# Pairing 配对系统

> "OpenClaw的配对系统设计得太安全了。8字符的人性化配对码（排除易混淆字符0OI1）确保了用户友好性，文件锁机制保证了并发安全，allowFrom白名单提供了细粒度的访问控制。卧槽，这个配对码生成算法太靠谱了——500次重试确保唯一性，过期清理防止状态堆积，三层URL解析（publicUrl→remote→tailscale→bind）让远程配对丝滑顺畅。这个系统把安全性和可用性平衡得恰到好处。"

---

## 核心技术洞察

### 1. 人性化配对码生成

```typescript
// src/pairing/pairing-store.ts
const PAIRING_CODE_LENGTH = 8;
const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomCode(): string {
  let out = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    const idx = crypto.randomInt(0, PAIRING_CODE_ALPHABET.length);
    out += PAIRING_CODE_ALPHABET[idx];
  }
  return out;
}

function generateUniqueCode(existing: Set<string>): string {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const code = randomCode();
    if (!existing.has(code)) {
      return code;
    }
  }
  throw new Error("failed to generate unique pairing code");
}
```

**Leon点评**：这个配对码设计考虑得极其周到：
1. **字符选择**：排除易混淆字符（0, O, 1, I），只保留32个清晰字符
2. **长度权衡**：8字符提供32^8 ≈ 1.1万亿种组合，足够安全且易于输入
3. **重试机制**：500次重试确保高并发下也能生成唯一码
4. **密码学安全**：使用crypto.randomInt而不是Math.random，确保不可预测

这种设计在安全性和可用性之间找到了最佳平衡点。

### 2. 文件锁保证并发安全

```typescript
// src/pairing/pairing-store.ts
const PAIRING_STORE_LOCK_OPTIONS = {
  retries: {
    retries: 10,
    factor: 2,
    minTimeout: 100,
    maxTimeout: 10_000,
    randomize: true,
  },
  stale: 30_000,
} as const;

async function withFileLock<T>(
  filePath: string,
  fallback: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  await ensureJsonFile(filePath, fallback);
  return await withPathLock(filePath, PAIRING_STORE_LOCK_OPTIONS, async () => {
    return await fn();
  });
}
```

**Leon点评**：并发控制设计非常健壮：
1. **指数退避**：重试延迟从100ms开始，每次翻倍，最大10秒
2. **随机化**：避免多个进程的惊群效应
3. **过期检测**：30秒stale阈值防止死锁
4. **10次重试**：在竞争和延迟之间找到平衡

这种设计确保即使在多个进程同时操作配对存储时，也不会出现数据竞争。

### 3. allowFrom 白名单管理

```typescript
// src/pairing/pairing-store.ts
type AllowFromStore = {
  version: 1;
  allowFrom: string[];
};

async function addChannelAllowFromStoreEntry(
  params: AllowFromStoreEntryUpdateParams,
): Promise<{ changed: boolean; allowFrom: string[] }> {
  return await updateChannelAllowFromStore({
    ...params,
    apply: (current, normalized) => {
      if (current.includes(normalized)) {
        return null;  // 已存在，不修改
      }
      return [...current, normalized];  // 追加新条目
    },
  });
}

async function removeChannelAllowFromStoreEntry(
  params: AllowFromStoreEntryUpdateParams,
): Promise<{ changed: boolean; allowFrom: string[] }> {
  return await updateChannelAllowFromStore({
    ...params,
    apply: (current, normalized) => {
      const next = current.filter((entry) => entry !== normalized);
      if (next.length === current.length) {
        return null;  // 不存在，不修改
      }
      return next;
    },
  });
}
```

**Leon点评**：白名单管理简洁而有效：
1. **幂等性**：添加已存在的条目或删除不存在的条目都是no-op
2. **变更追踪**：返回changed标志让调用者知道是否需要更新UI
3. **去重**：dedupePreserveOrder函数保证顺序且去重
4. **账号隔离**：支持多账号的allowFrom隔离

这种设计让访问控制既灵活又安全。

### 4. 过期清理机制

