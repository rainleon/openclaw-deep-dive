# OpenClaw 记忆系统架构分析

> 基于源码的一手分析 · 深入理解作者原始设计意图

---

## 核心技术洞察

### 1. 双后端架构的战略布局

```typescript
export type MemoryBackend = "builtin" | "qmd";

// builtin: 内置 SQLite + 向量扩展
// qmd: 外部 qmd 工具进程通信
```

**Leon 的评价**：
这个设计体现了作者的野心。builtin 满足 90% 用户的需求（本地 Markdown 笔记），qmd 为高级用户留出扩展空间（大规模索引、分布式部署）。最关键的是，两者共享同一套配置接口，用户可以无缝切换。这种"简单内置 + 专业扩展"的组合拳，卧槽，真牛逼。

### 2. FTS-Only 降级模式的生存智慧

```typescript
// 无嵌入提供商时的搜索逻辑
if (!this.provider) {
  if (!this.fts.enabled || !this.fts.available) {
    log.warn("memory search: no provider and FTS unavailable");
    return [];
  }

  // 提取关键词
  const keywords = extractKeywords(cleaned);
  const searchTerms = keywords.length > 0 ? keywords : [cleaned];

  // 多关键词搜索 + 结果合并
  const resultSets = await Promise.all(
    searchTerms.map((term) => this.searchKeyword(term, candidates).catch(() => [])),
  );

  // 去重，保留最高分
  const seenIds = new Map<string, Result>();
  for (const results of resultSets) {
    for (const result of results) {
      const existing = seenIds.get(result.id);
      if (!existing || result.score > existing.score) {
        seenIds.set(result.id, result);
      }
    }
  }
}
```

**Leon 的评价**：
这种降级策略太他妈关键了。很多 AI 工具的致命问题是：没有 API Key 就完全不能用。OpenClaw 的做法是：没有嵌入模型也能用，只是从"语义搜索"退化成"关键词搜索"。这种"能用但不完美"的设计哲学，才是产品化思维，而不是学术思维。

### 3. 混合搜索的权重平衡艺术

```typescript
// 向量分 + 文本分，权重可调
const score = params.vectorWeight * entry.vectorScore + params.textWeight * entry.textScore;

// 默认配置
vectorWeight: 0.7,  // 语义相关性
textWeight: 0.3,   // 关键词匹配
```

**设计原理**：
- **向量搜索**擅长理解语义："那个关于 API 的讨论"
- **FTS 搜索**擅长精确匹配：文件名、专有名词、代码片段

**Leon 的评价**：
70/30 的默认权重很合理。纯向量搜索有个致命问题：专有名词（人名、API 名）会被泛化。加上 30% 的 FTS，既保留了语义理解，又确保了精确匹配。不过作者应该明确告诉用户这个权衡，而不是让大家默认接受。

### 4. MMR 重排序的多样性保证

```typescript
// MMR = λ * relevance - (1-λ) * max_similarity_to_selected
export function computeMMRScore(relevance: number, maxSimilarity: number, lambda: number): number {
  return lambda * relevance - (1 - lambda) * maxSimilarity;
}

// 默认配置
enabled: false,  // 需要显式启用
lambda: 0.7,     // 0 = max diversity, 1 = max relevance
```

**算法逻辑**：
1. 选择相关性最高的第一项
2. 对每个候选项，计算它与已选项的最大相似度
3. MMR 分数 = λ × 相关性 - (1-λ) × 最大相似度
4. 选择 MMR 分数最高的候选项

**Leon 的评价**：
MMR 是经典的信息检索算法，1998 年就提出了。OpenClaw 的实现很干净，用 Jaccard 相似度代替向量相似度（更轻量）。默认禁用是对的：多样性会牺牲精确度，让用户自己选。这种不替用户做决定的克制，值得赞赏。

### 5. 时间衰减的指数模型

```typescript
export function calculateTemporalDecayMultiplier(params: {
  ageInDays: number;
  halfLifeDays: number;
}): number {
  const lambda = Math.LN2 / params.halfLifeDays;
  return Math.exp(-lambda * params.ageInDays);
}

// 应用到分数
score = score * Math.exp(-lambda * ageInDays);
```

