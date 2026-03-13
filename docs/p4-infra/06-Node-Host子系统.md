# OpenClaw 架构探索：Node-Host 子系统

> 基于 `src/node-host/` 的一手源码分析

---

## 最核心的技术洞察 (Top 10)

### 1. 子进程执行框架的本质
**评价**: 这不仅仅是"执行命令"，而是一个完整的**分布式执行沙箱**。

Node-Host 将 OpenClaw 的 AI Agent 能力扩展到系统层面，通过 WebSocket 连接到 Gateway，声明 "system" 和 "browser" 两种能力。它本质上是一个**受控的命令执行代理**，而非简单的 shell 替代品。

关键设计决策：
- 使用独立进程而非直接执行，隔离风险
- 通过 Gateway 路由所有执行请求，实现集中审计
- 支持远程和本地两种部署模式

```typescript
// src/node-host/runner.ts
const client = new GatewayClient({
  url,
  token: token || undefined,
  password: password || undefined,
  instanceId: nodeId,
  clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
  clientDisplayName: displayName,
  clientVersion: VERSION,
  platform: process.platform,
  mode: GATEWAY_CLIENT_MODES.NODE,
  role: "node",
  scopes: [],
  caps: ["system", ...(browserProxyEnabled ? ["browser"] : [])],
  commands: [
    ...NODE_SYSTEM_RUN_COMMANDS,
    ...NODE_EXEC_APPROVALS_COMMANDS,
    ...(browserProxyEnabled ? [NODE_BROWSER_PROXY_COMMAND] : []),
  ],
  // ...
});
```

### 2. 路径硬化机制 (Path Hardening)
**评价**: 这是防止 TOCTOU (Time-of-Check-Time-of-Use) 攻击的**教科书级实现**。

在用户批准执行命令后，系统会将命令中的可执行文件路径解析为其真实路径，确保执行的是用户批准的那个确切文件，而非符号链接攻击后的替换版本。

核心实现：
```typescript
// src/node-host/invoke-system-run-plan.ts
export function hardenApprovedExecutionPaths(params: {
  approvedByAsk: boolean;
  argv: string[];
  shellCommand: string | null;
  cwd: string | undefined;
}): /* ... */ {
  if (!params.approvedByAsk) {
    return { ok: true, argv: params.argv, argvChanged: false, /* ... */ };
  }

  const resolution = resolveCommandResolutionFromArgv(params.argv, hardenedCwd);
  const pinnedExecutable = resolution?.resolvedRealPath ?? resolution?.resolvedPath;
  if (!pinnedExecutable) {
    return { ok: false, message: "SYSTEM_RUN_DENIED: approval requires a stable executable path" };
  }

  const argv = [...params.argv];
  argv[0] = pinnedExecutable;  // 替换为真实路径
  return { ok: true, argv, argvChanged: true, /* ... */ };
}
```

**安全意义**：防止攻击者在审批后替换二进制文件。

### 3. 工作目录 (CWD) 快照验证
**评价**: 这种对细节的执着体现了作者对安全边界的**变态级追求**。

不仅仅是路径硬化，系统还记录了工作目录的 inode 信息，在执行前验证目录未被篡改。这防止了通过符号链接重定向到敏感目录的攻击。

```typescript
// src/node-host/invoke-system-run-plan.ts
export type ApprovedCwdSnapshot = {
  cwd: string;
  stat: fs.Stats;  // 包含 inode, dev 等唯一标识
};

function resolveCanonicalApprovalCwdSync(cwd: string): /* ... */ {
  const cwdReal = fs.realpathSync(requestedCwd);
  const cwdRealStat = fs.statSync(cwdReal);

  // 检查路径中是否存在可变的符号链接
  if (hasMutableSymlinkPathComponentSync(requestedCwd)) {
    return { ok: false, message: "SYSTEM_RUN_DENIED: approval requires canonical cwd (no symlink path components)" };
  }

  // 验证 cwd 本身不是符号链接
  if (cwdLstat.isSymbolicLink()) {
    return { ok: false, message: "SYSTEM_RUN_DENIED: approval requires canonical cwd (no symlink cwd)" };
  }

  // 验证三次 stat 结果的 fileIdentity 一致性
  if (!sameFileIdentity(cwdStat, cwdLstat) || !sameFileIdentity(cwdStat, cwdRealStat)) {
    return { ok: false, message: "SYSTEM_RUN_DENIED: approval cwd identity mismatch" };
  }

  return { ok: true, snapshot: { cwd: cwdReal, stat: cwdRealStat } };
}
```

