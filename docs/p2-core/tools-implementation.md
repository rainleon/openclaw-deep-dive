# OpenClaw 架构探索：Tool 技术底层实现

> **Leon 的评价**: 这份文档是**硬核技术向**的——不讲分类使用场景，只讲**怎么实现的**。从 Tool 定义到执行流程，从参数解析到结果返回，从 SDK 适配到错误处理，全部基于源码。

---

## 最核心的技术洞察 (Top 10)

### 1. Tool 执行的完整调用链：四层封装
**Leon 的评价**: 这条调用链**设计得相当复杂**，但每层都有明确职责。AI 调用 Tool 时，实际穿过四层封装：`AgentTool` → `toToolDefinitions()` → `ToolDefinition` → `execute()` → 实际业务逻辑。**分层解耦做得很好**，但调试时要跳过四层才能找到真正问题。

```
AI Agent
    ↓
pi-embedded (运行时)
    ↓
toToolDefinitions(tools[])  ← 适配器层：转换为 SDK 格式
    ↓
ToolDefinition.execute()    ← 执行器层：参数解析、Hook、错误处理
    ↓
实际业务逻辑 (read/exec/...)
```

**源码证据**：
```typescript
// src/agents/pi-tool-definition-adapter.ts:137
export function toToolDefinitions(tools: AnyAgentTool[]): ToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name || "tool",
    label: tool.label ?? name,
    description: tool.description ?? "",
    parameters: tool.parameters,
    execute: async (...args: ToolExecuteArgs): Promise<AgentToolResult<unknown>> => {
      // Hook、参数处理、错误包装
    },
  }));
}
```

### 2. 参数系统的双层处理：原始参数 → 规范化参数
**Leon 的评价**: 参数处理**有两个层次**。第一层在 `splitToolExecuteArgs()` 中拆分 SDK 参数顺序（兼容新旧 API），第二层在各个 Tool 内部用 `readStringParam()` 等函数进行类型转换和验证。**兼容性和安全性都兼顾了**。

**源码证据**：
```typescript
// 兼容新旧 SDK 参数顺序
type ToolExecuteArgsCurrent = [
  string,      // toolCallId
  unknown,     // params
  AbortSignal | undefined,
  AgentToolUpdateCallback<unknown> | undefined,
  unknown,
];

type ToolExecuteArgsLegacy = [
  string,      // toolCallId
  unknown,     // params
  AgentToolUpdateCallback<unknown> | undefined,
  unknown,      // ctx
  AbortSignal | undefined,
];

function splitToolExecuteArgs(args: ToolExecuteArgsAny) {
  if (isLegacyToolExecuteArgs(args)) {
    const [toolCallId, params, onUpdate, _ctx, signal] = args;
    return { toolCallId, params, onUpdate, signal };
  }
  const [toolCallId, params, signal, onUpdate] = args;
  return { toolCallId, params, onUpdate, signal };
}
```

### 3. 错误处理的"友好化"：所有错误都转换为 text 结果
**Leon 的评价**: 这个设计**相当聪明**。Tool 执行出错时，不是抛异常终止整个会话，而是返回一个包含错误信息的 `AgentToolResult`。这样 AI 可以看到错误信息并继续尝试其他方案。**这是容错性的关键设计**。

**源码证据**：
```typescript
// src/agents/pi-tool-definition-adapter.ts:168-190
} catch (err) {
  // 区分 abort 和其他错误
  if (signal?.aborted) {
    throw err;  // abort 直接抛出
  }

  const described = describeToolExecutionError(err);
  logError(`[tools] ${normalizedName} failed: ${described.message}`);

  // 返回错误结果，而不是抛异常
  return jsonResult({
    status: "error",
    tool: normalizedName,
    error: described.message,
  });
}
```

