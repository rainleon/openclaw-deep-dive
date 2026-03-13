# CLI 入口系统 (CLI Entry System)

> "OpenClaw的CLI架构设计得太优雅了。懒加载命令注册——每个命令都是placeholder，只在首次调用时才动态导入真实实现。这种设计让CLI启动快如闪电，而且支持插件动态注册新命令。卧槽，这个progress.ts的 OSC 99 协议支持，比大多数CLI的spinner都要先进。"

---

## 核心技术洞察

### 1. 懒加载命令注册：Placeholder → Action → Reparse

```typescript
// src/cli/program/command-registry.ts
const coreEntries: CoreCliEntry[] = [
  {
    commands: [
      {
        name: "config",
        description: "Non-interactive config helpers (get/set/unset/file/validate)",
        hasSubcommands: true,
      },
    ],
    register: async ({ program }) => {
      const mod = await import("../config-cli.js");  // 懒加载
      mod.registerConfigCli(program);
    },
  },
  // ... 15+ more entries
];

function registerLazyCoreCommand(
  program: Command,
  ctx: ProgramContext,
  entry: CoreCliEntry,
  command: CoreCliCommandDescriptor,
) {
  // 创建 placeholder 命令
  const placeholder = program.command(command.name).description(command.description);
  placeholder.allowUnknownOption(true);   // 允许未知选项
  placeholder.allowExcessArguments(true); // 允许多余参数

  // 设置 action：首次调用时真实注册
  placeholder.action(async (...actionArgs) => {
    removeEntryCommands(program, entry);  // 移除 placeholder
    await entry.register({ program, ctx, argv: process.argv });  // 动态导入并注册
    await reparseProgramFromActionArgs(program, actionArgs);  // 重新解析
  });
}
```

**Leon点评**：这个懒加载设计太聪明了：
1. **启动优化**：所有命令都是轻量级 placeholder，不导入实际代码
2. **按需加载**：只有被调用的命令才会导入其实现模块
3. **透明重新解析**：用户感觉不到中间过程，action 参数被保留并重新解析
4. **支持插件**：插件可以动态注册命令，与核心命令使用相同机制

这种设计让我过了 React 的 lazy import + Suspense，但 OpenClaw 的实现更轻量级，不需要额外的框架支持。

### 2. OSC 99 进度协议：终端原生进度条

```typescript
// src/cli/progress.ts
const canOsc = isTty && supportsOscProgress(process.env, isTty);

const controller = canOsc
  ? createOscProgressController({
      env: process.env,
      isTty: stream.isTTY,
      write: (chunk: string) => stream.write(chunk),
    })
  : null;

const applyState = () => {
  if (!started) {
    return;
  }
  if (controller) {
    if (indeterminate) {
      controller.setIndeterminate(label);  // OSC 99: 无限进度
    } else {
      controller.setPercent(label, percent); // OSC 99: 百分比进度
    }
  }
  if (spin) {
    spin.message(theme.accent(label));  // Fallback: @clack/prompts spinner
  }
  if (renderLine) {
    renderLine();  // Fallback: 简单行更新
  }
  if (renderLog) {
    renderLog();  // Fallback: 日志输出
  }
};
```

**Leon点评**：这个进度显示系统的三层回退设计很专业：
1. **OSC 99**：如果终端支持，使用 OSC 99 协议（终端原生进度条，最流畅）
2. **@clack/prompts**：如果不支持 OSC 99 但是 TTY，使用 spinner（动画效果）
3. **简单行更新**：如果支持 TTY 但用户指定 `fallback: "line"`
4. **日志输出**：如果不是 TTY 但用户指定 `fallback: "log"`（节流 250ms）

OSC 99 是现代终端的扩展协议，支持原生的进度条、面包屑导航等高级功能。OpenClaw 对这个协议的支持让它比大多数 CLI 都更现代化。

### 3. 命令选项继承：防止无限深度遍历

```typescript
// src/cli/command-options.ts
const MAX_INHERIT_DEPTH = 2;

export function inheritOptionFromParent<T = unknown>(
  command: Command | undefined,
  name: string,
): T | undefined {
  if (!command) {
    return undefined;
  }

  // 检查子命令是否显式设置了选项
  const childSource = getOptionSource(command, name);
  if (childSource && childSource !== "default") {
    return undefined;  // 子命令有值，不继承
  }

  // 向上遍历父/祖父命令（最多2层）
  let depth = 0;
  let ancestor = command.parent;
  while (ancestor && depth < MAX_INHERIT_DEPTH) {
    const source = getOptionSource(ancestor, name);
    if (source && source !== "default") {
      return ancestor.opts<Record<string, unknown>>()[name] as T | undefined;
    }
    depth += 1;
    ancestor = ancestor.parent;
  }
  return undefined;
}
```

