# Shared 共享模块 (Shared Module)

> "OpenClaw 的共享模块提供了跨模块的工具函数和类型定义，包括节点匹配、需求评估、IP 地址处理、进程检测等基础能力。卧槽，这个模块太实用了——`resolveNodeIdFromCandidates` 支持精确匹配和前缀匹配，还能根据连接状态解决歧义；`evaluateRequirements` 实现了灵活的运行时需求检查，支持本地和远程二进制文件；IP 地址处理更是全面，支持 IPv4/IPv6、嵌入地址、特殊用途地址检测等。这些工具函数被整个代码库广泛使用，是系统功能的重要基础。"

---

## 核心技术洞察

### 1. 节点匹配算法

```typescript
// src/shared/node-match.ts
export type NodeMatchCandidate = {
  nodeId: string;
  displayName?: string;
  remoteIp?: string;
  connected?: boolean;
};

export function resolveNodeMatches(
  nodes: NodeMatchCandidate[],
  query: string,
): NodeMatchCandidate[] {
  const q = query.trim();
  if (!q) {
    return [];
  }

  const qNorm = normalizeNodeKey(q);
  return nodes.filter((n) => {
    // 1. 精确匹配 nodeId
    if (n.nodeId === q) {
      return true;
    }
    // 2. 精确匹配 remoteIp
    if (typeof n.remoteIp === "string" && n.remoteIp === q) {
      return true;
    }
    // 3. 规范化 displayName 匹配
    const name = typeof n.displayName === "string" ? n.displayName : "";
    if (name && normalizeNodeKey(name) === qNorm) {
      return true;
    }
    // 4. 前缀匹配（至少 6 个字符）
    if (q.length >= 6 && n.nodeId.startsWith(q)) {
      return true;
    }
    return false;
  });
}

export function resolveNodeIdFromCandidates(nodes: NodeMatchCandidate[], query: string): string {
  const q = query.trim();
  if (!q) {
    throw new Error("node required");
  }

  const rawMatches = resolveNodeMatches(nodes, q);
  if (rawMatches.length === 1) {
    return rawMatches[0]?.nodeId ?? "";
  }
  if (rawMatches.length === 0) {
    const known = listKnownNodes(nodes);
    throw new Error(`unknown node: ${q}${known ? ` (known: ${known})` : ""}`);
  }

  // 处理多个匹配：优先选择已连接的节点
  const connectedMatches = rawMatches.filter((match) => match.connected === true);
  const matches = connectedMatches.length > 0 ? connectedMatches : rawMatches;
  if (matches.length === 1) {
    return matches[0]?.nodeId ?? "";
  }

  throw new Error(
    `ambiguous node: ${q} (matches: ${matches
      .map((n) => n.displayName || n.remoteIp || n.nodeId)
      .join(", ")})`,
  );
}

function normalizeNodeKey(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}
```

**Leon 点评**：节点匹配算法设计非常智能：
1. **多策略匹配**：精确匹配 → IP 匹配 → 名称匹配 → 前缀匹配
2. **连接优先**：当有多个匹配时优先选择已连接的节点
3. **前缀保护**：前缀匹配要求至少 6 个字符，避免误匹配
4. **友好错误**：未匹配时列出已知节点，帮助用户选择
5. **歧义提示**：多个匹配时显示所有候选项，而不是随机选择

### 2. 运行时需求评估

```typescript
// src/shared/requirements.ts
export type Requirements = {
  bins: string[];       // 必需的二进制文件
  anyBins: string[];    // 至少需要一个
  env: string[];        // 必需的环境变量
  config: string[];     // 必需的配置路径
  os: string[];         // 支持的操作系统
};

export function evaluateRequirements(
  params: {
    always: boolean;
    required: Requirements;
    hasLocalBin: (bin: string) => boolean;
    hasRemoteBin?: (bin: string) => boolean;
    hasRemoteAnyBin?: (bins: string[]) => boolean;
    localPlatform: string;
    remotePlatforms?: string[];
    isEnvSatisfied: (envName: string) => boolean;
    isConfigSatisfied: (pathStr: string) => boolean;
  },
): { missing: Requirements; eligible: boolean; configChecks: RequirementConfigCheck[] } {
  const missingBins = resolveMissingBins({
    required: params.required.bins,
    hasLocalBin: params.hasLocalBin,
    hasRemoteBin: params.hasRemoteBin,
  });
  const missingAnyBins = resolveMissingAnyBins({
    required: params.required.anyBins,
    hasLocalBin: params.hasLocalBin,
    hasRemoteAnyBin: params.hasRemoteAnyBin,
  });
  const missingOs = resolveMissingOs({
    required: params.required.os,
    localPlatform: params.localPlatform,
    remotePlatforms: params.remotePlatforms,
  });
  const missingEnv = resolveMissingEnv({
    required: params.required.env,
    isSatisfied: params.isEnvSatisfied,
  });
  const configChecks = buildConfigChecks({
    required: params.required.config,
    isSatisfied: params.isConfigSatisfied,
  });
  const missingConfig = configChecks.filter((check) => !check.satisfied).map((check) => check.path);

  const missing = params.always
    ? { bins: [], anyBins: [], env: [], config: [], os: [] }
    : {
        bins: missingBins,
        anyBins: missingAnyBins,
        env: missingEnv,
        config: missingConfig,
        os: missingOs,
      };

  const eligible =
    params.always ||
    (missing.bins.length === 0 &&
      missing.anyBins.length === 0 &&
      missing.env.length === 0 &&
      missing.config.length === 0 &&
      missing.os.length === 0);

  return { missing, eligible, configChecks };
}
```

