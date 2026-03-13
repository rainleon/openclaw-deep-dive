# Hooks 集成机制

> "OpenClaw的Hooks系统设计得很精妙。两层架构——Internal Hooks处理事件分发，Plugin Hooks提供扩展能力，职责分离得很清晰。卧槽，这个设计比我见过的多数框架都优雅。"

---

## 核心技术洞察

### 1. GlobalThis 单例模式解决 Bundle Splitting

```typescript
// src/hooks/internal-hooks.ts
const _g = globalThis as typeof globalThis & {
  __openclaw_internal_hook_handlers__?: Map<string, InternalHookHandler[]>;
};
const handlers = (_g.__openclaw_internal_hook_handlers__ ??= new Map<string, InternalHookHandler[]>());
```

**Leon点评**：这个设计太聪明了。Bundle splitting 是现代前端构建的常见优化，但它会破坏单例模式——不同 chunk 的模块副本有独立的状态。通过 globalThis 存储注册表，所有 chunk 共享同一个 Map，无论打包器如何分割代码，hook 注册表始终一致。这种解决跨 chunk 通信问题的思路，值得所有使用 code splitting 的项目借鉴。

### 2. 两层 Hook 架构

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Hooks 系统架构                                   │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                    Internal Hooks (事件层)                         │  │
│  │  - command:new, command:reset, command:stop                       │  │
│  │  - session:start, session:end                                    │  │
│  │  - agent:bootstrap                                                │  │
│  │  - gateway:startup                                                │  │
│  │  - message:received, message:sent, message:transcribed            │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                          ↓ 触发                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                    Plugin Hooks (扩展层)                          │  │
│  │  - beforeAgentStart, afterAgentStart                             │  │
│  │  - beforeModelResolve, beforePromptBuild                          │  │
│  │  - beforeToolCall, afterToolCall                                 │  │
│  │  - messageReceived, messageSending, messageSent                  │  │
│  │  - sessionStart, sessionEnd, beforeReset                          │  │
│  │  - subagentSpawning, subagentSpawned, subagentDeliveryTarget       │  │
│  │  - llmInput, llmOutput                                            │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                          ↓ 合并                                        │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                      Hook Runner                                  │  │
│  │  - 优先级排序                                                     │  │
│  │  - 结果合并 (override/append/concat)                             │  │
│  │  - 错误捕获                                                       │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

**Leon点评**：两层架构的设计很清晰。Internal Hooks 是 OpenClaw 内部使用的事件系统，处理命令、会话、网关等生命周期事件；Plugin Hooks 是面向插件开发者的扩展 API，允许在 Agent 执行的各个阶段注入逻辑。两者职责不同，但通过 Hook Runner 统一执行，保持了架构的一致性。

### 3. 事件匹配的双重分发机制

```typescript
export async function triggerInternalHook(event: InternalHookEvent): Promise<void> {
  // 1. 匹配类型级别的 handlers (如 'command')
  const typeHandlers = handlers.get(event.type) ?? [];

  // 2. 匹配具体的 event:action handlers (如 'command:new')
  const specificHandlers = handlers.get(`${event.type}:${event.action}`) ?? [];

  // 3. 按注册顺序执行（type 先，specific 后）
  const allHandlers = [...typeHandlers, ...specificHandlers];

  for (const handler of allHandlers) {
    try {
      await handler(event);
    } catch (err) {
      log.error(`Hook error [${event.type}:${event.action}]: ${String(err)}`);
    }
  }
}
```

**Leon点评**：这个双重分发机制很灵活。监听 `'command'` 可以捕获所有命令事件，监听 `'command:new'` 只捕获 `/new` 命令。而且执行顺序是先 general 后 specific，这意味着 general handler 可以做一些前置处理（如日志、追踪），specific handler 做业务逻辑。这种设计模式在事件系统里很常见，但实现得这么干净的不多。

### 4. Hook 的目录发现与边界安全