**Leon点评**：这个选项继承机制设计得很保守：
1. **子命令优先**：如果子命令显式设置了选项，不继承父命令的值
2. **深度限制**：最多遍历 2 层（父命令 + 祖父命令），防止无限递归
3. **来源检测**：使用 `getOptionValueSource()` 区分 "default"、"cli"、"env" 等来源

这种设计避免了命令选项系统的复杂性，同时支持常见的继承场景（如 `--verbose` 从根命令传递到子命令）。

### 4. 依赖注入：运行时懒加载模块

```typescript
// src/cli/deps.ts
export type CliDeps = {
  sendMessageWhatsApp: typeof sendMessageWhatsApp;
  sendMessageTelegram: typeof sendMessageTelegram;
  sendMessageDiscord: typeof sendMessageDiscord;
  sendMessageSlack: typeof sendMessageSlack;
  sendMessageSignal: typeof sendMessageSignal;
  sendMessageIMessage: typeof sendMessageIMessage;
};

// 每个渠道的运行时模块 Promise（单例缓存）
let whatsappSenderRuntimePromise: Promise<typeof import("./deps-send-whatsapp.runtime.js")> | null = null;
// ... 其他渠道

function loadWhatsAppSenderRuntime() {
  whatsappSenderRuntimePromise ??= import("./deps-send-whatsapp.runtime.js");
  return whatsappSenderRuntimePromise;
}

export function createDefaultDeps(): CliDeps {
  return {
    sendMessageWhatsApp: async (...args) => {
      const { sendMessageWhatsApp } = await loadWhatsAppSenderRuntime();
      return await sendMessageWhatsApp(...args);
    },
    // ... 其他渠道
  };
}
```

**Leon点评**：这个依赖注入模式有多个优点：
1. **懒加载**：渠道发送函数只在需要时才导入
2. **单例缓存**：使用 `??=` 确保每个模块只导入一次
3. **类型安全**：`typeof import()` 保留完整的类型信息
4. **测试友好**：可以轻松 mock `CliDeps` 用于测试

这种设计避免了启动时导入所有渠道模块（有些渠道有大量依赖），同时保持了类型安全。

### 5. 程序上下文：缓存的渠道选项解析

```typescript
// src/cli/program/context.ts
export type ProgramContext = {
  programVersion: string;
  channelOptions: string[];
  messageChannelOptions: string;
  agentChannelOptions: string;
};

export function createProgramContext(): ProgramContext {
  let cachedChannelOptions: string[] | undefined;
  const getChannelOptions = (): string[] => {
    if (cachedChannelOptions === undefined) {
      cachedChannelOptions = resolveCliChannelOptions();
    }
    return cachedChannelOptions;
  };

  return {
    programVersion: VERSION,
    get channelOptions() {
      return getChannelOptions();
    },
    get messageChannelOptions() {
      return getChannelOptions().join("|");
    },
    get agentChannelOptions() {
      return ["last", ...getChannelOptions()].join("|");
    },
  };
}
```

**Leon点评**：这个上下文设计有几个巧妙之处：
1. **缓存**：`cachedChannelOptions` 确保只解析一次渠道选项
2. **Getter 动态计算**：使用 getter 而不是直接属性，支持延迟初始化
3. **选项格式化**：`messageChannelOptions` 和 `agentChannelOptions` 是管道分隔的字符串，直接用于 CLI 选项帮助文本
4. **"last" 特殊渠道**：agent 命令支持 `--channel last`，自动选择最近使用的渠道

这种设计避免了重复计算，同时保持了 API 的简洁性。

### 6. 帮助系统：主题化输出 + 示例