卧槽，这他妈是连 inode 都验证了，真是把攻击面压缩到极致。

### 4. 脚本操作数哈希锁定
**评价**: 对于解释器执行场景（如 `node script.js`），系统会锁定脚本文件的 SHA-256 哈希值。

当用户批准执行 `node build.js` 后，系统会记录 `build.js` 的 SHA-256 哈希。在执行前，如果文件内容发生任何变化（包括单字节），执行将被拒绝。

```typescript
// src/node-host/invoke-system-run-plan.ts
export type SystemRunApprovalFileOperand = {
  argvIndex: number;
  path: string;
  sha256: string;  // 审批时计算的文件哈希
};

function hashFileContentsSync(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function revalidateApprovedMutableFileOperand(params: {
  snapshot: SystemRunApprovalFileOperand;
  argv: string[];
  cwd: string | undefined;
}): boolean {
  // 验证路径未变
  if (realPath !== params.snapshot.path) return false;

  // 验证内容哈希未变
  try {
    return hashFileContentsSync(realPath) === params.snapshot.sha256;
  } catch {
    return false;
  }
}
```

**应用场景**：
- `node script.js` → 锁定 script.js
- `python build.py` → 锁定 build.py
- `bun run.ts` → 锁定 run.ts
- `deno run exec.ts` → 锁定 exec.ts

### 5. macOS 应用执行宿主集成
**评价**: 这是针对 Apple 安全沙箱的**创造性解决方案**。

在 macOS 上，某些操作（如屏幕录制、无障碍访问）需要用户明确授权。Node-Host 支持将执行请求转发给 macOS 原生应用，该应用可以在 UI 层面向用户请求权限。

```typescript
// src/infra/exec-host.ts
export async function requestExecHostViaSocket(params: {
  socketPath: string;
  token: string;
  request: ExecHostRequest;
  timeoutMs?: number;
}): Promise<ExecHostResponse | null> {
  const hmac = crypto
    .createHmac("sha256", token)
    .update(`${nonce}:${ts}:${requestJson}`)
    .digest("hex");

  const payload = JSON.stringify({
    type: "exec",
    id: crypto.randomUUID(),
    nonce,
    ts,
    hmac,
    requestJson,
  });

  return await requestJsonlSocket({ socketPath, payload, timeoutMs, /* ... */ });
}
```

**通信协议**：
- 使用 Unix Domain Socket (`~/.openclaw/exec-approvals.sock`)
- HMAC-SHA256 签名验证请求完整性
- JSONL (JSON Lines) 格式进行消息交换

### 6. 三阶段执行流程
**评价**: 将复杂的审批逻辑分解为清晰的阶段，每个阶段可独立测试和扩展。

```typescript
// src/node-host/invoke-system-run.ts
async function parseSystemRunPhase(opts: HandleSystemRunInvokeOptions): Promise<SystemRunParsePhase | null> {
  const command = resolveSystemRunCommand({ command, rawCommand });
  const approvalPlan = normalizeSystemRunApprovalPlan(systemRunPlan);
  const envOverrides = sanitizeSystemRunEnvOverrides({ overrides: env, shellWrapper });

  return { argv, shellCommand, cmdText, approvalPlan, agentId, sessionKey, runId, /* ... */ };
}

async function evaluateSystemRunPolicyPhase(opts, parsed): Promise<SystemRunPolicyPhase | null> {
  const approvals = resolveExecApprovals(agentId);
  const { analysisOk, allowlistSatisfied } = evaluateSystemRunAllowlist({ /* ... */ });
  const policy = evaluateSystemRunPolicy({ security, ask, analysisOk, allowlistSatisfied });

  if (!policy.allowed) {
    await sendSystemRunDenied(opts, execution, { reason: policy.eventReason, message: policy.errorMessage });
    return null;
  }

  return { ...parsed, approvals, security, policy, allowlistMatches, /* ... */ };
}

async function executeSystemRunPhase(opts: HandleSystemRunInvokeOptions, phase: SystemRunPolicyPhase): Promise<void> {
  // 重新验证 CWD 快照
  if (!revalidateApprovedCwdSnapshot({ snapshot: phase.approvedCwdSnapshot })) {
    await sendSystemRunDenied(opts, phase.execution, { reason: "approval-required", message: APPROVAL_CWD_DRIFT_DENIED_MESSAGE });
    return;
  }

  // 重新验证脚本操作数哈希
  if (!revalidateApprovedMutableFileOperand({ snapshot: phase.approvalPlan.mutableFileOperand })) {
    await sendSystemRunDenied(opts, phase.execution, { reason: "approval-required", message: APPROVAL_SCRIPT_OPERAND_DRIFT_DENIED_MESSAGE });
    return;
  }

  // 执行命令
  const result = await opts.runCommand(execArgv, phase.cwd, phase.env, phase.timeoutMs);
}
```

