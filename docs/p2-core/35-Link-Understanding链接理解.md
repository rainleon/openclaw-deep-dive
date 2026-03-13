# Link Understanding 链接理解 (Link Understanding)

> "OpenClaw 的链接理解系统通过 CLI 命令将 URL 转换为可读内容，支持作用域策略控制和多模型回退。系统智能提取消息中的 URL，调用外部命令解析，然后将结果附加到回复中。卧槽，这个设计太巧妙了——让 Agent 可以「阅读」用户分享的链接，大幅扩展了信息获取能力。作用域策略确保只对可信会话启用，避免滥用和成本问题。"

---

## 核心技术洞察

### 1. 链接提取

```typescript
// src/link-understanding/detect.ts
import { getUrlPatterns } from "../shared/urls.js";

export type LinkDetectionResult = {
  urls: string[];
  cleanedText: string;
};

export function extractLinksFromMessage(
  message: string,
  options?: { maxLinks?: number },
): LinkDetectionResult {
  const maxLinks = options?.maxLinks ?? 10;
  const patterns = getUrlPatterns();

  const urls: string[] = [];
  const cleanedText = message.replace(
    new RegExp(`(?:${patterns.join("|")})`, "gi"),
    (match) => {
      if (urls.length >= maxLinks) {
        return match; // 超过限制后不再提取
      }
      const normalized = match.trim();
      if (normalized && !urls.includes(normalized)) {
        urls.push(normalized);
      }
      return match;
    }
  );

  return { urls, cleanedText };
}
```

**Leon 点评**：链接提取设计得很健壮：
1. **多模式匹配**：使用 URL patterns 数组匹配多种 URL 格式
2. **去重**：自动去重，避免重复处理同一链接
3. **数量限制**：`maxLinks` 防止滥用和成本爆炸
4. **文本保留**：cleanedText 保留原始文本（只提取不删除）

### 2. CLI 执行器

```typescript
// src/link-understanding/runner.ts
async function runCliEntry(params: {
  entry: LinkModelConfig;
  ctx: MsgContext;
  url: string;
  config?: LinkToolsConfig;
}): Promise<string | null> {
  if ((entry.type ?? "cli") !== "cli") {
    return null;
  }
  const command = entry.command.trim();
  if (!command) {
    return null;
  }
  const args = entry.args ?? [];
  const timeoutMs = resolveTimeoutMsFromConfig({ config: params.config, entry });

  const templCtx = {
    ...params.ctx,
    LinkUrl: params.url,
  };
  const argv = [command, ...args].map((part, index) =>
    index === 0 ? part : applyTemplate(part, templCtx),
  );

  if (shouldLogVerbose()) {
    logVerbose(`Link understanding via CLI: ${argv.join(" ")}`);
  }

  const { stdout } = await runExec(argv[0], argv.slice(1), {
    timeoutMs,
    maxBuffer: CLI_OUTPUT_MAX_BUFFER,
  });
  const trimmed = stdout.trim();
  return trimmed || null;
}
```

**Leon 点评**：CLI 执行器提供了灵活性：
1. **模板替换**：通过 `applyTemplate` 支持变量替换
2. **上下文注入**：将 LinkUrl 和其他上下文传递给命令
3. **超时保护**：防止命令无限期运行
4. **缓冲限制**：`maxBuffer` 防止输出过大

### 3. 作用域策略

```typescript
// src/link-understanding/runner.ts
function resolveScopeDecision(params: {
  config?: LinkToolsConfig;
  ctx: MsgContext;
}): "allow" | "deny" {
  return resolveMediaUnderstandingScope({
    scope: params.config?.scope,
    sessionKey: params.ctx.SessionKey,
    channel: params.ctx.Surface ?? params.ctx.Provider,
    chatType: normalizeMediaUnderstandingChatType(params.ctx.ChatType),
  });
}
```

**Leon 点评**：作用域策略重用了媒体理解的作用域系统：
1. **统一策略**：与媒体理解使用相同的策略接口
2. **多维度控制**：sessionKey、channel、chatType 精细控制
3. **默认安全**：默认拒绝，需要显式配置允许
4. **一致性**：确保所有媒体理解功能使用相同的安全边界

### 4. 主运行器

