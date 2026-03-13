# iMessage 通道 (iMessage Channel)

> "OpenClaw 的 iMessage 通道通过 RPC 客户端与 Messages gateway 通信，实现了 JSON-RPC 2.0 协议的消息收发。系统包含反射守卫防止回声、缓存系统避免重复发送、出站清理确保格式正确、入站处理规范消息格式、Monitor provider 提供健康检查。卧槽，回声检测的模式匹配太完善了——内部分隔符、思考标签、相关记忆标签，这些都是 AI Agent 特有的模式，精准识别并过滤，避免无限循环。"

---

## 核心技术洞察

### 1. JSON-RPC 2.0 客户端

```typescript
// src/imessage/client.ts
export class IMessageRpcClient {
  private readonly pending = new Map<string, PendingRequest>();
  private messageId = 0;
  private socket?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;

  async request<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ): Promise<T> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      await this.connect();
    }

    const id = String(++this.messageId);
    const message: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params: params ?? {},
    };

    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const pending = new Deferred<T>();
    this.pending.set(id, {
      deferred: pending,
      method,
      timeout: setTimeout(() => {
        this.pending.delete(id);
        pending.reject(new Error(`RPC request ${method}#${id} timed out after ${timeoutMs}ms`));
      }, timeoutMs),
    });

    this.socket.send(JSON.stringify(message));
    return pending.promise;
  }

  private handleIncomingMessage(data: string): void {
    let response: JsonRpcResponse;
    try {
      response = JSON.parse(data);
    } catch {
      return; // Ignore invalid JSON
    }

    const pending = this.pending.get(String(response.id));
    if (!pending) {
      return; // Unknown response
    }

    clearTimeout(pending.timeout);
    this.pending.delete(String(response.id));

    if (response.error) {
      pending.deferred.reject(new Error(response.error.message));
    } else {
      pending.deferred.resolve(response.result as unknown as T);
    }
  }
}
```

**Leon 点评**：RPC 客户端设计非常专业：
1. **并发安全**：使用 messageId 增量 ID 确保唯一性
2. **超时处理**：每个请求独立超时，避免永久挂起
3. **连接管理**：自动重连机制，处理网络波动
4. **类型安全**：泛型支持，调用方指定返回类型

### 2. 反射守卫

```typescript
// src/imessage/monitor/reflection-guard.ts
export const INTERNAL_SEPARATOR_RE = /───(?:[\s\S]*?)───/;

export const THINKING_TAG_RE =
  /<thinking(?:\s[^>]*)?>(?:[\s\S]*?)<\/thinking>/gi;

export const RELEVANT_MEMORIES_TAG_RE =
  /<relevant_memories(?:\s[^>]*)?>(?:[\s\S]*?)<\/relevant_memories>/gi;

export function looksLikeEchoFromInbound(
  inboundText: string,
  sentTexts: string[],
): boolean {
  const inboundTextNormalized = normalizeTextForEchoComparison(inboundText);

  for (const sentText of sentTexts) {
    const sentTextNormalized = normalizeTextForEchoComparison(sentText);

    // 完全匹配
    if (inboundTextNormalized === sentTextNormalized) {
      return true;
    }

    // 前缀匹配（处理被截断的回声）
    if (inboundTextNormalized.startsWith(sentTextNormalized.slice(0, 100))) {
      return true;
    }

    // 后缀匹配（处理前缀被添加的回声）
    if (inboundTextNormalized.endsWith(sentTextNormalized.slice(-100))) {
      return true;
    }
  }

  return false;
}

export function containsInternalMarkers(text: string): boolean {
  return (
    INTERNAL_SEPARATOR_RE.test(text) ||
    THINKING_TAG_RE.test(text) ||
    RELEVANT_MEMORIES_TAG_RE.test(text)
  );
}

export function shouldBlockMessageAsEcho(params: {
  inboundText: string;
  sentTexts: string[];
}): boolean {
  const { inboundText, sentTexts } = params;

  // 检查内部标记
  if (containsInternalMarkers(inboundText)) {
    return true;
  }

  // 检查回声匹配
  return looksLikeEchoFromInbound(inboundText, sentTexts);
}
```

**Leon 点评**：反射守卫的设计太聪明了：
1. **多模式检测**：内部分隔符、思考标签、记忆标签，这些 AI Agent 特有的模式
2. **模糊匹配**：前缀/后缀匹配处理被截断或被修改的回声
3. **文本规范化**：去除空白和差异后比较
4. **防循环**：精准识别并过滤，避免无限对话循环

### 3. 回声缓存

```typescript
// src/imessage/monitor/echo-cache.ts
export const SENT_MESSAGE_TEXT_TTL_MS = 5_000; // 文本缓存 5 秒
export const SENT_MESSAGE_ID_TTL_MS = 60_000; // ID 缓存 60 秒