```typescript
// src/hooks/workspace.ts
function loadHookFromDir(params: {
  hookDir: string;
  source: HookSource;
  pluginId?: string;
  nameHint?: string;
}): Hook | null {
  const hookMdPath = path.join(params.hookDir, "HOOK.md");

  // 边界文件读取
  const content = readBoundaryFileUtf8({
    absolutePath: hookMdPath,
    rootPath: params.hookDir,
    boundaryLabel: "hook directory",
  });

  // 解析 Frontmatter
  const frontmatter = parseFrontmatter(content);

  // 查找 handler 文件（按优先级）
  const handlerCandidates = ["handler.ts", "handler.js", "index.ts", "index.js"];
  for (const candidate of handlerCandidates) {
    const safeCandidatePath = resolveBoundaryFilePath({
      absolutePath: path.join(params.hookDir, candidate),
      rootPath: params.hookDir,
      boundaryLabel: "hook directory",
    });
    if (safeCandidatePath) {
      handlerPath = safeCandidatePath;
      break;
    }
  }
}
```

**Leon点评**：Hook 的发现机制设计得很周到：
1. **目录结构**：每个 Hook 是一个子目录，包含 `HOOK.md` 和 `handler.ts`
2. **边界安全**：使用 Boundary File Read 防止路径逃逸
3. **Handler 候选**：4 种候选文件名，兼容不同开发习惯
4. **Frontmatter 元数据**：在 `HOOK.md` 中声明事件类型和运行时条件

这种设计既保证了安全性（边界检查），又提供了足够的灵活性（多种 handler 文件名）。

---

## 一、Hooks 系统架构总览

### 系统边界

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Hooks 系统边界                                   │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                      Hook 发现层                                    │  │
│  │  - 目录扫描 (bundled/managed/workspace)                           │  │
│  │  - HOOK.md 解析                                                   │  │
│  │  - handler.ts 定位                                                │  │
│  │  - 边界安全检查                                                    │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                          ↓                                               │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                      Hook 加载层                                    │  │
│  │  - 运行时条件评估 (OS/bins/config/env)                           │  │
│  │  - 动态导入 (带缓存失效)                                          │  │
│  │  - 事件注册到 GlobalThis Map                                      │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                          ↓                                               │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                      Hook 触发层                                    │  │
│  │  - 双重匹配 (type + type:action)                                 │  │
│  │  - 顺序执行 (general → specific)                                 │  │
│  │  - 错误隔离                                                       │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                          ↓                                               │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                      Hook 合并层 (Plugin Hooks)                    │  │
│  │  - 优先级排序                                                     │  │
│  │  - 结果合并策略                                                   │  │
│  │  - 返回值聚合                                                     │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 核心 Hook 类型

| 类别 | Internal Hooks | Plugin Hooks |
|------|----------------|--------------|
| **命令** | command:new, reset, stop | - |
| **会话** | session:start, end | sessionStart, sessionEnd, beforeReset |
| **Agent** | agent:bootstrap | beforeAgentStart, afterAgentStart, agentEnd |
| **模型** | - | beforeModelResolve, beforePromptBuild |
| **工具** | - | beforeToolCall, afterToolCall |
| **消息** | message:received, sent, transcribed, preprocessed | messageReceived, messageSending, messageSent |
| **子 Agent** | - | subagentSpawning, subagentSpawned, subagentDeliveryTarget |
| **LLM** | - | llmInput, llmOutput |
| **会话管理** | - | beforeCompaction, afterCompaction, beforeMessageWrite |
| **Gateway** | gateway:startup | gatewayStart, gatewayStop |

---

## 二、Internal Hooks 事件系统

### 事件类型定义

```typescript
// src/hooks/internal-hooks.ts
export type InternalHookEventType = "command" | "session" | "agent" | "gateway" | "message";

export interface InternalHookEvent {
  type: InternalHookEventType;
  action: string;
  sessionKey: string;
  context: Record<string, unknown>;
  timestamp: Date;
  messages: string[];  // Hooks 可以推送消息到这个数组
}
```

### 事件示例

**命令事件**：
```typescript
type CommandNewHookEvent = InternalHookEvent & {
  type: "command";
  action: "new";
  context: {
    workspaceDir: string;
    bootstrapFiles: WorkspaceBootstrapFile[];
    cfg?: OpenClawConfig;
    sessionKey?: string;
    sessionId?: string;
    agentId?: string;
  };
};
```

**消息事件**：
```typescript
type MessageReceivedHookEvent = InternalHookEvent & {
  type: "message";
  action: "received";
  context: {
    from: string;
    content: string;
    timestamp?: number;
    channelId: string;
    accountId?: string;
    conversationId?: string;
    messageId?: string;
    metadata?: Record<string, unknown>;
  };
};
```

### Hook Handler 类型

