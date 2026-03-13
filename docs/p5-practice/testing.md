# Test Utils 测试工具 (Test Utils)

> "OpenClaw 的测试工具模块提供了全面的测试基础设施，包括端口管理、临时环境、Channel 插件 Mock、时间冻结、NPM 命令断言、仓库扫描等。端口管理系统使用确定性端口块分配，避免并行测试时的端口冲突。临时环境系统隔离 HOME 环境变量和状态目录，确保测试间的独立性。卧槽，端口分配的分块策略太聪明了——基于 worker ID 分配端口块，每个测试获得独立的 1000 端口范围，避免了衍生端口的冲突问题。"

---

## 核心技术洞察

### 1. 确定性端口块分配

```typescript
// src/test-utils/ports.ts
let nextTestPortOffset = 0;

export async function getDeterministicFreePortBlock(params?: {
  offsets?: number[];
}): Promise<number> {
  const offsets = params?.offsets ?? [0, 1, 2, 3, 4];
  const maxOffset = Math.max(...offsets);

  // 获取 worker ID
  const workerIdRaw = process.env.VITEST_WORKER_ID ?? process.env.VITEST_POOL_ID ?? "";
  const workerId = Number.parseInt(workerIdRaw, 10);
  const shard = Number.isFinite(workerId)
    ? Math.max(0, workerId)
    : isMainThread
      ? Math.abs(process.pid)
      : Math.abs(threadId);

  // 分配端口块：30,000-59,999，每个 worker 1000 端口
  const rangeSize = 1000;
  const shardCount = 30;
  const base = 30_000 + (Math.abs(shard) % shardCount) * rangeSize; // <= 59,999
  const usable = rangeSize - maxOffset;

  // 按块分配，避免衍生端口冲突
  const blockSize = Math.max(maxOffset + 1, 8);

  for (let attempt = 0; attempt < usable; attempt += blockSize) {
    const start = base + ((nextTestPortOffset + attempt) % usable);
    const ok = (await Promise.all(offsets.map((offset) => isPortFree(start + offset)))).every(
      Boolean,
    );
    if (!ok) {
      continue;
    }
    nextTestPortOffset = (nextTestPortOffset + attempt + blockSize) % usable;
    return start;
  }

  // Fallback: 让 OS 选择端口块
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const port = await getOsFreePort();
    const ok = (await Promise.all(offsets.map((offset) => isPortFree(port + offset)))).every(
      Boolean,
    );
    if (ok) {
      return port;
    }
  }

  throw new Error("failed to acquire a free port block");
}
```

**Leon 点评**：端口分配策略设计得非常巧妙：
1. **分块策略**：每个 worker 获得 1000 端口范围
2. **衍生端口安全**：blockSize ≥ maxOffset + 1，确保 port+1/port+2 不冲突
3. **轮询分配**：nextTestPortOffset 循环使用端口块
4. **双重回退**：OS 分配端口块 + 25 次重试

### 2. 临时 HOME 环境

```typescript
// src/test-utils/temp-home.ts
const HOME_ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "OPENCLAW_STATE_DIR",
] as const;

export async function createTempHomeEnv(prefix: string): Promise<TempHomeEnv> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.mkdir(path.join(home, ".openclaw"), { recursive: true });

  const snapshot = captureEnv([...HOME_ENV_KEYS]);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.OPENCLAW_STATE_DIR = path.join(home, ".openclaw");

  if (process.platform === "win32") {
    const match = home.match(/^([A-Za-z]:)(.*)$/);
    if (match) {
      process.env.HOMEDRIVE = match[1];
      process.env.HOMEPATH = match[2] || "\\";
    }
  }

  return {
    home,
    restore: async () => {
      snapshot.restore();
      await fs.rm(home, { recursive: true, force: true });
    },
  };
}
```

**Leon 点评**：临时 HOME 环境处理很全面：
1. **跨平台支持**：处理 Unix (HOME) 和 Windows (USERPROFILE/HOMEDRIVE/HOMEPATH)
2. **状态目录隔离**：创建独立的 .openclaw 目录
3. **环境快照**：captureEnv/restore 保存和恢复环境变量
4. **自动清理**：restore 时递归删除临时目录

