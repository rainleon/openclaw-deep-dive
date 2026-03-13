# Cron 调度引擎架构

> 基于 `src/cron/` 源码分析

---

## 核心技术洞察（TL;DR）

Cron 是 OpenClaw 的**时间指挥家**，一个设计精巧的定时任务编排系统。

| 洞察 | 说明 |
|------|------|
| **三层调度刀法** | at（绝对时间）/ every（间隔）/ cron（表达式）三种模式 |
| **隔离执行架构** | `sessionTarget: "isolated"` 确保每次执行是全新会话 |
| **交付目标解析** | 复杂的优先级逻辑（payload → delivery → global → fallback） |
| **错过的任务处理** | `maxMissedJobsPerRestart` + `missedJobStaggerMs` 防止启动风暴 |
| **会话收割机** | `session-reaper.ts` 自动清理过期 cron run 会话 |
| **临时重试机制** | 检测 interim ack → 自动补一枪获取完整输出 |
| **心跳抑制策略** | `HEARTBEAT_OK` 无内容时跳过交付，减少噪音 |
| **失败告警链路** | `failureDestination` 独立于主交付目标 |
| **Schedule 缓存** | 512 条目的 croner 表达式缓存，LRU 淘汰 |
| **交错执行机制** | `staggerMs` 防止整点任务同时触发 |

**一句话总结**：Cron 是一个**时间驱动的任务编排系统**，用隔离执行 + 精密交付逻辑 + 自动清理机制，确保定时任务可靠运行。

---

## 一、Cron 定位与架构全景

Cron 是 OpenClaw 的**定时任务调度引擎**，负责：
- 时间触发与调度计算
- Agent 任务隔离执行
- 消息交付与失败通知
- 会话生命周期管理
- 错过任务恢复

```
┌─────────────────────────────────────────────────────────────────┐
│                        Cron Architecture                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌────────────────┐    ┌────────────────┐    ┌────────────────┐│
│  │  Timer Loop    │───→│  Scheduler     │───→│  Job Queue     ││
│  │  (setInterval) │    │  (nextRunAt)   │    │  (due jobs)    ││
│  └────────────────┘    └────────────────┘    └────────────────┘│
│           │                     │                    │          │
│           ▼                     ▼                    ▼          │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                   CronService State                        │  │
│  │  store: CronStoreFile | timer: Timeout | running: bool  │  │
│  └──────────────────────────────────────────────────────────┘  │
│           │                     │                    │          │
│           ▼                     ▼                    ▼          │
│  ┌────────────────┐    ┌────────────────┐    ┌────────────────┐│
│  │ Isolated       │    │ Delivery       │    │ Session        ││
│  │ Agent Runner   │    │ Dispatcher     │    │ Reaper         ││
│  │                │    │                │    │                ││
│  └────────────────┘    └────────────────┘    └────────────────┘│
│           │                     │                    │          │
│           ▼                     ▼                    ▼          │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                   Outputs                                  │  │
│  │  - Agent execution (summary/outputText)                  │  │
│  │  - Channel delivery (announce/webhook)                  │  │
│  │  - Failure notifications                                │  │
│  │  - Telemetry (tokens, model, provider)                  │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 二、任务类型系统

**文件**: `src/cron/types.ts`

```typescript
type CronSchedule =
  | { kind: "at"; at: string }                                    // 绝对时间
  | { kind: "every"; everyMs: number; anchorMs?: number }         // 固定间隔
  | { kind: "cron"; expr: string; tz?: string; staggerMs?: number }; // cron 表达式
```

### 三种调度模式

| 模式 | 适用场景 | 示例 |
|------|----------|------|
| **at** | 一次性定时任务 | `"2024-03-15 09:00"` |
| **every** | 固定间隔重复 | `everyMs: 3600000` (每小时) + `anchorMs` (对齐点) |
| **cron** | 复杂周期规则 | `"0 9 * * 1-5"` (工作日 9 点) |

**Leon 洞察**：这三种模式覆盖了**几乎所有定时任务场景**。

- `at`：一次性任务，比如"下周三下午 3 点提醒我开会"
- `every`：固定间隔，比如"每 30 分钟检查一次邮箱"
- `cron`：复杂周期，比如"每周一到周五早上 9 点"

**有意思的是 `every` 模式的 `anchorMs` 设计**：

```typescript
// schedule.ts:89-97
const anchor = Math.max(0, Math.floor(anchorRaw ?? nowMs));
if (nowMs < anchor) {
  return anchor;  // 还没到锚点，等待
}
const elapsed = nowMs - anchor;
const steps = Math.max(1, Math.floor((elapsed + everyMs - 1) / everyMs));
return anchor + steps * everyMs;
```

这个逻辑确保了**即使 Gateway 重启，也能恢复正确的调度时间**。比如 `everyMs: 3600000, anchorMs: 1710000000000`（2024年3月某日整点），无论何时重启，下一次执行总是在整点。

---

## 三、Cron 表达式解析与缓存

**文件**: `src/cron/schedule.ts`

```typescript
const CRON_EVAL_CACHE_MAX = 512;
const cronEvalCache = new Map<string, Cron>();

