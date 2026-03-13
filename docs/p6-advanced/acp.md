# ACP 控制平面 (Agent Control Plane)

> "OpenClaw 的 ACP 是一个精心设计的分布式会话管理系统，支持多运行时抽象、会话持久化、并发控制和策略执行。卧槽，这个运行时缓存太优雅了——自动追踪活跃会话、支持空闲驱逐、优雅处理并发。会话身份协调机制通过 pending/resolved 状态确保跨重启的一致性，而持久化绑定让特定对话可以永久关联到 Agent。"

---

## 核心技术洞察

### 1. 运行时抽象层

```typescript
// src/acp/runtime/types.ts
export interface AcpRuntime {
  ensureSession(input: AcpRuntimeEnsureInput): Promise<AcpRuntimeHandle>;
  runTurn(input: AcpRuntimeTurnInput): AsyncIterable<AcpRuntimeEvent>;
  getCapabilities?(input: { handle?: AcpRuntimeHandle }): Promise<AcpRuntimeCapabilities>;
  getStatus?(input: { handle: AcpRuntimeHandle; signal?: AbortSignal }): Promise<AcpRuntimeStatus>;
  setMode?(input: { handle: AcpRuntimeHandle; mode: string }): Promise<void>;
  setConfigOption?(input: { handle: AcpRuntimeHandle; key: string; value: string }): Promise<void>;
  cancel(input: { handle: AcpRuntimeHandle; reason?: string }): Promise<void>;
  close(input: { handle: AcpRuntimeHandle; reason: string }): Promise<void>;
}
```

**Leon 点评**：运行时抽象层是 ACP 的核心设计理念：
1. **接口统一**：所有 Agent 运行时（acpx、原生等）实现同一接口
2. **异步流式**：`runTurn` 返回 `AsyncIterable` 支持流式响应
3. **可选能力**：通过 `getCapabilities` 动态发现运行时支持的功能
4. **控制协议**：`setMode`、`setConfigOption` 实现运行时控制

### 2. 会话管理器核心

```typescript
// src/acp/control-plane/manager.core.ts
export class AcpSessionManager {
  async initializeSession(input: AcpInitializeSessionInput): Promise<AcpSessionResolution> {
    // 1. 检查策略是否允许
    if (!isAcpEnabledByPolicy(input.cfg)) {
      return { kind: "none", sessionKey: input.sessionKey };
    }

    // 2. 检查 Agent 白名单
    const policyError = resolveAcpAgentPolicyError(input.cfg, input.agent);
    if (policyError) {
      return { kind: "stale", sessionKey: input.sessionKey, error: policyError };
    }

    // 3. 加载或创建会话元数据
    const meta = await this.loadOrCreateMeta(input);

    // 4. 获取或创建运行时句柄
    const handle = await this.ensureRuntimeHandle(input, meta);

    return { kind: "ready", sessionKey: input.sessionKey, meta };
  }
}
```

**Leon 点评**：会话管理器的职责划分清晰：
1. **策略执行**：在初始化前检查所有策略约束
2. **元数据持久化**：会话状态持久化到磁盘
3. **运行时缓存**：活跃会话缓存在内存中
4. **错误分类**：none/stale/ready 三种状态便于上层处理

### 3. 运行时缓存机制

```typescript
// src/acp/control-plane/runtime-cache.ts
export class RuntimeCache {
  private readonly cache = new Map<string, RuntimeCacheEntry>();

  set(actorKey: string, state: CachedRuntimeState, params: { now?: number } = {}): void {
    this.cache.set(actorKey, {
      state,
      lastTouchedAt: params.now ?? Date.now(),
    });
  }

  collectIdleCandidates(params: { maxIdleMs: number; now?: number }): CachedRuntimeSnapshot[] {
    const now = params.now ?? Date.now();
    return this.snapshot({ now }).filter((entry) => entry.idleMs >= params.maxIdleMs);
  }

  snapshot(params: { now?: number } = {}): CachedRuntimeSnapshot[] {
    const now = params.now ?? Date.now();
    const entries: CachedRuntimeSnapshot[] = [];
    for (const [actorKey, entry] of this.cache.entries()) {
      entries.push({
        actorKey,
        state: entry.state,
        lastTouchedAt: entry.lastTouchedAt,
        idleMs: Math.max(0, now - entry.lastTouchedAt),
      });
    }
    return entries;
  }
}
```