**衰减曲线**：
```
半衰期 30 天：
- 0 天  → 分数 × 1.00
- 30 天 → 分数 × 0.50
- 60 天 → 分数 × 0.25
- 90 天 → 分数 × 0.125
```

**常青内容例外**：
```typescript
// MEMORY.md, memory.md, memory/*.md 不衰减
if (params.source === "memory" && isEvergreenMemoryPath(params.filePath)) {
  return null; // 不应用衰减
}

// 日期格式文件才衰减：memory/2025-03-10.md
const DATED_MEMORY_PATH_RE = /(?:^|\/)memory\/(\d{4})-(\d{2})-(\d{2})\.md$/;
```

**Leon 的评价**：
这个设计考虑得很周全。日记式笔记（2025-03-10.md）会随时间贬值，但知识库（MEMORY.md）不应该衰减。用文件路径区分两种内容，既简单又直观。唯一的问题是：用户可能不知道这个规则，导致意外行为。文档需要强调这一点。

### 6. 只读数据库错误的自动恢复

```typescript
private async runSyncWithReadonlyRecovery(params?: {...}): Promise<void> {
  try {
    await this.runSync(params);
    return;
  } catch (err) {
    if (!this.isReadonlyDbError(err) || this.closed) {
      throw err;
    }

    // 检测到只读错误，重新打开数据库
    log.warn(`memory sync readonly handle detected; reopening sqlite connection`, { reason });
    try {
      this.db.close();
    } catch {}
    this.db = this.openDatabase();
    this.vectorReady = null;
    this.vector.available = null;
    this.ensureSchema();

    // 重试同步
    await this.runSync(params);
    this.readonlyRecoverySuccesses += 1;
  }
}
```

**Leon 的评价**：
这是实战经验的体现。SQLite 的只读错误通常发生在：
- 网络驱动器连接中断
- 外部硬盘被卸载
- 文件权限意外变更

很多系统遇到这种错误就直接崩溃，OpenClaw 能自动恢复，这种鲁棒性是生产环境必需的。唯一的问题是：如果数据库真的损坏（不是只读），这种重试会陷入死循环。应该加一个重试次数限制。

### 7. 四键嵌入缓存的精准去重

```typescript
CREATE TABLE embedding_cache (
  provider TEXT NOT NULL,      -- openai, gemini, voyage...
  model TEXT NOT NULL,         -- text-embedding-3-small, embed-001...
  provider_key TEXT NOT NULL,  -- API 密钥哈希（多用户隔离）
  hash TEXT NOT NULL,          -- 内容哈希
  embedding TEXT NOT NULL,
  dims INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (provider, model, provider_key, hash)
);
```

**四键设计**：
- **provider** + **model**：不同提供商的向量不兼容
- **provider_key**：同一文本，不同用户的嵌入需要分别缓存（隔离）
- **hash**：内容去重

**Leon 的评价**：
这个四键设计非常精准。特别是 `provider_key`，很多系统会忽略这一点，导致多用户场景下的缓存混乱。不过有个潜在问题：如果用户换了 API Key（同一提供商），缓存会失效。但这是正确的行为：不同 Key 可能对应不同的账户配额，不应该共享缓存。

### 8. 来源隔离的设计哲学

```typescript
export type MemorySource = "memory" | "sessions";

// memory: 用户主动维护的笔记
// sessions: 历史对话记录
```