**三个阶段**：
1. **Parse Phase** - 解析命令，构建审批计划
2. **Policy Phase** - 评估安全策略，检查白名单
3. **Execute Phase** - 验证快照，执行命令

### 7. 安全二进制运行时策略集成
**评价**: 将技能（Skills）系统的可信任二进制文件无缝集成到审批系统中。

Node-Host 会定期从 Gateway 获取已注册的技能二进制文件列表，并将这些文件添加到自动允许列表中。这意味着用户安装的技能可以自动执行其声明的二进制工具，无需逐个审批。

```typescript
// src/node-host/runner.ts
class SkillBinsCache implements SkillBinsProvider {
  private bins: SkillBinTrustEntry[] = [];
  private readonly ttlMs = 90_000;  // 90秒刷新一次

  async current(force = false): Promise<SkillBinTrustEntry[]> {
    if (force || Date.now() - this.lastRefresh > this.ttlMs) {
      await this.refresh();
    }
    return this.bins;
  }

  private async refresh() {
    const bins = await this.fetch();  // 从 Gateway 获取
    this.bins = resolveSkillBinTrustEntries(bins, this.pathEnv);
    this.lastRefresh = Date.now();
  }
}

const skillBins = new SkillBinsCache(async () => {
  const res = await client.request<{ bins: Array<unknown> }>("skills.bins", {});
  return Array.isArray(res?.bins) ? res.bins.map((bin) => String(bin)) : [];
}, pathEnv);
```

**关键特性**：
- 90 秒 TTL，平衡新鲜度和性能
- 路径环境变量感知
- 去重处理（name + resolvedPath 作为唯一键）

### 8. Shell 包装器拦截策略
**评价**: 在 `allowlist` 模式下，shell 包装器（如 `sh -c`, `bash -c`）被显式禁止，除非用户明确批准。

这是一个关键的安全决策：shell 包装器可以绕过白名单，因为它们接受任意字符串作为命令。因此，在 `allowlist` 安全模式下，shell 包装器必须经过审批流程。

```typescript
// src/node-host/exec-policy.ts
export function evaluateSystemRunPolicy(params: {
  security: ExecSecurity;
  shellWrapperInvocation: boolean;
  /* ... */
}): SystemRunPolicyDecision {
  const shellWrapperBlocked = params.security === "allowlist" && params.shellWrapperInvocation;

  if (shellWrapperBlocked && !approvedByAsk) {
    return {
      allowed: false,
      eventReason: "allowlist-miss",
      errorMessage: "SYSTEM_RUN_DENIED: allowlist miss (shell wrappers like sh/bash/zsh -c require approval)",
      /* ... */
    };
  }

  return { allowed: true, /* ... */ };
}
```

**Windows 特殊处理**：`cmd.exe /c` 也被视为 shell 包装器，有单独的错误消息。

### 9. 输出截断与尾部保留
**评价**: 对于长输出，系统采用"头部截断 + 尾部保留"策略，既控制大小又保留关键信息。

```typescript
// src/node-host/invoke.ts
const OUTPUT_CAP = 200_000;  // 200KB 总上限
const OUTPUT_EVENT_TAIL = 20_000;  // 20KB 尾部保留

function applyOutputTruncation(result: RunResult): void {
  if (result.stdout.length > OUTPUT_CAP) {
    result.stdout = result.stdout.slice(0, OUTPUT_CAP - OUTPUT_EVENT_TAIL) +
      `\n[... ${result.stdout.length - OUTPUT_CAP} bytes omitted ...]\n` +
      result.stdout.slice(-OUTPUT_EVENT_TAIL);
  }
  if (result.stderr.length > OUTPUT_CAP) {
    result.stderr = result.stderr.slice(0, OUTPUT_CAP - OUTPUT_EVENT_TAIL) +
      `\n[... ${result.stderr.length - OUTPUT_CAP} bytes omitted ...]\n` +
      result.stderr.slice(-OUTPUT_EVENT_TAIL);
  }
}
```

**策略意义**：
- 防止单次输出占用过多内存
- 保留尾部（通常包含错误信息）
- 明确标记省略的字节数

