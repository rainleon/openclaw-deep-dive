# Commands 命令系统 (Commands System)

> "OpenClaw 的命令系统是整个 CLI 的核心调度中心，70,000+ 行代码支撑着从 agent 运行到配置诊断的完整生命周期。agent.ts 作为最复杂的命令，处理 ACP 集成、模型回退、会话管理、技能快照等全套流程。health.ts 提供优雅的健康检查抽象，通过 channel plugin 机制统一各平台探测。doctor-config-flow.ts 将诊断流程图化，近 2000 行代码处理配置验证和问题修复。卧槽，这个 senderIsOwner 分层设计太重要了——agentCommand 默认为 true，agentCommandFromIngress 必须显式声明，防止网络调用者意外继承本地权限。"

---

## 核心技术洞察

### 1. Agent 命令双入口设计

```typescript
// src/commands/agent.ts
export async function agentCommand(
  opts: AgentCommandOpts,
  runtime: RuntimeEnv = defaultRuntime,
  deps: CliDeps = createDefaultDeps(),
) {
  return await agentCommandInternal(
    {
      ...opts,
      // agentCommand 是可信操作者入口，用于 CLI/本地流程
      // Ingress 调用者必须通过 agentCommandFromIngress 显式选择所有者语义
      // 防止网络面向路径意外继承本地默认值
      senderIsOwner: opts.senderIsOwner ?? true,
    },
    runtime,
    deps,
  );
}

export async function agentCommandFromIngress(
  opts: AgentCommandIngressOpts,
  runtime: RuntimeEnv = defaultRuntime,
  deps: CliDeps = createDefaultDeps(),
) {
  if (typeof opts.senderIsOwner !== "boolean") {
    // HTTP/WS ingress 必须在边界显式声明信任级别
    // 保持网络面向调用者静默继承本地受信默认值
    throw new Error("senderIsOwner must be explicitly set for ingress agent runs.");
  }
  return await agentCommandInternal(
    {
      ...opts,
      senderIsOwner: opts.senderIsOwner,
    },
    runtime,
    deps,
  );
}
```

**Leon 点评**：双入口设计提供了安全分层：
1. **默认安全**：CLI 入口默认为 owner，符合本地操作预期
2. **显式声明**：网络入口必须显式声明信任级别，防止权限泄露
3. **类型分离**：两个不同的类型确保编译时检查
4. **文档化意图**：注释清晰说明了安全边界

### 2. ACP 可见文本累加器

```typescript
// src/commands/agent.ts
function createAcpVisibleTextAccumulator() {
  let pendingSilentPrefix = "";
  let visibleText = "";
  const startsWithWordChar = (chunk: string): boolean => /^[\p{L}\p{N}]/u.test(chunk);

  const resolveNextCandidate = (base: string, chunk: string): string => {
    if (!base) {
      return chunk;
    }
    if (
      isSilentReplyText(base, SILENT_REPLY_TOKEN) &&
      !chunk.startsWith(base) &&
      startsWithWordChar(chunk)
    ) {
      return chunk;
    }
    // 某些 ACP 后端即使在 text_delta 风格钩子上也发出累积快照
    // 只有当它们严格扩展缓冲文本时才接受
    if (chunk.startsWith(base) && chunk.length > base.length) {
      return chunk;
    }
    return `${base}${chunk}`;
  };

  const mergeVisibleChunk = (base: string, chunk: string): { text: string; delta: string } => {
    if (!base) {
      return { text: chunk, delta: chunk };
    }
    if (chunk.startsWith(base) && chunk.length > base.length) {
      const delta = chunk.slice(base.length);
      return { text: chunk, delta };
    }
    return {
      text: `${base}${chunk}`,
      delta: chunk,
    };
  };

  return {
    consume(chunk: string): { text: string; delta: string } | null {
      if (!chunk) {
        return null;
      }

      if (!visibleText) {
        const leadCandidate = resolveNextCandidate(pendingSilentPrefix, chunk);
        const trimmedLeadCandidate = leadCandidate.trim();
        if (
          isSilentReplyText(trimmedLeadCandidate, SILENT_REPLY_TOKEN) ||
          isSilentReplyPrefixText(trimmedLeadCandidate, SILENT_REPLY_TOKEN)
        ) {
          pendingSilentPrefix = leadCandidate;
          return null;
        }
        if (pendingSilentPrefix) {
          pendingSilentPrefix = "";
          visibleText = leadCandidate;
          return {
            text: visibleText,
            delta: leadCandidate,
          };
        }
      }

      const nextVisible = mergeVisibleChunk(visibleText, chunk);
      visibleText = nextVisible.text;
      return nextVisible.delta ? nextVisible : null;
    },
    finalize(): string {
      return visibleText.trim();
    },
    finalizeRaw(): string {
      return visibleText;
    },
  };
}
```

