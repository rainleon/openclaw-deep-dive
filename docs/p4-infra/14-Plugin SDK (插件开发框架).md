# Plugin SDK 插件开发框架

> "卧槽，这个插件系统设计得真优雅。开放能力的同时，安全边界控制得死死的。"

---

## 核心技术洞察

### 1. 三层安全防护机制

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Plugin 安全防护层级                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  第一层：路径安全防护                                              │  │
│  │  - Boundary File Read (边界文件读取)                              │  │
│  │  - 路径逃逸检测 (source escapes root)                             │  │
│  │  - 符号链接拒绝 (拒绝 hardlink)                                   │  │
│  │  - 世界可写目录阻止                                                │  │
│  │  - 所有权验证 (UID 校验)                                          │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                          ↓                                               │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  第二层：API 能力隔离                                              │  │
│  │  - Runtime API 只暴露必要能力                                    │  │
│  │  - subagent 只在 Gateway request 期间可用                        │  │
│  │  - modelAuth 剥离 agentDir/store/profileId                       │  │
│  │  - 工具沙箱隔离 (sandboxed context)                              │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                          ↓                                               │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  第三层：配置验证                                                  │  │
│  │  - Schema 验证 (不执行代码)                                       │  │
│  │  - JSON Schema 校验                                              │  │
│  │  - UI Hints 元数据                                                │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

**Leon点评**：这三层防护设计得非常严谨。第一层防止插件访问敏感文件，第二层限制插件的能力边界，第三层确保配置安全。特别是 modelAuth 的能力剥离——插件只能指定 provider/model，真正的凭证查找由核心管道处理，防止插件窃取其他提供商的凭证。这个设计太聪明了。

### 2. Plugin SDK 的模块化导出策略

```typescript
// 官方推荐的子路径导入方式
import { ... } from "openclaw/plugin-sdk/core";         // 通用 API
import { ... } from "openclaw/plugin-sdk/telegram";     // Telegram 特定
import { ... } from "openclaw/plugin-sdk/discord";      // Discord 特定
import { ... } from "openclaw/plugin-sdk/memory-core";  // 内存插件特定

// 废弃但不兼容性中断的方式
import { ... } from "openclaw/plugin-sdk";             // 单体导入（已废弃）
```

**Leon点评**：这个设计体现了演进式架构的智慧。旧的单体导入仍然工作（不破坏兼容性），但推荐使用模块化子路径。这样既保护了现有生态，又引导新代码走向更好的架构。30+ 个子路径覆盖了所有扩展类型，从通用 core 到特定渠道（telegram/discord/line）再到特定插件（memory-lancedb/voice-call）。

### 3. Hook 系统的优先级合并策略

```typescript
// beforePromptBuild hook 的合并逻辑
const mergeBeforePromptBuild = (
  acc: PluginHookBeforePromptBuildResult | undefined,
  next: PluginHookBeforePromptBuildResult,
): PluginHookBeforePromptBuildResult => ({
  systemPrompt: next.systemPrompt ?? acc?.systemPrompt,
  prependContext: concatOptionalTextSegments({ left: acc?.prependContext, right: next.prependContext }),
  prependSystemContext: concatOptionalTextSegments({ left: acc?.prependSystemContext, right: next.prependSystemContext }),
  appendSystemContext: concatOptionalTextSegments({ left: acc?.appendSystemContext, right: next.appendSystemContext }),
});
```

**Leon点评**：这个合并策略设计得很优雅。高优先级 hook 的覆盖操作（如 systemPrompt）会胜出，而追加操作（如 prependContext）则按优先级顺序累积。这样既保证了关键能力可以被覆盖，又允许多个插件协作增强提示词。

### 4. Plugin Registry 的双向索引设计

```typescript
export type PluginRegistry = {
  plugins: PluginRecord[];           // 插件元数据
  tools: PluginToolRegistration[];   // 工具注册
  hooks: PluginHookRegistration[];   // Hook 注册
  typedHooks: TypedPluginHookRegistration[];  // 类型化 Hook
  channels: PluginChannelRegistration[];      // 渠道注册
  providers: PluginProviderRegistration[];    // 提供商注册
  gatewayHandlers: GatewayRequestHandlers;    // Gateway 方法
  httpRoutes: PluginHttpRouteRegistration[];  // HTTP 路由
  cliRegistrars: PluginCliRegistration[];     // CLI 注册
  services: PluginServiceRegistration[];      // 服务注册
  commands: PluginCommandRegistration[];      // 命令注册
  diagnostics: PluginDiagnostic[];            // 诊断信息
};
```

