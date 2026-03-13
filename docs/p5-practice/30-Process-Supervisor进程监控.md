# Process Supervisor 进程监控

> "OpenClaw 的进程监控系统是 Tool 系统的执行引擎，支持子进程和 PTY 两种模式，双重超时机制防止僵尸进程，优雅的进程树终止确保清理彻底。卧槽，这个 `no-output-timeout` 设计太聪明了——不仅限制总执行时间，还检测进程是否'卡住'不输出。PTY 适配器通过 node-pty 实现交互式 shell 支持，而运行注册表提供完整的进程生命周期追踪。"

---

## 核心技术洞察

### 1. 双重超时机制

```typescript
// src/process/supervisor/supervisor.ts
const spawn = async (input: SpawnInput): Promise<ManagedRun> => {
  const overallTimeoutMs = clampTimeout(input.timeoutMs);
  const noOutputTimeoutMs = clampTimeout(input.noOutputTimeoutMs);

  // 整体超时
  if (overallTimeoutMs) {
    timeoutTimer = setTimeout(() => {
      requestCancel("overall-timeout");
    }, overallTimeoutMs);
  }

  // 无输出超时
  if (noOutputTimeoutMs) {
    noOutputTimer = setTimeout(() => {
      requestCancel("no-output-timeout");
    }, noOutputTimeoutMs);
  }

  const touchOutput = () => {
    registry.touchOutput(runId);
    if (!noOutputTimeoutMs || settled) {
      return;
    }
    // 重置无输出超时
    if (noOutputTimer) {
      clearTimeout(noOutputTimer);
    }
    noOutputTimer = setTimeout(() => {
      requestCancel("no-output-timeout");
    }, noOutputTimeoutMs);
  };

  adapter.onStdout((chunk) => {
    touchOutput(); // 每次输出重置超时
  });
};
```

**Leon 点评**：双重超时机制解决了不同场景的问题：
1. **整体超时**：防止进程无限期运行
2. **无输出超时**：检测进程是否"卡住"
3. **自动重置**：每次输出都会重置无输出超时
4. **合理默认值**：不设置超时时不会触发，避免误杀

### 2. 进程树终止

```typescript
// src/process/kill-tree.ts
export function killProcessTree(pid: number, opts?: { graceMs?: number }): void {
  const graceMs = normalizeGraceMs(opts?.graceMs);

  if (process.platform === "win32") {
    killProcessTreeWindows(pid, graceMs);
    return;
  }

  killProcessTreeUnix(pid, graceMs);
}

function killProcessTreeUnix(pid: number, graceMs: number): void {
  // Step 1: 优雅 SIGTERM 到进程组
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return; // Already gone
    }
  }

  // Step 2: 等待宽限期，然后 SIGKILL
  setTimeout(() => {
    if (isProcessAlive(-pid)) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Fall through to direct pid kill
      }
    }
    if (!isProcessAlive(pid)) {
      return;
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Process exited between liveness check and kill
    }
  }, graceMs).unref(); // 不阻塞事件循环退出
}
```

**Leon 点评**：进程树终止的设计非常细致：
1. **平台差异**：Windows 使用 taskkill，Unix 使用进程组
2. **优雅终止**：先 SIGTERM 给进程清理机会
3. **强制终止**：宽限期后 SIGKILL 确保终止
4. **unref()**：定时器不阻塞事件循环退出

### 3. PTY 适配器

```typescript
// src/process/supervisor/adapters/pty.ts
export async function createPtyAdapter(params: {
  shell: string;
  args: string[];
  cwd?: string;
  env?: NodeJs.ProcessEnv;
  cols?: number;
  rows?: number;
  name?: string;
}): Promise<PtyAdapter> {
  const module = (await import("@lydell/node-pty")) as unknown as PtyModule;
  const spawn = module.spawn ?? module.default?.spawn;
  if (!spawn) {
    throw new Error("PTY support is unavailable (node-pty spawn not found).");
  }

  const pty = spawn(params.shell, params.args, {
    cwd: params.cwd,
    env: params.env ? toStringEnv(params.env) : undefined,
    name: params.name ?? process.env.TERM ?? "xterm-256color",
    cols: params.cols ?? 120,
    rows: params.rows ?? 30,
  });

  const kill = (signal: NodeJS.Signals = "SIGKILL") => {
    try {
      if (signal === "SIGKILL" && typeof pty.pid === "number" && pty.pid > 0) {
        killProcessTree(pty.pid);
      } else if (process.platform === "win32") {
        pty.kill();
      } else {
        pty.kill(signal);
      }
    } catch {
      // ignore kill errors
    }

    if (signal === "SIGKILL") {
      scheduleForceKillWaitFallback(signal);
    }
  };

  return { pid, stdin, onStdout, onStderr, wait, kill, dispose };
}
```