**Leon 点评**：文本累加器处理了复杂的 ACP 流式输出：
1. **静默前缀处理**：过滤掉 `SILENT_REPLY_TOKEN` 前缀
2. **增量检测**：区分累积快照和增量更新
3. **Unicode 支持**：使用 `\p{L}\p{N}` 匹配任何语言的字母数字
4. **双重finalize**：提供原始和修剪后的版本

### 3. Health Check 抽象层

```typescript
// src/commands/health.ts
export async function getHealthSnapshot(params?: {
  timeoutMs?: number;
  probe?: boolean;
}): Promise<HealthSummary> {
  const timeoutMs = params?.timeoutMs;
  const cfg = loadConfig();
  const { defaultAgentId, ordered } = resolveAgentOrder(cfg);
  const channelBindings = buildChannelAccountBindings(cfg);

  // 为每个 channel plugin 探测账户状态
  for (const plugin of listChannelPlugins()) {
    channelLabels[plugin.id] = plugin.meta.label ?? plugin.id;
    const accountIds = plugin.config.listAccountIds(cfg);
    const defaultAccountId = resolveChannelDefaultAccountId({
      plugin,
      cfg,
      accountIds,
    });

    for (const accountId of accountIdsToProbe) {
      const account = plugin.config.resolveAccount(cfg, accountId);
      const enabled = plugin.config.isEnabled
        ? plugin.config.isEnabled(account, cfg)
        : isAccountEnabled(account);
      const configured = plugin.config.isConfigured
        ? await plugin.config.isConfigured(account, cfg)
        : true;

      let probe: unknown;
      if (enabled && configured && doProbe && plugin.status?.probeAccount) {
        try {
          probe = await plugin.status.probeAccount({
            account,
            timeoutMs: cappedTimeout,
            cfg,
          });
        } catch (err) {
          probe = { ok: false, error: formatErrorMessage(err) };
        }
      }

      const summary = plugin.status?.buildChannelSummary
        ? await plugin.status.buildChannelSummary({
            account,
            cfg,
            defaultAccountId: accountId,
            snapshot,
          })
        : undefined;
    }
  }

  return summary;
}
```

**Leon 点评**：Health Check 设计得非常优雅：
1. **Plugin 抽象**：通过 channel plugin 统一不同平台
2. **可选探测**：`isConfigured`、`isEnabled`、`probeAccount` 都是可选的
3. **错误容错**：探测失败不影响其他 channel
4. **超时控制**：每个探测都有独立的超时限制

### 4. Auth Choice 处理链

```typescript
// src/commands/auth-choice.apply.ts
export async function applyAuthChoice(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult> {
  const handlers: Array<(p: ApplyAuthChoiceParams) => Promise<ApplyAuthChoiceResult | null>> = [
    applyAuthChoiceAnthropic,
    applyAuthChoiceVllm,
    applyAuthChoiceOpenAI,
    applyAuthChoiceOAuth,
    applyAuthChoiceApiProviders,
    applyAuthChoiceMiniMax,
    applyAuthChoiceGitHubCopilot,
    applyAuthChoiceGoogleGeminiCli,
    applyAuthChoiceCopilotProxy,
    applyAuthChoiceQwenPortal,
    applyAuthChoiceXAI,
    applyAuthChoiceVolcengine,
    applyAuthChoiceBytePlus,
  ];

  for (const handler of handlers) {
    const result = await handler(params);
    if (result) {
      return result;
    }
  }

  return { config: params.config };
}
```

