# Providers AI 提供商集成

> "OpenClaw的提供商集成设计得太优雅了。GitHub Copilot使用设备流OAuth，完美避免了客户端密钥暴露；Qwen Portal实现了标准的RFC 6749 refresh token机制；模型定义系统让新的Copilot模型可以无缝集成。卧槽，这个OAuth刷新逻辑考虑得太周全了——400错误时提示重新认证，access_token缺失时抛出明确错误，expires_in验证确保时间戳正确。这种设计让多个AI提供商的集成既安全又可维护。"

---

## 核心技术洞察

### 1. GitHub Copilot 设备流 OAuth

```typescript
// src/providers/github-copilot-auth.ts
const CLIENT_ID = "Iv1.b507a08c87ecfe98";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

async function requestDeviceCode(params: { scope: string }): Promise<DeviceCodeResponse> {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    scope: params.scope,
  });

  const res = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!res.ok) {
    throw new Error(`GitHub device code failed: HTTP ${res.status}`);
  }

  const json = parseJsonResponse<DeviceCodeResponse>(await res.json());
  if (!json.device_code || !json.user_code || !json.verification_uri) {
    throw new Error("GitHub device code response missing fields");
  }
  return json;
}
```

**Leon点评**：GitHub设备流OAuth是安全的典范：
1. **无客户端密钥**：设备流不需要客户端密钥，避免暴露
2. **用户友好**：用户在浏览器中授权，CLI只显示代码
3. **轮询机制**：自动轮询直到用户完成授权
4. **错误处理**：处理授权pending、slow_down、expired、access_denied等各种情况

这种设计让CLI应用可以安全地使用OAuth，而不需要管理客户端密钥。

### 2. 轮询令牌获取

```typescript
async function pollForAccessToken(params: {
  deviceCode: string;
  intervalMs: number;
  expiresAt: number;
}): Promise<string> {
  const bodyBase = new URLSearchParams({
    client_id: CLIENT_ID,
    device_code: params.deviceCode,
    grant_type: "urn:ietf:params:oauth-grant-type:device_code",
  });

  while (Date.now() < params.expiresAt) {
    const res = await fetch(ACCESS_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: bodyBase,
    });

    if (!res.ok) {
      throw new Error(`GitHub device token failed: HTTP ${res.status}`);
    }

    const json = parseJsonResponse<DeviceTokenResponse>(await res.json());
    if ("access_token" in json && typeof json.access_token === "string") {
      return json.access_token;
    }

    const err = "error" in json ? json.error : "unknown";
    if (err === "authorization_pending") {
      await new Promise((r) => setTimeout(r, params.intervalMs));
      continue;
    }
    if (err === "slow_down") {
      await new Promise((r) => setTimeout(r, params.intervalMs + 2000));
      continue;
    }
    if (err === "expired_token") {
      throw new Error("GitHub device code expired; run login again");
    }
    if (err === "access_denied") {
      throw new Error("GitHub login cancelled");
    }
    throw new Error(`GitHub device flow error: ${err}`);
  }

  throw new Error("GitHub device code expired; run login again");
}
```

**Leon点评**：轮询逻辑处理了OAuth设备流的所有状态：
1. **authorization_pending**：用户还未授权，继续轮询
2. **slow_down**：GitHub要求减慢轮询速度
3. **expired_token**：设备码过期，提示用户重新登录
4. **access_denied**：用户拒绝授权
5. **成功**：返回access_token

### 3. Qwen Portal OAuth 刷新

```typescript
// src/providers/qwen-portal-oauth.ts
const QWEN_OAUTH_TOKEN_ENDPOINT = `https://chat.qwen.ai/api/v1/oauth2/token`;
const QWEN_OAUTH_CLIENT_ID = "f0304373b74a44d2b584a3fb70ca9e56";

