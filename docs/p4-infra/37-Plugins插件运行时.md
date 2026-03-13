# Plugins 插件运行时 (Plugins Runtime)

> "OpenClaw 的插件运行时是系统可扩展性的核心，15,000+ 行代码支撑着插件发现、加载、Hooks 集成、服务管理全套流程。discovery.ts 通过多层安全检查（源文件逃逸检测、权限验证、所有权验证）防止恶意插件，openBoundaryFileSync 确保插件代码不会读取边界外的文件。loader.ts 的 Proxy Runtime 设计太优雅了——延迟初始化避免加载不需要的依赖，同时保持完整的 API 可用性。Hooks 系统提供 30+ 生命周期钩子，覆盖从模型解析到消息发送的完整流程，prompt injection hooks 特殊处理确保静态上下文可缓存。卧槽，这个 provenance tracking 太完善了——load paths + install records 双重验证，未追踪的插件会发出警告，默认安全边界清晰明了。"

---

## 核心技术洞察

### 1. 插件发现安全检查

```typescript
// src/plugins/discovery.ts
type CandidateBlockReason =
  | "source_escapes_root"
  | "path_stat_failed"
  | "path_world_writable"
  | "path_suspicious_ownership";

function checkSourceEscapesRoot(params: {
  source: string;
  rootDir: string;
}): CandidateBlockIssue | null {
  const sourceRealPath = safeRealpathSync(params.source);
  const rootRealPath = safeRealpathSync(params.rootDir);
  if (!sourceRealPath || !rootRealPath) {
    return null;
  }
  if (isPathInside(rootRealPath, sourceRealPath)) {
    return null;
  }
  return {
    reason: "source_escapes_root",
    sourcePath: params.source,
    rootPath: params.rootDir,
    targetPath: params.source,
    sourceRealPath,
    rootRealPath,
  };
}

function checkPathStatAndPermissions(params: {
  source: string;
  rootDir: string;
  origin: PluginOrigin;
  uid: number | null;
}): CandidateBlockIssue | null {
  if (process.platform === "win32") {
    return null;
  }
  const pathsToCheck = [params.rootDir, params.source];
  for (const targetPath of pathsToCheck) {
    const stat = safeStatSync(targetPath);
    if (!stat) {
      return {
        reason: "path_stat_failed",
        sourcePath: params.source,
        rootPath: params.rootDir,
        targetPath,
      };
    }
    const modeBits = stat.mode & 0o777;
    if ((modeBits & 0o002) !== 0) {
      return {
        reason: "path_world_writable",
        sourcePath: params.source,
        rootPath: params.rootDir,
        targetPath,
        modeBits,
      };
    }
    if (
      params.origin !== "bundled" &&
      params.uid !== null &&
      typeof stat.uid === "number" &&
      stat.uid !== params.uid &&
      stat.uid !== 0
    ) {
      return {
        reason: "path_suspicious_ownership",
        sourcePath: params.source,
        rootPath: params.rootDir,
        targetPath,
        foundUid: stat.uid,
        expectedUid: params.uid,
      };
    }
  }
  return null;
}
```

**Leon 点评**：安全检查设计得非常周全：
1. **源文件逃逸检测**：确保插件代码不会读取 root 目录外的文件
2. **世界可写检测**：防止其他用户修改插件代码
3. **所有权验证**：非 root 用户必须拥有插件文件
4. **bundled 例外**：内置插件豁免权限检查

### 2. Proxy Runtime 延迟初始化

```typescript
// src/plugins/loader.ts
// 延迟初始化运行时，避免启动路径加载不需要的 channel runtime 依赖
let resolvedRuntime: PluginRuntime | null = null;
const resolveRuntime = (): PluginRuntime => {
  resolvedRuntime ??= createPluginRuntime(options.runtimeOptions);
  return resolvedRuntime;
};
const runtime = new Proxy({} as PluginRuntime, {
  get(_target, prop, receiver) {
    return Reflect.get(resolveRuntime(), prop, receiver);
  },
  set(_target, prop, value, receiver) {
    return Reflect.set(resolveRuntime(), prop, value, receiver);
  },
  has(_target, prop) {
    return Reflect.has(resolveRuntime(), prop);
  },
  ownKeys() {
    return Reflect.ownKeys(resolveRuntime() as object);
  },
  getOwnPropertyDescriptor(_target, prop) {
    return Reflect.getOwnPropertyDescriptor(resolveRuntime() as object, prop);
  },
  defineProperty(_target, prop, attributes) {
    return Reflect.defineProperty(resolveRuntime() as object, prop, attributes);
  },
  deleteProperty(_target, prop) {
    return Reflect.deleteProperty(resolveRuntime() as object, prop);
  },
  getPrototypeOf() {
    return Reflect.getPrototypeOf(resolveRuntime() as object);
  },
});
```