function resolveCachedCron(expr: string, timezone: string): Cron {
  const key = `${timezone}\u0000${expr}`;
  const cached = cronEvalCache.get(key);
  if (cached) return cached;

  // LRU 淘汰
  if (cronEvalCache.size >= CRON_EVAL_CACHE_MAX) {
    const oldest = cronEvalCache.keys().next().value;
    cronEvalCache.delete(oldest);
  }

  const next = new Cron(expr, { timezone, catch: false });
  cronEvalCache.set(key, next);
  return next;
}
```

**Leon 评价**：**卧槽，这个缓存设计很聪明**。

1. **复合 key**：`${timezone}\u0000${expr}` 用 NUL 字符分隔，防止碰撞
2. **LRU 淘汰**：缓存满了删最老的，简单有效
3. **`catch: false`**：croner 配置，不让表达式错误吞掉其他异常

**问题点**：缓存没有 TTL，如果一个 cron 表达式不再使用，它会一直占着内存。对于长期运行的 Gateway，这可能是个问题。不过考虑到 512 的上限，影响有限。

---

## 四、隔离执行架构

**文件**: `src/cron/isolated-agent/run.ts`

```typescript
export async function runCronIsolatedAgentTurn(params: {
  cfg: OpenClawConfig;
  deps: CliDeps;
  job: CronJob;
  message: string;
  abortSignal?: AbortSignal;
  sessionKey: string;
  agentId?: string;
  deliveryContract?: "cron-owned" | "shared";  // ⚠️ 关键参数
}): Promise<RunCronAgentTurnResult>
```

### SessionTarget 两种模式

| 模式 | 行为 | 适用场景 |
|------|------|----------|
| **isolated** | 每次执行创建全新会话 | 定时爬虫、数据汇总 |
| **main** | 复用主会话上下文 | 对话式任务 |

**Leon 洞察**：`sessionTarget: "isolated"` 是个**非常重要的设计决策**。

传统 cron（如 Linux cron）每次执行都是全新进程，自然隔离。但 OpenClaw 的 Agent 是会话式的——如果不隔离，第一次执行的状态会污染后续执行。

**示例**：
```json
{
  "sessionTarget": "isolated",
  "payload": {
    "message": "检查天气并推送"
  }
}
```

每次执行都会：
1. 创建新 `sessionId`
2. 清空前文上下文
3. 执行任务
4. 保留会话记录（可追溯）

### 临时重试机制（Interim Retry）

`run.ts:649-687` 有个**非常巧妙的设计**：

```typescript
// 如果第一轮只是 interim ack（比如 "on it"），自动补一枪
const shouldRetryInterimAck =
  !interimRunResult.meta?.error &&
  !interimRunResult.didSendViaMessagingTool &&
  !interimPayloadHasStructuredContent &&
  countActiveDescendantRuns(agentSessionKey) === 0 &&
  isLikelyInterimCronMessage(interimText);

if (shouldRetryInterimAck) {
  const continuationPrompt = [
    "Your previous response was only an acknowledgement...",
    "Complete the original task now.",
    "Do not send a status update like 'on it'.",
  ].join(" ");
  await runPrompt(continuationPrompt);
}
```

**Leon 评价**：这个设计**太贴心了**。

很多情况下 Agent 会先回复 "on it" 之类的 interim ack，然后才开始真正工作。对于 cron 来说，第一轮就是最后一轮——没有第二轮给你真正完成工作。

这个自动重试机制确保了：
1. 如果 Agent 只是说了 "on it"，会自动再问一次
2. 如果 Agent 已经开始工作了（有 descendant runs），不会打扰
3. 如果 Agent 真的只是完成任务（没有继续），会得到完整的输出

**踩过坑才能写出这个**。

---

## 五、交付目标解析（Delivery Plan）

**文件**: `src/cron/delivery.ts`

```typescript
export type CronDeliveryPlan = {
  mode: CronDeliveryMode;           // "none" | "announce" | "webhook"
  channel?: CronMessageChannel;     // "telegram" | "discord" | ...
  to?: string;                      // 收件人
  accountId?: string;               // 多账号场景
  source: "delivery" | "payload";   // 配置来源
  requested: boolean;               // 是否请求交付
};
```

### 优先级逻辑

```
1. delivery.mode (最高优先级)
   └─→ delivery.channel / delivery.to / delivery.accountId

