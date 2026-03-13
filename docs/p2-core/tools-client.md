# 10. Client Tool 跨端协作机制：执行委托给客户端

> OpenClaw 的 "pending" 模式让服务端定义工具、客户端执行工具，实现跨端协作。

---

## 核心技术洞察

### 1. 职责分离设计
服务端定义工具的 schema 和描述，告诉 AI "能做什么"；客户端负责实际执行。`status: "pending"` 是这个分离的关键状态标志。这种设计避免了在服务端硬编码各种客户端特定的执行逻辑，也让 AI 可以调用那些只有客户端才能执行的操作（如打开 modal、获取位置等）。

### 2. OpenResponses 协议兼容
OpenClaw 兼容 [OpenResponses](https://www.open-responses.com/) 规范——这是一个基于 OpenAI Responses API 的开放推理标准。这意味着任何支持 OpenResponses 的客户端都能对接 OpenClaw，而不是被锁定在专有协议上。

### 3. 数据流动链路
`onClientToolCall` → `clientToolCallDetected` → `attempt.clientToolCall` → `pendingToolCalls` → HTTP `function_call`。整个传递过程使用简单的变量赋值，没有引入复杂的异步队列，让数据流清晰可追踪。

### 4. Hook 机制不失效
即使是 client tools，也会经过 `runBeforeToolCallHook`。服务端插件仍可以修改参数或阻止调用。这避免了因为跨端执行而丧失服务端控制权的问题。

### 5. Session Key 派生
当请求包含 `user` 字段时，Gateway 会派生稳定的 session key，让无状态 HTTP 端点支持有状态会话。这是一个实用的设计细节。

### 6. 响应状态语义
当 AI 调用客户端工具时，响应状态是 `"incomplete"` 而非 `"completed"` 或 `"failed"`。这准确传达了"对话未结束，等待客户端返回工具结果"的语义。

### 7. call_id 关联机制
每次调用生成唯一的 `call_id`，客户端用它来关联工具执行结果。这是支持 `function_call_output` 回调的基础设计。

### 8. 安全边界明确
文档明确指出这个 endpoint 是 "full operator-access" 表面，建议只在 loopback/tailnet/private ingress 使用。没有模糊安全责任。

### 9. tool_choice 粒度控制
支持 `"none"` | `"required"` | `"auto"` | `{ type: "function" }`，让客户端可以精确控制 AI 的工具使用行为。

### 10. 流式/非流式一致性
无论是 streaming 还是 non-streaming，pending tool calls 都返回 `function_call` item。客户端只需一套处理逻辑。

---

## 一、核心概念：什么是 Client Tool？

### 定义

Client Tool（客户端工具）是由**调用方提供**的工具定义，而不是服务端内置的工具。

| 特性 | Server Tools (内置) | Client Tools (托管) |
|------|---------------------|---------------------|
| 定义位置 | 服务端代码 | 客户端请求 |
| 执行位置 | 服务端 | 客户端 |
| 工具 schema | `src/agents/tools/*` | HTTP 请求体 |
| 调用结果 | 服务端返回 | 客户端执行后上报 |

### 使用场景

```typescript
// 客户端发送的请求
{
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get current weather",
        "parameters": {
          "type": "object",
          "properties": {
            "city": { "type": "string" }
          }
        }
      }
    }
  ]
}
```

AI 看到的工具列表包括：
- 服务端内置工具（如 `bash.run`, `fs.write`）
- 客户端提供的工具（如 `get_weather`）

当 AI 决定调用 `get_weather` 时：
1. 服务端返回 `status: "pending"` + 工具调用信息
2. 客户端收到后自己执行 `get_weather`
3. 客户端将结果作为 `function_call_output` 发回
4. 服务端继续对话

---

## 二、技术架构：完整流程图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Client Tool 跨端协作流程                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐                  │
│  │   客户端      │───→│  Gateway     │───→│  Agent 核心   │                  │
│  │  (外部应用)   │    │  HTTP Handler│    │  (AI 推理)    │                  │
│  └──────────────┘    └──────────────┘    └──────────────┘                  │
│         │                   │                     │                         │
│         │ 1. POST /v1/responses                  │                         │
│         │    { tools: [...] }                    │                         │
│         │                   │                     │                         │
│         │                   │ 2. toClientToolDefinitions()                │
│         │                   │    转换工具为 ToolDefinition                 │
│         │                   │                     │                         │
│         │                   │                     │ 3. AI 选择调用工具       │
│         │                   │                     │                         │
│         │                   │ 4. onClientToolCall()                       │
│         │                   │    设置 clientToolCallDetected              │
│         │                   │                     │                         │
│         │ 5. Response:      │                     │                         │
│         │    { status: "incomplete",             │                         │
│         │      output: [{                         │
│         │        type: "function_call",          │
│         │        name: "get_weather",            │
│         │        arguments: "{...}"              │
│         │      }]}                                                               │
│         │◀──────────────────                     │                         │
│         │                                                                  │
│         │ 6. 客户端执行 get_weather()                                       │
│         │                                                                  │
│         │ 7. POST /v1/responses                                           │
│         │    { input: [{                                                 │
│         │        type: "function_call_output",                           │
│         │        call_id: "...",                                          │
│         │        output: "{...result...}"                                │
│         │      }]}                                                        │
│         │─────────────────→                                                │
│         │                   │ 8. 继续对话，AI 处理工具结果                │
│         │                   │                     │                         │
│         │ 9. 最终响应        │                     │                         │
│         │◀──────────────────                     │                         │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 三、源码分析：关键实现

### 3.1 工具定义转换 (`pi-tool-definition-adapter.ts`)

```typescript
// src/agents/pi-tool-definition-adapter.ts:196-236
export function toClientToolDefinitions(
  tools: ClientToolDefinition[],
  onClientToolCall?: (toolName: string, params: Record<string, unknown>) => void,
  hookContext?: HookContext,
): ToolDefinition[] {
  return tools.map((tool) => {
    const func = tool.function;
    return {
      name: func.name,
      label: func.name,
      description: func.description ?? "",
      parameters: func.parameters as ToolDefinition["parameters"],
      execute: async (...args: ToolExecuteArgs): Promise<AgentToolResult<unknown>> => {
        const { toolCallId, params } = splitToolExecuteArgs(args);

        // 关键：仍然运行 before_tool_call hook
        const outcome = await runBeforeToolCallHook({
          toolName: func.name,
          params,
          toolCallId,
          ctx: hookContext,
        });
        if (outcome.blocked) {
          throw new Error(outcome.reason);
        }

        const adjustedParams = outcome.params;
        const paramsRecord = isPlainObject(adjustedParams) ? adjustedParams : {};

        // 关键：通知处理器有客户端工具被调用
        if (onClientToolCall) {
          onClientToolCall(func.name, paramsRecord);
        }

        // 关键：返回 pending 状态，不执行工具
        return jsonResult({
          status: "pending",
          tool: func.name,
          message: "Tool execution delegated to client",
        });
      },
    } satisfies ToolDefinition;
  });
}
```

**说明**: `runBeforeToolCallHook` 的调用确保 client tools 也经过服务端策略检查。参数可以被修改，调用可以被阻止。

---

### 3.2 Agent 运行时集成 (`attempt.ts`)

```typescript
// src/agents/pi-embedded-runner/run/attempt.ts:1157-1177
// Add client tools (OpenResponses hosted tools) to customTools
let clientToolCallDetected: { name: string; params: Record<string, unknown> } | null = null;
const clientToolLoopDetection = resolveToolLoopDetectionConfig({
  cfg: params.config,
  agentId: sessionAgentId,
});

const clientToolDefs = clientTools
  ? toClientToolDefinitions(
      clientTools,
      (toolName, toolParams) => {
        // 回调：捕获工具调用
        clientToolCallDetected = { name: toolName, params: toolParams };
      },
      {
        agentId: sessionAgentId,
        sessionKey: sandboxSessionKey,
        sessionId: params.sessionId,
        runId: params.runId,
        loopDetection: clientToolLoopDetection,
      },
    )
  : [];

const allCustomTools = [...customTools, ...clientToolDefs];
```

```typescript
// src/agents/pi-embedded-runner/run/attempt.ts:2074-2075
// Client tool call detected (OpenResponses hosted tools)
clientToolCall: clientToolCallDetected ?? undefined,
```

```typescript
// src/agents/pi-embedded-runner/run.ts:1514-1528
// Handle client tool calls (OpenResponses hosted tools)
stopReason: attempt.clientToolCall
  ? "tool_calls"
  : (lastAssistant?.stopReason as string | undefined),
pendingToolCalls: attempt.clientToolCall
  ? [
      {
        id: randomBytes(5).toString("hex").slice(0, 9),
        name: attempt.clientToolCall.name,
        arguments: JSON.stringify(attempt.clientToolCall.params),
      },
    ]
  : undefined,
```

---

### 3.3 HTTP 响应构建 (`openresponses-http.ts`)

```typescript
// src/gateway/openresponses-http.ts:187-198
type PendingToolCall = { id: string; name: string; arguments: string };

function resolveStopReasonAndPendingToolCalls(meta: unknown): {
  stopReason: string | undefined;
  pendingToolCalls: PendingToolCall[] | undefined;
} {
  if (!meta || typeof meta !== "object") {
    return { stopReason: undefined, pendingToolCalls: undefined };
  }
  const record = meta as { stopReason?: string; pendingToolCalls?: PendingToolCall[] };
  return { stopReason: record.stopReason, pendingToolCalls: record.pendingToolCalls };
}
```

```typescript
// src/gateway/openresponses-http.ts:491-512
// If agent called a client tool, return function_call instead of text
if (stopReason === "tool_calls" && pendingToolCalls && pendingToolCalls.length > 0) {
  const functionCall = pendingToolCalls[0];
  const functionCallItemId = `call_${randomUUID()}`;
  const response = createResponseResource({
    id: responseId,
    model,
    status: "incomplete",  // 关键：状态是 incomplete
    output: [
      {
        type: "function_call",
        id: functionCallItemId,
        call_id: functionCall.id,  // 客户端需要这个 ID 来返回结果
        name: functionCall.name,
        arguments: functionCall.arguments,
      },
    ],
    usage,
  });
  sendJson(res, 200, response);
  return true;
}
```

---

## 四、完整请求/响应示例

### 4.1 初始请求（带 Client Tools）

```http
POST /v1/responses HTTP/1.1
Host: 127.0.0.1:18789
Authorization: Bearer YOUR_TOKEN
Content-Type: application/json

{
  "model": "openclaw:main",
  "input": "What's the weather in Tokyo?",
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get current weather for a city",
        "parameters": {
          "type": "object",
          "properties": {
            "city": { "type": "string", "description": "City name" }
          },
          "required": ["city"]
        }
      }
    }
  ]
}
```

### 4.2 服务端响应（Function Call）

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "resp_1234567890",
  "status": "incomplete",
  "output": [
    {
      "type": "function_call",
      "id": "call_abc123",
      "call_id": "a1b2c3d4e",
      "name": "get_weather",
      "arguments": "{\"city\":\"Tokyo\"}"
    }
  ],
  "usage": {
    "input_tokens": 150,
    "output_tokens": 50,
    "total_tokens": 200
  }
}
```

### 4.3 客户端执行并返回结果

```http
POST /v1/responses HTTP/1.1
Host: 127.0.0.1:18789
Authorization: Bearer YOUR_TOKEN
Content-Type: application/json