**Leon点评**：这个注册表设计得非常全面。10 种注册类型覆盖了插件的所有扩展点，而且每个注册都保留了 `pluginId` 和 `source` 信息，方便调试和错误追踪。诊断数组特别实用——可以在加载阶段收集所有问题，而不是遇到第一个错误就失败。

---

## 一、Plugin SDK 架构总览

### 系统边界

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Plugin 系统边界                                   │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                      插件发现层                                    │  │
│  │  - package.json 扫描                                              │  │
│  │  - openclaw.plugin.json 读取                                      │  │
│  │  - 路径安全检查                                                    │  │
│  │  - 所有权验证                                                      │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                          ↓                                               │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                      插件加载层                                    │  │
│  │  - jiti 动态导入                                                  │  │
│  │  - Plugin Runtime 创建                                           │  │
│  │  - 注册表初始化                                                    │  │
│  │  - Hook 注册                                                       │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                          ↓                                               │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                      插件执行层                                    │  │
│  │  - Hook Runner (优先级排序)                                       │  │
│  │  - Command Registry (命令分发)                                    │  │
│  │  - Tool Factory (工具创建)                                        │  │
│  │  - Gateway RPC 路由                                                │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                          ↓                                               │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                      核心 API 层                                   │  │
│  │  - config (配置访问)                                              │  │
│  │  - subagent (子 Agent 调用)                                       │  │
│  │  - system (系统操作)                                              │  │
│  │  - media (媒体处理)                                               │  │
│  │  - tools (工具注册)                                               │  │
│  │  - channel (渠道操作)                                             │  │
│  │  - events (事件系统)                                              │  │
│  │  - logging (日志)                                                 │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 核心 API

| API 模块 | 能力 | 限制 |
|---------|------|------|
| `runtime.config` | 访问 OpenClaw 配置 | 只读 |
| `runtime.subagent` | 调用子 Agent | 仅 Gateway request 期间 |
| `runtime.system` | 运行命令、读取环境变量 | 沙箱限制 |
| `runtime.media` | 媒体处理、转写、TTS | 依赖配置 |
| `runtime.tools` | 工具创建和注册 | 类型安全 |
| `runtime.channel` | 渠道操作 | 仅注册渠道的插件 |
| `runtime.events` | 事件订阅/发布 | 全局命名空间 |
| `runtime.logging` | 结构化日志 | 子系统隔离 |

---

## 二、插件发现与加载机制

### 发现流程

```typescript
// src/plugins/discovery.ts
export type PluginCandidate = {
  idHint: string;
  source: string;
  rootDir: string;
  origin: PluginOrigin;           // "bundled" | "user" | "workspace"
  workspaceDir?: string;
  packageName?: string;
  packageVersion?: string;
  packageDescription?: string;
  packageDir?: string;
  packageManifest?: OpenClawPackageManifest;
};

// 发现来源
1. ~/.openclaw/extensions/     // 用户目录
2. <workspace>/extensions/     // 工作区目录
3. <bundled>/extensions/       // 打包插件
4. extraPaths                  // 配置指定路径
```

### 安全检查清单

```typescript
export type CandidateBlockReason =
  | "source_escapes_root"      // 源文件逃逸插件根目录
  | "path_stat_failed"         // 路径 stat 失败
  | "path_world_writable"      // 世界可写目录
  | "path_suspicious_ownership";// 可疑所有权
```

**安全检查实现**：
```typescript
function checkSourceEscapesRoot(params: {
  source: string;
  rootDir: string;
}): CandidateBlockIssue | null {
  const sourceRealPath = safeRealpathSync(params.source);
  const rootRealPath = safeRealpathSync(params.rootDir);
  if (isPathInside(rootRealPath, sourceRealPath)) {
    return null;
  }
  return {
    reason: "source_escapes_root",
    sourcePath: params.source,
    rootPath: params.rootDir,
    sourceRealPath,
    rootRealPath,
  };
}
```

