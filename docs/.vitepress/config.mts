import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'OpenClaw Deep Dive',
  description: 'OpenClaw 技术深度解析文档',
  base: '/openclaw-deep-dive/',
  themeConfig: {
    nav: [
      { text: '首页', link: '/' },
      { text: '架构', link: '/architecture/overview' },
      { text: 'GitHub', link: 'https://github.com/rainleon/openclaw-deep-dive' }
    ],

    sidebar: [
      {
        text: '介绍',
        items: [
          { text: '什么是 OpenClaw', link: '/intro/what-is' }
        ]
      },
      {
        text: '核心概念',
        items: [
          { text: '架构概览', link: '/architecture/overview' },
          { text: 'Agent 系统', link: '/architecture/agents' },
          { text: '工具系统', link: '/architecture/tools' },
          { text: '模型配置', link: '/architecture/models' }
        ]
      },
      {
        text: '进阶指南',
        items: [
          { text: '自定义 Skills', link: '/advanced/skills' },
          { text: '插件开发', link: '/advanced/plugins' },
          { text: '网关配置', link: '/advanced/gateway' }
        ]
      }
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/rainleon/openclaw-deep-dive' }
    ],

    search: {
      provider: 'local'
    }
  }
})