```typescript
export type InternalHookHandler = (event: InternalHookEvent) => Promise<void> | void;

// 示例：监听所有命令事件
registerInternalHook('command', async (event) => {
  console.log('Command:', event.action);
});

// 示例：只监听 /new 命令
registerInternalHook('command:new', async (event) => {
  await saveSessionToMemory(event);
});
```

---

## 三、Hook 发现与加载

### 目录结构

```
~/.openclaw/hooks/
├── my-hook/
│   ├── HOOK.md              # Hook 元数据
│   └── handler.ts           # Hook 处理逻辑
├── another-hook/
│   ├── HOOK.md
│   └── index.ts             # 也支持 index.js/ts
```

### HOOK.md Frontmatter

```yaml
---
name: my-hook
description: My custom hook
openclaw:
  emoji: 🪝
  events:
    - command:new
    - session:start
  os:
    - darwin
    - linux
  requires:
    bins:
      - ffmpeg
    config:
      - browser.enabled
  always: true
  export: default
  enabled: true
---

# My Hook Documentation

This hook does X, Y, Z...
```

### 元数据解析

```typescript
// src/hooks/frontmatter.ts
export type OpenClawHookMetadata = {
  always?: boolean;              // 无条件执行
  hookKey?: string;              // 配置中的键名
  emoji?: string;                # 图标
  homepage?: string;             # 主页
  events: string[];              # 监听的事件
  export?: string;               # 导出名称 (默认 "default")
  os?: string[];                 # 操作系统限制
  requires?: {
    bins?: string[];             # 需要的二进制文件
    anyBins?: string[];          # 任一即可
    env?: string[];              # 需要的环境变量
    config?: string[];           # 需要的配置路径
  };
  install?: HookInstallSpec[];   # 安装规范
};
```

### Hook 加载流程

```typescript
// src/hooks/loader.ts
export async function loadInternalHooks(
  cfg: OpenClawConfig,
  workspaceDir: string,
): Promise<number> {
  // 1. 扫描 Hook 目录
  const hookEntries = loadWorkspaceHookEntries(workspaceDir, {
    config: cfg,
    managedHooksDir: opts?.managedHooksDir,
    bundledHooksDir: opts?.bundledHooksDir,
  });

  // 2. 过滤符合运行时条件的 Hooks
  const eligible = hookEntries.filter((entry) =>
    shouldIncludeHook({ entry, config: cfg })
  );

  // 3. 加载并注册每个 Hook
  for (const entry of eligible) {
    const hookConfig = resolveHookConfig(cfg, entry.hook.name);

    // 检查是否显式禁用
    if (hookConfig?.enabled === false) {
      continue;
    }

    // 边界安全检查
    const opened = await openBoundaryFile({
      absolutePath: entry.hook.handlerPath,
      rootPath: entry.hook.baseDir,
      boundaryLabel: "hook directory",
    });
    if (!opened.ok) {
      log.error(`Hook '${entry.hook.name}' fails boundary checks`);
      continue;
    }

    // 动态导入（workspace/managed hooks 使用缓存失效）
    const importUrl = buildImportUrl(safeHandlerPath, entry.hook.source);
    const mod = await import(importUrl);

    // 获取 handler 函数
    const exportName = entry.metadata?.export ?? "default";
    const handler = resolveFunctionModuleExport<InternalHookHandler>({
      mod,
      exportName,
    });

    // 注册到所有声明的事件
    const events = entry.metadata?.events ?? [];
    for (const event of events) {
      registerInternalHook(event, handler);
    }

    loadedCount++;
  }

  return loadedCount;
}
```

---

## 四、运行时条件评估

### 评估条件

```typescript
// src/hooks/config.ts
function evaluateHookRuntimeEligibility(params: {
  entry: HookEntry;
  config?: OpenClawConfig;
  hookConfig?: HookConfig;
  eligibility?: HookEligibilityContext;
}): boolean {
  const { entry, config, hookConfig, eligibility } = params;
  const remote = eligibility?.remote;

  return evaluateRuntimeEligibility({
    // OS 限制
    os: entry.metadata?.os,
    remotePlatforms: remote?.platforms,

    // 无条件执行
    always: entry.metadata?.always,

    // 依赖检查
    requires: entry.metadata?.requires,
    hasBin: hasBinary,
    hasAnyBin: remote?.hasAnyBin,
    hasRemoteBin: remote?.hasBin,

    // 环境变量
    hasEnv: (envName) =>
      Boolean(process.env[envName] || hookConfig?.env?.[envName]),

    // 配置路径
    isConfigPathTruthy: (configPath) =>
      isConfigPathTruthy(config, configPath),
  });
}
```