**Leon 点评**：Proxy Runtime 设计非常巧妙：
1. **延迟加载**：只在第一次访问时创建实际 runtime
2. **透明代理**：所有操作都转发到真实 runtime
3. **完整实现**：支持 get/set/has/ownKeys 等所有陷阱
4. **性能优化**：启动时不加载不需要的依赖

### 3. Hooks 系统架构

```typescript
// src/plugins/types.ts
export type PluginHookName =
  | "before_model_resolve"
  | "before_prompt_build"
  | "before_agent_start"
  | "llm_input"
  | "llm_output"
  | "agent_end"
  | "before_compaction"
  | "after_compaction"
  | "before_reset"
  | "message_received"
  | "message_sending"
  | "message_sent"
  | "before_tool_call"
  | "after_tool_call"
  | "tool_result_persist"
  | "before_message_write"
  | "session_start"
  | "session_end"
  | "subagent_spawning"
  | "subagent_delivery_target"
  | "subagent_spawned"
  | "subagent_ended"
  | "gateway_start"
  | "gateway_stop";

export const PROMPT_INJECTION_HOOK_NAMES = [
  "before_prompt_build",
  "before_agent_start",
] as const satisfies readonly PluginHookName[]>;

// Prompt injection hooks 特殊处理
export type PluginHookBeforePromptBuildResult = {
  systemPrompt?: string;
  prependContext?: string;
  /**
   * Prepended to the agent system prompt so providers can cache it (e.g. prompt caching).
   * Use for static plugin guidance instead of prependContext to avoid per-turn token cost.
   */
  prependSystemContext?: string;
  /**
   * Appended to the agent system prompt so providers can cache it (e.g. prompt caching).
   * Use for static plugin guidance instead of prependContext to avoid per-turn token cost.
   */
  appendSystemContext?: string;
};
```

**Leon 点评**：Hooks 系统设计非常完善：
1. **完整生命周期**：覆盖从开始到结束的完整流程
2. **Prompt Injection**：特殊处理 prompt 相关 hooks，支持缓存
3. **类型安全**：每个 hook 都有明确的类型定义
4. **上下文传递**：统一的上下文对象传递机制

### 4. 插件 API 注册

```typescript
// src/plugins/types.ts
export type OpenClawPluginApi = {
  id: string;
  name: string;
  version?: string;
  description?: string;
  source: string;
  config: OpenClawConfig;
  pluginConfig?: Record<string, unknown>;
  runtime: PluginRuntime;
  logger: PluginLogger;
  registerTool: (
    tool: AnyAgentTool | OpenClawPluginToolFactory,
    opts?: OpenClawPluginToolOptions,
  ) => void;
  registerHook: (
    events: string | string[],
    handler: InternalHookHandler,
    opts?: OpenClawPluginHookOptions,
  ) => void;
  registerHttpRoute: (params: OpenClawPluginHttpRouteParams) => void;
  registerChannel: (registration: OpenClawPluginChannelRegistration | ChannelPlugin) => void;
  registerGatewayMethod: (method: string, handler: GatewayRequestHandler) => void;
  registerCli: (registrar: OpenClawPluginCliRegistrar, opts?: { commands?: string[] }) => void;
  registerService: (service: OpenClawPluginService) => void;
  registerProvider: (provider: ProviderPlugin) => void;
  registerCommand: (command: OpenClawPluginCommandDefinition) => void;
  registerContextEngine: (
    id: string,
    factory: ContextEngineFactory,
  ) => void;
  resolvePath: (input: string) => string;
  on: <K extends PluginHookName>(
    hookName: K,
    handler: PluginHookHandlerMap[K],
    opts?: { priority?: number },
  ) => void;
};
```

**Leon 点评**：插件 API 提供了完整的扩展能力：
1. **工具注册**：动态注册 AI 工具
2. **Hooks 注册**：监听和拦截系统事件
3. **HTTP 路由**：注册自定义 HTTP 端点
4. **渠道注册**：添加新的消息渠道
5. **CLI 命令**：扩展命令行界面
6. **服务注册**：后台服务支持
7. **Provider 注册**：添加新的 AI Provider