**Leon点评**：这个安全检查做得很到位。realpath 解析所有符号链接后再检查包含关系，防止通过 `../symlink` 逃逸。所有权检查防止其他用户的插件被加载，避免权限升级攻击。

### 插件清单 (Manifest)

```typescript
// openclaw.plugin.json
export type PluginManifest = {
  id: string;                        // 必需
  configSchema: Record<string, unknown>;  // 必需
  kind?: PluginKind;                 // "memory" | "context-engine"
  channels?: string[];               // 声明的渠道 ID
  providers?: string[];              // 声明的提供商 ID
  skills?: string[];                 // Skills 目录
  name?: string;                     // 显示名称
  description?: string;              // 描述
  version?: string;                  // 版本
  uiHints?: Record<string, PluginConfigUiHint>;  // UI 提示
};
```

### 加载流程

```typescript
// src/plugins/loader.ts
export async function loadPlugins(
  options: PluginLoadOptions,
): Promise<PluginLoadResult> {
  // 1. 发现候选插件
  const discoveryResult = await discoverOpenClawPlugins(...);

  // 2. 加载插件清单
  for (const candidate of discoveryResult.candidates) {
    const manifestResult = loadPluginManifest(candidate.rootDir);
    if (!manifestResult.ok) {
      diagnostics.push({
        level: "error",
        pluginId: candidate.idHint,
        message: manifestResult.error,
      });
      continue;
    }
  }

  // 3. 动态导入插件模块
  const jiti = createJiti({ alias: resolvePluginSdkAliasMap() });
  const module = await jiti.import(candidate.source);

  // 4. 验证导出
  const plugin = validatePluginModule(module);

  // 5. 注册到 Registry
  registerPlugin(plugin, manifest, runtime);
}
```

---

## 三、Hook 系统架构

### Hook 类型与优先级

```typescript
export type PluginHookName =
  // Agent 生命周期
  | "beforeAgentStart"
  | "beforeModelResolve"
  | "beforePromptBuild"
  | "afterAgentStart"
  | "agentEnd"

  // 工具调用
  | "beforeToolCall"
  | "afterToolCall"
  | "toolResultPersist"

  // 消息处理
  | "messageReceived"
  | "messageSending"
  | "messageSent"
  | "beforeMessageWrite"

  // 会话管理
  | "sessionStart"
  | "sessionEnd"
  | "beforeReset"
  | "beforeCompaction"
  | "afterCompaction"

  // 子 Agent
  | "subagentSpawning"
  | "subagentSpawned"
  | "subagentDeliveryTarget"
  | "subagentEnded"

  // Gateway
  | "gatewayStart"
  | "gatewayStop"

  // LLM
  | "llmInput"
  | "llmOutput";
```

### Hook 注册

```typescript
// src/plugins/types.ts
export type OpenClawPluginHookOptions = {
  entry?: HookEntry;           // 目标 Agent (留空 = 全局)
  name?: string;               // Hook 名称
  description?: string;        // 描述
  register?: boolean;          // 是否自动注册
};

// 插件代码示例
export default {
  hooks: [
    {
      hook: "beforePromptBuild",
      priority: 100,
      handler: async (ctx) => {
        return {
          prependSystemContext: "You are a helpful assistant.",
        };
      },
    },
  ],
};
```

### Hook 执行顺序

```typescript
// 按优先级降序执行（高优先级先执行）
function getHooksForName<K extends PluginHookName>(
  registry: PluginRegistry,
  hookName: K,
): PluginHookRegistration<K>[] {
  return registry.typedHooks
    .filter((h) => h.hookName === hookName)
    .toSorted((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
}
```

**Leon点评**：优先级降序排序（高优先级先执行）是正确的选择。对于 before* 类型的 hook，高优先级插件应该有更强的话语权；对于合并策略（如 beforePromptBuild），高优先级的覆盖操作会胜出。

### Hook 结果合并

```typescript
// beforePromptBuild 的合并示例
const mergeBeforePromptBuild = (
  acc: PluginHookBeforePromptBuildResult | undefined,
  next: PluginHookBeforePromptBuildResult,
): PluginHookBeforePromptBuildResult => ({
  // 覆盖操作：高优先级胜出
  systemPrompt: next.systemPrompt ?? acc?.systemPrompt,

  // 追加操作：按优先级顺序累积
  prependContext: concatOptionalTextSegments({
    left: acc?.prependContext,
    right: next.prependContext,
  }),
  prependSystemContext: concatOptionalTextSegments({
    left: acc?.prependSystemContext,
    right: next.prependSystemContext,
  }),
  appendSystemContext: concatOptionalTextSegments({
    left: acc?.appendSystemContext,
    right: next.appendSystemContext,
  }),
});
```

