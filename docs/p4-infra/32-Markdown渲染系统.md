# Markdown 渲染系统 (Markdown Rendering)

> "OpenClaw 的 Markdown 渲染系统设计了一个巧妙的中间表示层（IR），使得同一套 Markdown 可以渲染到不同平台（纯文本、WhatsApp、Telegram）。边界栈算法处理嵌套风格——先打开外层、后打开内层，LIFO 关闭保持正确嵌套。表格渲染支持三种模式（关闭/bullets/code），智能检测第一列作为行标签。WhatsApp 转换使用占位符保护代码块，避免误转换。"

---

## 核心技术洞察

### 1. 中间表示层（IR）

```typescript
// src/markdown/ir.ts
export type MarkdownStyle =
  | "bold"
  | "italic"
  | "strikethrough"
  | "code"
  | "code_block"
  | "spoiler"
  | "blockquote";

export type MarkdownStyleSpan = {
  start: number;
  end: number;
  style: MarkdownStyle;
};

export type MarkdownLinkSpan = {
  start: number;
  end: number;
  href: string;
};

export type MarkdownIR = {
  text: string;
  styles: MarkdownStyleSpan[];
  links: MarkdownLinkSpan[];
};
```

**Leon 点评**：中间表示层是整个渲染系统的核心：
1. **格式无关**：text + spans 表示与渲染目标解耦
2. **可组合**：styles 和 links 可以独立处理
3. **可切片**：支持分块渲染长消息
4. **类型安全**：TypeScript 类型确保正确性

### 2. 边界栈算法

```typescript
// src/markdown/render.ts
export function renderMarkdownWithMarkers(ir: MarkdownIR, options: RenderOptions): string {
  const text = ir.text ?? "";
  if (!text) {
    return "";
  }

  // 按优先级排序样式
  const STYLE_RANK = new Map<MarkdownStyle, number>(
    [
      ["blockquote", 0],
      ["code_block", 1],
      ["code", 2],
      ["bold", 3],
      ["italic", 4],
      ["strikethrough", 5],
      ["spoiler", 6],
    ].map(([style, index]) => [style, index])
  );

  function sortStyleSpans(spans: MarkdownStyleSpan[]): MarkdownStyleSpan[] {
    return [...spans].toSorted((a, b) => {
      if (a.start !== b.start) {
        return a.start - b.start;
      }
      if (a.end !== b.end) {
        return b.end - a.end; // 内层优先
      }
      return (STYLE_RANK.get(a.style) ?? 0) - (STYLE_RANK.get(b.style) ?? 0);
    });
  }

  // 统一的样式和链接栈
  const stack: { close: string; end: number }[] = [];
  const boundaries = new Set<number>();

  for (const span of styled) {
    boundaries.add(span.start);
    boundaries.add(span.end);
    const bucket = startsAt.get(span.start);
    if (bucket) {
      bucket.push(span);
    } else {
      startsAt.set(span.start, [span]);
    }
  }

  // 按结束时间降序排列，确保 LIFO 关闭
  for (const spans of startsAt.values()) {
    spans.sort((a, b) => b.end - a.end);
  }

  // 渲染循环
  for (let i = 0; i < points.length; i += 1) {
    const pos = points[i];

    // 关闭所有在此位置结束的元素
    while (stack.length && stack[stack.length - 1]?.end === pos) {
      const item = stack.pop();
      out += item.close;
    }

    // 打开所有在此位置开始的元素
    for (const span of openingItems) {
      out += item.open;
      stack.push({ close: item.close, end: item.end });
    }

    const next = points[i + 1];
    if (next && next > pos) {
      out += options.escapeText(text.slice(pos, next));
    }
  }

  return out;
}
```

**Leon 点评**：边界栈算法非常优雅：
1. **统一处理**：styles 和 links 用同一个栈
2. **LIFO 语义**：后打开的先关闭，保持嵌套正确
3. **降序排序**：同起点按结束时间降序，确保外层先打开
4. **边界检测**：自动检测所有边界点，避免遗漏

### 3. 表格渲染

