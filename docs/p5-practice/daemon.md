# Daemon 守护进程 (Daemon)

> "OpenClaw 的守护进程系统实现了跨平台后台服务的统一管理，通过抽象层屏蔽 macOS LaunchAgent、Linux systemd 和 Windows Scheduled Task 的差异。卧槽，这个设计太优雅了——一套接口支持三大平台，每个平台都有自己的最佳实践，而且还能处理 fallback、legacy 清理和 linger。特别是 Platform Registry 模式，通过 `GATEWAY_SERVICE_REGISTRY` 实现了零成本的平台分发，而 linger 机制解决了 Linux user services 的持久化问题。"

---

## 核心技术洞察

### 1. 平台服务注册表

```typescript
// src/daemon/service.ts
type SupportedGatewayServicePlatform = "darwin" | "linux" | "win32";

const GATEWAY_SERVICE_REGISTRY: Record<SupportedGatewayServicePlatform, GatewayService> = {
  darwin: {
    label: "LaunchAgent",
    loadedText: "loaded",
    notLoadedText: "not loaded",
    install: ignoreInstallResult(installLaunchAgent),
    uninstall: uninstallLaunchAgent,
    stop: stopLaunchAgent,
    restart: restartLaunchAgent,
    isLoaded: isLaunchAgentLoaded,
    readCommand: readLaunchAgentProgramArguments,
    readRuntime: readLaunchAgentRuntime,
  },
  linux: {
    label: "systemd",
    loadedText: "enabled",
    notLoadedText: "disabled",
    install: ignoreInstallResult(installSystemdService),
    uninstall: uninstallSystemdService,
    stop: stopSystemdService,
    restart: restartSystemdService,
    isLoaded: isSystemdServiceEnabled,
    readCommand: readSystemdServiceExecStart,
    readRuntime: readSystemdServiceRuntime,
  },
  win32: {
    label: "Scheduled Task",
    loadedText: "registered",
    notLoadedText: "missing",
    install: ignoreInstallResult(installScheduledTask),
    uninstall: uninstallScheduledTask,
    stop: stopScheduledTask,
    restart: restartScheduledTask,
    isLoaded: isScheduledTaskInstalled,
    readCommand: readScheduledTaskCommand,
    readRuntime: readScheduledTaskRuntime,
  },
};

export function resolveGatewayService(): GatewayService {
  if (isSupportedGatewayServicePlatform(process.platform)) {
    return GATEWAY_SERVICE_REGISTRY[process.platform];
  }
  throw new Error(`Gateway service install not supported on ${process.platform}`);
}
```

**Leon 点评**：平台注册表设计非常精妙：
1. **类型安全**：通过 `SupportedGatewayServicePlatform` 确保只支持已知平台
2. **统一接口**：`GatewayService` 类型定义了跨平台一致的操作
3. **运行时分发**：`resolveGatewayService()` 根据平台返回对应实现
4. **零分支**：调用方完全不需要平台判断，直接调用方法即可
5. **文本本地化**：`loadedText`/`notLoadedText` 适应不同平台的术语

### 2. LaunchAgent 智能安装

