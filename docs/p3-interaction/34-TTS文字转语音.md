# TTS 文字转语音 (Text-to-Speech)

> "OpenClaw 的 TTS 系统支持多提供商（OpenAI、ElevenLabs、Edge）、自动模式（off/always/inbound/tagged）和智能文本摘要。指令解析器通过 `[[tts:...]]` 标签支持精细的语音控制——可以切换提供商、声音、模型、语音设置等。提供商回退机制确保服务可用性，Edge TTS 作为免费回退选项。卧槽，自动摘要功能太聪明了——当文本超过限制时，用 LLM 自动压缩到目标长度，保留关键信息。"

---

## 核心技术洞察

### 1. 多提供商架构

```typescript
// src/tts/tts.ts
export async function textToSpeech(params: {
  text: string;
  cfg: OpenClawConfig;
  prefsPath?: string;
  channel?: string;
  overrides?: TtsDirectiveOverrides;
}): Promise<TtsResult> {
  const config = resolveTtsConfig(params.cfg);
  const prefsPath = params.prefsPath ?? resolveTtsPrefsPath(config);
  const channelId = resolveChannelId(params.channel);
  const output = resolveOutputFormat(channelId);

  // 用户选择的提供商
  const userProvider = getTtsProvider(config, prefsPath);
  const overrideProvider = params.overrides?.provider;
  const provider = overrideProvider ?? userProvider;

  // 提供商回退顺序
  const providers = resolveTtsProviderOrder(provider);
  const errors: string[] = [];

  // 尝试每个提供商
  for (const provider of providers) {
    const providerStart = Date.now();
    try {
      if (provider === "edge") {
        if (!config.edge.enabled) {
          errors.push("edge: disabled");
          continue;
        }
        // Edge TTS 实现...
        return {
          success: true,
          audioPath: edgeResult.audioPath,
          latencyMs: Date.now() - providerStart,
          provider,
          outputFormat: edgeResult.outputFormat,
          voiceCompatible: edgeResult.voiceCompatible,
        };
      }

      const apiKey = resolveTtsApiKey(config, provider);
      if (!apiKey) {
        errors.push(`${provider}: no API key`);
        continue;
      }

      // OpenAI / ElevenLabs 实现...
      return {
        success: true,
        audioPath,
        latencyMs: Date.now() - providerStart,
        provider,
        outputFormat,
        voiceCompatible: output.voiceCompatible,
      };
    } catch (err) {
      errors.push(formatTtsProviderError(provider, err));
    }
  }

  return buildTtsFailureResult(errors);
}
```

**Leon 点评**：多提供商架构确保了可靠性：
1. **回退机制**：主提供商失败时自动尝试其他提供商
2. **Edge 免费回退**：Edge TTS 作为最后的免费选项
3. **错误收集**：收集所有提供商的错误信息
4. **性能追踪**：记录每个提供商的延迟

### 2. 指令解析器

```typescript
// src/tts/tts-core.ts
export function parseTtsDirectives(
  text: string,
  policy: ResolvedTtsModelOverrides,
  openaiBaseUrl?: string,
): TtsDirectiveParseResult {
  if (!policy.enabled) {
    return { cleanedText: text, overrides: {}, warnings: [], hasDirective: false };
  }

  const overrides: TtsDirectiveOverrides = {};
  const warnings: string[] = [];
  let cleanedText = text;
  let hasDirective = false;

  // 解析 [[tts:text]]...[[/tts:text]]
  const blockRegex = /\[\[tts:text\]\]([\s\S]*?)\[\[\/tts:text\]\]/gi;
  cleanedText = cleanedText.replace(blockRegex, (_match, inner: string) => {
    hasDirective = true;
    if (policy.allowText && overrides.ttsText == null) {
      overrides.ttsText = inner.trim();
    }
    return "";
  });

  // 解析 [[tts:key=value]]
  const directiveRegex = /\[\[tts:([^\]]+)\]\]/gi;
  cleanedText = cleanedText.replace(directiveRegex, (_match, body: string) => {
    hasDirective = true;
    const tokens = body.split(/\s+/).filter(Boolean);
    for (const token of tokens) {
      const eqIndex = token.indexOf("=");
      if (eqIndex === -1) continue;

      const key = token.slice(0, eqIndex).trim().toLowerCase();
      const value = token.slice(eqIndex + 1).trim();

      switch (key) {
        case "provider":
          if (policy.allowProvider) {
            if (["openai", "elevenlabs", "edge"].includes(value)) {
              overrides.provider = value;
            } else {
              warnings.push(`unsupported provider "${value}"`);
            }
          }
          break;
        case "voice":
        case "openai_voice":
          if (policy.allowVoice) {
            if (isValidOpenAIVoice(value, openaiBaseUrl)) {
              overrides.openai = { ...overrides.openai, voice: value };
            } else {
              warnings.push(`invalid OpenAI voice "${value}"`);
            }
          }
          break;
        case "voiceid":
          if (policy.allowVoice) {
            if (isValidVoiceId(value)) {
              overrides.elevenlabs = { ...overrides.elevenlabs, voiceId: value };
            } else {
              warnings.push(`invalid ElevenLabs voiceId "${value}"`);
            }
          }
          break;
        // ... 更多选项
      }
    }
    return "";
  });

  return { cleanedText, ttsText: overrides.ttsText, hasDirective, overrides, warnings };
}
```