```typescript
// src/markdown/ir.ts
function renderTableAsBullets(state: RenderState) {
  if (!state.table) {
    return;
  }
  const headers = state.table.headers.map(trimCell);
  const rows = state.table.rows.map((row) => row.map(trimCell));

  // 检测第一列是否应该用作行标签
  const useFirstColAsLabel = headers.length > 1 && rows.length > 0;

  if (useFirstColAsLabel) {
    // 每行变成一个部分，第一列作为标题，其余列为键值对
    for (const row of rows) {
      if (row.length === 0) {
        continue;
      }

      const rowLabel = row[0];
      if (rowLabel?.text) {
        const labelStart = state.text.length;
        appendCell(state, rowLabel);
        const labelEnd = state.text.length;
        if (labelEnd > labelStart) {
          state.styles.push({ start: labelStart, end: labelEnd, style: "bold" });
        }
        state.text += "\n";
      }

      // 添加每列作为项目符号
      for (let i = 1; i < row.length; i++) {
        appendTableBulletValue(state, {
          header: headers[i],
          value: row[i],
          columnIndex: i,
          includeColumnFallback: true,
        });
      }
      state.text += "\n";
    }
  }
}
```

**Leon 点评**：表格渲染的智能处理：
1. **模式选择**：off/bullets/code 三种模式
2. **智能检测**：自动检测第一列作为行标签
3. **单元格裁剪**：自动去除单元格空白
4. **风格保留**：单元格内的样式和链接正确处理

### 4. WhatsApp 格式转换

```typescript
// src/markdown/whatsapp.ts
export function markdownToWhatsApp(text: string): string {
  if (!text) {
    return text;
  }

  // 1. 提取并保护围栏代码块
  const fences: string[] = [];
  let result = text.replace(/```[\s\S]*?```/g, (match) => {
    fences.push(match);
    return `${FENCE_PLACEHOLDER}${fences.length - 1}`;
  });

  // 2. 提取并保护内联代码
  const inlineCodes: string[] = [];
  result = result.replace(/`[^`\n]+`/g, (match) => {
    inlineCodes.push(match);
    return `${INLINE_CODE_PLACEHOLDER}${inlineCodes.length - 1}`;
  });

  // 3. 转换 **bold** → *bold* 和 __bold__ → *bold*
  result = result.replace(/\*\*(.+?)\*\*/g, "*$1*");
  result = result.replace(/__(.+?)__/g, "*$1*");

  // 4. 转换 ~~strikethrough~~ → ~strikethrough~
  result = result.replace(/~~(.+?)~~/g, "~$1~");

  // 5. 恢复内联代码
  result = result.replace(
    new RegExp(`${escapeRegExp(INLINE_CODE_PLACEHOLDER)}(\\d+)`, "g"),
    (_, idx) => inlineCodes[Number(idx)] ?? "",
  );

  // 6. 恢复围栏代码块
  result = result.replace(
    new RegExp(`${escapeRegExp(FENCE_PLACEHOLDER)}(\\d+)`, "g"),
    (_, idx) => fences[Number(idx)] ?? "",
  );

  return result;
}
```

**Leon 点评**：WhatsApp 转换使用占位符策略：
1. **保护代码**：先提取代码块，避免误转换
2. **格式转换**：标准 Markdown → WhatsApp 格式
3. **顺序恢复**：按相反顺序恢复代码块
4. **避免冲突**：占位符使用空字符避免与内容冲突

### 5. IR 分块

```typescript
// src/markdown/ir.ts
export function chunkMarkdownIR(ir: MarkdownIR, limit: number): MarkdownIR[] {
  if (!ir.text) {
    return [];
  }
  if (limit <= 0 || ir.text.length <= limit) {
    return [ir];
  }

  const chunks = chunkText(ir.text, limit);
  const results: MarkdownIR[] = [];
  let cursor = 0;

  chunks.forEach((chunk, index) => {
    if (!chunk) {
      return;
    }
    // 跳过第二个块及后续块前的空白
    if (index > 0) {
      while (cursor < ir.text.length && /\s/.test(ir.text[cursor] ?? "")) {
        cursor += 1;
      }
    }
    const start = cursor;
    const end = Math.min(ir.text.length, start + chunk.length);

    results.push({
      text: chunk,
      styles: sliceStyleSpans(ir.styles, start, end),
      links: sliceLinkSpans(ir.links, start, end),
    });

    cursor = end;
  });

  return results;
}
```

**Leon 点评**：IR 分块处理长消息：
1. **文本分块**：使用通用文本分块算法
2. **空白跳过**：第二个块及后续块跳过前导空白
3. **切片调整**：styles 和 links 坐标调整为相对位置
4. **边界处理**：正确处理跨块的样式

---

## 一、渲染架构总览

### 核心组件

```
Markdown Rendering
├── IR（中间表示）
│   ├── Text（纯文本）
│   ├── Style Spans（样式区间）
│   └── Link Spans（链接区间）
├── Parser（解析器）
│   ├── markdown-it
│   ├── Token Stream
│   └── Render State
├── Renderer（渲染器）
│   ├── Style Markers
│   ├── Link Builder
│   └── Escape Function
└── Platform Converters（平台转换器）
    ├── WhatsApp
    ├── Telegram
    └── Plain Text
