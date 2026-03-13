# Canvas Host 与 A2UI 画布系统

> 一张画布，连接AI能力与用户界面的桥梁

---

## 核心技术洞察

> "这不仅仅是个文件服务器，OpenClaw把Canvas做成了一个完整的双向UI渲染管道。卧槽，这个设计真聪明。"

### 1. Canvas能力令牌的三重验证机制

```
本地直连  ──→  允许访问
     ↓
Bearer Token  ──→  Gateway认证
     ↓
Canvas Capability Token  ──→  Node会话验证（滑动过期10分钟）
```

**Leon点评**：三层安全策略既保护了Canvas资源，又不会过度限制合法访问。滑动过期机制特别优雅——只要Node保持活跃使用，Capability就持续有效；一旦闲置，自动过期。这是个很好的资源清理策略。

### 2. A2UI资源解析的14级回退策略

```typescript
// src/canvas-host/a2ui.ts 的 fallbackPaths 策略
1. src/canvas-host/a2ui/
2. src/canvas-host/a2ui/dist/
3. node_modules/@openclaw/a2ui/dist/
4. dist/a2ui/
5. extensions/*/a2ui/
6. 用户自定义目录
...
14. 最终404
```

**Leon点评**：这种多层回退策略让A2UI资源可以从任意位置加载，完美支持插件生态和自定义扩展。不过14层确实有点多，调试时可能需要追踪每个回退路径。

### 3. 移动端的双向WebSocket桥接

```
┌─────────────┐     WebSocket      ┌──────────────┐     HTTP/WSS      ┌─────────────┐
│   Mobile    │◄──────────────────►│   Gateway    │◄─────────────────►│ Canvas Host │
│  (iOS/Android)│   canvas.invoke   │              │   Capability     │   (A2UI)     │
└─────────────┘                     └──────────────┘                   └─────────────┘
      │                                    │
      │ canvas.eval / canvas.snapshot       │
      ▼                                    ▼
  WebView渲染                       透传到A2UI运行时
```

**Leon点评**：这个设计的精髓在于Gateway作为中间层，负责认证和路由，而Canvas Host无需关心移动端的复杂性。移动端的CanvasController直接调用Gateway的canvas.invoke命令，Gateway再通过HTTP获取Canvas资源。职责分离得很干净。

### 4. 文件热重载的开发体验优化

```typescript
// src/canvas-host/server.ts
const watcher = chokidar.watch(rootReal, {
  ignored: /node_modules/,
  ignoreInitial: true,
});

watcher.on("change", (path) => {
  const hash = computeBundleHash(path);
  broadcastWebSocketMessage({ type: "reload", hash });
});
```

**Leon点评**：chokidar的文件监听加上WebSocket的实时通知，开发时改代码立即生效。这个设计考虑得很周到——开发体验是产品体验的一部分。

---

## 一、Canvas Host 架构总览

