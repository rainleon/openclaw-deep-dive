# OpenClaw 架构探索：Tool 分类机制详解

> 基于 `src/agents/tool-catalog.ts` 的一手源码分析

---

## 最核心的技术洞察 (Top 10)

### 1. 双维分类系统：section × profiles = 精确定位
**Leon 的评价**: 这个设计**太他妈的优雅了**。大多数人做工具分类只会想到单维度——要么按功能分，要么按场景分。OpenClaw 直接来个二维矩阵：`sectionId` 回答"这是个什么工具"，`profiles` 回答"适合什么场景"。这就像给工具装上了 GPS 坐标，想找什么都能精准定位。

**源码证据**：
```typescript
type CoreToolDefinition = {
  sectionId: string;    // 功能域：fs, runtime, web...
  profiles: ToolProfileId[];  // 场景：minimal, coding, messaging, full
};
```

```typescript
type CoreToolDefinition = {
  id: string;           // 工具唯一标识
  label: string;        // 显示名称
  description: string;  // 功能描述
  sectionId: string;    // 功能域分类 (11个)
  profiles: ToolProfileId[];  // 适用场景 (4个)
  includeInOpenClawGroup?: boolean;  // 是否包含在 group:openclaw
};
```

**分类矩阵**：

| Section (功能域) | minimal | coding | messaging | full |
|-----------------|:-------:|:------:|:--------:|:----:|
| fs (文件) | - | ✅ | - | ✅ |
| runtime (运行时) | - | ✅ | - | ✅ |
| web (网络) | - | - | - | ✅ |
| memory (记忆) | - | ✅ | - | ✅ |
| sessions (会话) | ✅ | ✅ | ✅ | ✅ |
| ui (界面) | - | - | - | ✅ |
| messaging (消息) | - | - | ✅ | ✅ |
| automation (自动) | - | ✅ | - | ✅ |
| nodes (节点) | - | - | - | ✅ |
| agents (代理) | - | - | - | ✅ |
| media (媒体) | - | ✅ | - | ✅ |

**设计意义**：
- **sectionId** 回答"这个工具是做什么的？"
- **profiles** 回答"这个工具适合什么场景？"
- 两维度交叉让配置既灵活又精确

### 2. 工具组自动生成：一次定义，处处生效
**Leon 的评价**: **卧槽，牛逼**。很多人做工具组会手写硬编码，每次加新工具都要改三四个地方。这个直接用 `sectionId` 自动生成 `group:{section}`，新工具加进去自动归组。这就是"约定优于配置"的教科书级实现——懒人智慧，一劳永逸。

```typescript
function buildCoreToolGroupMap() {
  const sectionToolMap = new Map<string, string[]>();
  for (const tool of CORE_TOOL_DEFINITIONS) {
    const groupId = `group:${tool.sectionId}`;  // 自动生成组名
    const list = sectionToolMap.get(groupId) ?? [];
    list.push(tool.id);
    sectionToolMap.set(groupId, list);
  }
  return {
    "group:openclaw": openclawTools,
    ...Object.fromEntries(sectionToolMap.entries()),
  };
}
```

**生成的工具组**：
```javascript
{
  "group:openclaw": [...],  // 所有 includeInOpenClawGroup = true 的工具
  "group:fs": ["read", "write", "edit", "apply_patch"],
  "group:runtime": ["exec", "process"],
  "group:web": ["web_search", "web_fetch"],
  "group:memory": ["memory_search", "memory_get"],
  "group:sessions": ["sessions_list", "sessions_history", ...],
  "group:ui": ["browser", "canvas"],
  "group:messaging": ["message"],
  "group:automation": ["cron", "gateway"],
  "group:nodes": ["nodes"],
  "group:agents": ["agents_list"],
  "group:media": ["image", "tts"],
}
```

### 3. Profile 渐进式授权：从只读到全权的安全梯子
**Leon 的评价**: 这个安全模型**想得很清楚**。不像有些项目要么全开要么全关，这里有四级梯度：`minimal` 只能看状态，`coding` 能干活，`messaging` 能聊天，`full` 想干啥干啥。最聪明的是——高风险工具（exec、browser）默认全关，得你自己手动开。这不是保守，这是对用户的负责。

### 4. 11 个 Section 的语义化：用户视角，不是技术视角
**Leon 的评价**: 分类名称选得**恰到好处**。你看——"Files"、"Runtime"、"Web"、"Memory"——全是用户会用的词，没有"FilesystemOperations"、"ProcessManagement"这种技术黑话。这说明作者真的站在用户角度思考，不是拿着锤子找钉子。

