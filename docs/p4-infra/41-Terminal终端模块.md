# Terminal 终端模块 (Terminal Module)

> "OpenClaw 的终端模块提供了命令行界面的渲染和交互能力，包括表格渲染、ANSI 处理、进度显示、链接格式化、终端恢复等。卧槽，这个模块太完善了——`renderTable` 支持动态列宽、自动换行、flex 布局和 Unicode 边框；ANSI 处理能正确识别 SGR 和 OSC-8 序列，确保文本换行不破坏样式；`restoreTerminalState` 更是考虑了 raw mode、stdin 暂停、进度条清理等各种边界情况。特别是智能文本换行算法，能识别 URL、路径等敏感 token，避免破坏可复制性。"

---

## 核心技术洞察

### 1. 表格渲染引擎

```typescript
// src/terminal/table.ts
export type TableColumn = {
  key: string;
  header: string;
  align?: "left" | "right" | "center";
  minWidth?: number;
  maxWidth?: number;
  flex?: boolean;  // 允许自动伸缩
};

export type RenderTableOptions = {
  columns: TableColumn[];
  rows: Array<Record<string, string>>;
  width?: number;
  padding?: number;
  border?: "unicode" | "ascii" | "none";
};

export function renderTable(opts: RenderTableOptions): string {
  const rows = opts.rows.map((row) => {
    const next: Record<string, string> = {};
    for (const [key, value] of Object.entries(row)) {
      next[key] = displayString(value);
    }
    return next;
  });
  const border = opts.border ?? "unicode";

  // 计算列宽
  const metrics = columns.map((c) => {
    const headerW = visibleWidth(c.header);
    const cellW = Math.max(0, ...rows.map((r) => visibleWidth(r[c.key] ?? "")));
    return { headerW, cellW };
  });

  const widths = columns.map((c, i) => {
    const m = metrics[i];
    const base = Math.max(m?.headerW ?? 0, m?.cellW ?? 0) + padding * 2;
    const capped = c.maxWidth ? Math.min(base, c.maxWidth) : base;
    return Math.max(c.minWidth ?? 3, capped);
  });

  // 处理宽度限制
  if (maxWidth && total > maxWidth) {
    // 优先收缩 flex 列，然后收缩非 flex 列
    const flexOrder = columns
      .map((_c, i) => ({ i, w: widths[i] ?? 0 }))
      .filter(({ i }) => Boolean(columns[i]?.flex))
      .toSorted((a, b) => b.w - a.w)
      .map((x) => x.i);

    // 逐步收缩直到满足宽度限制
    shrink(flexOrder, preferredMinWidths);
    shrink(flexOrder, absoluteMinWidths);
    shrink(nonFlexOrder, preferredMinWidths);
    shrink(nonFlexOrder, absoluteMinWidths);
  }

  // 如果有空间，扩展 flex 列填充可用宽度
  if (maxWidth && extra > 0) {
    for (const i of flexCols) {
      if ((widths[i] ?? 0) < (caps[i] ?? Infinity)) {
        widths[i] = (widths[i] ?? 0) + 1;
        extra -= 1;
      }
    }
  }

  // 渲染表格
  const lines: string[] = [];
  lines.push(hLine(box.tl, box.t, box.tr));
  lines.push(...renderRow({}, true));
  lines.push(hLine(box.ml, box.m, box.mr));
  for (const row of rows) {
    lines.push(...renderRow(row, false));
  }
  lines.push(hLine(box.bl, box.b, box.br));
  return `${lines.join("\n")}\n`;
}
```

**Leon 点评**：表格渲染引擎设计非常精妙：
1. **Flex 布局**：flex 列可以自动伸缩，充分利用终端宽度
2. **智能收缩**：宽度不足时优先收缩 flex 列，避免破坏重要内容
3. **ANSI 感知**：换行时不会破坏 ANSI 转义序列
4. **多行支持**：每个单元格可以包含多行文本
5. **边框选择**：支持 Unicode（┌─│）、ASCII（+-|）和无边框