{
  "model": "openclaw:main",
  "input": [
    {
      "type": "function_call_output",
      "call_id": "a1b2c3d4e",
      "output": "{\"temperature\": 22, \"condition\": \"sunny\", \"humidity\": 45}"
    }
  ]
}
```

### 4.4 最终响应（AI 处理工具结果）

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "resp_9876543210",
  "status": "completed",
  "output": [
    {
      "type": "message",
      "id": "msg_xyz789",
      "role": "assistant",
      "content": [
        {
          "type": "output_text",
          "text": "The weather in Tokyo is currently sunny with a temperature of 22°C and humidity at 45%."
        }
      ],
      "status": "completed"
    }
  ],
  "usage": {
    "input_tokens": 200,
    "output_tokens": 80,
    "total_tokens": 280
  }
}
```

---

## 五、工具选择策略（`tool_choice`）

### 5.1 支持的策略

| 值 | 行为 | 示例 |
|---|------|------|
| `"none"` | 禁用所有工具 | `"tool_choice": "none"` |
| `"required"` | 必须调用工具 | `"tool_choice": "required"` |
| `"auto"` | AI 自主选择 | `"tool_choice": "auto"` (默认) |
| `{ type: "function" }` | 必须调用指定工具 | `{"type": "function", "function": {"name": "get_weather"}}` |