**Leon 点评**：运行时缓存的设计考虑了实际使用场景：
1. **活跃追踪**：`lastTouchedAt` 追踪会话活跃度
2. **空闲驱逐**：`collectIdleCandidates` 找出长时间未使用的会话
3. **快照能力**：`snapshot` 提供缓存状态的完整视图
4. **优雅降级**：缓存丢失时可以从持久化元数据恢复

### 4. 会话身份协调

```typescript
// src/acp/runtime/session-identity.ts
export function mergeSessionIdentity(params: {
  current: SessionAcpIdentity | undefined;
  incoming: SessionAcpIdentity | undefined;
  now: number;
}): SessionAcpIdentity | undefined {
  const currentResolved = current?.state === "resolved";
  const incomingResolved = incoming?.state === "resolved";

  // 只有当 incoming 已解析，或 current 未解析时，才使用 incoming 的值
  const allowIncomingValue = !currentResolved || incomingResolved;

  const nextAcpxSessionId = allowIncomingValue && incoming?.acpxSessionId
    ? incoming.acpxSessionId
    : current?.acpxSessionId;

  const nextAgentSessionId = allowIncomingValue && incoming?.agentSessionId
    ? incoming.agentSessionId
    : current?.agentSessionId;

  const nextResolved = Boolean(nextAcpxSessionId || nextAgentSessionId);
  const nextState: SessionAcpIdentity["state"] = nextResolved ? "resolved" : "pending";

  return {
    state: nextState,
    ...(nextAcpxSessionId ? { acpxSessionId: nextAcpxSessionId } : {}),
    ...(nextAgentSessionId ? { agentSessionId: nextAgentSessionId } : {}),
    source: incoming?.source ?? current?.source ?? "status",
    lastUpdatedAt: now,
  };
}
```

**Leon 点评**：会话身份协调解决了分布式系统的一致性问题：
1. **状态机**：pending → resolved 的单向转换
2. **合并策略**：resolved 状态优先于 pending 状态
3. **多 ID 支持**：acpxSessionId、agentSessionId、acpxRecordId
4. **时间戳追踪**：`lastUpdatedAt` 用于调试和审计

### 5. 持久化绑定

```typescript
// src/acp/persistent-bindings.types.ts
export function buildConfiguredAcpSessionKey(spec: ConfiguredAcpBindingSpec): string {
  const hash = createHash("sha256")
    .update(`${spec.channel}:${spec.accountId}:${spec.conversationId}`)
    .digest("hex")
    .slice(0, 16);
  return `agent:${sanitizeAgentId(spec.agentId)}:acp:binding:${spec.channel}:${spec.accountId}:${hash}`;
}

export function toConfiguredAcpBindingRecord(spec: ConfiguredAcpBindingSpec): SessionBindingRecord {
  return {
    bindingId: `config:acp:${spec.channel}:${spec.accountId}:${spec.conversationId}`,
    targetSessionKey: buildConfiguredAcpSessionKey(spec),
    targetKind: "session",
    conversation: {
      channel: spec.channel,
      accountId: spec.accountId,
      conversationId: spec.conversationId,
      parentConversationId: spec.parentConversationId,
    },
    status: "active",
    boundAt: 0,
    metadata: {
      source: "config",
      mode: spec.mode,
      agentId: spec.agentId,
      ...(spec.acpAgentId ? { acpAgentId: spec.acpAgentId } : {}),
      label: spec.label,
      ...(spec.backend ? { backend: spec.backend } : {}),
      ...(spec.cwd ? { cwd: spec.cwd } : {}),
    },
  };
}
```