### 10. Windows 代码页处理
**评价**: 这个细节处理显示了作者对跨平台兼容性的**极致追求**。

在 Windows 上，子进程输出可能使用不同的代码页（如 CP936, CP65001）。Node-Host 会自动检测并转换编码，确保输出正确解析。

```typescript
// src/node-host/invoke.ts
function detectWindowsEncoding(buffer: Buffer): string {
  // 检查 BOM (Byte Order Mark)
  if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
    return "utf-8";
  }

  // 尝试从环境变量获取代码页
  const codePage = process.env.CHCP_CP || "65001";  // 默认 UTF-8
  const encodingMap: Record<string, string> = {
    "65001": "utf-8",
    "936": "gbk",
    "950": "big5",
    // ...
  };

  return encodingMap[codePage] || "utf-8";
}
```

---

## 一、Node-Host 系统架构

### 1.1 整体架构图

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Node-Host Architecture                           │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐           │
│  │   Gateway    │◄────┤  Node-Host   │◄────┤    CLI       │           │
│  │  (WebSocket) │     │   Process    │     │   Invoker    │           │
│  └──────────────┘     └──────────────┘     └──────────────┘           │
│         │                    │                                          │
│         ▼                    ▼                                          │
│  ┌──────────────────────────────────────────────────────────────┐     │
│  │                    Command Dispatch Layer                     │     │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │     │
│  │  │ system.run   │  │ system.which │  │ browser.proxy │      │     │
│  │  │  .prepare    │  │              │  │              │      │     │
│  │  └──────────────┘  └──────────────┘  └──────────────┘      │     │
│  └──────────────────────────────────────────────────────────────┘     │
│         │                    │                                          │
│         ▼                    ▼                                          │
│  ┌──────────────────────────────────────────────────────────────┐     │
│  │                   Security & Policy Layer                     │     │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │     │
│  │  │   Allowlist  │  │   Approval   │  │  Path Harden │      │     │
│  │  │   Check      │  │   Planning   │  │     ing      │      │     │
│  │  └──────────────┘  └──────────────┘  └──────────────┘      │     │
│  └──────────────────────────────────────────────────────────────┘     │
│         │                    │                                          │
│         ▼                    ▼                                          │
│  ┌──────────────────────────────────────────────────────────────┐     │
│  │                   Execution Engines                           │     │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │     │
│  │  │    Direct    │  │ Mac App Exec │  │   Shell      │      │     │
│  │  │   Spawn      │  │    Host      │  │   Wrapper    │      │     │
│  │  └──────────────┘  └──────────────┘  └──────────────┘      │     │
│  └──────────────────────────────────────────────────────────────┘     │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 1.2 核心组件清单

| 文件 | 职责 | 关键类型/函数 |
|------|------|--------------|
| `src/node-host/runner.ts` | Node-Host 进程入口 | `runNodeHost()` |
| `src/node-host/config.ts` | 配置管理 | `NodeHostConfig`, `ensureNodeHostConfig()` |
| `src/node-host/invoke.ts` | 命令分发器 | `handleInvoke()` |
| `src/node-host/invoke-system-run.ts` | system.run 实现 | `handleSystemRunInvoke()` |
| `src/node-host/invoke-system-run-plan.ts` | 路径硬化与审批计划 | `hardenApprovedExecutionPaths()` |
| `src/node-host/exec-policy.ts` | 安全策略评估 | `evaluateSystemRunPolicy()` |
| `src/infra/exec-approvals.ts` | 审批配置存储 | `ExecApprovalsFile`, `resolveExecApprovals()` |
| `src/infra/exec-host.ts` | Mac App 执行宿主 | `requestExecHostViaSocket()` |
| `src/infra/jsonl-socket.ts` | Socket 通信基础 | `requestJsonlSocket()` |

---

## 二、命令协议详解

### 2.1 支持的命令

```typescript
// src/infra/node-commands.ts
export const NODE_SYSTEM_RUN_COMMANDS = [
  "system.run.prepare",  // 生成执行计划，供 UI 审批
  "system.run",          // 实际执行命令
  "system.which",        // 查找可执行文件路径
] as const;

export const NODE_EXEC_APPROVALS_COMMANDS = [
  "system.execApprovals.get",  // 获取审批配置
  "system.execApprovals.set",  // 设置审批配置
] as const;

export const NODE_BROWSER_PROXY_COMMAND = "browser.proxy";  // 浏览器代理命令
```

### 2.2 system.run.prepare 命令

**用途**：生成执行计划，供用户审批，但不实际执行。