### 5. 空 Profiles = 高风险工具的逃生舱
**Leon 的评价**: 这个设计**有点意思**。像 `browser`、`web_search` 这些工具的 `profiles` 是空数组——意思是它们不属于任何预设 profile，想用得手动配置。这不是 bug，是 feature。高风险工具默认关闭，逼你三思而行。安全领域就该这么谨慎。

### 6. Section Order 的用户心理学：基础优先，高级殿后
**Leon 的评价**: 这个顺序**不是随便排的**。fs（文件）和 runtime（运行）放最前——这是最基础的能力。sessions（会话）放正中间——这是核心功能。nodes（远程节点）和 agents（子代理）放最后——这是高级功能。这符合用户的学习曲线：先走路，再跑步，最后飞。

### 7. 工具组的透明性：配置即文档
**Leon 的评价**: 不用查文档，**看配置就知道能干啥**。`group:fs`？文件工具呗。`group:runtime`？运行工具呗。这种自解释的命名方式，让配置文件本身就变成了文档。少翻文档，多干活。

### 8. 配置灵活性：section、group、profile 三管齐下
**Leon 的评价**: **这他妈才是灵活**。你可以按 profile 快速上手（`profile: coding`），可以按 group 批量启用（`group:fs`），也可以单个工具精挑细选（`allow: ["read", "web_search"]`）。新手、老鸟、控制狂都能找到适合自己的玩法。

### 9. 插件工具组的优雅扩展
**Leon 的评价**: 核心工具组有 11 个，插件想加？随便加。`group:plugins` 包含所有插件工具，`your-plugin:specific` 包含特定插件的工具。**既统一又独立**，插件生态就是这么搞起来的。

### 10. 风险意识的全面渗透
**Leon 的评价**: 最让我印象深刻的是——**安全意识贯穿始终**。高风险工具（exec、browser、nodes）要么放在高风险 section，要么干脆不进任何 profile。这不是事后补丁，是设计时就考虑了安全。这种"安全第一"的思维模式，值得学习。

---

## 一、Section 分类详解

### 1.1 Files (fs)

**功能定位**: 文件系统读写操作

| 工具 | 功能 | Profiles | 风险等级 |
|------|------|----------|---------|
| `read` | 读取文件内容 | coding | 🟡 中 |
| `write` | 创建或覆盖文件 | coding | 🟠 高 |
| `edit` | 精确编辑文件 | coding | 🟠 高 |
| `apply_patch` | 应用补丁（OpenAI 格式） | coding | 🟠 高 |

**功能预期**：
- **read**: 只读访问，用于查看配置、源代码、日志
- **write**: 创建新文件或完全覆盖，用于初始化项目、生成配置
- **edit**: 精确修改，用于修复 bug、调整配置
- **apply_patch**: 批量修改，用于代码重构、多文件编辑

**使用场景**：
```yaml
# 场景 1：代码审查（只读）
tools:
  profile: minimal  # 不包含 fs 工具

# 场景 2：代码开发
tools:
  profile: coding   # 包含所有 fs 工具

# 场景 3：只读分析
tools:
  allow:
    - "read"        # 只启用读取
```

**安全考量**：
- 所有 fs 工具都在 `coding` profile，默认不启用
- `write`/`edit`/`apply_patch` 具有破坏性，需要明确授权

### 1.2 Runtime (runtime)

**功能定位**: 程序执行和进程管理

| 工具 | 功能 | Profiles | 风险等级 |
|------|------|----------|---------|
| `exec` | 执行 Shell 命令 | coding | 🔴 极高 |
| `process` | 管理后台进程 | coding | 🔴 极高 |

**功能预期**：
- **exec**: 同步执行命令，获取输出，用于脚本执行、系统管理
- **process**: 启动/停止后台进程，用于长期运行的服务

**使用场景**：
```bash
# 场景 1：构建项目
exec: ["npm", "run", "build"]

# 场景 2：运行测试
exec: ["pytest", "-v"]

# 场景 3：启动开发服务器
process: { action: "start", command: ["npm", "run", "dev"] }

# 场景 4：检查服务状态
process: { action: "list" }
```

**安全考量**：
- Runtime 工具具有系统级权限，是最高风险类别
- 配合 exec-approvals 系统实现审批机制
- 支持命令 allowlist 和策略管道

### 1.3 Web (web)

**功能定位**: 网络内容访问和搜索

