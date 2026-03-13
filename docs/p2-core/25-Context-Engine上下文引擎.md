# Context-Engine 上下文引擎

> "OpenClaw的上下文引擎设计得太精妙了。这个可插拔的架构让不同的上下文管理策略可以无缝替换，而LegacyContextEngine则完美保留了向后兼容性。全局Symbol注册表的设计简直是天才——它解决了bundle分块导致的注册隔离问题，让插件和主进程共享同一个注册表。卧槽，这个接口设计考虑得太周全了，ingest/assemble/compact/afterTurn四个核心方法覆盖了上下文管理的完整生命周期，还有subagent支持和运行时上下文传递，这才是真正的可扩展架构。"

---

## 核心技术洞察

### 1. 可插拔上下文管理架构

```typescript
// src/context-engine/types.ts
export interface ContextEngine {
  /** 引擎标识和元数据 */
  readonly info: ContextEngineInfo;

  /**
   * 初始化引擎状态，可选择导入历史上下文
   */
  bootstrap?(params: {
    sessionId: string;
    sessionFile: string;
  }): Promise<BootstrapResult>;

  /**
   * 摄取单条消息到引擎存储
   */
  ingest(params: {
    sessionId: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult>;

  /**
   * 摄取完整的turn批次
   */
  ingestBatch?(params: {
    sessionId: string;
    messages: AgentMessage[];
    isHeartbeat?: boolean;
  }): Promise<IngestBatchResult>;

  /**
   * 执行post-turn生命周期工作
   */
  afterTurn?(params: {
    sessionId: string;
    sessionFile: string;
    messages: AgentMessage[];
    prePromptMessageCount: number;
    autoCompactionSummary?: string;
    isHeartbeat?: boolean;
    tokenBudget?: number;
    runtimeContext?: ContextEngineRuntimeContext;
  }): Promise<void>;

  /**
   * 在token预算下组装模型上下文
   */
  assemble(params: {
    sessionId: string;
    messages: AgentMessage[];
    tokenBudget?: number;
  }): Promise<AssembleResult>;

  /**
   * 压缩上下文以减少token使用
   */
  compact(params: {
    sessionId: string;
    sessionFile: string;
    tokenBudget?: number;
    force?: boolean;
    currentTokenCount?: number;
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string;
    runtimeContext?: ContextEngineRuntimeContext;
  }): Promise<CompactResult>;

  /**
   * 准备子agent的状态
   */
  prepareSubagentSpawn?(params: {
    parentSessionKey: string;
    childSessionKey: string;
    ttlMs?: number;
  }): Promise<SubagentSpawnPreparation | undefined>;

  /**
   * 通知子agent生命周期结束
   */
  onSubagentEnded?(params: {
    childSessionKey: string;
    reason: SubagentEndReason;
  }): Promise<void>;

  /**
   * 释放资源
   */
  dispose?(): Promise<void>;
}
```

**Leon点评**：这个接口设计考虑得极其周全：
1. **完整生命周期**：bootstrap → ingest → assemble → compact → afterTurn，覆盖从初始化到清理的全过程
2. **灵活的可选方法**：核心方法（ingest/assemble/compact）是必需的，扩展功能（bootstrap/afterTurn/subagent）是可选的
3. **运行时上下文**：runtimeContext参数让引擎可以访问调用者的状态，实现更精细的控制
4. **子agent支持**：prepareSubagentSpawn/onSubagentEndded让引擎可以管理子agent的状态
5. **批量优化**：ingestBatch允许引擎优化批量消息的摄取

这种设计让不同的上下文管理策略（简单的pass-through到复杂的RAG系统）都可以实现同一个接口。

### 2. 全局Symbol注册表解决Bundle隔离