---

## 四、Plugin Command 系统

### 命令注册与验证

```typescript
// src/plugins/commands.ts
export const RESERVED_COMMANDS = new Set([
  "help", "commands", "status", "whoami", "context",
  "stop", "restart", "reset", "new", "compact",
  "config", "debug", "allowlist", "activation",
  "skill", "subagents", "kill", "steer", "tell", "model", "models", "queue",
  "send", "bash", "exec",
  "think", "verbose", "reasoning", "elevated",
  "usage",
]);

export function validateCommandName(name: string): string | null {
  const trimmed = name.trim().toLowerCase();

  if (!trimmed) {
    return "Command name cannot be empty";
  }

  // 必须以字母开头，只包含字母、数字、连字符、下划线
  if (!/^[a-z][a-z0-9_-]*$/.test(trimmed)) {
    return "Command name must start with a letter and contain only letters, numbers, hyphens, and underscores";
  }

  // 检查保留命令
  if (RESERVED_COMMANDS.has(trimmed)) {
    return `Command name "${trimmed}" is reserved by a built-in command`;
  }

  return null;
}
```

### 命令执行上下文

```typescript
export type PluginCommandContext = {
  senderId?: string;                  // 发送者 ID
  channel: string;                    // 渠道
  channelId?: ChannelId;              // 渠道 ID
  isAuthorizedSender: boolean;        // 是否授权
  args?: string;                      // 命令参数
  commandBody: string;                // 完整命令体
  config: OpenClawConfig;             // 配置
  from?: string;                      // 原始 From 值
  to?: string;                        // 原始 To 值
  accountId?: string;                 // 账户 ID
  messageThreadId?: number;           // 线程 ID
};
```

### 命令处理器

```typescript
export type PluginCommandHandler = (
  ctx: PluginCommandContext,
) => PluginCommandResult | Promise<PluginCommandResult>;

// 插件代码示例
export default {
  commands: [
    {
      name: "tts",
      description: "Text-to-speech synthesis",
      acceptsArgs: true,
      requireAuth: true,
      nativeNames: {
        default: "talkvoice",
        discord: "voice2",
      },
      handler: async (ctx) => {
        const { args, config } = ctx;
        // 执行 TTS 逻辑
        return {
          text: "Audio generated",
          format: "audio",
        };
      },
    },
  ],
};
```

**Leon点评**：nativeNames 的设计很巧妙。不同原生平台（如 Discord、Telegram）可能对命令名称有不同限制或偏好，通过 nativeNames 可以为每个平台定制别名，同时 default 作为后备。这种平台适配意识在跨平台框架中非常重要。

---

## 五、Plugin Runtime API

### Runtime 结构

```typescript
// src/plugins/runtime/types.ts
export type PluginRuntime = {
  version: string;

  // 配置访问
  config: {
    get(): OpenClawConfig;
  };

  // 子 Agent（仅 Gateway request 期间）
  subagent: {
    run(params: SubagentRunParams): Promise<SubagentRunResult>;
    waitForRun(params: SubagentWaitParams): Promise<SubagentWaitResult>;
    getSessionMessages(params: SubagentGetSessionMessagesParams): Promise<SubagentGetSessionMessagesResult>;
    deleteSession(params: SubagentDeleteSessionParams): Promise<void>;
  };

  // 系统操作
  system: {
    runCommand(params: { command: string; args?: string[] }): Promise<{ stdout: string; stderr: string }>;
    getEnv(key: string): string | undefined;
  };

  // 媒体处理
  media: {
    fetchRemoteMedia(params: { url: string }): Promise<{ filePath: string; mime: string }>;
  };

  // TTS/STT
  tts: {
    textToSpeechTelephony(params: { text: string; cfg: OpenClawConfig }): Promise<{ buffer: Buffer; sampleRate: number }>;
  };

  stt: {
    transcribeAudioFile(params: { filePath: string; cfg: OpenClawConfig; mime?: string }): Promise<{ text?: string }>;
  };

  // 工具注册
  tools: {
    register(factory: AnyAgentTool | AnyAgentTool[]): void;
  };

  // 渠道操作
  channel: {
    listConnectedAccounts(): ConnectedAccountInfo[];
  };

  // 事件系统
  events: {
    on(event: string, handler: (...args: unknown[]) => void): void;
    emit(event: string, ...args: unknown[]): void;
  };

  // 日志
  logging: {
    createLogger(subsystem: string): RuntimeLogger;
  };

  // 状态目录
  state: {
    resolveStateDir(): string;
  };

  // 模型认证（安全剥离）
  modelAuth: {
    getApiKeyForModel(params: { model: string; cfg: OpenClawConfig }): string | undefined;
    resolveApiKeyForProvider(params: { provider: string; cfg: OpenClawConfig }): string | undefined;
  };
};
```