**Leon 点评**：需求评估系统非常灵活：
1. **Always 标志**：`always=true` 时跳过所有检查，用于强制启用
2. **远程支持**：支持检查本地和远程二进制文件，适应分布式部署
3. **Any 语义**：`anyBins` 只要有一个满足即可，支持替代方案
4. **详细反馈**：返回缺失项列表和配置检查结果，便于诊断
5. **操作系统**：支持多平台检查，包括远程平台

### 3. IP 地址解析

```typescript
// src/shared/net/ip.ts
export function parseCanonicalIpAddress(raw: string | undefined): ParsedIpAddress | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = stripIpv6Brackets(trimmed);
  if (!normalized) {
    return undefined;
  }
  // 1. 尝试解析为标准 IPv4
  if (ipaddr.IPv4.isValid(normalized)) {
    if (!ipaddr.IPv4.isValidFourPartDecimal(normalized)) {
      return undefined;
    }
    return ipaddr.IPv4.parse(normalized);
  }
  // 2. 尝试解析为标准 IPv6
  if (ipaddr.IPv6.isValid(normalized)) {
    return ipaddr.IPv6.parse(normalized);
  }
  // 3. 尝试解析为嵌入 IPv4 的 IPv6
  return parseIpv6WithEmbeddedIpv4(normalized);
}

function parseIpv6WithEmbeddedIpv4(raw: string): ipaddr.IPv6 | undefined {
  if (!raw.includes(":") || !raw.includes(".")) {
    return undefined;
  }
  const match = /^(.*:)([^:%]+(?:\.[^:%]+){3})(%[0-9A-Za-z]+)?$/i.exec(raw);
  if (!match) {
    return undefined;
  }
  const [, prefix, embeddedIpv4, zoneSuffix = ""] = match;
  if (!ipaddr.IPv4.isValidFourPartDecimal(embeddedIpv4)) {
    return undefined;
  }
  const octets = embeddedIpv4.split(".").map((part) => Number.parseInt(part, 10));
  const high = ((octets[0] << 8) | octets[1]).toString(16);
  const low = ((octets[2] << 8) | octets[3]).toString(16);
  const normalizedIpv6 = `${prefix}${high}:${low}${zoneSuffix}`;
  if (!ipaddr.IPv6.isValid(normalizedIpv6)) {
    return undefined;
  }
  return ipaddr.IPv6.parse(normalizedIpv6);
}

export function extractEmbeddedIpv4FromIpv6(address: ipaddr.IPv6): ipaddr.IPv4 | undefined {
  // 1. IPv4-mapped 地址 ::ffff:w.x.y.z
  if (address.isIPv4MappedAddress()) {
    return address.toIPv4Address();
  }
  // 2. RFC 6145 (IPv4-Translated) ::ffff:0:w.x.y.z
  if (address.range() === "rfc6145") {
    return decodeIpv4FromHextets(address.parts[6], address.parts[7]);
  }
  // 3. RFC 6052 (IPv4-Translatable) 64:ff9b::/96
  if (address.range() === "rfc6052") {
    return decodeIpv4FromHextets(address.parts[6], address.parts[7]);
  }
  // 4. 其他嵌入格式
  for (const rule of EMBEDDED_IPV4_SENTINEL_RULES) {
    if (!rule.matches(address.parts)) {
      continue;
    }
    const [high, low] = rule.toHextets(address.parts);
    return decodeIpv4FromHextets(high, low);
  }
  return undefined;
}
```

