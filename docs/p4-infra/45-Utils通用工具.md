# Utils 通用工具 (Utils)

> "OpenClaw 的通用工具模块提供了各种实用函数，包括队列管理、消息通道、投递上下文、指令标签解析、并发控制、反应级别等。队列管理支持三种丢弃策略（summarize/old/new）和防抖机制，消息通道系统处理渠道规范化和 Markdown 能力检测。投递上下文合并策略处理跨渠道字段冲突，指令标签解析支持 audio_as_voice 和 reply_to 标签。卧槽，队列的 summarize 策略太聪明了——丢弃的条目被压缩成摘要行，而不是直接丢弃，这样 Agent 仍然能知道被丢弃内容的概要。"

---

## 核心技术洞察

### 1. 队列管理

```typescript
// src/utils/queue-helpers.ts
export type QueueState<T> = QueueSummaryState & {
  items: T[];
  cap: number;
};

export type QueueDropPolicy = QueueSummaryState["dropPolicy"];  // "summarize" | "old" | "new"

export function applyQueueDropPolicy<T>(params: {
  queue: QueueState<T>;
  summarize: (item: T) => string;
  summaryLimit?: number;
}): boolean {
  const cap = params.queue.cap;
  if (cap <= 0 || params.queue.items.length < cap) {
    return true;
  }
  if (params.queue.dropPolicy === "new") {
    return false;  // 拒绝新条目
  }

  const dropCount = params.queue.items.length - cap + 1;
  const dropped = params.queue.items.splice(0, dropCount);

  if (params.queue.dropPolicy === "summarize") {
    for (const item of dropped) {
      params.queue.droppedCount += 1;
      params.queue.summaryLines.push(buildQueueSummaryLine(params.summarize(item)));
    }
    const limit = Math.max(0, params.summaryLimit ?? cap);
    while (params.queue.summaryLines.length > limit) {
      params.queue.summaryLines.shift();  // FIFO 删除摘要
    }
  }
  // dropPolicy === "old": 直接丢弃，不记录
  return true;
}

export function waitForQueueDebounce(queue: {
  debounceMs: number;
  lastEnqueuedAt: number;
}): Promise<void> {
  if (process.env.OPENCLAW_TEST_FAST === "1") {
    return Promise.resolve();  // 测试模式跳过防抖
  }
  const debounceMs = Math.max(0, queue.debounceMs);
  if (debounceMs <= 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const check = () => {
      const since = Date.now() - queue.lastEnqueuedAt;
      if (since >= debounceMs) {
        resolve();
        return;
      }
      setTimeout(check, debounceMs - since);
    };
    check();
  });
}
```

**Leon 点评**：队列管理设计得非常灵活：
1. **三种策略**：summarize（摘要）、old（丢弃旧）、new（拒绝新）
2. **摘要机制**：droppedCount + summaryLines 记录被丢弃内容
3. **防抖等待**：等待 debounceMs 毫秒无新条目后再处理
4. **测试友好**：OPENCLAW_TEST_FAST 跳过防抖

### 2. 消息通道规范化

```typescript
// src/utils/message-channel.ts
export const INTERNAL_MESSAGE_CHANNEL = "webchat" as const;

const MARKDOWN_CAPABLE_CHANNELS = new Set<string>([
  "slack",
  "telegram",
  "signal",
  "discord",
  "googlechat",
  "tui",
  INTERNAL_MESSAGE_CHANNEL,
]);

export function normalizeMessageChannel(raw?: string | null): string | undefined {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === INTERNAL_MESSAGE_CHANNEL) {
    return INTERNAL_MESSAGE_CHANNEL;
  }
  const builtIn = normalizeChatChannelId(normalized);
  if (builtIn) {
    return builtIn;
  }
  const registry = getActivePluginRegistry();
  const pluginMatch = registry?.channels.find((entry) => {
    if (entry.plugin.id.toLowerCase() === normalized) {
      return true;
    }
    return (entry.plugin.meta.aliases ?? []).some(
      (alias) => alias.trim().toLowerCase() === normalized,
    );
  });
  return pluginMatch?.plugin.id ?? normalized;
}

export function isMarkdownCapableMessageChannel(raw?: string | null): boolean {
  const channel = normalizeMessageChannel(raw);
  if (!channel) {
    return false;
  }
  return MARKDOWN_CAPABLE_CHANNELS.has(channel);
}
```