**Leon 点评**：责任链模式处理认证选择：
1. **优先级顺序**：Anthropic > Vllm > OpenAI > OAuth > ...
2. **短路返回**：第一个非 null 结果立即返回
3. **可扩展**：添加新 provider 只需在数组中加入新 handler
4. **统一接口**：所有 handler 遵循相同的函数签名

### 5. Doctor Config Flow 状态机

```typescript
// src/commands/doctor-config-flow.ts
type ConfigFlowState =
  | { type: "check_missing_accounts" }
  | { type: "check_default_bindings" }
  | { type: "check_dangerous_matching" }
  | { type: "check_tools_policy" }
  | { type: "check_pairing_state" }
  | { type: "complete" };

async function runDoctorConfigFlow(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
}): Promise<DoctorResult[]> {
  const issues: DoctorResult[] = [];
  let state: ConfigFlowState = { type: "check_missing_accounts" };

  while (state.type !== "complete") {
    switch (state.type) {
      case "check_missing_accounts":
        const missingAccounts = await checkMissingAccounts(params.cfg);
        if (missingAccounts.length > 0) {
          issues.push(...missingAccounts);
        }
        state = { type: "check_default_bindings" };
        break;

      case "check_default_bindings":
        const bindingIssues = await checkDefaultBindings(params.cfg);
        if (bindingIssues.length > 0) {
          issues.push(...bindingIssues);
        }
        state = { type: "check_dangerous_matching" };
        break;

      case "check_dangerous_matching":
        const dangerousIssues = await checkDangerousMatching(params.cfg);
        if (dangerousIssues.length > 0) {
          issues.push(...dangerousIssues);
        }
        state = { type: "check_tools_policy" };
        break;

      // ... 更多状态
    }
  }

  return issues;
}
```

**Leon 点评**：诊断流程使用状态机模式：
1. **线性流程**：按顺序检查各个配置方面
2. **问题累积**：收集所有问题而不是遇到第一个就停止
3. **状态转移**：每个检查完成后转移到下一个状态
4. **可扩展**：添加新检查只需添加新的状态和 case 分支

---

## 一、命令系统架构总览

### 核心组件

```
Commands System
├── Agent Commands（Agent 命令）
│   ├── agent.ts - 主入口
│   ├── run-context.ts - 运行上下文
│   ├── delivery.ts - 结果交付
│   ├── session.ts - 会话解析
│   └── session-store.ts - 会话存储
├── Health Commands（健康检查）
│   ├── health.ts - 主入口
│   ├── health-style.ts - 样式格式化
│   └── probe integration - 探测集成
├── Doctor Commands（诊断）
│   ├── doctor.ts - 主入口
│   ├── doctor-config-flow.ts - 配置流程
│   ├── doctor-state-integrity.ts - 状态完整性
│   ├── doctor-auth.ts - 认证诊断
│   ├── doctor-sandbox.ts - 沙箱诊断
│   └── doctor-gateway-health.ts - 网关健康
├── Auth Commands（认证）
│   ├── auth-choice.apply.ts - 应用选择
│   ├── auth-choice.api-key.ts - API Key
│   ├── auth-choice.apply.oauth.ts - OAuth
│   └── provider-specific.ts - 各提供商特定
├── Status Commands（状态）
│   ├── status.ts - 主入口
│   ├── status.command.ts - 命令格式
│   └── status-all/ - 全部状态
├── Onboard Commands（入门）
│   ├── onboard-custom.ts - 自定义
│   ├── onboard-auth.ts - 认证
│   ├── onboard-channels.ts - 渠道
│   └── onboard-skills.ts - 技能
└── Utility Commands（工具）
    ├── cleanup-plan.ts - 清理计划
    ├── gateway-install-token.ts - 网关令牌
    └── vllm-setup.ts - Vllm 设置
```