### 3. Channel 插件测试辅助

```typescript
// src/test-utils/channel-plugins.ts
export const createTestRegistry = (channels: TestChannelRegistration[] = []): PluginRegistry => ({
  plugins: [],
  tools: [],
  hooks: [],
  typedHooks: [],
  channels: channels as unknown as PluginRegistry["channels"],
  providers: [],
  gatewayHandlers: {},
  httpRoutes: [],
  cliRegistrars: [],
  services: [],
  commands: [],
  diagnostics: [],
});

export const createChannelTestPluginBase = (params: {
  id: ChannelId;
  label?: string;
  docsPath?: string;
  capabilities?: ChannelCapabilities;
  config?: Partial<ChannelPlugin["config"]>;
}): Pick<ChannelPlugin, "id" | "meta" | "capabilities" | "config"> => ({
  id: params.id,
  meta: {
    id: params.id,
    label: params.label ?? String(params.id),
    selectionLabel: params.label ?? String(params.id),
    docsPath: params.docsPath ?? `/channels/${params.id}`,
    blurb: "test stub.",
  },
  capabilities: params.capabilities ?? { chatTypes: ["direct"] },
  config: {
    listAccountIds: () => ["default"],
    resolveAccount: () => ({}),
    ...params.config,
  },
});

export const createOutboundTestPlugin = (params: {
  id: ChannelId;
  outbound: ChannelOutboundAdapter;
  label?: string;
  docsPath?: string;
  capabilities?: ChannelCapabilities;
}): ChannelPlugin => ({
  ...createChannelTestPluginBase({
    id: params.id,
    label: params.label,
    docsPath: params.docsPath,
    capabilities: params.capabilities,
    config: { listAccountIds: () => [] },
  }),
  outbound: params.outbound,
});
```

**Leon 点评**：Channel 插件测试辅助设计得非常实用：
1. **最小化注册表**：只填充必要的 channels，其他字段为空
2. **合理的默认值**：chatTypes 默认 direct，listAccountIds 返回 ["default"]
3. **Builder 模式**：createChannelTestPluginBase → createOutboundTestPlugin
4. **类型安全**：Pick 提取必要的字段，避免过度约束

### 4. 时间冻结

```typescript
// src/test-utils/frozen-time.ts
import { vi } from "vitest";

export function useFrozenTime(at: string | number | Date): void {
  vi.useFakeTimers();
  vi.setSystemTime(at);
}

export function useRealTime(): void {
  vi.useRealTimers();
}
```

**Leon 点评**：时间冻结简洁有效：
1. **Vitest 集成**：使用 vi.useFakeTimers 和 vi.setSystemTime
2. **灵活输入**：支持字符串、数字时间戳、Date 对象
3. **对称 API**：useFrozenTime / useRealTime 配对使用

### 5. NPM 命令断言

