# OpenClaw Deep Dive

## 六大部分导航

```mermaid
graph LR
    subgraph P1["P1: 总览篇"]
        A1[架构认知]
        A2[设计哲学]
        A1 --> A2
    end

    subgraph P2["P2: 核心引擎篇"]
        B1[Agent Core]
        B2[Memory]
        B3[Tool System]
        B2 --> B1
        B3 --> B1
    end

    subgraph P3["P3: 交互层篇"]
        C1[Channels]
        C2[Media]
        C3["LINE/iMessage"]
        C1 --> B1
        C2 --> B1
    end

    subgraph P4["P4: 基础设施篇"]
        D1[Gateway]
        D2["Plugin SDK"]
        D3[Commands]
        D1 --> C1
        D2 --> B3
    end

    subgraph P5["P5: 工程实践篇"]
        E1[Security]
        E2[Hooks]
        E3[Config]
        E1 --> D1
        E2 --> B1
        E3 --> D1
    end

    subgraph P6["P6: 高级专题篇"]
        F1[Browser]
        F2["Canvas Host"]
        F3[ACP]
        F1 --> B3
        F2 --> C1
        F3 --> D1
    end

    A1 --> B1
    A2 --> D1
    E1 --> F3

    style B1 fill:#ff6b6b
    style D1 fill:#4ecdc4
    style E1 fill:#ffe66d
```

## 快速开始

本文档基于 OpenClaw 源码分析，所有结论均附带路径引用。

| 部分 | 内容 | 状态 |
|------|------|------|
| P1: 总览篇 | 架构认知、设计哲学 | 📝 规划中 |
| P2: 核心引擎篇 | Agent Core、Memory、Tool System | 📝 规划中 |
| P3: 交互层篇 | Channels、Media、LINE/iMessage | 📝 规划中 |
| P4: 基础设施篇 | Gateway、Plugin SDK、Commands | ✅ 已有 Gateway |
| P5: 工程实践篇 | Security、Hooks、Config | 📝 规划中 |
| P6: 高级专题篇 | Browser、Canvas Host、ACP | 📝 规划中 |

## 贡献指南

欢迎提交 PR 补充完善各章节内容。