**Leon 点评**：消息通道规范化设计得非常健壮：
1. **内置通道**：优先匹配内置渠道 ID
2. **插件通道**：回退到插件注册表，支持 aliases 匹配
3. **大小写不敏感**：全部转换为小写
4. **Markdown 能力**：预定义支持 Markdown 的渠道集合

### 3. 投递上下文

```typescript
// src/utils/delivery-context.ts
export type DeliveryContext = {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
};

export function mergeDeliveryContext(
  primary?: DeliveryContext,
  fallback?: DeliveryContext,
): DeliveryContext | undefined {
  const normalizedPrimary = normalizeDeliveryContext(primary);
  const normalizedFallback = normalizeDeliveryContext(fallback);
  if (!normalizedPrimary && !normalizedFallback) {
    return undefined;
  }
  const channelsConflict =
    normalizedPrimary?.channel &&
    normalizedFallback?.channel &&
    normalizedPrimary.channel !== normalizedFallback.channel;
  return normalizeDeliveryContext({
    channel: normalizedPrimary?.channel ?? normalizedFallback?.channel,
    // 保持路由字段与 channel 配对，避免跨渠道字段混淆
    to: channelsConflict
      ? normalizedPrimary?.to
      : (normalizedPrimary?.to ?? normalizedFallback?.to),
    accountId: channelsConflict
      ? normalizedPrimary?.accountId
      : (normalizedPrimary?.accountId ?? normalizedFallback?.accountId),
    threadId: channelsConflict
      ? normalizedPrimary?.threadId
      : (normalizedPrimary?.threadId ?? normalizedFallback?.threadId),
  });
}

export function deliveryContextKey(context?: DeliveryContext): string | undefined {
  const normalized = normalizeDeliveryContext(context);
  if (!normalized?.channel || !normalized?.to) {
    return undefined;
  }
  const threadId =
    normalized.threadId != null && normalized.threadId !== "" ? String(normalized.threadId) : "";
  return `${normalized.channel}|${normalized.to}|${normalized.accountId ?? ""}|${threadId}`;
}
```

**Leon 点评**：投递上下文合并策略很智能：
1. **冲突检测**：channelsConflict 标识跨渠道合并
2. **字段配对**：冲突时使用 primary 的路由字段，避免跨渠道混淆
3. **Key 生成**：channel + to + accountId + threadId 唯一标识
4. **规范化**：trim、类型转换、空值过滤

### 4. 指令标签解析

```typescript
// src/utils/directive-tags.ts
const AUDIO_TAG_RE = /\[\[\s*audio_as_voice\s*\]\]/gi;
const REPLY_TAG_RE = /\[\[\s*(?:reply_to_current|reply_to\s*:\s*([^\]\n]+))\s*\]\]/gi;

export function parseInlineDirectives(
  text?: string,
  options: InlineDirectiveParseOptions = {},
): InlineDirectiveParseResult {
  const { currentMessageId, stripAudioTag = true, stripReplyTags = true } = options;
  if (!text) {
    return {
      text: "",
      audioAsVoice: false,
      replyToCurrent: false,
      hasAudioTag: false,
      hasReplyTag: false,
    };
  }
  if (!text.includes("[[")) {
    return {
      text: normalizeDirectiveWhitespace(text),
      audioAsVoice: false,
      replyToCurrent: false,
      hasAudioTag: false,
      hasReplyTag: false,
    };
  }

  let cleaned = text;
  let audioAsVoice = false;
  let hasAudioTag = false;
  let hasReplyTag = false;
  let sawCurrent = false;
  let lastExplicitId: string | undefined;

  cleaned = cleaned.replace(AUDIO_TAG_RE, (match) => {
    audioAsVoice = true;
    hasAudioTag = true;
    return stripAudioTag ? " " : match;
  });

  cleaned = cleaned.replace(REPLY_TAG_RE, (match, idRaw: string | undefined) => {
    hasReplyTag = true;
    if (idRaw === undefined) {
      sawCurrent = true;
    } else {
      const id = idRaw.trim();
      if (id) {
        lastExplicitId = id;
      }
    }
    return stripReplyTags ? " " : match;
  });

  cleaned = normalizeDirectiveWhitespace(cleaned);

  const replyToId =
    lastExplicitId ?? (sawCurrent ? currentMessageId?.trim() || undefined : undefined);

  return {
    text: cleaned,
    audioAsVoice,
    replyToId,
    replyToExplicitId: lastExplicitId,
    replyToCurrent: sawCurrent,
    hasAudioTag,
    hasReplyTag,
  };
}

export function stripInlineDirectiveTagsForDisplay(text: string): StripInlineDirectiveTagsResult {
  if (!text) {
    return { text, changed: false };
  }
  const withoutAudio = text.replace(AUDIO_TAG_RE, "");
  const stripped = withoutAudio.replace(REPLY_TAG_RE, "");
  return {
    text: stripped,
    changed: stripped !== text,
  };
}
```