```typescript
// src/test-utils/channel-plugins.ts (npm-spec-install-test-helpers.ts)
function canonicalizeComparableDir(dirPath: string): string {
  const normalized = normalizeDarwinTmpPath(path.resolve(dirPath));
  try {
    return normalizeDarwinTmpPath(fs.realpathSync.native(normalized));
  } catch {
    return normalized;
  }
}

export function expectSingleNpmInstallIgnoreScriptsCall(params: {
  calls: Array<[unknown, { cwd?: string } | undefined]>;
  expectedTargetDir: string;
}) {
  const npmCalls = params.calls.filter((call) => Array.isArray(call[0]) && call[0][0] === "npm");
  expect(npmCalls.length).toBe(1);
  const first = npmCalls[0];
  if (!first) {
    throw new Error("expected npm install call");
  }
  const [argv, opts] = first;
  expect(argv).toEqual([
    "npm",
    "install",
    "--omit=dev",
    "--omit=peer",
    "--silent",
    "--ignore-scripts",
  ]);
  expect(opts?.cwd).toBeTruthy();
  const cwd = String(opts?.cwd);
  const expectedTargetDir = params.expectedTargetDir;
  expect(canonicalizeComparableDir(path.dirname(cwd))).toBe(
    canonicalizeComparableDir(path.dirname(expectedTargetDir)),
  );
  expect(path.basename(cwd)).toMatch(/^\.openclaw-install-stage-/);
}

export function expectSingleNpmPackIgnoreScriptsCall(params: {
  calls: Array<[unknown, unknown]>;
  expectedSpec: string;
}) {
  const packCalls = params.calls.filter(
    (call) => Array.isArray(call[0]) && call[0][0] === "npm" && call[0][1] === "pack",
  );
  expect(packCalls.length).toBe(1);
  const packCall = packCalls[0];
  if (!packCall) {
    throw new Error("expected npm pack call");
  }
  const [argv, options] = packCall;
  expect(argv).toEqual(["npm", "pack", params.expectedSpec, "--ignore-scripts", "--json"]);
  const commandOptions = typeof options === "number" ? undefined : options;
  expect(commandOptions).toMatchObject({ env: { NPM_CONFIG_IGNORE_SCRIPTS: "true" } });
}
```

**Leon 点评**：NPM 命令断言设计得很实用：
1. **命令过滤**：从所有调用中筛选 npm 调用
2. **参数验证**：精确验证 argv 数组
3. **目录规范化**：处理 Darwin /private/var 前缀
4. **临时目录匹配**：验证 `.openclaw-install-stage-*` 模式

### 6. 仓库扫描

```typescript
// src/test-utils/repo-scan.ts
export const DEFAULT_REPO_SCAN_SKIP_DIR_NAMES = new Set([".git", "dist", "node_modules"]);
export const DEFAULT_RUNTIME_SOURCE_ROOTS = ["src", "extensions"] as const;
export const DEFAULT_RUNTIME_SOURCE_EXTENSIONS = [".ts", ".tsx"] as const;
export const RUNTIME_SOURCE_SKIP_PATTERNS = [
  /\.test\.tsx?$/,
  /\.test-helpers\.tsx?$/,
  /\.test-utils\.tsx?$/,
  /\.e2e\.tsx?$/,
  /\.d\.ts$/,
  /\/(?:__tests__|tests)\//,
  /\/[^/]*test-helpers(?:\.[^/]+)?\.tsx?$/,
  /\/[^/]*test-utils(?:\.[^/]+)?\.tsx?$/,
] as const;

const runtimeSourceScanCache = new Map<string, Promise<Array<string>>>();

export async function listRepoFiles(
  repoRoot: string,
  options: RepoFileScanOptions,
): Promise<Array<string>> {
  const files: Array<string> = [];
  const pending: Array<PendingDir> = [];

  for (const root of options.roots) {
    const absolutePath = path.join(repoRoot, root);
    try {
      const stats = await fs.stat(absolutePath);
      if (stats.isDirectory()) {
        pending.push({ absolutePath });
      }
    } catch {
      // Skip missing roots. Useful when extensions/ is absent.
    }
  }

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) {
      continue;
    }
    const entries = await fs.readdir(current.absolutePath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!shouldSkipDirectory(entry.name, options)) {
          pending.push({ absolutePath: path.join(current.absolutePath, entry.name) });
        }
        continue;
      }
      if (!entry.isFile() || !hasAllowedExtension(entry.name, options.extensions)) {
        continue;
      }
      const filePath = path.join(current.absolutePath, entry.name);
      const relativePath = path.relative(repoRoot, filePath);
      if (options.shouldIncludeFile && !options.shouldIncludeFile(relativePath)) {
        continue;
      }
      files.push(filePath);
    }
  }

  files.sort((a, b) => a.localeCompare(b));
  return files;
}

export async function listRuntimeSourceFiles(
  repoRoot: string,
  options: RuntimeSourceScanOptions = {},
): Promise<Array<string>> {
  const roots = options.roots ?? DEFAULT_RUNTIME_SOURCE_ROOTS;
  const requestedExtensions = toSortedUnique(
    options.extensions ?? DEFAULT_RUNTIME_SOURCE_EXTENSIONS,
  );
  const cacheKey = getRuntimeScanCacheKey(repoRoot, roots);

  let pending = runtimeSourceScanCache.get(cacheKey);
  if (!pending) {
    pending = listRepoFiles(repoRoot, {
      roots,
      extensions: DEFAULT_RUNTIME_SOURCE_EXTENSIONS,
      skipHiddenDirectories: true,
      shouldIncludeFile: (relativePath) => !shouldSkipRuntimeSourcePath(relativePath),
    });
    runtimeSourceScanCache.set(cacheKey, pending);
  }
  const files = await pending;
  return files.filter((filePath) =>
    requestedExtensions.some((extension) => filePath.endsWith(extension)),
  );
}
```