### 2. ANSI 感知的文本换行

```typescript
// src/terminal/table.ts
function wrapLine(text: string, width: number): string[] {
  // ANSI-aware wrapping: never split inside ANSI SGR/OSC-8 sequences.
  const ESC = "\u001b";

  type Token = { kind: "ansi" | "char"; value: string };
  const tokens: Token[] = [];

  // 词法分析：区分 ANSI 序列和普通字符
  for (let i = 0; i < text.length; ) {
    if (text[i] === ESC) {
      // SGR: ESC [ ... m
      if (text[i + 1] === "[") {
        let j = i + 2;
        while (j < text.length && text[j] !== "m") {
          j += 1;
        }
        if (text[j] === "m") {
          tokens.push({ kind: "ansi", value: text.slice(i, j + 1) });
          i = j + 1;
          continue;
        }
      }
      // OSC-8 link: ESC ] 8 ; ; ... ST
      if (text[i + 1] === "]" && text.slice(i + 2, i + 5) === "8;;") {
        const st = text.indexOf(`${ESC}\\`, i + 5);
        if (st >= 0) {
          tokens.push({ kind: "ansi", value: text.slice(i, st + 2) });
          i = st + 2;
          continue;
        }
      }
    }
    // 普通字符
    const cp = text.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    tokens.push({ kind: "char", value: ch });
    i += ch.length;
  }

  // 提取前缀和后缀 ANSI（保持跨行样式）
  const prefixAnsi = tokens
    .slice(0, firstCharIndex)
    .filter((t) => t.kind === "ansi")
    .map((t) => t.value)
    .join("");
  const suffixAnsi = tokens
    .slice(lastCharIndex + 1)
    .filter((t) => t.kind === "ansi")
    .map((t) => t.value)
    .join("");

  // 按宽度换行，保留断点字符
  for (const token of coreTokens) {
    if (token.kind === "ansi") {
      buf.push(token);
      continue;
    }
    if (bufVisible + 1 > width && bufVisible > 0) {
      flushAt(lastBreakIndex);  // 在断点处换行
    }
    buf.push(token);
    bufVisible += 1;
    if (isBreakChar(ch)) {
      lastBreakIndex = buf.length;
    }
  }

  // 每行添加前缀和后缀 ANSI
  return lines.map((line) => `${prefixAnsi}${line}${suffixAnsi}`);
}
```

**Leon 点评**：ANSI 感知的换行算法非常健壮：
1. **词法分析**：正确区分 ANSI 序列和普通字符
2. **序列保护**：永远不会在 ANSI 序列中间断开
3. **样式保持**：自动提取前缀和后缀 ANSI，保持跨行样式
4. **智能断点**：优先在空格、标点符号处断开
5. **OSC-8 支持**：正确处理超链接的 OSC-8 序列

### 3. 终端状态恢复

```typescript
// src/terminal/restore.ts
const RESET_SEQUENCE = "\x1b[0m\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l";

export function restoreTerminalState(
  reason?: string,
  options: RestoreTerminalStateOptions = {},
): void {
  const resumeStdin = options.resumeStdinIfPaused ?? options.resumeStdin ?? false;

  // 1. 清理进度条
  try {
    clearActiveProgressLine();
  } catch (err) {
    reportRestoreFailure("progress line", err, reason);
  }

  // 2. 退出 raw mode
  const stdin = process.stdin;
  if (stdin.isTTY && typeof stdin.setRawMode === "function") {
    try {
      stdin.setRawMode(false);
    } catch (err) {
      reportRestoreFailure("raw mode", err, reason);
    }
    // 3. 恢复 stdin（可选）
    if (resumeStdin && typeof stdin.isPaused === "function" && stdin.isPaused()) {
      try {
        stdin.resume();
      } catch (err) {
        reportRestoreFailure("stdin resume", err, reason);
      }
    }
  }

  // 4. 重置终端状态
  if (process.stdout.isTTY) {
    try {
      process.stdout.write(RESET_SEQUENCE);
    } catch (err) {
      reportRestoreFailure("stdout reset", err, reason);
    }
  }
}
```