### 4. Before Tool Call Hook：拦截/修改参数的统一入口
**Leon 的评价**: Hook 系统**设计得很灵活**。`runBeforeToolCallHook()` 在任何 Tool 执行前都会被调用，可以拦截调用（blocked=true）或修改参数（params 替换）。这是**插件系统和安全控制的基础设施**。

**源码证据**：
```typescript
// src/agents/pi-tool-definition-adapter.ts:151-161
const hookOutcome = await runBeforeToolCallHook({
  toolName: name,
  params,
  toolCallId,
});
if (hookOutcome.blocked) {
  throw new Error(hookOutcome.reason);  // 被拦截
}
executeParams = hookOutcome.params;  // 参数被修改
```

### 5. exec Tool 的三宿主架构：sandbox | gateway | node
**Leon 的评价**: 这个设计**极其灵活**。exec 工具可以在三种宿主中运行：
1. **sandbox** - 隔离环境（最安全）
2. **gateway** - 本地直接执行（折中）
3. **node** - 远程节点执行（最强大）

**宿主选择逻辑**：
```typescript
// 1. 用户指定
let host = requestedHost ?? configuredHost;

// 2. elevated 模式强制使用 gateway
if (elevatedRequested) {
  host = "gateway";
}

// 3. 各宿主的特殊处理
if (host === "node") {
  return executeNodeHostCommand({...});
}
if (host === "gateway") {
  await processGatewayAllowlist({...});
}
if (host === "sandbox") {
  await resolveSandboxWorkdir({...});
}
```

**源码位置**：`src/agents/bash-tools.exec.ts:300-500`

### 6. 后台执行机制：yieldMs/background = 自动转入后台
**Leon 的评价**: 后台执行**设计得很巧妙**。当指定 `yieldMs` 或 `background=true` 时，命令会自动转入后台，Tool 立即返回一个 `status: "running"` 的结果。AI 可以用 `process` 工具继续管理这些后台任务。**这是长时间运行任务的优雅解决方案**。

**源码证据**：
```typescript
// 后台触发时机
const yieldWindow = allowBackground
  ? backgroundRequested ? 0 : clampWithDefault(params.yieldMs, defaultBackgroundMs)
  : null;

// 立即返回 running 状态
if (allowBackground && yieldWindow !== null) {
  if (yieldWindow === 0) {
    onYieldNow();  // 立即转入后台
  } else {
    yieldTimer = setTimeout(() => {
      markBackgrounded(run.session);
      resolveRunning();  // 返回 running 状态
    }, yieldWindow);
  }
}
```

### 7. 结果截断策略：Head + Tail 模式保护上下文
**Leon 的评价**: **这是个务实的设计**。工具输出可能非常大（几十万字符），如果全部塞给 AI 会撑爆上下文窗口。所以采用 Head + Tail 截断策略——保留开头和结尾，中间用 `[... middle omitted ...]` 标记。**既保留了关键信息，又控制了成本**。

**截断逻辑**：
```typescript
// src/agents/pi-embedded-runner/tool-result-truncation.ts
if (hasImportantTail(text) && budget > minKeepChars * 2) {
  const tailBudget = Math.min(Math.floor(budget * 0.3), 4_000);
  const headBudget = budget - tailBudget - MIDDLE_OMISSION_MARKER.length;
  return text.slice(0, headCut) + "[... middle omitted ...]" + text.slice(tailStart);
}
```

**源码位置**：`src/agents/pi-embedded-runner/tool-result-truncation.ts`

### 8. 参数验证的 snake_case 兼容：camelCase → snake_case
**Leon 的评价**: 这个细节处理得**相当到位**。AI 可能生成 `filePath` 或 `file_path`，参数读取器会自动尝试两种格式。**这是应对 AI 不确定性的实用主义设计**。

**源码证据**：
```typescript
// src/agents/tools/common.ts:63-72
function readParamRaw(params: Record<string, unknown>, key: string): unknown {
  if (Object.hasOwn(params, key)) {
    return params[key];
  }
  const snakeKey = toSnakeCaseKey(key);  // filePath → file_path
  if (snakeKey !== key && Object.hasOwn(params, snakeKey)) {
    return params[snakeKey];
  }
  return undefined;
}
```

