# Infra 基础设施层 (Infrastructure Layer)

> "OpenClaw 的基础设施层是整个系统的技术底座，67,000+ 行代码提供了从执行审批到网络传输的完整支持。exec-approvals.ts 实现了多层次的命令执行安全策略——deny/allowlist/full 三级安全模型，通过 Unix Socket 实现跨进程的审批通信。exec-wrapper-resolution.ts 提供了强大的命令包装器解析能力，支持 env/nice/nohup/stdbuf/timeout 等多层嵌套，深度限制防止无限包装循环。boundary-file-read.ts 确保文件读取不会逃逸边界，hardlink 检测防止符号链接攻击。卧槽，这个 wrapper 解析太完善了——通过标志分类、值前缀匹配、分离符检测，精确识别每个包装器的语义边界，timeout 甚至知道需要额外消耗一个 duration token，这种细节处理太专业了。"

---

## 核心技术洞察

### 1. 执行审批三级安全模型

```typescript
// src/infra/exec-approvals.ts
export type ExecSecurity = "deny" | "allowlist" | "full";
export type ExecAsk = "off" | "on-miss" | "always";

export function requiresExecApproval(params: {
  ask: ExecAsk;
  security: ExecSecurity;
  analysisOk: boolean;
  allowlistSatisfied: boolean;
}): boolean {
  return (
    params.ask === "always" ||
    (params.ask === "on-miss" &&
      params.security === "allowlist" &&
      (!params.analysisOk || !params.allowlistSatisfied))
  );
}

export function resolveExecApprovalsFromFile(params: {
  file: ExecApprovalsFile;
  agentId?: string;
  overrides?: ExecApprovalsDefaultOverrides;
  path?: string;
  socketPath?: string;
  token?: string;
}): ExecApprovalsResolved {
  const file = normalizeExecApprovals(params.file);
  const defaults = file.defaults ?? {};
  const agentKey = params.agentId ?? DEFAULT_AGENT_ID;
  const agent = file.agents?.[agentKey] ?? {};
  const wildcard = file.agents?.["*"] ?? {};

  // 解析默认值
  const resolvedDefaults: Required<ExecApprovalsDefaults> = {
    security: normalizeSecurity(
      agent.security ?? wildcard.security ?? resolvedDefaults.security,
      DEFAULT_SECURITY,
    ),
    ask: normalizeAsk(
      agent.ask ?? wildcard.ask ?? resolvedDefaults.ask,
      DEFAULT_ASK,
    ),
    askFallback: normalizeSecurity(
      agent.askFallback ?? wildcard.askFallback ?? resolvedDefaults.askFallback,
      DEFAULT_ASK_FALLBACK,
    ),
    autoAllowSkills: Boolean(
      agent.autoAllowSkills ?? wildcard.autoAllowSkills ?? resolvedDefaults.autoAllowSkills,
    ),
  };

  // 合并白名单
  const allowlist = [
    ...(Array.isArray(wildcard.allowlist) ? wildcard.allowlist : []),
    ...(Array.isArray(agent.allowlist) ? agent.allowlist : []),
  ];

  return {
    path: params.path ?? resolveExecApprovalsPath(),
    socketPath: expandHomePrefix(
      params.socketPath ?? file.socket?.path ?? resolveExecApprovalsSocketPath(),
    ),
    token: params.token ?? file.socket?.token ?? "",
    defaults: resolvedDefaults,
    agent: resolvedAgent,
    allowlist,
    file,
  };
}
```

**Leon 点评**：三级安全模型设计得非常清晰：
1. **deny**：最严格，需要显式批准每个命令
2. **allowlist**：白名单模式，已批准的命令自动批准
3. **full**：完全信任，自动批准所有命令
4. **ask 策略**：控制何时询问用户批准
5. **分层覆盖**：wildcard → agent → defaults 三层配置

### 2. 命令包装器解析引擎