```typescript
// src/context-engine/registry.ts
const CONTEXT_ENGINE_REGISTRY_STATE = Symbol.for("openclaw.contextEngineRegistryState");

type ContextEngineRegistryState = {
  engines: Map<string, ContextEngineFactory>;
};

function getContextEngineRegistryState(): ContextEngineRegistryState {
  const globalState = globalThis as typeof globalThis & {
    [CONTEXT_ENGINE_REGISTRY_STATE]?: ContextEngineRegistryState;
  };
  if (!globalState[CONTEXT_ENGINE_REGISTRY_STATE]) {
    globalState[CONTEXT_ENGINE_REGISTRY_STATE] = {
      engines: new Map<string, ContextEngineFactory>(),
    };
  }
  return globalState;
}

export function registerContextEngine(
  id: string,
  factory: ContextEngineFactory
): void {
  getContextEngineRegistryState().engines.set(id, factory);
}

export function getContextEngineFactory(
  id: string
): ContextEngineFactory | undefined {
  return getContextEngineRegistryState().engines.get(id);
}
```

**Leon点评**：这个设计巧妙地解决了bundle分块的问题：
1. **Symbol.for全局性**：使用Symbol.for而不是Symbol创建全局唯一的key，确保所有chunk共享同一个注册表
2. **延迟初始化**：注册表在首次访问时创建，避免启动时的开销
3. **工厂模式**：存储工厂函数而不是实例，允许延迟初始化和每次创建新实例
4. **类型安全**：TypeScript泛型确保类型安全

这个设计解决了#40096问题：当bundle被分成多个chunk时，插件注册的引擎仍然可以被主进程解析。

### 3. LegacyContextEngine的向后兼容设计

```typescript
// src/context-engine/legacy.ts
export class LegacyContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: "legacy",
    name: "Legacy Context Engine",
    version: "1.0.0",
  };

  async ingest(_params: {
    sessionId: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
    // No-op: SessionManager handles message persistence in the legacy flow
    return { ingested: false };
  }

  async assemble(params: {
    sessionId: string;
    messages: AgentMessage[];
    tokenBudget?: number;
  }): Promise<AssembleResult> {
    // Pass-through: existing pipeline handles context assembly
    return {
      messages: params.messages,
      estimatedTokens: 0,
    };
  }

  async compact(params: {
    sessionId: string;
    sessionFile: string;
    tokenBudget?: number;
    // ... other params
  }): Promise<CompactResult> {
    // Delegate to existing compaction logic
    const { compactEmbeddedPiSessionDirect } =
      await import("../agents/pi-embedded-runner/compact.runtime.js");

    const result = await compactEmbeddedPiSessionDirect({
      ...params.runtimeContext,
      sessionId: params.sessionId,
      sessionFile: params.sessionFile,
      tokenBudget: params.tokenBudget,
      // ...
    });

    return {
      ok: result.ok,
      compacted: result.compacted,
      reason: result.reason,
      result: result.result ? {
        summary: result.result.summary,
        firstKeptEntryId: result.result.firstKeptEntryId,
        tokensBefore: result.result.tokensBefore,
        tokensAfter: result.result.tokensAfter,
        details: result.result.details,
      } : undefined,
    };
  }
}
```

**Leon点评**：LegacyContextEngine是向后兼容的典范：
1. **最小改动**：ingest和assemble都是no-op/pass-through，保留了现有行为
2. **委托模式**：compact方法委托给现有的compactEmbeddedPiSessionDirect，避免重复实现
3. **类型适配**：将旧的结果类型适配到新的ContextEngine接口
4. **运行时边界**：通过动态导入compact.runtime.js保持懒加载边界

这种设计让OpenClaw可以逐步迁移到新的ContextEngine架构，而不破坏现有的功能。

### 4. 解析流程和配置集成