```typescript
// src/pairing/pairing-store.ts
const PAIRING_PENDING_TTL_MS = 60 * 60 * 1000;  // 1小时
const PAIRING_PENDING_MAX = 3;

function isExpired(entry: PairingRequest, nowMs: number): boolean {
  const createdAt = parseTimestamp(entry.createdAt);
  if (!createdAt) {
    return true;  // 无效时间戳视为过期
  }
  return nowMs - createdAt > PAIRING_PENDING_TTL_MS;
}

function pruneExpiredRequests(reqs: PairingRequest[], nowMs: number) {
  const kept: PairingRequest[] = [];
  let removed = false;
  for (const req of reqs) {
    if (isExpired(req, nowMs)) {
      removed = true;
      continue;
    }
    kept.push(req);
  }
  return { requests: kept, removed };
}

function pruneExcessRequests(reqs: PairingRequest[], maxPending: number) {
  if (maxPending <= 0 || reqs.length <= maxPending) {
    return { requests: reqs, removed: false };
  }
  const sorted = reqs.slice().toSorted((a, b) =>
    resolveLastSeenAt(a) - resolveLastSeenAt(b)
  );
  return { requests: sorted.slice(-maxPending), removed: true };
}
```

**Leon点评**：清理策略考虑了多种边界情况：
1. **时间过期**：1小时TTL防止配对请求永久停留
2. **数量限制**：最多3个待处理请求防止状态堆积
3. **LRU淘汰**：超出限制时删除最旧的请求
4. **惰性清理**：在下次访问时清理，而不是定期任务

这种设计保持了配对存储的清洁，同时避免了额外的复杂性。

### 5. 三层URL解析策略

```typescript
// src/pairing/setup-code.ts
async function resolveGatewayUrl(cfg: OpenClawConfig, opts: {
  env: NodeJS.ProcessEnv;
  publicUrl?: string;
  preferRemoteUrl?: boolean;
  forceSecure?: boolean;
  runCommandWithTimeout?: PairingSetupCommandRunner;
  networkInterfaces: () => ReturnType<typeof os.networkInterfaces>;
}): Promise<ResolveUrlResult> {
  const scheme = resolveScheme(cfg, { forceSecure: opts.forceSecure });
  const port = resolveGatewayPort(cfg, opts.env);

  // 1. 插件配置的publicUrl（最高优先级）
  if (typeof opts.publicUrl === "string" && opts.publicUrl.trim()) {
    const url = normalizeUrl(opts.publicUrl, scheme);
    if (url) {
      return { url, source: "plugins.entries.device-pair.config.publicUrl" };
    }
    return { error: "Configured publicUrl is invalid." };
  }

  // 2. 远程URL（可选偏好）
  const remoteUrlRaw = cfg.gateway?.remote?.url;
  const remoteUrl = typeof remoteUrlRaw === "string" && remoteUrlRaw.trim()
    ? normalizeUrl(remoteUrlRaw, scheme)
    : null;
  if (opts.preferRemoteUrl && remoteUrl) {
    return { url: remoteUrl, source: "gateway.remote.url" };
  }

  // 3. Tailscale Serve/Funnel
  const tailscaleMode = cfg.gateway?.tailscale?.mode ?? "off";
  if (tailscaleMode === "serve" || tailscaleMode === "funnel") {
    const host = await resolveTailnetHostWithRunner(opts.runCommandWithTimeout);
    if (!host) {
      return { error: "Tailscale Serve is enabled, but MagicDNS could not be resolved." };
    }
    return { url: `wss://${host}`, source: `gateway.tailscale.mode=${tailscaleMode}` };
  }

  // 4. 远程URL（默认）
  if (remoteUrl) {
    return { url: remoteUrl, source: "gateway.remote.url" };
  }

  // 5. 本地绑定地址
  const bindResult = resolveGatewayBindUrl({
    bind: cfg.gateway?.bind,
    customBindHost: cfg.gateway?.customBindHost,
    scheme,
    port,
    pickTailnetHost: () => pickTailnetIPv4(opts.networkInterfaces),
    pickLanHost: () => pickLanIPv4(opts.networkInterfaces),
  });
  if (bindResult) {
    return bindResult;
  }

  return {
    error: "Gateway is only bound to loopback. Set gateway.bind=lan, enable tailscale serve, or configure plugins.entries.device-pair.config.publicUrl.",
  };
}
```

**Leon点评**：URL解析策略极其周全：
1. **显式配置优先**：publicUrl具有最高优先级，适合生产环境
2. **Tailscale集成**：自动检测并使用Tailscale的MagicDNS
3. **智能回退**：从远程到本地，依次尝试
4. **清晰的错误消息**：当只绑定loopback时，给出明确的解决建议

这种设计让配对在各种网络拓扑下都能正常工作。

---

## 一、Pairing 系统架构总览

### 核心组件

```
Pairing 系统
├── pairing-store.ts - 配对存储管理
│   ├── PairingRequest - 配对请求结构
│   ├── PairingStore - 持久化格式
│   ├── upsertChannelPairingRequest() - 创建/更新配对
│   ├── approveChannelPairingCode() - 审批配对码
│   └── allowFrom管理 - 白名单增删查
├── pairing-challenge.ts - 配对挑战发布
│   └── issuePairingChallenge() - 统一挑战发布流程
├── pairing-messages.ts - 配对消息构建
│   └── buildPairingReply() - 生成配对回复
├── setup-code.ts - 配对设置代码解析
│   ├── resolvePairingSetupFromConfig() - 配置解析
│   ├── resolveGatewayUrl() - URL解析
│   ├── resolveAuth() - 认证解析
│   └── encodePairingSetupCode() - Base64URL编码
└── setup-code.test.ts - 测试
```

### 配对流程

```
┌─────────────┐
│ 用户发送消息 │
└──────┬──────┘
       ↓