```typescript
// src/infra/exec-wrapper-resolution.ts
const DISPATCH_WRAPPER_NAMES = [
  "chrt", "doas", "env", "ionice", "nice", "nohup",
  "setsid", "stdbuf", "sudo", "taskset", "timeout",
] as const;

const TRANSPARENT_DISPATCH_WRAPPERS = new Set(["nice", "nohup", "stdbuf", "timeout"]);

function resolveDispatchWrapperExecutionPlan(
  argv: string[],
  maxDepth = MAX_DISPATCH_WRAPPER_DEPTH,
): DispatchWrapperExecutionPlan {
  let current = argv;
  const wrappers: string[] = [];
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const unwrap = unwrapKnownDispatchWrapperInvocation(current);
    if (unwrap.kind === "blocked") {
      return blockedDispatchWrapperPlan({
        argv: current,
        wrappers,
        blockedWrapper: unwrap.wrapper,
      });
    }
    if (unwrap.kind !== "unwrapped" || unwrap.argv.length === 0) {
      break;
    }
    wrappers.push(unwrap.wrapper);

    // 语义使用检查：防止不透明的包装器使用
    if (isSemanticDispatchWrapperUsage(unwrap.wrapper, current)) {
      return blockedDispatchWrapperPlan({
        argv: current,
        wrappers,
        blockedWrapper: unwrap.wrapper,
      });
    }
    current = unwrap.argv;
  }

  return { argv: current, wrappers, policyBlocked: false };
}

function unwrapTimeoutInvocation(argv: string[]): string[] | null {
  return unwrapDashOptionInvocation(argv, {
    onFlag: (flag, lower) => {
      if (TIMEOUT_FLAG_OPTIONS.has(flag)) {
        return "continue";
      }
      if (TIMEOUT_OPTIONS_WITH_VALUE.has(flag)) {
        return lower.includes("=") ? "continue" : "consume-next";
      }
      return "invalid";
    },
    adjustCommandIndex: (commandIndex, currentArgv) => {
      // timeout 消耗一个必需的 duration token
      const wrappedCommandIndex = commandIndex + 1;
      return wrappedCommandIndex < currentArgv.length ? wrappedCommandIndex : null;
    },
  });
}
```

**Leon 点评**：包装器解析设计得非常专业：
1. **深度限制**：防止无限包装循环攻击
2. **语义检查**：防止不透明的包装器组合
3. **特殊处理**：timeout 知道需要额外消耗 duration token
4. **标志解析**：精确识别每个包装器的选项格式
5. **透明包装器**：nice/nohup/stdbuf 等被认为是透明的

### 3. 边界文件读取保护

```typescript
// src/infra/boundary-file-read.ts
export type BoundaryFileOpenOptions = {
  absolutePath: string;
  rootPath: string;
  boundaryLabel: string;
  rejectHardlinks?: boolean;
  skipLexicalRootCheck?: boolean;
};

export function openBoundaryFileSync(params: BoundaryFileOpenOptions): {
  ok: boolean;
  path: string;
  fd: number | null;
} {
  const { absolutePath, rootPath, boundaryLabel } = params;
  const rejectHardlinks = params.rejectHardlinks !== false;

  // 规范化路径
  const resolvedRoot = safeRealpathSync(rootPath);
  const resolvedPath = safeRealpathSync(absolutePath);

  if (!resolvedRoot || !resolvedPath) {
    return { ok: false, path: absolutePath, fd: null };
  }

  // 检查路径是否在边界内
  if (!isPathInside(resolvedRoot, resolvedPath)) {
    return { ok: false, path: absolutePath, fd: null };
  }

  // 检查 hardlink
  if (rejectHardlinks) {
    const stat = fs.statSync(resolvedPath);
    if (stat.nlink > 1) {
      // 可能有 hardlink
      const fileStats = fs.fstatSync(fs.openSync(resolvedPath, "r"));
      if (fileStats.nlink > 1) {
        fs.closeSync(fs.openSync(resolvedPath, "r"));
        return { ok: false, path: absolutePath, fd: null };
      }
      fs.closeSync(fileStats.fd);
    }
  }

  const fd = fs.openSync(resolvedPath, "r");
  return { ok: true, path: resolvedPath, fd };
}
```