**请求参数**：
```typescript
type SystemRunParams = {
  command?: string[];      // 命令数组形式
  rawCommand?: string;     // 原始命令字符串
  cwd?: string;            // 工作目录
  env?: Record<string, string>;  // 环境变量
  timeoutMs?: number;      // 超时时间
  agentId?: string;        // Agent ID
  sessionKey?: string;     // 会话键
};
```

**响应**：
```typescript
type SystemRunApprovalPlan = {
  argv: string[];                        // 硬化后的命令数组
  cwd: string | null;                    // 规范化的工作目录
  rawCommand: string | null;             // 显示用的原始命令
  agentId: string | null;                // Agent ID
  sessionKey: string | null;             // 会话键
  mutableFileOperand?: {                 // 脚本操作数快照
    argvIndex: number;
    path: string;
    sha256: string;
  };
};
```

### 2.3 system.run 命令

**用途**：实际执行命令，需要附带审批决策。

**额外参数**：
```typescript
type SystemRunParams = {
  // ... (system.run.prepare 的所有参数)
  approvalDecision?: "allow-once" | "allow-always";  // 审批决策
  approved?: boolean;                                // 是否已预批准
  systemRunPlan?: SystemRunApprovalPlan;             // 审批计划（用于验证）
  needsScreenRecording?: boolean;                    // 是否需要屏幕录制权限
  suppressNotifyOnExit?: boolean;                    // 是否抑制退出通知
};
```

---

## 三、安全策略详解

### 3.1 三级安全模式

```typescript
export type ExecSecurity = "deny" | "allowlist" | "full";
```

| 模式 | 行为 | 适用场景 |
|------|------|----------|
| `deny` | 完全禁止执行 | 高安全要求环境 |
| `allowlist` | 仅允许白名单命令 | 默认推荐模式 |
| `full` | 无限制执行 | 受信任环境 |

### 3.2 审批询问模式

```typescript
export type ExecAsk = "off" | "on-miss" | "always";
```

| 模式 | 行为 |
|------|------|
| `off` | 从不询问，自动允许/拒绝 |
| `on-miss` | 仅在白名单未命中时询问 |
| `always` | 总是询问用户审批 |

### 3.3 策略评估逻辑

```typescript
// src/node-host/exec-policy.ts
export function evaluateSystemRunPolicy(params: {
  security: ExecSecurity;
  ask: ExecAsk;
  analysisOk: boolean;        // 命令分析是否成功
  allowlistSatisfied: boolean; // 白名单是否满足
  approvalDecision: ExecApprovalDecision;
  approved?: boolean;
  isWindows: boolean;
  cmdInvocation: boolean;     // 是否是 cmd.exe 调用
  shellWrapperInvocation: boolean;  // 是否使用 shell 包装器
}): SystemRunPolicyDecision {
  const shellWrapperBlocked = params.security === "allowlist" && params.shellWrapperInvocation;

  // 1. 检查安全级别
  if (params.security === "deny") {
    return { allowed: false, eventReason: "security=deny", /* ... */ };
  }

  // 2. 检查是否需要审批
  const requiresAsk = requiresExecApproval({
    ask: params.ask,
    security: params.security,
    analysisOk: params.analysisOk,
    allowlistSatisfied: params.allowlistSatisfied,
  });
  if (requiresAsk && !approvedByAsk) {
    return { allowed: false, eventReason: "approval-required", /* ... */ };
  }

  // 3. 检查白名单
  if (params.security === "allowlist" && (!analysisOk || !allowlistSatisfied) && !approvedByAsk) {
    return { allowed: false, eventReason: "allowlist-miss", /* ... */ };
  }

  return { allowed: true, /* ... */ };
}
```

---

## 四、路径硬化详解

### 4.1 硬化流程

```
原始命令: ls -la /Users
         │
         ▼
解析可执行文件: /usr/bin/ls
         │
         ▼
解析真实路径: /usr/bin/ls -> /bin/ls (symlink)
         │
         ▼
硬化命令: [/bin/ls, "-la", "/Users"]
```

### 4.2 符号链接检测

```typescript
function hasMutableSymlinkPathComponentSync(targetPath: string): boolean {
  for (const component of pathComponentsFromRootSync(targetPath)) {
    if (!fs.lstatSync(component).isSymbolicLink()) {
      continue;
    }
    const parentDir = path.dirname(component);
    if (isWritableByCurrentProcessSync(parentDir)) {
      return true;  // 发现可变的符号链接
    }
  }
  return false;
}
```

