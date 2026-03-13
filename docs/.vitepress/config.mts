import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'OpenClaw Deep Dive',
  description: 'OpenClaw 技术深度解析文档',
  base: '/openclaw-deep-dive/',
  themeConfig: {
    nav: [
      { text: '首页', link: '/' },
      { text: 'GitHub', link: 'https://github.com/rainleon/openclaw-deep-dive' }
    ],
    sidebar: [
      {
        text: '文档',
        items: [
          { text: '前言', link: '/p1-overview/foreword' },
          { text: '架构认知', link: '/p1-overview/architecture' }
        ]
      }
    ]
  }
})