**Leon 点评**：边界文件读取提供了多层保护：
1. **路径验证**：确保文件在边界内
2. **Hardlink 检测**：防止通过 hardlink 逃逸
3. **Realpath 跟踪**：解析所有符号链接
4. **Lexical 检查**：确保路径词法上合法

### 4. Unix Socket 审批通信

```typescript
// src/infra/exec-approvals.ts
export async function requestExecApprovalViaSocket(params: {
  socketPath: string;
  token: string;
  request: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<ExecApprovalDecision | null> {
  const { socketPath, token, request } = params;
  if (!socketPath || !token) {
    return null;
  }

  const timeoutMs = params.timeoutMs ?? 15_000;
  const payload = JSON.stringify({
    type: "request",
    token,
    id: crypto.randomUUID(),
    request,
  });

  return await requestJsonlSocket({
    socketPath,
    payload,
    timeoutMs,
    accept: (value) => {
      const msg = value as { type?: string; decision?: ExecApprovalDecision };
      if (msg?.type === "decision" && msg.decision) {
        return msg.decision;
      }
      return undefined;
    },
  });
}
```

**Leon 点评**：Unix Socket 通信提供了安全的审批机制：
1. **Token 验证**：防止未授权访问
2. **超时控制**：防止无限等待
3. **JSONL 协议**：简洁的行协议，易于解析
4. **类型安全**：严格的类型检查

### 5. 环境变量操作检测

```typescript
// src/infra/exec-wrapper-resolution.ts
function hasEnvManipulationBeforeShellWrapperInternal(
  argv: string[],
  depth: number,
  envManipulationSeen: boolean,
): boolean {
  if (!isWithinDispatchClassificationDepth(depth)) {
    return false;
  }

  const token0 = argv[0]?.trim();
  if (!token0) {
    return false;
  }

  // 解析 dispatch wrappers
  const dispatchUnwrap = unwrapKnownDispatchWrapperInvocation(argv);
  if (dispatchUnwrap.kind === "blocked") {
    return false;
  }
  if (dispatchUnwrap.kind === "unwrapped") {
    const nextEnvManipulationSeen =
      envManipulationSeen ||
      (dispatchUnwrap.wrapper === "env" && envInvocationUsesModifiers(argv));
    return hasEnvManipulationBeforeShellWrapperInternal(
      dispatchUnwrap.argv,
      depth + 1,
      nextEnvManipulationSeen,
    );
  }

  // 解析 shell multiplexers
  const shellMultiplexerUnwrap = unwrapKnownShellMultiplexerInvocation(argv);
  if (shellMultiplexerUnwrap.kind === "blocked") {
    return false;
  }
  if (shellMultiplexerUnwrap.kind === "unwrapped") {
    return hasEnvManipulationBeforeShellWrapperInternal(
      shellMultiplexerUnwrap.argv,
      depth + 1,
      envManipulationSeen,
    );
  }

  // 检查 shell wrapper
  const wrapper = findShellWrapperSpec(normalizeExecutableToken(token0));
  if (!wrapper) {
    return false;
  }
  const payload = extractShellWrapperPayload(argv, wrapper);
  if (!payload) {
    return false;
  }

  return envManipulationSeen;
}
```

**Leon 点评**：环境变量操作检测非常细致：
1. **多层包装器支持**：dispatch → multiplexer → shell
2. **env 特殊处理**：env wrapper 本身就算环境操作
3. **递归检测**：逐层剥离包装器
4. **语义分析**：区分透明和不透明的包装器使用

---

## 一、基础设施架构总览

### 核心子系统