**Leon 点评**：持久化绑定实现了"对话即会话"的语义：
1. **SHA256 哈希**：将对话标识符转换为稳定的会话密钥
2. **元数据丰富**：mode、cwd、backend、label 全部持久化
3. **灵活绑定**：支持 acpAgentId 覆盖默认的 agentId
4. **父对话支持**：`parentConversationId` 处理线程化消息

---

## 一、ACP 架构总览

### 核心组件

```
ACP (Agent Control Plane)
├── Control Plane（控制平面）
│   ├── SessionManager（会话管理器）
│   ├── RuntimeCache（运行时缓存）
│   ├── SessionActorQueue（会话演员队列）
│   └── Policy（策略执行）
├── Runtime（运行时抽象）
│   ├── Registry（运行时注册表）
│   ├── Adapters（适配器）
│   ├── SessionIdentity（会话身份）
│   └── Errors（错误处理）
└── Persistent Bindings（持久化绑定）
    ├── Types（类型定义）
    ├── Resolve（解析器）
    ├── Route（路由器）
    └── Lifecycle（生命周期）
```

### 会话模式

| 模式 | 描述 | 使用场景 |
|------|------|----------|
| persistent | 持久化会话 | 长期对话、上下文保留 |
| oneshot | 一次性会话 | 无状态查询、快速响应 |

### 运行时后端

| 后端 | 描述 | 状态 |
|------|------|------|
| acpx | ACPX 本地运行时 | 默认 |
| (可扩展) | 其他运行时 | 待实现 |

---

## 二、类型系统

### 会话初始化输入

```typescript
export type AcpInitializeSessionInput = {
  cfg: OpenClawConfig;
  sessionKey: string;
  agent: string;
  mode: AcpRuntimeSessionMode;
  resumeSessionId?: string;
  cwd?: string;
  backendId?: string;
};
```

### 会话运行输入

```typescript
export type AcpRunTurnInput = {
  cfg: OpenClawConfig;
  sessionKey: string;
  text: string;
  attachments?: AcpTurnAttachment[];
  mode: AcpRuntimePromptMode;  // "prompt" | "steer"
  requestId: string;
  signal?: AbortSignal;
  onEvent?: (event: AcpRuntimeEvent) => Promise<void> | void;
};
```

### 会话关闭输入

```typescript
export type AcpCloseSessionInput = {
  cfg: OpenClawConfig;
  sessionKey: string;
  reason: string;
  clearMeta?: boolean;
  allowBackendUnavailable?: boolean;
  requireAcpSession?: boolean;
};
```

### 运行时事件

```typescript
export type AcpRuntimeEvent =
  | { type: "text_delta"; text: string; stream?: "output" | "thought"; tag?: AcpSessionUpdateTag }
  | { type: "status"; text: string; tag?: AcpSessionUpdateTag; used?: number; size?: number }
  | { type: "tool_call"; text: string; tag?: AcpSessionUpdateTag; toolCallId?: string; status?: string }
  | { type: "done"; stopReason?: string }
  | { type: "error"; message: string; code?: string; retryable?: boolean };
```

---

## 三、控制平面策略

### ACP 启用策略

```typescript
export function isAcpEnabledByPolicy(cfg: OpenClawConfig): boolean {
  return cfg.acp?.enabled !== false;
}
```

### Agent 白名单策略

```typescript
export function isAcpAgentAllowedByPolicy(cfg: OpenClawConfig, agentId: string): boolean {
  const allowed = (cfg.acp?.allowedAgents ?? [])
    .map((entry) => normalizeAgentId(entry))
    .filter(Boolean);
  if (allowed.length === 0) {
    return true;  // 空白名单 = 全部允许
  }
  return allowed.includes(normalizeAgentId(agentId));
}
```

### 速率限制策略

```typescript
export type AcpServerOptions = {
  sessionCreateRateLimit?: {
    maxRequests?: number;
    windowMs?: number;
  };
};
```