**schema 层面的隔离**：
```sql
CREATE TABLE files (
  path TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'memory',  -- 隔离字段
  hash TEXT NOT NULL,
  mtime INTEGER NOT NULL,
  size INTEGER NOT NULL
);

CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'memory',  -- 隔离字段
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  hash TEXT NOT NULL,
  model TEXT NOT NULL,
  text TEXT NOT NULL,
  embedding TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

**Leon 的评价**：
这个隔离设计非常有前瞻性。笔记和对话是两种完全不同的内容：
- **笔记**：用户精心整理的知识，应该长期保留
- **会话**：临时上下文，可能需要定期清理

把它们放在同一张表里，未来可以实现统一的搜索，同时又能分别管理。不过现在的代码里，sessions 的管理逻辑还不够完善（比如没有自动清理旧会话的机制）。

### 9. QMD 外部进程的接口抽象

```typescript
export type ResolvedQmdConfig = {
  command: string;           // qmd 可执行文件路径
  mcporter: {
    enabled: boolean;        // 是否启用 mcporter 服务器
    serverName: string;      // 服务器名称
    startDaemon: boolean;    // 是否自动启动守护进程
  };
  searchMode: "search" | "vsearch" | "query";  // 搜索模式
  collections: ResolvedQmdCollection[];        // 索引集合
  sessions: {
    enabled: boolean;
    exportDir?: string;
    retentionDays?: number;
  };
  update: {
    intervalMs: number;      // 更新间隔
    debounceMs: number;      // 防抖延迟
    onBoot: boolean;         // 启动时同步
    waitForBootSync: boolean;
    embedIntervalMs: number;
    commandTimeoutMs: number;
    updateTimeoutMs: number;
    embedTimeoutMs: number;
  };
  limits: {
    maxResults: number;
    maxSnippetChars: number;
    maxInjectedChars: number;
    timeoutMs: number;
  };
};
```

**设计亮点**：
- **三种搜索模式**：
  - `search`：纯向量搜索（最快，适合交互）
  - `vsearch`：向量搜索 + 结果数量限制
  - `query`：查询扩展 + 重排序（最慢，召回率最高）

- **默认选择 `search`**：注释说"CPU-only 系统上 query 模式极慢"，所以默认用更快的模式

**Leon 的评价**：
这种"默认保守，用户可选激进"的策略是对的。大多数用户不会等 10 秒钟看搜索结果，快速响应更重要。需要高召回率的用户可以自己切换到 query 模式。不过 UI 上应该明确标注每种模式的性能差异，否则用户会不知道为什么有时快有时慢。

---

## 一、记忆系统架构总览

### 核心职责

| 子模块 | 职责 |
|--------|------|
| **manager.ts** | 主管理器，协调所有子模块 |
| **manager-search.ts** | 向量搜索 + FTS 搜索 |
| **hybrid.ts** | 混合结果合并 + MMR 重排序 |
| **temporal-decay.ts** | 时间衰减计算 |
| **mmr.ts** | 最大边际相关性算法 |
| **embeddings.ts** | 嵌入提供商抽象（OpenAI/Gemini/Voyage/Mistral/Ollama） |
| **memory-schema.ts** | SQLite 数据库 schema |
| **backend-config.ts** | 后端配置解析（builtin/qmd） |
| **qmd-manager.ts** | QMD 外部进程管理器 |

### 数据流向

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         记忆系统数据流                                   │
└─────────────────────────────────────────────────────────────────────────┘

用户查询
    │
    ▼
┌───────────────────────────────────────────────────────────────┐
│  manager.search()                                              │
│  1. 检查是否需要同步 (dirty flag)                               │
│  2. 提取关键词 (FTS-only 模式)                                  │
│  3. 嵌入查询向量 (混合模式)                                     │
└───────────────────────────────────────────────────────────────┘
    │
    ├─────────────────┬─────────────────┐
    ▼                 ▼                 ▼
[FTS-Only 模式]   [向 量 搜 索]     [关 键 词 搜 索]
    │                 │                 │
    │           searchVector()    searchKeyword()
    │                 │                 │
    └─────────────────┴─────────────────┘
                      │
                      ▼
        ┌─────────────────────────────────┐
        │  mergeHybridResults()           │
        │  • score = 0.7*vector + 0.3*text │
        │  • 时间衰减                      │
        │  • MMR 重排序                    │
        └─────────────────────────────────┘
                      │
                      ▼
              MemorySearchResult[]
              (去重、过滤、切片)
```

### Schema 结构