```
Infrastructure Layer
├── Execution Safety（执行安全）
│   ├── Approvals（审批系统）
│   │   ├── 三级安全模型
│   │   ├── Unix Socket 通信
│   │   └── 白名单管理
│   ├── Wrapper Resolution（包装器解析）
│   │   ├── Dispatch Wrappers
│   │   ├── Shell Wrappers
│   │   └── 语义检查
│   ├── Safe Bin Policy（安全二进制策略）
│   │   ├── Trust Path
│   │   ├── Profile 配置
│   │   └── 运行时验证
│   └── Command Analysis（命令分析）
│       ├── Obfuscation Detection
│       └── Safety Checks
├── File System（文件系统）
│   ├── Boundary Reads（边界读取）
│   ├── Path Safety（路径安全）
│   ├── Archive Support（归档支持）
│   └── File Lock（文件锁）
├── Networking（网络）
│   ├── Ports（端口管理）
│   ├── SSH Tunnel（SSH 隧道）
│   ├── Bonjour（服务发现）
│   └── Tailscale（Tailscale 集成）
├── State Management（状态管理）
│   ├── Heartbeat Runner（心跳）
│   ├── Session Cost Usage（会话成本）
│   ├── Agent Events（Agent 事件）
│   └── State Migrations（状态迁移）
├── Platform Integration（平台集成）
│   ├── Home Dir（主目录）
│   ├── Brew（Homebrew）
│   ├── Package Managers（包管理器）
│   └── Device Auth（设备认证）
└── Utilities（工具）
    ├── Errors（错误处理）
    ├── Backoff（退避重试）
    ├── Fetch（HTTP 客户端）
    └── Clipboard（剪贴板）
```

---

## 二、执行安全系统

### 安全级别

| 级别 | 描述 | 使用场景 |
|------|------|----------|
| deny | 拒绝所有 | 默认，最安全 |
| allowlist | 白名单 | 需要预批准的命令 |
| full | 完全信任 | 本地开发环境 |

### 审批流程

```
Command Request
    ↓
Resolve Approvals (agent + overrides)
    ↓
Check Security Level
    ↓
┌─────────────┬──────────────┬─────────────┐
│  deny       │  allowlist    │    full      │
└─────────────┴──────────────┴─────────────┘
    ↓             ↓               ↓
  Always Ask   Check Allowlist   Auto Approve
    ↓             ↓               ↓
Request Approval  Check Match    Approve
    ↓             ↓               ↓
Wait Decision   Return         Return
```

### 审批请求

```typescript
export type ExecApprovalRequestPayload = {
  command: string;
  commandArgv?: string[];
  envKeys?: string[];
  systemRunBinding?: SystemRunApprovalBinding | null;
  systemRunPlan?: SystemRunApprovalPlan | null;
  cwd?: string | null;
  nodeId?: string | null;
  host?: string | null;
  security?: string | null;
  ask?: string | null;
  agentId?: string | null;
  resolvedPath?: string;
  sessionKey?: string;
  turnSourceChannel?: string | null;
  turnSourceTo?: string | null;
  turnSourceAccountId?: string | null;
  turnSourceThreadId?: string | number | null;
};
```

### 白名单管理

```typescript
export type ExecAllowlistEntry = {
  id?: string;
  pattern: string;
  lastUsedAt?: number;
  lastUsedCommand?: string;
  lastResolvedPath?: string;
};

export function recordAllowlistUse(
  approvals: ExecApprovalsFile,
  agentId: string | undefined,
  entry: ExecAllowlistEntry,
  command: string,
  resolvedPath?: string,
) {
  const target = agentId ?? DEFAULT_AGENT_ID;
  const agents = approvals.agents ?? {};
  const existing = agents[target] ?? {};
  const allowlist = Array.isArray(existing.allowlist) ? existing.allowlist : [];

  const nextAllowlist = allowlist.map((item) =>
    item.pattern === entry.pattern
      ? {
          ...item,
          id: item.id ?? crypto.randomUUID(),
          lastUsedAt: Date.now(),
          lastUsedCommand: command,
          lastResolvedPath: resolvedPath,
        }
      : item,
  );

  agents[target] = { ...existing, allowlist: nextAllowlist };
  approvals.agents = agents;
  saveExecApprovals(approvals);
}
```

---

## 三、包装器解析系统

### 包装器分类

