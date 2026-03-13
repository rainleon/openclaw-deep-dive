# Wizard 向导系统 (Onboarding Wizard)

> "OpenClaw 的向导系统是用户首次体验的关键路径，提供 QuickStart 和 Manual 两种模式，智能检测现有配置并优雅处理迁移。风险确认文案写得非常专业——明确指出'个人代理默认信任边界'这个核心设计。网关配置自动处理 Tailscale 约束（Funnel 需要 loopback + password），完成后的孵化选项（TUI/Web/Later）给用户充分的灵活性。"

---

## 核心技术洞察

### 1. 风险确认机制

```typescript
// src/wizard/onboarding.ts
async function requireRiskAcknowledgement(params: {
  opts: OnboardOptions;
  prompter: WizardPrompter;
}) {
  if (params.opts.acceptRisk === true) {
    return;
  }

  await params.prompter.note(
    [
      "Security warning — please read.",
      "",
      "OpenClaw is a hobby project and still in beta. Expect sharp edges.",
      "By default, OpenClaw is a personal agent: one trusted operator boundary.",
      "This bot can read files and run actions if tools are enabled.",
      "A bad prompt can trick it into doing unsafe things.",
      "",
      "OpenClaw is not a hostile multi-tenant boundary by default.",
      "If multiple users can message one tool-enabled agent, they share that delegated tool authority.",
      "",
      "If you're not comfortable with security hardening and access control, don't run OpenClaw.",
      "Ask someone experienced to help before enabling tools or exposing it to the internet.",
      "",
      "Recommended baseline:",
      "- Pairing/allowlists + mention gating.",
      "- Multi-user/shared inbox: split trust boundaries (separate gateway/credentials, ideally separate OS users/hosts).",
      "- Sandbox + least-privilege tools.",
      "- Shared inboxes: isolate DM sessions (`session.dmScope: per-channel-peer`) and keep tool access minimal.",
      "- Keep secrets out of the agent's reachable filesystem.",
      "- Use the strongest available model for any bot with tools or untrusted inboxes.",
      "",
      "Run regularly:",
      "openclaw security audit --deep",
      "openclaw security audit --fix",
      "",
      "Must read: https://docs.openclaw.ai/gateway/security",
    ].join("\n"),
    "Security",
  );

  const ok = await params.prompter.confirm({
    message:
      "I understand this is personal-by-default and shared/multi-user use requires lock-down. Continue?",
    initialValue: false,
  });
  if (!ok) {
    throw new WizardCancelledError("risk not accepted");
  }
}
```

**Leon 点评**：风险确认文案设计得非常好：
1. **明确边界**：强调"个人代理默认信任边界"
2. **具体建议**：提供可操作的安全加固建议
3. **多租户警告**：明确默认不是多租户安全边界
4. **定期审计**：引导用户建立安全审计习惯

### 2. 双模式向导流程

```typescript
// src/wizard/onboarding.ts
let flow: WizardFlow =
  explicitFlow ??
  (await prompter.select({
    message: "Onboarding mode",
    options: [
      { value: "quickstart", label: "QuickStart", hint: quickstartHint },
      { value: "advanced", label: "Manual", hint: manualHint },
    ],
    initialValue: "quickstart",
  }));

// QuickStart 自动使用合理默认值
if (flow === "quickstart") {
  await prompter.note(
    [
      "Keeping your current gateway settings:",
      `Gateway port: ${quickstartGateway.port}`,
      "Gateway bind: Loopback (127.0.0.1)",
      "Gateway auth: Token (default)",
      "Tailscale exposure: Off",
      "Direct to chat channels.",
    ].join("\n"),
    "QuickStart",
  );
}
```

**Leon 点评**：双模式设计满足不同用户需求：
1. **QuickStart**：合理默认值，快速上手
2. **Manual**：完全控制，适合高级用户
3. **模式检测**：远程模式自动切换到 Manual
4. **配置保留**：检测现有配置并询问处理方式

### 3. 网关配置约束