**Leon 点评**：指令标签解析实现得很完善：
1. **两种标签**：audio_as_voice（音频转语音）、reply_to（回复指定消息）
2. **灵活回复**：reply_to_current 或 reply_to: <id>
3. **保留/剥离**：stripAudioTag/stripReplyTags 控制是否保留标签
4. **显示清理**：stripInlineDirectiveTagsForDisplay 用于 UI 显示

### 5. 并发控制

```typescript
// src/utils/run-with-concurrency.ts
export type ConcurrencyErrorMode = "continue" | "stop";

export async function runTasksWithConcurrency<T>(params: {
  tasks: Array<() => Promise<T>>;
  limit: number;
  errorMode?: ConcurrencyErrorMode;
  onTaskError?: (error: unknown, index: number) => void;
}): Promise<{ results: T[]; firstError: unknown; hasError: boolean }> {
  const { tasks, limit, onTaskError } = params;
  const errorMode = params.errorMode ?? "continue";
  if (tasks.length === 0) {
    return { results: [], firstError: undefined, hasError: false };
  }

  const resolvedLimit = Math.max(1, Math.min(limit, tasks.length));
  const results: T[] = Array.from({ length: tasks.length });
  let next = 0;
  let firstError: unknown = undefined;
  let hasError = false;

  const workers = Array.from({ length: resolvedLimit }, async () => {
    while (true) {
      if (errorMode === "stop" && hasError) {
        return;  // stop 模式：遇到错误立即退出
      }
      const index = next;
      next += 1;
      if (index >= tasks.length) {
        return;
      }
      try {
        results[index] = await tasks[index]();
      } catch (error) {
        if (!hasError) {
          firstError = error;
          hasError = true;
        }
        onTaskError?.(error, index);
        if (errorMode === "stop") {
          return;
        }
      }
    }
  });

  await Promise.allSettled(workers);
  return { results, firstError, hasError };
}
```

**Leon 点评**：并发控制设计得很实用：
1. **Worker Pool**：创建 limit 个 worker 并发执行任务
2. **错误模式**：continue（继续）vs stop（停止）
3. **结果数组**：保持原始顺序，results[index] 对应 tasks[index]
4. **错误回调**：onTaskError 通知每个错误

### 6. 反应级别

```typescript
// src/utils/reaction-level.ts
export type ReactionLevel = "off" | "ack" | "minimal" | "extensive";

export type ResolvedReactionLevel = {
  level: ReactionLevel;
  /** ACK reactions (e.g., 👀 when processing) 是否启用 */
  ackEnabled: boolean;
  /** Agent-controlled reactions 是否启用 */
  agentReactionsEnabled: boolean;
  /** Agent 反应指导级别 */
  agentReactionGuidance?: "minimal" | "extensive";
};

export function resolveReactionLevel(params: {
  value: unknown;
  defaultLevel: ReactionLevel;
  invalidFallback: "ack" | "minimal";
}): ResolvedReactionLevel {
  const parsed = parseLevel(params.value);
  const effective =
    parsed.kind === "ok"
      ? parsed.value
      : parsed.kind === "missing"
        ? params.defaultLevel
        : params.invalidFallback;

  switch (effective) {
    case "off":
      return { level: "off", ackEnabled: false, agentReactionsEnabled: false };
    case "ack":
      return { level: "ack", ackEnabled: true, agentReactionsEnabled: false };
    case "minimal":
      return {
        level: "minimal",
        ackEnabled: false,
        agentReactionsEnabled: true,
        agentReactionGuidance: "minimal",
      };
    case "extensive":
      return {
        level: "extensive",
        ackEnabled: false,
        agentReactionsEnabled: true,
        agentReactionGuidance: "extensive",
      };
    default:
      return {
        level: "minimal",
        ackEnabled: false,
        agentReactionsEnabled: true,
        agentReactionGuidance: "minimal",
      };
  }
}
```