```typescript
// src/cli/program/help.ts
export function configureProgramHelp(program: Command, ctx: ProgramContext) {
  program
    .name(CLI_NAME)
    .description("")
    .version(ctx.programVersion)
    .option("--dev", "Dev profile: isolate state under ~/.openclaw-dev...")
    .option("--profile <name>", "Use a named profile...")
    .option("--log-level <level>", "Global log level override...");

  program.configureHelp({
    sortSubcommands: true,
    sortOptions: true,
    optionTerm: (option) => theme.option(option.flags),
    subcommandTerm: (cmd) => {
      const hasSubcommands = ROOT_COMMANDS_WITH_SUBCOMMANDS.has(cmd.name());
      return theme.command(hasSubcommands ? `${cmd.name()} *` : cmd.name());
    },
  });

  program.configureOutput({
    writeOut: (str) => {
      process.stdout.write(formatHelpOutput(str));
    },
    writeErr: (str) => {
      process.stderr.write(formatHelpOutput(str));
    },
    outputError: (str, write) => write(theme.error(str)),
  });

  // 添加示例
  program.addHelpText("afterAll", ({ command }) => {
    if (command !== program) {
      return "";
    }
    const docs = formatDocsLink("/cli", "docs.openclaw.ai/cli");
    return `\n${theme.heading("Examples:")}\n${fmt_examples}\n\n${theme.muted("Docs:")} ${docs}\n`;
  });
}
```

**Leon点评**：帮助系统的设计很用户友好：
1. **主题化输出**：所有输出都通过 `theme` 函数处理，支持颜色和格式
2. **自动排序**：子命令和选项按字母顺序排序，方便查找
3. **子命令标记**：有子命令的命令显示 `*` 后缀，提示用户可以进一步探索
4. **内置示例**：根命令帮助包含常见用法的示例
5. **文档链接**：自动生成官方文档链接

这种设计让 CLI 的帮助文本既专业又易于理解，符合现代 CLI 工具的最佳实践。

---

## 一、CLI 入口系统架构总览

### 系统边界

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         CLI 入口系统边界                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                      程序构建层                                    │  │
│  │  - buildProgram() (program/build-program.ts)                    │  │
│  │  - createProgramContext() (program/context.ts)                  │  │
│  │  - configureProgramHelp() (program/help.ts)                     │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                          ↓                                               │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                      命令注册层                                    │  │
│  │  - registerCoreCliCommands() (command-registry.ts)              │  │
│  │  - 懒加载 placeholder                                            │  │
│  │  - 动态导入真实实现                                               │  │
│  │  - reparseProgramFromActionArgs()                                │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                          ↓                                               │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                      命令选项层                                    │  │
│  │  - inheritOptionFromParent() (command-options.ts)               │  │
│  │  - hasExplicitOptions()                                         │  │
│  │  - MAX_INHERIT_DEPTH = 2                                        │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                          ↓                                               │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                      进度显示层                                    │  │
│  │  - createCliProgress() (progress.ts)                             │  │
│  │  - OSC 99 协议支持                                               │  │
│  │  - @clack/prompts spinner 回退                                   │  │
│  │  - 简单行更新/日志输出回退                                        │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                          ↓                                               │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                      依赖注入层                                    │  │
│  │  - createDefaultDeps() (deps.ts)                                 │  │
│  │  - 运行时懒加载渠道模块                                           │  │
│  │  - CliDeps 类型定义                                              │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                          ↓                                               │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                      工具函数层                                    │  │
│  │  - withManager() (cli-utils.ts)                                  │  │
│  │  - runCommandWithRuntime()                                       │  │
│  │  - resolveOptionFromCommand()                                    │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 核心 CLI 命令清单

| 命令 | 描述 | 子命令 |
|------|------|--------|
| setup | 初始化本地配置和工作区 | 否 |
| onboard | 交互式入门向导 | 否 |
| configure | 交互式配置向导 | 否 |
| config | 非交互式配置帮助 | 是 |
| backup | 创建和验证备份 | 是 |
| doctor | 健康检查 + 快速修复 | 否 |
| dashboard | 打开控制 UI | 否 |
| reset | 重置本地配置/状态 | 否 |
| uninstall | 卸载网关服务 | 否 |
| message | 发送、读取、管理消息 | 是 |
| memory | 搜索和重新索引记忆 | 是 |
| agent | 通过网关运行一次 agent 轮次 | 否 |
| agents | 管理隔离的 agents | 是 |
| status | 显示渠道健康状态 | 否 |
| health | 获取运行中网关的健康信息 | 否 |
| sessions | 列出存储的会话 | 是 |
| browser | 管理专用浏览器 | 是 |