### 9. Owner-Only 工具的运行时包装：权限检查移至执行时
**Leon 的评价**: 这个设计**很巧妙**。`ownerOnly` 工具不会被过滤掉，而是在执行时才会检查权限——如果非 owner 调用，直接返回错误。**这是声明式权限检查的实现**。

**源码证据**：
```typescript
// src/agents/tools/common.ts:242-255
export function wrapOwnerOnlyToolExecution(
  tool: AnyAgentTool,
  senderIsOwner: boolean,
): AnyAgentTool {
  if (tool.ownerOnly !== true || senderIsOwner || !tool.execute) {
    return tool;  // 不需要包装
  }
  return {
    ...tool,
    execute: async () => {
      throw new Error(OWNER_ONLY_TOOL_ERROR);  // 执行时检查
    },
  };
}
```

### 10. Client Tool 的"pending"模式：执行委托给客户端
**Leon 的评价**: **这是个有趣的设计**。有些工具（如 OpenResponses 的 hosted tools）不适合在服务端执行，而是返回一个 `status: "pending"` 的结果，告诉客户端"你来执行"。**这是跨端协作的桥梁**。

**源码证据**：
```typescript
// src/agents/pi-tool-definition-adapter.ts:228-232
return jsonResult({
  status: "pending",
  tool: func.name,
  message: "Tool execution delegated to client",
});
```

---

## 一、Tool 定义结构

### 1.1 核心 Type 定义

```typescript
// 来自 @mariozechner/pi-agent-core
type AgentTool<TParams = unknown, TResult = unknown> = {
  name: string;                      // 工具唯一标识
  label?: string;                    // 显示名称
  description?: string;              // 工具描述
  parameters?: JSONSchema;           // 参数 Schema
  execute: (
    toolCallId: string,
    params: TParams,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TResult> | undefined,
  ) => Promise<AgentToolResult<TResult>>;
};

type AgentToolResult<T> = {
  content: Array<{
    type: "text" | "image" | "audio";
    text?: string;
    data?: string;     // base64
    mimeType?: string;
  }>;
  details?: T;
};
```

### 1.2 工具定义示例

```typescript
// 简单工具：读取文件
export const readTool: AgentTool<{ filePath: string }, { content: string }> = {
  name: "read",
  label: "read",
  description: "Read the contents of a file",
  parameters: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "Path to the file to read",
      },
    },
    required: ["filePath"],
  },
  async execute(toolCallId, params, signal, onUpdate) {
    const content = await fs.readFile(params.filePath, "utf-8");
    return {
      content: [{ type: "text", text: content }],
      details: { filePath: params.filePath },
    };
  },
};

// 复杂工具：支持多个 action
export type GatewayToolParams =
  | { action: "restart" }
  | { action: "config.get"; path?: string }
  | { action: "config.patch"; raw: string };

export const gatewayTool: AgentTool<GatewayToolParams> = {
  name: "gateway",
  label: "Gateway",
  description: "Gateway control",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["restart", "config.get", "config.patch"],
      },
      // ... 其他参数
    },
    required: ["action"],
  },
  async execute(toolCallId, params, signal, onUpdate) {
    switch (params.action) {
      case "restart":
        return await handleGatewayRestart();
      case "config.get":
        return await callGatewayTool("config.get", {}, params);
      // ...
    }
  },
};
```

---

## 二、Tool 执行流程