2. payload.channel / payload.to
   └─→ 当 delivery 配置缺失时降级使用

3. 默认值
   └─→ channel: "last", to: undefined
```

**Leon 评价**：这个优先级设计**考虑得很周全**。

`source` 字段记录配置来源，方便调试：
- `"delivery"`：显式配置，用户明确说要发送
- `"payload"`：隐式配置，从任务描述推断

`requested` 字段是个**聪明的布尔值**：
```typescript
const requested = legacyMode === "explicit" ||
                  (legacyMode === "auto" && hasExplicitTarget);
```

只有在这些情况下才认为是"请求交付"：
- 模式是 `"explicit"`（明确要求发送）
- 或者模式是 `"auto"` 且有明确的目标（`to` 字段有值）

这避免了意外发送空消息。

---

## 六、启动恢复机制（Missed Jobs）

**文件**: `src/cron/service/ops.ts`

Gateway 重启后，可能有很多错过的任务需要执行。但全部立即执行会：
1. 消耗大量资源
2. 产生消息风暴
3. 可能触发 API 限流

**解决方案**：

```typescript
// service/state.ts:55-62
missedJobStaggerMs?: number;    // 错过任务之间的延迟
maxMissedJobsPerRestart?: number; // 最多立即执行多少个
```

**Leon 洞察**：这是一个**生产级别的考虑**。

假设你有 100 个每小时执行的任务，Gateway 停了 24 小时。重启后有 2400 个任务要执行。

如果不加控制：
- 2400 个任务几乎同时启动 → 系统崩溃
- 或者 API 限流 → 所有任务失败

**有了这个机制**：
```typescript
// 立即执行最多 N 个（比如 50 个）
const immediate = missedJobs.slice(0, maxMissedJobsPerRestart);
// 剩余的延迟重新调度
const deferred = missedJobs.slice(maxMissedJobsPerRestart);
```

`missedJobStaggerMs` 控制延迟任务之间的间隔，比如 30 秒一个，避免资源尖峰。

**这明显是作者踩过坑**——不然不会设计得这么细致。

---

## 七、会话收割机（Session Reaper）

**文件**: `src/cron/session-reaper.ts`

```typescript
const DEFAULT_RETENTION_MS = 24 * 3_600_000;  // 24 小时
const MIN_SWEEP_INTERVAL_MS = 5 * 60_000;      // 5 分钟