```
memory.db
├── meta (key-value 存储)
│   └── vectorDims: 1536  (向量维度)
├── files (文件索引)
│   ├── path: "memory/api-design.md"
│   ├── source: "memory" | "sessions"
│   ├── hash: SHA256
│   ├── mtime: 修改时间
│   └── size: 文件大小
├── chunks (文本块)
│   ├── id: "{path}:{startLine}:{endLine}"
│   ├── path: "memory/api-design.md"
│   ├── source: "memory" | "sessions"
│   ├── startLine: 10
│   ├── endLine: 30
│   ├── text: "..."
│   ├── model: "text-embedding-3-small"
│   └── embedding: "[0.1, -0.2, ...]"
├── chunks_vec (向量扩展)
│   └── embedding: BLOB (Float32Array)
├── chunks_fts (全文搜索表)
│   └── text, id, path, source, start_line, end_line
└── embedding_cache (嵌入缓存)
    ├── provider: "openai"
    ├── model: "text-embedding-3-small"
    ├── provider_key: "sk-xxx...sha256"
    ├── hash: SHA256(文本)
    └── embedding: "[0.1, -0.2, ...]"
```

---

## 二、核心组件分析

### 2.1 manager.ts - 主管理器

**文件**：`src/memory/manager.ts`

**单例缓存模式**：
```typescript
const INDEX_CACHE = new Map<string, MemoryIndexManager>();
const INDEX_CACHE_PENDING = new Map<string, Promise<MemoryIndexManager>>();

static async get(params: {
  cfg: OpenClawConfig;
  agentId: string;
  purpose?: "default" | "status";
}): Promise<MemoryIndexManager | null> {
  const key = `${agentId}:${workspaceDir}:${JSON.stringify(settings)}`;
  const existing = INDEX_CACHE.get(key);
  if (existing) {
    return existing;
  }

  // 防止重复创建
  const pending = INDEX_CACHE_PENDING.get(key);
  if (pending) {
    return pending;
  }

  const createPromise = (async () => {
    // ... 创建逻辑
    const manager = new MemoryIndexManager({...});
    INDEX_CACHE.set(key, manager);
    return manager;
  })();

  INDEX_CACHE_PENDING.set(key, createPromise);
  try {
    return await createPromise;
  } finally {
    INDEX_CACHE_PENDING.delete(key);
  }
}
```

**自动同步触发器**：
```typescript
// 1. 搜索时同步（懒加载）
if (this.settings.sync.onSearch && (this.dirty || this.sessionsDirty)) {
  void this.sync({ reason: "search" }).catch((err) => {
    log.warn(`memory sync failed (search): ${String(err)}`);
  });
}

// 2. 会话开始时同步（预热）
async warmSession(sessionKey?: string): Promise<void> {
  if (!this.settings.sync.onSessionStart) {
    return;
  }
  void this.sync({ reason: "session-start" }).catch((err) => {
    log.warn(`memory sync failed (session-start): ${String(err)}`);
  });
}

// 3. 定时同步
ensureIntervalSync() {
  this.intervalTimer = setInterval(() => {
    void this.sync({ reason: "interval" }).catch(() => {});
  }, this.settings.sync.intervalMs);
}

// 4. 文件监听同步
ensureWatcher() {
  this.watcher = chokidar.watch(paths, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 100 },
  }).on("all", () => {
    this.dirty = true;
    // 防抖
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(() => {
      void this.sync({ reason: "watcher" }).catch(() => {});
    }, this.settings.sync.debounceMs);
  });
}
```

### 2.2 manager-search.ts - 搜索实现

**文件**：`src/memory/manager-search.ts`

**向量搜索（双路径）**：
```typescript
export async function searchVector(params: {...}): Promise<SearchRowResult[]> {
  // 路径 A: sqlite-vec 扩展（原生加速）
  if (await params.ensureVectorReady(params.queryVec.length)) {
    const rows = params.db.prepare(
      `SELECT c.id, c.path, c.start_line, c.end_line, c.text,
              c.source,
              vec_distance_cosine(v.embedding, ?) AS dist
         FROM ${params.vectorTable} v
         JOIN chunks c ON c.id = v.id
        WHERE c.model = ?${params.sourceFilterVec.sql}
        ORDER BY dist ASC
        LIMIT ?`
    ).all(vectorToBlob(params.queryVec), params.providerModel, ...);

    return rows.map((row) => ({
      ...,
      score: 1 - row.dist,  // 余弦距离 → 相似度
    }));
  }

  // 路径 B: 内存计算（降级方案）
  const candidates = listChunks({ db, providerModel });
  const scored = candidates.map((chunk) => ({
    chunk,
    score: cosineSimilarity(params.queryVec, chunk.embedding),
  }));
  return scored.toSorted((a, b) => b.score - a.score);
}
```