### 2.1 完整执行时序图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Tool 执行流程                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  AI Agent                                                                     │
│    │                                                                         │
│    ▼                                                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  pi-embedded 运行层                                                   │   │
│  │                                                                         │   │
│  │  1. 构建 ToolDefinition[] (通过 toToolDefinitions)                       │   │
│  │     ├── 规范化 tool name                                                  │   │
│  │     ├── 包装 execute 函数                                                 │   │
│  │     └── 添加 Hook 调用点                                               │   │
│  │                                                                         │   │
│  │  2. 传递给 Pi SDK                                                        │   │
│  │                                                                         │   │
│  │  ┌───────────────────────────────────────────────────────────────────┐ │   │
│  │  │  ToolDefinition.execute()                                           │ │   │
│  │  │                                                                     │ │   │
│  │  │  ┌───────────────────────────────────────────────────────────┐ │ │   │
│  │  │  │  Before Tool Call Hook (拦截/修改参数)                          │ │ │   │
│  │  │  │  runBeforeToolCallHook({ toolName, params, toolCallId })      │ │ │   │
│  │  │  │  └───────────────────────────────────────────────────────────┘ │ │   │
│  │  │                                                                     │ │   │
│  │  │  ┌───────────────────────────────────────────────────────────┐ │ │   │
│  │  │  │  参数解析 (splitToolExecuteArgs)                                  │ │ │   │
│  │  │  │  └───────────────────────────────────────────────────────────┘ │ │   │
│  │  │                                                                     │ │   │
│  │  │  ┌───────────────────────────────────────────────────────────┐ │ │   │
│  │  │  │  Tool.execute() 调用                                               │ │ │   │
│  │  │  │                                                                     │ │ │   │
│  │  │  │  │  ├── readStringParam() 等参数验证                                │ │ │ │   │
│  │  │  │  │  ├── 业务逻辑执行                                                │ │ │ │   │
│  │  │  │  │  └── 结果构造                                                      │ │ │ │   │
│  │  │  │  └───────────────────────────────────────────────────────────┘ │ │   │
│  │  │                                                                     │ │   │
│  │  │  ┌───────────────────────────────────────────────────────────┐ │ │   │
│  │  │  │  结果规范化 (normalizeToolExecutionResult)                          │ │ │   │
│  │  │  │  └───────────────────────────────────────────────────────────┘ │ │   │
│  │  │                                                                     │ │   │
│  │  │  ┌───────────────────────────────────────────────────────────┐ │ │   │
│  │  │  │  错误处理 (catch → jsonResult with status=error)                   │ │ │   │
│  │  │  │  └───────────────────────────────────────────────────────────┘ │ │   │
│  │  │                                                                     │ │   │
│  │  │  └───────────────────────────────────────────────────────────────┘ │   │
│  │                                                                         │   │
│  │  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  └───────────────────────────────────────────────────────────────────────────┘
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 执行入口：`toToolDefinitions()`

```typescript
// src/agents/pi-tool-definition-adapter.ts:137-194
export function toToolDefinitions(tools: AnyAgentTool[]): ToolDefinition[] {
  return tools.map((tool) => {
    const name = tool.name || "tool";
    const normalizedName = normalizeToolName(name);
    const beforeHookWrapped = isToolWrappedWithBeforeToolCallHook(tool);

    return {
      name,
      label: tool.label ?? name,
      description: tool.description ?? "",
      parameters: tool.parameters,
      execute: async (...args: ToolExecuteArgs): Promise<AgentToolResult<unknown>> => {
        // 1. 拆分参数（兼容新旧 API）
        const { toolCallId, params, onUpdate, signal } = splitToolExecuteArgs(args);
        let executeParams = params;

        try {
          // 2. Before Tool Call Hook
          if (!beforeHookWrapped) {
            const hookOutcome = await runBeforeToolCallHook({
              toolName: name,
              params,
              toolCallId,
            });
            if (hookOutcome.blocked) {
              throw new Error(hookOutcome.reason);
            }
            executeParams = hookOutcome.params;
          }

          // 3. 调用实际 Tool
          const rawResult = await tool.execute(toolCallId, executeParams, signal, onUpdate);

          // 4. 规范化结果
          const result = normalizeToolExecutionResult({
            toolName: normalizedName,
            result: rawResult,
          });
          return result;
        } catch (err) {
          // 5. 错误处理
          if (signal?.aborted) {
            throw err;
          }

          const described = describeToolExecutionError(err);
          logError(`[tools] ${normalizedName} failed: ${described.message}`);

          // 返回错误结果，而不是抛异常
          return jsonResult({
            status: "error",
            tool: normalizedName,
            error: described.message,
          });
        }
      },
    } satisfies ToolDefinition;
  });
}
```