**Leon 点评**：仓库扫描实现得很健壮：
1. **缓存机制**：runtimeSourceScanCache 避免重复扫描
2. **错误容忍**：missing roots 静默跳过，extensions/ 可选
3. **深度遍历**：栈式迭代代替递归，避免栈溢出
4. **文件过滤**：扩展名 + 测试文件模式双重过滤

---

## 一、测试工具架构总览

### 核心组件

```
Test Utils
├── Port Management（端口管理）
│   ├── Deterministic Block（确定性块分配）
│   ├── Worker Sharding（Worker 分片）
│   └── Fallback（回退机制）
├── Temp Environment（临时环境）
│   ├── Temp Home（临时 HOME）
│   ├── Temp Dir（临时目录）
│   └── Env Snapshot（环境快照）
├── Plugin Test Helpers（插件测试辅助）
│   ├── Test Registry（测试注册表）
│   ├── Channel Plugin Base（Channel 插件基础）
│   └── Outbound Test Plugin（出站测试插件）
├── Time Control（时间控制）
│   ├── Frozen Time（时间冻结）
│   └── Real Time（真实时间）
├── NPM Assertions（NPM 断言）
│   ├── Install Call（安装调用断言）
│   └── Pack Call（打包调用断言）
├── Repo Scanning（仓库扫描）
│   ├── File Listing（文件列表）
│   ├── Runtime Sources（运行时源码）
│   └── Cache（缓存）
└── Misc Helpers（其他辅助）
    ├── Frozen Time（时间冻结）
    ├── Fetch Mock（Fetch Mock）
    ├── Exec Assertions（Exec 断言）
    └── Chunk Test Helpers（块测试辅助）
```

### 使用流程

```
Setup Test
    ↓
Create Temp Home Env
    ↓
Allocate Free Port Block
    ↓
Setup Test Registry
    ↓
Use Frozen Time (if needed)
    ↓
Run Test
    ↓
Assert Results
    ↓
Restore Environment
    ↓
Cleanup Temp Home
```

---

## 二、类型系统

### 端口管理类型

```typescript
type PortBlockOptions = {
  offsets?: number[];  // 衍生端口偏移量 [0, 1, 2, 3, 4]
};

type PortPermissionFallback = {
  offsets: number[];
  fallbackBase: number;
};
```

### 临时环境类型

```typescript
type TempHomeEnv = {
  home: string;
  restore: () => Promise<void>;
};

type TrackedTempDirs = {
  add: (path: string) => void;
  cleanup: () => Promise<void>;
};
```

### Channel 插件类型

```typescript
type TestChannelRegistration = {
  pluginId: string;
  plugin: unknown;
  source: string;
};

type ChannelTestPluginBaseParams = {
  id: ChannelId;
  label?: string;
  docsPath?: string;
  capabilities?: ChannelCapabilities;
  config?: Partial<ChannelPlugin["config"]>;
};
```

### 仓库扫描类型

```typescript
type RepoFileScanOptions = {
  roots: readonly string[];
  extensions: readonly string[];
  skipDirNames?: ReadonlySet<string>;
  skipHiddenDirectories?: boolean;
  shouldIncludeFile?: (relativePath: string) => boolean;
};

type RuntimeSourceScanOptions = {
  roots?: readonly string[];
  extensions?: readonly string[];
};
```

