# Sessions 会话管理 (Session Management)

> "OpenClaw 的会话管理系统提供了细粒度的会话级配置能力，包括发送策略、模型覆盖、会话标签等。发送策略通过 channel/chatType/keyPrefix 多维度匹配实现精细控制，模型覆盖支持自动和手动两种模式，会话标签提供用户友好的会话名称。卧槽，模型覆盖的联动清理太完善了——切换模型时自动清理过时的 runtime 信息、contextTokens 和 fallback 通知，确保状态一致性。"

---

## 核心技术洞察

### 1. 发送策略系统

```typescript
// src/sessions/send-policy.ts
export type SessionSendPolicyDecision = "allow" | "deny";

export function resolveSendPolicy(params: {
  cfg: OpenClawConfig;
  entry?: SessionEntry;
  sessionKey?: string;
  channel?: string;
  chatType?: SessionChatType;
}): SessionSendPolicyDecision {
  // 1. 会话级覆盖优先
  const override = normalizeSendPolicy(params.entry?.sendPolicy);
  if (override) {
    return override;
  }

  const policy = params.cfg.session?.sendPolicy;
  if (!policy) {
    return "allow";  // 默认允许
  }

  // 2. 解析匹配维度
  const channel =
    normalizeMatchValue(params.channel) ??
    normalizeMatchValue(params.entry?.channel) ??
    deriveChannelFromKey(params.sessionKey);
  const chatType =
    normalizeChatType(params.chatType ?? params.entry?.chatType) ??
    deriveChatTypeFromKey(params.sessionKey);
  const rawSessionKey = params.sessionKey ?? "";
  const strippedSessionKey = stripAgentSessionKeyPrefix(rawSessionKey) ?? "";

  // 3. 规则匹配
  let allowedMatch = false;
  for (const rule of policy.rules ?? []) {
    const action = normalizeSendPolicy(rule.action) ?? "allow";
    const match = rule.match ?? {};

    // 所有匹配条件必须满足
    if (match.channel && match.channel !== channel) continue;
    if (match.chatType && match.chatType !== chatType) continue;
    if (match.keyPrefix && !sessionKeyMatches(match.keyPrefix)) continue;

    if (action === "deny") {
      return "deny";  // deny 优先，立即返回
    }
    allowedMatch = true;
  }

  // 4. 返回结果
  if (allowedMatch) {
    return "allow";
  }

  const fallback = normalizeSendPolicy(policy.default);
  return fallback ?? "allow";
}
```

**Leon 点评**：发送策略设计得非常灵活：
1. **优先级清晰**：会话覆盖 > 规则匹配 > 默认值
2. **多维度匹配**：channel、chatType、keyPrefix 精细控制
3. **deny 优先**：遇到 deny 立即返回，安全优先
4. **智能推导**：从 sessionKey 自动推导 channel 和 chatType

### 2. 模型覆盖机制

```typescript
// src/sessions/model-overrides.ts
export function applyModelOverrideToSessionEntry(params: {
  entry: SessionEntry;
  selection: ModelOverrideSelection;
  profileOverride?: string;
  profileOverrideSource?: "auto" | "user";
}): { updated: boolean } {
  const { entry, selection, profileOverride } = params;
  let updated = false;
  let selectionUpdated = false;

  // 1. 应用模型选择
  if (selection.isDefault) {
    // 恢复默认模型
    if (entry.providerOverride) {
      delete entry.providerOverride;
      updated = true;
    }
    if (entry.modelOverride) {
      delete entry.modelOverride;
      updated = true;
    }
  } else {
    // 应用覆盖模型
    if (entry.providerOverride !== selection.provider) {
      entry.providerOverride = selection.provider;
      updated = true;
    }
    if (entry.modelOverride !== selection.model) {
      entry.modelOverride = selection.model;
      updated = true;
    }
  }

  // 2. 清理过时的 runtime 信息
  const runtimeModel = entry.model?.trim() ?? "";
  const runtimeProvider = entry.modelProvider?.trim() ?? "";
  const runtimePresent = runtimeModel || runtimeProvider;
  const runtimeAligned =
    runtimeModel === selection.model &&
    (!runtimeProvider || runtimeProvider === selection.provider);

  if (runtimePresent && (selectionUpdated || !runtimeAligned)) {
    delete entry.model;
    delete entry.modelProvider;
    updated = true;
  }

  // 3. 清理过时的 contextTokens
  if (entry.contextTokens && (selectionUpdated || (runtimePresent && !runtimeAligned))) {
    delete entry.contextTokens;
    updated = true;
  }

  // 4. 应用 profile 覆盖
  if (profileOverride) {
    entry.authProfileOverride = profileOverride;
    entry.authProfileOverrideSource = params.profileOverrideSource ?? "user";
    delete entry.authProfileOverrideCompactionCount;
    updated = true;
  } else {
    delete entry.authProfileOverride;
    delete entry.authProfileOverrideSource;
    delete entry.authProfileOverrideCompactionCount;
    updated = true;
  }

  // 5. 清理 fallback 通知
  if (updated) {
    delete entry.fallbackNoticeSelectedModel;
    delete entry.fallbackNoticeActiveModel;
    delete entry.fallbackNoticeReason;
    entry.updatedAt = Date.now();
  }

  return { updated };
}
```

