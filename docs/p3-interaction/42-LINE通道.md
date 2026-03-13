# LINE 通道 (LINE Channel)

> "OpenClaw 的 LINE 通道实现了完整的 Messaging API 功能，包括 Flex 模板、Rich Menu、模板消息、Webhook 处理和 Bot handlers。Flex 模板系统支持气泡、盒子和组件的嵌套布局，Rich Menu 提供了强大的用户界面导航能力，Webhook 签名验证确保了安全性。卧槽，模板消息的 LINE 限制处理得太精细了——text 字段 240 字符、altText 400 字符，这些细节都考虑到了，避免 API 调用失败。"

---

## 核心技术洞察

### 1. Flex 模板系统

```typescript
// src/line/flex/templates.ts
export type FlexComponent =
  | FlexBox
  | FlexButton
  | FlexImage
  | FlexText
  | FlexSpan
  | FlexSeparator
  | FlexFiller
  | FlexIcon;

export type FlexBox = {
  type: "box";
  layout: "horizontal" | "vertical";
  contents: FlexComponent[];
  flex?: number;
  spacing?: "none" | "xs" | "sm" | "md" | "lg" | "xl" | "xxl";
  margin?: string;
  paddingAll?: string;
  paddingTop?: string;
  paddingRight?: string;
  paddingBottom?: string;
  paddingLeft?: string;
  backgroundColor?: string;
  borderColor?: string;
  borderWidth?: string;
  cornerRadius?: string;
  height?: string;
  width?: string;
  alignItems?: "flex-start" | "center" | "flex-end";
  justifyContent?: "flex-start" | "center" | "flex-end" | "space-between";
  action?: Action;
};
```

**Leon 点评**：Flex 模板系统设计非常灵活：
1. **嵌套布局**：支持水平和垂直布局的任意嵌套
2. **精细控制**：flex、spacing、margin、padding 提供像素级控制
3. **样式丰富**：backgroundColor、borderColor、borderWidth、cornerRadius
4. **交互支持**：每个组件都可以附加 action

### 2. Rich Menu 批量操作

```typescript
// src/line/rich-menu.ts
export const USER_BATCH_SIZE = 500;

export async function bulkLinkRichMenuToUsers(params: {
  lineClient: line.messagingApi.MessagingApiBlobClient;
  richMenuId: string;
  userIds: string[];
  onProgress?: (progress: { processed: number; total: number }) => void;
}): Promise<{ succeeded: string[]; failed: Array<{ userId: string; error: string }> }> {
  const { lineClient, richMenuId, userIds, onProgress } = params;
  const succeeded: string[] = [];
  const failed: Array<{ userId: string; error: string }> = [];

  for (let i = 0; i < userIds.length; i += USER_BATCH_SIZE) {
    const batch = userIds.slice(i, Math.min(i + USER_BATCH_SIZE, userIds.length));
    const results = await Promise.allSettled(
      batch.map((userId) =>
        lineClient.linkRichMenuIdToUser(richMenuId, userId).then(
          () => ({ userId, success: true }),
          (error) => ({ userId, success: false, error: String(error) })
        )
      )
    );

    results.forEach((result, index) => {
      if (result.status === "fulfilled" && result.value.success) {
        succeeded.push(result.value.userId);
      } else {
        failed.push({
          userId: batch[index],
          error: result.status === "rejected" ? result.reason : result.value.error,
        });
      }
    });

    onProgress?.({ processed: i + batch.length, total: userIds.length });
  }

  return { succeeded, failed };
}
```

**Leon 点评**：批量操作设计得非常健壮：
1. **分批处理**：每批 500 个用户，避免 API 限流
2. **错误隔离**：Promise.allSettled 确保单个失败不影响整批
3. **进度回调**：onProgress 提供实时进度反馈
4. **详细结果**：返回成功和失败列表，便于重试

### 3. 模板消息限制处理