**Leon 点评**：PTY 适配器支持交互式命令：
1. **动态导入**：node-pty 是可选依赖
2. **终端设置**：支持 TERM 类型、列数、行数
3. **强制回退**：有些 PTY 主机不触发 onExit，需要回退定时器
4. **统一输出**：PTY 的 stdout 和 stderr 合并

### 4. 运行注册表

```typescript
// src/process/supervisor/registry.ts
export function createRunRegistry(options?: { maxExitedRecords?: number }): RunRegistry {
  const records = new Map<string, RunRecord>();
  const maxExitedRecords = resolveMaxExitedRecords(options?.maxExitedRecords);

  const pruneExitedRecords = () => {
    if (!records.size) {
      return;
    }
    let exited = 0;
    for (const record of records.values()) {
      if (record.state === "exited") {
        exited += 1;
      }
    }
    if (exited <= maxExitedRecords) {
      return;
    }
    let remove = exited - maxExitedRecords;
    for (const [runId, record] of records.entries()) {
      if (remove <= 0) {
        break;
      }
      if (record.state !== "exited") {
        continue;
      }
      records.delete(runId);
      remove -= 1;
    }
  };

  const finalize: RunRegistry["finalize"] = (runId, exit) => {
    const current = records.get(runId);
    if (!current) {
      return null;
    }
    const firstFinalize = current.state !== "exited";
    const ts = nowMs();
    const next: RunRecord = {
      ...current,
      state: "exited",
      terminationReason: current.terminationReason ?? exit.reason,
      exitCode: current.exitCode !== undefined ? current.exitCode : exit.exitCode,
      exitSignal: current.exitSignal !== undefined ? current.exitSignal : exit.exitSignal,
      updatedAtMs: ts,
    };
    records.set(runId, next);
    pruneExitedRecords(); // 自动清理旧记录
    return { record: { ...next }, firstFinalize };
  };

  return { add, get, list, listByScope, updateState, touchOutput, finalize, delete };
}
```

**Leon 点评**：运行注册表提供完整的进程追踪：
1. **状态机**：starting → running → exiting → exited
2. **自动清理**：退出记录超过限制时自动删除
3. **firstFinalize**：区分首次和重复 finalize
4. **作用域查询**：通过 scopeKey 查询相关进程

### 5. 子进程适配器

```typescript
// src/process/supervisor/adapters/child.ts
export async function createChildAdapter(params: {
  argv: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  windowsVerbatimArguments?: boolean;
  input?: string;
  stdinMode?: "inherit" | "pipe-open" | "pipe-closed";
}): Promise<ChildAdapter> {
  const stdinMode = params.stdinMode ?? (params.input !== undefined ? "pipe-closed" : "inherit");

  // 服务管理模式保持子进程附加，systemd/launchd 可以可靠停止进程树
  const useDetached = process.platform !== "win32" && !isServiceManagedRuntime();

  const options: SpawnOptions = {
    cwd: params.cwd,
    env: params.env ? toStringEnv(params.env) : undefined,
    stdio: ["pipe", "pipe", "pipe"],
    detached: useDetached,
    windowsHide: true,
    windowsVerbatimArguments: params.windowsVerbatimArguments,
  };

  const spawned = await spawnWithFallback({
    argv: resolvedArgv,
    options,
    fallbacks: useDetached
      ? [{ label: "no-detach", options: { detached: false } }]
      : [],
  });

  const kill = (signal?: NodeJS.Signals) => {
    const pid = child.pid ?? undefined;
    if (signal === undefined || signal === "SIGKILL") {
      if (pid) {
        killProcessTree(pid);
      } else {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore kill errors
        }
      }
      return;
    }
    try {
      child.kill(signal);
    } catch {
      // ignore kill errors for non-kill signals
    }
  };

  return { pid, stdin, onStdout, onStderr, wait, kill, dispose };
}
```