### 安全限制：subagent 不可用

```typescript
function createUnavailableSubagentRuntime(): PluginRuntime["subagent"] {
  const unavailable = () => {
    throw new Error("Plugin runtime subagent methods are only available during a gateway request.");
  };
  return {
    run: unavailable,
    waitForRun: unavailable,
    getSessionMessages: unavailable,
    getSession: unavailable,
    deleteSession: unavailable,
  };
}
```

**Leon点评**：这个设计非常聪明。subagent 只在 Gateway request 期间可用，防止插件在后台或初始化阶段滥用子 Agent 调用。通过运行时错误而不是编译时检查，既保证了安全，又保持了类型系统的简洁。

### 模型认证的安全剥离

```typescript
modelAuth: {
  // 剥离 agentDir/store，防止读取其他 Agent 的凭证
  // 剥离 profileId/preferredProfile，防止跨提供商凭证访问
  getApiKeyForModel: (params) =>
    getApiKeyForModelRaw({
      model: params.model,
      cfg: params.cfg,
      // agentDir, store, profileId, preferredProfile 全部移除
    }),
  resolveApiKeyForProvider: (params) =>
    resolveApiKeyForProviderRaw({
      provider: params.provider,
      cfg: params.cfg,
      // agentDir, store, profileId 全部移除
    }),
},
```

**Leon点评**：这个安全剥离设计太优雅了。插件只能指定"我要用 OpenAI 的 gpt-4"，至于用哪个凭证、从哪里读取，完全由核心管道决定。这样既满足了插件的功能需求，又防止了凭证窃取攻击。

---

## 六、Gateway HTTP 路由注册

### 路由注册 API

```typescript
api.registerHttpRoute({
  path: "/acme/webhook",
  auth: "plugin",              // "gateway" | "plugin"
  match: "exact",              // "exact" | "prefix"
  replaceExisting: false,      // 允许替换自己的路由
  handler: async (req, res) => {
    res.statusCode = 200;
    res.end("ok");
    return true;  // 返回 true 表示已处理
  },
});
```

### 路由冲突检测

```typescript
// src/plugins/http-route-overlap.ts
export function findOverlappingPluginHttpRoute(params: {
  routes: PluginHttpRouteRegistration[];
  path: string;
  match: OpenClawPluginHttpRouteMatch;
  auth: OpenClawPluginHttpRouteAuth;
}): PluginHttpRouteRegistration | null {
  for (const route of routes) {
    if (route.path === params.path && route.match === params.match) {
      if (route.auth !== params.auth) {
        // 相同路径但不同认证级别 → 拒绝
        return route;
      }
    }
  }
  return null;
}
```

**Leon点评**：路由冲突检测做得很严谨。相同路径 + 相同匹配模式，但认证级别不同，这显然是个安全漏洞——低认证的路由可能被用来绕过高认证的要求。直接拒绝这种冲突是正确的选择。

---

## 七、配置验证与 UI Hints

### 配置 Schema

```typescript
export type OpenClawPluginConfigSchema = {
  safeParse?: (value: unknown) => {
    success: boolean;
    data?: unknown;
    error?: {
      issues?: Array<{ path: Array<string | number>; message: string }>;
    };
  };
  parse?: (value: unknown) => unknown;
  validate?: (value: unknown) => PluginConfigValidation;
  uiHints?: Record<string, PluginConfigUiHint>;
  jsonSchema?: Record<string, unknown>;
};

export type PluginConfigUiHint = {
  label?: string;
  help?: string;
  tags?: string[];
  advanced?: boolean;
  sensitive?: boolean;
  placeholder?: string;
};
```