| 工具 | 功能 | Profiles | 风险等级 |
|------|------|----------|---------|
| `web_search` | 搜索引擎查询 | - | 🟢 低 |
| `web_fetch` | 获取网页内容 | - | 🟢 低 |

**功能预期**：
- **web_search**: 搜索最新信息、技术文档、新闻
- **web_fetch**: 抓取网页内容、API 响应

**使用场景**：
```bash
# 场景 1：查询技术问题
web_search: "TypeScript generic type inference"

# 场景 2：获取 API 文档
web_fetch: "https://docs.anthropic.com/api"

# 场景 3：监控网页变化
web_fetch: "https://example.com/status"
```

**特点**：
- **不包含在任何 profile** 中，需要手动启用
- 默认包含在 `group:openclaw`
- 相对安全，但可能有信息泄露风险

### 1.4 Memory (memory)

**功能定位**: 长期知识存储和检索

| 工具 | 功能 | Profiles | 风险等级 |
|------|------|----------|---------|
| `memory_search` | 语义搜索记忆 | coding | 🟢 低 |
| `memory_get` | 读取记忆文件 | coding | 🟢 低 |

**功能预期**：
- **memory_search**: 基于语义相似度搜索过去的对话和知识
- **memory_get**: 直接读取特定记忆文件

**使用场景**：
```bash
# 场景 1：查找历史讨论
memory_search: { query: "之前我们讨论的 API 认证方案" }

# 场景 2：检索用户偏好
memory_search: { query: "用户喜欢的代码风格" }

# 场景 3：读取项目上下文
memory_get: { path: "project-context.md" }
```

### 1.5 Sessions (sessions)

**功能定位**: 会话和子代理管理

| 工具 | 功能 | Profiles | 风险等级 |
|------|------|----------|---------|
| `session_status` | 当前会话状态 | minimal, coding, messaging | 🟢 低 |
| `sessions_list` | 列出所有会话 | coding, messaging | 🟢 低 |
| `sessions_history` | 会话历史记录 | coding, messaging | 🟢 低 |
| `sessions_send` | 向会话发送消息 | coding, messaging | 🟡 中 |
| `sessions_spawn` | 创建子代理 | coding | 🟠 高 |
| `subagents` | 管理子代理 | coding | 🟠 高 |

**功能预期**：
- **session_status**: 获取当前会话信息（模型、配置、状态）
- **sessions_list**: 列出所有会话，用于会话选择
- **sessions_history**: 查看会话历史，用于上下文理解
- **sessions_send**: 向其他会话发送消息，用于协作
- **sessions_spawn**: 创建专用子代理，用于任务分解
- **subagents**: 管理正在运行的子代理

**使用场景**：
```bash
# 场景 1：多代理协作
sessions_spawn: { agentId: "researcher", task: "调研市场趋势" }
sessions_spawn: { agentId: "writer", task: "撰写报告" }

# 场景 2：会话转发
sessions_send: {
  sessionKey: "telegram:user123",
  message: "您的报告已完成"
}

# 场景 3：上下文查询
sessions_history: { sessionKey: "main", limit: 10 }
```

### 1.6 UI (ui)

**功能定位**: 用户界面控制

| 工具 | 功能 | Profiles | 风险等级 |
|------|------|----------|---------|
| `browser` | 控制 Web 浏览器 | - | 🟠 高 |
| `canvas` | 控制 Canvas 界面 | - | 🟠 高 |

**功能预期**：
- **browser**: 打开/关闭浏览器、导航、截图、执行脚本
- **canvas**: 控制 iOS/Android Canvas 界面

**使用场景**：
```bash
# 场景 1：自动化测试
browser: {
  action: "navigate",
  url: "https://example.com"
}

# 场景 2：截图验证
browser: { action: "screenshot" }

# 场景 3：移动端交互
canvas: {
  action: "present",
  viewController: "ProfileViewController"
}
```

**特点**：
- **高风险类别**，需要手动授权
- 不属于任何预设 profile
- 配合浏览器自动化和 Canvas Host 使用

### 1.7 Messaging (messaging)

**功能定位**: 消息发送

| 工具 | 功能 | Profiles | 风险等级 |
|------|------|----------|---------|
| `message` | 发送消息 | messaging | 🟡 中 |

**功能预期**：
- 向已配置的渠道（Telegram、Discord 等）发送消息

**使用场景**：
```bash
# 场景 1：通知发送
message: {
  channel: "telegram",
  recipient: "user123",
  content: "任务已完成"
}

# 场景 2：警报推送
message: {
  channel: "discord",
  webhook: "...",
  content: "⚠️ 系统异常"
}
```