**Leon 点评**：指令解析器提供了精细的控制：
1. **文本替换**：`[[tts:text]]` 替换 TTS 文本
2. **键值对解析**：`[[tts:key=value]]` 设置参数
3. **策略检查**：根据 `allow*` 策略决定是否允许
4. **验证和警告**：验证输入值，返回警告信息

### 3. 自动模式系统

```typescript
// src/tts/tts.ts
export type TtsAutoMode = "off" | "always" | "inbound" | "tagged";

export async function maybeApplyTtsToPayload(params: {
  payload: ReplyPayload;
  cfg: OpenClawConfig;
  channel?: string;
  kind?: "tool" | "block" | "final";
  inboundAudio?: boolean;
  ttsAuto?: string;
}): Promise<ReplyPayload> {
  const config = resolveTtsConfig(params.cfg);
  const prefsPath = resolveTtsPrefsPath(config);
  const autoMode = resolveTtsAutoMode({
    config,
    prefsPath,
    sessionAuto: params.ttsAuto,
  });

  if (autoMode === "off") {
    return params.payload;
  }

  const text = params.payload.text ?? "";
  const directives = parseTtsDirectives(text, config.modelOverrides, config.openai.baseUrl);
  const cleanedText = directives.cleanedText.trim();
  const ttsText = directives.ttsText?.trim() || cleanedText;

  // 模式检查
  if (autoMode === "tagged" && !directives.hasDirective) {
    return params.payload;
  }
  if (autoMode === "inbound" && params.inboundAudio !== true) {
    return params.payload;
  }

  // 长度检查和摘要
  const maxLength = getTtsMaxLength(prefsPath);
  let textForAudio = ttsText.trim();

  if (textForAudio.length > maxLength) {
    if (!isSummarizationEnabled(prefsPath)) {
      textForAudio = `${textForAudio.slice(0, maxLength - 3)}...`;
    } else {
      const summary = await summarizeText({
        text: textForAudio,
        targetLength: maxLength,
        cfg: params.cfg,
        config,
        timeoutMs: config.timeoutMs,
      });
      textForAudio = summary.summary;
    }
  }

  // 执行 TTS
  const result = await textToSpeech({
    text: textForAudio,
    cfg: params.cfg,
    prefsPath,
    channel: params.channel,
    overrides: directives.overrides,
  });

  if (result.success && result.audioPath) {
    return {
      ...params.payload,
      text: cleanedText.length > 0 ? cleanedText : undefined,
      mediaUrl: result.audioPath,
      audioAsVoice: shouldVoice || params.payload.audioAsVoice,
    };
  }

  return params.payload;
}
```

**Leon 点评**：自动模式设计得非常灵活：
1. **off**：完全禁用 TTS
2. **always**：总是启用 TTS
3. **inbound**：仅在收到音频输入时启用
4. **tagged**：仅在检测到 `[[tts:]]` 标签时启用

### 4. 文本摘要