```typescript
// src/wizard/onboarding.gateway-config.ts
// 安全约束：
// - Tailscale 要求 bind=loopback，避免同时暴露非 loopback 服务器和 tailscale serve/funnel
// - Funnel 要求 password 认证

if (tailscaleMode !== "off" && bind !== "loopback") {
  await prompter.note("Tailscale requires bind=loopback. Adjusting bind to loopback.", "Note");
  bind = "loopback";
  customBindHost = undefined;
}

if (tailscaleMode === "funnel" && authMode !== "password") {
  await prompter.note("Tailscale funnel requires password auth.", "Note");
  authMode = "password";
}

// 检测 Tailscale 二进制
let tailscaleBin: string | null = null;
if (tailscaleMode !== "off") {
  tailscaleBin = await findTailscaleBinary();
  if (!tailscaleBin) {
    await prompter.note(TAILSCALE_MISSING_BIN_NOTE_LINES.join("\n"), "Tailscale Warning");
  }
}
```

**Leon 点评**：网关配置的约束处理非常细致：
1. **自动调整**：违反约束时自动修正配置
2. **前置检测**：使用 Tailscale 前检测二进制存在
3. **用户提示**：每个调整都有明确的提示
4. **文档链接**：提供相关文档链接

### 4. 密钥输入模式

```typescript
// src/wizard/onboarding.gateway-config.ts
const tokenMode =
  flow === "quickstart" && opts.secretInputMode !== "ref"
    ? quickstartTokenRef
      ? "ref"
      : "plaintext"
    : await resolveSecretInputModeForEnvSelection({
        prompter,
        explicitMode: opts.secretInputMode,
        copy: {
          modeMessage: "How do you want to provide the gateway token?",
          plaintextLabel: "Generate/store plaintext token",
          plaintextHint: "Default",
          refLabel: "Use SecretRef",
          refHint: "Store a reference instead of plaintext",
        },
      });

if (tokenMode === "ref") {
  const resolved = await promptSecretRefForOnboarding({
    provider: "gateway-auth-token",
    config: nextConfig,
    prompter,
    preferredEnvVar: "OPENCLAW_GATEWAY_TOKEN",
    copy: {
      sourceMessage: "Where is this gateway token stored?",
      envVarPlaceholder: "OPENCLAW_GATEWAY_TOKEN",
    },
  });
  gatewayTokenInput = resolved.ref;
  gatewayToken = resolved.resolvedValue;
} else {
  // QuickStart 自动生成或使用环境变量
  gatewayToken =
    (quickstartTokenString ?? normalizeGatewayTokenInput(process.env.OPENCLAW_GATEWAY_TOKEN)) ||
    randomToken();
  gatewayTokenInput = gatewayToken;
}
```

**Leon 点评**：密钥输入模式灵活且安全：
1. **SecretRef 支持**：可以引用环境变量或密钥管理器
2. **QuickStart 优化**：自动生成随机 token
3. **环境变量回退**：优先使用环境变量
4. **统一接口**：token 和 password 使用相同的输入逻辑

### 5. 孵化选择

```typescript
// src/wizard/onboarding.finalize.ts
if (hasBootstrap) {
  await prompter.note(
    [
      "This is the defining action that makes your agent you.",
      "Please take your time.",
      "The more you tell it, the better the experience will be.",
      'We will send: "Wake up, my friend!"',
    ].join("\n"),
    "Start TUI (best option!)",
  );
}

hatchChoice = await prompter.select({
  message: "How do you want to hatch your bot?",
  options: [
    { value: "tui", label: "Hatch in TUI (recommended)" },
    { value: "web", label: "Open the Web UI" },
    { value: "later", label: "Do this later" },
  ],
  initialValue: "tui",
});

if (hatchChoice === "tui") {
  restoreTerminalState("pre-onboarding tui", { resumeStdinIfPaused: true });
  await runTui({
    url: links.wsUrl,
    token: settings.authMode === "token" ? settings.gatewayToken : undefined,
    password: settings.authMode === "password" ? resolvedGatewayPassword : "",
    deliver: false,
    message: hasBootstrap ? "Wake up, my friend!" : undefined,
  });
  launchedTui = true;
}
```

**Leon 点评**：孵化选择提供了完整的用户体验：
1. **情感化文案**："Wake up, my friend!" 增加仪式感
2. **推荐 TUI**：终端界面是最佳孵化方式
3. **Web 回退**：浏览器支持时打开 Web UI
4. **延后选项**：允许用户稍后孵化

---