```typescript
// src/daemon/launchd.ts
export async function installLaunchAgent({
  env,
  stdout,
  programArguments,
  workingDirectory,
  environment,
  description,
}: GatewayServiceInstallArgs): Promise<{ plistPath: string }> {
  const { logDir, stdoutPath, stderrPath } = resolveGatewayLogPaths(env);
  await ensureSecureDirectory(logDir);

  const domain = resolveGuiDomain();
  const label = resolveLaunchAgentLabel({ env });

  // 1. 清理旧版服务
  for (const legacyLabel of resolveLegacyGatewayLaunchAgentLabels(env.OPENCLAW_PROFILE)) {
    const legacyPlistPath = resolveLaunchAgentPlistPathForLabel(env, legacyLabel);
    await execLaunchctl(["bootout", domain, legacyPlistPath]);
    await execLaunchctl(["unload", legacyPlistPath]);
    try {
      await fs.unlink(legacyPlistPath);
    } catch {
      // ignore
    }
  }

  // 2. 创建安全目录
  const plistPath = resolveLaunchAgentPlistPathForLabel(env, label);
  const home = toPosixPath(resolveHomeDir(env));
  const libraryDir = path.posix.join(home, "Library");
  await ensureSecureDirectory(home);
  await ensureSecureDirectory(libraryDir);
  await ensureSecureDirectory(path.dirname(plistPath));

  // 3. 构建 plist 文件
  const serviceDescription = resolveGatewayServiceDescription({ env, environment, description });
  const plist = buildLaunchAgentPlist({
    label,
    comment: serviceDescription,
    programArguments,
    workingDirectory,
    stdoutPath,
    stderrPath,
    environment,
  });
  await fs.writeFile(plistPath, plist, { encoding: "utf8", mode: LAUNCH_AGENT_PLIST_MODE });
  await fs.chmod(plistPath, LAUNCH_AGENT_PLIST_MODE).catch(() => undefined);

  // 4. 启动服务（处理 launchd 持久状态）
  await execLaunchctl(["bootout", domain, plistPath]);
  await execLaunchctl(["unload", plistPath]);
  await execLaunchctl(["enable", `${domain}/${label}`]); // 清除 disabled 状态
  const boot = await execLaunchctl(["bootstrap", domain, plistPath]);
  if (boot.code !== 0) {
    const detail = (boot.stderr || boot.stdout).trim();
    if (isUnsupportedGuiDomain(detail)) {
      throw new Error([
        `launchctl bootstrap failed: ${detail}`,
        `LaunchAgent install requires a logged-in macOS GUI session for this user (${domain}).`,
        "This usually means you are running from SSH/headless context or as the wrong user (including sudo).",
        "Fix: sign in to the macOS desktop as the target user and rerun `openclaw gateway install --force`.",
        "Headless deployments should use a dedicated logged-in user session or a custom LaunchDaemon (not shipped): https://docs.openclaw.ai/gateway",
      ].join("\n"));
    }
    throw new Error(`launchctl bootstrap failed: ${detail}`);
  }
  await execLaunchctl(["kickstart", "-k", `${domain}/${label}`]);

  writeFormattedLines(stdout, [
    { label: "Installed LaunchAgent", value: plistPath },
    { label: "Logs", value: stdoutPath },
  ], { leadingBlankLine: true });
  return { plistPath };
}
```

**Leon 点评**：LaunchAgent 安装流程考虑得非常周全：
1. **旧版清理**：自动清理 legacy 服务，避免冲突
2. **安全目录**：确保目录权限正确（0o755/0o644）
3. **持久状态处理**：通过 `enable` 命令清除 launchd 的 "disabled" 状态
4. **GUI 会话检测**：识别 SSH/headless 环境，给出友好错误提示
5. **完整生命周期**：bootout → unload → enable → bootstrap → kickstart

### 3. Systemd User Scope 回退

```typescript
// src/daemon/systemd.ts
async function execSystemctlUser(
  env: GatewayServiceEnv,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  const machineUser = resolveSystemctlMachineScopeUser(env);
  const sudoUser = env.SUDO_USER?.trim();

  // Under sudo, prefer the invoking non-root user's scope directly.
  if (sudoUser && sudoUser !== "root" && machineUser) {
    const machineScopeArgs = resolveSystemctlMachineUserScopeArgs(machineUser);
    if (machineScopeArgs.length > 0) {
      return await execSystemctl([...machineScopeArgs, ...args]);
    }
  }

  const directResult = await execSystemctl([...resolveSystemctlDirectUserScopeArgs(), ...args]);
  if (directResult.code === 0) {
    return directResult;
  }

  const detail = `${directResult.stderr} ${directResult.stdout}`.trim();
  if (!machineUser || !shouldFallbackToMachineUserScope(detail)) {
    return directResult;
  }

  const machineScopeArgs = resolveSystemctlMachineUserScopeArgs(machineUser);
  if (machineScopeArgs.length === 0) {
    return directResult;
  }
  return await execSystemctl([...machineScopeArgs, ...args]);
}

function shouldFallbackToMachineUserScope(detail: string): boolean {
  const normalized = detail.toLowerCase();
  return (
    normalized.includes("failed to connect to bus") ||
    normalized.includes("failed to connect to user scope bus") ||
    normalized.includes("dbus_session_bus_address") ||
    normalized.includes("xdg_runtime_dir")
  );
}
```

**Leon 点评**：systemd user scope 回退机制非常健壮：
1. **多上下文支持**：同时支持 direct user scope 和 machine user scope
2. **智能回退**：当 D-Bus 连接失败时自动尝试 machine scope
3. **Sudo 友好**：在 sudo 环境下优先使用调用者的 user scope
4. **错误识别**：通过特定错误消息判断是否需要回退
5. **无缝体验**：用户无需关心底层调用细节

### 4. Systemd Linger 支持