export async function refreshQwenPortalCredentials(
  credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
  const refreshToken = credentials.refresh?.trim();
  if (!refreshToken) {
    throw new Error("Qwen OAuth refresh token missing; re-authenticate.");
  }

  const response = await fetch(QWEN_OAUTH_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: QWEN_OAUTH_CLIENT_ID,
    }),
  });

  if (!response.ok) {
    if (response.status === 400) {
      throw new Error(
        `Qwen OAuth refresh token expired or invalid. Re-authenticate with \`${formatCliCommand("openclaw models auth login --provider qwen-portal")}\`.`,
      );
    }
    const text = await response.text();
    throw new Error(`Qwen OAuth refresh failed: ${text || response.statusText}`);
  }

  const payload = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  const accessToken = payload.access_token?.trim();
  const newRefreshToken = payload.refresh_token?.trim();
  const expiresIn = payload.expires_in;

  if (!accessToken) {
    throw new Error("Qwen OAuth refresh response missing access token.");
  }
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error("Qwen OAuth refresh response missing or invalid expires_in.");
  }

  return {
    ...credentials,
    access: accessToken,
    // RFC 6749 section 6: new refresh token is optional; if present, replace old.
    refresh: newRefreshToken || refreshToken,
    expires: Date.now() + expiresIn * 1000,
  };
}
```

**Leon点评**：OAuth刷新逻辑严格遵循RFC 6749：
1. **Refresh token轮换**：新token可选，存在则替换旧token
2. **错误提示**：400错误时给出明确的重新认证命令
3. **严格验证**：验证所有必需字段和类型
4. **过期时间**：使用相对时间expires_in转换为绝对时间

### 4. Copilot 模型定义系统

```typescript
// src/providers/github-copilot-models.ts
const DEFAULT_MODEL_IDS = [
  "claude-sonnet-4.6",
  "claude-sonnet-4.5",
  "gpt-4o",
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "o1",
  "o1-mini",
  "o3-mini",
] as const;

export function buildCopilotModelDefinition(modelId: string): ModelDefinitionConfig {
  const id = modelId.trim();
  if (!id) {
    throw new Error("Model id required");
  }
  return {
    id,
    name: id,
    api: "openai-responses",  // Copilot使用OpenAI兼容API
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
}
```

**Leon点评**：模型定义系统设计灵活：
1. **宽松列表**：包含所有可能的Copilot模型，不可用时由错误处理
2. **API复用**：使用OpenAI兼容的responses API
3. **视觉支持**：支持text和image输入
4. **成本归零**：Copilot成本由GitHub处理，本地不需要跟踪

---

## 一、Providers 系统架构总览

### 核心组件

```
Providers 系统
├── GitHub Copilot
│   ├── github-copilot-auth.ts - 设备流OAuth登录
│   ├── github-copilot-token.ts - 令牌交换和验证
│   └── github-copilot-models.ts - 模型定义
├── Qwen Portal
│   └── qwen-portal-oauth.ts - OAuth刷新
├── Google 共享
│   ├── google-shared.ts - Gemini CLI集成
│   └── google-shared.test-helpers.ts - 测试辅助
└── Kilocode 共享
    └── kilocode-shared.ts - 共享工具
```

### OAuth 流程对比

```
GitHub Copilot (设备流)
├── 1. 请求设备码
│   └── 返回: device_code, user_code, verification_uri
├── 2. 显示用户码
│   └── 用户访问 verification_uri 输入 user_code
├── 3. 轮询访问令牌
│   └── 返回: access_token
└── 4. 完成

Qwen Portal (授权码)
├── 1. 用户授权
│   └── 获取: access_token, refresh_token
├── 2. 刷新令牌
│   └── POST /oauth2/token with refresh_token
└── 3. 轮换 refresh_token (可选)
```

---

## 二、GitHub Copilot 集成

### 设备流 OAuth

**优点**：
- 无需客户端密钥
- 适合CLI/无浏览器环境
- GitHub官方支持

**流程**：
```
CLI                          用户浏览器
  │                              │
  │──请求设备码─────────────────→│
  │←────────────────返回device_code│
  │                              │
  │显示: 请访问 github.com/device │
  │      输入代码: ABC-12345     │
  │                              │
  │──轮询: 有授权吗？───────────→│
  │←────────────────pending      │
  │──轮询: 有授权吗？───────────→│
  │←────────────────access_token │
  │                              │
```

### 认证 Profile 存储

```typescript
// src/agents/auth-profiles.ts
export type AuthProfile = {
  type: "token";
  provider: string;
  token: string;
  expires?: number;
};

export function upsertAuthProfile(params: {
  profileId: string;
  credential: AuthProfile;
}): void {
  const store = ensureAuthProfileStore();
  store.profiles[params.profileId] = {
    ...params.credential,
    type: params.credential.type,
    provider: params.credential.provider,
  };
  writeAuthProfileStore(store);
}
```

### 配置集成

```typescript
await updateConfig((cfg) =>
  applyAuthProfileConfig(cfg, {
    provider: "github-copilot",
    profileId,
    mode: "token",
  }),
);
```

---

## 三、Qwen Portal 集成

### OAuth 刷新机制

```typescript
export async function refreshQwenPortalCredentials(
  credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
  // 1. 验证 refresh_token
  const refreshToken = credentials.refresh?.trim();
  if (!refreshToken) {
    throw new Error("Qwen OAuth refresh token missing; re-authenticate.");
  }

  // 2. 发送刷新请求
  const response = await fetch(QWEN_OAUTH_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: QWEN_OAUTH_CLIENT_ID,
    }),
  });

  // 3. 处理错误
  if (!response.ok) {
    if (response.status === 400) {
      throw new Error(
        `Qwen OAuth refresh token expired or invalid. ` +
        `Re-authenticate with \`${formatCliCommand("openclaw models auth login --provider qwen-portal")}\`.`
      );
    }
    throw new Error(`Qwen OAuth refresh failed: ${response.statusText}`);
  }

  // 4. 解析响应
  const payload = await response.json();
  const accessToken = payload.access_token?.trim();
  const newRefreshToken = payload.refresh_token?.trim();
  const expiresIn = payload.expires_in;

  // 5. 验证响应
  if (!accessToken) {
    throw new Error("Qwen OAuth refresh response missing access token.");
  }
  if (typeof expiresIn !== "number" || expiresIn <= 0) {
    throw new Error("Qwen OAuth refresh response missing or invalid expires_in.");
  }

  // 6. 返回新凭证
  return {
    ...credentials,
    access: accessToken,
    refresh: newRefreshToken || refreshToken,  // RFC 6749: 可选
    expires: Date.now() + expiresIn * 1000,
  };
}
```

### RFC 6749 合规性

OpenClaw 的实现严格遵循 [RFC 6749 Section 6](https://datatracker.ietf.org/doc/html/rfc6749#section-6)：

1. **Refresh Token 是可选的**：如果响应不包含新 refresh_token，继续使用旧的
2. **Expires In 是相对时间**：从响应时间开始计算的秒数
3. **错误处理**：400 表示 refresh_token 无效或过期

---

## 四、模型定义系统

### Copilot 模型列表

```typescript
const DEFAULT_MODEL_IDS = [
  // Claude 系列
  "claude-sonnet-4.6",
  "claude-sonnet-4.5",

  // GPT-4 系列
  "gpt-4o",
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4.1-nano",

  // OpenAI o1 系列
  "o1",
  "o1-mini",
  "o3-mini",
] as const;
```

**说明**：
- 这个列表保持宽泛，因为Copilot模型可能因计划/组织而异
- 如果模型不可用，Copilot API会返回错误，用户可以从配置中删除

### 模型定义构建

```typescript
export function buildCopilotModelDefinition(modelId: string): ModelDefinitionConfig {
  return {
    id: modelId.trim(),
    name: modelId.trim(),
    api: "openai-responses",  // 使用OpenAI兼容API
    reasoning: false,
    input: ["text", "image"],  // 支持视觉
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
  };
}
```

---

## 五、测试辅助工具

### Google 测试辅助

```typescript
// src/providers/google-shared.test-helpers.ts
export function makeGeminiCliModel(id: string): Model<"google-gemini-cli"> {
  return {
    id,
    name: id,
    api: "google-gemini-cli",
    provider: "google-gemini-cli",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1,
    maxTokens: 1,
  } as Model<"google-gemini-cli">;
}