```typescript
// src/context-engine/registry.ts
export async function resolveContextEngine(
  config?: OpenClawConfig
): Promise<ContextEngine> {
  // 1. 从配置获取插槽值
  const slotValue = config?.plugins?.slots?.contextEngine;

  // 2. 回退到默认值
  const engineId =
    typeof slotValue === "string" && slotValue.trim()
      ? slotValue.trim()
      : defaultSlotIdForKey("contextEngine");

  // 3. 获取工厂
  const factory = getContextEngineRegistryState().engines.get(engineId);

  // 4. 错误处理
  if (!factory) {
    throw new Error(
      `Context engine "${engineId}" is not registered. ` +
        `Available engines: ${listContextEngineIds().join(", ") || "(none)"}`
    );
  }

  // 5. 创建实例
  return factory();
}
```

**Leon点评**：解析流程清晰且健壮：
1. **配置优先**：显式配置的引擎ID优先级最高
2. **安全回退**：未配置时使用默认的"legacy"引擎
3. **友好的错误消息**：列出所有可用的引擎，帮助用户调试
4. **工厂创建**：支持异步初始化，让引擎可以建立DB连接等资源

---

## 一、Context-Engine 架构总览

### 核心组件

```
Context-Engine 系统
├── 接口层 (types.ts)
│   ├── ContextEngine - 主接口
│   ├── ContextEngineInfo - 元数据
│   ├── AssembleResult - 组装结果
│   ├── CompactResult - 压缩结果
│   ├── IngestResult - 摄取结果
│   └── SubagentSpawnPreparation - 子agent准备
├── 注册表 (registry.ts)
│   ├── registerContextEngine() - 注册引擎
│   ├── getContextEngineFactory() - 获取工厂
│   ├── listContextEngineIds() - 列出所有引擎
│   └── resolveContextEngine() - 解析引擎
├── 实现 (legacy.ts)
│   └── LegacyContextEngine - 向后兼容实现
└── 初始化 (init.ts)
    └── ensureContextEnginesInitialized() - 确保初始化
```

### 生命周期流程

```
Session Start
    ↓
bootstrap() [可选]
    ↓
┌─────────────────────────────────────┐
│  Turn Loop                          │
│  ┌─────────────┐                   │
│  │ ingest()    │ ← 用户消息         │
│  └──────┬──────┘                   │
│         ↓                           │
│  ┌─────────────┐                   │
│  │ assemble()  │ ← 构建上下文       │
│  └──────┬──────┘                   │
│         ↓                           │
│  ┌─────────────┐                   │
│  │ AI Run      │                   │
│  └──────┬──────┘                   │
│         ↓                           │
│  ┌─────────────┐                   │
│  │ afterTurn() │ ← 后处理           │
│  └──────┬──────┘                   │
│         ↓                           │
│  ┌─────────────┐                   │
│  │ compact()?  │ ← 需要时压缩       │
│  └─────────────┘                   │
└─────────────────────────────────────┘
    ↓
dispose() [可选]
```

---

## 二、类型系统详解

### ContextEngineInfo

```typescript
export type ContextEngineInfo = {
  id: string;           // 引擎唯一标识
  name: string;         // 人类可读名称
  version?: string;     // 版本号
  ownsCompaction?: boolean;  // 引擎是否管理自己的压缩生命周期
};
```

### AssembleResult

```typescript
export type AssembleResult = {
  /** 用作模型上下文的有序消息 */
  messages: AgentMessage[];
  /** 组装上下文的预估总token数 */
  estimatedTokens: number;
  /** 可选的上下文引擎提供的指令，前置到运行时系统提示 */
  systemPromptAddition?: string;
};
```

### CompactResult

```typescript
export type CompactResult = {
  ok: boolean;
  compacted: boolean;
  reason?: string;
  result?: {
    summary?: string;
    firstKeptEntryId?: string;
    tokensBefore: number;
    tokensAfter?: number;
    details?: unknown;
  };
};
```

### IngestResult

```typescript
export type IngestResult = {
  /** 消息是否被摄取（false表示重复或no-op） */
  ingested: boolean;
};
```

---

## 三、核心方法深入分析

### ingest() - 消息摄取

**职责**：将单条消息摄入引擎的存储系统