```typescript
// src/daemon/systemd-linger.ts
export type SystemdUserLingerStatus = {
  user: string;
  linger: "yes" | "no";
};

export async function readSystemdUserLingerStatus(
  env: Record<string, string | undefined>,
): Promise<SystemdUserLingerStatus | null> {
  const user = resolveLoginctlUser(env);
  if (!user) {
    return null;
  }
  try {
    const { stdout } = await runExec("loginctl", ["show-user", user, "-p", "Linger"], {
      timeoutMs: 5_000,
    });
    const line = stdout
      .split("\n")
      .map((entry) => entry.trim())
      .find((entry) => entry.startsWith("Linger="));
    const value = line?.split("=")[1]?.trim().toLowerCase();
    if (value === "yes" || value === "no") {
      return { user, linger: value };
    }
  } catch {
    // ignore; loginctl may be unavailable
  }
  return null;
}

export async function enableSystemdUserLinger(params: {
  env: Record<string, string | undefined>;
  user?: string;
  sudoMode?: "prompt" | "non-interactive";
}): Promise<{ ok: boolean; stdout: string; stderr: string; code: number }> {
  const user = params.user ?? resolveLoginctlUser(params.env);
  if (!user) {
    return { ok: false, stdout: "", stderr: "Missing user", code: 1 };
  }
  const needsSudo = typeof process.getuid === "function" ? process.getuid() !== 0 : true;
  const sudoArgs =
    needsSudo && params.sudoMode !== undefined
      ? ["sudo", ...(params.sudoMode === "non-interactive" ? ["-n"] : [])]
      : [];
  const argv = [...sudoArgs, "loginctl", "enable-linger", user];
  try {
    const result = await runCommandWithTimeout(argv, { timeoutMs: 30_000 });
    return {
      ok: result.code === 0,
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.code ?? 1,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, stdout: "", stderr: message, code: 1 };
  }
}
```

**Leon 点评**：linger 支持解决了 Linux user services 的关键问题：
1. **持久化运行**：linger 允许用户服务在登出后继续运行
2. **状态查询**：通过 `loginctl show-user` 查询 linger 状态
3. **自动启用**：检测到需要时自动启用 linger
4. **Sudo 处理**：正确处理需要 root 权限的情况
5. **非交互模式**：支持自动化场景的非交互式启用

### 5. 运行时 Node.js 路径解析

```typescript
// src/daemon/runtime-paths.ts
export async function resolvePreferredNodePath(params: {
  env?: Record<string, string | undefined>;
  runtime?: string;
  platform?: NodeJS.Platform;
  execFile?: ExecFileAsync;
  execPath?: string;
}): Promise<string | undefined> {
  if (params.runtime !== "node") {
    return undefined;
  }

  // 优先使用当前运行的 node（尊重版本管理器）
  const platform = params.platform ?? process.platform;
  const currentExecPath = params.execPath ?? process.execPath;
  if (currentExecPath && isNodeExecPath(currentExecPath, platform)) {
    const execFileImpl = params.execFile ?? execFileAsync;
    const version = await resolveNodeVersion(currentExecPath, execFileImpl);
    if (isSupportedNodeVersion(version)) {
      return resolveStableNodePath(currentExecPath);
    }
  }

  // 回退到系统 node
  const systemNode = await resolveSystemNodeInfo(params);
  if (!systemNode?.supported) {
    return undefined;
  }
  return systemNode.path;
}

export function isVersionManagedNodePath(
  nodePath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const normalized = normalizeForCompare(nodePath, platform);
  return VERSION_MANAGER_MARKERS.some((marker) => normalized.includes(marker));
}

const VERSION_MANAGER_MARKERS = [
  "/.nvm/",
  "/.fnm/",
  "/.volta/",
  "/.asdf/",
  "/.n/",
  "/.nodenv/",
  "/.nodebrew/",
  "/nvs/",
];
```

**Leon 点评**：Node.js 路径解析考虑了版本管理器生态：
1. **版本管理器优先**：优先使用当前活跃的版本管理器中的 node
2. **系统 Node 回退**：当版本管理器不可用时回退到系统 node
3. **版本检查**：确保选中的 node 版本符合要求（Node 22+）
4. **标记识别**：通过路径标记识别版本管理器（nvm/fnm/volta 等）
5. **跨平台支持**：正确处理 macOS/Linux/Windows 的路径差异

---

## 一、守护进程架构总览

### 核心组件