**Leon 点评**：模型覆盖的联动清理非常完善：
1. **状态一致性**：切换模型时清理所有相关状态
2. **Runtime 清理**：过时的 model/modelProvider 自动删除
3. **Context 清理**：contextTokens 与模型绑定，切换时清理
4. **Fallback 清理**：清理过时的 fallback 通知
5. **Profile 联动**：profile 覆盖时清理压缩计数

### 3. 会话标签系统

```typescript
// src/sessions/session-label.ts
export const SESSION_LABEL_MAX_LENGTH = 64;

export type ParsedSessionLabel = { ok: true; label: string } | { ok: false; error: string };

export function parseSessionLabel(raw: unknown): ParsedSessionLabel {
  if (typeof raw !== "string") {
    return { ok: false, error: "invalid label: must be a string" };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, error: "invalid label: empty" };
  }
  if (trimmed.length > SESSION_LABEL_MAX_LENGTH) {
    return {
      ok: false,
      error: `invalid label: too long (max ${SESSION_LABEL_MAX_LENGTH})`,
    };
  }
  return { ok: true, label: trimmed };
}
```

**Leon 点评**：会话标签验证简洁有效：
1. **长度限制**：64 字符最大长度
2. **空值检测**：空标签被拒绝
3. **类型验证**：确保字符串类型
4. **错误友好**：返回具体的错误原因

### 4. 会话 ID 识别

```typescript
// src/sessions/session-id.ts
export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function looksLikeSessionId(value: string): boolean {
  return SESSION_ID_RE.test(value.trim());
}
```

**Leon 点评**：会话 ID 识别简单直接：
1. **UUID 格式**：标准 UUID v4 格式
2. **大小写不敏感**：支持大小写输入
3. **trim 处理**：自动去除前后空白
4. **正则验证**：高效的正则表达式匹配

### 5. 会话键推导

```typescript
// src/sessions/session-key-utils.ts
export function deriveSessionChatType(sessionKey?: string): SessionChatType {
  if (!sessionKey) {
    return "unknown";
  }
  const parts = sessionKey.split(":").filter(Boolean);
  if (parts.length < 3) {
    return "unknown";
  }

  const channel = parts[0];
  const type = parts[1];

  if (type === "dm") {
    return "dm";
  }
  if (type === "group" || type === "channel") {
    // 检查是否是小群组
    const peerId = parts[2];
    if (peerId?.endsWith("-large")) {
      return "group_large";
    }
    return "group";
  }
  return "unknown";
}
```

**Leon 点评**：会话键推导智能识别：
1. **格式解析**：从 sessionKey 推导 chatType
2. **小群组检测**：`-large` 后缀识别大群组
3. **类型安全**：返回标准 SessionChatType
4. **回退处理**：无法识别时返回 "unknown"

---

## 一、会话管理架构总览

### 核心组件

```
Session Management
├── Session ID（会话 ID）
│   ├── UUID 格式验证
│   └── 识别函数
├── Session Label（会话标签）
│   ├── 解析和验证
│   └── 长度限制
├── Send Policy（发送策略）
│   ├── 规则匹配
│   ├── 多维度过滤
│   └── 默认值回退
├── Model Overrides（模型覆盖）
│   ├── Provider 覆盖
│   ├── Model 覆盖
│   └── 联动清理
└── Session Chat Type（会话聊天类型）
    ├── 推导函数
    └── 类型映射
```

### 会话聊天类型

| 类型 | 描述 | 示例 |
|------|------|------|
| dm | 直接消息 | 用户对用户 |
| group | 群组 | 小群组 |
| group_large | 大群组 | 大型群组 |
| unknown | 未知 | 无法识别 |

---

## 二、类型系统

### 会话条目

```typescript
export type SessionEntry = {
  sessionKey: string;
  label?: string;
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
  channel?: string;
  chatType?: SessionChatType;
  sendPolicy?: "allow" | "deny";
  providerOverride?: string;
  modelOverride?: string;
  model?: string;
  modelProvider?: string;
  contextTokens?: number;
  authProfileOverride?: string;
  authProfileOverrideSource?: "auto" | "user";
  // ... 更多字段
};
```

### 发送策略规则

