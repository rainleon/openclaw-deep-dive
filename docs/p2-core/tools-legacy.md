# Tool 系统（事实对齐版）

本文以源码为依据，聚焦“目录位置、调用路径、安全与配置边界”。路径引用均为相对仓库根，避免超出代码的推断。

## 1. 目录与定位
- 目录与元数据：src/agents/tool-catalog.ts
- 工具实现：src/agents/tools/*
- Agent 主循环（触发工具调用）：src/agents/pi-embedded-runner/run.ts
- 插件工具注入：src/plugins/tools.ts（若存在）

## 2. 调用路径（一次工具调用）
1) Agent 决定调用某工具（见 src/agents/pi-embedded-runner/run.ts）
2) 依据目录/策略选择可用工具（src/agents/tool-catalog.ts）
3) 执行实现（src/agents/tools/*）
4) 结果进入会话/上下文，参与后续发送或推理

## 3. 分组与可用性
- 功能分组：按“文件/运行时/会话/消息/媒体”等域组织，便于配置整组启用
- 预设 Profile：面向不同场景的工具集合（最小可观测、编码辅助等），定义见目录文件
- 插件工具：由插件注册，通常与核心工具分组隔离
注：具体名称与集合以 src/agents/tool-catalog.ts 实际定义为准

## 4. 策略与安全（最小规则集）
- 允许/拒绝：拒绝优先于允许（常见安全基线）
- 所有者限制：敏感工具仅限所有者或具备特定权限的发送者（以实现为准）
- 插件隔离：仅启用插件工具时，目录层通常保留最小核心集以防“误锁死”

## 5. 与网关/节点关系（何时走远程）
- 本地工具：纯本地执行（如文本/文件读取）
- 网关型工具：通过 Gateway 方法集执行（参考 src/gateway/server-methods.ts）
- 节点型工具：经由节点/远程执行通道（从 tools/* 内部可检索到对应调用）

## 6. 查阅入口
- 目录与定义：src/agents/tool-catalog.ts
- 调用触发：src/agents/pi-embedded-runner/run.ts
- 实现集合：src/agents/tools/*
- 插件注入：src/plugins/tools.ts（若存在）
- 网关方法：src/gateway/server-methods.ts（涉及网关型工具时）

---

# OpenClaw 架构探索：Tool 系统

> 基于 `src/agents/tool*` 和 `src/agents/tools/` 的一手源码分析

---

## 最核心的技术洞察 (Top 10)

### 1. 工具策略管道的七层过滤
**评价**: 这是**权限控制领域的策略模式典范**，将复杂的权限决策分解为清晰的层次。

OpenClaw 不使用单一配置，而是通过七层策略管道逐步过滤工具：

```
1. Profile 层 (tools.profile)
   ↓
2. Provider Profile 层 (tools.byProvider.profile)
   ↓
3. 全局允许层 (tools.allow)
   ↓
4. Provider 允许层 (tools.byProvider.allow)
   ↓
5. Agent 允许层 (agents.{id}.tools.allow)
   ↓
6. Agent Provider 允许层 (agents.{id}.tools.byProvider.allow)
   ↓
7. Group 允许层 (group tools.allow)
```

```typescript
// src/agents/tool-policy-pipeline.ts
export function buildDefaultToolPolicyPipelineSteps(params: {
  profilePolicy?: ToolPolicyLike;
  providerProfilePolicy?: ToolPolicyLike;
  globalPolicy?: ToolPolicyLike;
  globalProviderPolicy?: ToolPolicyLike;
  agentPolicy?: ToolPolicyLike;
  agentProviderPolicy?: ToolPolicyLike;
  groupPolicy?: ToolPolicyLike;
  agentId?: string;
}): ToolPolicyPipelineStep[] {
  return [
    { policy: params.profilePolicy, label: "tools.profile", stripPluginOnlyAllowlist: true },
    { policy: params.providerProfilePolicy, label: "tools.byProvider.profile", stripPluginOnlyAllowlist: true },
    { policy: params.globalPolicy, label: "tools.allow", stripPluginOnlyAllowlist: true },
    { policy: params.globalProviderPolicy, label: "tools.byProvider.allow", stripPluginOnlyAllowlist: true },
    { policy: params.agentPolicy, label: "agents.{id}.tools.allow", stripPluginOnlyAllowlist: true },
    { policy: params.agentProviderPolicy, label: "agents.{id}.tools.byProvider.allow", stripPluginOnlyAllowlist: true },
    { policy: params.groupPolicy, label: "group tools.allow", stripPluginOnlyAllowlist: true },
  ];
}
```

**设计意义**：
- Profile 预设可快速启用工具组合
- Provider 级别控制可针对不同 AI 提供商定制
- Agent 级别控制实现多租户隔离
- Group 机制允许批量管理

### 2. 工具组 (Tool Groups) 的语义化抽象
**评价**: 将工具按功能域分组，使配置具有**语义层级**而非扁平列表。

```typescript
// src/agents/tool-catalog.ts
export const CORE_TOOL_GROUPS = {
  "group:openclaw": ["read", "write", "edit", "exec", "process", "web_search", "web_fetch", ...],
  "group:fs": ["read", "write", "edit", "apply_patch"],
  "group:runtime": ["exec", "process"],
  "group:web": ["web_search", "web_fetch"],
  "group:memory": ["memory_search", "memory_get"],
  "group:sessions": ["sessions_list", "sessions_history", "sessions_send", "sessions_spawn", ...],
  "group:ui": ["browser", "canvas"],
  "group:messaging": ["message"],
  "group:automation": ["cron", "gateway"],
  "group:nodes": ["nodes"],
  "group:agents": ["agents_list"],
  "group:media": ["image", "tts"],
};
```

**配置示例**：
```yaml
tools:
  allow:
    - "group:fs"        # 启用所有文件系统工具
    - "group:web"       # 启用所有 Web 工具
    - "exec"            # 单独启用 exec
```

### 3. Profile 预设系统
**评价**: 为不同场景预设工具组合，减少配置认知负担。

| Profile | 包含工具 | 适用场景 |
|---------|----------|----------|
| `minimal` | `session_status` | 最小化只读监控 |
| `coding` | `fs*`, `runtime*`, `memory*`, `sessions*`, `image`, `browser`, `cron` | 编程任务 |
| `messaging` | `sessions*`, `message` | 消息交互 |
| `full` | 所有工具 | 完全信任环境 |

```typescript
// src/agents/tool-catalog.ts
const CORE_TOOL_DEFINITIONS: CoreToolDefinition[] = [
  { id: "read", label: "read", description: "Read file contents", sectionId: "fs", profiles: ["coding"] },
  { id: "exec", label: "exec", description: "Run shell commands", sectionId: "runtime", profiles: ["coding"] },
  { id: "web_search", label: "web_search", description: "Search the web", sectionId: "web", profiles: [] },
  { id: "session_status", label: "session_status", description: "Session status", sectionId: "sessions", profiles: ["minimal", "coding", "messaging"] },
  // ...
];
```

### 4. 插件工具的智能剥离
**评价**: 这个设计巧妙地防止了插件工具配置意外禁用核心工具。

当白名单仅包含插件工具时，系统会自动剥离该白名单，防止意外禁用核心工具：

```typescript
// src/agents/tool-policy.ts
export function stripPluginOnlyAllowlist(
  policy: ToolPolicyLike | undefined,
  groups: PluginToolGroups,
  coreTools: Set<string>,
): AllowlistResolution {
  let hasCoreEntry = false;
  for (const entry of normalized) {
    const isPluginEntry = entry === "group:plugins" || pluginIds.has(entry) || pluginTools.has(entry);
    const expanded = expandToolGroups([entry]);
    const isCoreEntry = expanded.some((tool) => coreTools.has(tool));
    if (isCoreEntry) hasCoreEntry = true;
  }

  const strippedAllowlist = !hasCoreEntry;
  if (strippedAllowlist) {
    // 避免意外禁用核心工具
    return { policy: { ...policy, allow: undefined }, unknownAllowlist, strippedAllowlist: true };
  }
  return { policy, unknownAllowlist, strippedAllowlist: false };
}
```

**警告机制**：
```typescript
if (resolved.unknownAllowlist.length > 0) {
  params.warn(`tools: ${step.label} allowlist contains unknown entries (${entries}). ` +
    (resolved.strippedAllowlist
      ? "Ignoring allowlist so core tools remain available. Use tools.alsoAllow for additive plugin tool enablement."
      : "These entries won't match any tool unless the plugin is enabled."));
}
```

### 5. 循环检测的四种模式
**评价**: 对 AI Agent 执行死锁问题的**全面防御方案**。

```typescript
// src/agents/tool-loop-detection.ts
export type LoopDetectorKind =
  | "generic_repeat"          // 通用重复检测
  | "known_poll_no_progress"  // 已知轮询无进度检测
  | "global_circuit_breaker"  // 全局熔断器
  | "ping_pong";              // Ping-pong 循环检测
```

**检测阈值**：
- `warningThreshold: 10` - 警告级别
- `criticalThreshold: 20` - 严重级别（阻塞执行）
- `globalCircuitBreakerThreshold: 30` - 全局熔断

**Ping-Pong 检测示例**：
```
调用序列: A → B → A → B → A → B → ...
检测器: 发现交替调用模式
判断: 如果连续 20+ 次且结果无变化 → 触发熔断
```

```typescript
function getPingPongStreak(history, currentSignature) {
  // 检测是否有两个工具在交替调用
  let otherSignature: string | undefined;
  for (let i = history.length - 2; i >= 0; i -= 1) {
    if (call.argsHash !== last.argsHash) {
      otherSignature = call.argsHash;
      break;
    }
  }

  // 验证是否真的是 A → B → A → B 模式
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const expected = alternatingTailCount % 2 === 0 ? last.argsHash : otherSignature;
    if (call.argsHash !== expected) break;
    alternatingTailCount += 1;
  }

  return { count: alternatingTailCount + 1, pairedToolName: last.toolName, noProgressEvidence };
}
```

卧槽，连 ping-pong 死锁都能检测出来，这他妈是 AI Agent 领域的**故障艺术大师级**设计。

### 6. 工具结果截断的头尾保留策略
**评价**: 在截断大型工具结果时，智能保留错误信息在尾部，这是**用户体验与性能的完美平衡**。

```typescript
// src/agents/pi-embedded-runner/tool-result-truncation.ts
const MAX_TOOL_RESULT_CONTEXT_SHARE = 0.3;  // 单个工具最多占 30% 上下文
const HARD_MAX_TOOL_RESULT_CHARS = 400_000; // 硬上限 40 万字符

function hasImportantTail(text: string): boolean {
  const tail = text.slice(-2000).toLowerCase();
  return (
    /\b(error|exception|failed|fatal|traceback|panic|stack trace|errno|exit code)\b/.test(tail) ||
    /\}\s*$/.test(tail.trim()) ||  // JSON 结束标记
    /\b(total|summary|result|complete|finished|done)\b/.test(tail)  // 总结词
  );
}

export function truncateToolResultText(text: string, maxChars: number): string {
  if (hasImportantTail(text) && budget > minKeepChars * 2) {
    const tailBudget = Math.min(Math.floor(budget * 0.3), 4_000);  // 尾部保留 4K
    const headBudget = budget - tailBudget - MIDDLE_OMISSION_MARKER.length;
    return text.slice(0, headCut) + "[... middle omitted ...]" + text.slice(tailStart) + suffix;
  }
  // 默认保留头部
  return text.slice(0, cutPoint) + suffix;
}
```

**截断策略**：
1. 检测尾部是否包含重要信息（错误、JSON 结束、总结）
2. 如果有，采用 Head + Tail 模式
3. 否则采用 Head-only 模式
4. 添加截断标记，提示 AI 使用 offset/limit 参数

### 7. 工具调用 ID 的供应商兼容性处理
**评价**: 这是一个**跨 LLM 提供商兼容性的隐藏细节**，许多类似项目都会在这里翻车。

不同提供商对 toolCallId 的格式要求不同：
- OpenAI/Anthropic: 任意字符串
- Mistral: 严格的 9 字母数字字符 (`strict9`)
- 某些提供商: 仅字母数字 (`strict`)

```typescript
// src/agents/tool-call-id.ts
export function sanitizeToolCallId(id: string, mode: ToolCallIdMode = "strict"): string {
  if (mode === "strict9") {
    const alphanumericOnly = id.replace(/[^a-zA-Z0-9]/g, "");
    if (alphanumericOnly.length >= 9) return alphanumericOnly.slice(0, 9);
    if (alphanumericOnly.length > 0) return shortHash(alphanumericOnly, 9);
    return shortHash("sanitized", 9);
  }

  const alphanumericOnly = id.replace(/[^a-zA-Z0-9]/g, "");
  return alphanumericOnly.length > 0 ? alphanumericOnly : "sanitizedtoolid";
}
```

**去重机制**：
由于清理可能产生冲突（如 `a|b` 和 `a:b` 都变成 `ab`），系统使用稳定的映射和后缀去重：

```typescript
function makeUniqueToolId(params: { id: string; used: Set<string>; mode: ToolCallIdMode }): string {
  const base = sanitizeToolCallId(params.id, params.mode).slice(0, 40);
  if (!params.used.has(base)) return base;

  const hash = shortHash(params.id);
  const candidate = `${clippedBase}_${hash}`;
  if (!params.used.has(candidate)) return candidate;

  for (let i = 2; i < 1000; i += 1) {
    const next = `${candidate.slice(0, 40 - suffix.length)}_${i}`;
    if (!params.used.has(next)) return next;
  }

  return `${candidate.slice(0, 40 - ts.length)}_${Date.now()}`;
}
```

### 8. 工具参数的安全读取
**评价**: 将参数校验逻辑封装成库，消除重复代码并确保一致性。

```typescript
// src/agents/tools/common.ts
export function readStringParam(
  params: Record<string, unknown>,
  key: string,
  options: StringParamOptions = {},
) {
  const { required = false, trim = true, label = key, allowEmpty = false } = options;

  // 支持 snake_case 和 camelCase
  const raw = readParamRaw(params, key);
  if (typeof raw !== "string") {
    if (required) throw new ToolInputError(`${label} required`);
    return undefined;
  }

  const value = trim ? raw.trim() : raw;
  if (!value && !allowEmpty) {
    if (required) throw new ToolInputError(`${label} required`);
    return undefined;
  }
  return value;
}

export function readNumberParam(
  params: Record<string, unknown>,
  key: string,
  options: { required?: boolean; integer?: boolean; strict?: boolean } = {},
): number | undefined {
  const { required = false, integer = false, strict = false } = options;

  // 支持数字和字符串
  if (typeof raw === "number" && Number.isFinite(raw)) value = raw;
  else if (typeof raw === "string") {
    const parsed = strict ? Number(raw) : Number.parseFloat(raw);
    if (Number.isFinite(parsed)) value = parsed;
  }

  if (value === undefined) {
    if (required) throw new ToolInputError(`${label} required`);
    return undefined;
  }
  return integer ? Math.trunc(value) : value;
}
```

**Snake Case 支持**：
```typescript
function readParamRaw(params: Record<string, unknown>, key: string): unknown {
  if (Object.hasOwn(params, key)) return params[key];
  const snakeKey = toSnakeCaseKey(key);  // maxRetries → max_retries
  if (snakeKey !== key && Object.hasOwn(params, snakeKey)) {
    return params[snakeKey];
  }
  return undefined;
}
```

### 9. 所有者专用工具 (Owner-Only Tools)
**评价**: 这是一个简单但有效的**多租户安全机制**。

某些工具（如 `whatsapp_login`, `cron`, `gateway`）仅允许所有者执行：

```typescript
// src/agents/tool-policy.ts
const OWNER_ONLY_TOOL_NAME_FALLBACKS = new Set<string>(["whatsapp_login", "cron", "gateway"]);

export function applyOwnerOnlyToolPolicy(tools: AnyAgentTool[], senderIsOwner: boolean) {
  const withGuard = tools.map((tool) => {
    if (!isOwnerOnlyTool(tool)) return tool;
    return wrapOwnerOnlyToolExecution(tool, senderIsOwner);
  });

  if (senderIsOwner) return withGuard;
  return withGuard.filter((tool) => !isOwnerOnlyTool(tool));
}

function wrapOwnerOnlyToolExecution(tool: AnyAgentTool, senderIsOwner: boolean): AnyAgentTool {
  if (tool.ownerOnly !== true || senderIsOwner || !tool.execute) return tool;
  return {
    ...tool,
    execute: async () => {
      throw new Error("Tool restricted to owner senders.");
    },
  };
}
```

**双重保护**：
1. 声明式：`tool.ownerOnly = true`
2. 回退列表：`OWNER_ONLY_TOOL_NAME_FALLBACKS`
3. 执行时包装：非所有者调用直接抛异常

### 10. Before Tool Call Hook 机制
**评价**: 将**前置逻辑**与工具执行解耦，实现横切关注点的优雅分离。

```typescript
// src/agents/pi-tool-definition-adapter.ts
execute: async (...args: ToolExecuteArgs): Promise<AgentToolResult<unknown>> => {
  const { toolCallId, params, onUpdate, signal } = splitToolExecuteArgs(args);
  let executeParams = params;

  try {
    if (!beforeHookWrapped) {
      const hookOutcome = await runBeforeToolCallHook({
        toolName: name,
        params,
        toolCallId,
      });
      if (hookOutcome.blocked) {
        throw new Error(hookOutcome.reason);
      }
      executeParams = hookOutcome.params;  // 使用修改后的参数
    }

    const rawResult = await tool.execute(toolCallId, executeParams, signal, onUpdate);
    const result = normalizeToolExecutionResult({ toolName: normalizedName, result: rawResult });
    return result;
  } catch (err) {
    if (signal?.aborted) throw err;
    return jsonResult({ status: "error", tool: normalizedName, error: described.message });
  }
}
```

**Hook 用途**：
- 参数验证和规范化
- 权限检查
- 速率限制
- 审计日志
- 参数重写（如路径展开）

---

## 一、Tool 系统架构总览

### 1.1 整体架构图

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Tool System Architecture                        │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐           │
│  │   AI Model   │────▶│  Pi SDK      │────▶│ Tool Invoke  │           │
│  │  (Claude)    │     │  Agent Core │     │  Handler     │           │
│  └──────────────┘     └──────────────┘     └──────────────┘           │
│                                  │                   │                 │
│                                  ▼                   ▼                 │
│  ┌──────────────────────────────────────────────────────────────┐     │
│  │                    Tool Policy Pipeline                      │     │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────┐  │     │
│  │  │ Profile │ │Provider │ │ Global  │ │  Agent  │ │Group│  │     │
│  │  │   1     │ │   2     │ │   3     │ │   4     │ │  5  │  │     │
│  │  └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────┘  │     │
│  └──────────────────────────────────────────────────────────────┘     │
│                                  │                                     │
│                                  ▼                                     │
│  ┌──────────────────────────────────────────────────────────────┐     │
│  │                    Tool Registry                               │     │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐       │     │
│  │  │   Core   │ │ Plugin   │ │  Client  │ │ Custom   │       │     │
│  │  │  Tools   │ │  Tools   │ │  Tools   │ │  Tools   │       │     │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘       │     │
│  └──────────────────────────────────────────────────────────────┘     │
│                                  │                                     │
│                                  ▼                                     │
│  ┌──────────────────────────────────────────────────────────────┐     │
│  │                   Tool Execution Layer                        │     │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐       │     │
│  │  │ Loop     │ │  Result  │ │  Call ID │ │  Sandbox │       │     │
│  │  │ Detect   │ │Truncation│ │ Sanitize │ │   Guard  │       │     │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘       │     │
│  └──────────────────────────────────────────────────────────────┘     │
│                                  │                                     │
│                                  ▼                                     │
│  ┌──────────────────────────────────────────────────────────────┐     │
│  │                    Tool Implementations                       │     │
│  │  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐   │     │
│  │  │ read │ │write │ │ edit │ │ exec │ │browser│ │memory│   │     │
│  │  └──────┘ └──────┘ └──────┘ └──────┘ └──────┘ └──────┘   │     │
│  └──────────────────────────────────────────────────────────────┘     │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 1.2 核心组件清单

| 文件 | 职责 | 关键类型/函数 |
|------|------|--------------|
| `src/agents/tool-catalog.ts` | 工具目录定义 | `CORE_TOOL_DEFINITIONS`, `CORE_TOOL_GROUPS` |
| `src/agents/tool-policy-pipeline.ts` | 策略管道 | `buildDefaultToolPolicyPipelineSteps()` |
| `src/agents/tool-policy.ts` | 策略解析 | `expandToolGroups()`, `normalizeToolName()` |
| `src/agents/pi-tool-definition-adapter.ts` | Pi SDK 适配 | `toToolDefinitions()` |
| `src/agents/tool-loop-detection.ts` | 循环检测 | `detectToolCallLoop()`, `recordToolCall()` |
| `src/agents/pi-embedded-runner/tool-result-truncation.ts` | 结果截断 | `truncateToolResultText()` |
| `src/agents/tool-call-id.ts` | ID 清理 | `sanitizeToolCallId()` |
| `src/agents/sandbox/tool-policy.ts` | 沙箱策略 | `isToolAllowed()`, `resolveSandboxToolPolicyForAgent()` |
| `src/agents/tool-fs-policy.ts` | 文件系统策略 | `resolveEffectiveToolFsWorkspaceOnly()` |
| `src/agents/tools/common.ts` | 工具通用工具 | `readStringParam()`, `jsonResult()`, `imageResult()` |

---

## 二、核心工具定义

### 2.1 工具目录

OpenClaw 定义了 **21 个核心工具**，分为 11 个功能域：

| 功能域 | 工具 |
|--------|------|
| `fs` | read, write, edit, apply_patch |
| `runtime` | exec, process |
| `web` | web_search, web_fetch |
| `memory` | memory_search, memory_get |
| `sessions` | sessions_list, sessions_history, sessions_send, sessions_spawn, subagents, session_status |
| `ui` | browser, canvas |
| `messaging` | message |
| `automation` | cron, gateway |
| `nodes` | nodes |
| `agents` | agents_list |
| `media` | image, tts |

### 2.2 Profile 预设

```typescript
// src/agents/tool-catalog.ts
const CORE_TOOL_PROFILES: Record<ToolProfileId, ToolProfilePolicy> = {
  minimal: {
    allow: ["session_status"],  // 仅会话状态
  },
  coding: {
    allow: [
      // 文件系统
      "read", "write", "edit", "apply_patch",
      // 运行时
      "exec", "process",
      // 记忆
      "memory_search", "memory_get",
      // 会话
      "sessions_list", "sessions_history", "sessions_send", "sessions_spawn", "subagents",
      // 媒体
      "image",
      // UI
      "browser",
      // 自动化
      "cron",
    ],
  },
  messaging: {
    allow: ["sessions_list", "sessions_history", "sessions_send", "message"],
  },
  full: {},  // 允许所有工具
};
```

### 2.3 工具元数据

```typescript
type CoreToolDefinition = {
  id: string;                // 工具 ID
  label: string;             // 显示名称
  description: string;       // 描述
  sectionId: string;         // 所属功能域
  profiles: ToolProfileId[]; // 所属 profile
  includeInOpenClawGroup?: boolean;  // 是否包含在 group:openclaw 中
};
```

---

## 三、工具策略系统

### 3.1 策略类型

```typescript
export type ToolPolicyLike = {
  allow?: string[];  // 允许列表
  deny?: string[];   // 拒绝列表
};
```

**优先级规则**：
1. `deny` 优先于 `allow`
2. 精确匹配优先于通配符
3. 后层策略可覆盖前层

### 3.2 工具组扩展

```typescript
export function expandToolGroups(list?: string[]): string[] {
  const normalized = normalizeToolList(list);
  const expanded: string[] = [];
  for (const value of normalized) {
    const group = TOOL_GROUPS[value];
    if (group) {
      expanded.push(...group);  // 展开组
      continue;
    }
    expanded.push(value);
  }
  return Array.from(new Set(expanded));  // 去重
}
```

**示例**：
```javascript
expandToolGroups(["group:fs", "exec"])
// → ["read", "write", "edit", "apply_patch", "exec"]
```

### 3.3 插件工具组

```typescript
export type PluginToolGroups = {
  all: string[];              // 所有插件工具
  byPlugin: Map<string, string[]>;  // 按 pluginId 分组
};

export function expandPluginGroups(
  list: string[] | undefined,
  groups: PluginToolGroups,
): string[] | undefined {
  if (!list || list.length === 0) return list;

  const expanded: string[] = [];
  for (const entry of list) {
    if (entry === "group:plugins") {
      expanded.push(...groups.all);  // 展开所有插件工具
      continue;
    }
    const tools = groups.byPlugin.get(entry);
    if (tools && tools.length > 0) {
      expanded.push(...tools);  // 展开特定插件的工具
      continue;
    }
    expanded.push(entry);
  }
  return Array.from(new Set(expanded));
}
```

---

## 四、循环检测系统

### 4.1 检测器类型

| 检测器 | 触发条件 | 级别 | 行为 |
|--------|----------|------|------|
| `generic_repeat` | 相同调用 10+ 次 | warning | 警告 |
| `known_poll_no_progress` | 轮询无进度 10+ 次 | warning → critical | 警告 → 阻塞 |
| `ping_pong` | 交替调用 10+ 次 | warning → critical | 警告 → 阻塞 |
| `global_circuit_breaker` | 任何无进度 30+ 次 | critical | 阻塞 |

### 4.2 调用哈希

```typescript
export function hashToolCall(toolName: string, params: unknown): string {
  return `${toolName}:${digestStable(params)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).toSorted();  // 键排序保证稳定性
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}`;
}
```

### 4.3 结果哈希

```typescript
function hashToolOutcome(toolName: string, params: unknown, result: unknown, error: unknown): string | undefined {
  if (error !== undefined) {
    return `error:${digestStable(formatErrorForHash(error))}`;
  }

  // 对已知轮询工具的特殊处理
  if (isKnownPollToolCall(toolName, params)) {
    return digestStable({
      action: params.action,
      status: details.status,
      exitCode: details.exitCode ?? null,
      text: extractTextContent(result),
    });
  }

  return digestStable({ details, text: extractTextContent(result) });
}
```

### 4.4 Ping-Pong 检测

```
历史记录:
  [tool=A, args=X, result=R1]
  [tool=B, args=Y, result=R2]
  [tool=A, args=X, result=R1]  ← 相同参数和结果
  [tool=B, args=Y, result=R2]  ← 相同参数和结果
  [tool=A, args=X, ...]        ← 当前调用

检测器发现:
  - A 和 B 交替调用
  - 最近 5 次调用都是这个模式
  - A 的结果一直是 R1，B 的结果一直是 R2（无进展）

结论: Ping-pong 死锁
```

---

## 五、工具结果截断

### 5.1 大小限制

```typescript
const MAX_TOOL_RESULT_CONTEXT_SHARE = 0.3;  // 单个工具最多占 30% 上下文
const HARD_MAX_TOOL_RESULT_CHARS = 400_000; // 硬上限 40 万字符

export function calculateMaxToolResultChars(contextWindowTokens: number): number {
  const maxTokens = Math.floor(contextWindowTokens * 0.3);
  const maxChars = maxTokens * 4;  // 粗略 1 token = 4 chars
  return Math.min(maxChars, 400_000);
}
```

### 5.2 截断策略

```typescript
export function truncateToolResultText(text: string, maxChars: number): string {
  if (hasImportantTail(text) && budget > minKeepChars * 2) {
    // Head + Tail 模式
    const tailBudget = Math.min(Math.floor(budget * 0.3), 4_000);
    const headBudget = budget - tailBudget - MIDDLE_OMISSION_MARKER.length;
    return text.slice(0, headCut) + "[... middle omitted ...]" + text.slice(tailStart) + suffix;
  }
  // Head-only 模式
  return text.slice(0, cutPoint) + suffix;
}
```

### 5.3 会话文件截断

```typescript
export async function truncateOversizedToolResultsInSession(params: {
  sessionFile: string;
  contextWindowTokens: number;
}): Promise<{ truncated: boolean; truncatedCount: number }> {
  const sessionManager = SessionManager.open(sessionFile);
  const branch = sessionManager.getBranch();

  // 找到所有超大的工具结果
  const oversizedIndices: number[] = [];
  for (let i = 0; i < branch.length; i++) {
    if (entry.type === "message" && isToolResult(entry.message)) {
      const textLength = getToolResultTextLength(entry.message);
      if (textLength > maxChars) oversizedIndices.push(i);
    }
  }

  if (oversizedIndices.length === 0) return { truncated: false, truncatedCount: 0 };

  // 从第一个超大条目的父节点分支
  const firstOversizedIdx = oversizedIndices[0];
  const branchFromId = branch[firstOversizedIdx].parentId;
  sessionManager.branch(branchFromId);

  // 重新附加所有条目，截断超大的工具结果
  for (let i = firstOversizedIdx; i < branch.length; i++) {
    const entry = branch[i];
    if (entry.type === "message" && oversizedSet.has(i)) {
      const truncated = truncateToolResultMessage(entry.message, maxChars);
      sessionManager.appendMessage(truncated);
    }
  }

  return { truncated: true, truncatedCount: oversizedIndices.length };
}
```

---

## 六、工具调用 ID 处理

### 6.1 清理模式

```typescript
export type ToolCallIdMode = "strict" | "strict9";

export function sanitizeToolCallId(id: string, mode: ToolCallIdMode = "strict"): string {
  if (mode === "strict9") {
    // Mistral 要求严格的 9 字母数字字符
    const alphanumericOnly = id.replace(/[^a-zA-Z0-9]/g, "");
    if (alphanumericOnly.length >= 9) return alphanumericOnly.slice(0, 9);
    if (alphanumericOnly.length > 0) return shortHash(alphanumericOnly, 9);
    return shortHash("sanitized", 9);
  }

  // 通用模式：仅字母数字
  const alphanumericOnly = id.replace(/[^a-zA-Z0-9]/g, "");
  return alphanumericOnly.length > 0 ? alphanumericOnly : "sanitizedtoolid";
}
```

### 6.2 去重机制

由于清理可能产生冲突，系统使用稳定的映射和后缀去重：

```typescript
function makeUniqueToolId(params: { id: string; used: Set<string>; mode: ToolCallIdMode }): string {
  const base = sanitizeToolCallId(params.id, params.mode).slice(0, 40);
  if (!params.used.has(base)) return base;

  // 添加哈希后缀
  const hash = shortHash(params.id);
  const candidate = `${clippedBase}_${hash}`;
  if (!params.used.has(candidate)) return candidate;

  // 添加数字后缀
  for (let i = 2; i < 1000; i += 1) {
    const next = `${candidate.slice(0, 40 - suffix.length)}_${i}`;
    if (!params.used.has(next)) return next;
  }

  // 最后手段：添加时间戳
  const ts = `_${Date.now()}`;
  return `${candidate.slice(0, 40 - ts.length)}${ts}`;
}
```

### 6.3 消息重写

```typescript
export function sanitizeToolCallIdsForCloudCodeAssist(
  messages: AgentMessage[],
  mode: ToolCallIdMode = "strict",
): AgentMessage[] {
  const map = new Map<string, string>();
  const used = new Set<string>();

  const resolve = (id: string) => {
    const existing = map.get(id);
    if (existing) return existing;
    const next = makeUniqueToolId({ id, used, mode });
    map.set(id, next);
    used.add(next);
    return next;
  };

  return messages.map((msg) => {
    if (msg.role === "assistant") {
      return rewriteAssistantToolCallIds({ message: msg, resolve });
    }
    if (msg.role === "toolResult") {
      return rewriteToolResultIds({ message: msg, resolve });
    }
    return msg;
  });
}
```

---

## 七、沙箱工具策略

### 7.1 沙箱默认配置

```typescript
// src/agents/sandbox/constants.ts
export const DEFAULT_TOOL_ALLOW = [
  "session_status",
  "image",  // 多模态工作流必需
];

export const DEFAULT_TOOL_DENY: string[] = [];
```

### 7.2 策略解析

```typescript
export function resolveSandboxToolPolicyForAgent(
  cfg?: OpenClawConfig,
  agentId?: string,
): SandboxToolPolicyResolved {
  const agentConfig = cfg && agentId ? resolveAgentConfig(cfg, agentId) : undefined;

  // 优先级：Agent → Global → Default
  const allow = Array.isArray(agentConfig?.tools?.sandbox?.tools?.allow)
    ? agentConfig.tools.sandbox.tools.allow
    : Array.isArray(cfg?.tools?.sandbox?.tools?.allow)
      ? cfg.tools.sandbox.tools.allow
      : [...DEFAULT_TOOL_ALLOW];

  const deny = Array.isArray(agentConfig?.tools?.sandbox?.tools?.deny)
    ? agentConfig.tools.sandbox.tools.deny
    : Array.isArray(cfg?.tools?.sandbox?.tools?.deny)
      ? cfg.tools.sandbox.tools.deny
      : [...DEFAULT_TOOL_DENY];

  return { allow: expandToolGroups(allow), deny: expandToolGroups(deny), sources: {...} };
}
```

### 7.3 工具允许检查

```typescript
export function isToolAllowed(policy: SandboxToolPolicy, name: string): boolean {
  const normalized = normalizeGlob(name);
  const deny = compileGlobPatterns({ raw: expandToolGroups(policy.deny ?? []), normalize: normalizeGlob });
  if (matchesAnyGlobPattern(normalized, deny)) return false;

  const allow = compileGlobPatterns({ raw: expandToolGroups(policy.allow ?? []), normalize: normalizeGlob });
  if (allow.length === 0) return true;  // 空允许列表 = 允许所有
  return matchesAnyGlobPattern(normalized, allow);
}
```

---

## 八、工具实现示例

### 8.1 工具定义结构

```typescript
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { readStringParam, ToolInputError, jsonResult } from "./common.js";

export const readTool: AgentTool<{ filePath: string }, unknown> = {
  name: "read",
  label: "read",
  description: "Read the contents of a file",
  parameters: {
    type: "object",
    properties: {
      filePath: { type: "string", description: "Path to the file to read" },
      limit: { type: "number", description: "Maximum number of bytes to read" },
    },
    required: ["filePath"],
  },

  async execute(toolCallId, params, signal, onUpdate): Promise<AgentToolResult<unknown>> {
    // 参数验证
    const filePath = readStringParam(params, "filePath", { required: true });
    const limit = readNumberParam(params, "limit");

    // 执行逻辑
    const content = await fs.readFile(filePath, "utf-8");

    // 返回结果
    return {
      content: [{ type: "text", text: content }],
      details: { filePath, size: content.length },
    };
  },
};
```

### 8.2 辅助函数

```typescript
// JSON 结果
export function jsonResult(payload: unknown): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

// 图片结果
export async function imageResultFromFile(params: {
  label: string;
  path: string;
  extraText?: string;
}): Promise<AgentToolResult<unknown>> {
  const buf = await fs.readFile(params.path);
  const mimeType = (await detectMime({ buffer: buf.slice(0, 256) })) ?? "image/png";
  return {
    content: [
      { type: "text", text: params.extraText ?? `MEDIA:${params.path}` },
      { type: "image", data: buf.toString("base64"), mimeType },
    ],
    details: { path: params.path },
  };
}
```

---

## 九、Pi SDK 集成

### 9.1 工具定义适配

```typescript
export function toToolDefinitions(tools: AnyAgentTool[]): ToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name || "tool",
    label: tool.label ?? name,
    description: tool.description ?? "",
    parameters: tool.parameters,
    execute: async (...args: ToolExecuteArgs): Promise<AgentToolResult<unknown>> => {
      const { toolCallId, params, onUpdate, signal } = splitToolExecuteArgs(args);

      // Before Tool Call Hook
      const hookOutcome = await runBeforeToolCallHook({ toolName: name, params, toolCallId });
      if (hookOutcome.blocked) throw new Error(hookOutcome.reason);

      // 执行工具
      const rawResult = await tool.execute(toolCallId, hookOutcome.params, signal, onUpdate);

      // 规范化结果
      return normalizeToolExecutionResult({ toolName: name, result: rawResult });
    },
  }));
}
```

### 9.2 工具分割

```typescript
export function splitSdkTools(options: {
  tools: AnyAgentTool[];
  sandboxEnabled: boolean;
}): {
  builtInTools: AnyAgentTool[];
  customTools: ReturnType<typeof toToolDefinitions>;
} {
  return {
    builtInTools: [],  // 不使用 SDK 内置工具
    customTools: toToolDefinitions(options.tools),  // 全部通过 customTools
  };
}
```

---

## 十、作者的技术权衡

### 10.1 工具组 vs 扁平配置

**选择**: 分层工具组

**优势**：
- 语义化配置（`group:fs` vs `["read", "write", ...]`）
- 易于扩展（新工具自动加入组）
- 跨插件一致性（`group:plugins` 包含所有插件工具）

**代价**：
- 需要维护组定义
- 学习曲线略高

### 10.2 七层策略管道 vs 单层配置

**选择**: 七层管道

**优势**：
- 细粒度控制（Profile → Provider → Agent → Group）
- 配置继承和覆盖清晰
- 支持插件生态

**代价**：
- 调试复杂度高
- 需要良好的文档

### 10.3 循环检测的主动干预

**选择**: 检测到循环时阻塞执行

**优势**：
- 防止资源浪费
- 避免 API 费用失控
- 提供清晰的错误消息

**代价**：
- 可能误杀正常重试
- 需要配置调整阈值

---

## 十一、相关源码文件索引

| 文件路径 | 行数 | 核心功能 |
|---------|------|----------|
| `src/agents/tool-catalog.ts` | ~327 | 核心工具定义、分组、Profile |
| `src/agents/tool-policy-pipeline.ts` | ~109 | 策略管道构建和应用 |
| `src/agents/tool-policy.ts` | ~206 | 策略解析、插件组扩展 |
| `src/agents/tool-policy-shared.ts` | ~50 | 工具名规范化、组扩展 |
| `src/agents/pi-tool-definition-adapter.ts` | ~200+ | Pi SDK 工具适配 |
| `src/agents/tool-loop-detection.ts` | ~624 | 循环检测、哈希、历史记录 |
| `src/agents/pi-embedded-runner/tool-result-truncation.ts` | ~397 | 工具结果截断 |
| `src/agents/tool-call-id.ts` | ~269 | 工具调用 ID 清理和去重 |
| `src/agents/sandbox/tool-policy.ts` | ~110 | 沙箱工具策略 |
| `src/agents/tool-fs-policy.ts` | ~32 | 文件系统策略 |
| `src/agents/tools/common.ts` | ~341 | 参数读取、结果构造 |

---

## 附录 A：Tool 与 Node 的关系

### A.1 架构关系图

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    Tool 与 Node 的交互架构                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌──────────────┐                                                         │
│  │   AI Agent   │                                                         │
│  │  (Claude)    │                                                         │
│  └──────┬───────┘                                                         │
│         │                                                                │
│         ▼                                                                │
│  ┌──────────────────────────────────────────────────────────────┐      │
│  │                    Tool 调用接口层                              │      │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │      │
│  │  │   exec   │  │ process  │  │  nodes   │  │  ...     │   │      │
│  │  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────────┘   │      │
│  └───────┼─────────────┼─────────────┼───────────────────────────┘      │
│          │             │             │                                   │
│          ▼             ▼             ▼                                   │
│  ┌──────────────────────────────────────────────────────────────┐      │
│  │                    执行路径选择                                │      │
│  │                                                               │      │
│  │  ┌────────────┐     ┌────────────┐                            │      │
│  │  │ 直接执行    │     │ Node-Host   │                            │      │
│  │  │ (Gateway)  │     │ (子进程)    │                            │      │
│  │  └────────────┘     └──────┬─────┘                            │      │
│  └─────────────────────────────┼───────────────────────────────────┘      │
│                                │                                           │
│                                ▼                                           │
│  ┌──────────────────────────────────────────────────────────────┐      │
│  │                    Node-Host 系统                              │      │
│  │  ┌────────────────────────────────────────────────────────┐   │      │
│  │  │  system.run.prepare → system.run → system.execApprovals  │   │      │
│  │  └────────────────────────────────────────────────────────┘   │      │
│  └──────────────────────────────────────────────────────────────┘      │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### A.2 Tool 如何使用 Node

#### 1. `nodes` 工具 - 直接与 Node-Host 通信

`nodes` 工具是 Tool 与 Node-Host 的**主要桥梁**，提供以下功能：

| Action | 功能 | Node-Host 命令 |
|--------|------|---------------|
| `run` | 在远程节点执行命令 | `system.run.prepare` → `system.run` |
| `invoke` | 调用任意 Node-Host 命令 | 任意命令（如 `browser.proxy`） |
| `status` | 列出所有节点 | `node.list` |
| `describe` | 获取节点详情 | `node.describe` |
| `notify` | 发送系统通知 | `system.notify` |
| `camera_snap` | 拍照 | `camera.snap` |
| `screen_record` | 屏幕录制 | `screen.record` |

**执行流程**：
```typescript
// 1. 调用 nodes tool 的 run action
await callGatewayTool("node.invoke", gatewayOpts, {
  nodeId,
  command: "system.run.prepare",
  params: { command: ["ls", "-la"] },
});

// 2. 获取审批计划
const prepared = parsePreparedSystemRunPayload(response.payload);

// 3. 实际执行
await callGatewayTool("node.invoke", gatewayOpts, {
  nodeId,
  command: "system.run",
  params: { command: prepared.plan.argv, ... },
});
```

#### 2. `exec` 工具 - 可选的 Node-Host 路由

`exec` 工具支持多种执行宿主：

```typescript
type ExecHost = "sandbox" | "gateway" | "node";

// 优先级顺序
const hostOrder = [
  "node",      // Node-Host（远程执行）
  "gateway",   // Gateway（本地执行）
  "sandbox",   // 沙箱（隔离执行）
];
```

### A.3 依赖关系总结

```
Tool 系统
    │
    ├── nodes tool ───────────┐
    │                          │ 直接依赖
    ├── exec tool ─────────────┤
    │                          │
    └── process tool ───────────┘
                               │
                               ▼
                        Node-Host 系统
                               │
                    ┌──────────┴──────────┐
                    │                     │
               system.run            browser.proxy
               system.exec            ...
```

**关键点**：
1. **Tool 是接口层** - 定义 AI Agent 可调用的功能
2. **Node-Host 是执行层** - 提供安全的远程命令执行能力
3. **nodes tool 是桥梁** - 让 Tool 可以调用 Node-Host 的能力
4. **可选依赖** - exec tool 可以选择是否使用 Node-Host

---

## 附录 B：Gateway 类型工具与扩展

### B.1 什么是 Gateway 类型工具？

**Gateway 工具** 是一种特殊的 Tool 类型，它通过 **WebSocket 连接** 与 Gateway 服务器通信，调用 Gateway 的 **Server Methods** 来实现功能。

**评价**: 这种设计将 **Tool 接口** 与 **业务实现** 完全解耦，AI Agent 只需调用统一的 `callGatewayTool()`，无需关心底层是本地执行还是远程 RPC。

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    Gateway 工具架构                                      │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌──────────────┐                                                         │
│  │   AI Agent   │                                                         │
│  │  (Claude)    │                                                         │
│  └──────┬───────┘                                                         │
│         │                                                                │
│         ▼                                                                │
│  ┌──────────────────────────────────────────────────────────────┐      │
│  │                  Tool 执行层                                   │      │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │      │
│  │  │ gateway  │  │  nodes   │  │  agents  │  │ sessions │   │      │
│  │  │  tool    │  │  tool    │  │  tool    │  │   tool   │   │      │
│  │  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘   │      │
│  └───────┼─────────────┼─────────────┼─────────────┼─────────────┘      │
│          │             │             │             │                    │
│          ▼             ▼             ▼             ▼                    │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │                    callGatewayTool()                              │  │
│  │                    src/gateway/callGatewayTool()                   │  │
│  └─────────────────────────────┬─────────────────────────────────────┘  │
│                                │                                         │
│                                ▼                                         │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │                  Gateway WebSocket 连接                            │  │
│  │                    ws://localhost:18789                            │  │
│  └─────────────────────────────┬─────────────────────────────────────┘  │
│                                │                                         │
│                                ▼                                         │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │              Gateway Server Methods (命令处理器)                     │  │
│  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ │  │
│  │  │   config    │ │    nodes    │ │   agents    │ │  sessions   │ │  │
│  │  │  Handlers   │ │  Handlers   │ │  Handlers   │ │  Handlers   │ │  │
│  │  └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘ │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### B.2 现有的 Gateway 工具

| 工具名称 | 文件位置 | Actions 数 | 主要功能 |
|---------|---------|-----------|---------|
| `gateway` | `src/agents/tools/gateway-tool.ts` | 6 | 配置管理、Gateway 重启、更新 |
| `nodes` | `src/agents/tools/nodes-tool.ts` | 9 | 节点管理、远程命令执行 |
| `agents` | `src/agents/tools/agents-tool.ts` | 4 | Agent 管理 |
| `sessions` | `src/agents/tools/sessions-tool.ts` | 6 | 会话管理 |

#### 1. `gateway` 工具

```typescript
// src/agents/tools/gateway-tool.ts
export const gatewayTool: AgentToolGatewayActions = {
  name: "gateway",
  label: "Gateway",
  description: "Manage Gateway configuration and operations",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["restart", "config.get", "config.schema.lookup", "config.apply", "config.patch", "update.run"],
        description: "The action to perform",
      },
      // ... 其他参数
    },
    required: ["action"],
  },

  async execute(toolCallId, params, signal, onUpdate) {
    const { action, ...rest } = params;

    switch (action) {
      case "restart":
        return await handleGatewayRestart(rest);
      case "config.get":
        return await callGatewayTool("config.get", gatewayOpts, undefined);
      case "config.schema.lookup":
        return await callGatewayTool("config.schema.lookup", gatewayOpts, rest);
      case "config.apply":
        return await callGatewayTool("config.apply", gatewayOpts, rest);
      case "config.patch":
        return await callGatewayTool("config.patch", gatewayOpts, rest);
      case "update.run":
        return await callGatewayTool("update.run", gatewayOpts, rest);
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  },
};
```

#### 2. `nodes` 工具

```typescript
// src/agents/tools/nodes-tool.ts
export const nodesTool: AgentToolNodesActions = {
  name: "nodes",
  label: "Nodes",
  description: "Manage remote nodes and execute commands",
  actions: {
    run: "Run a command on a remote node",
    invoke: "Invoke any node command",
    status: "List all connected nodes",
    describe: "Get details about a specific node",
    notify: "Send a system notification",
    camera_snap: "Take a photo",
    screen_record: "Record screen",
    // ...
  },
  // ... 类似的 execute 实现
};
```

### B.3 Gateway Server Methods 完整列表

Gateway 服务器支持以下命令（定义在 `src/gateway/server-methods-list.ts`）：

#### 配置管理
| 命令 | 功能 | 处理器位置 |
|------|------|-----------|
| `config.get` | 获取配置 | `src/gateway/server-methods/config.ts` |
| `config.set` | 设置配置 | `src/gateway/server-methods/config.ts` |
| `config.apply` | 应用配置（带重启） | `src/gateway/server-methods/config.ts` |
| `config.patch` | 补丁配置 | `src/gateway/server-methods/config.ts` |
| `config.schema` | 获取配置 Schema | `src/gateway/server-methods/config.ts` |
| `config.schema.lookup` | 查询特定配置 Schema | `src/gateway/server-methods/config.ts` |

#### 节点管理
| 命令 | 功能 | 处理器位置 |
|------|------|-----------|
| `node.list` | 列出所有节点 | `src/gateway/server-methods/nodes.ts` |
| `node.describe` | 获取节点详情 | `src/gateway/server-methods/nodes.ts` |
| `node.rename` | 重命名节点 | `src/gateway/server-methods/nodes.ts` |
| `node.invoke` | 调用节点命令 | `src/gateway/server-methods/nodes.ts` |
| `node.pair.request` | 请求配对 | `src/gateway/server-methods/nodes.ts` |
| `node.pair.approve` | 批准配对 | `src/gateway/server-methods/nodes.ts` |
| `node.pair.reject` | 拒绝配对 | `src/gateway/server-methods/nodes.ts` |
| `node.pair.verify` | 验证配对 | `src/gateway/server-methods/nodes.ts` |
| `node.canvas.capability.refresh` | 刷新 Canvas 能力 | `src/gateway/server-methods/nodes.ts` |

#### Agent 管理
| 命令 | 功能 | 处理器位置 |
|------|------|-----------|
| `agents.list` | 列出所有 Agent | `src/gateway/server-methods/agents.ts` |
| `agents.create` | 创建新 Agent | `src/gateway/server-methods/agents.ts` |
| `agents.update` | 更新 Agent | `src/gateway/server-methods/agents.ts` |
| `agents.delete` | 删除 Agent | `src/gateway/server-methods/agents.ts` |
| `agents.files.list` | 列出 Agent 文件 | `src/gateway/server-methods/agents.ts` |
| `agents.files.get` | 获取 Agent 文件内容 | `src/gateway/server-methods/agents.ts` |
| `agents.files.set` | 设置 Agent 文件内容 | `src/gateway/server-methods/agents.ts` |

#### 会话管理
| 命令 | 功能 | 处理器位置 |
|------|------|-----------|
| `sessions.list` | 列出所有会话 | `src/gateway/server-methods/sessions.ts` |
| `sessions.preview` | 预览会话内容 | `src/gateway/server-methods/sessions.ts` |
| `sessions.get` | 获取会话详情 | `src/gateway/server-methods/sessions.ts` |
| `sessions.patch` | 更新会话 | `src/gateway/server-methods/sessions.ts` |
| `sessions.reset` | 重置会话 | `src/gateway/server-methods/sessions.ts` |
| `sessions.delete` | 删除会话 | `src/gateway/server-methods/sessions.ts` |
| `sessions.compact` | 压缩会话 | `src/gateway/server-methods/sessions.ts` |

#### 其他命令
| 类别 | 命令 |
|------|------|
| **健康检查** | `health`, `doctor.memory.status` |
| **日志** | `logs.tail` |
| **渠道** | `channels.status`, `channels.logout` |
| **模型** | `models.list` |
| **工具** | `tools.catalog` |
| **技能** | `skills.status`, `skills.bins`, `skills.install`, `skills.update` |
| **Cron** | `cron.list`, `cron.status`, `cron.add`, `cron.update`, `cron.remove`, `cron.run`, `cron.runs` |
| **TTS** | `tts.status`, `tts.providers`, `tts.enable`, `tts.disable`, `tts.convert`, `tts.setProvider` |
| **VoiceWake** | `voicewake.get`, `voicewake.set` |
| **Talk** | `talk.config`, `talk.mode` |
| **Exec Approvals** | `exec.approvals.get`, `exec.approvals.set`, `exec.approvals.node.get`, `exec.approvals.node.set` |
| **Wizard** | `wizard.start`, `wizard.next`, `wizard.cancel`, `wizard.status` |
| **Usage** | `usage.status`, `usage.cost` |
| **Update** | `update.run` |
| **Secrets** | `secrets.reload`, `secrets.resolve` |
| **Browser** | `browser.request` |
| **Agent** | `agent`, `agent.identity.get`, `agent.wait` |
| **Send** | `send` |
| **Chat** | `chat.history`, `chat.abort`, `chat.send` |

### B.4 如何扩展 Gateway 类型工具

#### 步骤 1：定义新的 Tool

在 `src/agents/tools/` 下创建新文件，例如 `my-custom-tool.ts`：

```typescript
// src/agents/tools/my-custom-tool.ts
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { callGatewayTool, type GatewayCallOptions } from "../gateway.js";

export interface MyCustomToolParams {
  action: "doSomething" | "doAnotherThing";
  param1?: string;
  param2?: number;
}

export const myCustomTool: AgentTool<MyCustomToolParams, unknown> = {
  name: "myCustom",
  label: "My Custom Tool",
  description: "Does custom things via Gateway",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["doSomething", "doAnotherThing"],
        description: "The action to perform",
      },
      param1: { type: "string", description: "First parameter" },
      param2: { type: "number", description: "Second parameter" },
    },
    required: ["action"],
  },

  async execute(toolCallId, params, signal, onUpdate) {
    const { action, ...rest } = params as MyCustomToolParams;

    // 准备 Gateway 调用选项
    const gatewayOpts: GatewayCallOptions = {
      method: "myCustom.method",  // 你的 Gateway 方法名
      expectFinal: true,
    };

    switch (action) {
      case "doSomething":
        // 调用 Gateway 方法
        return await callGatewayTool("myCustom.doSomething", gatewayOpts, rest);

      case "doAnotherThing":
        return await callGatewayTool("myCustom.doAnotherThing", gatewayOpts, rest);

      default:
        throw new Error(`Unknown action: ${action}`);
    }
  },
};
```

#### 步骤 2：注册 Tool 到目录

在 `src/agents/tool-catalog.ts` 中添加：

```typescript
// src/agents/tool-catalog.ts
import { myCustomTool } from "./tools/my-custom-tool.js";

export const CORE_TOOLS: CoreToolDefinition[] = [
  // ... 其他工具
  {
    id: "myCustom",
    label: "My Custom",
    description: "Does custom things via Gateway",
    sectionId: "automation",
    sectionLabel: "Automation",
    profiles: ["full"],  // 或 ["coding", "full"]
    includeInOpenClawGroup: true,
  },
];
```

在 `src/agents/tools/index.ts` 中导出：

```typescript
export * from "./my-custom-tool.js";
```

#### 步骤 3：实现 Gateway Server Method

在 `src/gateway/server-methods/` 下创建 `my-custom.ts`：

```typescript
// src/gateway/server-methods/my-custom.ts
import {
  ErrorCodes,
  errorShape,
  validateMyCustomParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

export const myCustomHandlers: GatewayRequestHandlers = {
  "myCustom.doSomething": async ({ params, respond }) => {
    // 参数验证
    if (!validateMyCustomParams(params)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Invalid params"),
      );
      return;
    }

    const { param1, param2 } = params as { param1?: string; param2?: number };

    try {
      // 实现你的逻辑
      const result = await doSomething(param1, param2);

      respond(true, { ok: true, result }, undefined);
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, String(error)),
      );
    }
  },

  "myCustom.doAnotherThing": async ({ params, respond }) => {
    // 类似实现
    // ...
  },
};

async function doSomething(param1?: string, param2?: number) {
  // 你的业务逻辑
  return { success: true, data: "..." };
}
```

#### 步骤 4：注册 Handler 到 Gateway

在 `src/gateway/server-methods.ts` 中导入并添加：

```typescript
// src/gateway/server-methods.ts
import { myCustomHandlers } from "./server-methods/my-custom.js";

export const coreGatewayHandlers: GatewayRequestHandlers = {
  // ... 其他 handlers
  ...myCustomHandlers,
};
```

#### 步骤 5：添加参数验证（可选）

在 `src/gateway/protocol/` 中添加验证器：

```typescript
// src/gateway/protocol/validators.ts
export function validateMyCustomParams(params: unknown): params is MyCustomParams {
  // 验证逻辑
  return true;
}
```

#### 步骤 6：添加到方法列表（可选）

在 `src/gateway/server-methods-list.ts` 中添加：

```typescript
const BASE_METHODS = [
  // ... 其他方法
  "myCustom.doSomething",
  "myCustom.doAnotherThing",
];
```

### B.5 完整示例：添加一个新的 Gateway 工具

假设我们要添加一个 `backup` 工具，支持备份和恢复操作：

#### 1. 创建 Tool (`src/agents/tools/backup-tool.ts`)

```typescript
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { callGatewayTool, type GatewayCallOptions } from "../gateway.js";

export const backupTool: AgentTool = {
  name: "backup",
  label: "Backup",
  description: "Backup and restore operations",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["create", "restore", "list"],
        description: "The backup action to perform",
      },
      name: { type: "string", description: "Backup name" },
      path: { type: "string", description: "Path to backup/restore" },
    },
    required: ["action"],
  },

  async execute(toolCallId, params, signal, onUpdate) {
    const { action, ...rest } = params;
    const gatewayOpts: GatewayCallOptions = {
      method: `backup.${action}`,
      expectFinal: true,
    };

    return await callGatewayTool(`backup.${action}`, gatewayOpts, rest);
  },
};
```

#### 2. 创建 Server Methods (`src/gateway/server-methods/backup.ts`)

```typescript
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

export const backupHandlers: GatewayRequestHandlers = {
  "backup.create": async ({ params, respond }) => {
    try {
      const { name, path } = params as { name?: string; path?: string };
      // 实现备份逻辑
      const backupId = await createBackup(name, path);
      respond(true, { ok: true, backupId }, undefined);
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(error)));
    }
  },

  "backup.restore": async ({ params, respond }) => {
    // 实现恢复逻辑
  },

  "backup.list": async ({ params, respond }) => {
    // 实现列表逻辑
  },
};
```

#### 3. 注册到系统

在相应的 `index.ts` 和 `tool-catalog.ts` 中添加导出和注册。

### B.6 调试 Gateway 工具

#### 启用详细日志

```bash
# 启用 Gateway 详细日志
OPENCLAW_LOG=gateway=debug openclaw gateway run
```

#### 使用 WebSocket 客户端测试

```javascript
// test-gateway-tool.js
import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:18789');

ws.on('open', () => {
  // 发送测试请求
  ws.send(JSON.stringify({
    req: { id: 'test-1', method: 'backup.list', params: {} },
    token: 'your-auth-token',
  }));
});

ws.on('message', (data) => {
  console.log('Response:', JSON.parse(data));
});
```

### B.7 常见问题

**Q: 什么时候应该使用 Gateway 工具而不是直接在 Tool 中实现？**

A: 当你的功能需要：
- 访问 Gateway 管理的状态（配置、会话、节点列表等）
- 执行需要 Gateway 权限的操作
- 跨多个 Agent 共享状态
- 需要与 Gateway 的其他子系统交互（如渠道、Cron 等）

**Q: Gateway 工具和普通工具有什么性能差异？**

A: Gateway 工具需要 WebSocket 通信，有额外的序列化/反序列化开销。但大多数情况下这个开销可忽略，而且 Gateway 方便了集中管理和权限控制。

**Q: 如何确保 Gateway 方法的权限控制？**

A: Gateway 在 `server-methods.ts` 中有 `authorizeGatewayMethod()` 函数，会根据 client 的 role 和 scopes 进行权限验证。确保你的方法在正确的角色下可访问。

---

*本文档持续更新中...*