### Hook 配置

```yaml
# config.yaml
hooks:
  internal:
    enabled: true
    entries:
      my-hook:
        enabled: true
        env:
          MY_HOOK_API_KEY: "xxx"
```

---

## 五、Plugin Hooks 系统

### Hook 注册 API

```typescript
// src/plugins/hooks.ts
export type PluginHookOptions = {
  entry?: HookEntry;           # 目标 Agent (留空 = 全局)
  name?: string;               # Hook 名称
  description?: string;        # 描述
  priority?: number;           # 优先级 (高优先级先执行)
  register?: boolean;          # 是否自动注册
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
    {
      hook: "beforeToolCall",
      priority: 50,
      handler: async (ctx) => {
        console.log("Tool call:", ctx.toolName);
      },
    },
  ],
};
```

### Hook 上下文类型

```typescript
// beforePromptBuild
type PluginHookBeforePromptBuildContext = {
  agentId: string;
  sessionKey: string;
  messageChannel: string;
  config: OpenClawConfig;
};

// beforeToolCall
type PluginHookBeforeToolCallContext = {
  agentId: string;
  sessionKey: string;
  toolName: string;
  toolInput: unknown;
  config: OpenClawConfig;
};

// messageReceived
type PluginHookMessageReceivedContext = {
  channelId: string;
  messageChannel: string;
  message: {
    from: string;
    content: string;
    timestamp: number;
  };
};
```

### Hook 结果合并

```typescript
// beforePromptBuild 的合并
const mergeBeforePromptBuild = (
  acc: PluginHookBeforePromptBuildResult | undefined,
  next: PluginHookBeforePromptBuildResult,
): PluginHookBeforePromptBuildResult => ({
  // 覆盖：高优先级胜出
  systemPrompt: next.systemPrompt ?? acc?.systemPrompt,

  // 追加：按优先级累积
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

## 六、关键技术权衡

### 1. GlobalThis vs Module Singleton

| 方案 | 优势 | 劣势 |
|------|------|------|
| GlobalThis | 跨 bundle 共享 | 全局污染 |
| Module Singleton | 封装好 | Bundle splitting 失效 |

**选择**：GlobalThis
**原因**：Bundle splitting 是现代构建的必需，跨 chunk 通信只能通过全局状态

### 2. Frontmatter vs 单独配置文件

| 方案 | 优势 | 劣势 |
|------|------|------|
| Frontmatter | 文档和配置在一起 | 文件格式限制 |
| 单独配置 | 结构化、灵活 | 文件数量增加 |

**选择**：Frontmatter
**原因**：Hook.md 本身就是文档，配置和文档在一起更易维护

### 3. 双重匹配 vs 单一匹配

| 方案 | 优势 | 劣势 |
|------|------|------|
| 双重匹配 (type + type:action) | 灵活、支持通用处理 | 执行顺序需要注意 |
| 单一匹配 | 简单、直观 | 灵活性差 |

**选择**：双重匹配
**原因**：通用处理场景（如日志）和特定处理场景都需要

---

## 附录A：Hooks 与其他模块的关系

**Q：Internal Hooks 和 Plugin Hooks 有什么区别？**

A：
- **Internal Hooks**：OpenClaw 内部事件系统，处理命令、会话、网关等生命周期事件
- **Plugin Hooks**：插件扩展 API，允许在 Agent 执行的各个阶段注入逻辑

关系：Internal Hooks 可以触发 Plugin Hooks。例如 `command:new` 事件会触发 `beforeAgentStart` hook。

**Q：Hook 的事件优先级是如何工作的？**

A：Plugin Hooks 支持 `priority` 字段，数值越大优先级越高。高优先级的 hook 先执行，对于覆盖操作（如 `systemPrompt`）高优先级胜出，对于追加操作（如 `prependContext`）按优先级顺序累积。Internal Hooks 不支持优先级，按注册顺序执行。

**Q：Hook 的 `messages` 数组是如何工作的？**

A：Internal Hook Event 包含一个 `messages: string[]` 数组，Hook 可以向这个数组推送消息，这些消息会被发送回用户。例如，`command:new` hook 可以在会话创建时发送欢迎消息。

---

*本文档基于源码分析，涵盖 Internal Hooks、Plugin Hooks、事件分发、运行时条件评估等核心组件。*
