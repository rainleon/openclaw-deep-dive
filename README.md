# OpenClaw Deep Dive

OpenClaw 深入解析文档站点，使用 VitePress + Mermaid 构建并发布到 GitHub Pages。

## 快速开始
- 安装依赖：`npm ci`
- 本地预览：`npm run docs:dev`
- 构建站点：`npm run docs:build`（产物位于 `docs/.vitepress/dist`）
- 预览构建：`npm run docs:preview`

## 目录结构
- `docs/` 文档根目录
  - `.vitepress/config.mts` 站点与导航配置（base 已设为 `/openclaw-deep-dive/`）
  - `index.md` 首页（含 Mermaid 导图）
  - `p1-overview/`、`p2-core/`、`p3-interaction/`、`p4-infra/`、`p5-practice/`、`p6-advanced/` 各分册内容

## 部署
仓库已配置 GitHub Pages 自动部署工作流：
- 工作流文件：[.github/workflows/deploy.yml](.github/workflows/deploy.yml)
- 触发条件：推送到 `main` 分支或手动触发
- 部署目标：`docs/.vitepress/dist` 发布到 GitHub Pages

注意事项：
- 站点 `base` 已设置为仓库名 `/openclaw-deep-dive/`，如仓库名变更请同步更新 `docs/.vitepress/config.mts`。
- 请勿提交构建产物，`.gitignore` 已忽略 `docs/.vitepress/dist`/`cache` 与误提交的静态文件。

## 贡献
欢迎通过 PR 补充完善各章节内容。文档内推荐使用 Mermaid 绘制流程/结构图，示例参见 `docs/index.md`。