```typescript
// Dispatch Wrappers（调度包装器）
const DISPATCH_WRAPPER_NAMES = [
  "chrt",    // Linux CPU 调度
  "doas",    // OpenBSD doas
  "env",     // 环境变量
  "ionice",   // Linux IO 调度
  "nice",    // 进程优先级
  "nohup",   // 忽略 HUP 信号
  "setsid",  // 创建会话
  "stdbuf",  // 缓冲区控制
  "sudo",    // 以超级用户执行
  "taskset",  // CPU 亲和性
  "timeout", // 超时控制
] as const;

// Shell Wrappers（Shell 包装器）
const POSIX_SHELL_WRAPPER_NAMES = ["ash", "bash", "dash", "fish", "ksh", "sh", "zsh"];
const WINDOWS_CMD_WRAPPER_NAMES = ["cmd"];
const POWERSHELL_WRAPPER_NAMES = ["powershell", "pwsh"];

// Shell Multiplexers（Shell 多路复用器）
const SHELL_MULTIPLEXER_WRAPPER_NAMES = ["busybox", "toybox"];
```

### 解析流程

```
Input: ["timeout", "10s", "env", "VAR=val", "sh", "-c", "echo", "test"]
    ↓
Step 1: Parse timeout wrapper
    ↓
Unwrap: ["env", "VAR=val", "sh", "-c", "echo", "test"]
Wrapper: timeout
    ↓
Step 2: Parse env wrapper
    ↓
Unwrap: ["sh", "-c", "echo", "test"]
Wrapper: timeout, env
    ↓
Step 3: Parse shell wrapper
    ↓
Extract Command: echo test
Wrappers: timeout, env, sh
```

### 选项解析

```typescript
function unwrapDashOptionInvocation(
  argv: string[],
  params: {
    onFlag: (flag: string, lowerToken: string) => WrapperScanDirective;
    adjustCommandIndex?: (commandIndex: number, argv: string[]) => number | null;
  },
): string[] | null {
  return scanWrapperInvocation(argv, {
    separators: new Set(["--"]),
    onToken: (token, lower) => {
      if (!token.startsWith("-") || token === "-") {
        return "stop";  // 命令开始
      }
      const [flag] = lower.split("=", 2);
      return params.onFlag(flag, lower);
    },
    adjustCommandIndex: params.adjustCommandIndex,
  });
}
```

### 扫描指令

| 指令 | 描述 |
|------|------|
| continue | 继续扫描下一个 token |
| consume-next | 消费下一个 token 作为值 |
| stop | 停止扫描，找到命令 |
| invalid | 无效语法，解析失败 |

---

## 四、边界文件保护

### 边界检查

```typescript
function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}
```

### Hardlink 检测

```typescript
function checkHardlinkSafety(filePath: string): boolean {
  const stat = fs.statSync(filePath);
  if (stat.nlink > 1) {
    // 可能有 hardlink
    const fileStats = fs.fstatSync(fs.openSync(filePath, "r"));
    if (fileStats.nlink > 1) {
      fs.closeSync(fs.openSync(filePath, "r"));
      return false;  // 确认有 hardlink
    }
    fs.closeSync(fileStats.fd);
  }
  return true;
}
```

### 边界文件打开

```typescript
export function openBoundaryFileSync(params: BoundaryFileOpenOptions): {
  ok: boolean;
  path: string;
  fd: number | null;
} {
  const { absolutePath, rootPath, boundaryLabel } = params;
  const rejectHardlinks = params.rejectHardlinks !== false;

  // 规范化路径
  const resolvedRoot = safeRealpathSync(rootPath);
  const resolvedPath = safeRealpathSync(absolutePath);

  if (!resolvedRoot || !resolvedPath) {
    return { ok: false, path: absolutePath, fd: null };
  }

  // 检查边界
  if (!isPathInside(resolvedRoot, resolvedPath)) {
    return { ok: false, path: absolutePath, fd: null };
  }

  // 检查 hardlink
  if (rejectHardlinks) {
    const stat = fs.statSync(resolvedPath);
    if (stat.nlink > 1) {
      const fileStats = fs.fstatSync(fs.openSync(resolvedPath, "r"));
      if (fileStats.nlink > 1) {
        fs.closeSync(fs.openSync(resolvedPath, "r"));
        return { ok: false, path: absolutePath, fd: null };
      }
      fs.closeSync(fileStats.fd);
    }
  }

  const fd = fs.openSync(resolvedPath, "r");
  return { ok: true, path: resolvedPath, fd };
}
```