---

## 二、命令注册完整流程

### 懒加载流程图

```
用户执行: openclaw config set foo bar
        ↓
┌─────────────────────────────────────────┐
│ 1. Commander 解析 argv                  │
│    - program: "config"                  │
│    - subcommand: "set"                  │
│    - args: ["foo", "bar"]               │
└─────────────────────────────────────────┘
        ↓
┌─────────────────────────────────────────┐
│ 2. 命中 config placeholder               │
│    - name: "config"                     │
│    - allowUnknownOption: true           │
│    - allowExcessArguments: true         │
└─────────────────────────────────────────┘
        ↓
┌─────────────────────────────────────────┐
│ 3. 触发 placeholder action              │
│    - removeEntryCommands("config")      │
│    - await import("../config-cli.js")   │
│    - registerConfigCli(program)         │
└─────────────────────────────────────────┘
        ↓
┌─────────────────────────────────────────┐
│ 4. 真实 config 命令注册                 │
│    - config set                         │
│    - config get                         │
│    - config unset                       │
│    - config file                        │
│    - config validate                    │
└─────────────────────────────────────────┘
        ↓
┌─────────────────────────────────────────┐
│ 5. 重新解析并执行                        │
│    - reparseProgramFromActionArgs()     │
│    - 执行 config set foo bar            │
└─────────────────────────────────────────┘
```

### 核心命令注册代码

```typescript
// src/cli/program/command-registry.ts
const coreEntries: CoreCliEntry[] = [
  {
    commands: [
      {
        name: "message",
        description: "Send, read, and manage messages",
        hasSubcommands: true,
      },
    ],
    register: async ({ program, ctx }) => {
      const mod = await import("./register.message.js");
      mod.registerMessageCommands(program, ctx);
    },
  },
  // ... 15+ more entries
];

export function registerCoreCliCommands(
  program: Command,
  ctx: ProgramContext,
  argv: string[]
) {
  // 优化：如果用户只请求一个命令，只注册该命令的 placeholder
  const primary = getPrimaryCommand(argv);
  if (primary && shouldRegisterCorePrimaryOnly(argv)) {
    const entry = coreEntries.find((candidate) =>
      candidate.commands.some((cmd) => cmd.name === primary),
    );
    if (entry) {
      const cmd = entry.commands.find((c) => c.name === primary);
      if (cmd) {
        registerLazyCoreCommand(program, ctx, entry, cmd);
      }
      return;
    }
  }

  // 否则注册所有命令的 placeholder
  for (const entry of coreEntries) {
    for (const cmd of entry.commands) {
      registerLazyCoreCommand(program, ctx, entry, cmd);
    }
  }
}
```

---

## 三、进度显示机制

### OSC 99 协议示例

```typescript
// OSC 99 协议转义序列
// \x1b]99;{action};{params}\x07

// 设置百分比进度: \x1b]99;P;30\x07  (30%)
// 设置无限进度: \x1b]99;I;Downloading file\x07
// 清除进度: \x1b]99;C\x07

// 使用 osc-progress 库
import { createOscProgressController } from "osc-progress";

const controller = createOscProgressController({
  env: process.env,
  isTty: stream.isTTY,
  write: (chunk: string) => stream.write(chunk),
});

// 无限进度（用于下载、处理等）
controller.setIndeterminate("Processing files...");

// 百分比进度（用于可量化任务）
controller.setPercent("Copying files", 45);  // 45%

// 清除进度条
controller.clear();
```

### 进度回退策略

```typescript
// src/cli/progress.ts
export function createCliProgress(options: ProgressOptions): ProgressReporter {
  const stream = options.stream ?? process.stderr;
  const isTty = stream.isTTY;

  // 1. 尝试 OSC 99（最先进）
  const canOsc = isTty && supportsOscProgress(process.env, isTty);
  const controller = canOsc ? createOscProgressController({...}) : null;

  // 2. 回退到 @clack/prompts spinner（TTY 但无 OSC 99）
  const allowSpinner = isTty && options.fallback === "spinner";
  const spin = allowSpinner ? spinner() : null;

  // 3. 回退到简单行更新（用户指定）
  const allowLine = isTty && options.fallback === "line";
  const renderLine = allowLine ? () => {
    clearActiveProgressLine();
    stream.write(`${theme.accent(label)} ${percent}%`);
  } : null;

  // 4. 回退到日志输出（非 TTY）
  const allowLog = !isTty && options.fallback === "log";
  const renderLog = allowLog ? () => {
    stream.write(`${label} ${percent}%\n`);
  } : null;

  return { setLabel, setPercent, tick, done };
}
```