**Leon 点评**：反应级别解析设计得很清晰：
1. **四级控制**：off（关闭）、ack（仅确认）、minimal（少量）、extensive（大量）
2. **双维度**：ackEnabled（系统反应）+ agentReactionsEnabled（Agent 反应）
3. **三值处理**：ok（使用值）、missing（默认值）、invalid（回退值）
4. **指导级别**：minimal/extensive 传递给 Agent 作为反应频率指导

---

## 一、通用工具架构总览

### 核心组件

```
Utils
├── Queue Helpers（队列辅助）
│   ├── Drop Policy（丢弃策略）
│   ├── Debounce（防抖）
│   └── Summary（摘要）
├── Message Channel（消息通道）
│   ├── Normalization（规范化）
│   ├── Markdown Capability（Markdown 能力）
│   └── Gateway Client Info（Gateway 客户端信息）
├── Delivery Context（投递上下文）
│   ├── Normalization（规范化）
│   ├── Merge（合并）
│   └── Key Generation（Key 生成）
├── Directive Tags（指令标签）
│   ├── Audio Tag（音频标签）
│   ├── Reply Tag（回复标签）
│   └── Strip（剥离）
├── Concurrency Control（并发控制）
│   ├── Worker Pool（Worker 池）
│   ├── Error Mode（错误模式）
│   └── Results（结果）
└── Reaction Level（反应级别）
    ├── Parse（解析）
    ├── Resolve（解析）
    └── Capability（能力）
```

### 处理流程

```
Queue Processing:
New Item → Check Cap → Apply Drop Policy → Add or Reject → Wait Debounce → Drain

Message Channel:
Raw Input → Normalize → Check Built-in → Check Plugin → Return Channel ID

Delivery Context:
Merge Contexts → Detect Conflicts → Pair Fields → Normalize → Generate Key

Directive Tags:
Parse Text → Extract Tags → Strip/Keep → Return Cleaned Text + Metadata

Concurrency:
Create Workers → Distribute Tasks → Execute Concurrently → Collect Results

Reaction Level:
Parse Value → Resolve Level → Return Capabilities
```

---

## 二、类型系统

### 队列类型

```typescript
export type QueueDropPolicy = "summarize" | "old" | "new";

export type QueueSummaryState = {
  dropPolicy: QueueDropPolicy;
  droppedCount: number;
  summaryLines: string[];
};

export type QueueState<T> = QueueSummaryState & {
  items: T[];
  cap: number;
  debounceMs: number;
  lastEnqueuedAt: number;
  draining?: boolean;
};
```

### 消息通道类型

```typescript
export type InternalMessageChannel = "webchat";

export type GatewayMessageChannel = DeliverableMessageChannel | InternalMessageChannel;

export type GatewayAgentChannelHint = GatewayMessageChannel | "last";
```

### 投递上下文类型

```typescript
export type DeliveryContext = {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
};

export type DeliveryContextSessionSource = {
  channel?: string;
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
  deliveryContext?: DeliveryContext;
};
```

### 指令标签类型

```typescript
export type InlineDirectiveParseResult = {
  text: string;
  audioAsVoice: boolean;
  replyToId?: string;
  replyToExplicitId?: string;
  replyToCurrent: boolean;
  hasAudioTag: boolean;
  hasReplyTag: boolean;
};

export type InlineDirectiveParseOptions = {
  currentMessageId?: string;
  stripAudioTag?: boolean;
  stripReplyTags?: boolean;
};
```

### 并发控制类型

```typescript
export type ConcurrencyErrorMode = "continue" | "stop";

export type ConcurrencyResult<T> = {
  results: T[];
  firstError: unknown;
  hasError: boolean;
};
```

### 反应级别类型

```typescript
export type ReactionLevel = "off" | "ack" | "minimal" | "extensive";

export type ResolvedReactionLevel = {
  level: ReactionLevel;
  ackEnabled: boolean;
  agentReactionsEnabled: boolean;
  agentReactionGuidance?: "minimal" | "extensive";
};
```

---

## 三、队列管理

### 丢弃策略

| 策略 | 行为 | 适用场景 |
|------|------|----------|
| summarize | 丢弃旧条目，记录摘要 | 需要知道被丢弃内容 |
| old | 丢弃旧条目，不记录 | 只关心最新内容 |
| new | 拒绝新条目 | 保护现有数据 |

### 队列操作