**关键考虑**：
- **重复检测**：返回`ingested: false`表示消息是重复的
- **Heartbeat标记**：`isHeartbeat`标记让引擎可以区分心跳消息和真实用户消息
- **异步持久化**：引擎可以选择立即持久化或批量延迟写入

### assemble() - 上下文组装

**职责**：在token预算下选择最相关的消息

**关键考虑**：
- **消息排序**：返回的消息必须按时间顺序排列
- **Token估算**：`estimatedTokens`帮助调用者决定是否需要压缩
- **系统提示扩展**：`systemPromptAddition`允许引擎向系统提示添加上下文相关的指令

### compact() - 上下文压缩

**职责**：减少上下文大小，保持在预算内

**压缩策略**：
- **摘要**：用AI生成的摘要替换旧消息
- **修剪**：完全删除旧消息
- **混合**：摘要重要部分，修剪不重要部分

**关键参数**：
- `force`: 强制压缩，即使低于阈值
- `currentTokenCount`: 当前实时token估计
- `compactionTarget`: "budget"（严格预算）或"threshold"（阈值触发）

### afterTurn() - Turn后处理

**职责**：在每次run尝试后执行生命周期工作

**用途**：
- 持久化规范上下文
- 触发后台压缩决策
- 更新统计和元数据

---

## 四、子Agent支持

### prepareSubagentSpawn()

```typescript
prepareSubagentSpawn?(params: {
  parentSessionKey: string;
  childSessionKey: string;
  ttlMs?: number;
}): Promise<SubagentSpawnPreparation | undefined>;
```

**用途**：在子agent启动前准备引擎管理的状态

**返回值**：
```typescript
export type SubagentSpawnPreparation = {
  /** 子agent启动失败时回滚 */
  rollback: () => void | Promise<void>;
};
```

**场景**：
- 为子agent创建专用的上下文视图
- 设置TTL（time-to-live）用于自动清理
- 提供回滚机制用于错误恢复

### onSubagentEnded()

```typescript
onSubagentEnded?(params: {
  childSessionKey: string;
  reason: SubagentEndReason;
}): Promise<void>;
```

**结束原因**：
- `"deleted"`: 用户删除了子agent
- `"completed"`: 子agent完成任务
- `"swept"`: 子agent被TTL清理
- `"released"`: 子agent被释放

---

## 五、Bundle分块隔离问题 (#40096)

### 问题描述

当OpenClaw的bundle被分成多个chunk时，插件在一个chunk中注册的ContextEngine在另一个chunk中无法被解析。

### 解决方案

使用`Symbol.for()`创建全局唯一的注册表key：

```typescript
const CONTEXT_ENGINE_REGISTRY_STATE =
  Symbol.for("openclaw.contextEngineRegistryState");
```

**为什么有效**：
1. `Symbol.for()`在全局Symbol注册表中查找或创建Symbol
2. 所有模块共享同一个Symbol引用
3. `globalThis`在所有chunk中是同一个对象

### 测试覆盖

```typescript
describe("Bundle chunk isolation (#40096)", () => {
  it("Symbol.for key is stable across independently loaded modules", async () => {
    const chunkA = await import("./registry.ts?chunk=a");
    const chunkB = await import("./registry.ts?chunk=b");

    chunkA.registerContextEngine("test", () => new MockEngine());

    // chunkB可以看到chunkA注册的引擎
    expect(chunkB.getContextEngineFactory("test")).toBeDefined();
  });
});
```

---

## 六、技术权衡

### 1. Pass-through vs 自主管理

| 方案 | 优势 | 劣势 |
|------|------|------|
| Pass-through | 简单、保留现有行为 | 无法优化 |
| 自主管理 | 完全控制、可优化 | 复杂度高 |

**选择**：LegacyContextEngine使用pass-through
**原因**：保持向后兼容，让新引擎可以逐步采用

### 2. 全局注册表 vs 依赖注入