```typescript
export type SessionSendPolicyRule = {
  action?: "allow" | "deny";
  match?: {
    channel?: string;
    chatType?: SessionChatType;
    keyPrefix?: string;
    rawKeyPrefix?: string;
  };
};
```

### 模型覆盖选择

```typescript
export type ModelOverrideSelection = {
  provider: string;
  model: string;
  isDefault?: boolean;  // 是否为默认模型
};
```

---

## 三、发送策略

### 策略配置

```typescript
export type SessionSendPolicy = {
  default?: "allow" | "deny";
  rules?: SessionSendPolicyRule[];
};
```

### 匹配维度

| 维度 | 描述 | 示例 |
|------|------|------|
| channel | 渠道标识 | telegram, discord |
| chatType | 聊天类型 | dm, group, group_large |
| keyPrefix | 会话键前缀 | agent:default:telegram: |
| rawKeyPrefix | 原始键前缀 | telegram:123456: |

### 匹配示例

```yaml
# 禁止所有群组消息
- action: deny
  match:
    chatType: group

# 允许特定渠道的 DM
- action: allow
  match:
    channel: telegram
    chatType: dm

# 禁止特定会话
- action: deny
  match:
    keyPrefix: "agent:default:discord:spam-channel:"
```

---

## 四、模型覆盖

### 覆盖层级

```
默认模型（全局配置）
    ↓
Provider 覆盖（会话级）
    ↓
Model 覆盖（会话级）
    ↓
Runtime 信息（运行时）
```

### 覆盖清理

当切换模型时，自动清理：
1. **Runtime 信息**：`model`、`modelProvider`
2. **Context Tokens**：`contextTokens`
3. **Fallback 通知**：`fallbackNotice*`
4. **Profile 压缩**：`authProfileOverrideCompactionCount`

### Profile 覆盖

```typescript
// 自动覆盖（例如通过 AutoCMD）
applyModelOverrideToSessionEntry({
  entry,
  selection,
  profileOverride: "claude-sonnet-4",
  profileOverrideSource: "auto",
});

// 用户覆盖（通过命令）
applyModelOverrideToSessionEntry({
  entry,
  selection,
  profileOverride: "gpt-4o",
  profileOverrideSource: "user",
});
```

---

## 五、会话标签

### 标签约束

| 约束 | 值 | 说明 |
|------|-----|------|
| 最大长度 | 64 字符 | 防止标签过长 |
| 必须非空 | - | 空标签被拒绝 |
| 类型 | string | 必须是字符串 |
| 自动 trim | - | 去除前后空白 |

### 验证结果

```typescript
type ParsedSessionLabel =
  | { ok: true; label: string }
  | { ok: false; error: string };
```

---

## 六、会话键

### 格式

```
<channel>:<type>:<peerId>[:<subId>]
```

### 示例

| 会话键 | 渠道 | 类型 | Peer ID |
|--------|------|------|--------|
| `telegram:dm:123456` | telegram | dm | 123456 |
| `discord:group:789:large` | discord | group_large | 789 |
| `slack:channel:ABC:G123` | slack | group | ABC/G123 |

### Agent 会话键

```
agent:<agentId>:<channel>:<type>:<peerId>[:<subId>]
```

---

## 七、技术权衡

### 1. 会话级 vs 全局配置

| 方案 | 优势 | 劣势 |
|------|------|------|
| 会话级 | 精细控制、灵活性 | 配置复杂 |
| 全局配置 | 简单、一致 | 粒度粗 |

**选择**：两者结合
**原因**：全局配置作为默认值，会话级覆盖提供精细控制

### 2. Deny 优先 vs Allow 优先

| 方案 | 优势 | 劣势 |
|------|------|------|
| Deny 优先 | 安全优先、白名单模式 | 需要明确允许 |
| Allow 优先 | 开放、易用 | 需要明确禁止 |

**选择**：Deny 优先
**原因**：安全优先，deny 规则立即生效

### 3. 自动清理 vs 手动清理

| 方案 | 优势 | 劣势 |
|------|------|------|
| 自动清理 | 状态一致、用户无感知 | 可能过度清理 |
| 手动清理 | 精确控制 | 容易遗漏 |

**选择**：自动清理
**原因**：确保状态一致性，避免用户困惑

### 4. 推导 vs 显式配置

| 方案 | 优势 | 劣势 |
|------|------|------|
| 推导 | 自动化、减少配置 | 可能不准确 |
| 显式配置 | 精确、可控 | 需要手动配置 |

**选择**：推导 + 显式覆盖
**原因**：默认自动推导，支持显式覆盖修正

---

*本文档基于源码分析，涵盖会话管理的架构、发送策略、模型覆盖、会话标签、会话键推导以及技术权衡。*