**Leon 点评**：终端状态恢复考虑得非常周全：
1. **进度条清理**：使用 `\r\x1b[2K` 清除当前行
2. **Raw Mode 退出**：正确退出终端的原始模式
3. **Stdin 控制**：可选地恢复 stdin（Docker 环境需谨慎）
4. **完整重置**：重置 SGR、光标、鼠标等所有终端状态
5. **错误报告**：每个步骤都有独立的错误处理

### 4. 进度行管理

```typescript
// src/terminal/progress-line.ts
let activeStream: NodeJS.WriteStream | null = null;

export function registerActiveProgressLine(stream: NodeJS.WriteStream): void {
  if (!stream.isTTY) {
    return;
  }
  activeStream = stream;
}

export function clearActiveProgressLine(): void {
  if (!activeStream?.isTTY) {
    return;
  }
  activeStream.write("\r\x1b[2K");  // 回车 + 清除行
}

export function unregisterActiveProgressLine(stream?: NodeJS.WriteStream): void {
  if (!activeStream) {
    return;
  }
  if (stream && activeStream !== stream) {
    return;
  }
  activeStream = null;
}
```

**Leon 点评**：进度行管理简洁有效：
1. **TTY 检测**：只在 TTY 环境启用
2. **单例模式**：全局只有一个活跃进度条
3. **清除序列**：使用标准的 `\r\x1b[2K` 清除行
4. **流验证**：unregister 时验证流匹配

### 5. 智能文本换行

```typescript
// src/terminal/note.ts
function isCopySensitiveToken(word: string): boolean {
  if (!word) {
    return false;
  }
  // URL 前缀
  if (URL_PREFIX_RE.test(word)) {
    return true;
  }
  // 路径前缀
  if (word.startsWith("/") || word.startsWith("~/") ||
      word.startsWith("./") || word.startsWith("../")) {
    return true;
  }
  // Windows 路径
  if (WINDOWS_DRIVE_RE.test(word) || word.startsWith("\\\\")) {
    return true;
  }
  // 包含路径分隔符
  if (word.includes("/") || word.includes("\\")) {
    return true;
  }
  // 文件名（含下划线）
  return word.includes("_") && FILE_LIKE_RE.test(word);
}

function wrapLine(line: string, maxWidth: number): string[] {
  const match = line.match(/^(\s*)([-*\u2022]\s+)?(.*)$/);
  const indent = match?.[1] ?? "";
  const bullet = match?.[2] ?? "";
  const content = match?.[3] ?? "";

  const firstPrefix = `${indent}${bullet}`;
  const nextPrefix = `${indent}${bullet ? " ".repeat(bullet.length) : ""}`;

  const words = content.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  let prefix = firstPrefix;
  let available = firstWidth;

  for (const word of words) {
    if (!current) {
      if (visibleWidth(word) > available) {
        if (isCopySensitiveToken(word)) {
          // 不拆分敏感 token
          current = word;
          continue;
        }
        // 拆分长单词
        const parts = splitLongWord(word, available);
        const first = parts.shift() ?? "";
        lines.push(prefix + first);
        for (const part of parts) {
          lines.push(prefix + part);
        }
        continue;
      }
      current = word;
      continue;
    }

    const candidate = `${current} ${word}`;
    if (visibleWidth(candidate) <= available) {
      current = candidate;
      continue;
    }

    // 当前行满了，换行
    lines.push(prefix + current);
    prefix = nextPrefix;
    available = nextWidth;
    current = word;
  }

  if (current || words.length === 0) {
    lines.push(prefix + current);
  }

  return lines;
}
```