```

### Markdown 样式映射

| 样式 | Markdown | WhatsApp | Telegram | Plain |
|------|----------|-----------|----------|-------|
| Bold | `**text**` | `*text*` | `*text*` | 移除 |
| Italic | `*text*` | `_text_` | `_text_` | 移除 |
| Strikethrough | `~~text~~` | `~text~` | `~~text~~` | 移除 |
| Code | `` `text` `` | ``` `text` ``` | `` `text` `` | 移除 |
| Code Block | ```text``` | ```text``` | ```text``` | 移除 |

---

## 二、类型系统

### Markdown IR

```typescript
export type MarkdownIR = {
  text: string;
  styles: MarkdownStyleSpan[];
  links: MarkdownLinkSpan[];
};
```

### 渲染选项

```typescript
export type RenderOptions = {
  styleMarkers: Partial<Record<MarkdownStyle, {
    open: string;
    close: string;
  }>>;
  escapeText: (text: string) => string;
  buildLink?: (link: MarkdownLinkSpan, text: string) => {
    start: number;
    end: number;
    open: string;
    close: string;
  } | null;
};
```

### 解析选项

```typescript
export type MarkdownParseOptions = {
  linkify?: boolean;           // 自动链接化 URL
  enableSpoilers?: boolean;    // 启用 ||spoiler||
  headingStyle?: "none" | "bold";
  blockquotePrefix?: string;   // 引用前缀
  autolink?: boolean;          // 自动链接化
  tableMode?: "off" | "bullets" | "code";
};
```

---

## 三、表格渲染模式

### 模式对比

| 模式 | 输入 | 输出 | 使用场景 |
|------|------|------|----------|
| off | Markdown 表格 | 保留原样 | 支持原生表格的平台 |
| bullets | Markdown 表格 | 项目符号列表 | 不支持表格的平台 |
| code | Markdown 表格 | 代码块表格 | 需要对齐的平台 |

### Bullets 模式示例

```markdown
| Name | Age | City |
|------|-----|------|
| Alice | 30 | NYC |
| Bob | 25 | LA |
```

转换为：

```
Name
• Age: 30
• City: NYC