**Leon 点评**：IP 地址解析非常全面：
1. **格式支持**：标准 IPv4、IPv6、嵌入 IPv4 的 IPv6、带括号的 IPv6
2. **嵌入地址**：支持 5 种 IPv4 嵌入 IPv6 的格式（IPv4-mapped、NAT64、6to4、Teredo、ISATAP）
3. **规范化**：自动将 IPv4-mapped 地址转换为 IPv4
4. **特殊地址**：检测私有地址、回环地址、CGNAT 地址等
5. **CIDR 匹配**：支持 IP 范围匹配

### 4. 进程存活检测

```typescript
// src/shared/pid-alive.ts
export function isPidAlive(pid: number): boolean {
  if (!isValidPid(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);  // 信号 0 用于检测进程存在
  } catch {
    return false;
  }
  // Linux 特殊处理：检测僵尸进程
  if (isZombieProcess(pid)) {
    return false;
  }
  return true;
}

function isZombieProcess(pid: number): boolean {
  if (process.platform !== "linux") {
    return false;
  }
  try {
    const status = fsSync.readFileSync(`/proc/${pid}/status`, "utf8");
    const stateMatch = status.match(/^State:\s+(\S)/m);
    return stateMatch?.[1] === "Z";
  } catch {
    return false;
  }
}

export function getProcessStartTime(pid: number): number | null {
  if (process.platform !== "linux") {
    return null;
  }
  if (!isValidPid(pid)) {
    return null;
  }
  try {
    const stat = fsSync.readFileSync(`/proc/${pid}/stat`, "utf8");
    const commEndIndex = stat.lastIndexOf(")");
    if (commEndIndex < 0) {
      return null;
    }
    // comm 字段可能包含空格，从最后一个 ")" 之后分割
    const afterComm = stat.slice(commEndIndex + 1).trimStart();
    const fields = afterComm.split(/\s+/);
    // 字段 22 (starttime) 在 comm-split 后的索引 19
    const starttime = Number(fields[19]);
    return Number.isInteger(starttime) && starttime >= 0 ? starttime : null;
  } catch {
    return null;
  }
}
```

**Leon 点评**：进程存活检测考虑得很周全：
1. **标准检测**：使用 `kill(0)` 检测进程存在（Unix 标准做法）
2. **僵尸进程**：Linux 上额外检测僵尸进程状态
3. **PID 回收**：`getProcessStartTime` 用于检测 PID 重用
4. **平台兼容**：非 Linux 平台自动降级
5. **错误处理**：所有文件读取都有 try-catch 保护

### 5. 网关绑定 URL 解析

