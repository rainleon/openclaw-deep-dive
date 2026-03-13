import{_ as a,o as n,c as i,ag as l}from"./chunks/framework.KJnzX0KA.js";const c=JSON.parse('{"title":"OpenClaw Deep Dive","description":"","frontmatter":{"layout":"page"},"headers":[],"relativePath":"index.md","filePath":"index.md"}'),t={name:"index.md"};function p(e,s,E,h,k,d){return n(),i("div",null,[...s[0]||(s[0]=[l(`<h1 id="openclaw-deep-dive" tabindex="-1">OpenClaw Deep Dive <a class="header-anchor" href="#openclaw-deep-dive" aria-label="Permalink to &quot;OpenClaw Deep Dive&quot;">​</a></h1><h2 id="六大部分导航" tabindex="-1">六大部分导航 <a class="header-anchor" href="#六大部分导航" aria-label="Permalink to &quot;六大部分导航&quot;">​</a></h2><div class="language-mermaid vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">mermaid</span><pre class="shiki shiki-themes github-light github-dark vp-code" tabindex="0"><code><span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">graph LR</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">    subgraph P1[&quot;P1: 总览篇&quot;]</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">        A1[架构认知]</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">        A2[设计哲学]</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">        A1 --&gt; A2</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">    end</span></span>
<span class="line"></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">    subgraph P2[&quot;P2: 核心引擎篇&quot;]</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">        B1[Agent Core]</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">        B2[Memory]</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">        B3[Tool System]</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">        B2 --&gt; B1</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">        B3 --&gt; B1</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">    end</span></span>
<span class="line"></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">    subgraph P3[&quot;P3: 交互层篇&quot;]</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">        C1[Channels]</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">        C2[Media]</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">        C3[LINE/iMessage]</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">        C1 --&gt; B1</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">        C2 --&gt; B1</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">    end</span></span>
<span class="line"></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">    subgraph P4[&quot;P4: 基础设施篇&quot;]</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">        D1[Gateway]</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">        D2[Plugin SDK]</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">        D3[Commands]</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">        D1 --&gt; C1</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">        D2 --&gt; B3</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">    end</span></span>
<span class="line"></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">    subgraph P5[&quot;P5: 工程实践篇&quot;]</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">        E1[Security]</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">        E2[Hooks]</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">        E3[Config]</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">        E1 --&gt; D1</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">        E2 --&gt; B1</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">        E3 --&gt; D1</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">    end</span></span>
<span class="line"></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">    subgraph P6[&quot;P6: 高级专题篇&quot;]</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">        F1[Browser]</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">        F2[Canvas Host]</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">        F3[ACP]</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">        F1 --&gt; B3</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">        F2 --&gt; C1</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">        F3 --&gt; D1</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">    end</span></span>
<span class="line"></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">    A1 --&gt; B1</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">    A2 --&gt; D1</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">    E1 --&gt; F3</span></span>
<span class="line"></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">    style B1 fill:#ff6b6b</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">    style D1 fill:#4ecdc4</span></span>
<span class="line"><span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8;">    style E1 fill:#ffe66d</span></span></code></pre></div><h2 id="快速开始" tabindex="-1">快速开始 <a class="header-anchor" href="#快速开始" aria-label="Permalink to &quot;快速开始&quot;">​</a></h2><p>本文档基于 OpenClaw 源码分析，所有结论均附带路径引用。</p><table tabindex="0"><thead><tr><th>部分</th><th>内容</th><th>状态</th></tr></thead><tbody><tr><td>P1: 总览篇</td><td>架构认知、设计哲学</td><td>📝 规划中</td></tr><tr><td>P2: 核心引擎篇</td><td>Agent Core、Memory、Tool System</td><td>📝 规划中</td></tr><tr><td>P3: 交互层篇</td><td>Channels、Media、LINE/iMessage</td><td>📝 规划中</td></tr><tr><td>P4: 基础设施篇</td><td>Gateway、Plugin SDK、Commands</td><td>✅ 已有 Gateway</td></tr><tr><td>P5: 工程实践篇</td><td>Security、Hooks、Config</td><td>📝 规划中</td></tr><tr><td>P6: 高级专题篇</td><td>Browser、Canvas Host、ACP</td><td>📝 规划中</td></tr></tbody></table><h2 id="贡献指南" tabindex="-1">贡献指南 <a class="header-anchor" href="#贡献指南" aria-label="Permalink to &quot;贡献指南&quot;">​</a></h2><p>欢迎提交 PR 补充完善各章节内容。</p>`,8)])])}const g=a(t,[["render",p]]);export{c as __pageData,g as default};