### 验证流程

```typescript
// 配置验证不执行插件代码
export async function validatePluginConfig(params: {
  pluginId: string;
  config: unknown;
}): Promise<PluginConfigValidation> {
  // 1. 读取 openclaw.plugin.json
  const manifestResult = loadPluginManifest(pluginRoot);
  if (!manifestResult.ok) {
    return { ok: false, errors: [manifestResult.error] };
  }

  // 2. 使用 manifest.configSchema 验证
  const { configSchema } = manifestResult.manifest;

  if (configSchema.safeParse) {
    const result = configSchema.safeParse(config);
    if (!result.success) {
      return {
        ok: false,
        errors: result.error?.issues?.map(i => `${i.path.join('.')}: ${i.message}`) ?? [],
      };
    }
  }

  // 3. 自定义验证
  if (configSchema.validate) {
    return configSchema.validate(config);
  }

  return { ok: true };
}
```

**Leon点评**：配置验证不执行插件代码是个关键的安全决策。这样可以在加载插件之前就拒绝恶意配置，避免代码执行阶段的攻击。同时通过 JSON Schema 和自定义验证函数，兼顾了易用性和灵活性。

---

## 八、关键技术权衡

### 1. 子路径导入 vs 单体导入

| 方案 | 优势 | 劣势 |
|------|------|------|
| 子路径导入 | 按需加载、类型安全、bundle 优化 | 导入路径较长 |
| 单体导入 | 简洁、向后兼容 | 包体积大、依赖不明确 |

**选择**：推荐子路径，保留单体兼容性
**原因**：渐进式升级，不破坏现有生态

### 2. 配置验证 vs 代码验证

| 方案 | 优势 | 劣势 |
|------|------|------|
| 配置验证 | 安全、不执行代码 | 验证逻辑静态 |
| 代码验证 | 灵活、动态 | 存在代码执行风险 |

**选择**：配置验证优先
**原因**：安全第一，避免恶意插件在加载阶段攻击

### 3. Hook 优先级 vs Hook 顺序

| 方案 | 优势 | 劣势 |
|------|------|------|
| 优先级 | 灵活、可控 | 需要协调 |
| 顺序 | 可预测、简单 | 不够灵活 |

**选择**：优先级
**原因**：插件生态需要更强的控制能力

---

## 附录A：Plugin、Hooks、Gateway 三者关系

**Q：Plugin、Hooks、Channels 三者有什么区别？**

A：
- **Plugin**：代码组织单元，一个 npm 包或本地目录
- **Hook**：生命周期扩展点，插件可以注册多个 hook
- **Channel**：消息平台适配器，通常由插件提供

关系：
```
Plugin (openclaw-matrix)
  ├─ Channel (matrix)          // 消息渠道
  ├─ Hook (beforePromptBuild)  // 生命周期 hook
  ├─ Command (/matrix-status)   // 自定义命令
  └─ Tool (matrix-send)        // Agent 工具
```

**Q：插件命令 (`/command`) 和 Agent 工具有什么区别？**

A：
| 维度 | 插件命令 | Agent 工具 |
|------|----------|------------|
| 触发方式 | 用户直接输入 `/command` | Agent 决策调用 |
| 执行路径 | 绕过 LLM，直接执行 | 经过 LLM 推理 |
| 适合场景 | 简单操作、状态查询 | 复杂任务、需要理解 |
| 权限控制 | `requireAuth` | Agent 策略管道 |

**Q：Plugin SDK 的 core、compat、渠道特定子路径如何选择？**

A：
- **core**：通用 API，适用于所有插件（Provider、Tool、Service）
- **compat**：需要更广泛共享运行时助手的打包/内部插件代码
- **渠道特定**（telegram/discord/line）：对应渠道的专用插件

选择原则：优先最窄的子路径。Matrix 插件用 `plugin-sdk/matrix`，通用 Provider 插件用 `plugin-sdk/core`，只有需要跨渠道共享逻辑时才用 `plugin-sdk/compat`。

---

*本文档基于源码分析，涵盖 Plugin SDK、Hook 系统、命令注册、配置验证等核心组件。*