### 1.8 Automation (automation)

**功能定位**: 自动化和系统控制

| 工具 | 功能 | Profiles | 风险等级 |
|------|------|----------|---------|
| `cron` | 定时任务管理 | coding | 🟠 高 |
| `gateway` | Gateway 控制 | - | 🔴 极高 |

**功能预期**：
- **cron**: 创建/删除/列出定时任务，用于周期性任务
- **gateway**: 重启、配置、更新 Gateway，用于系统管理

**使用场景**：
```bash
# 场景 1：定时备份
cron: {
  action: "add",
  schedule: "0 2 * * *",  # 每天凌晨 2 点
  command: ["backup"]
}

# 场景 2：配置更新
gateway: {
  action: "config.patch",
  config: { tools: { allow: ["new_tool"] } }
}

# 场景 3：系统重启
gateway: { action: "restart" }
```

### 1.9 Nodes (nodes)

**功能定位**: 远程节点和设备管理

| 工具 | 功能 | Profiles | 风险等级 |
|------|------|----------|---------|
| `nodes` | 节点管理、远程命令 | - | 🔴 极高 |

**功能预期**：
- **nodes**: 列出节点、执行远程命令、通知、拍照、录屏等

**使用场景**：
```bash
# 场景 1：远程执行
nodes: {
  action: "run",
  nodeId: "iphone-pro",
  command: "system.run",
  params: { command: ["ls", "-la"] }
}

# 场景 2：设备通知
nodes: {
  action: "notify",
  nodeId: "ipad",
  message: "备份完成"
}

# 场景 3：截图诊断
nodes: {
  action: "camera_snap",
  nodeId: "iphone"
}
```

### 1.10 Agents (agents)

**功能定位**: Agent 管理

| 工具 | 功能 | Profiles | 风险等级 |
|------|------|----------|---------|
| `agents_list` | 列出所有 Agent | - | 🟢 低 |

**功能预期**：
- **agents_list**: 查看可用的 Agent 配置

### 1.11 Media (media)

**功能定位**: 多媒体处理

| 工具 | 功能 | Profiles | 风险等级 |
|------|------|----------|---------|
| `image` | 图像理解 | coding | 🟢 低 |
| `tts` | 文字转语音 | - | 🟢 低 |

**功能预期**：
- **image**: 理解图片内容、OCR、图表分析
- **tts**: 文本转语音输出

**使用场景**：
```bash
# 场景 1：截图分析
image: { path: "screenshot.png", query: "这个错误是什么？" }

# 场景 2：语音播报
tts: { text: "任务已完成", provider: "openai" }
```

---

## 二、Profile 场景详解

### 2.1 Minimal Profile

**授权理念**: 只读、无破坏性

```typescript
minimal: {
  allow: ["session_status"],  // 仅会话状态
}
```

**适用场景**：
- **监控机器人**: 定期检查系统状态
- **信息查询**: 回答"当前使用什么模型？"
- **健康检查**: 验证 Gateway 是否运行

**典型对话**：
```
用户: 当前的会话状态是什么？
AI: [使用 session_status] 您正在使用 claude-opus-4-6 模型...
```

### 2.2 Coding Profile

**授权理念**: 编程助手，完整开发能力

```typescript
coding: {
  allow: [
    // 文件系统 (4)
    "read", "write", "edit", "apply_patch",
    // 运行时 (2)
    "exec", "process",
    // 记忆 (2)
    "memory_search", "memory_get",
    // 会话 (5)
    "sessions_list", "sessions_history", "sessions_send",
    "sessions_spawn", "subagents",
    // 媒体 (1)
    "image",
    // 自动化 (1)
    "cron",
  ],
}
```

**适用场景**：
- **代码开发**: 编写、修改、运行代码
- **项目重构**: 批量修改、代码分析
- **调试测试**: 运行测试、查看日志
- **文档生成**: 读取代码、生成文档

**典型对话**：
```
用户: 帮我重构这个函数
AI: [使用 read] 读取文件
    [使用 edit] 修改函数
    [使用 exec] 运行测试
    [使用 process] 启动开发服务器
```

### 2.3 Messaging Profile

**授权理念**: 消息交互，无文件操作

```typescript
messaging: {
  allow: [
    // 会话 (4)
    "session_status", "sessions_list",
    "sessions_history", "sessions_send",
    // 消息 (1)
    "message",
  ],
}
```