---

## 三、端口管理

### 端口块分配策略

```
Worker ID → Shard Index → Port Base
    ↓           ↓              ↓
  worker-1     0         30,000 - 30,999
  worker-2     1         31,000 - 31,999
  worker-3     2         32,000 - 32,999
  ...
  worker-30    29        59,000 - 59,999
```

### 端口块参数

| 参数 | 默认值 | 描述 |
|------|--------|------|
| offsets | [0, 1, 2, 3, 4] | 衍生端口偏移量 |
| rangeSize | 1000 | 每个 worker 的端口范围 |
| shardCount | 30 | Worker 分片数量 |
| base | 30,000 | 起始端口 |
| blockSize | max(8, maxOffset + 1) | 分块大小 |

### 使用示例

```typescript
// 分配端口块：测试服务 +1, +2, +3 端口
const basePort = await getDeterministicFreePortBlock({
  offsets: [0, 1, 2, 3],  // 使用 base, base+1, base+2, base+3
});

// basePort = 30,000 (worker 1)
// 使用端口：30,000, 30,001, 30,002, 30,003
```

### 权限回退

```typescript
const port = await getFreePortBlockWithPermissionFallback({
  offsets: [0, 1],
  fallbackBase: 8000,  // EPERM/EACCES 时使用 8000 + pid % 10000
});
```

---

## 四、临时环境

### Temp Home

```typescript
const { home, restore } = await createTempHomeEnv("openclaw-test-");

// home: /tmp/openclaw-test-xxx
// process.env.HOME → home
// process.env.OPENCLAW_STATE_DIR → home/.openclaw

// 测试完成后清理
await restore();
```

### 环境变量覆盖

| 平台 | 环境变量 |
|------|---------|
| Unix/Linux | HOME, OPENCLAW_STATE_DIR |
| Windows | USERPROFILE, HOMEDRIVE, HOMEPATH, OPENCLAW_STATE_DIR |

### Tracked Temp Dirs

```typescript
const tracked = createTrackedTempDirs();
tracked.add("/tmp/test-dir-1");
tracked.add("/tmp/test-dir-2");

// 批量清理
await tracked.cleanup();
```

---

## 五、Channel 插件测试

### 创建测试注册表

```typescript
const registry = createTestRegistry([
  {
    pluginId: "test-channel",
    plugin: testChannelPlugin,
    source: "test",
  },
]);
```

### 创建测试插件

```typescript
const plugin = createChannelTestPluginBase({
  id: "test-channel",
  label: "Test Channel",
  docsPath: "/channels/test",
  capabilities: { chatTypes: ["direct", "group"] },
  config: {
    listAccountIds: () => ["account-1", "account-2"],
    resolveAccount: (id) => ({ id, name: id }),
  },
});
```

### 创建出站测试插件

```typescript
const outboundPlugin = createOutboundTestPlugin({
  id: "test-outbound",
  outbound: async (message) => {
    console.log("Sent:", message);
  },
  capabilities: { chatTypes: ["direct"] },
});
```

### MS Teams 测试插件

```typescript
const teamsPlugin = createMSTeamsTestPlugin({
  aliases: ["teams", "msteams"],
  outbound: async (message) => { /* ... */ },
});
```

---

## 六、时间控制

### 冻结时间

```typescript
test("with frozen time", () => {
  useFrozenTime("2024-01-01T00:00:00Z");
  // Date.now() 返回固定时间

  useRealTime();  // 恢复真实时间
});
```

### 时间格式

| 格式 | 示例 |
|------|------|
| ISO String | "2024-01-01T00:00:00Z" |
| Timestamp | 1704067200000 |
| Date Object | new Date("2024-01-01") |

---

## 七、NPM 断言

### Install 断言