**检查项**：
1. 路径中每个组件是否为符号链接
2. 符号链接的父目录是否可写
3. 如果是，则认为该路径不可信

### 4.3 FileIdentity 验证

```typescript
// src/infra/file-identity.ts
export type FileIdentity = {
  ino: bigint;   // inode number
  dev: bigint;   // device identifier
  mode: number;  // file mode
  nlink: number; // number of hard links
  uid: number;   // user ID
  gid: number;   // group ID
  rdev: bigint;  // device ID (if special file)
  blksize: number;  // blocksize
  size: number;  // file size
  blocks: number;  // number of blocks
  atimeMs: number; // access time
  mtimeMs: number; // modification time
  ctimeMs: number; // status change time
};

export function sameFileIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return (
    a.ino === b.ino &&
    a.dev === b.dev &&
    a.mode === b.mode &&
    a.size === b.size
  );
}
```

**验证逻辑**：
- `lstat(path)` 获取文件信息（不跟随符号链接）
- `stat(path)` 获取文件信息（跟随符号链接）
- `realpath(path)` 获取真实路径
- 三者必须一致，否则拒绝

---

## 五、macOS 应用执行宿主

### 5.1 架构设计

```
┌─────────────────────────────────────────────────────────────┐
│                    macOS Execution Flow                     │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────────┐         ┌──────────────┐                │
│  │  Node-Host   │────────▶│   Mac App    │                │
│  │  (CLI)       │  Socket │ (GUI)        │                │
│  └──────────────┘         └──────────────┘                │
│         │                         │                        │
│         │ exec request            │ UI permission prompt  │
│         │                         │                        │
│         ▼                         ▼                        │
│  ┌──────────────┐         ┌──────────────┐                │
│  │ ~/.openclaw/ │         │  macOS TCC   │                │
│  │exec-approvals│         │  Dialog      │                │
│  │   .sock      │         └──────────────┘                │
│  └──────────────┘                                          │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 5.2 通信协议

**请求格式**：
```typescript
type ExecHostRequest = {
  command: string[];            // 要执行的命令
  rawCommand?: string;          // 显示用的原始命令
  cwd?: string;                 // 工作目录
  env?: Record<string, string>; // 环境变量
  timeoutMs?: number;           // 超时时间
  needsScreenRecording?: boolean;  // 是否需要屏幕录制
  agentId?: string;             // Agent ID
  sessionKey?: string;          // 会话键
  approvalDecision?: "allow-once" | "allow-always";  // 审批决策
};
```

**Socket 消息包装**：
```typescript
const payload = JSON.stringify({
  type: "exec",
  id: crypto.randomUUID(),
  nonce: crypto.randomBytes(16).toString("hex"),
  ts: Date.now(),
  hmac: crypto.createHmac("sha256", token)
    .update(`${nonce}:${ts}:${requestJson}`)
    .digest("hex"),
  requestJson: JSON.stringify(request),
});
```

**响应格式**：
```typescript
type ExecHostRunResult = {
  exitCode?: number;
  timedOut: boolean;
  success: boolean;
  stdout: string;
  stderr: string;
  error?: string | null;
};

type ExecHostResponse =
  | { ok: true; payload: ExecHostRunResult }
  | { ok: false; error: { code: string; message: string; reason?: string } };
```

---

## 六、技能二进制集成

### 6.1 技能注册流程

```
┌─────────────────────────────────────────────────────────────┐
│                  Skill Bin Registration                     │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. 技能定义 package.json                                   │
│     ┌────────────────────────────────────┐                │
│     │ {                                  │                │
│     │   "name": "@openclaw/skill-foo",   │                │
│     │   "openclaw": {                    │                │
│     │     "bins": ["foo", "bar"]         │                │
│     │   }                                │                │
│     │ }                                  │                │
│     └────────────────────────────────────┘                │
│                       │                                    │
│                       ▼                                    │
│  2. Gateway 启动时扫描技能                                 │
│     ┌────────────────────────────────────┐                │
│     │ skills.bins → ["foo", "bar"]       │                │
│     └────────────────────────────────────┘                │
│                       │                                    │
│                       ▼                                    │
│  3. Node-Host 定期刷新技能列表                             │
│     ┌────────────────────────────────────┐                │
│     │ SkillBinsCache (TTL: 90s)          │                │
│     └────────────────────────────────────┘                │
│                       │                                    │
│                       ▼                                    │
│  4. 解析可执行文件路径                                     │
│     ┌────────────────────────────────────┐                │
│     │ "foo" → "/usr/local/bin/foo"       │                │
│     │ "bar" → "/home/user/.local/bin/bar"│                │
│     └────────────────────────────────────┘                │
│                       │                                    │
│                       ▼                                    │
│  5. 添加到自动允许列表                                     │
│     ┌────────────────────────────────────┐                │
│     │ autoAllowSkills: true              │                │
│     │ → 允许无需审批执行                 │                │
│     └────────────────────────────────────┘                │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 6.2 技能白名单条目