### 5. 插件来源追踪

```typescript
// src/plugins/loader.ts
function buildProvenanceIndex(params: {
  config: OpenClawConfig;
  normalizedLoadPaths: string[];
}): PluginProvenanceIndex {
  const loadPathMatcher = createPathMatcher();
  for (const loadPath of params.normalizedLoadPaths) {
    addPathToMatcher(loadPathMatcher, loadPath);
  }

  const installRules = new Map<string, InstallTrackingRule>();
  const installs = params.config.plugins?.installs ?? {};
  for (const [pluginId, install] of Object.entries(installs)) {
    const rule: InstallTrackingRule = {
      trackedWithoutPaths: false,
      matcher: createPathMatcher(),
    };
    const trackedPaths = [install.installPath, install.sourcePath]
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter(Boolean);
    if (trackedPaths.length === 0) {
      rule.trackedWithoutPaths = true;
    } else {
      for (const trackedPath of trackedPaths) {
        addPathToMatcher(rule.matcher, trackedPath);
      }
    }
    installRules.set(pluginId, rule);
  }

  return { loadPathMatcher, installRules };
}

function warnAboutUntrackedLoadedPlugins(params: {
  registry: PluginRegistry;
  provenance: PluginProvenanceIndex;
  logger: PluginLogger;
}) {
  for (const plugin of params.registry.plugins) {
    if (plugin.status !== "loaded" || plugin.origin === "bundled") {
      continue;
    }
    if (
      isTrackedByProvenance({
        pluginId: plugin.id,
        source: plugin.source,
        index: params.provenance,
      })
    ) {
      continue;
    }
    const message =
      "loaded without install/load-path provenance; treat as untracked local code and pin trust via plugins.allow or install records";
    params.registry.diagnostics.push({
      level: "warn",
      pluginId: plugin.id,
      source: plugin.source,
      message,
    });
    params.logger.warn(`[plugins] ${plugin.id}: ${message} (${plugin.source})`);
  }
}
```

**Leon 点评**：来源追踪提供了可审计的插件管理：
1. **Load Path 追踪**：记录所有配置的加载路径
2. **Install Record 追踪**：记录已安装插件的路径
3. **未追踪警告**：未追踪的插件会发出警告
4. **双重验证**：load paths + install records 双重验证

---

## 一、插件运行时架构总览

### 核心组件

```
Plugins Runtime
├── Discovery（发现）
│   ├── 目录扫描
│   ├── Package Manifest 读取
│   ├── 安全检查
│   └── 缓存管理
├── Loader（加载器）
│   ├── Jiti 集成
│   ├── Plugin SDK 别名
│   ├── 配置验证
│   └── API 创建
├── Registry（注册表）
│   ├── 插件记录
│   ├── 工具注册
│   ├── Hooks 注册
│   └── 诊断收集
├── Hooks（钩子系统）
│   ├── 生命周期钩子
│   ├── Prompt Injection
│   ├── 事件分发
│   └── 优先级排序
├── Runtime（运行时）
│   ├── 服务管理
│   ├── 状态存储
│   └── 生命周期控制
└── Commands（命令）
    ├── 命令注册
    ├── 权限检查
    └── 处理器分发
```

### 插件来源

| 来源 | 路径 | 优先级 | 用途 |
|------|------|--------|------|
| Bundled | 内置目录 | 最高 | 官方插件 |
| Global | `~/.openclaw/extensions/` | 高 | 用户全局插件 |
| Workspace | `.openclaw/extensions/` | 中 | 工作空间插件 |
| Config | `plugins.load.paths` | 低 | 自定义路径 |

---

## 二、类型系统

### 插件定义

```typescript
export type OpenClawPluginDefinition = {
  id?: string;
  name?: string;
  description?: string;
  version?: string;
  kind?: PluginKind;
  configSchema?: OpenClawPluginConfigSchema;
  register?: (api: OpenClawPluginApi) => void | Promise<void>;
  activate?: (api: OpenClawPluginApi) => void | Promise<void>;
};

export type PluginKind = "memory" | "context-engine";
```

### 插件配置模式

