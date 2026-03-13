# OpenClaw 架构总览（基于源码的事实对齐版）

本文以仓库源码为唯一事实来源，所有断言均附带路径引用（相对仓库根）。避免空泛形容与拟人化描述。

## 1. 定位与边界
- 核心目标：提供可落地的 AI Agent 运行时、消息渠道集成与工具执行体系。
- 运行入口：命令行 CLI 与 Gateway 服务并行存在，分别面向本地交互与长连接服务。
- 本文不覆盖第三方扩展实现细节，聚焦核心仓库。

## 2. 模块总览（目录与职责）
- CLI 与命令
  - 入口与装配：src/entry.ts、src/index.ts
  - 主流程：src/cli/run-main.ts、src/cli/program.ts、src/cli/route.ts
  - 命令实现：src/commands/*
- Agent 与上下文
  - 主循环与工具调用：src/agents/pi-embedded-runner/run.ts
  - 工具目录与适配：src/agents/tool-catalog.ts、src/agents/tools/*
  - 记忆/上下文接入：src/agents/memory-search.ts、src/context-engine/*
- 渠道与路由
  - 路由与会话键：src/routing/resolve-route.ts、src/routing/session-key.ts
  - 渠道注册与公共工具：src/channels/registry.ts
  - 平台实现：src/telegram、src/discord、src/slack、src/signal、src/imessage、src/web
- 网关（Gateway）
  - 启动与方法集：src/gateway/server.impl.ts、src/gateway/server-methods.ts、src/gateway/server-http.ts
  - 运行期集成：src/gateway/server-ws-runtime.ts、src/gateway/server-startup.ts
- 媒体与浏览器
  - 媒体服务：src/media/server.ts、src/media/store.ts、src/media/fetch.ts
  - 浏览器与自动化：src/browser/*
- 配置与日志
  - 配置入口与校验：src/config/config.ts、src/config/io.ts、src/config/validation.ts
  - 日志统一入口：src/logging.ts、src/logging/logger.ts、src/logging/subsystem.ts

以上目录在不同版本可能存在精简/重命名，请以实际仓库为准。

## 3. 典型调用链
- CLI → Agent → 渠道发送
  1) 入口：src/entry.ts → 动态导入 src/cli/run-main.ts
  2) 组装 CLI：src/cli/program.ts 注册命令 → 例如 src/commands/agent.ts
  3) Agent 执行：src/agents/pi-embedded-runner/run.ts（工具在 src/agents/tools/*）
  4) 出站发送：src/infra/outbound/*（实现因版本而异）→ 各渠道 send（如 src/telegram/send.ts）
- Gateway → Handler → Agent
  1) 服务：src/gateway/server.impl.ts 启动 WS/HTTP
  2) 分发：src/gateway/server-methods.ts 聚合各方法
  3) 触发：方法内根据请求调度 Agent 或系统服务

## 4. 关键文件（查阅起点）
- CLI：src/entry.ts、src/cli/run-main.ts、src/cli/program.ts
- Agent：src/agents/pi-embedded-runner/run.ts、src/agents/tool-catalog.ts、src/agents/tools/*
- 路由：src/routing/resolve-route.ts、src/routing/session-key.ts
- 渠道：src/channels/registry.ts、各平台 send/monitor 文件
- 网关：src/gateway/server.impl.ts、src/gateway/server-methods.ts
- 配置：src/config/config.ts、src/config/validation.ts
- 日志：src/logging.ts、src/logging/logger.ts

## 5. 可复现阅读路径
- 从 CLI 入手：阅读 src/entry.ts → src/cli/run-main.ts，了解命令如何注册与解析。
- 追踪一次消息发送：从某个命令触发到 Agent 执行，再到出站发送与渠道落地。
- 对照文档目录阅读：docs/* 下的配置、网关和渠道说明与源码相互印证。

## 6. 写作规范与引用
- 事实优先：每个结论配套“路径引用”；当版本差异导致文件缺失时，标注“版本差异，读者以实际分支为准”。
- 命名一致：产品名“OpenClaw”，命令/包名/配置键“openclaw”。
- 示例最小化：只保留可复现的最小路径与命令，不做臆测性拓展。

（本章将随仓库结构演进持续更新）