| 方案 | 优势 | 劣势 |
|------|------|------|
| 全局注册表 | 简单、插件易集成 | 测试困难、隐式依赖 |
| 依赖注入 | 可测试、显式依赖 | 复杂、插件集成困难 |

**选择**：全局注册表 + Symbol.for
**原因**：插件系统需要简单性，Symbol.for解决了测试隔离问题

### 3. 工厂模式 vs 单例模式

| 方案 | 优势 | 劣势 |
|------|------|------|
| 工厂模式 | 每次创建新实例、支持有状态的引擎 | 开销略高 |
| 单例模式 | 性能最优、全局状态共享 | 测试困难、并发问题 |

**选择**：工厂模式
**原因**：支持有状态的引擎（需要DB连接的引擎），每次调用可以创建新实例

---

## 七、实现自定义ContextEngine

### 最小实现

```typescript
import type { ContextEngine } from "@openclaw/plugin-sdk";

export class MyContextEngine implements ContextEngine {
  readonly info = {
    id: "my-engine",
    name: "My Context Engine",
    version: "1.0.0",
  };

  async ingest({ message }: {
    sessionId: string;
    message: AgentMessage;
  }): Promise<{ ingested: boolean }> {
    // 存储消息到你的存储系统
    await this.store(sessionId, message);
    return { ingested: true };
  }

  async assemble({ messages, tokenBudget }: {
    sessionId: string;
    messages: AgentMessage[];
    tokenBudget?: number;
  }): Promise<{ messages: AgentMessage[]; estimatedTokens: number }> {
    // 实现你的上下文选择策略
    const selected = await this.selectMessages(sessionId, tokenBudget);
    return {
      messages: selected,
      estimatedTokens: this.estimateTokens(selected),
    };
  }

  async compact({ sessionId, tokenBudget }: {
    sessionId: string;
    sessionFile: string;
    tokenBudget?: number;
  }): Promise<CompactResult> {
    // 实现你的压缩策略
    const result = await this.summarizeOldMessages(sessionId, tokenBudget);
    return result;
  }
}
```

### 注册引擎

```typescript
import { registerContextEngine } from "@openclaw/plugin-sdk";

export default function myPlugin(api: PluginAPI) {
  registerContextEngine("my-engine", () => new MyContextEngine());
}
```

---

## 八、与OpenClaw核心的集成

### 在run.ts中的使用

```typescript
// 解析引擎
const contextEngine = await resolveContextEngine(config);

// 摄取消息
await contextEngine.ingest({
  sessionId,
  message: userMessage,
});

// 组装上下文
const { messages, estimatedTokens } = await contextEngine.assemble({
  sessionId,
  messages: allMessages,
  tokenBudget: model.contextWindow,
});

// 运行AI
const result = await runAI(messages);

// Turn后处理
await contextEngine.afterTurn({
  sessionId,
  sessionFile,
  messages: result.messages,
  prePromptMessageCount: messages.length,
  tokenBudget: model.contextWindow,
});

// 需要时压缩
if (estimatedTokens > threshold) {
  await contextEngine.compact({
    sessionId,
    sessionFile,
    tokenBudget: model.contextWindow,
  });
}
```

---

## 附录：Context-Engine 与 Memory 的关系

### Q: Context-Engine 和 Memory 系统是什么关系？

**A: 它们是互补但独立的两个子系统**

```
Context-Engine (上下文引擎)
├── 职责：管理当前会话的消息上下文
├── 关注：短期、会话级别
├── 操作：选择哪些消息发给 AI
└── 目标：控制 token 使用，保持上下文相关

Memory (记忆系统)
├── 职责：搜索和检索长期知识
├── 关注：长期、知识库级别
├── 操作：向量搜索、语义检索
└── 目标：从外部知识库找到相关信息
```

### Q: 作者为什么这样设计？

**A: 基于职责分离和务实分阶段策略**

**1. 职责分离原则**