┌─────────────────────────────┐
│ 检查allowFrom白名单          │
│                             │
│  已在白名单？ ──Yes→ 接受消息 │
│       │                      │
│      No                      │
│       ↓                      │
│  创建配对请求                │
│  生成配对码                  │
│  发送配对提示                │
└─────────────────────────────┘
       ↓
┌─────────────────────────────┐
│ 管理员审批                   │
│                             │
│  $ openclaw pairing approve  │
│     telegram ABC12345        │
└─────────────────────────────┘
       ↓
┌─────────────────────────────┐
│ 添加到allowFrom白名单        │
│ 删除配对请求                 │
└─────────────────────────────┘
       ↓
┌─────────────┐
│ 用户重试消息 │
└──────┬──────┘
       ↓
   消息接受 ✓
```

---

## 二、数据结构详解

### PairingRequest

```typescript
export type PairingRequest = {
  id: string;              // 用户/设备标识
  code: string;            // 8字符配对码
  createdAt: string;       // ISO 8601时间戳
  lastSeenAt: string;      // 最后访问时间
  meta?: Record<string, string>;  // 元数据（如accountId）
};
```

### PairingStore

```typescript
type PairingStore = {
  version: 1;
  requests: PairingRequest[];
};
```

### AllowFromStore

```typescript
type AllowFromStore = {
  version: 1;
  allowFrom: string[];  // 允许的用户ID列表
};
```

### 文件路径

```
~/.openclaw/credentials/
├── telegram-pairing.json           # 配对请求存储
├── telegram-allowFrom.json         # 白名单（默认账号）
├── telegram-account123-allowFrom.json  # 白名单（特定账号）
├── discord-pairing.json
├── discord-allowFrom.json
└── ...
```

---

## 三、配对码生成算法

### 字符集设计

```typescript
// 排除易混淆字符
// 0 (零) → 排除
// O (大写O) → 排除
// 1 (一) → 排除
// I (大写I) → 排除
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";  // 32字符
```

**选择理由**：
- 字母表：26个字母 - 4个易混淆 = 22个
- 数字：10个数字 - 2个易混淆 = 8个
- 总计：30个清晰字符（实际代码32个）

### 唯一性保证

```typescript
function generateUniqueCode(existing: Set<string>): string {
  // 最多重试500次
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const code = randomCode();
    if (!existing.has(code)) {
      return code;
    }
  }
  throw new Error("failed to generate unique pairing code");
}
```

**碰撞概率分析**：
- 8字符32进制：32^8 ≈ 1.1 × 10^12 种组合
- 假设100个活跃配对：碰撞概率 ≈ 100^2 / (2 × 32^8) ≈ 4.5 × 10^-21
- **结论**：实际上不可能碰撞

---

## 四、并发控制机制

### 文件锁策略

```typescript
const PAIRING_STORE_LOCK_OPTIONS = {
  retries: {
    retries: 10,           // 最多重试10次
    factor: 2,             // 指数退避因子
    minTimeout: 100,       // 初始100ms
    maxTimeout: 10_000,    // 最大10秒
    randomize: true,       // 随机化抖动
  },
  stale: 30_000,           // 30秒过期
} as const;
```

**重试时序**：
```
尝试 1: 100ms + random(0-100ms) = ~100ms
尝试 2: 200ms + random(0-200ms) = ~200ms
尝试 3: 400ms + random(0-400ms) = ~400ms
尝试 4: 800ms + random(0-800ms) = ~800ms
尝试 5: 1600ms + random(0-1600ms) = ~1.6s
尝试 6: 3200ms + random(0-3200ms) = ~3.2s
尝试 7: 6400ms + random(0-6400ms) = ~6.4s
尝试 8+: 10s (达到上限)