### 命令分类

| 分类 | 命令 | 文件数 | 核心职责 |
|------|------|--------|----------|
| Agent | agent, agents.* | ~15 | Agent 生命周期管理 |
| Health | health | 3 | 系统健康检查 |
| Doctor | doctor* | ~12 | 诊断和修复 |
| Auth | auth-choice* | ~20 | 认证配置 |
| Status | status* | ~8 | 状态报告 |
| Onboard | onboard* | ~10 | 新用户引导 |
| Config | configure* | ~5 | 配置管理 |
| Utility | * | ~15 | 辅助工具 |

---

## 二、类型系统

### Agent 命令选项

```typescript
export type AgentCommandOpts = {
  message: string;
  to?: string;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  thinking?: string;
  thinkingOnce?: string;
  verbose?: string;
  timeout?: number;
  deliver?: boolean;
  images?: string[];
  clientTools?: Record<string, unknown>;
  lane?: string;
  extraSystemPrompt?: string;
  inputProvenance?: string;
  // ... 更多选项
};

export type AgentCommandIngressOpts = AgentCommandOpts & {
  senderIsOwner: boolean;  // 必须显式设置
};
```

### Health 摘要

```typescript
export type HealthSummary = {
  ok: true;
  ts: number;
  durationMs: number;
  channels: Record<string, ChannelHealthSummary>;
  channelOrder: string[];
  channelLabels: Record<string, string>;
  heartbeatSeconds: number;
  defaultAgentId: string;
  agents: AgentHealthSummary[];
  sessions: {
    path: string;
    count: number;
    recent: Array<{
      key: string;
      updatedAt: number | null;
      age: number | null;
    }>;
  };
};
```

### Doctor 结果

```typescript
export type DoctorResult = {
  type: "error" | "warning" | "info";
  scope: string;
  message: string;
  fix?: () => Promise<void>;
  docs?: string;
};
```

### Auth 选择

```typescript
export type AuthChoice =
  | { type: "anthropic"; model?: string }
  | { type: "openai"; model?: string }
  | { type: "oauth"; provider: string }
  | { type: "api-key"; provider: string; key?: string }
  | { type: "skip" };
```

---

## 三、Agent 命令执行流程

### 准备阶段

```typescript
async function prepareAgentCommandExecution(
  opts: AgentCommandOpts & { senderIsOwner: boolean },
  runtime: RuntimeEnv,
) {
  const message = opts.message ?? "";
  if (!message.trim()) {
    throw new Error("Message (--message) is required");
  }

  const loadedRaw = loadConfig();
  const { resolvedConfig: cfg, diagnostics } = await resolveCommandSecretRefsViaGateway({
    config: loadedRaw,
    commandName: "agent",
    targetIds: getAgentRuntimeCommandSecretTargetIds(),
  });

  const sessionResolution = resolveSession({
    cfg,
    to: opts.to,
    sessionId: opts.sessionId,
    sessionKey: opts.sessionKey,
    agentId: agentIdOverride,
  });

  const workspace = await ensureAgentWorkspace({
    dir: workspaceDirRaw,
    ensureBootstrapFiles: !agentCfg?.skipBootstrap,
  });

  return {
    body,
    cfg,
    sessionId,
    sessionKey,
    sessionEntry,
    workspaceDir,
    agentDir,
    runId,
    acpManager,
    acpResolution,
  };
}
```

### 执行阶段