---

## 三、参数处理机制

### 3.1 参数读取工具集

```typescript
// src/agents/tools/common.ts

// 字符串参数（支持 camelCase 和 snake_case）
export function readStringParam(
  params: Record<string, unknown>,
  key: string,
  options: StringParamOptions = {},
): string | undefined {
  const { required = false, trim = true, label = key, allowEmpty = false } = options;
  const raw = readParamRaw(params, key);  // 自动尝试两种格式

  if (typeof raw !== "string") {
    if (required) {
      throw new ToolInputError(`${label} required`);
    }
    return undefined;
  }

  const value = trim ? raw.trim() : raw;
  if (!value && !allowEmpty) {
    if (required) {
      throw new ToolInputError(`${label} required`);
    }
    return undefined;
  }
  return value;
}

// 数字参数（支持字符串和数字）
export function readNumberParam(
  params: Record<string, unknown>,
  key: string,
  options: {
    required?: boolean;
    label?: string;
    integer?: boolean;    // 是否只接受整数
    strict?: boolean;     // 是否严格模式（Number() vs parseFloat）
  } = {},
): number | undefined {
  const { required = false, label = key, integer = false, strict = false } = options;
  const raw = readParamRaw(params, key);
  let value: number | undefined;

  if (typeof raw === "number" && Number.isFinite(raw)) {
    value = raw;
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed) {
      const parsed = strict ? Number(trimmed) : Number.parseFloat(trimmed);
      if (Number.isFinite(parsed)) {
        value = parsed;
      }
    }
  }

  if (value === undefined) {
    if (required) {
      throw new ToolInputError(`${label} required`);
    }
    return undefined;
  }

  return integer ? Math.trunc(value) : value;
}

// 字符串数组参数
export function readStringArrayParam(
  params: Record<string, unknown>,
  key: string,
  options: StringParamOptions = {},
): string[] | undefined {
  const { required = false, label = key } = options;
  const raw = readParamRaw(params, key);

  if (Array.isArray(raw)) {
    const values = raw
      .filter((entry) => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (values.length === 0 && required) {
      throw new ToolInputError(`${label} required`);
    }
    return values;
  }

  if (typeof raw === "string") {
    const value = raw.trim();
    if (!value && required) {
      throw new ToolInputError(`${label} required`);
    }
    return [value];
  }

  if (required) {
    throw new ToolInputError(`${label} required`);
  }
  return undefined;
}
```

### 3.2 snake_case 转换实现

```typescript
function toSnakeCaseKey(key: string): string {
  return key
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")   // camelCase → camel_Case
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")   // camelCase → camel_Case
    .toLowerCase();
}

// 示例：
// filePath → file_path
// filePathOld → file_path_old
// parseHTML → parse_html
```

---

## 四、结果返回机制

### 4.1 结果结构

```typescript
type AgentToolResult<T> = {
  content: Array<{
    type: "text" | "image" | "audio";
    text?: string;      // type="text" 时必需
    data?: string;      // type="image" 时为 base64
    mimeType?: string;  // type="image/audio" 时必需
  }>;
  details?: T;          // 任意结构化数据
};
```

### 4.2 结果构造工具