```typescript
type SkillBinTrustEntry = {
  name: string;         // 二进制文件名（如 "foo"）
  resolvedPath: string; // 解析后的完整路径
};

// 示例
[
  { name: "foo", resolvedPath: "/usr/local/bin/foo" },
  { name: "bar", resolvedPath: "/home/user/.local/bin/bar" },
]
```

### 6.3 刷新机制

```typescript
class SkillBinsCache implements SkillBinsProvider {
  private bins: SkillBinTrustEntry[] = [];
  private lastRefresh = 0;
  private readonly ttlMs = 90_000;  // 90秒 TTL

  async current(force = false): Promise<SkillBinTrustEntry[]> {
    if (force || Date.now() - this.lastRefresh > this.ttlMs) {
      await this.refresh();
    }
    return this.bins;
  }
}
```

**设计考虑**：
- TTL 设置为 90 秒，平衡新鲜度和性能
- 支持强制刷新（`force: true`）
- 刷新失败时保留缓存，不中断执行

---

## 七、事件流与审计

### 7.1 执行事件

```typescript
type ExecEventPayload = {
  sessionKey: string;           // 会话标识
  runId: string;                // 运行 ID
  host: "node" | "gateway";     // 执行宿主
  command: string;              // 执行的命令
  reason?: string;              // 拒绝原因（如果被拒绝）
  suppressNotifyOnExit?: boolean;  // 是否抑制退出通知
};

type ExecFinishedEventParams = {
  sessionKey: string;
  runId: string;
  cmdText: string;
  result: {
    exitCode: number;
    timedOut: boolean;
    success: boolean;
    stdout: string;
    stderr: string;
    error?: string | null;
  };
  suppressNotifyOnExit?: boolean;
};
```

### 7.2 事件发送顺序

```
1. node.invoke.request (Gateway → Node-Host)
   │
   ▼
2. parseSystemRunPhase (解析命令)
   │
   ▼
3. evaluateSystemRunPolicyPhase (策略评估)
   │   ├── 拒绝 → node.event: exec.denied
   │   └── 通过 → 继续
   ▼
4. executeSystemRunPhase (执行命令)
   │
   ▼
5. node.event: exec.finished (执行完成)
   │
   ▼
6. node.invoke.result (返回结果)
```

---

## 八、配置文件详解

### 8.1 node.json

**位置**：`~/.openclaw/node.json`

```typescript
type NodeHostConfig = {
  version: 1;
  nodeId: string;           // 节点唯一标识
  token?: string;           // Gateway 认证令牌
  displayName?: string;     // 显示名称
  gateway?: {
    host?: string;          // Gateway 主机
    port?: number;          // Gateway 端口
    tls?: boolean;          // 是否启用 TLS
    tlsFingerprint?: string; // TLS 指纹
  };
};
```

### 8.2 exec-approvals.json

**位置**：`~/.openclaw/exec-approvals.json`

```typescript
type ExecApprovalsFile = {
  version: 1;
  socket?: {
    path?: string;          // Socket 路径
    token?: string;         // Socket 认证令牌
  };
  defaults?: {
    security?: ExecSecurity;
    ask?: ExecAsk;
    askFallback?: ExecSecurity;
    autoAllowSkills?: boolean;
  };
  agents?: Record<string, {
    security?: ExecSecurity;
    ask?: ExecAsk;
    askFallback?: ExecSecurity;
    autoAllowSkills?: boolean;
    allowlist?: Array<{
      id?: string;
      pattern: string;
      lastUsedAt?: number;
      lastUsedCommand?: string;
      lastResolvedPath?: string;
    }>;
  }>;
};
```

### 8.3 通配符 Agent

配置支持通配符 `*` 作为 fallback：

```json
{
  "agents": {
    "*": {
      "security": "allowlist",
      "ask": "on-miss",
      "allowlist": ["git", "npm", "node"]
    },
    "specific-agent": {
      "security": "full"
    }
  }
}
```

**解析优先级**：
1. Agent 特定配置
2. 通配符 `*` 配置
3. 全局 `defaults` 配置
4. 硬编码默认值