export class SentMessageCache {
  private textCache = new Map<string, number>();
  private idCache = new Set<string>();

  addText(text: string): void {
    const normalized = normalizeTextForEchoComparison(text);
    this.textCache.set(normalized, Date.now() + SENT_MESSAGE_TEXT_TTL_MS);
    this.cleanup();
  }

  addId(messageId: string): void {
    this.idCache.add(messageId);
    // ID 缓存不自动清理，由外部调用 cleanupById
  }

  hasText(text: string): boolean {
    const normalized = normalizeTextForEchoComparison(text);
    const expiresAt = this.textCache.get(normalized);
    if (!expiresAt) {
      return false;
    }
    if (Date.now() > expiresAt) {
      this.textCache.delete(normalized);
      return false;
    }
    return true;
  }

  hasId(messageId: string): boolean {
    return this.idCache.has(messageId);
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, expiresAt] of this.textCache.entries()) {
      if (now > expiresAt) {
        this.textCache.delete(key);
      }
    }
  }

  cleanupById(messageId: string): void {
    this.idCache.delete(messageId);
  }
}
```

**Leon 点评**：回声缓存设计得很合理：
1. **双缓存机制**：文本缓存（短期）和 ID 缓存（长期）
2. **TTL 过期**：文本 5 秒、ID 60 秒，避免误杀
3. **自动清理**：每次操作时清理过期条目
4. **独立管理**：ID 缓存由外部清理，精确控制

### 4. 出站清理

```typescript
// src/imessage/sanitize-outbound.ts
export function sanitizeOutboundText(text: string): string {
  let sanitized = text;

  // 移除内部分隔符
  sanitized = sanitized.replace(INTERNAL_SEPARATOR_RE, "");

  // 移除思考标签
  sanitized = sanitized.replace(THINKING_TAG_RE, "");

  // 移除相关记忆标签
  sanitized = sanitized.replace(RELEVANT_MEMORIES_TAG_RE, "");

  // 移除多余的连续换行
  sanitized = sanitized.replace(/\n{3,}/g, "\n\n");

  // 去除首尾空白
  sanitized = sanitized.trim();

  return sanitized;
}

export function sanitizeOutboundMessage(
  message: OutboundMessage,
): OutboundMessage {
  if (message.type === "text") {
    return {
      ...message,
      text: sanitizeOutboundText(message.text),
    };
  }
  return message;
}
```

**Leon 点评**：出站清理很实用：
1. **内部标记清理**：移除 AI Agent 内部通信标记
2. **格式整理**：规范化换行，保持可读性
3. **类型安全**：只处理文本消息，其他类型原样返回
4. **不可变更新**：展开运算符创建新对象

### 5. 入站处理

```typescript
// src/imessage/inbound-processing.ts
export async function processInboundMessage(params: {
  message: InboundMessage;
  ctx: MsgContext;
  sentMessageCache: SentMessageCache;
}): Promise<{ shouldProcess: boolean; reason?: string }> {
  const { message, ctx, sentMessageCache } = params;

  // 跳过非文本消息
  if (message.type !== "text") {
    return { shouldProcess: false, reason: "non-text message" };
  }

  // 检查是否是我们发送的消息
  if (sentMessageCache.hasId(message.guid)) {
    sentMessageCache.cleanupById(message.guid);
    return { shouldProcess: false, reason: "sent message" };
  }

  // 检查是否是回声
  const sentTexts = Array.from(sentMessageCache.getTexts());
  if (shouldBlockMessageAsEcho({ inboundText: message.text, sentTexts })) {
    return { shouldProcess: false, reason: "echo detected" };
  }

  // 更新上下文
  ctx.Body = message.text;
  ctx.IMessageGuid = message.guid;
  ctx.IMessageHandle = message.handle;

  return { shouldProcess: true };
}
```

**Leon 点评**：入站处理流程清晰：
1. **类型过滤**：只处理文本消息
2. **ID 检查**：通过 GUID 识别自己发送的消息
3. **回声检测**：结合反射守卫和缓存
4. **上下文更新**：注入 iMessage 特定信息

### 6. Monitor Provider

```typescript
// src/imessage/monitor-provider.ts
export class IMessageMonitorProvider implements MonitorProvider {
  constructor(
    private readonly client: IMessageRpcClient,
    private readonly config: IMessageConfig,
  ) {}