```typescript
// JSON 结果（最常用）
export function jsonResult(payload: unknown): AgentToolResult<unknown> {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
    details: payload,
  };
}

// 图片结果
export async function imageResultFromFile(params: {
  label: string;
  path: string;
  extraText?: string;
  details?: Record<string, unknown>;
  imageSanitization?: ImageSanitizationLimits;
}): Promise<AgentToolResult<unknown>> {
  const buf = await fs.readFile(params.path);
  const mimeType = (await detectMime({ buffer: buf.slice(0, 256) })) ?? "image/png";

  return await imageResult({
    label: params.label,
    path: params.path,
    base64: buf.toString("base64"),
    mimeType,
    extraText: params.extraText,
    details: params.details,
    imageSanitization: params.imageSanitization,
  });
}
```

### 4.3 结果规范化

```typescript
function normalizeToolExecutionResult(params: {
  toolName: string;
  result: unknown;
}): AgentToolResult<unknown> {
  const { toolName, result } = params;

  // 如果已经有标准 content[] 结构，直接返回
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>;
    if (Array.isArray(record.content)) {
      return result as AgentToolResult<unknown>;
    }

    // 否则，强制转换为标准格式
    logDebug(`tools: ${toolName} returned non-standard result (missing content[]); coercing`);
    const details = "details" in record ? record.details : record;
    const safeDetails = details ?? { status: "ok", tool: toolName };
    return {
      content: [
        {
          type: "text",
          text: stringifyToolPayload(safeDetails),
        },
      ],
      details: safeDetails,
    };
  }

  // 非 object 结果，转换为 JSON
  const safeDetails = result ?? { status: "ok", tool: toolName };
  return {
    content: [
      {
        type: "text",
        text: stringifyToolPayload(safeDetails),
      },
    ],
    details: safeDetails,
  };
}
```

---

## 五、exec Tool 实现深度剖析

### 5.1 exec Tool 的参数 Schema

```typescript
const execSchema = {
  type: "object",
  properties: {
    command: { type: "string", description: "Shell command to execute" },
    workdir: { type: "string", description: "Working directory" },
    env: {
      type: "object",
      description: "Environment variables",
      additionalProperties: { type: "string" },
    },
    yieldMs: {
      type: "number",
      description: "Yield after N ms (background continuation)",
    },
    background: {
      type: "boolean",
      description: "Run in background (continues after tool returns)",
    },
    timeout: { type: "number", description: "Timeout in seconds" },
    pty: { type: "boolean", description: "Use PTY (terminal UI)" },
    host: {
      type: "string",
      enum: ["sandbox", "gateway", "node"],
      description: "Execution host",
    },
    security: {
      type: "string",
      enum: ["deny", "allowlist", "full"],
      description: "Security policy",
    },
    ask: {
      type: "string",
      enum: ["off", "on-miss", "always"],
      description: "Approval requirement",
    },
    node: { type: "string", description: "Target node (for host=node)" },
    elevated: {
      type: "boolean",
      description: "Elevated permissions (owner only)",
    },
  },
  required: ["command"],
} as const;
```

### 5.2 宿主选择逻辑

```typescript
// 1. 获取默认宿主
const configuredHost = defaults?.host ?? "sandbox";
const sandboxHostConfigured = defaults?.host === "sandbox";
const requestedHost = normalizeExecHost(params.host) ?? null;

// 2. 确定 effective host
let host: ExecHost = requestedHost ?? configuredHost;

// 3. 非提升模式不能切换宿主
if (!elevatedRequested && requestedHost && requestedHost !== configuredHost) {
  throw new Error(
    `exec host not allowed (requested ${renderExecHostLabel(requestedHost)}; ` +
    `configure tools.exec.host=${renderExecHostLabel(configuredHost)} to allow).`
  );
}

// 4. 提升模式强制使用 gateway
if (elevatedRequested) {
  host = "gateway";
}
```

### 5.3 三种宿主的执行路径