---

## 四、会话演员队列

### 队列语义

```typescript
// src/acp/control-plane/session-actor-queue.ts
export class SessionActorQueue {
  private readonly activeTurns = new Map<string, ActiveTurnState>();

  async enqueue(input: AcpRunTurnInput): Promise<AcpTurnResult> {
    const sessionKey = input.sessionKey;

    // 检查是否有活跃的 turn
    const existing = this.activeTurns.get(sessionKey);
    if (existing) {
      // 等待现有 turn 完成
      await existing.cancelPromise;
    }

    // 创建新的 turn
    const abortController = new AbortController();
    const turnState: ActiveTurnState = {
      runtime,
      handle,
      abortController,
    };
    this.activeTurns.set(sessionKey, turnState);

    // 执行 turn
    try {
      const result = await this.executeTurn(input, turnState);
      return result;
    } finally {
      this.activeTurns.delete(sessionKey);
    }
  }
}
```

**Leon 点评**：会话演员队列确保了会话内的串行执行：
1. **活跃追踪**：`activeTurns` 追踪每个会话的活跃 turn
2. **串行保证**：同一会话的 turn 串行执行
3. **取消传播**：`abortController` 支持优雅取消
4. **自动清理**：turn 完成后自动从队列移除

---

## 五、可观测性

### 快照指标

```typescript
export type AcpManagerObservabilitySnapshot = {
  runtimeCache: {
    activeSessions: number;
    idleTtlMs: number;
    evictedTotal: number;
    lastEvictedAt?: number;
  };
  turns: {
    active: number;
    queueDepth: number;
    completed: number;
    failed: number;
    averageLatencyMs: number;
    maxLatencyMs: number;
  };
  errorsByCode: Record<string, number>;
};
```

### 会话状态

```typescript
export type AcpSessionStatus = {
  sessionKey: string;
  backend: string;
  agent: string;
  identity?: SessionAcpIdentity;
  state: SessionAcpMeta["state"];
  mode: AcpRuntimeSessionMode;
  runtimeOptions: AcpSessionRuntimeOptions;
  capabilities: AcpRuntimeCapabilities;
  runtimeStatus?: AcpRuntimeStatus;
  lastActivityAt: number;
  lastError?: string;
};
```

---

## 六、技术权衡

### 1. 内存缓存 vs 纯持久化

| 方案 | 优势 | 劣势 |
|------|------|------|
| 内存缓存 | 低延迟、支持复杂操作 | 受限容量、重启丢失 |
| 纯持久化 | 无容量限制、持久稳定 | 高延迟、不支持复杂查询 |

**选择**：混合模式
**原因**：缓存活跃会话，持久化作为真相源

### 2. 串行队列 vs 并行执行

| 方案 | 优势 | 劣势 |
|------|------|------|
| 串行队列 | 状态一致、实现简单 | 吞吐量受限 |
| 并行执行 | 高吞吐量 | 状态复杂、冲突风险 |

**选择**：会话内串行、会话间并行
**原因**：会话状态一致性优先，多会话并发提高吞吐

### 3. 运行时抽象 vs 直接集成

| 方案 | 优势 | 劣势 |
|------|------|------|
| 运行时抽象 | 可扩展、可测试 | 抽象开销 |
| 直接集成 | 高性能、直接访问 | 紧耦合、难扩展 |

**选择**：运行时抽象
**原因**：支持多种运行时、便于测试、未来扩展

### 4. Pending/Resolved 状态 vs 直接 ID

| 方案 | 优势 | 劣势 |
|------|------|------|
| 状态机 | 支持异步初始化、可恢复 | 复杂度高 |
| 直接 ID | 简单直接 | 无法表示中间状态 |

**选择**：Pending/Resolved 状态机
**原因**：运行时初始化是异步的，需要表示中间状态

---

*本文档基于源码分析，涵盖 ACP 控制平面的架构、类型系统、策略执行、会话管理、运行时缓存、身份协调和持久化绑定。*