**Leon 点评**：子进程适配器考虑了多种场景：
1. **stdin 模式**：inherit/pipe-open/pipe-closed 三种模式
2. **服务检测**：`OPENCLAW_SERVICE_MARKER` 检测服务管理模式
3. **回退机制**：detached 失败时回退到非 detached
4. **命令补全**：Windows 自动补全 .cmd/.bat/.exe

---

## 一、进程监控架构总览

### 核心组件

```
Process Supervisor
├── Supervisor（监控器）
│   ├── Spawn（孵化）
│   ├── Cancel（取消）
│   └── Reconcile Orphans（孤进程协调）
├── Adapters（适配器）
│   ├── Child Adapter（子进程）
│   └── PTY Adapter（伪终端）
├── Registry（注册表）
│   ├── Add（添加）
│   ├── Update State（更新状态）
│   ├── Touch Output（触碰输出）
│   └── Finalize（完成）
└── Kill Tree（进程树终止）
    ├── Unix（Unix 实现）
    └── Windows（Windows 实现）
```

### 进程状态

| 状态 | 描述 | 转换 |
|------|------|------|
| starting | 进程正在启动 | → running / exited |
| running | 进程运行中 | → exiting / exited |
| exiting | 进程正在退出 | → exited |
| exited | 进程已退出 | 终态 |

### 终止原因

| 原因 | 描述 |
|------|------|
| manual-cancel | 用户手动取消 |
| overall-timeout | 整体超时 |
| no-output-timeout | 无输出超时 |
| spawn-error | 孵化错误 |
| signal | 信号终止 |
| exit | 正常退出 |

---

## 二、类型系统

### 孵化输入

```typescript
export type SpawnInput =
  | {
      mode: "child";
      argv: string[];
      windowsVerbatimArguments?: boolean;
      input?: string;
      stdinMode?: "inherit" | "pipe-open" | "pipe-closed";
    }
  | {
      mode: "pty";
      ptyCommand: string;
    };
```

### 基础输入

```typescript
type SpawnBaseInput = {
  runId?: string;
  sessionId: string;
  backendId: string;
  scopeKey?: string;
  replaceExistingScope?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  noOutputTimeoutMs?: number;
  captureOutput?: boolean;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
};
```

### 运行记录

```typescript
export type RunRecord = {
  runId: string;
  sessionId: string;
  backendId: string;
  scopeKey?: string;
  pid?: number;
  processGroupId?: number;
  startedAtMs: number;
  lastOutputAtMs: number;
  createdAtMs: number;
  updatedAtMs: number;
  state: RunState;
  terminationReason?: TerminationReason;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | number | null;
};
```

### 运行退出

```typescript
export type RunExit = {
  reason: TerminationReason;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  noOutputTimedOut: boolean;
};
```

---

## 三、超时管理

### 整体超时

```typescript
// 限制进程的总执行时间
const overallTimeoutMs = clampTimeout(input.timeoutMs);

if (overallTimeoutMs) {
  timeoutTimer = setTimeout(() => {
    requestCancel("overall-timeout");
  }, overallTimeoutMs);
}
```

### 无输出超时

```typescript
// 检测进程是否"卡住"不输出
const noOutputTimeoutMs = clampTimeout(input.noOutputTimeoutMs);

const touchOutput = () => {
  registry.touchOutput(runId);
  if (!noOutputTimeoutMs || settled) {
    return;
  }
  if (noOutputTimer) {
    clearTimeout(noOutputTimer);
  }
  noOutputTimer = setTimeout(() => {
    requestCancel("no-output-timeout");
  }, noOutputTimeoutMs);
};

adapter.onStdout((chunk) => {
  touchOutput();
});
```

### 超时值归一化

```typescript
function clampTimeout(value?: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.max(1, Math.floor(value));
}
```