```
Daemon Module
├── Service Registry（服务注册表）
│   ├── Platform Dispatch
│   ├── Unified Interface
│   └── Operation Mapping
├── macOS LaunchAgent
│   ├── Plist Generation
│   ├── launchctl Integration
│   └── GUI Domain Handling
├── Linux Systemd
│   ├── Unit File Generation
│   ├── systemctl Integration
│   ├── User Scope Fallback
│   └── Linger Support
├── Windows Scheduled Task
│   ├── Task Script Generation
│   ├── schtasks Integration
│   └── CMD Quoting
├── Runtime Management（运行时管理）
│   ├── Node.js Path Resolution
│   ├── Version Detection
│   └── System Node Fallback
└── Diagnostics（诊断）
    ├── Service Inspection
    ├── Extra Service Detection
    └── Log Analysis
```

### 处理流程

```
Install Gateway Service
    ↓
Resolve Platform Service
    ↓
Parse Install Args
    ↓
Generate Config (plist/unit/cmd)
    ↓
Secure Directories
    ↓
Write Config File
    ↓
Load Service (bootstrap/enable/run)
    ↓
Verify Status
```

---

## 二、类型系统

### 服务接口

```typescript
export type GatewayService = {
  label: string;
  loadedText: string;
  notLoadedText: string;
  install: (args: GatewayServiceInstallArgs) => Promise<void>;
  uninstall: (args: GatewayServiceManageArgs) => Promise<void>;
  stop: (args: GatewayServiceControlArgs) => Promise<void>;
  restart: (args: GatewayServiceControlArgs) => Promise<void>;
  isLoaded: (args: GatewayServiceEnvArgs) => Promise<boolean>;
  readCommand: (env: GatewayServiceEnv) => Promise<GatewayServiceCommandConfig | null>;
  readRuntime: (env: GatewayServiceEnv) => Promise<GatewayServiceRuntime>;
};
```

### 安装参数

```typescript
export type GatewayServiceInstallArgs = {
  env: GatewayServiceEnv;
  stdout: NodeJS.WritableStream;
  programArguments: string[];
  workingDirectory?: string;
  environment?: GatewayServiceEnv;
  description?: string;
};
```

### 运行时状态

```typescript
export type GatewayServiceRuntime = {
  status?: string;          // "running" | "stopped" | "unknown"
  state?: string;           // platform-specific state
  subState?: string;        // systemd sub-state
  pid?: number;             // main process PID
  lastExitStatus?: number;  // last exit code
  lastExitReason?: string;  // exit reason
  lastRunResult?: string;   // Windows task result
  lastRunTime?: string;     // Windows last run time
  detail?: string;          // error details
  cachedLabel?: boolean;    // launchd cached label
  missingUnit?: boolean;    // unit file missing
};
```

### 环境变量

```typescript
export type GatewayServiceEnv = Record<string, string | undefined>;
```

---

## 三、平台实现

### macOS LaunchAgent

#### 特点

- **GUI Domain**: `gui/<uid>` 用于用户会话
- **Plist Format**: XML 格式的配置文件
- **Launchctl**: 服务管理命令行工具
- **ThrottleInterval**: 防止频繁重启

#### 安装流程

```bash
# 1. 清理旧版服务
launchctl bootout gui/$UID/<label>
launchctl unload <plist-path>

# 2. 写入 plist 文件
cp plist ~/Library/LaunchAgents/<label>.plist

# 3. 启用服务
launchctl enable gui/$UID/<label>
launchctl bootstrap gui/$UID <plist-path>
launchctl kickstart -k gui/$UID/<label>
```

#### 配置文件位置

| 类型 | 路径 |
|------|------|
| User | `~/Library/LaunchAgents/` |
| System | `/Library/LaunchAgents/` |
| Daemon | `/Library/LaunchDaemons/` |

### Linux Systemd

#### 特点

- **User Scope**: `--user` 用于用户服务
- **Unit Format**: INI 格式的配置文件
- **Systemctl**: 服务管理命令行工具
- **Linger**: 登出后保持运行

#### 安装流程

```bash
# 1. 写入 unit 文件
cp unit ~/.config/systemd/user/<service>.service

# 2. 重载 systemd
systemctl --user daemon-reload

# 3. 启用并启动服务
systemctl --user enable <service>.service
systemctl --user restart <service>.service
```

#### 配置文件位置

| 类型 | 路径 |
|------|------|
| User | `~/.config/systemd/user/` |
| System | `/etc/systemd/system/` |
| Global | `/usr/lib/systemd/system/` |

### Windows Scheduled Task

#### 特点