  async getMonitorStatus(): Promise<MonitorStatusResult> {
    try {
      // 检查 RPC 连接
      await this.client.request("ping", {}, { timeoutMs: 3000 });

      return {
        status: "operational",
        message: "iMessage gateway is operational",
      };
    } catch (error) {
      return {
        status: "down",
        message: `iMessage gateway is down: ${error}`,
      };
    }
  }

  async getMonitorMetrics(): Promise<MonitorMetricsResult> {
    // 返回指标（具体实现省略）
    return {
      metrics: [],
      summary: {},
    };
  }
}
```

**Leon 点评**：Monitor Provider 很简洁：
1. **健康检查**：通过 ping 检查连接状态
2. **错误处理**：捕获异常并返回 down 状态
3. **接口实现**：符合 MonitorProvider 规范
4. **可扩展**：可以添加更多指标

---

## 一、iMessage 通道架构总览

### 核心组件

```
iMessage Channel
├── RPC Client（RPC 客户端）
│   ├── JSON-RPC 2.0
│   ├── WebSocket 连接
│   ├── 请求队列
│   └── 超时处理
├── Reflection Guard（反射守卫）
│   ├── Echo Detection（回声检测）
│   ├── Internal Markers（内部标记）
│   └── Pattern Matching（模式匹配）
├── Echo Cache（回声缓存）
│   ├── Text Cache（文本缓存）
│   ├── ID Cache（ID 缓存）
│   └── TTL Expiration（TTL 过期）
├── Sanitize Outbound（出站清理）
│   ├── Marker Removal（标记移除）
│   └── Format Normalization（格式规范化）
├── Inbound Processing（入站处理）
│   ├── Type Filtering（类型过滤）
│   ├── ID Check（ID 检查）
│   └── Context Update（上下文更新）
└── Monitor Provider（监控提供者）
    ├── Health Check（健康检查）
    └── Metrics（指标）
```

### 处理流程

```
Outbound Flow:
Agent Message
    ↓
Sanitize Outbound
    ↓
Send via RPC Client
    ↓
Add to Echo Cache
    ↓
Deliver to iMessage

Inbound Flow:
iMessage Received
    ↓
Process Inbound
    ↓
Check Echo Cache (ID)
    ↓
Check Reflection Guard
    ↓
Check Echo Cache (Text)
    ↓
Update Context
    ↓
Forward to Agent
```

---

## 二、类型系统

### 消息类型

```typescript
export type OutboundMessage =
  | OutboundTextMessage
  | OutboundAttachmentMessage
  | OutboundTapbackMessage
  | OutboundEffectMessage;

export type InboundMessage =
  | InboundTextMessage
  | InboundAttachmentMessage
  | InboundTapbackMessage
  | InboundReactionMessage;

export type OutboundTextMessage = {
  type: "text";
  text: string;
  to: string;
  guid?: string;
};

export type InboundTextMessage = {
  type: "text";
  text: string;
  guid: string;
  handle: string;
  from: string;
};
```

### RPC 类型

```typescript
export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params?: Record<string, unknown>;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};
```

### 配置类型

```typescript
export type IMessageConfig = {
  enabled: boolean;
  gatewayUrl: string;
  sendPolicy?: SendPolicy;
  handle?: string;
  monitor?: {
    enabled?: boolean;
  };
};
```

---

## 三、RPC 客户端

### 连接管理

```typescript
async connect(): Promise<void> {
  if (this.socket?.readyState === WebSocket.OPEN) {
    return;
  }

  this.socket = new WebSocket(this.config.gatewayUrl);

  this.socket.onopen = () => {
    this.clearReconnectTimer();
    this.emit("connected");
  };

  this.socket.onmessage = (event) => {
    this.handleIncomingMessage(event.data);
  };

  this.socket.onclose = () => {
    this.scheduleReconnect();
    this.emit("disconnected");
  };

  this.socket.onerror = (error) => {
    this.emit("error", error);
  };

  await new Promise<void>((resolve, reject) => {
    const onConnected = () => {
      this.off("connected", onConnected);
      this.off("error", onError);
      resolve();
    };
    const onError = (error: unknown) => {
      this.off("connected", onConnected);
      this.off("error", onError);
      reject(error);
    };
    this.on("connected", onConnected);
    this.on("error", onError);
  });
}
```

### 重连策略

| 策略 | 参数 | 描述 |
|------|------|------|
| 指数退避 | 初始 1s，最大 30s | 逐步增加重连间隔 |
| 最大重试 | 无限重试 | 持续尝试直到成功 |
| 连接超时 | 10s | 连接建立超时时间 |

---

## 四、反射守卫

### 内部标记模式

| 模式 | 正则 | 用途 |
|------|------|------|
| 内部分隔符 | `/───(?:[\s\S]*?)───/` | AI 内部思考分隔 |
| 思考标签 | `/<thinking(?:\s[^>]*)?>(?:[\s\S]*?)<\/thinking>/gi` | 思考过程标记 |
| 记忆标签 | `/<relevant_memories(?:\s[^>]*)?>(?:[\s\S]*?)<\/relevant_memories>/gi` | 相关记忆标记 |

### 回声检测策略

1. **完全匹配**：规范化文本完全相同
2. **前缀匹配**：入站文本以已发送文本开头（处理截断）
3. **后缀匹配**：入站文本以已发送文本结尾（处理前缀添加）

---

## 五、回声缓存

### TTL 设置

| 缓存类型 | TTL | 原因 |
|---------|-----|------|
| 文本缓存 | 5 秒 | 短期内检测回声 |
| ID 缓存 | 60 秒 | GUID 唯一，可以长期缓存 |

### 缓存操作

```typescript
// 发送消息时添加
cache.addText(message.text);
cache.addId(message.guid);