```typescript
// 添加条目
function enqueue<T>(queue: QueueState<T>, item: T): boolean {
  if (shouldSkipQueueItem({ item, items: queue.items, dedupe })) {
    return false;
  }
  if (!applyQueueDropPolicy({ queue, summarize })) {
    return false;  // dropPolicy === "new" 时拒绝
  }
  queue.items.push(item);
  queue.lastEnqueuedAt = Date.now();
  return true;
}

// 处理队列
async function processQueue<T>(queue: QueueState<T>, run: (item: T) => Promise<void>): Promise<void> {
  await waitForQueueDebounce(queue);
  queue.draining = true;
  while (queue.items.length > 0) {
    await drainNextQueueItem(queue.items, run);
  }
  queue.draining = false;
}
```

### 摘要生成

```typescript
const summary = buildQueueSummaryPrompt({
  state: queue,
  noun: "message",
  title: "Dropped messages due to cap.",
});

// 输出：
// [Queue overflow] Dropped 5 messages due to cap.
// Summary:
// - User: Hello, how are you?
// - User: What's the weather today?
// - ...
```

---

## 四、消息通道

### 渠道规范化流程

```
Input
    ↓
Trim + Lowercase
    ↓
Match Internal (webchat)
    ↓
Match Built-in (telegram, discord, ...)
    ↓
Match Plugin (id + aliases)
    ↓
Return Normalized
```

### Markdown 能力检测

```typescript
isMarkdownCapableMessageChannel("telegram");   // true
isMarkdownCapableMessageChannel("signal");     // true
isMarkdownCapableMessageChannel("whatsapp");  // false
isMarkdownCapableMessageChannel("webchat");    // true
```

### Gateway 客户端信息

```typescript
// 检测 CLI 客户端
isGatewayCliClient({ mode: "cli" });           // true
isGatewayCliClient({ mode: "webchat" });       // false

// 检测 Webchat 客户端
isWebchatClient({ mode: "webchat" });          // true
isWebchatClient({ id: "webchat-ui" });         // true
isWebchatClient({ mode: "cli" });              // false
```

---

## 五、投递上下文

### 合并策略

```
Primary + Fallback
    ↓
Detect Channel Conflict
    ↓
No Conflict → Merge All Fields
    ↓
Conflict → Use Primary Routing Fields
    ↓
Normalize → Return
```

### Key 生成

```
channel|to|accountId|threadId

示例：
telegram|user123||               → DM
telegram||group123|              → 群组
discord|user456|account1|789     → 带线程
```

### 会话字段规范化

```typescript
const normalized = normalizeSessionDeliveryFields({
  channel: "telegram",
  lastChannel: "discord",
  lastTo: "user123",
  deliveryContext: {
    channel: "signal",
    to: "user456",
  },
});

// deliveryContext: { channel: "signal", to: "user456" }
// lastChannel: "signal"
// lastTo: "user456"
```

---

## 六、指令标签

### 标签格式

| 标签 | 格式 | 含义 |
|------|------|------|
| audio_as_voice | `[[audio_as_voice]]` | 文本转语音时播放 |
| reply_to_current | `[[reply_to_current]]` | 回复当前消息 |
| reply_to_id | `[[reply_to: <id>]]` | 回复指定消息 |

### 解析示例

```typescript
parseInlineDirectives(
  "Hello [[audio_as_voice]] [[reply_to: msg123]] world",
  { currentMessageId: "msg456" }
);

// 结果：
// {
//   text: "Hello world",
//   audioAsVoice: true,
//   replyToId: "msg123",
//   replyToExplicitId: "msg123",
//   replyToCurrent: false,
//   hasAudioTag: true,
//   hasReplyTag: true,
// }

parseInlineDirectives("[[reply_to_current]] Check this", { currentMessageId: "msg456" });

// 结果：
// {
//   text: "Check this",
//   audioAsVoice: false,
//   replyToId: "msg456",
//   replyToExplicitId: undefined,
//   replyToCurrent: true,
//   hasAudioTag: false,
//   hasReplyTag: true,
// }
```

### 显示剥离

```typescript
stripInlineDirectiveTagsForDisplay("[[audio_as_voice]] Hello [[reply_to: msg1]]");
// { text: " Hello ", changed: true }

stripInlineDirectiveTagsFromMessageForDisplay({
  content: [
    { type: "text", text: "[[audio_as_voice]] Hello" },
    { type: "image", url: "..." },
  ],
});
// {
//   content: [
//     { type: "text", text: " Hello" },
//     { type: "image", url: "..." },
//   ],
// }
```