```typescript
// src/tts/tts-core.ts
export async function summarizeText(params: {
  text: string;
  targetLength: number;
  cfg: OpenClawConfig;
  config: ResolvedTtsConfig;
  timeoutMs: number;
}): Promise<SummarizeResult> {
  const { text, targetLength, cfg, config, timeoutMs } = params;

  // 解析摘要模型
  const { ref } = resolveSummaryModelRef(cfg, config);
  const resolved = resolveModel(ref.provider, ref.model, undefined, cfg);
  if (!resolved.model) {
    throw new Error(`Unknown summary model: ${ref.provider}/${ref.model}`);
  }

  const apiKey = requireApiKey(
    await getApiKeyForModel({ model: resolved.model, cfg }),
    ref.provider,
  );

  // 调用 LLM 摘要
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await completeSimple(resolved.model, {
      messages: [
        {
          role: "user",
          content:
            `You are an assistant that summarizes texts concisely while keeping the most important information. ` +
            `Summarize the text to approximately ${targetLength} characters. Maintain the original tone and style. ` +
            `Reply only with the summary, without additional explanations.\n\n` +
            `<text_to_summarize>\n${text}\n</text_to_summarize>`,
          timestamp: Date.now(),
        },
      ],
    }, {
      apiKey,
      maxTokens: Math.ceil(targetLength / 2),
      temperature: 0.3,
      signal: controller.signal,
    });

    const summary = res.content
      .filter((block) => block.type === "text")
      .map((block) => block.text.trim())
      .filter(Boolean)
      .join(" ")
      .trim();

    if (!summary) {
      throw new Error("No summary returned");
    }

    return {
      summary,
      latencyMs: Date.now() - startTime,
      inputLength: text.length,
      outputLength: summary.length,
    };
  } finally {
    clearTimeout(timeout);
  }
}
```

**Leon 点评**：文本摘要功能设计得很好：
1. **专用提示词**：优化的摘要提示词
2. **目标长度**：精确控制摘要长度
3. **超时保护**：防止 LLM 调用挂起
4. **统计追踪**：记录输入/输出长度和延迟

### 5. 用户偏好系统

```typescript
// src/tts/tts.ts
export type TtsUserPrefs = {
  tts?: {
    auto?: TtsAutoMode;
    enabled?: boolean;
    provider?: TtsProvider;
    maxLength?: number;
    summarize?: boolean;
  };
};

function readPrefs(prefsPath: string): TtsUserPrefs {
  try {
    if (!existsSync(prefsPath)) {
      return {};
    }
    return JSON.parse(readFileSync(prefsPath, "utf8"));
  } catch {
    return {};
  }
}

function updatePrefs(prefsPath: string, update: (prefs: TtsUserPrefs) => void): void {
  const prefs = readPrefs(prefsPath);
  update(prefs);
  mkdirSync(path.dirname(prefsPath), { recursive: true });
  atomicWriteFileSync(prefsPath, JSON.stringify(prefs, null, 2));
}

// 设置函数
export function setTtsAutoMode(prefsPath: string, mode: TtsAutoMode): void {
  updatePrefs(prefsPath, (prefs) => {
    prefs.tts = { ...prefs.tts, auto: mode };
  });
}

export function setTtsProvider(prefsPath: string, provider: TtsProvider): void {
  updatePrefs(prefsPath, (prefs) => {
    prefs.tts = { ...prefs.tts, provider };
  });
}

export function setTtsMaxLength(prefsPath: string, maxLength: number): void {
  updatePrefs(prefsPath, (prefs) => {
    prefs.tts = { ...prefs.tts, maxLength };
  });
}

export function setSummarizationEnabled(prefsPath: string, enabled: boolean): void {
  updatePrefs(prefsPath, (prefs) => {
    prefs.tts = { ...prefs.tts, summarize: enabled };
  });
}
```

**Leon 点评**：用户偏好系统简洁有效：
1. **JSON 持久化**：简单的 JSON 文件存储
2. **原子写入**：使用临时文件 + 重命名确保原子性
3. **增量更新**：只更新修改的字段
4. **类型安全**：TypeScript 类型确保正确性

---

## 一、TTS 架构总览

### 提供商

| 提供商 | 模型/声音 | 成本 | 质量 |
|--------|----------|------|------|
| OpenAI | gpt-4o-mini-tts, tts-1, tts-1-hd | 付费 | 高 |
| ElevenLabs | 多语言、多声音 | 付费 | 极高 |
| Edge | 系统内置 | 免费 | 中 |

### 输出格式