### 5.2 实现代码

```typescript
// src/gateway/openresponses-http.ts:104-143
function applyToolChoice(params: {
  tools: ClientToolDefinition[];
  toolChoice: CreateResponseBody["tool_choice"];
}): { tools: ClientToolDefinition[]; extraSystemPrompt?: string } {
  const { tools, toolChoice } = params;

  if (!toolChoice) {
    return { tools };
  }

  if (toolChoice === "none") {
    return { tools: [] };  // 移除所有工具
  }

  if (toolChoice === "required") {
    if (tools.length === 0) {
      throw new Error("tool_choice=required but no tools were provided");
    }
    return {
      tools,
      extraSystemPrompt: "You must call one of the available tools before responding.",
    };
  }

  if (typeof toolChoice === "object" && toolChoice.type === "function") {
    const targetName = toolChoice.function?.name?.trim();
    if (!targetName) {
      throw new Error("tool_choice.function.name is required");
    }
    const matched = tools.filter((tool) => tool.function?.name === targetName);
    if (matched.length === 0) {
      throw new Error(`tool_choice requested unknown tool: ${targetName}`);
    }
    return {
      tools: matched,  // 只保留匹配的工具
      extraSystemPrompt: `You must call the ${targetName} tool before responding.`,
    };
  }

  return { tools };
}
```