### 使用示例

```typescript
// 无限进度（spinner）
await withProgress({
  label: "Loading configuration...",
  indeterminate: true,
}, async (progress) => {
  const config = await loadConfig();
  progress.done();
  return config;
});

// 百分比进度
await withProgress({
  label: "Copying files",
  total: 100,
}, async (progress) => {
  for (let i = 0; i < 100; i++) {
    await copyFile(files[i]);
    progress.tick();  // 进度 +1
  }
});

// 自定义更新
const progress = createCliProgress({ label: "Downloading..." });
// ... 后来
progress.setLabel("Downloading: file.zip");
progress.setPercent(45);
// ... 最后
progress.done();
```

---

## 四、命令选项系统

### 选项继承示例

```typescript
// 命令结构
// openclaw --verbose agent --to +1234567890 --message "Hi"

// 根命令设置 --verbose
program.option("--verbose", "Enable verbose logging");

// agent 命令可以继承 --verbose
agentCommand.action(async (options) => {
  const verbose = inheritOptionFromParent<boolean>(agentCommand, "verbose");
  // verbose 来自根命令的 --verbose
});

// 子命令优先（显式设置不继承）
program.option("--verbose", "Enable verbose logging", false);
agentCommand.option("--verbose", "Agent verbose logging", false);

// 如果用户运行: openclaw agent --verbose
// agent 的 --verbose 优先，不继承根命令的值
```

### 显式选项检测

```typescript
export function hasExplicitOptions(
  command: Command,
  names: readonly string[]
): boolean {
  return names.some((name) =>
    command.getOptionValueSource(name) === "cli"
  );
}

// 示例
program.option("--verbose", "Verbose logging", false);
subcommand.option("--verbose", "Subcommand verbose", false);

// openclaw --verbose subcommand
// subcommand.getOptionValueSource("verbose") === "default"  // 继承

// openclaw subcommand --verbose
// subcommand.getOptionValueSource("verbose") === "cli"  // 显式设置
```

---

## 五、依赖注入模式

### CliDeps 接口

```typescript
// src/cli/deps.ts
export type CliDeps = {
  sendMessageWhatsApp: typeof sendMessageWhatsApp;
  sendMessageTelegram: typeof sendMessageTelegram;
  sendMessageDiscord: typeof sendMessageDiscord;
  sendMessageSlack: typeof sendMessageSlack;
  sendMessageSignal: typeof sendMessageSignal;
  sendMessageIMessage: typeof sendMessageIMessage;
};

export function createDefaultDeps(): CliDeps {
  return {
    sendMessageWhatsApp: async (...args) => {
      const { sendMessageWhatsApp } = await loadWhatsAppSenderRuntime();
      return await sendMessageWhatsApp(...args);
    },
    // ... 其他渠道
  };
}

export function createOutboundSendDeps(deps: CliDeps): OutboundSendDeps {
  return createOutboundSendDepsFromCliSource(deps);
}
```

### 使用示例

```typescript
// 在命令中使用
export async function sendMessageHandler(
  target: string,
  message: string,
  deps: CliDeps = createDefaultDeps(),  // 可注入用于测试
) {
  switch (channel) {
    case "whatsapp":
      await deps.sendMessageWhatsApp(target, message);
      break;
    case "telegram":
      await deps.sendMessageTelegram(target, message);
      break;
    // ...
  }
}

// 测试
const mockDeps: CliDeps = {
  sendMessageWhatsApp: async () => ({ ok: true }),
  sendMessageTelegram: async () => ({ ok: true }),
  // ...
};
await sendMessageHandler("+1234567890", "Test", mockDeps);
```

---

## 六、关键技术权衡

### 1. 懒加载 vs 预加载

| 方案 | 优势 | 劣势 |
|------|------|------|
| 懒加载 | 启动快、内存占用低 | 首次执行有延迟 |
| 预加载 | 首次执行快 | 启动慢、内存占用高 |

**选择**：懒加载
**原因**：CLI 工具大多数时候只执行一个命令，预加载所有命令代码浪费资源