---

## 四、作用域管理

### 作用域取消

```typescript
const cancelScope = (scopeKey: string, reason: TerminationReason = "manual-cancel") => {
  if (!scopeKey.trim()) {
    return;
  }
  for (const [runId, run] of active.entries()) {
    if (run.scopeKey !== scopeKey) {
      continue;
    }
    cancel(runId, reason);
  }
};
```

### 替换现有作用域

```typescript
const spawn = async (input: SpawnInput): Promise<ManagedRun> => {
  const runId = input.runId?.trim() || crypto.randomUUID();

  // 如果设置了 replaceExistingScope，先取消同作用域的所有进程
  if (input.replaceExistingScope && input.scopeKey?.trim()) {
    cancelScope(input.scopeKey, "manual-cancel");
  }

  // ... 孵化新进程
};
```

---

## 五、平台差异处理

### Windows vs Unix

| 特性 | Windows | Unix |
|------|---------|------|
| 进程树终止 | taskkill /T /F | kill -pid (进程组) |
| 优雅终止 | taskkill /T | SIGTERM |
| 强制终止 | taskkill /F /T | SIGKILL |
| PTY EOF | \x1a | \x04 (Ctrl+D) |
| 命令补全 | .cmd/.bat/.exe | 无 |

### 命令解析

```typescript
function resolveCommand(command: string): string {
  if (process.platform !== "win32") {
    return command;
  }
  const lower = command.toLowerCase();
  if (lower.endsWith(".exe") || lower.endsWith(".cmd") || lower.endsWith(".bat")) {
    return command;
  }
  const basename = lower.split(/[\\/]/).pop() ?? lower;
  if (basename === "npm" || basename === "pnpm" || basename === "yarn" || basename === "npx") {
    return `${command}.cmd`;
  }
  return command;
}
```

---

## 六、可观测性

### 按作用域查询

```typescript
const listByScope: RunRegistry["listByScope"] = (scopeKey) => {
  if (!scopeKey.trim()) {
    return [];
  }
  return Array.from(records.values())
    .filter((record) => record.scopeKey === scopeKey)
    .map((record) => ({ ...record }));
};
```

### 最后输出时间

```typescript
const touchOutput: RunRegistry["touchOutput"] = (runId) => {
  const current = records.get(runId);
  if (!current) {
    return;
  }
  const ts = nowMs();
  records.set(runId, {
    ...current,
    lastOutputAtMs: ts,
    updatedAtMs: ts,
  });
};
```

---

## 七、技术权衡

### 1. PTY vs 子进程

| 方案 | 优势 | 劣势 |
|------|------|------|
| PTY | 交互式、终端支持 | 依赖 node-pty、资源消耗大 |
| 子进程 | 轻量、无依赖 | 不支持交互式命令 |

**选择**：两者都支持
**原因**：不同场景需要不同模式，shell 命令需要 PTY，简单脚本用子进程

### 2. 进程组 vs 独立进程

| 方案 | 优势 | 劣势 |
|------|------|------|
| 进程组 | 便于终止进程树 | 需要额外支持 |
| 独立进程 | 简单直接 | 难以追踪子进程 |

**选择**：Unix 使用进程组，Windows 使用 taskkill
**原因**：平台特性不同，需要平台特定实现

### 3. 内存注册表 vs 持久化

| 方案 | 优势 | 劣势 |
|------|------|------|
| 内存注册表 | 高性能、支持复杂查询 | 重启丢失 |
| 持久化 | 持久稳定 | 低性能、复杂度高 |

**选择**：内存注册表
**原因**：进程监控是临时的，重启后孤进程可以协调清理

### 4. 优雅终止 vs 立即终止

| 方案 | 优势 | 劣势 |
|------|------|------|
| 优雅终止 | 进程可以清理资源 | 可能有进程不响应 |
| 立即终止 | 确保终止 | 资源可能泄漏 |

**选择**：先优雅后强制
**原因**：给进程清理机会，超时后强制确保终止

---

*本文档基于源码分析，涵盖进程监控的架构、双重超时机制、进程树终止、PTY/子进程适配器、运行注册表、作用域管理以及平台差异处理。*