```typescript
// src/shared/gateway-bind-url.ts
export type GatewayBindUrlResult =
  | {
      url: string;
      source: "gateway.bind=custom" | "gateway.bind=tailnet" | "gateway.bind=lan";
    }
  | {
      error: string;
    }
  | null;

export function resolveGatewayBindUrl(params: {
  bind?: string;
  customBindHost?: string;
  scheme: "ws" | "wss";
  port: number;
  pickTailnetHost: () => string | null;
  pickLanHost: () => string | null;
}): GatewayBindUrlResult {
  const bind = params.bind ?? "loopback";
  if (bind === "custom") {
    const host = params.customBindHost?.trim();
    if (host) {
      return { url: `${params.scheme}://${host}:${params.port}`, source: "gateway.bind=custom" };
    }
    return { error: "gateway.bind=custom requires gateway.customBindHost." };
  }

  if (bind === "tailnet") {
    const host = params.pickTailnetHost();
    if (host) {
      return { url: `${params.scheme}://${host}:${params.port}`, source: "gateway.bind=tailnet" };
    }
    return { error: "gateway.bind=tailnet set, but no tailnet IP was found." };
  }

  if (bind === "lan") {
    const host = params.pickLanHost();
    if (host) {
      return { url: `${params.scheme}://${host}:${params.port}`, source: "gateway.bind=lan" };
    }
    return { error: "gateway.bind=lan set, but no private LAN IP was found." };
  }

  return null;  // loopback 默认不返回 URL
}
```

**Leon 点评**：网关绑定 URL 解析简洁清晰：
1. **多种绑定模式**：loopback（默认）、custom、tailnet、lan
2. **错误提示**：每种失败情况都有明确的错误消息
3. **来源追踪**：返回 URL 来源，便于日志和调试
4. **函数式设计**：通过回调函数获取 IP，解耦 IP 选择逻辑
5. **类型安全**：使用联合类型精确描述返回值

### 6. 文本分块

```typescript
// src/shared/text-chunking.ts
export function chunkTextByBreakResolver(
  text: string,
  limit: number,
  resolveBreakIndex: (window: string) => number,
): string[] {
  if (!text) {
    return [];
  }
  if (limit <= 0 || text.length <= limit) {
    return [text];
  }
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);
    const candidateBreak = resolveBreakIndex(window);
    const breakIdx =
      Number.isFinite(candidateBreak) && candidateBreak > 0 && candidateBreak <= limit
        ? candidateBreak
        : limit;
    const rawChunk = remaining.slice(0, breakIdx);
    const chunk = rawChunk.trimEnd();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
    // 检查是否在分隔符上断开，避免重复空格
    const brokeOnSeparator = breakIdx < remaining.length && /\s/.test(remaining[breakIdx]);
    const nextStart = Math.min(remaining.length, breakIdx + (brokeOnSeparator ? 1 : 0));
    remaining = remaining.slice(nextStart).trimStart();
  }
  if (remaining.length) {
    chunks.push(remaining);
  }
  return chunks;
}
```

**Leon 点评**：文本分块算法设计巧妙：
1. **自定义断点**：通过回调函数支持不同的断点策略
2. **边界处理**：正确处理断点超出限制的情况
3. **空白符处理**：避免在断点处重复空格
4. **清理输出**：每个分块都 trimEnd，尾部整体 trimStart
5. **无限保护**：limit <= 0 时返回整个文本作为一块

---

## 一、共享模块架构总览

### 核心组件

```
Shared Module
├── Node Matching（节点匹配）
│   ├── ID 匹配
│   ├── IP 匹配
│   ├── 名称匹配
│   └── 前缀匹配
├── Requirements（需求评估）
│   ├── Binary 检查
│   ├── Env 检查
│   ├── Config 检查
│   └── OS 检查
├── IP Address（IP 地址）
│   ├── IPv4 解析
│   ├── IPv6 解析
│   ├── 嵌入地址
│   └── 特殊地址检测
├── Process（进程）
│   ├── 存活检测
│   ├── 僵尸进程
│   └── 启动时间
├── Network（网络）
│   ├── 绑定 URL
│   ├── CIDR 匹配
│   └── 地址分类
├── Text（文本）
│   ├── 分块
│   ├── 提取
│   └── 连接
└── Types（类型）
    ├── Session
    ├── Usage
    └── Device Auth
```

---

## 二、节点匹配

### 匹配优先级

| 优先级 | 匹配方式 | 示例 |
|--------|---------|------|
| 1 | 精确 nodeId | `"node-abc123"` |
| 2 | 精确 IP | `"192.168.1.100"` |
| 3 | 规范化名称 | `"My Device"` → `"my-device"` |
| 4 | 前缀（≥6 字符） | `"node-abc"` 匹配 `"node-abc123"` |

### 连接优先

```typescript
// 当多个节点匹配时，优先选择已连接的
const connectedMatches = rawMatches.filter((match) => match.connected === true);
const matches = connectedMatches.length > 0 ? connectedMatches : rawMatches;
```

### 名称规范化

```typescript
function normalizeNodeKey(value: string) {
  return value
    .toLowerCase()                    // 转小写
    .replace(/[^a-z0-9]+/g, "-")     // 非字母数字转连字符
    .replace(/^-+/, "")              // 去除前导连字符
    .replace(/-+$/, "");             // 去除尾部连字符
}

// 示例
// "My Device 123" → "my-device-123"
// "  test--node  " → "test-node"
```

---

## 三、需求评估

### 需求类型

| 类型 | 描述 | 检查方式 |
|------|------|---------|
| `bins` | 必需的二进制文件 | 本地或远程都必须存在 |
| `anyBins` | 替代二进制文件 | 本地或远程至少一个存在 |
| `env` | 必需的环境变量 | 必须非空 |
| `config` | 必需的配置 | 必须为 truthy |
| `os` | 支持的操作系统 | 本地或远程必须匹配 |

### 评估流程

```
输入 Requirements
    ↓
检查 always 标志
    ↓
检查 bins（本地 + 远程）
    ↓
检查 anyBins（本地 OR 远程）
    ↓
检查 os（本地 OR 远程）
    ↓
检查 env
    ↓
检查 config
    ↓
返回 missing + eligible
```

### 配置路径检查

```typescript
export type RequirementConfigCheck = {
  path: string;       // 配置路径
  satisfied: boolean; // 是否满足
};