### 2. OSC 99 vs 传统 Spinner

| 方案 | 优势 | 劣势 |
|------|------|------|
| OSC 99 | 终端原生、最流畅 | 需要终端支持 |
| 传统 Spinner | 兼容性好 | 视觉效果较差 |

**选择**：OSC 99 + Spinner 回退
**原因**：在支持的终端上提供最佳体验，同时保持向后兼容

### 3. Placeholder vs 延迟注册

| 方案 | 优势 | 劣势 |
|------|------|------|
| Placeholder | Commander 可见、帮助完整 | 需要重新解析 |
| 延迟注册 | 简单 | Commander 不可见、帮助不完整 |

**选择**：Placeholder
**原因**：用户可以看到所有可用命令，帮助文本完整，虽然实现稍复杂

### 4. 依赖注入 vs 全局导入

| 方案 | 优势 | 劣势 |
|------|------|------|
| 依赖注入 | 可测试、模块化 | 代码稍多 |
| 全局导入 | 简单 | 难以测试、耦合 |

**选择**：依赖注入
**原因**：测试友好，支持运行时模块替换

---

## 七、CLI 系统与其他模块的关系

**Q：CLI 命令如何与 Gateway 通信？**

A：通过 WebSocket RPC（`src/cli/gateway-rpc.ts`）。CLI 命令可以发送 JSON-RPC 请求到运行中的 Gateway，执行远程命令如 `gateway status`、`agent run` 等。

**Q：--dev 选项是如何工作的？**

A：`--dev` 选项修改 `OPENCLAW_STATE_DIR` 环境变量，指向 `~/.openclaw-dev` 而不是 `~/.openclaw`。这会隔离配置、状态、会话等所有数据，方便开发测试。

**Q：placeholder 的 `allowUnknownOption` 和 `allowExcessArguments` 为什么需要？**

A：因为 placeholder 不知道真实命令的选项和参数结构。这两个标志确保 Commander 不会在重新解析前拒绝有效的选项和参数。

**Q：为什么 `MAX_INHERIT_DEPTH = 2`？**

A：这是一个保守的深度限制。大多数 CLI 只需要父子命令继承（1 层），2 层覆盖了更复杂场景（如 `openclaw gateway nodes status`）。无限深度遍历有性能风险且容易引入 bug。

**Q：OSC 99 支持哪些终端？**

A：主要支持现代终端模拟器，如 iTerm2、WezTerm、Kitty、Windows Terminal 等。`osc-progress` 库通过检测环境变量来判断终端支持。

---

## 附录A：核心命令示例

```bash
# 配置管理
openclaw config set agents.defaults.model anthropic/claude-opus-4-6
openclaw config get agents.defaults.model
openclaw config unset agents.defaults.model
openclaw config file  # 打开配置文件
openclaw config validate

# 消息发送
openclaw message send --channel whatsapp --target +1234567890 --message "Hi"
openclaw message read --channel telegram --chat @mychat --limit 10

# Agent 交互
openclaw agent --to +1234567890 --message "Summarize my day"
openclaw agents list
openclaw agents create my-workspace

# 浏览器自动化
openclaw browser start
openclaw browser screenshot https://example.com
openclaw browser close

# 系统管理
openclaw status
openclaw health
openclaw sessions
openclaw doctor
```

---

## 附录B：进度显示完整示例

```typescript
// 基础用法
await withProgress({
  label: "Loading...",
  indeterminate: true,
}, async (progress) => {
  const data = await fetchData();
  return data;
});

// 百分比进度
await withProgress({
  label: "Processing files",
  total: files.length,
}, async (progress) => {
  for (const file of files) {
    await processFile(file);
    progress.tick();
  }
});

// 自定义更新
const progress = createCliProgress({
  label: "Downloading...",
  total: 1000,
  delayMs: 500,  // 延迟 500ms 后显示
});

// 更新标签
progress.setLabel("Downloading: file.zip");

// 更新百分比
progress.setPercent(45);

// 完成后清理
progress.done();

// withProgressTotals 用于动态总数
await withProgressTotals({
  label: "Processing...",
}, async (update, progress) => {
  let completed = 0;
  for (const item of items) {
    await processItem(item);
    completed += 1;
    update({ completed, total: items.length });
  }
});
```

---

*本文档基于源码分析，涵盖命令注册、懒加载、进度显示、依赖注入等核心组件。*