---

## 九、常见执行场景

### 9.1 场景一：简单命令执行

```
用户: 执行 `ls -la`
     │
     ▼
CLI: 发送 system.run.invoke
     │
     ▼
Node-Host: 解析 → 策略评估 → 允许
     │
     ▼
执行: spawn("/bin/ls", ["-la"])
     │
     ▼
返回: { exitCode: 0, stdout: "...", stderr: "" }
```

### 9.2 场景二：需要审批的脚本

```
用户: 执行 `node build.js`
     │
     ▼
CLI: 发送 system.run.prepare
     │
     ▼
Node-Host: 生成审批计划
     │   - 硬化路径: /usr/local/bin/node
     │   - 锁定脚本: build.js (sha256: abc123...)
     │   - CWD 快照: /Users/user/project (ino: 12345)
     │
     ▼
UI: 显示审批提示
     │
     ▼
用户: 点击"允许"
     │
     ▼
CLI: 发送 system.run (with approvalDecision: "allow-once")
     │
     ▼
Node-Host: 验证审批计划 → 执行
     │   - 重新验证 CWD 快照
     │   - 重新验证脚本哈希
     │   - 执行命令
     │
     ▼
返回: { exitCode: 0, stdout: "Build success", stderr: "" }
```

### 9.3 场景三：Shell 包装器拦截

```
用户: 执行 `sh -c "echo hello"`
     │
     ▼
CLI: 发送 system.run.invoke
     │
     ▼
Node-Host: 策略评估
     │   - security: "allowlist"
     │   - shellWrapperInvocation: true
     │   - allowlistSatisfied: false
     │
     ▼
拒绝: SYSTEM_RUN_DENIED: allowlist miss
      (shell wrappers like sh/bash/zsh -c require approval)
```

### 9.4 场景四：macOS 屏幕录制权限

```
用户: 执行需要屏幕录制的命令
     │
     ▼
Node-Host: needsScreenRecording: true
     │
     ▼
转发到 Mac App Exec Host
     │
     ▼
Mac App: 显示 TCC 权限请求对话框
     │
     ▼
用户: 点击"好"
     │
     ▼
Mac App: 执行命令 → 返回结果
     │
     ▼
Node-Host: 转发结果到 CLI
```

---

## 十、作者的技术权衡

### 10.1 进程隔离 vs 内联执行

**选择**：独立 Node-Host 进程

**优势**：
- 故障隔离：Node-Host 崩溃不影响主 Gateway
- 权限分离：可独立控制文件系统访问
- 可独立部署：可在远程机器上运行

**代价**：
- 通信开销：WebSocket 通信延迟
- 复杂度增加：需要管理进程生命周期

### 10.2 路径硬化的侵入性

**选择**：在审批后修改 argv[0] 为真实路径

**优势**：
- 防止 TOCTOU 攻击
- 确保执行的是批准的确切文件

**代价**：
- 可能影响依赖于 `argv[0]` 的脚本
- 错误消息可能显示硬化后的路径

### 10.3 Socket 通信 vs HTTP

**选择**：Unix Domain Socket (JSONL)

**优势**：
- 低延迟：无需 TCP 开销
- 文件系统权限：天然支持访问控制
- 简单协议：JSONL 易于调试

**代价**：
- 平台限制：Windows 支持有限
- 无网络透明性：无法远程访问

---

## 十一、相关源码文件索引

| 文件路径 | 行数 | 核心功能 |
|---------|------|----------|
| `src/node-host/runner.ts` | ~232 | Node-Host 进程入口和 Gateway 连接 |
| `src/node-host/config.ts` | ~67 | 配置文件管理 |
| `src/node-host/invoke.ts` | ~662 | 命令分发器，处理所有 node.invoke 请求 |
| `src/node-host/invoke-system-run.ts` | ~537 | system.run 命令的核心实现 |
| `src/node-host/invoke-system-run-plan.ts` | ~676 | 路径硬化、审批计划生成、快照验证 |
| `src/node-host/exec-policy.ts` | ~135 | 安全策略评估 |
| `src/infra/exec-approvals.ts` | ~588 | 审批配置文件管理 |
| `src/infra/exec-host.ts` | ~81 | Mac App Exec Host Socket 客户端 |
| `src/infra/jsonl-socket.ts` | ~60 | JSONL Socket 通信基础 |
| `src/infra/node-commands.ts` | ~14 | Node 命令常量定义 |

---

*本文档持续更新中...*