**关键词搜索（BM25）**：
```typescript
export async function searchKeyword(params: {...}): Promise<SearchRowResult[]> {
  const ftsQuery = params.buildFtsQuery(params.query);
  // "discussed API" → "discussed" AND "API"

  const rows = params.db.prepare(
    `SELECT id, path, source, start_line, end_line, text,
            bm25(${params.ftsTable}) AS rank
       FROM ${params.ftsTable}
      WHERE ${params.ftsTable} MATCH ?${modelClause}${sourceFilter.sql}
      ORDER BY rank ASC
      LIMIT ?`
  ).all(ftsQuery, ...);

  return rows.map((row) => {
    const textScore = params.bm25RankToScore(row.rank);
    // BM25 rank 越小越好 → 转换为 [0, 1] 分数
    return {
      ...,
      score: textScore,
      textScore,
    };
  });
}

// BM25 rank → score 转换
export function bm25RankToScore(rank: number): number {
  if (rank < 0) {
    // 负 rank 表示高相关（BM25 扩展）
    const relevance = -rank;
    return relevance / (1 + relevance);
  }
  // 正 rank，越小越好
  return 1 / (1 + rank);
}
```

### 2.3 hybrid.ts - 混合搜索

**文件**：`src/memory/hybrid.ts`

**结果合并逻辑**：
```typescript
export async function mergeHybridResults(params: {
  vector: HybridVectorResult[];
  keyword: HybridKeywordResult[];
  vectorWeight: number;
  textWeight: number;
  mmr?: Partial<MMRConfig>;
  temporalDecay?: Partial<TemporalDecayConfig>;
}): Promise<HybridResult[]> {
  // 1. 按 ID 合并结果
  const byId = new Map<string, MergedItem>();
  for (const r of params.vector) {
    byId.set(r.id, { ...r, textScore: 0 });
  }
  for (const r of params.keyword) {
    const existing = byId.get(r.id);
    if (existing) {
      existing.textScore = r.textScore;
    } else {
      byId.set(r.id, { ...r, vectorScore: 0 });
    }
  }

  // 2. 加权合并分数
  const merged = Array.from(byId.values()).map((entry) => ({
    ...entry,
    score: params.vectorWeight * entry.vectorScore +
            params.textWeight * entry.textScore,
  }));

  // 3. 时间衰减
  const decayed = await applyTemporalDecayToHybridResults({
    results: merged,
    temporalDecay: params.temporalDecay,
    workspaceDir: params.workspaceDir,
  });

  // 4. 排序
  const sorted = decayed.toSorted((a, b) => b.score - a.score);

  // 5. MMR 重排序（可选）
  if (params.mmr?.enabled) {
    return applyMMRToHybridResults(sorted, params.mmr);
  }

  return sorted;
}
```

**FTS 查询构建**：
```typescript
export function buildFtsQuery(raw: string): string | null {
  const tokens = raw.match(/[\p{L}\p{N}_]+/gu)  // Unicode 字母数字
    ?.map((t) => t.trim())
    .filter(Boolean) ?? [];
  if (tokens.length === 0) {
    return null;
  }
  const quoted = tokens.map((t) => `"${t.replaceAll('"', "")}"`);
  return quoted.join(" AND ");  // "discussed" AND "API"
}
```

### 2.4 memory-schema.ts - 数据库 Schema

**文件**：`src/memory/memory-schema.ts`

**Schema 初始化**：
```typescript
export function ensureMemoryIndexSchema(params: {
  db: DatabaseSync;
  embeddingCacheTable: string;
  ftsTable: string;
  ftsEnabled: boolean;
}): { ftsAvailable: boolean; ftsError?: string } {
  // 1. 元数据表
  params.db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // 2. 文件索引表
  params.db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'memory',
      hash TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL
    );
  `);

  // 3. 文本块表
  params.db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'memory',
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      hash TEXT NOT NULL,
      model TEXT NOT NULL,
      text TEXT NOT NULL,
      embedding TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  // 4. 嵌入缓存表
  params.db.exec(`
    CREATE TABLE IF NOT EXISTS ${params.embeddingCacheTable} (
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      provider_key TEXT NOT NULL,
      hash TEXT NOT NULL,
      embedding TEXT NOT NULL,
      dims INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (provider, model, provider_key, hash)
    );
  `);

  // 5. 全文搜索表（可选）
  let ftsAvailable = false;
  let ftsError: string | undefined;
  if (params.ftsEnabled) {
    try {
      params.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS ${params.ftsTable} USING fts5(
           text,
           id UNINDEXED,
           path UNINDEXED,
           source UNINDEXED,
           model UNINDEXED,
           start_line UNINDEXED,
           end_line UNINDEXED
         );`
      );
      ftsAvailable = true;
    } catch (err) {
      ftsAvailable = false;
      ftsError = err.message;
    }
  }

  // 6. 索引
  params.db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);`);
  params.db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);`);

  return { ftsAvailable, ftsError };
}