**Leon 点评**：智能文本换行非常贴心：
1. **敏感 token 保护**：URL、路径、文件名不被拆分
2. **列表缩进**：正确处理项目符号和缩进
3. **长单词处理**：必要时强制拆分超长单词
4. **宽度计算**：使用 `visibleWidth` 而非字符串长度
5. **保留格式**：换行后保留原始缩进和项目符号

### 6. 主题和调色板

```typescript
// src/terminal/palette.ts
export const LOBSTER_PALETTE = {
  accent: "#FF5A2D",        // 主强调色
  accentBright: "#FF7A3D",  // 亮强调色
  accentDim: "#D14A22",     // 暗强调色
  info: "#FF8A5B",          // 信息色
  success: "#2FBF71",       // 成功色
  warn: "#FFB020",          // 警告色
  error: "#E23D2D",         // 错误色
  muted: "#8B7F77",         // 静音色
} as const;

// src/terminal/theme.ts
const hasForceColor =
  typeof process.env.FORCE_COLOR === "string" &&
  process.env.FORCE_COLOR.trim().length > 0 &&
  process.env.FORCE_COLOR.trim() !== "0";

const baseChalk = process.env.NO_COLOR && !hasForceColor
  ? new Chalk({ level: 0 })
  : chalk;

export const theme = {
  accent: hex(LOBSTER_PALETTE.accent),
  accentBright: hex(LOBSTER_PALETTE.accentBright),
  accentDim: hex(LOBSTER_PALETTE.accentDim),
  info: hex(LOBSTER_PALETTE.info),
  success: hex(LOBSTER_PALETTE.success),
  warn: hex(LOBSTER_PALETTE.warn),
  error: hex(LOBSTER_PALETTE.error),
  muted: hex(LOBSTER_PALETTE.muted),
  heading: baseChalk.bold.hex(LOBSTER_PALETTE.accent),
  command: hex(LOBSTER_PALETTE.accentBright),
  option: hex(LOBSTER_PALETTE.warn),
} as const;

export const isRich = () => Boolean(baseChalk.level > 0);

export const colorize = (rich: boolean, color: (value: string) => string, value: string) =>
  rich ? color(value) : value;
```

**Leon 点评**：主题系统设计规范：
1. **Lobster 调色板**：统一的颜色规范，与文档保持同步
2. **NO_COLOR 支持**：遵守 NO_COLOR 环境变量标准
3. **FORCE_COLOR 支持**：允许强制启用颜色
4. **丰富度检测**：`isRich()` 检测终端颜色支持
5. **条件着色**：`colorize()` 根据 rich 标志选择是否着色

### 7. 安全文本处理

```typescript
// src/terminal/ansi.ts
const ANSI_SGR_PATTERN = "\\x1b\\[[0-9;]*m";
const OSC8_PATTERN = "\\x1b\\]8;;.*?\\x1b\\\\|\\x1b\\]8;;\\x1b\\\\";

export function stripAnsi(input: string): string {
  return input.replace(OSC8_REGEX, "").replace(ANSI_REGEX, "");
}

export function sanitizeForLog(v: string): string {
  let out = stripAnsi(v);
  // 移除 C0 控制字符（U+0000–U+001F）和 DEL（U+007F）
  for (let c = 0; c <= 0x1f; c++) {
    out = out.replaceAll(String.fromCharCode(c), "");
  }
  return out.replaceAll(String.fromCharCode(0x7f), "");
}

// src/terminal/safe-text.ts
export function sanitizeTerminalText(input: string): string {
  const normalized = stripAnsi(input)
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
  let sanitized = "";
  for (const char of normalized) {
    const code = char.charCodeAt(0);
    const isControl = (code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f);
    if (!isControl) {
      sanitized += char;
    }
  }
  return sanitized;
}
```

**Leon 点评**：安全文本处理非常严格：
1. **日志净化**：`sanitizeForLog` 防止日志伪造（CWE-117）
2. **终端净化**：`sanitizeTerminalText` 转义控制字符
3. **ANSI 移除**：正确识别 SGR 和 OSC-8 序列
4. **控制字符过滤**：移除所有 C0 和 C1 控制字符
5. **转义显示**：换行符、制表符转义为可读形式