## 一、向导架构总览

### 核心流程

```
Onboarding Wizard
├── 风险确认（Risk Acknowledgement）
├── 配置处理（Config Handling）
│   ├── 现有配置检测
│   ├── 配置验证
│   └── 重置/更新/保留
├── 模式选择（Flow Selection）
│   ├── QuickStart
│   └── Manual (Advanced)
├── 网关配置（Gateway Config）
│   ├── 端口（Port）
│   ├── 绑定（Bind）
│   ├── 认证（Auth）
│   └── Tailscale
├── 认证设置（Auth Setup）
│   ├── Provider 选择
│   ├── API Key / OAuth
│   └── 模型选择
├── 渠道设置（Channel Setup）
├── 搜索设置（Search Setup）
├── 技能设置（Skills Setup）
└── 完成（Finalize）
    ├── 服务安装
    ├── 健康检查
    └── 孵化选择
```

### QuickStart vs Manual

| 特性 | QuickStart | Manual |
|------|-----------|--------|
| 端口 | 自动检测 | 手动输入 |
| 绑定 | Loopback | 可选 |
| 认证 | Token | Token/Password |
| Tailscale | Off | 可选 |
| 渠道 | 自动 | 手动 |
| 交互 | 最少 | 完整 |

---

## 二、提示器接口

### 类型定义

```typescript
export type WizardPrompter = {
  intro: (title: string) => Promise<void>;
  outro: (message: string) => Promise<void>;
  note: (message: string, title?: string) => Promise<void>;
  select: <T>(params: WizardSelectParams<T>) => Promise<T>;
  multiselect: <T>(params: WizardMultiSelectParams<T>) => Promise<T[]>;
  text: (params: WizardTextParams) => Promise<string>;
  confirm: (params: WizardConfirmParams) => Promise<boolean>;
  progress: (label: string) => WizardProgress;
};
```

### 选择参数

```typescript
export type WizardSelectParams<T = string> = {
  message: string;
  options: Array<{
    value: T;
    label: string;
    hint?: string;
  }>;
  initialValue?: T;
};
```

### 文本参数

```typescript
export type WizardTextParams = {
  message: string;
  initialValue?: string;
  placeholder?: string;
  validate?: (value: string) => string | undefined;
};
```

---

## 三、配置处理

### 现有配置检测

```typescript
const snapshot = await readConfigFileSnapshot();
let baseConfig: OpenClawConfig = snapshot.valid
  ? (snapshot.exists ? snapshot.config : {})
  : {};

if (snapshot.exists && !snapshot.valid) {
  await prompter.note(onboardHelpers.summarizeExistingConfig(baseConfig), "Invalid config");
  if (snapshot.issues.length > 0) {
    await prompter.note(
      snapshot.issues.map((iss) => `- ${iss.path}: ${iss.message}`).join("\n"),
      "Config issues",
    );
  }
  await prompter.outro("Config invalid. Run `openclaw doctor` to repair it.");
  runtime.exit(1);
}
```

### 配置操作选择

```typescript
if (snapshot.exists) {
  await prompter.note(onboardHelpers.summarizeExistingConfig(baseConfig), "Existing config detected");

  const action = await prompter.select({
    message: "Config handling",
    options: [
      { value: "keep", label: "Use existing values" },
      { value: "modify", label: "Update values" },
      { value: "reset", label: "Reset" },
    ],
  });

  if (action === "reset") {
    const resetScope = await prompter.select({
      message: "Reset scope",
      options: [
        { value: "config", label: "Config only" },
        { value: "config+creds+sessions", label: "Config + creds + sessions" },
        { value: "full", label: "Full reset (config + creds + sessions + workspace)" },
      ],
    });
    await handleReset(resetScope, workspaceDir, runtime);
    baseConfig = {};
  }
}
```

---

## 四、网关配置

### 绑定模式

| 模式 | 描述 | 地址 |
|------|------|------|
| loopback | 仅本机 | 127.0.0.1 |
| lan | 局域网 | 0.0.0.0 |
| tailnet | Tailscale 网络 | Tailscale IP |
| auto | 自动回退 | Loopback → LAN |
| custom | 自定义 IP | 用户指定 |

### 认证模式