```typescript
expectSingleNpmInstallIgnoreScriptsCall({
  calls: execSpy.mock.calls,
  expectedTargetDir: "/path/to/plugin",
});

// 验证：
// - 只有一次 npm install 调用
// - argv: ["npm", "install", "--omit=dev", "--omit=peer", "--silent", "--ignore-scripts"]
// - cwd 是 expectedTargetDir 父目录的 .openclaw-install-stage-* 子目录
```

### Pack 断言

```typescript
expectSingleNpmPackIgnoreScriptsCall({
  calls: execSpy.mock.calls,
  expectedSpec: "/path/to/spec",
});

// 验证：
// - 只有一次 npm pack 调用
// - argv: ["npm", "pack", spec, "--ignore-scripts", "--json"]
// - env.NPM_CONFIG_IGNORE_SCRIPTS = "true"
```

---

## 八、仓库扫描

### 扫描配置

```typescript
// 扫描默认运行时源码
const files = await listRuntimeSourceFiles(repoRoot);
// roots: ["src", "extensions"]
// extensions: [".ts", ".tsx"]

// 自定义扫描
const files = await listRepoFiles(repoRoot, {
  roots: ["custom-src"],
  extensions: [".js", ".ts"],
  skipDirNames: new Set([".git", "node_modules", "dist"]),
  skipHiddenDirectories: true,
  shouldIncludeFile: (path) => !path.includes("/test/"),
});
```

### 跳过模式

| 模式 | 描述 |
|------|------|
| `/\.test\.tsx?$/` | 测试文件 |
| `/\.test-helpers\.tsx?$/` | 测试辅助文件 |
| `/\.e2e\.tsx?$/` | E2E 测试文件 |
| `/\.d\.ts$/` | TypeScript 声明文件 |
| `/\/(?:__tests__|tests)\//` | 测试目录 |
| `/\/[^/]*test-helpers/` | test-helpers 文件 |
| `/\/[^/]*test-utils/` | test-utils 文件 |

### 缓存键

```typescript
const cacheKey = `${repoRoot}::${roots.join(",")}`;
// 例如: "/path/to/repo::src,extensions"
```

---

## 九、其他辅助工具

### Exec 断言

```typescript
expectExecSuccess(result);
expectExecFailure(result, "expected error message");
```

### Fetch Mock

```typescript
const mockFetch = createFetchMock();
mockFetch.intercept("https://api.example.com/data", {
  status: 200,
  body: { result: "ok" },
});
```

### Chunk Test Helpers

```typescript
const chunks = createTestChunks([1, 2, 3, 4, 5], 2);
// [[1, 2], [3, 4], [5]]
```

---

## 十、技术权衡

### 1. 确定性端口 vs OS 分配

| 方案 | 优势 | 劣势 |
|------|------|------|
| 确定性端口 | 可重现、避免冲突 | 需要管理端口范围 |
| OS 分配 | 简单 | 不可重现、可能冲突 |

**选择**：确定性端口优先，OS 分配回退
**原因**：测试可重现性优先，OS 分配作为回退机制

### 2. 临时环境 vs 污染环境

| 方案 | 优势 | 劣势 |
|------|------|------|
| 临时环境 | 隔离、安全 | 设置成本 |
| 污染环境 | 简单 | 干扰其他测试 |

**选择**：临时环境
**原因**：测试隔离性优先，避免状态污染

### 3. 时间冻结 vs 真实时间

| 方案 | 优势 | 劣势 |
|------|------|------|
| 时间冻结 | 可预测、可重现 | 不真实 |
| 真实时间 | 真实 | 不可预测 |

**选择**：时间冻结
**原因**：测试可预测性优先

### 4. 缓存 vs 每次扫描

| 方案 | 优势 | 劣势 |
|------|------|------|
| 缓存 | 快速 | 可能过期 |
| 每次扫描 | 最新 | 慢 |

**选择**：缓存
**原因**：仓库扫描成本高，运行时源码不变

---

*本文档基于源码分析，涵盖测试工具的架构、端口管理、临时环境、Channel 插件测试、时间控制、NPM 断言、仓库扫描以及技术权衡。*