```typescript
// ===== 1. Node Host (远程执行) =====
if (host === "node") {
  return executeNodeHostCommand({
    command: params.command,
    workdir,
    env,
    requestedNode: params.node?.trim(),
    boundNode: defaults?.node?.trim(),
    sessionKey: defaults?.sessionKey,
    agentId,
    security,
    ask,
    timeoutSec: params.timeout,
    // ...
  });
}

// ===== 2. Gateway (本地执行，有审批) =====
if (host === "gateway" && !bypassApprovals) {
  const gatewayResult = await processGatewayAllowlist({
    command: params.command,
    workdir,
    env,
    security,
    ask,
    safeBins,
    safeBinProfiles,
    // ...
  });

  if (gatewayResult.pendingResult) {
    return gatewayResult.pendingResult;  // 等待审批
  }

  execCommandOverride = gatewayResult.execCommandOverride;
}

// ===== 3. Sandbox (隔离执行) =====
if (host === "sandbox") {
  const resolved = await resolveSandboxWorkdir({
    workdir: rawWorkdir,
    sandbox,
    warnings,
  });

  // 构建沙箱环境变量
  const env = buildSandboxEnv({
    defaultPath: DEFAULT_PATH,
    paramsEnv: params.env,
    sandboxEnv: sandbox.env,
    containerWorkdir: resolved.containerWorkdir,
  });
}

// ===== 4. 实际执行 =====
const run = await runExecProcess({
  command: params.command,
  execCommand: execCommandOverride,
  workdir,
  env,
  sandbox,
  usePty: params.pty === true && !sandbox,
  maxOutput,
  onUpdate,
});
```

### 5.4 后台执行机制

```typescript
// 关键状态
let yielded = false;
let yieldTimer: NodeJS.Timeout | null = null;

// Yield 触发器
const onYieldNow = () => {
  if (yieldTimer) {
    clearTimeout(yieldTimer);
  }
  if (yielded) {
    return;
  }
  yielded = true;
  markBackgrounded(run.session);
  resolveRunning();  // 立即返回 running 状态
};

// 自动 yield 逻辑
if (allowBackground && yieldWindow !== null) {
  if (yieldWindow === 0) {
    onYieldNow();  // 立即 yield
  } else {
    yieldTimer = setTimeout(() => {
      if (yielded) {
        return;
      }
      yielded = true;
      markBackgrounded(run.session);
      resolveRunning();
    }, yieldWindow);
  }
}

// 返回给 AI 的结果
{
  content: [{
    type: "text",
    text: `Command still running (session ${run.session.id}, pid ${run.session.pid}). Use process (list/poll/log/write/kill/clear/remove) for follow-up.`
  }],
  details: {
    status: "running",
    sessionId: run.session.id,
    pid: run.session.pid,
    startedAt: run.startedAt,
    cwd: run.session.cwd,
  }
}
```

---

## 六、并行执行机制

### 6.1 Tool 并行调用

```typescript
// AI 可能同时调用多个工具
const results = await Promise.all([
  readTool.execute(..., { filePath: "file1.txt" }),
  readTool.execute(..., { filePath: "file2.txt" }),
  execTool.execute(..., { command: "ls -la" }),
]);
```

### 6.2 onUpdate 回调（流式输出）

```typescript
type AgentToolUpdateCallback<T> = (update: {
  contentDelta?: string;
  content?: Array<{ type: "text" | "image"; ... }>;
  details?: T;
}) => void;

// Tool 执行过程中可以发送增量更新
async execute(toolCallId, params, signal, onUpdate) {
  // 长时间运行的任务可以发送进度
  if (onUpdate) {
    onUpdate({
      contentDelta: "Processing file 1/10...",
    });
  }

  const result = await doHeavyWork();

  return {
    content: [{ type: "text", text: result }],
  };
}
```

### 6.3 Abort Signal 传递

