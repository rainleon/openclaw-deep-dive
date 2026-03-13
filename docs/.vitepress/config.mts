import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'OpenClaw Deep Dive',
  description: 'OpenClaw 技术深度解析文档',
  base: '/openclaw-deep-dive/',
  themeConfig: {
    nav: [
      { text: '首页', link: '/' },
      { text: '总览', link: '/p1-overview/architecture' },
      { text: '核心引擎', link: '/p2-core/agent' },
      { text: '基础设施', link: '/p4-infra/gateway' },
      { text: 'GitHub', link: 'https://github.com/rainleon/openclaw-deep-dive' }
    ],

    sidebar: [
      // P1: 总览篇
      {
        text: '📖 P1: 总览篇',
        collapsible: true,
        collapsed: false,
        items: [
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
          { text: 'Memory System', link: '/p2-core/memory' },
          { text: 'Tool System', link: '/p2-core/tools' }
        ]
      },

      // P3: 交互层篇
      {
        text: '💬 P3: 交互层篇',
        collapsible: true,
        collapsed: true,
        items: [
          { text: 'Channels 体系', link: '/p3-interaction/channels' },
          { text: 'Media 服务', link: '/p3-interaction/media' },
          { text: 'LINE/iMessage', link: '/p3-interaction/line-imessage' }
        ]
      },

      // P4: 基础设施篇
      {
        text: '🏗️ P4: 基础设施篇',
        collapsible: true,
        collapsed: false,
        items: [
          { text: 'Gateway 架构', link: '/p4-infra/gateway' },
          { text: 'Plugin SDK', link: '/p4-infra/plugin-sdk' },
          { text: 'Commands 系统', link: '/p4-infra/commands' }
        ]
      },

      // P5: 工程实践篇
      {
        text: '🔧 P5: 工程实践篇',
        collapsible: true,
        collapsed: true,
        items: [
          { text: 'Security 安全', link: '/p5-practice/security' },
          { text: 'Hooks 机制', link: '/p5-practice/hooks' },
          { text: 'Config 配置', link: '/p5-practice/config' }
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