```typescript
// src/line/template-messages.ts
export function createConfirmTemplate(
  text: string,
  confirmAction: Action,
  cancelAction: Action,
  altText?: string,
): TemplateMessage {
  const template: ConfirmTemplate = {
    type: "confirm",
    text: text.slice(0, 240), // LINE API 限制
    actions: [confirmAction, cancelAction],
  };
  return {
    type: "template",
    altText: altText?.slice(0, 400) ?? text.slice(0, 400), // LINE API 限制
    template,
  };
}

export function createButtonsTemplate(
  text: string,
  actions: Action[],
  title?: string,
  altText?: string,
): TemplateMessage {
  if (actions.length > 4) {
    throw new Error("Buttons template supports up to 4 actions");
  }

  const template: ButtonsTemplate = {
    type: "buttons",
    text: text.slice(0, 160), // LINE API 限制
    actions: actions.slice(0, 4),
    ...(title && { title: title.slice(0, 40) }), // LINE API 限制
  };

  return {
    type: "template",
    altText: altText?.slice(0, 400) ?? text.slice(0, 400),
    template,
  };
}
```

**Leon 点评**：模板消息的限制处理太精细了：
1. **文本限制**：confirm 240 字符、buttons text 160 字符、title 40 字符
2. **动作限制**：buttons 最多 4 个动作
3. **AltText 限制**：400 字符限制
4. **提前验证**：抛出错误而不是静默截断

### 4. Webhook 签名验证

```typescript
// src/line/webhook-utils.ts
export function verifyLineSignature(params: {
  body: string;
  signature: string;
  channelSecret: string;
}): boolean {
  const { body, signature, channelSecret } = params;

  const hmac = createHmac("sha256", channelSecret);
  hmac.update(body, "utf8");
  const digest = hmac.digest("base64");

  return timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(digest)
  );
}

export function parseLineWebhookBody(params: {
  body: string;
  signature?: string;
  channelSecret: string;
}): WebhookBody {
  const { body, signature, channelSecret } = params;

  if (!signature) {
    throw new Error("Missing LINE webhook signature");
  }

  if (!verifyLineSignature({ body, signature, channelSecret })) {
    throw new Error("Invalid LINE webhook signature");
  }

  return JSON.parse(body);
}
```

**Leon 点评**：Webhook 安全处理非常专业：
1. **HMAC 验证**：使用 SHA-256 HMAC 验证签名
2. **时序安全**：timingSafeEqual 防止时序攻击
3. **显式检查**：缺少签名时抛出明确错误
4. **统一解析**：验证和解析在一个函数中完成

### 5. Bot Handlers 事件处理

```typescript
// src/line/bot-handlers.ts
export async function handleLineMessageEvent(params: {
  event: line.WebhookEvent;
  ctx: MsgContext;
  lineClient: line.messagingApi.MessagingApiClient;
}): Promise<void> {
  const { event, ctx, lineClient } = params;

  if (event.type !== "message" || event.message.type !== "text") {
    return;
  }

  const replyToken = event.replyToken;
  const messageText = event.message.text;

  // 更新上下文
  ctx.LineEvent = event;
  ctx.LineReplyToken = replyToken;
  ctx.Body = messageText;

  // 处理消息...
}

export async function handleLineFollowEvent(params: {
  event: line.WebhookEvent;
  ctx: MsgContext;
  lineClient: line.messagingApi.MessagingApiClient;
}): Promise<void> {
  const { event, ctx } = params;

  if (event.type !== "follow") {
    return;
  }

  // 更新上下文
  ctx.LineEvent = event;
  ctx.LineSource = event.source;

  // 处理关注事件...
}
```

**Leon 点评**：Bot handlers 设计清晰：
1. **类型守卫**：严格检查事件类型
2. **上下文注入**：将 LINE 特定信息注入 MsgContext
3. **单一职责**：每个 handler 处理一种事件类型
4. **易于扩展**：可以添加更多 handler

---

## 一、LINE 通道架构总览

### 核心组件

```
LINE Channel
├── Flex Templates（Flex 模板）
│   ├── Bubble（气泡）
│   ├── Box（盒子）
│   └── Components（组件）
├── Rich Menu（富菜单）
│   ├── Create（创建）
│   ├── Link（关联）
│   └── Batch Operations（批量操作）
├── Template Messages（模板消息）
│   ├── Confirm（确认）
│   ├── Buttons（按钮）
│   └── Carousel（轮播）
├── Webhook（Webhook）
│   ├── Signature Verification（签名验证）
│   ├── Body Parsing（解析）
│   └── Event Handlers（事件处理器）
└── Monitor（监控）
    ├── Status Check（状态检查）
    └── Metrics（指标）
```