export async function sweepCronRunSessions(params: {
  cronConfig?: CronConfig;
  sessionStorePath: string;
  nowMs?: number;
  log: Logger;
  force?: boolean;
}): Promise<ReaperResult>
```

### 收割逻辑

1. **识别目标**：`isCronRunSessionKey(key)` → `cron:<jobId>:run:<uuid>`
2. **保留基础会话**：`cron:<jobId>` 不动，只清理 run 会话
3. **TTL 清理**：`updatedAt < now - retentionMs` 的删除
4. **节流控制**：5 分钟最多扫一次
5. **文件清理**：会话删除后，对应的 transcript 文件也归档

**Leon 评价**：这个设计**考虑得非常周到**。

```
会话层级:
cron:daily-summary          ← 基础会话（永久保留）
cron:daily-summary:run:abc ← 执行记录（24小时后清理）
cron:daily-summary:run:def ← 执行记录（24小时后清理）
```

**为什么只清理 run 会话？**
- 基础会话包含配置信息（label、model、skillsSnapshot）
- run 会话只是执行记录，价值有限

**为什么 5 分钟节流？**
- 避免每次 timer tick 都扫一遍文件
- 即使有几百个任务，5 分钟内变化也不大

**为什么保留 24 小时？**
- 用户可能想查看最近几次的执行结果
- 太久了就没意义了

---

## 八、心跳抑制策略

**文件**: `src/cron/heartbeat-policy.ts`

```typescript
export function shouldSkipHeartbeatOnlyDelivery(
  payloads: HeartbeatDeliveryPayload[],
  ackMaxChars: number,
): boolean {
  if (payloads.length === 0) return true;

  // 有媒体内容 → 不跳过
  const hasAnyMedia = payloads.some(payload =>
    (payload.mediaUrls?.length ?? 0) > 0 || Boolean(payload.mediaUrl)
  );
  if (hasAnyMedia) return false;

  // 只有 HEARTBEAT_OK → 跳过
  return payloads.some(payload => {
    const result = stripHeartbeatToken(payload.text, {
      mode: "heartbeat",
      maxAckChars: ackMaxChars,
    });
    return result.shouldSkip;
  });
}
```

**Leon 洞察**：这是个**用户体验优化**。

Cron 任务如果只是返回"✅ 任务已执行"，用户不想收到通知。但如果有实质内容（比如爬取的结果、生成的报告），就需要通知。

**判断逻辑**：
1. 没有 payloads → 跳过
2. 有媒体（图片/文件）→ 不跳过
3. 只有 `HEARTBEAT_OK` → 跳过
4. 有实质内容 → 不跳过

**这减少了大量噪音**，特别是对于高频任务（比如每 5 分钟的心跳检查）。

---

## 九、失败告警链路

**文件**: `src/cron/delivery.ts`

```typescript
type CronFailureDestination = {
  channel?: CronMessageChannel;
  to?: string;
  accountId?: string;
  mode?: "announce" | "webhook";
};
```

### 告警与主交付的分离

```typescript
// delivery.ts:204-206
if (delivery && isSameDeliveryTarget(delivery, result)) {
  return null;  // 不发送重复的失败通知
}
```

**Leon 评价**：这个**去重逻辑很重要**。

假设任务失败时：
- 主目标是发送给 Telegram 群组
- 失败目标也是发送给同一个群组

如果不检查，用户会收到两条消息：
1. 任务执行失败通知
2. 发送失败通知

**这是重复的噪音**。

**另一个细节**：`mode` 切换时自动清除 `to`：
```typescript
// delivery.ts:178-182
if (!jobToExplicitValue && globalMode !== jobMode) {
  to = undefined;  // announce 需要频道，webhook 需要 URL
}
```

因为 `announce` 的 `to` 是频道收件人（如 `-123456789`），而 `webhook` 的 `to` 是 HTTP URL。两者语义不同，切换时需要清除。

---

## 十、交错执行机制（Stagger）

**文件**: `src/cron/stagger.ts`

```typescript
export const DEFAULT_TOP_OF_HOUR_STAGGER_MS = 5 * 60 * 1000;  // 5 分钟

function isRecurringTopOfHourCronExpr(expr: string) {
  const fields = parseCronFields(expr);
  if (fields.length === 5) {
    const [minuteField, hourField] = fields;
    return minuteField === "0" && hourField.includes("*");
  }
  // ...
}
```

### 为什么需要 Stagger？

假设你有 10 个任务都是 `"0 * * * *"`（每小时整点执行）：
- 如果不交错，10 个任务同时在 `:00` 秒触发
- CPU、内存、网络同时达到峰值
- 可能触发 API 限流

**交错执行**：
```typescript
staggerMs: 300000  // 5 分钟窗口
```

每个任务会在整点后的 5 分钟内随机时间触发，均匀分散负载。

**自动检测**：
```typescript
return isRecurringTopOfHourCronExpr(expr)
  ? DEFAULT_TOP_OF_HOUR_STAGGER_MS
  : 0;
```

如果是整点任务（`0 * * * *`），自动应用 5 分钟交错。

**Leon 评价**：这是一个**工程经验的体现**。

作者意识到整点任务是一个常见模式（比如每小时汇总、每小时备份），所以默认就给它们加交错。不需要用户手动配置。

---

## 十一、存储与持久化

**文件**: `src/cron/store.ts`

```typescript
export const DEFAULT_CRON_DIR = path.join(CONFIG_DIR, "cron");
export const DEFAULT_CRON_STORE_PATH = path.join(DEFAULT_CRON_DIR, "jobs.json");

type CronStoreFile = {
  version: 1;
  jobs: CronJob[];
};
```

### 写入流程（原子性保证）

```typescript
// store.ts:91-105
const tmp = `${storePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
await fs.promises.writeFile(tmp, json, { encoding: "utf-8", mode: 0o600 });

if (previous !== null && !opts?.skipBackup) {
  const backupPath = `${storePath}.bak`;
  await fs.promises.copyFile(storePath, backupPath);
}

await renameWithRetry(tmp, storePath);
```