总等待时间: ~22s (10次尝试)
```

### 原子操作保证

```typescript
async function updateAllowFromStoreEntry(params: {
  channel: PairingChannel;
  entry: string | number;
  accountId?: string;
  env?: NodeJS.ProcessEnv;
  apply: (current: string[], normalized: string) => string[] | null;
}): Promise<{ changed: boolean; allowFrom: string[] }> {
  return await withFileLock(
    filePath,
    { version: 1, allowFrom: [] } satisfies AllowFromStore,
    async () => {
      // 在锁保护下读取
      const { current, normalized } = await readAllowFromState({
        channel: params.channel,
        entry: params.entry,
        filePath,
      });

      // 应用变更
      const next = params.apply(current, normalized);
      if (!next) {
        return { changed: false, allowFrom: current };
      }

      // 在锁保护下写入
      await writeAllowFromState(filePath, next);
      return { changed: true, allowFrom: next };
    },
  );
}
```

---

## 五、URL 解析策略

### 优先级顺序

```
1. plugins.entries.device-pair.config.publicUrl
   └─ 用户显式配置的公开URL

2. gateway.remote.url (if preferRemoteUrl)
   └─ 远程网关URL（可选偏好）

3. gateway.tailscale.mode = serve|funnel
   └─ Tailscale MagicDNS

4. gateway.remote.url (default)
   └─ 远程网关URL（默认）

5. gateway.bind + local network interfaces
   └─ 本地绑定地址
      ├─ customBindHost (显式配置)
      ├─ Tailnet IPv4 (CGNAT)
      └─ LAN IPv4 (RFC1918)

6. 回退到错误
   └─ "Gateway is only bound to loopback..."
```

### IP 地址选择

```typescript
function pickIPv4Matching(
  networkInterfaces: () => ReturnType<typeof os.networkInterfaces>,
  matches: (address: string) => boolean,
): string | null {
  const nets = networkInterfaces();
  for (const entries of Object.values(nets)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (!entry || entry.internal || entry.family !== "IPv4") {
        continue;
      }
      const address = entry.address?.trim() ?? "";
      if (address && matches(address)) {
        return address;
      }
    }
  }
  return null;
}
```

**选择逻辑**：
1. 跳过内部地址（loopback）
2. 只考虑IPv4
3. 优先匹配第一个符合条件的地址

---

## 六、认证解析流程

### 认证模式

```typescript
function resolveAuth(cfg: OpenClawConfig, env: NodeJS.ProcessEnv): ResolveAuthResult {
  const mode = cfg.gateway?.auth?.mode;

  // 1. 显式模式配置
  if (mode === "password") {
    if (!password) {
      return { error: "Gateway auth is set to password, but no password is configured." };
    }
    return { password, label: "password" };
  }
  if (mode === "token") {
    if (!token) {
      return { error: "Gateway auth is set to token, but no token is configured." };
    }
    return { token, label: "token" };
  }

  // 2. 自动检测
  if (token) {
    return { token, label: "token" };
  }
  if (password) {
    return { password, label: "password" };
  }

  // 3. 未配置
  return { error: "Gateway auth is not configured (no token or password)." };
}
```

### 环境变量回退

```typescript
function resolveGatewayTokenFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  return env.OPENCLAW_GATEWAY_TOKEN?.trim() ||
         env.CLAWDBOT_GATEWAY_TOKEN?.trim() ||
         undefined;
}

function resolveGatewayPasswordFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  return env.OPENCLAW_GATEWAY_PASSWORD?.trim() ||
         env.CLAWDBOT_GATEWAY_PASSWORD?.trim() ||
         undefined;
}
```

**注意**：同时支持新的 `OPENCLAW_` 和旧的 `CLAWDBOT_` 前缀，确保向后兼容。

---

## 七、配对设置代码编码

### Base64URL 编码

```typescript
export function encodePairingSetupCode(payload: PairingSetupPayload): string {
  const json = JSON.stringify(payload);
  const base64 = Buffer.from(json, "utf8").toString("base64");
  return base64
    .replace(/\+/g, "-")    // + → -
    .replace(/\//g, "_")    // / → _
    .replace(/=+$/g, "");   // 移除padding
}
```

**示例**：
```json
// 输入
{
  "url": "wss://example.com:18789",
  "token": "abc123"
}

// JSON
{"url":"wss://example.com:18789","token":"abc123"}

// Base64
eyJ1cmwiOiJ3c3M6Ly9leGFtcGxlLmNvbToxODc4OSIsInRva2VuIjoiYWJjMTIzIn0=

// Base64URL (编码后)
eyJ1cmwiOiJ3c3M6Ly9leGFtcGxlLmNvbToxODc4OSIsInRva2VuIjoiYWJjMTIzIn0
```

---

## 八、与渠道集成

### 配对适配器接口

```typescript
export type ChannelPairingAdapter = {
  /** 标准化用户ID（去除@、域名等） */
  normalizeAllowEntry?(entry: string): string;

  /** 构建用户显示行 */
  buildSenderIdLine?(senderId: string): string;

  /** 发送配对回复 */
  sendPairingReply(channel: string, senderId: string, text: string): Promise<void>;
};
```

### 统一配对挑战流程

```typescript
export async function issuePairingChallenge(
  params: PairingChallengeParams,
): Promise<{ created: boolean; code?: string }> {
  const { code, created } = await params.upsertPairingRequest({
    id: params.senderId,
    meta: params.meta,
  });

  if (!created) {
    return { created: false };
  }

  params.onCreated?.({ code });

  const replyText =
    params.buildReplyText?.({ code, senderIdLine: params.senderIdLine }) ??
    buildPairingReply({
      channel: params.channel,
      idLine: params.senderIdLine,
      code,
    });

  try {
    await params.sendPairingReply(replyText);
  } catch (err) {
    params.onReplyError?.(err);
  }

  return { created: true, code };
}
```

---

## 九、多账号支持

### 账号隔离

```typescript
function resolveAllowFromAccountId(accountId?: string): string {
  return normalizePairingAccountId(accountId) || DEFAULT_ACCOUNT_ID;
}

function resolveAllowFromPath(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv,
  accountId?: string,
): string {
  const base = safeChannelKey(channel);
  const normalizedAccountId = typeof accountId === "string" ? accountId.trim() : "";
  if (!normalizedAccountId) {
    return path.join(resolveCredentialsDir(env), `${base}-allowFrom.json`);
  }
  return path.join(
    resolveCredentialsDir(env),
    `${base}-${safeAccountKey(normalizedAccountId)}-allowFrom.json`,
  );
}
```

### 向后兼容

```typescript
function shouldIncludeLegacyAllowFromEntries(normalizedAccountId: string): boolean {
  // 默认账号保留旧的单文件兼容性
  return !normalizedAccountId || normalizedAccountId === DEFAULT_ACCOUNT_ID;
}

export async function readChannelAllowFromStore(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string,
): Promise<string[]> {
  const resolvedAccountId = resolveAllowFromAccountId(accountId);

  if (!shouldIncludeLegacyAllowFromEntries(resolvedAccountId)) {
    // 非默认账号：只读取账号专用文件
    return await readNonDefaultAccountAllowFrom({
      channel,
      env,
      accountId: resolvedAccountId,
    });
  }

  // 默认账号：合并账号文件和旧文件
  const scopedPath = resolveAllowFromPath(channel, env, resolvedAccountId);
  const scopedEntries = await readAllowFromStateForPath(channel, scopedPath);
  const legacyPath = resolveAllowFromPath(channel, env);
  const legacyEntries = await readAllowFromStateForPath(channel, legacyPath);
  return dedupePreserveOrder([...scopedEntries, ...legacyEntries]);
}
```

---

## 十、技术权衡

### 1. 文件存储 vs 数据库

| 方案 | 优势 | 劣势 |
|------|------|------|
| 文件存储 | 简单、可审计、易于备份 | 并发复杂度高 |
| 数据库 | 原生并发支持 | 额外依赖、复杂性 |

**选择**：文件存储 + 文件锁
**原因**：
- 配对数据量小（通常<10条）
- 文件锁已足够保证一致性
- 避免额外的数据库依赖

### 2. 即时清理 vs 惰性清理

| 方案 | 优势 | 劣势 |
|------|------|------|
| 即时清理 | 数据始终干净 | 需要定时任务 |
| 惰性清理 | 简单、无额外进程 | 清理延迟 |

**选择**：惰性清理
**原因**：
- 过期配对只在访问时才有影响
- 避免定时任务的复杂性
- 清理延迟可接受（下次访问时清理）

### 3. 固定TTL vs 滑动TTL

| 方案 | 优势 | 劣势 |
|------|------|------|
| 固定TTL | 简单、可预测 | 用户活跃时仍过期 |
| 滑动TTL | 活跃用户不过期 | 需要每次更新 |

**选择**：固定TTL + lastSeenAt
**原因**：
- 固定TTL简化逻辑
- lastSeenAt提供调试信息
- 1小时足够用户完成配对

---

*本文档基于源码分析，涵盖Pairing配对系统的完整架构、配对码生成、并发控制、URL解析、认证流程以及多账号支持。*