---

## 六、安全边界

### 6.1 认证机制

```
Gateway 认证 → OpenClaw 控制平面 → Agent 工具策略 → Client Tool 执行
```

### 6.2 安全注意事项

文档中明确警告：

> Treat this endpoint as a **full operator-access** surface for the gateway instance.
>
> - HTTP bearer auth here is not a narrow per-user scope model.
> - A valid Gateway token/password for this endpoint should be treated like an owner/operator credential.
> - Requests run through the same control-plane agent path as trusted operator actions.
> - There is no separate non-owner/per-user tool boundary on this endpoint.
> - **Keep this endpoint on loopback/tailnet/private ingress only; do not expose it directly to the public internet.**

### 6.3 URL 输入保护

对于 `input_file` 和 `input_image` URL 输入：

```typescript
// src/gateway/openresponses-http.ts:85-97
files: {
  ...fileLimits,
  urlAllowlist: normalizeInputHostnameAllowlist(files?.urlAllowlist),
},
images: {
  allowUrl: images?.allowUrl ?? true,
  urlAllowlist: normalizeInputHostnameAllowlist(images?.urlAllowlist),
  // ...
  maxRedirects: images?.maxRedirects ?? 3,
  timeoutMs: images?.timeoutMs ?? DEFAULT_INPUT_TIMEOUT_MS,
},
```

**说明**: URL 白名单是 SSRF 防护的关键。作者提供了白名单机制而不是简单禁止 URL 输入。

---

## 七、配置