### 系统边界

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Canvas Host 系统边界                             │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                      文件服务层                                    │  │
│  │  - 静态资源服务 (A2UI bundle)                                     │  │
│  │  - Capability认证路由                                             │  │
│  │  - 热重载WebSocket信令                                            │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                          ↓ HTTP                                        │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                      资源解析层                                    │  │
│  │  - 14级回退路径策略                                               │  │
│  │  - A2UI bundle hash验证                                          │  │
│  │  - Live reload脚本注入                                            │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                          ↓ 文件系统                                    │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                      存储层                                        │  │
│  │  - src/canvas-host/a2ui/                                          │  │
│  │  - node_modules/@openclaw/a2ui/                                  │  │
│  │  - extensions/*/a2ui/                                             │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 核心组件

| 组件 | 文件 | 核心职责 |
|------|------|----------|
| Canvas Host Server | `src/canvas-host/server.ts` | HTTP服务器、文件服务、热重载 |
| A2UI 资源解析 | `src/canvas-host/a2ui.ts` | A2UI bundle解析、14级回退、脚本注入 |
| 文件安全解析 | `src/canvas-host/file-resolver.ts` | 路径安全检查、目录遍历防护 |
| Canvas Capability | `src/gateway/canvas-capability.ts` | Token铸造、URL scope解析 |
| HTTP认证 | `src/gateway/server/http-auth.ts` | 三重验证机制 |

---

## 二、Canvas Capability Token 机制

### Token 铸造与生命周期

```typescript
// src/gateway/canvas-capability.ts
export const CANVAS_CAPABILITY_TTL_MS = 10 * 60_000; // 10分钟

export function mintCanvasCapabilityToken(): string {
  return randomBytes(18).toString("base64url");
}
```

**Token存储位置**：
- Gateway WebSocket客户端状态：`client.canvasCapability`
- 过期时间戳：`client.canvasCapabilityExpiresAtMs`

**滑动过期机制**：
```typescript
// src/gateway/server/http-auth.ts
if (safeEqualSecret(client.canvasCapability, capability)) {
  // 每次使用时刷新过期时间
  client.canvasCapabilityExpiresAtMs = nowMs + CANVAS_CAPABILITY_TTL_MS;
  return true;
}
```

### Scoped URL 解析

```typescript
// 两种URL格式等价：
// 1. Path-based: /__openclaw__/cap/<capability>/path/to/resource
// 2. Query-based: /path/to/resource?oc_cap=<capability>

export function normalizeCanvasScopedUrl(rawUrl: string): NormalizedCanvasScopedUrl {
  // 从path或query解析capability
  // 重写URL为规范格式
  // 检测malformed格式
}
```

**Leon点评**：URL scope设计很巧妙，path版本更隐蔽，query版本更灵活。两种方式都支持，兼容性很好。

---

## 三、A2UI 资源解析与注入

### 14级回退路径策略

```typescript
// src/canvas-host/a2ui.ts
const CANDIDATE_PATHS = [
  "src/canvas-host/a2ui",
  "src/canvas-host/a2ui/dist",
  "node_modules/@openclaw/a2ui/dist",
  "dist/a2ui",
  "extensions/*/a2ui",
  // ... 共14种
];
```

### Live Reload 脚本注入

```typescript
export function injectCanvasLiveReload(htmlContent: string, wsUrl: string): string {
  const script = `
    <script>
      (function() {
        const ws = new WebSocket("${wsUrl}");
        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data);
          if (msg.type === 'reload') {
            location.reload();
          }
        };
      })();
    </script>
  `;
  return htmlContent.replace("</head>", `${script}</head>`);
}
```

**Leon点评**：这个注入方式简单粗暴但有效。WebSocket连接是独立的，不会干扰A2UI自己的通信逻辑。

---

## 四、移动端集成架构

### iOS 集成

```swift
// apps/ios/Sources/Model/NodeAppModel+Canvas.swift
extension NodeAppModel {
    func resolveA2UIHostURL() async -> String? {
        guard let raw = await self.gatewaySession.currentCanvasHostUrl() else { return nil }
        guard let base = URL(string: trimmed) else { return nil }
        if let host = base.host, LoopbackHost.isLoopback(host) {
            return nil  // 拒绝loopback，只接受远程Gateway
        }
        return base.appendingPathComponent("__openclaw__/a2ui/").absoluteString + "?platform=ios"
    }

    func ensureA2UIReadyWithCapabilityRefresh(timeoutMs: Int = 5000) async -> A2UIReadyState {
        // 首次尝试加载
        guard let initialUrl = await self.resolveA2UIHostURLWithCapabilityRefresh() else {
            return .hostNotConfigured
        }
        self.screen.navigate(to: initialUrl)
        if await self.screen.waitForA2UIReady(timeoutMs: timeoutMs) {
            return .ready(initialUrl)
        }

        // 首次渲染可能失败（capability轮换），重试一次
        guard await self.gatewaySession.refreshNodeCanvasCapability() else { return .hostUnavailable }
        guard let refreshedUrl = await self.resolveA2UIHostURL() else { return .hostUnavailable }
        self.screen.navigate(to: refreshedUrl)
        if await self.screen.waitForA2UIReady(timeoutMs: timeoutMs) {
            return .ready(refreshUrlUrl)
        }
        return .hostUnavailable
    }
}
```

### Android 集成

```kotlin
// apps/android/app/src/main/java/ai/openclaw/app/node/CanvasController.kt
class CanvasController {
    private val scaffoldAssetUrl = "file:///android_asset/CanvasScaffold/scaffold.html"

    fun navigate(url: String) {
        val trimmed = url.trim()
        this.url = if (trimmed.isBlank() || trimmed == "/") null else trimmed
        reload()
    }