---

## 五、网络子系统

### 端口管理

```typescript
// src/infra/ports-probe.ts
export function findAvailablePort(params: {
  preferredPort?: number;
  host?: string;
  minPort?: number;
  maxPort?: number;
  excludePorts?: number[];
}): Promise<number | null> {
  const {
    preferredPort = 18789,
    host = "127.0.0.1",
    minPort = 1024,
    maxPort = 65535,
    excludePorts = [],
  } = params;

  const tryPort = async (port: number): Promise<boolean> => {
    if (port < minPort || port > maxPort) {
      return false;
    }
    if (excludePorts.includes(port)) {
      return false;
    }
    try {
      const server = net.createServer();
      await new Promise<void>((resolve, reject) => {
        server.on("error", reject);
        server.listen(port, host, () => {
          server.close(() => resolve());
        });
      });
      return true;
    } catch {
      return false;
    }
  };

  // 尝试首选端口
  if (preferredPort && await tryPort(preferredPort)) {
    return preferredPort;
  }

  // 搜索可用端口
  for (let port = minPort; port <= maxPort; port += 1) {
    if (await tryPort(port)) {
      return port;
    }
  }

  return null;
}
```

### SSH 隧道

```typescript
// src/infra/ssh-tunnel.ts
export type SSHTunnelConfig = {
  localHost: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  sshHost: string;
  sshUser?: string;
  sshKey?: string;
};

export async function createSSHTunnel(config: SSHTunnelConfig): Promise<void> {
  const sshArgs = [
    config.sshHost ?? `${config.sshUser ?? "root"}@${config.sshHost}`,
    "-L",
    `${config.localHost}:${config.localPort}:${config.remoteHost}:${config.remotePort}`,
    "-N",  // 不执行远程命令
    "-o", "ExitOnForwardFailure=yes",
  ];

  if (config.sshKey) {
    sshArgs.push("-i", config.sshKey);
  }

  const process = spawn("ssh", sshArgs, {
    stdio: "ignore",
    detached: true,
  });

  // 等待隧道建立
  await new Promise<void>((resolve, reject) => {
    process.on("error", reject);
    process.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`SSH tunnel exited with code ${code}`));
      }
    });

    // 简单的连接测试
    setTimeout(() => {
      const socket = net.connect(config.localPort, config.localHost, () => {
        socket.destroy();
        resolve();
      });
      socket.on("error", () => {
        // 端口可能还没准备好
      });
    }, 1000);
  });
}
```

### 服务发现

```typescript
// src/infra/bonjour.ts
export type BonjourService = {
  name: string;
  type: string;
  port: number;
  host?: string;
  txt?: Record<string, string>;
};

export function publishBonjourService(params: {
  service: BonjourService;
}): Promise<mDNS.BonjourService> {
  const { service } = params;

  return new Promise((resolve, reject) => {
    const bonjour = mDNS.createBonjour(undefined, {
      interface: params.service.host ? undefined : "0.0.0.0",
    });

    const server = bonjour.publish({
      name: service.name,
      type: service.type,
      port: service.port,
      host: service.host,
      txt: service.txt,
    });

    server.on("error", (err) => {
      reject(err);
    });

    server.on("up", () => {
      resolve(bonjour);
    });
  });
}
```

---

## 六、状态管理

### 心跳运行器