```typescript
export type OpenClawPluginConfigSchema = {
  safeParse?: (value: unknown) => {
    success: boolean;
    data?: unknown;
    error?: {
      issues?: Array<{ path: Array<string | number>; message: string }>;
    };
  };
  parse?: (value: unknown) => unknown;
  validate?: (value: unknown) => PluginConfigValidation;
  uiHints?: Record<string, PluginConfigUiHint>;
  jsonSchema?: Record<string, unknown>;
};

export type PluginConfigValidation =
  | { ok: true; value?: unknown }
  | { ok: false; errors: string[] };
```

### 插件记录

```typescript
export type PluginRecord = {
  id: string;
  name: string;
  description?: string;
  version?: string;
  source: string;
  origin: PluginOrigin;
  workspaceDir?: string;
  kind?: PluginKind;
  enabled: boolean;
  status: "loaded" | "disabled" | "error";
  error?: string;
  toolNames: string[];
  hookNames: PluginHookName[];
  channelIds: ChannelId[];
  providerIds: string[];
  gatewayMethods: string[];
  cliCommands: string[];
  services: string[];
  commands: string[];
  httpRoutes: number;
  hookCount: number;
  configSchema: boolean;
  configUiHints?: Record<string, PluginConfigUiHint>;
  configJsonSchema?: Record<string, unknown>;
};
```

### 诊断信息

```typescript
export type PluginDiagnostic = {
  level: "warn" | "error";
  message: string;
  pluginId?: string;
  source?: string;
};
```

---

## 三、插件发现流程

### 目录扫描

```typescript
function discoverInDirectory(params: {
  dir: string;
  origin: PluginOrigin;
  ownershipUid?: number | null;
  workspaceDir?: string;
  candidates: PluginCandidate[];
  diagnostics: PluginDiagnostic[];
  seen: Set<string>;
}) {
  if (!fs.existsSync(params.dir)) {
    return;
  }
  const entries = fs.readdirSync(params.dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(params.dir, entry.name);
    if (entry.isFile()) {
      if (!isExtensionFile(fullPath)) {
        continue;
      }
      addCandidate({
        candidates: params.candidates,
        diagnostics: params.diagnostics,
        seen: params.seen,
        idHint: path.basename(entry.name, path.extname(entry.name)),
        source: fullPath,
        rootDir: path.dirname(fullPath),
        origin: params.origin,
        ownershipUid: params.ownershipUid,
        workspaceDir: params.workspaceDir,
      });
    }
    if (entry.isDirectory()) {
      if (shouldIgnoreScannedDirectory(entry.name)) {
        continue;
      }
      const manifest = readPackageManifest(fullPath);
      const extensionResolution = resolvePackageExtensionEntries(manifest);
      const extensions = extensionResolution.status === "ok" ? extensionResolution.entries : [];

      if (extensions.length > 0) {
        // 使用 package.json 的 extensions 字段
        for (const extPath of extensions) {
          const resolved = resolvePackageEntrySource({
            packageDir: fullPath,
            entryPath: extPath,
            sourceLabel: fullPath,
            diagnostics: params.diagnostics,
          });
          if (resolved) {
            addCandidate({ ... });
          }
        }
      } else {
        // 查找默认入口文件
        const indexFile = [...DEFAULT_PLUGIN_ENTRY_CANDIDATES]
          .map((candidate) => path.join(fullPath, candidate))
          .find((candidate) => fs.existsSync(candidate));
        if (indexFile && isExtensionFile(indexFile)) {
          addCandidate({ ... });
        }
      }
    }
  }
}
```

### 发现来源优先级

```typescript
export function discoverOpenClawPlugins(params: {
  workspaceDir?: string;
  extraPaths?: string[];
  ownershipUid?: number | null;
  cache?: boolean;
}): PluginDiscoveryResult {
  const candidates: PluginCandidate[] = [];
  const diagnostics: PluginDiagnostic[] = [];
  const seen = new Set<string>();

  // 1. 自定义路径（config plugins.load.paths）
  for (const extraPath of params.extraPaths ?? []) {
    discoverFromPath({
      rawPath: extraPath,
      origin: "config",
      ownershipUid: params.ownershipUid,
      workspaceDir: params.workspaceDir,
      candidates,
      diagnostics,
      seen,
    });
  }

  // 2. 工作空间插件
  if (params.workspaceDir) {
    const workspaceExtDirs = [path.join(params.workspaceDir, ".openclaw", "extensions")];
    for (const dir of workspaceExtDirs) {
      discoverInDirectory({
        dir,
        origin: "workspace",
        ownershipUid: params.ownershipUid,
        workspaceDir: params.workspaceDir,
        candidates,
        diagnostics,
        seen,
      });
    }
  }

  // 3. 内置插件
  const bundledDir = resolveBundledPluginsDir();
  if (bundledDir) {
    discoverInDirectory({
      dir: bundledDir,
      origin: "bundled",
      ownershipUid: params.ownershipUid,
      candidates,
      diagnostics,
      seen,
    });
  }

  // 4. 全局插件（保持在内置插件之后）
  const globalDir = path.join(resolveConfigDir(), "extensions");
  discoverInDirectory({
    dir: globalDir,
    origin: "global",
    ownershipUid: params.ownershipUid,
    candidates,
    diagnostics,
    seen,
  });

  return { candidates, diagnostics };
}
```