**适用场景**：
- **对话机器人**: 与用户聊天、回答问题
- **消息转发**: 跨渠道消息路由
- **会话管理**: 查看历史、切换会话

**典型对话**：
```
用户: 转发给 Alice
AI: [使用 sessions_list] 查找 Alice 的会话
    [使用 sessions_send] 转发消息
```

### 2.4 Full Profile

**授权理念**: 完全信任，无限制

```typescript
full: {
  allow: [],  // 空数组 = 允许所有工具
}
```

**适用场景**：
- **本地开发**: 完全控制自己的机器
- **自动化脚本**: 需要所有能力的自动化
- **高级用户**: 理解风险并需要全部功能

---

## 三、配置示例

### 3.1 按场景选择 Profile

```yaml
# 场景 1：聊天机器人
tools:
  profile: messaging

# 场景 2：编程助手
tools:
  profile: coding

# 场景 3：完全信任的本地助手
tools:
  profile: full
```

### 3.2 按分类启用工具

```yaml
# 只启用文件和网络工具
tools:
  allow:
    - "group:fs"
    - "group:web"

# 启用所有核心工具（除高风险）
tools:
  allow:
    - "group:openclaw"
```

### 3.3 精细控制单个工具

```yaml
# 启用特定工具
tools:
  allow:
    - "read"        # 只读文件
    - "web_search"  # 网络搜索
    - "memory_search"  # 记忆搜索

# 排除特定工具
tools:
  profile: coding
  deny:
    - "exec"        # 禁用命令执行
    - "process"     # 禁用进程管理
```

### 3.4 多 Agent 配置

```yaml
agents:
  coder:
    model: claude-opus-4-6
    tools:
      profile: coding  # 编程能力

  chat:
    model: claude-sonnet-4-6
    tools:
      profile: messaging  # 对话能力

  admin:
    model: claude-opus-4-6
    tools:
      profile: full  # 完全控制
```

---

## 四、工具组速查表

| 组名 | 包含工具 | 主要用途 | 风险等级 |
|------|---------|----------|---------|
| `group:openclaw` | 所有 includeInOpenClawGroup=true | 通用工具集 | 混合 |
| `group:fs` | read, write, edit, apply_patch | 文件操作 | 🟠 高 |
| `group:runtime` | exec, process | 程序执行 | 🔴 极高 |
| `group:web` | web_search, web_fetch | 网络访问 | 🟢 低 |
| `group:memory` | memory_search, memory_get | 知识记忆 | 🟢 低 |
| `group:sessions` | sessions_*, subagents, session_status | 会话管理 | 🟡 中 |
| `group:ui` | browser, canvas | 界面控制 | 🟠 高 |
| `group:messaging` | message | 消息发送 | 🟡 中 |
| `group:automation` | cron, gateway | 自动化 | 🔴 极高 |
| `group:nodes` | nodes | 远程节点 | 🔴 极高 |
| `group:agents` | agents_list | 代理管理 | 🟢 低 |
| `group:media` | image, tts | 媒体处理 | 🟢 低 |

---

## 五、作者的技术权衡

### 5.1 为什么选择 11 个 Section？

**考量因素**：
1. **用户心智**: 对应用户理解的功能域
2. **工具数量**: 每个组 2-6 个工具，不会过于拥挤
3. **扩展性**: 新工具有明确的归属
4. **权限边界**: 高风险工具集中在特定组

### 5.2 为什么 profiles 是 mutually exclusive？

**设计原因**：
1. **简化配置**: 用户不需要理解复杂的重叠
2. **明确预期**: 每个 profile 有清晰的使用场景
3. **安全默认**: 避免意外启用高风险工具
4. **工具特例**: 少数工具（如 sessions_*）可以跨越多个 profile

### 5.3 为什么 group:openclaw 存在？

**设计考量**：
1. **便捷性**: 一次启用所有常用工具
2. **插件兼容**: 插件工具也通过组暴露
3. **灵活性**: 用户可以选择专业组或通用组
4. **语义清晰**: "openclaw" 代表项目的核心能力

---

## 六、相关源码文件索引

| 文件路径 | 行数 | 核心功能 |
|---------|------|----------|
| `src/agents/tool-catalog.ts` | ~327 | 工具定义、分类、Profile |
| `src/agents/tool-policy.ts` | ~206 | 策略解析、组扩展 |
| `src/agents/tool-policy-shared.ts` | ~50 | 工具名规范化 |
| `src/agents/tool-policy-pipeline.ts` | ~109 | 策略管道 |

---

*本文档持续更新中...*