// 示例
const checks: RequirementConfigCheck[] = [
  { path: "gateway.enabled", satisfied: true },
  { path: "gateway.bind", satisfied: false },
];
```

---

## 四、IP 地址处理

### 支持的格式

| 格式 | 示例 | 解析结果 |
|------|------|---------|
| 标准 IPv4 | `192.168.1.1` | IPv4 |
| 标准 IPv6 | `2001:db8::1` | IPv6 |
| IPv6 带 IPv4 | `::ffff:192.168.1.1` | IPv4-mapped IPv6 |
| IPv6 带括号 | `[2001:db8::1]` | IPv6 |
| 嵌入 IPv4 | `2002:c0a8:101::1` | IPv6 (6to4) |

### 嵌入 IPv4 格式

| 格式 | 前缀 | 示例 | 说明 |
|------|------|------|------|
| IPv4-mapped | `::ffff:w.x.y.z` | `::ffff:192.168.1.1` | RFC 4291 |
| NAT64 | `64:ff9b:1::w.x.y.z` | `64:ff9b:1::192.168.1.1` | RFC 6146 |
| 6to4 | `2002:w.x.y.z::` | `2002:c0a8:101::1` | RFC 3056 |
| Teredo | `2001::w.x.y.z` | `2001::192.168.1.1` | RFC 4380 |
| ISATAP | `...:5efe:w.x.y.z` | `fe80::5efe:192.168.1.1` | RFC 5214 |

### 特殊地址检测

| 类型 | IPv4 范围 | IPv6 范围 |
|------|-----------|-----------|
| 回环 | `127.0.0.0/8` | `::1/128` |
| 私有 | `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` | `fc00::/7` |
| 链路本地 | `169.254.0.0/16` | `fe80::/10` |
| CGNAT | `100.64.0.0/10` | - |

---

## 五、文本处理

### 聊天内容提取

```typescript
export function extractTextFromChatContent(
  content: unknown,
  opts?: {
    sanitizeText?: (text: string) => string;
    joinWith?: string;
    normalizeText?: (text: string) => string;
  },
): string | null;

// 支持格式
// 1. 纯文本: "hello"
// 2. 内容块: [{ type: "text", text: "hello" }, { type: "text", text: "world" }]
// 3. 混合: [{ type: "image", ... }, { type: "text", text: "text" }]
```

### 文本分块策略

| 策略 | 断点选择 | 适用场景 |
|------|---------|---------|
| 句子边界 | 最后的句号 | 自然语言 |
| 单词边界 | 最后的空格 | 英文文本 |
| 段落边界 | 最后的换行 | 结构化文本 |
| 硬切 | limit 位置 | 二进制数据 |

---

## 六、会话和设备

### 设备认证

```typescript
export type DeviceAuthEntry = {
  token: string;         // 认证令牌
  role: string;          // 角色名称
  scopes: string[];      // 权限范围
  updatedAtMs: number;   // 更新时间戳
};

export type DeviceAuthStore = {
  version: 1;
  deviceId: string;
  tokens: Record<string, DeviceAuthEntry>;
};
```

### 会话使用统计

```typescript
export type SessionUsageEntry = {
  key: string;
  label?: string;
  sessionId?: string;
  updatedAt?: number;
  agentId?: string;
  channel?: string;
  chatType?: string;
  origin?: {
    label?: string;
    provider?: string;
    surface?: string;
    chatType?: string;
    from?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };
  modelOverride?: string;
  providerOverride?: string;
  modelProvider?: string;
  model?: string;
  usage: SessionCostSummary | null;
  contextWeight?: SessionSystemPromptReport | null;
};
```

### 头像策略

```typescript
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;  // 2MB

const LOCAL_AVATAR_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"
]);

// 检测头像来源
export function isAvatarDataUrl(value: string): boolean;
export function isAvatarHttpUrl(value: string): boolean;
export function isWorkspaceRelativeAvatarPath(value: string): boolean;
export function isWindowsAbsolutePath(value: string): boolean;
```

---

## 七、工具函数

### 二进制文件检测

```typescript
export function hasBinary(bin: string): boolean;

// 特点：
// 1. 使用 PATH 环境变量
// 2. Windows 支持 PATHEXT 扩展
// 3. 缓存结果直到 PATH 变化
// 4. 检查可执行权限
```

### 配置路径解析

```typescript
export function resolveConfigPath(config: unknown, pathStr: string): unknown;

// 示例
const config = { gateway: { bind: "tailnet" } };
resolveConfigPath(config, "gateway.bind");  // "tailnet"
resolveConfigPath(config, "gateway.port");  // undefined
```

### 真值判断

```typescript
export function isTruthy(value: unknown): boolean;

// 规则：
// null/undefined → false
// false → false
// 0 → false
// "" → false
// 其他 → true
```

---

*本文档基于源码分析，涵盖共享模块的节点匹配、需求评估、IP 地址处理、进程检测、文本处理、会话类型以及工具函数。*