### 处理流程

```
Webhook Request
    ↓
Verify Signature
    ↓
Parse Body
    ↓
Route to Handler
    ├── Message Event → handleLineMessageEvent
    ├── Follow Event → handleLineFollowEvent
    ├── Unfollow Event → handleLineUnfollowEvent
    ├── Postback Event → handleLinePostbackEvent
    └── Beacon Event → handleLineBeaconEvent
    ↓
Update Context
    ↓
Process Message
    ↓
Reply via LINE API
```

---

## 二、类型系统

### Flex 组件类型

```typescript
export type FlexComponent =
  | FlexBox
  | FlexButton
  | FlexImage
  | FlexText
  | FlexSpan
  | FlexSeparator
  | FlexFiller
  | FlexIcon;

export type FlexBubble = {
  type: "bubble";
  size?: "nano" | "micro" | "kilo" | "mega" | "giga";
  header?: FlexBox;
  hero?: FlexBox | FlexImage;
  body: FlexBox;
  footer?: FlexBox;
  styles?: FlexBubbleStyles;
};

export type FlexCarousel = {
  type: "carousel";
  contents: FlexBubble[];
};
```

### 模板消息类型

```typescript
export type TemplateMessage =
  | ConfirmTemplateMessage
  | ButtonsTemplateMessage
  | CarouselTemplateMessage;

export type Action =
  | MessageAction
  | PostbackAction
  | URIAction
  | DateTimePickerAction
  | CameraAction
  | CameraRollAction
  | LocationAction;
```

### Webhook 事件类型

```typescript
export type WebhookEvent =
  | MessageEvent
  | FollowEvent
  | UnfollowEvent
  | JoinEvent
  | LeaveEvent
  | MemberJoinEvent
  | MemberLeaveEvent
  | PostbackEvent
  | BeaconEvent
  | AccountLinkEvent
  | DeviceLinkEvent
  | DeviceUnlinkEvent
  | ThingsEvent;
```

---

## 三、Flex 模板

### 布局类型

| 类型 | 描述 | 用途 |
|------|------|------|
| horizontal | 水平布局 | 横向排列组件 |
| vertical | 垂直布局 | 纵向排列组件 |
| baseline | 基线布局 | 文本对齐 |

### 组件类型

| 组件 | 描述 | 限制 |
|------|------|------|
| Box | 容器组件 | 支持嵌套 |
| Button | 按钮组件 | 需要 action |
| Image | 图片组件 | 支持 URL |
| Text | 文本组件 | 支持 FlexSpan |
| Span | 文本片段 | 用于 Text 内部 |
| Separator | 分隔线 | 样式可定制 |
| Filler | 填充器 | flex=1 |

### Flex 示例

```typescript
const flexMessage: FlexMessage = {
  type: "flex",
  altText: "Flex Message",
  contents: {
    type: "bubble",
    body: {
      type: "box",
      layout: "vertical",
      contents: [
        {
          type: "text",
          text: "Hello, LINE!",
        },
        {
          type: "button",
          action: {
            type: "message",
            label: "Tap me",
            text: "Button tapped",
          },
        },
      ],
    },
  },
};
```

---

## 四、Rich Menu

### Rich Menu 结构

```typescript
export type RichMenu = {
  size: RichMenuSize;
  selected: boolean;
  name: string;
  chatBarText: string;
  areas: RichMenuArea[];
};

export type RichMenuSize = {
  width: number; // 2500px 固定
  height: number; // 1686px 或 2500px
};

export type RichMenuArea = {
  bounds: RichMenuBounds;
  action: Action;
};

export type RichMenuBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};
```

### Rich Menu 操作