// 接收消息时检查
if (cache.hasId(message.guid)) {
  // 跳过，这是我们发送的
}

if (cache.hasText(message.text)) {
  // 可能是回声
}
```

---

## 六、出站清理

### 清理规则

| 规则 | 操作 | 原因 |
|------|------|------|
| 内部分隔符 | 移除 | 用户不应看到 |
| 思考标签 | 移除 | 用户不应看到 |
| 记忆标签 | 移除 | 用户不应看到 |
| 多余换行 | 规范化为 `\n\n` | 保持可读性 |
| 首尾空白 | trim | 清理格式 |

### 清理示例

```
Before:
```
<thinking>我需要思考一下</thinking>
Hello! 👋

How can I help?



───internal note───
```

After:
```
Hello! 👋

How can I help?
```

---

## 七、入站处理

### 处理步骤

```
1. 类型检查
   ├─ text → 继续
   └─ 其他 → 跳过

2. ID 检查
   ├─ 在缓存中 → 跳过（我们发送的）
   └─ 不在缓存 → 继续

3. 回声检测
   ├─ 包含内部标记 → 跳过
   ├─ 匹配已发送文本 → 跳过
   └─ 无匹配 → 继续

4. 上下文更新
   ├─ ctx.Body = message.text
   ├─ ctx.IMessageGuid = message.guid
   └─ ctx.IMessageHandle = message.handle

5. 转发到 Agent
```

---

## 八、Monitor Provider

### 健康检查

```typescript
await client.request("ping", {}, { timeoutMs: 3000 });
```

**状态**：
- `operational`：ping 成功
- `down`：ping 失败或超时

### 指标

```typescript
{
  metrics: [
    { name: "messages_sent", value: 123, unit: "count" },
    { name: "messages_received", value: 456, unit: "count" },
    { name: "echo_blocks", value: 12, unit: "count" },
  ],
  summary: {
    total_messages: 579,
    echo_rate: 0.021,
  }
}
```

---

## 九、技术权衡

### 1. WebSocket vs HTTP

| 方案 | 优势 | 劣势 |
|------|------|------|
| WebSocket | 双向通信、实时 | 需要保持连接 |
| HTTP | 简单、无状态 | 轮询开销 |

**选择**：WebSocket
**原因**：iMessage gateway 需要实时推送消息，WebSocket 更合适

### 2. 缓存 TTL 长度

| 方案 | 优势 | 劣势 |
|------|------|------|
| 短 TTL | 内存占用小 | 可能漏检回声 |
| 长 TTL | 检测准确 | 内存占用大 |

**选择**：短 TTL（文本 5s，ID 60s）
**原因**：文本回声很快出现，ID 可以缓存更久

### 3. 完全匹配 vs 模糊匹配

| 方案 | 优势 | 劣势 |
|------|------|------|
| 完全匹配 | 精确 | 可能漏检被修改的回声 |
| 模糊匹配 | 宽松 | 可能误杀 |

**选择**：两者结合
**原因**：完全匹配优先，前缀/后缀匹配处理边界情况

### 4. 出站清理 vs 原样发送

| 方案 | 优势 | 劣势 |
|------|------|------|
| 清理 | 用户体验好 | 可能丢失信息 |
| 原样发送 | 保留完整 | 用户看到内部标记 |

**选择**：出站清理
**原因**：内部标记是 Agent 实现细节，不应暴露给用户

---

*本文档基于源码分析，涵盖 iMessage 通道的架构、RPC 客户端、反射守卫、回声缓存、出站清理、入站处理、Monitor provider 以及技术权衡。*