| 模式 | 描述 | 使用场景 |
|------|------|----------|
| token | 令牌认证 | 推荐，本地+远程 |
| password | 密码认证 | Tailscale Funnel |

### Tailscale 模式

| 模式 | 描述 | 要求 |
|------|------|------|
| off | 关闭 | - |
| serve | Serve 暴露 | bind=loopback |
| funnel | Funnel 暴露 | bind=loopback + password |

---

## 五、认证设置

### Provider 分类

```typescript
const authChoice = await promptAuthChoiceGrouped({
  prompter,
  store: authStore,
  includeSkip: true,
});
```

分类包括：
- **Quickstart providers**：快速配置（OpenAI、Anthropic）
- **OAuth providers**：OAuth 流程（GitHub Copilot、Google）
- **API key providers**：API Key（OpenAI、Anthropic、Qwen）
- **Skip**：跳过认证

### 模型选择

```typescript
const modelSelection = await promptDefaultModel({
  config: nextConfig,
  prompter,
  allowKeep: true,
  ignoreAllowlist: true,
  includeVllm: true,
  preferredProvider: resolvePreferredProviderForAuthChoice(authChoice),
});
```

---

## 六、完成流程

### 服务安装

```typescript
const daemonRuntime = await prompter.select({
  message: "Gateway service runtime",
  options: GATEWAY_DAEMON_RUNTIME_OPTIONS,
  initialValue: opts.daemonRuntime ?? DEFAULT_GATEWAY_DAEMON_RUNTIME,
});

const service = resolveGatewayService();
const loaded = await service.isLoaded({ env: process.env });

if (loaded) {
  const action = await prompter.select({
    message: "Gateway service already installed",
    options: [
      { value: "restart", label: "Restart" },
      { value: "reinstall", label: "Reinstall" },
      { value: "skip", label: "Skip" },
    ],
  });
}
```

### 健康检查

```typescript
if (!opts.skipHealth) {
  const probeLinks = resolveControlUiLinks({
    bind: nextConfig.gateway?.bind ?? "loopback",
    port: settings.port,
    customBindHost: nextConfig.gateway?.customBindHost,
    basePath: undefined,
  });

  await waitForGatewayReachable({
    url: probeLinks.wsUrl,
    token: settings.gatewayToken,
    deadlineMs: 15_000,
  });

  try {
    await healthCommand({ json: false, timeoutMs: 10_000 }, runtime);
  } catch (err) {
    runtime.error(formatHealthCheckFailure(err));
    await prompter.note(
      [
        "Docs:",
        "https://docs.openclaw.ai/gateway/health",
        "https://docs.openclaw.ai/gateway/troubleshooting",
      ].join("\n"),
      "Health check help",
    );
  }
}
```

---

## 七、技术权衡

### 1. QuickStart vs Manual

| 方案 | 优势 | 劣势 |
|------|------|------|
| QuickStart | 快速上手、合理默认 | 灵活性低 |
| Manual | 完全控制 | 复杂度高 |

**选择**：两者都支持
**原因**：不同用户有不同需求，新手想要快速开始，高级用户想要完全控制

### 2. 自动检测 vs 手动输入

| 方案 | 优势 | 劣势 |
|------|------|------|
| 自动检测 | 减少输入、智能 | 可能检测错误 |
| 手动输入 | 精确控制 | 输入繁琐 |

**选择**：自动检测 + 手动确认
**原因**：平衡便利性和准确性

### 3. 配置覆盖 vs 配置合并

| 方案 | 优势 | 劣势 |
|------|------|------|
| 配置覆盖 | 简单、可预测 | 丢失手动配置 |
| 配置合并 | 保留手动配置 | 可能产生冲突 |

**选择**：用户选择
**原因**：让用户决定如何处理现有配置

### 4. TUI vs Web 孵化

| 方案 | 优势 | 劣势 |
|------|------|------|
| TUI | 最佳体验、仪式感 | 需要终端 |
| Web | 跨平台、易访问 | 体验稍差 |

**选择**：推荐 TUI，提供 Web 回退
**原因**：TUI 提供最佳孵化体验，Web 为无终端环境提供替代

---

*本文档基于源码分析，涵盖向导系统的架构、风险确认、双模式流程、网关配置、认证设置、完成流程以及技术权衡。*