- **Task Scheduler**: Windows 任务计划程序
- **ONLOGON Trigger**: 用户登录时启动
- **LIMITED Token**: 限制权限级别
- **CMD Script**: 生成批处理脚本

#### 安装流程

```cmd
REM 1. 生成任务脚本
echo @echo off > gateway.cmd
echo openclaw gateway run >> gateway.cmd

REM 2. 创建计划任务
schtasks /Create /F /SC ONLOGON /RL LIMITED /TN "OpenClaw Gateway" /TR "gateway.cmd"

REM 3. 运行任务
schtasks /Run /TN "OpenClaw Gateway"
```

#### 配置文件位置

| 类型 | 路径 |
|------|------|
| Script | `%OPENCLAW_STATE_DIR%\gateway.cmd` |
| Task | Task Scheduler (注册表) |

---

## 四、配置生成

### LaunchAgent Plist

```typescript
// src/daemon/launchd-plist.ts
export function buildLaunchAgentPlist({
  label,
  comment,
  programArguments,
  workingDirectory,
  stdoutPath,
  stderrPath,
  environment,
}: {
  label: string;
  comment?: string;
  programArguments: string[];
  workingDirectory?: string;
  stdoutPath: string;
  stderrPath: string;
  environment?: Record<string, string | undefined>;
}): string {
  // XML plist 生成
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${plistEscape(label)}</string>
    <key>Comment</key>
    <string>${plistEscape(comment ?? "")}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>${LAUNCH_AGENT_THROTTLE_INTERVAL_SECONDS}</integer>
    <key>Umask</key>
    <integer>${LAUNCH_AGENT_UMASK_DECIMAL}</integer>
    <key>ProgramArguments</key>
    <array>${programArguments.map(arg => `\n      <string>${plistEscape(arg)}</string>`).join("")}
    </array>
    ${workingDirectory ? `
    <key>WorkingDirectory</key>
    <string>${plistEscape(workingDirectory)}</string>` : ""}
    <key>StandardOutPath</key>
    <string>${plistEscape(stdoutPath)}</string>
    <key>StandardErrorPath</key>
    <string>${plistEscape(stderrPath)}</string>${environment ? `
    <key>EnvironmentVariables</key>
    <dict>${Object.entries(environment).map(([key, value]) =>
      `\n    <key>${plistEscape(key)}</key>\n    <string>${plistEscape(value ?? "")}</string>`
    ).join("")}\n    </dict>` : ""}
  </dict>
</plist>
`;
}
```

### Systemd Unit

```typescript
// src/daemon/systemd-unit.ts
export function buildSystemdUnit({
  description,
  programArguments,
  workingDirectory,
  environment,
}: GatewayServiceRenderArgs): string {
  const execStart = programArguments.map(systemdEscapeArg).join(" ");
  const descriptionValue = description?.trim() || "OpenClaw Gateway";
  const descriptionLine = `Description=${descriptionValue}`;
  const workingDirLine = workingDirectory
    ? `WorkingDirectory=${systemdEscapeArg(workingDirectory)}`
    : null;
  const envLines = renderEnvLines(environment);
  return [
    "[Unit]",
    descriptionLine,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    `ExecStart=${execStart}`,
    "Restart=always",
    "RestartSec=5",
    "TimeoutStopSec=30",
    "TimeoutStartSec=30",
    "SuccessExitStatus=0 143",
    "KillMode=control-group",
    workingDirLine,
    ...envLines,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].filter((line) => line !== null).join("\n");
}
```

### Windows Task Script

```typescript
// src/daemon/schtasks.ts
function buildTaskScript({
  description,
  programArguments,
  workingDirectory,
  environment,
}: GatewayServiceRenderArgs): string {
  const lines: string[] = ["@echo off"];
  const trimmedDescription = description?.trim();
  if (trimmedDescription) {
    lines.push(`rem ${trimmedDescription}`);
  }
  if (workingDirectory) {
    lines.push(`cd /d ${quoteCmdScriptArg(workingDirectory)}`);
  }
  if (environment) {
    for (const [key, value] of Object.entries(environment)) {
      if (!value || key.toUpperCase() === "PATH") {
        continue;
      }
      lines.push(renderCmdSetAssignment(key, value));
    }
  }
  const command = programArguments.map(quoteCmdScriptArg).join(" ");
  lines.push(command);
  return `${lines.join("\r\n")}\r\n`;
}
```

---

## 五、服务标签

### 默认标签

| 平台 | Gateway 服务 | Node 服务 |
|------|-------------|----------|
| macOS | `ai.openclaw.gateway` | `ai.openclaw.node` |
| Linux | `openclaw-gateway` | `openclaw-node` |
| Windows | `OpenClaw Gateway` | `OpenClaw Node` |

### Profile 后缀

```typescript
export function resolveGatewayProfileSuffix(profile?: string): string {
  const normalized = normalizeGatewayProfile(profile);
  return normalized ? `-${normalized}` : "";
}