// 迁移：添加 source 列
function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  if (rows.some((row) => row.name === column)) {
    return;
  }
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
```

### 2.5 temporal-decay.ts - 时间衰减

**文件**：`src/memory/temporal-decay.ts`

**核心算法**：
```typescript
export function toDecayLambda(halfLifeDays: number): number {
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) {
    return 0;
  }
  return Math.LN2 / halfLifeDays;  // λ = ln(2) / T½
}

export function calculateTemporalDecayMultiplier(params: {
  ageInDays: number;
  halfLifeDays: number;
}): number {
  const lambda = toDecayLambda(params.halfLifeDays);
  return Math.exp(-lambda * params.ageInDays);  // e^(-λt)
}

export async function applyTemporalDecayToHybridResults<T>(
  results: T[],
  temporalDecay?: Partial<TemporalDecayConfig>,
  workspaceDir?: string,
): Promise<T[]> {
  const config = { ...DEFAULT_TEMPORAL_DECAY_CONFIG, ...temporalDecay };
  if (!config.enabled) {
    return [...results];
  }

  const timestampPromiseCache = new Map<string, Promise<Date | null>>();

  return Promise.all(
    results.map(async (entry) => {
      // 提取时间戳（带缓存）
      const cacheKey = `${entry.source}:${entry.path}`;
      let timestampPromise = timestampPromiseCache.get(cacheKey);
      if (!timestampPromise) {
        timestampPromise = extractTimestamp({
          filePath: entry.path,
          source: entry.source,
          workspaceDir,
        });
        timestampPromiseCache.set(cacheKey, timestampPromise);
      }

      const timestamp = await timestampPromise;
      if (!timestamp) {
        return entry;  // 常青内容，不衰减
      }

      const ageInDays = (Date.now() - timestamp.getTime()) / DAY_MS;
      const decayedScore = entry.score * calculateTemporalDecayMultiplier({
        ageInDays,
        halfLifeDays: config.halfLifeDays,
      });

      return { ...entry, score: decayedScore };
    }),
  );
}
```

**时间戳提取优先级**：
```typescript
// 1. 文件名中的日期
const DATED_MEMORY_PATH_RE = /(?:^|\/)memory\/(\d{4})-(\d{2})-(\d{2})\.md$/;
function parseMemoryDateFromPath(filePath: string): Date | null {
  const match = DATED_MEMORY_PATH_RE.exec(filePath);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const timestamp = Date.UTC(year, month - 1, day);
  return new Date(timestamp);
}

// 2. 常青内容不衰减
function isEvergreenMemoryPath(filePath: string): boolean {
  return filePath === "MEMORY.md" ||
         filePath === "memory.md" ||
         (filePath.startsWith("memory/") && !DATED_MEMORY_PATH_RE.test(filePath));
}