export function makeGoogleAssistantMessage(model: string, content: unknown) {
  return {
    role: "assistant",
    content,
    api: "google-generative-ai",
    provider: "google",
    model,
    usage: makeZeroUsageSnapshot(),
    stopReason: "stop",
    timestamp: 0,
  };
}

export function expectConvertedRoles(contents: Array<{ role?: string }>, expectedRoles: string[]) {
  expect(contents).toHaveLength(expectedRoles.length);
  for (const [index, role] of expectedRoles.entries()) {
    expect(contents[index]?.role).toBe(role);
  }
}
```

---

## 六、技术权衡

### 1. 设备流 vs 授权码

| 方案 | 优势 | 劣势 |
|------|------|------|
| 设备流 | 无客户端密钥、适合CLI | 用户体验稍差 |
| 授权码 | 更好的用户体验 | 需要客户端密钥 |

**选择**：GitHub Copilot 使用设备流
**原因**：CLI应用无法安全存储客户端密钥

### 2. 宽松模型列表 vs 严格验证

| 方案 | 优势 | 劣势 |
|------|------|------|
| 宽松列表 | 支持新模型、无需更新 | 可能包含无效模型 |
| 严格验证 | 只显示可用模型 | 需要定期更新列表 |

**选择**：宽松列表
**原因**：Copilot模型因组织而异，API会处理无效请求

### 3. 内联成本 vs 零成本

| 方案 | 优势 | 劣势 |
|------|------|------|
| 内联成本 | 准确跟踪使用情况 | 需要维护定价 |
| 零成本 | 简单、无需更新 | 无法跟踪成本 |

**选择**：零成本
**原因**：Copilot成本由GitHub处理，本地跟踪无意义

---

*本文档基于源码分析，涵盖Providers提供商集成的OAuth流程、模型定义系统、测试辅助工具以及技术权衡。*