```typescript
async function agentCommandInternal(
  opts: AgentCommandOpts & { senderIsOwner: boolean },
  runtime: RuntimeEnv = defaultRuntime,
  deps: CliDeps = createDefaultDeps(),
) {
  const prepared = await prepareAgentCommandExecution(opts, runtime);

  // ACP 快速路径
  if (acpResolution?.kind === "ready" && sessionKey) {
    const visibleTextAccumulator = createAcpVisibleTextAccumulator();
    await acpManager.runTurn({
      cfg,
      sessionKey,
      text: body,
      mode: "prompt",
      requestId: runId,
      signal: opts.abortSignal,
      onEvent: (event) => {
        if (event.type === "text_delta") {
          const visibleUpdate = visibleTextAccumulator.consume(event.text);
          if (visibleUpdate) {
            emitAgentEvent({
              runId,
              stream: "assistant",
              data: {
                text: visibleUpdate.text,
                delta: visibleUpdate.delta,
              },
            });
          }
        }
      },
    });
    const finalText = visibleTextAccumulator.finalize();
    return await deliverAgentCommandResult({ ... });
  }

  // 嵌入式 Pi Agent 路径
  const fallbackResult = await runWithModelFallback({
    cfg,
    provider,
    model,
    runId,
    agentDir,
    fallbacksOverride: effectiveFallbacksOverride,
    run: (providerOverride, modelOverride, runOptions) => {
      return runAgentAttempt({
        providerOverride,
        modelOverride,
        cfg,
        sessionEntry,
        sessionId,
        sessionKey,
        // ...
      });
    },
  });

  return await deliverAgentCommandResult({ ... });
}
```

### 会话存储更新

```typescript
async function updateSessionStoreAfterAgentRun(params: {
  cfg: OpenClawConfig;
  contextTokensOverride?: number;
  sessionId: string;
  sessionKey: string;
  storePath: string;
  sessionStore: Record<string, SessionEntry>;
  defaultProvider: string;
  defaultModel: string;
  fallbackProvider: string;
  fallbackModel: string;
  result: AgentRunResult;
}) {
  const entry = params.sessionStore[params.sessionKey];
  if (!entry) {
    return;
  }

  const updatedEntry: SessionEntry = {
    ...entry,
    contextTokens: params.contextTokensOverride ?? params.result.meta.contextTokens,
    model: params.fallbackModel,
    modelProvider: params.fallbackProvider,
    updatedAt: Date.now(),
  };

  // 记录 fallback 通知
  if (params.fallbackProvider !== params.defaultProvider || params.fallbackModel !== params.defaultModel) {
    updatedEntry.fallbackNoticeSelectedModel = `${params.defaultProvider}/${params.defaultModel}`;
    updatedEntry.fallbackNoticeActiveModel = `${params.fallbackProvider}/${params.fallbackModel}`;
    updatedEntry.fallbackNoticeReason = params.result.meta.fallbackReason;
  }

  await persistSessionEntry({
    sessionStore: params.sessionStore,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    entry: updatedEntry,
  });
}
```

---

## 四、Health Check 系统

### Channel Plugin 接口

```typescript
export type ChannelPlugin = {
  id: string;
  meta: {
    label: string;
    // ...
  };
  config: {
    listAccountIds(cfg: OpenClawConfig): string[];
    resolveAccount(cfg: OpenClawConfig, accountId: string): unknown;
    isEnabled?(account: unknown, cfg: OpenClawConfig): boolean;
    isConfigured?(account: unknown, cfg: OpenClawConfig): Promise<boolean>;
  };
  status?: {
    probeAccount?(params: {
      account: unknown;
      timeoutMs: number;
      cfg: OpenClawConfig;
    }): Promise<unknown>;
    buildChannelSummary?(params: {
      account: unknown;
      cfg: OpenClawConfig;
      defaultAccountId: string;
      snapshot: ChannelAccountSnapshot;
    }): Promise<ChannelHealthSummary>;
    logSelfId?(params: {
      account: unknown;
      cfg: OpenClawConfig;
      runtime: RuntimeEnv;
      includeChannelPrefix: boolean;
    }): void;
  };
};
```

### 探测流程