    private fun reload() {
        withWebViewOnMain { wv ->
            if (currentUrl == null) {
                wv.loadUrl(scaffoldAssetUrl)  // 默认Canvas
            } else {
                wv.loadUrl(currentUrl)  // A2UI或自定义Canvas
            }
        }
    }

    suspend fun snapshotBase64(format: SnapshotFormat, quality: Double?, maxWidth: Int?): String {
        val wv = webView ?: throw IllegalStateException("no webview")
        val bmp = wv.captureBitmap()
        val scaled = bmp.scaleForMaxWidth(maxWidth)
        // 编码为Base64返回
    }
}
```

### A2UI 消息处理（Android）

```kotlin
// apps/android/app/src/main/java/ai/openclaw/app/node/A2UIHandler.kt
class A2UIHandler(
    private val canvas: CanvasController,
    private val json: Json,
    private val getNodeCanvasHostUrl: () -> String?,
) {
    suspend fun ensureA2uiReady(a2uiUrl: String): Boolean {
        // 检查是否已加载
        val already = canvas.eval(a2uiReadyCheckJS)
        if (already == "true") return true

        // 加载A2UI并等待就绪（最多50次 × 120ms = 6秒）
        canvas.navigate(a2uiUrl)
        repeat(50) {
            val ready = canvas.eval(a2uiReadyCheckJS)
            if (ready == "true") return true
            delay(120)
        }
        return false
    }

    fun decodeA2uiMessages(command: String, paramsJson: String?): String {
        // 支持JSONL和messages[]两种格式
        // 验证A2UI v0.8协议格式
    }

    companion object {
        const val a2uiReadyCheckJS = """
            (() => {
                try {
                    const host = globalThis.openclawA2UI;
                    return !!host && typeof host.applyMessages === 'function';
                } catch (_) {
                    return false;
                }
            })()
        """

        fun a2uiApplyMessagesJS(messagesJson: String): String = """
            (() => {
                try {
                    const host = globalThis.openclawA2UI;
                    if (!host) return { ok: false, error: "missing openclawA2UI" };
                    const messages = $messagesJson;
                    return host.applyMessages(messages);
                } catch (e) {
                    return { ok: false, error: String(e?.message ?? e) };
                }
            })()
        """.trimIndent()
    }
}
```

**Leon点评**：Android的A2UIHandler设计得很干净。ready检测 + 轮询等待 + JavaScript注入，三步搞定异步初始化。6秒超时设置也很合理——既不会太短误判失败，也不会太长阻塞UI。

### A2UI v0.8 协议验证

```kotlin
private fun validateA2uiV0_8(msg: JsonObject, lineNumber: Int) {
    // 拒绝v0.9的createSurface格式
    if (msg.containsKey("createSurface")) {
        throw IllegalArgumentException("A2UI v0.9 not supported")
    }

    // 只接受v0.8的消息类型
    val allowed = setOf("beginRendering", "surfaceUpdate", "dataModelUpdate", "deleteSurface")
    val matched = msg.keys.filter { allowed.contains(it) }

    // 必须有且仅有一个合法key
    if (matched.size != 1) {
        throw IllegalArgumentException("Invalid A2UI message format")
    }
}
```

**Leon点评**：协议版本检查做得很严格。v0.9和v0.8消息格式不兼容，提前拒绝可以避免运行时混乱。不过这种硬编码版本检查在v0.10发布时又要改了，或许可以考虑版本号字段。

---

## 五、Canvas HTTP 请求处理流程

### 请求处理管道

```typescript
// src/gateway/server-http.ts
const requestStages: GatewayHttpRequestStage[] = [
  { name: "hooks", run: () => handleHooksRequest(req, res) },
  { name: "tools-invoke", run: () => handleToolsInvokeHttpRequest(...) },
  { name: "openai-completions", run: () => handleOpenAiHttpRequest(...) },
  { name: "control-ui", run: () => handleControlUiHttpRequest(...) },
  { name: "canvas-auth", run: async () => {
    const scopedCanvas = normalizeCanvasScopedUrl(req.url ?? "/");
    if (scopedCanvas.malformedScopedPath) {
      sendGatewayAuthFailure(res, { ok: false, reason: "unauthorized" });
      return true;
    }
    const ok = await authorizeCanvasRequest({
      req,
      auth: resolvedAuth,
      clients,
      canvasCapability: scopedCanvas.capability,
      malformedScopedPath: scopedCanvas.malformedScopedPath,
    });
    if (!ok.ok) {
      sendGatewayAuthFailure(res, ok);
      return true;
    }
    return false;  // 继续后续stage
  }},
  { name: "a2ui", run: () => handleA2uiHttpRequest(req, res) },
  { name: "canvas-http", run: () => canvasHost.handleHttpRequest(req, res) },
];
```

### 三重认证逻辑

```typescript
// src/gateway/server/http-auth.ts
export async function authorizeCanvasRequest(params: {
  req: IncomingMessage;
  auth: ResolvedGatewayAuth;
  clients: Set<GatewayWsClient>;
  canvasCapability?: string;
}): Promise<GatewayAuthResult> {
  // 1. 本地直连放行
  if (isLocalDirectRequest(req)) {
    return { ok: true };
  }

  // 2. Bearer Token验证
  const token = getBearerToken(req);
  if (token) {
    const authResult = await authorizeHttpGatewayConnect({ auth, token });
    if (authResult.ok) return authResult;
  }

  // 3. Canvas Capability Token验证
  if (canvasCapability && hasAuthorizedNodeWsClientForCanvasCapability(clients, canvasCapability)) {
    return { ok: true };
  }

  return { ok: false, reason: "unauthorized" };
}
```

**Leon点评**：这个认证顺序设计得很合理：
1. 最先检查本地直连，零开销
2. 然后是Bearer Token，支持Gateway标准认证
3. 最后是Canvas Capability，专为移动端Node设计

三个通道互不干扰，覆盖了所有使用场景。

---

## 六、文件安全解析机制

### 路遍历防护

```typescript
// src/canvas-host/file-resolver.ts
export async function resolveFileWithinRoot(
  rootReal: string,
  urlPath: string,
): Promise<SafeOpenResult | null> {
  const normalized = normalizeUrlPath(urlPath);
  const rel = normalized.replace(/^\/+/, "");

  // 拒绝包含".."的路径
  if (rel.split("/").some((p) => p === "..")) {
    return null;
  }

  // 使用SafeOpen确保不逃逸root目录
  return await openFileWithinRoot({ rootDir: rootReal, relativePath: rel });
}
```

### 目录自动index.html

```typescript
if (normalized.endsWith("/")) {
  return await tryOpen(path.posix.join(rel, "index.html"));
}