### 7.1 启用端点

```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: {
          enabled: true,
          // 可选配置
          maxBodyBytes: 20000000,
          maxUrlParts: 8,
          files: {
            allowUrl: true,
            urlAllowlist: ["cdn.example.com", "*.assets.example.com"],
            allowedMimes: ["text/plain", "application/pdf", ...],
            maxBytes: 5242880,
            maxChars: 200000,
            maxRedirects: 3,
            timeoutMs: 10000,
          },
          images: {
            allowUrl: true,
            urlAllowlist: ["images.example.com"],
            allowedMimes: ["image/jpeg", "image/png", ...],
            maxBytes: 10485760,
            maxRedirects: 3,
            timeoutMs: 10000,
          },
        },
      },
    },
  },
}
```

### 7.2 默认值

| 配置 | 默认值 |
|------|--------|
| `maxBodyBytes` | 20MB |
| `maxUrlParts` | 8 |
| `files.maxBytes` | 5MB |
| `files.maxChars` | 200k |
| `files.maxRedirects` | 3 |
| `files.timeoutMs` | 10s |
| `images.maxBytes` | 10MB |
| `images.maxRedirects` | 3 |
| `images.timeoutMs` | 10s |

---

## 八、流式模式支持

### 8.1 SSE 事件类型

```typescript
// 非工具调用的流式事件
"response.created"
"response.in_progress"
"response.output_item.added"
"response.output_text.delta"
"response.output_text.done"
"response.content_part.done"
"response.output_item.done"
"response.completed"

// 工具调用的流式事件（特殊处理）
if (stopReason === "tool_calls" && pendingToolCalls && pendingToolCalls.length > 0) {
  // 发送 function_call 事件而不是文本事件
}
```

### 8.2 流式工具调用响应

```typescript
// src/gateway/openresponses-http.ts:728-754
if (stopReason === "tool_calls" && pendingToolCalls && pendingToolCalls.length > 0) {
  const functionCall = pendingToolCalls[0];
  const usage = finalUsage ?? createEmptyUsage();

  writeSseEvent(res, {
    type: "response.output_text.done",
    item_id: outputItemId,
    output_index: 0,
    content_index: 0,
    text: "",
  });

  writeSseEvent(res, {
    type: "response.output_item.done",
    output_index: 0,
    item: createAssistantOutputItem({
      id: outputItemId,
      text: "",
      status: "completed",
    }),
  });

  // 发送 function_call 事件
  writeSseEvent(res, {
    type: "response.output_item.added",
    output_index: 0,
    item: {
      type: "function_call",
      id: `call_${randomUUID()}`,
      call_id: functionCall.id,
      name: functionCall.name,
      arguments: functionCall.arguments,
      status: "incomplete",
    },
  });

  writeSseEvent(res, {
    type: "response.output_item.done",
    output_index: 0,
    item: {
      type: "function_call",
      id: `call_${randomUUID()}`,
      call_id: functionCall.id,
      name: functionCall.name,
      arguments: functionCall.arguments,
      status: "incomplete",
    },
  });

  const incompleteResponse = createResponseResource({
    id: responseId,
    model,
    status: "incomplete",
    output: [{
      type: "function_call",
      id: `call_${randomUUID()}`,
      call_id: functionCall.id,
      name: functionCall.name,
      arguments: functionCall.arguments,
      status: "incomplete",
    }],
    usage,
  });

  writeSseEvent(res, { type: "response.completed", response: incompleteResponse });
  writeDone(res);
  res.end();
  return;
}
```

---

## 九、与内置工具的关系

### 9.1 工具合并逻辑

```typescript
// src/agents/pi-embedded-runner/run/attempt.ts:1179
const allCustomTools = [...customTools, ...clientToolDefs];
```

### 9.2 工具列表（AI 看到的视角）

```
内置工具 (built-in):
  - pi_fs_read
  - pi_fs_write
  - pi_bash_run
  - pi_web_search
  ...

自定义工具 (custom):
  - 来自 skills 的工具

客户端工具 (client):
  - get_weather
  - send_email
  - query_database
  ...（由客户端请求提供）
```