// 3. 文件修改时间
const stat = await fs.stat(absolutePath);
return new Date(stat.mtimeMs);
```

---

## 三、设计模式与权衡

### 3.1 双后端战略

| 维度 | builtin | qmd |
|------|---------|-----|
| **部署** | 内置，无需额外安装 | 外部进程，需要单独部署 |
| **性能** | 受限于单机 | 可分布式扩展 |
| **索引规模** | 适合 <100k 文档 | 适合 >100k 文档 |
| **搜索模式** | search (纯向量) | search/vsearch/query |
| **会话支持** | 原生支持 | 需要配置 exportDir |
| **用户群体** | 个人用户 | 团队/企业 |

### 3.2 搜索模式对比

| 模式 | 速度 | 召回率 | 适用场景 |
|------|------|--------|----------|
| **search** | 最快 | 中等 | 交互式搜索 |
| **vsearch** | 快 | 中等 | 需要结果数量限制 |
| **query** | 慢 | 最高 | 离线批量分析 |

### 3.3 同步策略对比

| 触发器 | 优点 | 缺点 |
|--------|------|------|
| **onSearch** | 按需同步，省资源 | 首次搜索慢 |
| **onSessionStart** | 预热完成，响应快 | 可能同步无用内容 |
| **interval** | 定期更新，不依赖事件 | 可能空转 |
| **watcher** | 实时响应 | 频繁写文件时性能差 |

### 3.4 错误分类与处理

| 错误类型 | 检测方式 | 处理策略 |
|----------|----------|----------|
| **只读数据库** | `SQLITE_READONLY` | 重新打开连接，重试 |
| **嵌入失败** | API 超时/错误 | 降级到 FTS-only |
| **FTS 不可用** | FTS5 加载失败 | 降级到纯向量 |
| **向量扩展不可用** | sqlite-vec 加载失败 | 内存计算余弦相似度 |

---

## 四、潜在问题与改进建议

### 4.1 只读恢复缺少重试限制

**问题**：如果数据库真的损坏（不是只读），重试会无限循环。

**建议**：
```typescript
private readonlyRecoveryAttempts = 0;
private readonlyRecoveryFailures = 0;
private static readonly MAX_READONLY_RECOVERY_ATTEMPTS = 3;

if (this.readonlyRecoveryAttempts >= MAX_READONLY_RECOVERY_ATTEMPTS) {
  log.error(`memory sync readonly recovery exceeded max attempts`);
  throw err;
}
```

### 4.2 时间衰减规则不够显式

**问题**：用户可能不知道 `memory/2025-03-10.md` 会衰减，而 `memory/api.md` 不会。

**建议**：
1. 在配置文档中明确说明规则
2. 提供覆盖选项：`temporalDecay.evergreenPatterns`

### 4.3 批处理失败后的降级策略

**问题**：批处理失败 2 次后禁用，但没有自动恢复机制。

**建议**：
```typescript
// 定期重试批处理
setInterval(async () => {
  if (this.batchFailureCount >= BATCH_FAILURE_LIMIT) {
    try {
      await this.embedBatchWithRetry(["ping"]);
      this.batchFailureCount = 0;  // 重置计数
      log.info(`memory batch processing recovered`);
    } catch {}
  }
}, BATCH_RETRY_INTERVAL_MS);
```

### 4.4 会话清理机制缺失

**问题**：sessions 表会无限增长，没有自动清理。

**建议**：
```typescript
// 配置项
sessions: {
  enabled: boolean;
  exportDir?: string;
  retentionDays?: number;  // 新增：保留天数
  cleanupIntervalDays?: number;  // 清理间隔
}

// 定期清理
if (retentionDays > 0) {
  const cutoffMs = Date.now() - retentionDays * DAY_MS;
  this.db.prepare(`DELETE FROM sessions WHERE updated_at < ?`).run(cutoffMs);
  this.db.prepare(`DELETE FROM chunks WHERE source = 'sessions' AND updated_at < ?`).run(cutoffMs);
}
```

---

## 五、总结

记忆系统是 OpenClaw 的"第二大脑"，其设计体现了以下原则：

1. **降级优先**：没有 API Key 也能用（FTS-only），崩溃了能自动恢复
2. **性能权衡**：默认用最快的 search 模式，需要召回率可以切换到 query
3. **隔离设计**：memory/sessions 来源隔离，provider/model/key 四键缓存
4. **时间感知**：日记式内容衰减，知识库内容常青
5. **双后端战略**：builtin 满足 90% 用户，qmd 留给高级用户

这个系统的复杂度远超一般 AI 工具的"简单向量搜索"，但每个复杂点都有明确的工程价值。这不是过度设计，而是面向生产环境的务实设计。

---

## 附录：Memory 与 Context-Engine 的关系

### Q: Memory 和 Context-Engine 是什么关系？

**A: 它们是互补但独立的两个子系统**

```
Memory (记忆系统)
├── 职责：搜索和检索长期知识
├── 关注：长期、知识库级别
├── 操作：向量搜索、语义检索
└── 目标：从外部知识库找到相关信息