const candidate = path.join(rootReal, rel);
try {
  const st = await fs.lstat(candidate);
  if (st.isDirectory()) {
    return await tryOpen(path.posix.join(rel, "index.html"));
  }
} catch {
  // ignore
}
```

**Leon点评**：安全防护做得很扎实：
1. 显式拒绝".."路径
2. 使用SafeOpen进行二次检查
3. 自动目录→index.html映射

不过这里有个细节：符号链接直接返回null，这可能是为了防止链接逃逸root目录的防御性设计。

---

## 七、Canvas 命令在移动端的处理

### Android Invoke 分发

```kotlin
// apps/android/app/src/main/java/ai/openclaw/app/node/InvokeDispatcher.kt
when (command) {
  // A2UI命令
  OpenClawCanvasA2UICommand.Reset.rawValue ->
    withReadyA2ui {
      withCanvasAvailable {
        val res = canvas.eval(A2UIHandler.a2uiResetJS)
        onCanvasA2uiReset()
        GatewaySession.InvokeResult.ok(res)
      }
    }

  OpenClawCanvasA2UICommand.Push.rawValue,
  OpenClawCanvasA2UICommand.PushJSONL.rawValue -> {
    val messages = a2uiHandler.decodeA2uiMessages(command, paramsJson)
    withReadyA2ui {
      withCanvasAvailable {
        val js = A2UIHandler.a2uiApplyMessagesJS(messages)
        val res = canvas.eval(js)
        onCanvasA2uiPush()
        GatewaySession.InvokeResult.ok(res)
      }
    }
  }

  // Canvas控制命令
  "canvas.navigate" -> {
    val url = CanvasController.parseNavigateUrl(paramsJson)
    canvas.navigate(url)
    GatewaySession.InvokeResult.ok(null)
  }

  "canvas.eval" -> {
    val js = CanvasController.parseEvalJs(paramsJson)
    val res = canvas.eval(js)
    GatewaySession.InvokeResult.ok(res)
  }

  "canvas.snapshot" -> {
    val params = CanvasController.parseSnapshotParams(paramsJson)
    val base64 = canvas.snapshotBase64(params.format, params.quality, params.maxWidth)
    GatewaySession.InvokeResult.ok(base64)
  }
}
```

### iOS 前台命令保护

```typescript
// src/gateway/server-methods/nodes.ts
function isForegroundRestrictedIosCommand(command: string): boolean {
  return (
    command === "canvas.present" ||
    command === "canvas.navigate" ||
    command.startsWith("canvas.") ||
    command.startsWith("camera.") ||
    command.startsWith("screen.") ||
    command.startsWith("talk.")
  );
}