Bob
• Age: 25
• City: LA
```

### Code 模式示例

```markdown
| Name | Age | City |
|------|-----|------|
| Alice | 30 | NYC |
```

转换为：

```
```
| Name | Age | City |
|------|-----|------|
| Alice | 30 | NYC |
```
```

---

## 四、平台转换

### WhatsApp 格式

| Markdown | WhatsApp | 说明 |
|----------|----------|------|
| `**bold**` | `*bold*` | 双星号转单星号 |
| `__bold__` | `*bold*` | 下划线转星号 |
| `~~strike~~` | `~strike~` | 双波浪号转单波浪号 |
| `` `code` `` | ``` `code` ``` | 保持不变 |
| ```code block``` | ```code block``` | 保持不变 |

### Telegram 格式

| Markdown | Telegram | 说明 |
|----------|----------|------|
| `**bold**` | `*bold*` | 双星号转单星号 |
| `*italic*` | `_italic_` | 星号转下划线 |
| `~~strike~~` | `~~strike~~` | 保持不变 |
| `` `code` `` | `` `code` `` | 保持不变 |

---

## 五、渲染流程

### 解析阶段

```typescript
export function markdownToIRWithMeta(
  markdown: string,
  options: MarkdownParseOptions = {},
): { ir: MarkdownIR; hasTables: boolean } {
  // 1. 创建 markdown-it 实例
  const md = createMarkdownIt(options);

  // 2. 解析为 token 流
  const tokens = md.parse(markdown ?? "");

  // 3. 可选：注入 spoiler tokens
  if (options.enableSpoilers) {
    applySpoilerTokens(tokens);
  }

  // 4. 渲染为 IR
  const state = initRenderState(options);
  renderTokens(tokens, state);
  closeRemainingStyles(state);

  return {
    ir: {
      text: state.text,
      styles: mergeStyleSpans(state.styles),
      links: state.links,
    },
    hasTables: state.hasTables,
  };
}
```

### 渲染阶段

```typescript
export function renderMarkdownWithMarkers(ir: MarkdownIR, options: RenderOptions): string {
  // 1. 收集所有边界点
  const boundaries = new Set<number>([0, ir.text.length]);
  for (const span of ir.styles) {
    boundaries.add(span.start);
    boundaries.add(span.end);
  }
  for (const link of ir.links) {
    boundaries.add(link.start);
    boundaries.add(link.end);
  }

  // 2. 按起点分组样式
  const startsAt = new Map<number, MarkdownStyleSpan[]>();
  for (const span of ir.styles) {
    const bucket = startsAt.get(span.start) || [];
    bucket.push(span);
    startsAt.set(span.start, bucket);
  }

  // 3. 排序（外层优先）
  for (const bucket of startsAt.values()) {
    bucket.sort((a, b) => b.end - a.end);
  }

  // 4. 渲染循环
  const points = [...boundaries].toSorted((a, b) => a - b);
  const stack: { close: string; end: number }[] = [];
  let out = "";

  for (let i = 0; i < points.length; i += 1) {
    const pos = points[i];

    // 关闭元素
    while (stack.length && stack[stack.length - 1]?.end === pos) {
      out += stack.pop().close;
    }

    // 打开元素
    const openingItems = startsAt.get(pos) || [];
    for (const item of openingItems.sort((a, b) => b.end - a.end)) {
      const marker = styleMarkers[item.style];
      out += marker.open;
      stack.push({ close: marker.close, end: item.end });
    }

    // 输出文本
    const next = points[i + 1];
    if (next && next > pos) {
      out += escapeText(ir.text.slice(pos, next));
    }
  }

  return out;
}
```

---

## 六、技术权衡

### 1. IR vs 直接渲染

| 方案 | 优势 | 劣势 |
|------|------|------|
| IR | 平台无关、可分块 | 额外转换 |
| 直接渲染 | 高性能 | 平台耦合 |

**选择**：IR
**原因**：需要支持多个平台，IR 提供更好的抽象

### 2. 占位符 vs 原地转换

| 方案 | 优势 | 劣势 |
|------|------|------|
| 占位符 | 避免冲突、顺序清晰 | 需要额外内存 |
| 原地转换 | 节省内存 | 可能误转换 |

**选择**：占位符
**原因**：WhatsApp 转换需要避免代码块内容被误转换

### 3. 栈 vs 递归

| 方案 | 优势 | 劣势 |
|------|------|------|
| 栈 | 迭代、无深度限制 | 手动管理 |
| 递归 | 简洁 | 深度限制 |

**选择**：栈
**原因**：避免深度限制，手动控制更容易调试

### 4. 表格模式

| 方案 | 优势 | 劣势 |
|------|------|------|
| 单一模式 | 简单 | 不灵活 |
| 多模式 | 灵活 | 复杂度高 |

**选择**：多模式
**原因**：不同平台对表格的支持不同，需要多种输出

---

*本文档基于源码分析，涵盖 Markdown 渲染系统的架构、中间表示层、边界栈算法、表格渲染、平台转换以及技术权衡。*