// 示例
// profile="beta" → "-beta"
// profile="default" → ""
// profile=null → ""
```

### 标签示例

| Profile | macOS Label | Linux Unit | Windows Task |
|---------|-------------|------------|--------------|
| default | `ai.openclaw.gateway` | `openclaw-gateway` | `OpenClaw Gateway` |
| beta | `ai.openclaw.beta` | `openclaw-gateway-beta` | `OpenClaw Gateway (beta)` |
| prod | `ai.openclaw.prod` | `openclaw-gateway-prod` | `OpenClaw Gateway (prod)` |

### Legacy 标签

| 类型 | macOS | Linux |
|------|-------|-------|
| clawdbot | - | `clawdbot-gateway` |
| moltbot | - | `moltbot-gateway` |

---

## 六、技术权衡

### 1. LaunchAgent vs LaunchDaemon

| 方案 | 优势 | 劣势 |
|------|------|------|
| LaunchAgent | 用户级、无需 root | 需要 GUI 会话 |
| LaunchDaemon | 系统级、无 GUI 依赖 | 需要 root、权限复杂 |

**选择**：LaunchAgent
**原因**：用户友好，无需 root 权限，适合桌面应用

### 2. User vs System Scope

| 方案 | 优势 | 劣势 |
|------|------|------|
| User Scope | 用户级、无需 root | 需要 linger 持久化 |
| System Scope | 系统级、自动持久化 | 需要 root、权限复杂 |

**选择**：User Scope + Linger
**原因**：用户友好，通过 linger 解决持久化问题

### 3. Current Node vs System Node

| 方案 | 优势 | 劣势 |
|------|------|------|
| Current Node | 尊重版本管理器 | 可能过旧 |
| System Node | 稳定、可预测 | 不尊重用户选择 |

**选择**：Current Node 优先，System Node 回退
**原因**：尊重用户的版本管理器选择，同时确保有可用版本

### 4. 自动 Linger vs 手动 Linger

| 方案 | 优势 | 劣势 |
|------|------|------|
| 自动 Linger | 无需用户干预 | 需要 sudo |
| 手动 Linger | 用户控制 | 容易遗漏 |

**选择**：自动 Linger（检测时提示）
**原因**：确保服务正常运行，提供明确的错误提示

---

## 七、最佳实践

### 推荐配置

```typescript
// macOS LaunchAgent
const launchAgentConfig = {
  label: "ai.openclaw.gateway",
  RunAtLoad: true,
  KeepAlive: true,
  ThrottleInterval: 1,  // 快速重启
  Umask: 0o077,         // 安全权限
};

// Linux systemd
const systemdConfig = {
  Restart: "always",
  RestartSec: 5,
  TimeoutStopSec: 30,
  TimeoutStartSec: 30,
  SuccessExitStatus: "0 143",
  KillMode: "control-group",
};

// Windows Scheduled Task
const taskConfig = {
  trigger: "ONLOGON",
  runLevel: "LIMITED",
  interactiveOnly: true,  // 仅交互式会话
};
```

### 安全考虑

1. **权限控制**：
   - LaunchAgent: umask 0o077（owner-only）
   - 目录权限: 0o755（可执行）
   - 文件权限: 0o644（可读）

2. **环境变量**：
   - 避免 PATH 注入
   - 过滤敏感变量
   - 使用绝对路径

3. **日志安全**：
   - 日志文件位置：`~/.openclaw/gateway/logs/`
   - 避免记录敏感信息
   - 定期轮转

### 故障排查

| 问题 | 可能原因 | 解决方案 |
|------|---------|---------|
| macOS: bootstrap failed | SSH 环境、错误用户 | 使用 GUI 会话 |
| Linux: D-Bus error | User scope 不可用 | 使用 machine scope |
| Linux: 服务停止 | Lingering 未启用 | 启用 linger |
| Windows: 任务未运行 | 权限不足、触发器错误 | 检查任务配置 |

---

*本文档基于源码分析，涵盖守护进程系统的架构、平台实现、配置生成、服务标签以及技术权衡。*