function shouldQueueAsPendingForegroundAction(params: {
  platform?: string;
  command: string;
  error: unknown;
}): boolean {
  const platform = (params.platform ?? "").trim().toLowerCase();
  if (!platform.startsWith("ios") && !platform.startsWith("ipados")) {
    return false;
  }

  if (!isForegroundRestrictedIosCommand(params.command)) {
    return false;
  }

  const error = params.error as { code?: string; message?: string } | null;
  const code = error?.code?.trim().toUpperCase() ?? "";
  const message = error?.message?.trim().toUpperCase() ?? "";

  return code === "NODE_BACKGROUND_UNAVAILABLE" || message.includes("BACKGROUND_UNAVAILABLE");
}
```

**Leon点评**：iOS的前台限制处理得很好：
1. 明确列出需要前台的命令类型
2. 检测特定的错误码和消息
3. 自动将失败的命令放入pending队列

这样iOS App在返回前台时可以重试这些命令，用户体验不会中断。

---

## 八、关键技术权衡

### 1. Capability Token vs Session Token

| 方案 | 优势 | 劣势 |
|------|------|------|
| Capability Token | 独立认证、滑动过期、权限隔离 | 需要额外存储和管理 |
| Session Token | 复用现有机制 | 权限粒度不够细 |

**选择**：Capability Token
**原因**：Canvas需要独立的权限控制，特别是移动端Node的临时访问场景。

### 2. 14级回退 vs 单一配置

| 方案 | 优势 | 劣势 |
|------|------|------|
| 14级回退 | 灵活、兼容多种布局 | 性能开销、调试复杂 |
| 单一配置 | 简单、性能好 | 生态扩展受限 |

**选择**：14级回退
**原因**：插件生态需要从任意位置加载A2UI资源，灵活性优先。

### 3. WebSocket热重载 vs 轮询

| 方案 | 优势 | 劣势 |
|------|------|------|
| WebSocket推送 | 实时、低开销 | 需要保持连接 |
| 客户端轮询 | 简单、无状态 | 延迟高、浪费资源 |

**选择**：WebSocket推送
**原因**：开发体验优先，且Gateway已有WebSocket基础设施。

---

## 附录A：Canvas与Gateway、移动端的关系

**Q：Canvas Host和Gateway是什么关系？**

A：Canvas Host是Gateway管理的HTTP服务器，负责提供A2UI静态资源和Canvas能力认证。Gateway通过WebSocket与移动端Node通信，Node发起的canvas.invoke命令最终由Canvas Host处理。两者是独立的进程，通过Capability Token进行安全通信。

**Q：移动端为什么要通过Gateway而不是直接访问Canvas Host？**

A：三层原因：
1. **认证**：Gateway负责验证Node身份和Canvas权限
2. **路由**：Gateway管理多个Node，需要将请求路由到正确的Canvas Host实例
3. **复用**：Gateway已有WebSocket连接，不需要移动端建立额外的HTTP连接

**Q：Capability Token和Bearer Token有什么区别？**

A：
- **Bearer Token**：Gateway的长期认证凭据，用于CLI、Web UI等Operator客户端
- **Capability Token**：临时的Canvas访问令牌，仅用于移动端Node访问Canvas资源

Capability Token的有效期绑定到Node的WebSocket连接生命周期，连接断开后Token自动失效。

---

*本文档基于源码分析，涵盖Canvas Host、A2UI集成、移动端CanvasController等核心组件。*