---

## 一、终端模块架构总览

### 核心组件

```
Terminal Module
├── Table Rendering（表格渲染）
│   ├── Column Layout
│   ├── Width Calculation
│   ├── Flex Shrink/Expand
│   └── ANSI-Aware Wrapping
├── ANSI Processing（ANSI 处理）
│   ├── SGR Sequences
│   ├── OSC-8 Links
│   ├── Stripping
│   └── Visible Width
├── Progress（进度显示）
│   ├── Line Registration
│   ├── Clear Sequence
│   └── Stream Management
├── Restore（状态恢复）
│   ├── Raw Mode Exit
│   ├── Stdin Resume
│   └── Terminal Reset
├── Theme（主题）
│   ├── Lobster Palette
│   ├── Color Functions
│   └── Rich Detection
├── Safe Text（安全文本）
│   ├── Log Sanitization
│   ├── Terminal Sanitization
│   └── Control Character Filter
└── Links（链接）
    ├── Docs Links
    └── Terminal Hyperlinks
```

---

## 二、表格渲染

### 列配置选项

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `key` | string | - | 行数据的键名 |
| `header` | string | - | 列标题 |
| `align` | Align | "left" | 对齐方式 |
| `minWidth` | number | 3 | 最小宽度 |
| `maxWidth` | number | - | 最大宽度 |
| `flex` | boolean | false | 允许伸缩 |

### 宽度计算

```typescript
// 1. 初始宽度 = max(headerWidth, max(cellWidths)) + padding * 2
const base = Math.max(headerW, cellW) + padding * 2;

// 2. 应用最大宽度限制
const capped = maxWidth ? Math.min(base, maxWidth) : base;

// 3. 应用最小宽度限制
const width = Math.max(minWidth ?? 3, capped);
```

### Flex 收缩顺序

```
Flex 列（从宽到窄）→ Flex 列（到绝对最小）
→ 非 Flex 列（从宽到窄）→ 非 Flex 列（到绝对最小）
```

### 边框样式

| 样式 | 字符 | 示例 |
|------|------|------|
| Unicode | ┌─│┬┼┐└┘┴├┤ | 现代终端 |
| ASCII | +-+ | 兼容终端 |
| None | 无 | 纯文本 |

---

## 三、ANSI 处理

### 支持的序列

| 类型 | 格式 | 用途 |
|------|------|------|
| SGR | `\x1b[...m` | 颜色和样式 |
| OSC-8 | `\x1b]8;;...\x1b\\` | 超链接 |

### SGR 参数

| 参数 | 效果 |
|------|------|
| 0 | 重置所有样式 |
| 1 | 粗体 |
| 2 | 暗淡 |
| 3 | 斜体 |
| 4 | 下划线 |
| 30-37 | 前景色 |
| 38;5;n | 256 色 |
| 38;2;r;g;b | 真彩色 |
| 90-97 | 亮前景色 |
| 39 | 默认前景色 |
| 40-47 | 背景色 |
| 48;5;n | 256 色 |
| 48;2;r;g;b | 真彩色 |
| 100-107 | 亮背景色 |
| 49 | 默认背景色 |

### 可见宽度计算

```typescript
export function visibleWidth(input: string): number {
  return Array.from(stripAnsi(input)).length;
}

// 示例
visibleWidth("\x1b[31mRed\x1b[0m");  // 3
visibleWidth("正常文本");              // 4
visibleWidth("\u001b]8;;https://example.com\x1b\\Link\x1b]8;;\x1b\\");  // 4
```

---

## 四、终端恢复

### 重置序列

```
\x1b[0m      - 重置所有 SGR 样式
\x1b[?25h    - 显示光标
\x1b[?1000l  - 禁用鼠标报告
\x1b[?1002l  - 禁用按钮事件跟踪
\x1b[?1003l  - 禁用所有鼠标事件
\x1b[?1006l  - 禁用 SGR 扩展模式
\x1b[?2004l  - 禁用焦点事件模式
```