### 9.3 冲突处理

如果客户端工具与内置工具同名：

```typescript
// toClientToolDefinitions 会保留客户端工具定义
// 但工具调用会经过 runBeforeToolCallHook
// Hook 可以阻止或修改调用
```

---

## 十、使用场景

### 10.1 Web 应用集成

```typescript
// 前端代码
const response = await fetch('/v1/responses', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'openclaw:assistant',
    input: userMessage,
    tools: [
      {
        type: 'function',
        function: {
          name: 'open_modal',
          description: 'Open a modal dialog',
          parameters: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              content: { type: 'string' }
            }
          }
        }
      }
    ]
  })
});

const data = await response.json();

// 如果 AI 想打开 modal
if (data.status === 'incomplete') {
  const toolCall = data.output.find(item => item.type === 'function_call');
  if (toolCall?.name === 'open_modal') {
    const args = JSON.parse(toolCall.arguments);
    // 在前端执行：打开 modal
    openModal(args.title, args.content);

    // 将结果发回
    await sendToolResult(toolCall.call_id, { success: true });
  }
}
```

### 10.2 移动应用集成

```swift
// iOS 应用
let tools = [
  [
    "type": "function",
    "function": [
      "name": "get_location",
      "description": "Get user's current location",
      "parameters": [
        "type": "object",
        "properties": [:]
      ]
    ]
  ]
]

// AI 请求位置
// → App 收到 function_call
// → 调用 CLLocationManager 获取位置
// → 返回结果
```

### 10.3 IoT 设备控制

```json
{
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "toggle_light",
        "description": "Toggle smart light",
        "parameters": {
          "type": "object",
          "properties": {
            "device_id": { "type": "string" },
            "state": { "type": "boolean" }
          }
        }
      }
    }
  ]
}
```

---

## 十一、测试覆盖

```typescript
// src/agents/pi-tools.before-tool-call.integration.e2e.test.ts:247-281
describe("before_tool_call hook integration for client tools", () => {
  it("passes modified params to client tool callbacks", async () => {
    hookRunner.hasHooks.mockReturnValue(true);
    hookRunner.runBeforeToolCall.mockResolvedValue({ params: { extra: true } });

    const onClientToolCall = vi.fn();
    const [tool] = toClientToolDefinitions(
      [
        {
          type: "function",
          function: {
            name: "client_tool",
            description: "Client tool",
            parameters: {
              type: "object",
              properties: { value: { type: "string" } }
            },
          },
        },
      ],
      onClientToolCall,
      { agentId: "main", sessionKey: "main" },
    );

    const extensionContext = {} as Parameters<typeof tool.execute>[4];
    await tool.execute("client-call-1", { value: "ok" }, undefined, undefined, extensionContext);

    // 验证 hook 修改后的参数被传递给回调
    expect(onClientToolCall).toHaveBeenCalledWith("client_tool", {
      value: "ok",
      extra: true,  // hook 添加的参数
    });
  });
});
```

---

## 十二、总结

Client Tool 的 "pending" 模式核心要点：

1. **职责分离**：服务端定义工具，客户端执行工具
2. **协议兼容**：兼容 OpenResponses 开放标准
3. **状态传递**：`status: "pending"` → `status: "incomplete"` 流程
4. **Hook 集成**：服务端策略控制不因跨端执行而失效
5. **会话管理**：通过 `user` 字段实现有状态对话
6. **安全边界**：明确的认证和访问控制
7. **流式支持**：统一的流式和非流式行为

这个设计让 OpenClaw 可以作为 "AI 大脑" 服务，被各种前端应用、移动设备、IoT 系统集成。服务端不需要知道客户端的实现细节，只需要定义工具接口；客户端不需要知道 AI 如何推理，只需要执行工具并返回结果。

---

*最后更新：2026-03-10*