---

## 四、插件加载流程

### 加载入口

```typescript
export function loadOpenClawPlugins(options: PluginLoadOptions = {}): PluginRegistry {
  const cfg = applyTestPluginDefaults(options.config ?? {}, process.env);
  const logger = options.logger ?? defaultLogger();
  const normalized = normalizePluginsConfig(cfg.plugins);
  const cacheKey = buildCacheKey({
    workspaceDir: options.workspaceDir,
    plugins: normalized,
  });

  // 缓存检查
  if (options.cache !== false) {
    const cached = registryCache.get(cacheKey);
    if (cached) {
      activatePluginRegistry(cached, cacheKey);
      return cached;
    }
  }

  // 清理之前的插件命令
  clearPluginCommands();

  // 创建注册表和 API
  const { registry, createApi } = createPluginRegistry({
    logger,
    runtime,
    coreGatewayHandlers: options.coreGatewayHandlers,
  });

  // 发现插件
  const discovery = discoverOpenClawPlugins({
    workspaceDir: options.workspaceDir,
    extraPaths: normalized.loadPaths,
    cache: options.cache,
  });

  // 加载插件
  const manifestRegistry = loadPluginManifestRegistry({
    config: cfg,
    workspaceDir: options.workspaceDir,
    cache: options.cache,
    candidates: discovery.candidates,
    diagnostics: discovery.diagnostics,
  });

  // 构建来源索引
  const provenance = buildProvenanceIndex({
    config: cfg,
    normalizedLoadPaths: normalized.loadPaths,
  });

  // 处理每个候选插件
  for (const candidate of discovery.candidates) {
    const manifestRecord = manifestByRoot.get(candidate.rootDir);
    if (!manifestRecord) {
      continue;
    }

    const enableState = resolveEffectiveEnableState({
      id: pluginId,
      origin: candidate.origin,
      config: normalized,
      rootConfig: cfg,
    });

    if (!enableState.enabled) {
      // 插件被禁用
      continue;
    }

    // 加载插件模块
    const mod = getJiti()(safeSource) as OpenClawPluginModule;
    const resolved = resolvePluginModuleExport(mod);
    const api = createApi(record, {
      config: cfg,
      pluginConfig: validatedConfig.value,
      hookPolicy: entry?.hooks,
    });

    try {
      const result = register(api);
      registry.plugins.push(record);
    } catch (err) {
      // 记录错误
    }
  }

  // 警告未追踪的插件
  warnAboutUntrackedLoadedPlugins({
    registry,
    provenance,
    logger,
  });

  // 缓存注册表
  if (options.cache !== false) {
    registryCache.set(cacheKey, registry);
  }

  activatePluginRegistry(registry, cacheKey);
  return registry;
}
```

### 插件启用状态解析

```typescript
function resolveEffectiveEnableState(params: {
  id: string;
  origin: PluginOrigin;
  config: NormalizedPluginsConfig;
  rootConfig: OpenClawConfig;
}): { enabled: boolean; reason?: string } {
  // 1. 检查是否全局禁用
  if (!params.config.enabled) {
    return { enabled: false, reason: "plugins disabled globally" };
  }

  // 2. 检查白名单
  if (params.config.allow.length > 0) {
    if (!params.config.allow.includes(params.id)) {
      return { enabled: false, reason: "not in allow list" };
    }
  }

  // 3. 检查黑名单
  if (params.config.deny.includes(params.id)) {
    return { enabled: false, reason: "in deny list" };
  }

  // 4. 检查插件特定配置
  const entry = params.config.entries[params.id];
  if (entry?.enabled === false) {
    return { enabled: false, reason: "explicitly disabled in config" };
  }

  // 5. Bundled 插件默认启用
  if (params.origin === "bundled") {
    return { enabled: true };
  }

  // 6. 其他插件需要显式启用
  if (entry?.enabled === true) {
    return { enabled: true };
  }

  return { enabled: false, reason: "no explicit enable flag" };
}
```