| 格式 | 扩展名 | 使用场景 |
|------|--------|----------|
| mp3 | .mp3 | 通用兼容 |
| opus | .opus | Telegram 语音消息 |
| pcm | .wav | 电话通话 |

### 自动模式

| 模式 | 触发条件 | 使用场景 |
|------|----------|----------|
| off | - | 禁用 TTS |
| always | 所有消息 | 全部语音播报 |
| inbound | 收到音频 | 回复语音消息 |
| tagged | `[[tts:]]` 标签 | 精确控制 |

---

## 二、配置系统

### 全局配置

```typescript
export type TtsConfig = {
  auto?: TtsAutoMode;
  enabled?: boolean;
  provider?: TtsProvider;
  summaryModel?: string;
  modelOverrides?: TtsModelOverrideConfig;
  maxLength?: number;
  timeoutMs?: number;
  openai?: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    voice?: string;
  };
  elevenlabs?: {
    apiKey?: string;
    baseUrl?: string;
    voiceId?: string;
    modelId?: string;
    applyTextNormalization?: "auto" | "on" | "off";
    languageCode?: string;
    voiceSettings?: {
      stability?: number;
      similarityBoost?: number;
      style?: number;
      useSpeakerBoost?: boolean;
      speed?: number;
    };
  };
  edge?: {
    enabled?: boolean;
    voice?: string;
    lang?: string;
    outputFormat?: string;
    saveSubtitles?: boolean;
    proxy?: string;
    timeoutMs?: number;
  };
  prefsPath?: string;
};
```

### 用户偏好

```typescript
export type TtsUserPrefs = {
  tts?: {
    auto?: TtsAutoMode;
    enabled?: boolean;
    provider?: TtsProvider;
    maxLength?: number;
    summarize?: boolean;
  };
};
```

### 模型覆盖策略

```typescript
export type TtsModelOverrideConfig = {
  enabled?: boolean;
  allowText?: boolean;
  allowProvider?: boolean;
  allowVoice?: boolean;
  allowModelId?: boolean;
  allowVoiceSettings?: boolean;
  allowNormalization?: boolean;
  allowSeed?: boolean;
};
```

---

## 三、指令系统

### TTS 文本指令

```markdown
This will be spoken normally.
[[tts:text]]This will be used for TTS instead.[[/tts:text]]
This will not be spoken.
```

### 参数指令

```markdown
Normal text [[tts:provider=elevenlabs voiceid=yourVoiceId]]special voice[[/tts:text]]

[[tts:provider=openai openai_voice=alloy model=gpt-4o-mini-tts]]
```

### 支持的参数

| 参数 | 提供商 | 描述 |
|------|--------|------|
| provider | 通用 | 切换提供商 |
| voice | OpenAI | 设置 OpenAI 声音 |
| voiceId | ElevenLabs | 设置 ElevenLabs 声音 ID |
| model | OpenAI/ElevenLabs | 设置模型 |
| stability | ElevenLabs | 设置稳定性 (0-1) |
| similarityBoost | ElevenLabs | 设置相似度 (0-1) |
| style | ElevenLabs | 设置风格 (0-1) |
| speed | ElevenLabs | 设置语速 (0.5-2) |
| useSpeakerBoost | ElevenLabs | 启用扬声器增强 |
| applyTextNormalization | ElevenLabs | 文本规范化 |
| languageCode | ElevenLabs | 语言代码 |
| seed | ElevenLabs | 随机种子 |

---

## 四、文本处理

### Markdown 去除

```typescript
import { stripMarkdown } from "../line/markdown-to-line.js";

// 在 TTS 前去除 Markdown 格式
textForAudio = stripMarkdown(textForAudio).trim();
```

### 文本长度限制

```typescript
export const DEFAULT_TTS_MAX_LENGTH = 1500;
export const DEFAULT_MAX_TEXT_LENGTH = 4096;

if (text.length > config.maxTextLength) {
  return {
    success: false,
    error: `Text too long (${text.length} chars, max ${config.maxTextLength})`,
  };
}
```

### 文本摘要

```typescript
if (textForAudio.length > maxLength) {
  if (!isSummarizationEnabled(prefsPath)) {
    textForAudio = `${textForAudio.slice(0, maxLength - 3)}...`;
  } else {
    const summary = await summarizeText({
      text: textForAudio,
      targetLength: maxLength,
      cfg: params.cfg,
      config,
      timeoutMs: config.timeoutMs,
    });
    textForAudio = summary.summary;
  }
}
```