| 操作 | API | 描述 |
|------|-----|------|
| 创建 | createRichMenu | 上传 Rich Menu 对象 |
| 上传图片 | uploadRichMenuImage | 上传 Rich Menu 图片 |
| 设置默认 | setDefaultRichMenu | 设置默认 Rich Menu |
| 关联用户 | linkRichMenuIdToUser | 为用户设置 Rich Menu |
| 批量关联 | bulkLinkRichMenuToUsers | 批量设置 Rich Menu |
| 取消关联 | unlinkRichMenuIdFromUser | 取消用户 Rich Menu |
| 获取 | getRichMenu | 获取 Rich Menu 详情 |
| 删除 | deleteRichMenu | 删除 Rich Menu |

---

## 五、模板消息

### Confirm 模板

```typescript
const confirmTemplate = createConfirmTemplate(
  "Are you sure?",
  { type: "message", label: "Yes", text: "yes" },
  { type: "message", label: "No", text: "no" },
  "Confirmation"
);
```

**限制**：
- text: 最大 240 字符
- actions: 恰好 2 个
- altText: 最大 400 字符

### Buttons 模板

```typescript
const buttonsTemplate = createButtonsTemplate(
  "Select an option",
  [
    { type: "message", label: "Option 1", text: "opt1" },
    { type: "message", label: "Option 2", text: "opt2" },
  ],
  "Menu",
  "Buttons Menu"
);
```

**限制**：
- title: 最大 40 字符（可选）
- text: 最大 160 字符
- actions: 1-4 个
- altText: 最大 400 字符

### Carousel 模板

```typescript
const carouselTemplate = createCarouselTemplate([
  {
    text: "Item 1",
    actions: [
      { type: "message", label: "Buy", text: "buy1" },
    ],
  },
  {
    text: "Item 2",
    actions: [
      { type: "message", label: "Buy", text: "buy2" },
    ],
  },
]);
```

**限制**：
- columns: 1-12 个
- 每列 text: 最大 120 字符
- 每列 title: 最大 40 字符（可选）
- 每列 actions: 1-3 个
- altText: 最大 400 字符

---

## 六、Webhook 处理

### 签名验证流程

```
Request Header: X-Line-Signature
    ↓
Extract Signature
    ↓
Compute HMAC(body, channelSecret)
    ↓
Compare with timingSafeEqual
    ↓
Valid? → Parse Body
Invalid? → Throw Error
```

### 事件路由

| 事件类型 | Handler | 描述 |
|---------|---------|------|
| message | handleLineMessageEvent | 文本/图片/视频消息 |
| follow | handleLineFollowEvent | 用户关注 |
| unfollow | handleLineUnfollowEvent | 用户取消关注 |
| postback | handleLinePostbackEvent | Postback 数据 |
| beacon | handleLineBeaconEvent | Beacon 事件 |
| join | handleLineJoinEvent | 机器人加入群组 |
| leave | handleLineLeaveEvent | 机器人离开群组 |

---

## 七、技术权衡

### 1. 批量操作 vs 单个操作

| 方案 | 优势 | 劣势 |
|------|------|------|
| 批量操作 | 减少网络开销、提高吞吐 | 失败处理复杂 |
| 单个操作 | 简单、精确控制 | 性能低 |

**选择**：批量操作
**原因**：Rich Menu 需要大量用户操作，批量处理显著提升性能

### 2. Promise.all vs Promise.allSettled

| 方案 | 优势 | 劣势 |
|------|------|------|
| Promise.all | 快速失败 | 一个失败全部失败 |
| Promise.allSettled | 全部完成 | 需要手动检查结果 |

**选择**：Promise.allSettled
**原因**：批量操作需要隔离失败，继续处理其他用户

### 3. 硬限制 vs 软限制

| 方案 | 优势 | 劣势 |
|------|------|------|
| 硬限制 | 避免失败 | 截断内容 |
| 软限制 | 保留内容 | 可能失败 |

**选择**：硬限制
**原因**：API 限制是硬性的，提前截断避免失败

### 4. 签名验证 vs 明文传输

| 方案 | 优势 | 劣势 |
|------|------|------|
| 签名验证 | 安全、防篡改 | 需要管理密钥 |
| 明文传输 | 简单 | 不安全 |

**选择**：签名验证
**原因**：Webhook 需要验证请求来源，防止伪造

---

*本文档基于源码分析，涵盖 LINE 通道的架构、Flex 模板、Rich Menu、模板消息、Webhook 处理、Bot handlers 以及技术权衡。*