- **Context-Engine** 负责"当前对话上下文的管理"
  - 选择最近的哪些消息保留
  - 何时需要压缩上下文
  - 压缩时如何摘要

- **Memory** 负责"外部知识检索"
  - 从笔记中搜索相关信息
  - 从历史会话中查找类似对话
  - 向量搜索、语义匹配

**2. 设计边界清晰**

从代码 `src/agents/pi-settings.ts:103-106` 可以看出：

```typescript
// 当 Context-Engine ownsCompaction=true 时
// 禁用 Pi SDK 内部的 auto-compaction
export function shouldDisablePiAutoCompaction(params: {
  contextEngineInfo?: ContextEngineInfo;
}): boolean {
  return params.contextEngineInfo?.ownsCompaction === true;
}
```

这表明作者认为：
- **压缩决策权**应该属于 Context-Engine
- **Memory 不应该干扰上下文管理**

**3. 当前协作方式**

从代码 `src/agents/pi-embedded-runner/run/attempt.ts:1422-1447` 可以看出：

```typescript
// Context-Engine 在消息组装阶段工作
if (params.contextEngine) {
  const assembled = await params.contextEngine.assemble({
    sessionId: params.sessionId,
    messages: activeSession.messages,  // 当前会话的消息
    tokenBudget: params.contextTokenBudget,
  });

  // Context-Engine 可以添加 systemPromptAddition
  if (assembled.systemPromptAddition) {
    systemPromptText += assembled.systemPromptAddition;
  }
}

// Memory 是一个独立的 Tool，由 AI 调用
// src/agents/tool-catalog.ts:101-104
{
  id: "memory_search",
  label: "memory_search",
  description: "Semantic search",
  sectionId: "memory",
}
```

**关键点**：
- Context-Engine 在**每次 AI 调用前**自动工作
- Memory 通过**Tool 系统**由 AI 显式调用
- 两者目前没有自动集成机制

### Q: 未来的集成方向？

**A: 作者预留了扩展空间**

```typescript
// ContextEngine 接口设计
export interface ContextEngine {
  // 核心方法
  assemble(params: {
    sessionId: string;
    messages: AgentMessage[];
    tokenBudget?: number;
  }): Promise<AssembleResult>;

  // 返回值支持 systemPromptAddition
  // 这可能是未来与 Memory 集成的入口
}
```

**可能的未来集成方向**：
1. Context-Engine 在 assemble 时调用 Memory 搜索
2. 将 Memory 搜索结果作为 systemPromptAddition 返回
3. 实现"RAG 增强的上下文管理"

**但作者选择了务实的分阶段策略**：
- 第一阶段：先把两个子系统做扎实（当前状态）
- 第二阶段：再考虑深度融合（未来可能）

### Q: 这个设计的优缺点是什么？

**优点（Leon 的评价）**：
- ✅ **职责单一**：每个子系统专注于自己的领域
- ✅ **易于理解**：边界清晰，维护成本低
- ✅ **向后兼容**：LegacyContextEngine 保持现有行为
- ✅ **可扩展性**：插件可以注册新的 ContextEngine

**潜在问题**：
- ⚠️ **缺乏自动协作**：需要 AI 显式调用 memory_search
- ⚠️ **可能的重复工作**：Memory 搜索和 Context 选择可能有重叠
- ⚠️ **用户体验**：需要用户显式配置才能集成两者

### Q: 总结

**作者的设计哲学**：**"宁缺毋滥"的分阶段策略**

- 不强求一开始就做完美的集成
- 先保证每个子系统都能独立工作良好
- 预留扩展接口，让未来的集成成为可能

这种设计比过度耦合要安全得多——**先把基础做扎实，再考虑高级特性**。

---

*本文档基于源码分析，涵盖Context-Engine的完整架构、类型系统、核心方法、子Agent支持、bundle分块隔离问题的解决方案以及与Memory系统的关系分析。*