---

## 七、并发控制

### Worker Pool 模式

```
Tasks: [T1, T2, T3, T4, T5, T6]
Limit: 3

Workers: [W1, W2, W3]

W1: T1 → T4 → ...
W2: T2 → T5 → ...
W3: T3 → T6 → ...

Results: [R1, R2, R3, R4, R5, R6]
```

### 错误模式

| 模式 | 行为 | 适用场景 |
|------|------|----------|
| continue | 遇到错误继续执行 | 最大吞吐量 |
| stop | 遇到错误立即停止 | 快速失败 |

### 使用示例

```typescript
const { results, firstError, hasError } = await runTasksWithConcurrency({
  tasks: [
    async () => await fetch(url1),
    async () => await fetch(url2),
    async () => await fetch(url3),
  ],
  limit: 2,
  errorMode: "continue",
  onTaskError: (error, index) => {
    console.error(`Task ${index} failed:`, error);
  },
});
```

---

## 八、反应级别

### 级别定义

| 级别 | ACK | Agent Reactions | 指导 |
|------|-----|-----------------|------|
| off | ❌ | ❌ | - |
| ack | ✅ | ❌ | - |
| minimal | ❌ | ✅ | minimal（少量） |
| extensive | ❌ | ✅ | extensive（大量） |

### 解析逻辑

```
Input Value
    ↓
Parse
    ├─ ok → Use Value
    ├─ missing → Use defaultLevel
    └─ invalid → Use invalidFallback
    ↓
Resolve Capabilities
    ↓
Return ResolvedReactionLevel
```

### 使用示例

```typescript
resolveReactionLevel({
  value: "minimal",
  defaultLevel: "off",
  invalidFallback: "ack",
});

// { level: "minimal", ackEnabled: false, agentReactionsEnabled: true, agentReactionGuidance: "minimal" }

resolveReactionLevel({
  value: "invalid",
  defaultLevel: "off",
  invalidFallback: "ack",
});

// { level: "ack", ackEnabled: true, agentReactionsEnabled: false }

resolveReactionLevel({
  value: undefined,
  defaultLevel: "extensive",
  invalidFallback: "ack",
});

// { level: "extensive", ackEnabled: false, agentReactionsEnabled: true, agentReactionGuidance: "extensive" }
```

---

## 九、其他工具

### Boolean 工具

```typescript
normalizeBooleanValue("true");    // true
normalizeBooleanValue("1");       // true
normalizeBooleanValue("yes");     // true
normalizeBooleanValue("false");   // false
normalizeBooleanValue("0");       // false
```

### Chunk 工具

```typescript
chunkItems([1, 2, 3, 4, 5], 2);  // [[1, 2], [3, 4], [5]]
```

### Fetch 超时

```typescript
await fetchWithTimeout(url, { timeoutMs: 5000 });
```

### Safe JSON

```typescript
parseSafeJSON("{invalid}");           // { ok: false, error: ... }
parseSafeJSON('{"valid": true}');     // { ok: true, value: { valid: true } }
```

---

## 十、技术权衡

### 1. 队列策略选择

| 场景 | 推荐策略 | 原因 |
|------|----------|------|
| 聊天消息 | summarize | 用户想知道被丢弃的消息 |
| 日志条目 | old | 只关心最新日志 |
| 关键数据 | new | 不丢弃任何数据 |

### 2. 并发限制

| 方案 | 优势 | 劣势 |
|------|------|------|
| 高并发 | 快速 | 资源消耗大 |
| 低并发 | 省资源 | 慢 |

**选择**：根据任务类型动态调整
- CPU 密集型：concurrency ≈ CPU 核心数
- I/O 密集型：concurrency ≈ CPU 核心数 × 2-4

### 3. 错误处理

| 场景 | 推荐模式 |
|------|----------|
| 批量处理 | continue（记录错误，继续处理） |
| 关键任务 | stop（立即失败） |

### 4. 反应级别

| 场景 | 推荐级别 |
|------|----------|
| 生产环境 | off 或 ack（避免干扰） |
| 测试/开发 | minimal 或 extensive（反馈友好） |

---

*本文档基于源码分析，涵盖通用工具的架构、队列管理、消息通道、投递上下文、指令标签解析、并发控制、反应级别以及技术权衡。*