```typescript
// src/link-understanding/runner.ts
export async function runLinkUnderstanding(params: {
  cfg: OpenClawConfig;
  ctx: MsgContext;
  message?: string;
}): Promise<LinkUnderstandingResult> {
  const config = params.cfg.tools?.links;
  if (!config || config.enabled === false) {
    return { urls: [], outputs: [] };
  }

  const scopeDecision = resolveScopeDecision({ config, ctx: params.ctx });
  if (scopeDecision === "deny") {
    if (shouldLogVerbose()) {
      logVerbose("Link understanding disabled by scope policy.");
    }
    return { urls: [], outputs: [] };
  }

  const message = params.message ?? params.ctx.CommandBody ?? params.ctx.RawBody ?? params.ctx.Body;
  const links = extractLinksFromMessage(message ?? "", { maxLinks: config?.maxLinks });
  if (links.length === 0) {
    return { urls: [], outputs: [] };
  }

  const entries = config?.models ?? [];
  if (entries.length === 0) {
    return { urls: links, outputs: [] };
  }

  const outputs: string[] = [];
  for (const url of links) {
    const output = await runLinkEntries({
      entries,
      ctx: params.ctx,
      url,
      config,
    });
    if (output) {
      outputs.push(output);
    }
  }

  return { urls: links, outputs };
}
```

**Leon 点评**：主运行器的流程设计清晰：
1. **配置检查**：首先检查是否启用
2. **作用域验证**：验证当前会话是否允许
3. **链接提取**：从消息中提取 URL
4. **模型回退**：尝试每个配置的模型直到成功

---

## 一、链接理解架构总览

### 核心组件

```
Link Understanding
├── Detection（检测）
│   ├── URL Pattern Matching
│   ├── Deduplication
│   └── Max Links Limit
├── Execution（执行）
│   ├── CLI Command Runner
│   ├── Template Replacement
│   └── Timeout Protection
├── Scope Policy（作用域策略）
│   ├── Session Key
│   ├── Channel
│   └── Chat Type
└── Model Fallback（模型回退）
    ├── Entry Array
    ├── Sequential Try
    └── Error Collection
```

### 处理流程

```
Input Message
    ↓
Extract URLs (with limit)
    ↓
Check Scope Policy
    ↓
For Each URL:
    ├── Try Model 1 → Output?
    ├── Try Model 2 → Output?
    └── Try Model 3 → Output?
    ↓
Collect Outputs
    ↓
Return Result
```

---

## 二、类型系统

### 配置类型

```typescript
export type LinkToolsConfig = {
  enabled?: boolean;
  scope?: MediaUnderstandingScope;
  timeoutSeconds?: number;
  maxLinks?: number;
  models?: LinkModelConfig[];
};
```

### 模型配置

```typescript
export type LinkModelConfig = {
  type?: "cli";
  command: string;
  args?: string[];
  timeoutSeconds?: number;
};
```

### 运行结果

```typescript
export type LinkUnderstandingResult = {
  urls: string[];
  outputs: string[];
};
```

### 消息上下文

```typescript
type MsgContext = {
  SessionKey: string;
  Provider?: string;
  Surface?: string;
  ChatType?: string;
  CommandBody?: string;
  RawBody?: string;
  Body?: string;
  // ... 更多字段
};
```

---

## 三、配置示例

### 基础配置

```yaml
tools:
  links:
    enabled: true
    maxLinks: 3
    models:
      - command: "link-summary"
        args: []
```

### 多模型配置

```yaml
tools:
  links:
    enabled: true
    maxLinks: 2
    timeoutSeconds: 30
    models:
      - command: "link-summary"
        args: ["--lang=en"]
      - command: "link-extract"
        args: ["--format=text"]
      - command: "custom-link-parser"
        timeoutSeconds: 15
```

### 作用域配置

```yaml
tools:
  links:
    enabled: true
    scope:
      default: deny
      allow:
        - sessionKey: "agent:default:telegram:*"
      deny:
        - chatType: "group_large"
```

---

## 四、链接检测

### URL Patterns

```typescript
// src/shared/urls.ts
export function getUrlPatterns(): string[] {
  return [
    // HTTP/HTTPS URLs
    "https?://(?:[a-zA-Z0-9-]+\\.)+[[a-zA-Z]{2,}(?::\\d+)?(?:\\/[^\\s]*)?",
    // Common patterns can be added
  ];
}
```

### 提取限制

| 参数 | 默认值 | 描述 |
|------|--------|------|
| maxLinks | 10 | 最多提取的链接数 |
| caseSensitive | false | 是否区分大小写 |
| global | false | 全局匹配（vs 第一次匹配） |

### 清理文本

```typescript
const { urls, cleanedText } = extractLinksFromMessage(message, { maxLinks: 5 });

// urls: ["https://example.com", "https://openclaw.ai"]
// cleanedText: 原始消息（保留所有文本，只提取不删除）
```

---

## 五、CLI 执行

### 命令模板