```typescript
// src/infra/heartbeat-runner.ts
export type HeartbeatRunnerConfig = {
  enabled: boolean;
  intervalMs: number;
  jitterMs?: number;
  maxFailedAttempts?: number;
};

export async function runHeartbeatLoop(params: {
  agentId: string;
  cfg: OpenClawConfig;
  onTick: (result: HeartbeatTick) => void | Promise<void>;
}): Promise<void> {
  const config = resolveHeartbeatRunnerConfig(params.cfg, params.agentId);
  if (!config.enabled) {
    return;
  }

  const { intervalMs, jitterMs, maxFailedAttempts } = config;
  let failedAttempts = 0;

  while (true) {
    const startedAt = Date.now();
    try {
      const result = await fetchHeartbeatTick({
        agentId: params.agentId,
        cfg: params.cfg,
      });

      failedAttempts = 0;  // 重置失败计数
      await params.onTick(result);

      // 计算下次执行时间
      const elapsed = Date.now()() - startedAt;
      const delay = Math.max(0, intervalMs - elapsed);
      const jitter = jitterMs ? Math.floor(Math.random() * jitterMs) : 0;

      await sleep(delay + jitter);
    } catch (err) {
      failedAttempts++;

      if (maxFailedAttempts && failedAttempts >= maxFailedAttempts) {
        throw new Error(`Heartbeat failed after ${failedAttempts} attempts: ${err}`);
      }

      // 失败后快速重试
      await sleep(1000);
    }
  }
}
```

### 会话成本追踪

```typescript
// src/infra/session-cost-usage.ts
export type SessionCostUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
};

export function recordSessionCostUsage(params: {
  agentId: string;
  sessionId: string;
  usage: SessionCostUsage;
}): void {
  const key = `${params.agentId}:${params.sessionId}`;
  const store = getSessionCostUsageStore();

  store.set(key, {
    ...params.usage,
    recordedAt: Date.now(),
  });

  // 持久化到磁盘
  persistSessionCostUsage();
}
```

### 状态迁移

```typescript
// src/infra/state-migrations.ts
export type StateMigration = {
  version: number;
  description: string;
  migrate: (data: unknown) => unknown;
};

export const STATE_MIGRATIONS: StateMigration[] = [
  {
    version: 1,
    description: "Initial version",
    migrate: (data) => data,
  },
  {
    version: 2,
    description: "Add agents field",
    migrate: (data) => ({
      ...data,
      agents: {},
    }),
  },
  // ... 更多迁移
];

export function runStateMigrations(data: unknown): unknown {
  let current = data;
  const migrations = STATE_MIGRATIONS.filter(m => m.version > (current?.version ?? 0));

  for (const migration of migrations) {
    try {
      current = migration.migrate(current);
    } catch (err) {
      throw new Error(`State migration v${migration.version} failed: ${err}`);
    }
  }

  return current;
}
```

---

## 七、技术权衡

### 1. Deny vs Allowlist vs Full

| 方案 | 优势 | 劣势 |
|------|------|------|
| Deny | 最安全、用户控制 | 需要频繁批准 |
| Allowlist | 平衡安全与便利 | 需要预配置 |
| Full | 最方便 | 安全风险高 |

**选择**：默认 deny
**原因**：安全第一，默认最安全策略

### 2. Socket vs 文件通信

| 方案 | 优势 | 劣势 |
|------|------|------|
| Socket | 实时、跨进程 | 复杂度高 |
| 文件 | 简单、可靠 | 延迟高 |

**选择**：Unix Socket
**原因**：审批需要实时响应

### 3. 包装器解析 vs 直接执行

| 方案 | 优势 | 劣势 |
|------|------|------|
| 解析包装器 | 精确控制、可审计 | 复杂度高 |
| 直接执行 | 简单、快速 | 安全风险 |

**选择**：解析包装器
**原因**：安全性和可审计性

### 4. 边界检查 vs 直接打开

| 方案 | 优势 | 劣势 |
|------|------|------|
| 边界检查 | 安全、可控 | 性能开销 |
| 直接打开 | 简单、快速 | 安全风险 |

**选择**：边界检查
**原因**：防止路径逃逸攻击

---

*本文档基于源码分析，涵盖基础设施层的架构、执行安全、包装器解析、边界保护、网络子系统以及技术权衡。*