---

## 五、Hooks 系统

### Hook 注册

```typescript
export type PluginHookRegistration<K extends PluginHookName = PluginHookName> = {
  pluginId: string;
  hookName: K;
  handler: PluginHookHandlerMap[K];
  priority?: number;
  source: string;
};

// 在插件中注册 hook
export type OpenClawPluginApi = {
  on: <K extends PluginHookName>(
    hookName: K,
    handler: PluginHookHandlerMap[K],
    opts?: { priority?: number },
  ) => void;
  // ...
};

// 使用示例
plugin.api.on("before_prompt_build", async (event, ctx) => {
  return {
    prependSystemContext: "You are a helpful assistant with access to custom tools.",
  };
});
```

### Prompt Injection Hooks

```typescript
export const PROMPT_INJECTION_HOOK_NAMES = [
  "before_prompt_build",
  "before_agent_start",
] as const satisfies readonly PluginHookName[];

// 特殊处理这些 hooks 以支持缓存
export type PluginHookBeforePromptBuildResult = {
  systemPrompt?: string;
  prependContext?: string;
  prependSystemContext?: string;  // 可缓存
  appendSystemContext?: string;   // 可缓存
};
```

### Hook 事件分发

```typescript
// Hook 运行器会按优先级顺序调用所有注册的处理器
export type PluginHookRunner = {
  runBeforePromptBuild: (
    event: PluginHookBeforePromptBuildEvent,
    ctx: PluginHookAgentContext,
  ) => Promise<PluginHookBeforePromptBuildResult>;
  // ... 其他 hook 方法
};
```

---

## 六、服务管理

### 服务定义

```typescript
export type OpenClawPluginService = {
  id: string;
  start: (ctx: OpenClawPluginServiceContext) => void | Promise<void>;
  stop?: (ctx: OpenClawPluginServiceContext) => void | Promise<void>;
};

export type OpenClawPluginServiceContext = {
  config: OpenClawConfig;
  workspaceDir?: string;
  stateDir: string;
  logger: PluginLogger;
};

// 在插件中注册服务
plugin.api.registerService({
  id: "my-background-worker",
  start: async (ctx) => {
    ctx.logger.info("Starting background worker");
    // 初始化服务
  },
  stop: async (ctx) => {
    ctx.logger.info("Stopping background worker");
    // 清理服务
  },
});
```

### 服务生命周期

```
Gateway Start
    ↓
For Each Plugin:
  For Each Service:
    start(context)
    ↓
Gateway Running
    ↓
Gateway Stop
    ↓
For Each Plugin (reverse order):
  For Each Service (reverse order):
    stop?(context)
```

---

## 七、技术权衡

### 1. Jiti vs 直接 import

| 方案 | 优势 | 劣势 |
|------|------|------|
| Jiti | 支持 TS、别名、热重载 | 额外依赖 |
| 直接 import | 简单、快速 | 不支持 TS |

**选择**：Jiti
**原因**：插件需要 TS 支持和别名解析

### 2. Proxy Runtime vs 直接创建

| 方案 | 优势 | 劣势 |
|------|------|------|
| Proxy Runtime | 延迟加载、透明 | 代理开销 |
| 直接创建 | 简单、直接 | 立即加载所有依赖 |

**选择**：Proxy Runtime
**原因**：启动时不需要加载所有 channel runtime 依赖

### 3. 安全检查 vs 性能

| 方案 | 优势 | 劣势 |
|------|------|------|
| 完整检查 | 安全、可审计 | 性能开销 |
| 最小检查 | 快速 | 安全风险 |

**选择**：完整检查
**原因**：插件安全是第一优先级

### 4. 缓存 vs 实时扫描

| 方案 | 优势 | 劣势 |
|------|------|------|
| 缓存 | 快速、减少 IO | 可能过时 |
| 实时扫描 | 始终最新 | 性能开销 |

**选择**：缓存 + 短 TTL（默认 1 秒）
**原因**：平衡性能和实时性

---

*本文档基于源码分析，涵盖插件运行时的架构、插件发现、加载流程、Hooks 系统、服务管理以及技术权衡。*