### 清除进度条

```
\r      - 回车到行首
\x1b[2K - 清除整行
```

### 使用场景

| 场景 | resumeStdin | 说明 |
|------|-------------|------|
| 正常退出 | false | 进程即将退出，无需恢复 |
| 继续运行 | true | 清理后继续交互 |
| Docker | false | 避免保持容器运行 |

---

## 五、主题和颜色

### Lobster 调色板

```typescript
const LOBSTER_PALETTE = {
  accent: "#FF5A2D",        // 主橙色
  accentBright: "#FF7A3D",  // 亮橙色
  accentDim: "#D14A22",     // 暗橙色
  info: "#FF8A5B",          // 浅橙色
  success: "#2FBF71",       // 绿色
  warn: "#FFB020",          // 黄色
  error: "#E23D2D",         // 红色
  muted: "#8B7F77",         // 灰色
};
```

### 颜色函数

| 函数 | 用途 | 示例 |
|------|------|------|
| `theme.accent()` | 主强调色 | 关键信息 |
| `theme.success()` | 成功状态 | 成功消息 |
| `theme.warn()` | 警告状态 | 警告消息 |
| `theme.error()` | 错误状态 | 错误消息 |
| `theme.heading()` | 标题 | 粗体强调 |
| `theme.command()` | 命令 | 命令行 |
| `theme.option()` | 选项 | 配置项 |

### 环境变量

| 变量 | 值 | 效果 |
|------|-----|------|
| `FORCE_COLOR` | "1"/"0" | 强制启用/禁用颜色 |
| `NO_COLOR` | 任意 | 禁用颜色（优先级低于 FORCE_COLOR） |

---

## 六、安全处理

### 日志净化

```typescript
export function sanitizeForLog(v: string): string {
  // 1. 移除 ANSI 序列
  // 2. 移除 C0 控制字符（U+0000–U+001F）
  // 3. 移除 DEL（U+007F）
  return stripAnsi(v)
    .replaceAll(controlChars, "")
    .replaceAll(DEL, "");
}
```

### 终端净化

```typescript
export function sanitizeTerminalText(input: string): string {
  // 1. 移除 ANSI 序列
  // 2. 转义 \r → \\r, \n → \\n, \t → \\t
  // 3. 移除 C0 和 C1 控制字符
  return stripAnsi(input)
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replaceAll(controlChars, "");
}
```

### 安全场景

| 场景 | 使用函数 | 原因 |
|------|---------|------|
| 日志文件 | `sanitizeForLog` | 防止日志伪造 |
| 终端输出 | `sanitizeTerminalText` | 防止终端注入 |
| 表格渲染 | `stripAnsi` | 宽度计算 |

---

## 七、智能换行

### 断点字符

```typescript
const isBreakChar = (ch: string) =>
  ch === " " || ch === "\t" || ch === "/" ||
  ch === "-" || ch === "_" || ch === ".";
```

### 敏感 Token

| 类型 | 示例 | 保护方式 |
|------|------|---------|
| URL | `https://example.com/path` | 不拆分 |
| Unix 路径 | `/usr/local/bin` | 不拆分 |
| Windows 路径 | `C:\Program Files` | 不拆分 |
| UNC 路径 | `\\server\share` | 不拆分 |
| 文件名 | `administrators_authorized_keys` | 不拆分 |

### 列表缩进

```
缩进 + 项目符号
    ↓
第一行: 缩进 + 符号 + 内容（宽度 - 第一前缀）
后续行: 缩进 + 空格 + 内容（宽度 - 后续前缀）

示例:
  * This is a long item that wraps
    to multiple lines with proper
    indentation.
```

---

*本文档基于源码分析，涵盖终端模块的表格渲染、ANSI 处理、进度显示、终端恢复、主题系统、安全文本处理以及智能换行。*