```typescript
async execute(toolCallId, params, signal, onUpdate) {
  // 设置 abort 监听
  const onAbortSignal = () => {
    if (yielded || run.session.backgrounded) {
      return;  // 后台任务不杀
    }
    run.kill();  // 杀死前台任务
  };

  if (signal?.aborted) {
    onAbortSignal();
  } else if (signal) {
    signal.addEventListener("abort", onAbortSignal, { once: true });
  }

  // 执行...
}
```

---

## 七、错误处理机制

### 7.1 错误类型

```typescript
// 工具输入错误
export class ToolInputError extends Error {
  readonly status: number = 400;  // HTTP 400
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

// 工具授权错误
export class ToolAuthorizationError extends ToolInputError {
  override readonly status = 403;  // HTTP 403
  constructor(message: string) {
    super(message);
    this.name = "ToolAuthorizationError";
  }
}
```

### 7.2 错误包装策略

```typescript
// 所有工具执行都被 try-catch 包裹
try {
  const rawResult = await tool.execute(toolCallId, executeParams, signal, onUpdate);
  return normalizeToolExecutionResult({ toolName, result: rawResult });
} catch (err) {
  // 区分 abort 和普通错误
  if (signal?.aborted) {
    throw err;  // abort 直接抛出，终止会话
  }

  // 其他错误转换为结果
  const described = describeToolExecutionError(err);
  logError(`[tools] ${toolName} failed: ${described.message}`);

  return jsonResult({
    status: "error",
    tool: toolName,
    error: described.message,
  });
}
```

### 7.3 错误信息构造

```typescript
function describeToolExecutionError(err: unknown): {
  message: string;
  stack?: string;
} {
  if (err instanceof Error) {
    const message = err.message?.trim() ? err.message : String(err);
    return { message, stack: err.stack };
  }
  return { message: String(err) };
}
```

---

## 八、Hook 系统

### 8.1 Before Tool Call Hook

```typescript
// Hook 接口
type BeforeToolCallHookResult = {
  blocked?: boolean;    // true = 拦截执行
  params?: unknown;     // 修改后的参数
  reason?: string;      // 拦截原因
};

// Hook 调用点
const hookOutcome = await runBeforeToolCallHook({
  toolName: name,
  params,
  toolCallId,
});

// 处理结果
if (hookOutcome.blocked) {
  throw new Error(hookOutcome.reason);  // 被拦截
}
executeParams = hookOutcome.params;  // 使用修改后的参数
```

### 8.2 Hook 使用场景

```typescript
// 场景 1：安全检查
function hookSafeFilePath(toolName: string, params: unknown): BeforeToolCallHookResult {
  if (toolName === "write") {
    const { filePath } = params as { filePath: string };
    if (filePath.startsWith("/etc/")) {
      return {
        blocked: true,
        reason: "Writing to /etc is not allowed",
      };
    }
  }
  return {};
}

// 场景 2：参数预处理
function hookInjectApiKey(toolName: string, params: unknown): BeforeToolCallHookResult {
  if (toolName === "web_fetch") {
    const { url, headers } = params as { url: string; headers?: Record<string, string> };
    return {
      params: {
        url,
        headers: { ...headers, "Authorization": `Bearer ${API_KEY}` },
      },
    };
  }
  return {};
}
```

---

## 九、相关源码文件索引

| 文件路径 | 行数 | 核心功能 |
|---------|------|----------|
| `src/agents/pi-tool-definition-adapter.ts` | ~237 | Tool 适配器、结果规范化 |
| `src/agents/tools/common.ts` | ~340 | 参数读取、结果构造 |
| `src/agents/bash-tools.exec.ts` | ~600 | exec Tool 实现 |
| `src/agents/pi-embedded-runner/run.ts` | ~200+ | Pi Agent 运行时 |
| `src/agents/pi-embedded-runner/tool-result-truncation.ts` | ~400 | 结果截断 |
| `src/agents/pi-tools.before-tool-call.ts` | ~100 | Hook 系统 |

---

*本文档持续更新中...*