---

## 五、提供商实现

### OpenAI TTS

```typescript
export async function openaiTTS(params: {
  text: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  voice: string;
  responseFormat: "mp3" | "opus" | "pcm";
  timeoutMs: number;
}): Promise<Buffer> {
  const { text, apiKey, baseUrl, model, voice, responseFormat, timeoutMs } = params;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/audio/speech`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: text,
        voice,
        response_format: responseFormat,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`OpenAI TTS API error (${response.status})`);
    }

    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}
```

### ElevenLabs TTS

```typescript
export async function elevenLabsTTS(params: {
  text: string;
  apiKey: string;
  baseUrl: string;
  voiceId: string;
  modelId: string;
  outputFormat: string;
  seed?: number;
  applyTextNormalization?: "auto" | "on" | "off";
  languageCode?: string;
  voiceSettings: ResolvedTtsConfig["elevenlabs"]["voiceSettings"];
  timeoutMs: number;
}): Promise<Buffer> {
  const {
    text,
    apiKey,
    baseUrl,
    voiceId,
    modelId,
    outputFormat,
    seed,
    applyTextNormalization,
    languageCode,
    voiceSettings,
    timeoutMs,
  } = params;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = new URL(`${normalizeElevenLabsBaseUrl(baseUrl)}/v1/text-to-speech/${voiceId}`);
    url.searchParams.set("output_format", outputFormat);

    const response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
        seed: normalizeSeed(seed),
        apply_text_normalization: normalizeApplyTextNormalization(applyTextNormalization),
        language_code: normalizeLanguageCode(languageCode),
        voice_settings: {
          stability: voiceSettings.stability,
          similarity_boost: voiceSettings.similarityBoost,
          style: voiceSettings.style,
          use_speaker_boost: voiceSettings.useSpeakerBoost,
          speed: voiceSettings.speed,
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`ElevenLabs API error (${response.status})`);
    }

    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}
```

### Edge TTS

```typescript
export async function edgeTTS(params: {
  text: string;
  outputPath: string;
  config: ResolvedTtsConfig["edge"];
  timeoutMs: number;
}): Promise<void> {
  const { text, outputPath, config, timeoutMs } = params;

  const tts = new EdgeTTS({
    voice: config.voice,
    lang: config.lang,
    outputFormat: config.outputFormat,
    saveSubtitles: config.saveSubtitles,
    proxy: config.proxy,
    rate: config.rate,
    pitch: config.pitch,
    volume: config.volume,
    timeout: config.timeoutMs ?? timeoutMs,
  });

  await tts.ttsPromise(text, outputPath);
}
```

---

## 六、技术权衡

### 1. 多提供商 vs 单提供商

| 方案 | 优势 | 劣势 |
|------|------|------|
| 多提供商 | 可靠性、成本优化 | 复杂度高 |
| 单提供商 | 简单、一致 | 单点故障 |

**选择**：多提供商
**原因**：可靠性和成本优化优先

### 2. 摘要 vs 截断

| 方案 | 优势 | 劣势 |
|------|------|------|
| 摘要 | 保留关键信息 | 需要额外 LLM 调用 |
| 截断 | 简单、快速 | 丢失信息 |

**选择**：可选摘要
**原因**：允许用户选择，摘要默认启用

### 3. 指令 vs 配置

| 方案 | 优势 | 劣势 |
|------|------|------|
| 指令 | 精细控制、消息级 | 每次需要指定 |
| 配置 | 一次性设置、全局 | 粒度粗 |

**选择**：两者结合
**原因**：配置设置默认值，指令提供精细控制

### 4. 本地 vs 云端

| 方案 | 优势 | 劣势 |
|------|------|------|
| 本地 (Edge) | 免费、隐私 | 质量中等 |
| 云端 (OpenAI/ElevenLabs) | 高质量、多语言 | 成本、隐私 |

**选择**：云端为主、本地为辅
**原因**：质量优先，Edge 作为免费回退

---

*本文档基于源码分析，涵盖 TTS 系统的架构、多提供商支持、自动模式、指令解析、文本摘要、用户偏好以及技术权衡。*