Context-Engine (上下文引擎)
├── 职责：管理当前会话的消息上下文
├── 关注：短期、会话级别
├── 操作：选择哪些消息发给 AI
└── 目标：控制 token 使用，保持上下文相关
```

### Q: 当前如何协作？

**A: Memory 作为 Tool，Context-Engine 在消息组装阶段工作**

```typescript
// src/agents/tool-catalog.ts:101-104
// Memory 是一个独立的 Tool
{
  id: "memory_search",
  label: "memory_search",
  description: "Semantic search",
  sectionId: "memory",
}

// src/agents/pi-embedded-runner/run/attempt.ts:1422-1428
// Context-Engine 在 AI 调用前组装上下文
if (params.contextEngine) {
  const assembled = await params.contextEngine.assemble({
    sessionId: params.sessionId,
    messages: activeSession.messages,  // 当前会话的消息
    tokenBudget: params.contextTokenBudget,
  });

  // 可以通过 systemPromptAddition 添加额外内容
  if (assembled.systemPromptAddition) {
    systemPromptText += assembled.systemPromptAddition;
  }
}
```

**关键点**：
- **Context-Engine**：每次 AI 调用前自动工作，选择当前会话的消息
- **Memory**：通过 Tool 系统，由 AI 显式调用 `memory_search`
- 两者目前**没有自动集成**

### Q: 作者为什么这样设计？

**A: 务实的分阶段策略**

**设计原则**：
1. **职责分离** - 每个子系统专注于自己的领域
2. **避免耦合** - 不强求一开始就做完美集成
3. **保持简单** - 复杂的集成会增加理解和维护成本

**从源码可以看出作者的设计边界**：

```typescript
// src/agents/pi-settings.ts:103-106
// 当 Context-Engine ownsCompaction=true 时
// 禁用 Pi SDK 内部的 auto-compaction
export function shouldDisablePiAutoCompaction(params: {
  contextEngineInfo?: ContextEngineInfo;
}): boolean {
  return params.contextEngineInfo?.ownsCompaction === true;
}
```

这表明：
- **压缩决策权**明确属于 Context-Engine
- **Memory 不应该干扰**上下文管理

### Q: 未来可能的集成方向？

**A: 作者预留了扩展空间**

```typescript
// ContextEngine 接口设计
export interface ContextEngine {
  assemble(params: {
    sessionId: string;
    messages: AgentMessage[];
    tokenBudget?: number;
  }): Promise<AssembleResult>;

  // AssembleResult 支持 systemPromptAddition
  // 这可能是未来与 Memory 集成的入口
}
```

**可能的集成方案**：
1. Context-Engine 在 assemble 时自动调用 Memory 搜索
2. 将 Memory 搜索结果作为 systemPromptAddition 注入
3. 实现"RAG 增强的上下文管理"

### Q: Leon 的评价

**优点**：
- ✅ **务实**：不强求一开始就完美集成
- ✅ **清晰**：职责边界明确
- ✅ **可扩展**：预留了集成接口

**潜在问题**：
- ⚠️ **需要显式调用**：AI 必须主动调用 memory_search
- ⚠️ **可能重复工作**：上下文选择和知识检索可能有重叠
- ⚠️ **用户体验**：需要配置才能获得最佳效果

**总结**：作者选择了**"宁缺毋滥"**的分阶段策略——先保证每个子系统独立工作良好，再考虑深度融合。这比一开始就做复杂集成要安全得多。

---

*文档版本：v1.0*
*最后更新：2025-03-10*
*分析者：Leon*
