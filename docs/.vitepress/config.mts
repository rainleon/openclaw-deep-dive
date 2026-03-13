import { withMermaid } from "vitepress-plugin-mermaid";

export default withMermaid({
  title: 'OpenClaw Deep Dive',
  description: 'OpenClaw 技术深度解析文档',
  base: '/openclaw-deep-dive/',
  mermaid: {
    theme: 'default'
  },
  themeConfig: {
    nav: [
      { text: '首页', link: '/' },
      { text: '总览', link: '/p1-overview/architecture' },
      { text: '核心引擎', link: '/p2-core/agent' },
      { text: '交互层', link: '/p3-interaction/channels' },
      { text: '基础设施', link: '/p4-infra/gateway' },
      { text: '工程实践', link: '/p5-practice/security' },
      { text: 'GitHub', link: 'https://github.com/rainleon/openclaw-deep-dive' }
    ],

    sidebar: [
      // P1: 总览篇
      {
        text: '📖 P1: 总览篇',
        collapsible: true,
        collapsed: false,
        items: [
          { text: '前言', link: '/p1-overview/foreword' },
          { text: '架构认知', link: '/p1-overview/architecture' },
          { text: '设计哲学', link: '/p1-overview/philosophy' }
        ]
      },

      // P2: 核心引擎篇
      {
        text: '⚙️ P2: 核心引擎篇',
        collapsible: true,
        collapsed: false,
        items: [
          { text: 'Agent Core', link: '/p2-core/agent' },
          { text: '自动回复引擎', link: '/p2-core/auto-reply' },
          { text: 'Context Engine', link: '/p2-core/context-engine' },
          { text: 'Link Understanding', link: '/p2-core/link-understanding' },
          { text: 'Memory System', link: '/p2-core/memory' },
          { text: 'Providers 集成', link: '/p2-core/providers' },
          { text: 'Tool System', link: '/p2-core/tools' },
          { text: 'Tool 分类机制', link: '/p2-core/tools-classification' },
          { text: 'Tool 技术实现', link: '/p2-core/tools-implementation' },
          { text: 'Client-Tool 协作', link: '/p2-core/tools-client' }
        ]
      },

      // P3: 交互层篇
      {
        text: '💬 P3: 交互层篇',
        collapsible: true,
        collapsed: true,
        items: [
          { text: 'Channels 体系', link: '/p3-interaction/channels' },
          { text: '平台特定实现', link: '/p3-interaction/platforms' },
          { text: 'Media 服务', link: '/p3-interaction/media' },
          { text: 'LINE 通道', link: '/p3-interaction/line' },
          { text: 'iMessage 通道', link: '/p3-interaction/imessage' },
          { text: '移动端实现', link: '/p3-interaction/mobile' },
          { text: 'TTS 文字转语音', link: '/p3-interaction/tts' }
        ]
      },

      // P4: 基础设施篇
      {
        text: '🏗️ P4: 基础设施篇',
        collapsible: true,
        collapsed: true,
        items: [
          { text: 'Gateway 架构', link: '/p4-infra/gateway' },
          { text: 'CLI 入口', link: '/p4-infra/cli' },
          { text: 'Commands 系统', link: '/p4-infra/commands' },
          { text: 'Cron 调度引擎', link: '/p4-infra/cron' },
          { text: 'Markdown 渲染', link: '/p4-infra/markdown' },
          { text: 'Node-Host 子系统', link: '/p4-infra/node-host' },
          { text: 'Pairing 配对系统', link: '/p4-infra/pairing' },
          { text: 'Plugin SDK', link: '/p4-infra/plugin-sdk' },
          { text: 'Plugins 运行时', link: '/p4-infra/plugins-runtime' },
          { text: '路由系统', link: '/p4-infra/routing' },
          { text: 'Sessions 会话', link: '/p4-infra/sessions' },
          { text: 'Shared 模块', link: '/p4-infra/shared' },
          { text: 'Terminal 模块', link: '/p4-infra/terminal' },
          { text: 'TUI 界面', link: '/p4-infra/tui' },
          { text: 'Utils 工具', link: '/p4-infra/utils' },
          { text: 'Infra 基础设施', link: '/p4-infra/infra' },
          { text: 'Wizard 向导', link: '/p4-infra/wizard' }
        ]
      },

      // P5: 工程实践篇
      {
        text: '🔧 P5: 工程实践篇',
        collapsible: true,
        collapsed: true,
        items: [
          { text: 'Security 安全', link: '/p5-practice/security' },
          { text: '密钥管理', link: '/p5-practice/keys' },
          { text: 'Hooks 机制', link: '/p5-practice/hooks' },
          { text: 'Config 配置', link: '/p5-practice/config' },
          { text: 'Logging 日志', link: '/p5-practice/logging' },
          { text: 'Daemon 守护进程', link: '/p5-practice/daemon' },
          { text: 'Supervisor 监控', link: '/p5-practice/supervisor' },
          { text: 'Testing 测试', link: '/p5-practice/testing' }
        ]
      },

      // P6: 高级专题篇
      {
        text: '🚀 P6: 高级专题篇',
        collapsible: true,
        collapsed: true,
        items: [
          { text: 'Browser 自动化', link: '/p6-advanced/browser' },
          { text: 'Canvas Host', link: '/p6-advanced/canvas' },
          { text: 'ACP 协议', link: '/p6-advanced/acp' }
        ]
      }
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/rainleon/openclaw-deep-dive' }
    ],

    search: {
      provider: 'local'
    },

    footer: {
      message: 'Based on source code analysis',
      copyright: 'Released under MIT License'
    }
  }
})