**Leon 洞察**：这个**原子写入**设计很标准。

1. **写临时文件**：`.tmp` 后缀
2. **备份原文件**：`.bak` 后缀
3. **重命名替换**：`rename()` 在大多数文件系统上是原子的

**Windows 兼容**：
```typescript
// store.ts:122-128
if (code === "EPERM" || code === "EEXIST") {
  await fs.promises.copyFile(src, dest);
  await fs.promises.unlink(src).catch(() => {});
  return;
}
```

Windows 的 `rename()` 不支持原子替换，所以用 `copyFile + unlink` 降级处理。

**重试机制**：
```typescript
// store.ts:108-131
for (let attempt = 0; attempt <= RENAME_MAX_RETRIES; attempt++) {
  try {
    await fs.promises.rename(src, dest);
    return;
  } catch (err) {
    if (code === "EBUSY" && attempt < RENAME_MAX_RETRIES) {
      await new Promise(resolve =>
        setTimeout(resolve, RENAME_BASE_DELAY_MS * 2 ** attempt)
      );
      continue;
    }
    // ...
  }
}
```

`EBUSY`（文件忙）时指数退避重试，最多 4 次（50ms → 100ms → 200ms → 400ms）。

**这明显是在生产环境踩过坑**。

---

## 十二、关键技术洞察

1. **三种调度模式**：at / every / cron 覆盖所有定时场景
2. **隔离执行**：`sessionTarget: "isolated"` 防止上下文污染
3. **交付目标解析**：复杂的优先级逻辑（payload → delivery → global）
4. **启动恢复**：`maxMissedJobsPerRestart` 防止启动风暴
5. **会话收割**：`session-reaper` 自动清理过期 run 会话
6. **临时重试**：interim ack 自动补枪获取完整输出
7. **心跳抑制**：`HEARTBEAT_OK` 无内容时跳过交付
8. **交错执行**：`staggerMs` 防止整点任务同时触发
9. **原子写入**：tmp 文件 + 备份 + rename 保证数据安全
10. **Cron 缓存**：512 条目 LRU 缓存，减少重复解析

---

## 十三、设计权衡

| 决策 | 选择 | 动机 | Leon 点评 |
|------|------|------|-----------|
| 调度库 | croner | 功能完善、时区支持正确 | 比 node-cron 更可靠 |
| 缓存大小 | 512 条目 | 平衡内存和命中率 | 对于个人用 Gateway 足够了 |
| 会话保留 | 24 小时 | 可查最近执行结果 | 可配置 `cron.sessionRetention` |
| 交错窗口 | 5 分钟 | 整点任务负载分散 | 可通过 `staggerMs` 调整 |
| 启动恢复 | 延迟执行 | 防止资源尖峰 | `maxMissedJobsPerRestart` 可调 |
| 文件权限 | 0o600 | 敏感信息保护 | 备份文件也需要保护 |

---

## 十四、潜在改进点

| 问题 | 建议 | 优先级 |
|------|------|--------|
| Cron 缓存无 TTL | 添加 1 小时 TTL | 低 |
| 交错执行只检测整点 | 扩展到其他高频模式 | 低 |
| 会话收割 5 分钟节流 | 可配置节流间隔 | 低 |
| 临时重试可能无限循环 | 最多重试 1 次 | 中 |
| `deliveryContract` 类型隐式 | 改为显式参数 | 低 |

---

## 十五、相关文件索引

| 组件 | 文件路径 | Leon 评价 |
|------|----------|-----------|
| CronService | `src/cron/service.ts` | 简洁的门面，逻辑分散在 ops |
| Service Ops | `src/cron/service/ops.ts` | 核心操作逻辑 |
| Service State | `src/cron/service/state.ts` | 状态结构清晰 |
| Schedule | `src/cron/schedule.ts` | croner 封装 + 缓存 |
| Isolated Run | `src/cron/isolated-agent/run.ts` | 隔离执行的核心，很长但组织良好 |
| Delivery | `src/cron/delivery.ts` | 交付目标解析很复杂 |
| Heartbeat Policy | `src/cron/heartbeat-policy.ts` | 心跳抑制逻辑 |
| Session Reaper | `src/cron/session-reaper.ts` | 会话清理机制 |
| Stagger | `src/cron/stagger.ts` | 交错执行逻辑 |
| Store | `src/cron/store.ts` | 原子写入实现 |
| Types | `src/cron/types.ts` | 类型定义完整 |

---

*文档版本：2026-03-11 | By Leon*