```typescript
for (const plugin of listChannelPlugins()) {
  const accountIds = plugin.config.listAccountIds(cfg);
  const defaultAccountId = resolveChannelDefaultAccountId({
    plugin,
    cfg,
    accountIds,
  });

  for (const accountId of accountIdsToProbe) {
    const account = plugin.config.resolveAccount(cfg, accountId);
    const enabled = plugin.config.isEnabled
      ? plugin.config.isEnabled(account, cfg)
      : isAccountEnabled(account);
    const configured = plugin.config.isConfigured
      ? await plugin.config.isConfigured(account, cfg)
      : true;

    let probe: unknown;
    if (enabled && configured && doProbe && plugin.status?.probeAccount) {
      try {
        probe = await plugin.status.probeAccount({
          account,
          timeoutMs: cappedTimeout,
          cfg,
        });
      } catch (err) {
        probe = { ok: false, error: formatErrorMessage(err) };
      }
    }

    const summary = plugin.status?.buildChannelSummary
      ? await plugin.status.buildChannelSummary({
          account,
          cfg,
          defaultAccountId: accountId,
          snapshot,
        })
      : undefined;
  }
}
```

---

## 五、Doctor 诊断系统

### 配置流程检查

```typescript
type ConfigCheck = {
  name: string;
  check: (cfg: OpenClawConfig) => Promise<DoctorResult[]>;
};

const CONFIG_CHECKS: ConfigCheck[] = [
  {
    name: "missing_accounts",
    check: checkMissingAccounts,
  },
  {
    name: "default_bindings",
    check: checkDefaultBindings,
  },
  {
    name: "dangerous_matching",
    check: checkDangerousMatching,
  },
  {
    name: "tools_policy",
    check: checkToolsPolicy,
  },
  {
    name: "pairing_state",
    check: checkPairingState,
  },
];

async function runDoctorConfigFlow(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
}): Promise<DoctorResult[]> {
  const issues: DoctorResult[] = [];

  for (const { name, check } of CONFIG_CHECKS) {
    const checkIssues = await check(params.cfg);
    issues.push(...checkIssues);
  }

  return issues;
}
```

### 诊断结果格式化

```typescript
export function formatDoctorResult(result: DoctorResult): string {
  const icon = result.type === "error" ? "❌" : result.type === "warning" ? "⚠️" : "ℹ️";
  const scope = result.scope ? `[${result.scope}]` : "";
  const message = `${icon} ${scope} ${result.message}`;
  const docs = result.docs ? `\n  Docs: ${result.docs}` : "";
  return `${message}${docs}`;
}
```

---

## 六、技术权衡

### 1. 双入口 vs 单入口

| 方案 | 优势 | 劣势 |
|------|------|------|
| 双入口 | 安全边界清晰、类型安全 | 代码重复 |
| 单入口 + 标志 | 简洁 | 容易遗漏检查 |

**选择**：双入口
**原因**：安全是第一优先级，代码重复可以通过内部函数解决

### 2. 状态机 vs 链式调用

| 方案 | 优势 | 劣势 |
|------|------|------|
| 状态机 | 流程清晰、易调试 | 代码冗长 |
| 链式调用 | 简洁 | 难以跟踪状态 |

**选择**：状态机
**原因**：诊断流程复杂，需要清晰的状态跟踪

### 3. Plugin 抽象 vs 直接实现

| 方案 | 优势 | 劣势 |
|------|------|------|
| Plugin 抽象 | 统一接口、易扩展 | 间接调用 |
| 直接实现 | 性能高、直接 | 难以维护 |

**选择**：Plugin 抽象
**原因**：支持多个平台，统一接口降低复杂度

### 4. 累加器 vs 直接输出

| 方案 | 优势 | 劣势 |
|------|------|------|
| 累加器 | 灵活处理、支持过滤 | 内存开销 |
| 直接输出 | 简单、高效 | 难以后处理 |

**选择**：累加器
**原因**：需要处理静默前缀、增量检测等复杂逻辑

---

*本文档基于源码分析，涵盖命令系统的架构、Agent 命令执行、Health Check、Doctor 诊断、Auth Choice 以及技术权衡。*