```bash
# 基础命令
command: "link-summary"

# 带参数的命令
command: "link-summary"
args: ["--lang=en", "--format=text"]

# 使用上下文变量
command: "link-summary"
args: ["--url", "{LinkUrl}", "--session", "{SessionKey}"]
```

### 模板变量

| 变量 | 描述 | 示例 |
|------|------|------|
| LinkUrl | 当前处理的 URL | https://example.com/article |
| SessionKey | 会话键 | agent:default:telegram:123456 |
| Provider | 渠道 | telegram |
| Surface | 表面 | telegram |
| ChatType | 聊天类型 | dm |
| ... | 其他上下文字段 | ... |

### 执行环境

```typescript
const { stdout } = await runExec(argv[0], argv.slice(1), {
  timeoutMs,
  maxBuffer: CLI_OUTPUT_MAX_BUFFER,
});
```

| 参数 | 默认值 | 描述 |
|------|--------|------|
| timeoutMs | 30秒 | 命令超时时间 |
| maxBuffer | 1MB | 输出最大缓冲区 |

---

## 六、作用域策略

### 策略继承

```typescript
function resolveScopeDecision(params: {
  config?: LinkToolsConfig;
  ctx: MsgContext;
}): "allow" | "deny" {
  // 1. 检查链接特定配置
  // 2. 回退到通用媒体理解策略
  // 3. 默认拒绝
}
```

### 作用域维度

| 维度 | 类型 | 示例 |
|------|------|------|
| sessionKey | string | "agent:default:telegram:*" |
| channel | string | "telegram", "discord" |
| chatType | string | "dm", "group", "group_large" |
| default | "allow" | "deny" 默认 |

### 策略示例

```yaml
# 只允许 DM 会话
tools:
  links:
    scope:
      allow:
        - chatType: "dm"
      deny:
        - chatType: "group"
        - chatType: "group_large"

# 只允许特定会话
tools:
  links:
    scope:
      allow:
        - sessionKey: "agent:vip:telegram:*"
      default: deny

# 禁止所有群组
tools:
  links:
    scope:
      deny:
        - chatType: "group"
        - chatType: "group_large"
```

---

## 七、技术权衡

### 1. 内嵌 vs 外部

| 方案 | 优势 | 劣势 |
|------|------|------|
| 内嵌解析 | 无外部依赖、快速 | 功能有限、维护成本 |
| 外部 CLI | 灵活、可扩展 | 依赖外部命令 |

**选择**：外部 CLI
**原因**：灵活性和可扩展性优先，用户可以选择任何工具

### 2. 同步 vs 异步

| 方案 | 优势 | 劣势 |
|------|------|------|
| 同步 | 简单、可靠 | 阻塞回复 |
| 异步 | 非阻塞 | 复杂度高 |

**选择**：同步
**原因**：链接理解是消息处理的一部分，需要等待结果

### 3. 全部处理 vs 数量限制

| 方案 | 优势 | 劣势 |
|------|------|------|
| 全部处理 | 完整信息 | 可能很慢、成本高 |
| 数量限制 | 可控成本、速度快 | 可能遗漏信息 |

**选择**：数量限制
**原因**：防止滥用和成本爆炸，默认限制 10 个链接

### 4. 提取保留 vs 提取删除

| 方案 | 优势 | 劣势 |
|------|------|------|
| 提取保留 | 用户可见、透明 | 消息包含 URL |
| 提取删除 | 消息简洁 | 用户看不到原始 URL |

**选择**：提取保留
**原因**：保留原始消息，用户可以自行点击链接

---

## 八、最佳实践

### 推荐配置

```yaml
tools:
  links:
    # 默认关闭，需要时手动启用
    enabled: false

    # 限制每个消息最多处理 3 个链接
    maxLinks: 3

    # 30 秒超时
    timeoutSeconds: 30

    # 作用域：只允许 DM 会话
    scope:
      allow:
        - chatType: "dm"
      default: deny

    # 模型配置
    models:
      - command: "link-summary"
        args: ["--format=text", "--max-length=500"]
```

### 安全考虑

1. **命令验证**：确保 CLI 命令来自可信来源
2. **超时保护**：防止命令无限期运行
3. **缓冲限制**：防止输出过大导致内存问题
4. **作用域控制**：默认拒绝，显式允许

### 性能优化

1. **并行处理**：理论上可以并行处理多个链接（当前串行）
2. **缓存**：缓存相同 URL 的解析结果
3. **超时设置**：根据网络情况调整超时时间
4. **输出限制**：限制输出长度，避免过大

---

*本文档基于源码分析，涵盖链接理解系统的架构、链接检测、CLI 执行、作用域策略、模型回退以及技术权衡。*
