### 项目概述

`@kne/fastify-mail-gateway` 是一个邮件网关 Fastify 插件：托管已有邮箱账号（IMAP 收信 + SMTP 发信），把邮件同步到本地数据库，提供收件箱、已发送、草稿、回收站和标签管理接口；并对收到和发出的邮件执行**可动态配置的规则中间件**（条件 + 动作），例如打标签分类、自动回复、转发、调用 Webhook，或调用宿主系统注册的自定义动作。

配套前端为 `components-admin` 中的 `MailGateway` 模块。

### 核心架构与流程

```
收信（定时 cron / 手动同步）
  IMAP 拉取 UID > lastUid 的新邮件
        ↓
  mailparser 解析 → 存入 inbox（按 Message-ID 去重，附件只记录元数据）
        ↓
  onReceive 钩子 → 规则管道（direction=receive）

发信（接口 / 草稿发送 / 规则内动作）
  beforeSend 钩子（可改写或拦截）
        ↓
  发信前规则（direction=beforeSend，可修改或拦截；出错或拦截则不发送）
        ↓
  SMTP 发送 → 存入 sent
        ↓
  发信后规则（direction=send）→ afterSend 钩子
  （规则动作内发信不触发发信前 / 发信后规则）

规则管道
  按 priority 加载启用规则 → 过滤适用邮箱 → 条件求值
        ↓（命中）
  按顺序执行动作（单个动作失败不影响其他动作）→ 写 ruleLog → 命中后短路，不再执行后续规则
```

| 节点 | 说明 |
|------|------|
| 同步游标 | 每个邮箱保存 `{ uidValidity, lastUid }`；uidValidity 变化时重新从最新一批开始同步 |
| 首次同步 | 只拉取最新 `syncBatchSize` 封，之后按 UID 升序增量追赶，每次最多 `syncBatchSize` 封 |
| 动作注册表 | 内置动作 + `options.actions` + 运行时 `services.action.register` |
| 条件注册表 | 内置字段条件 + `options.conditions` + 运行时 `services.condition.register` 注册的扩展条件 |
| 系统默认模版 | 配置 `templateDir` 时，数据库同步完成后按 `code` 载入 / 覆盖系统默认分类与模版 |
| 系统默认标签 | 配置 `defaultLabels` 时，数据库同步完成后按 `code` 载入 / 覆盖系统默认全局标签（不可修改、删除） |
| 规则日志 | 只记录命中的规则，包含每个动作的结果、错误和耗时 |

### 核心概念详解

#### 规则

规则由**触发时机**、**适用邮箱**、**条件**、**动作**组成：

| 概念 | 说明 |
|------|------|
| direction | 触发时机：`receive` 收信后，`beforeSend` 发信前（可拦截或修改邮件），`send` 发信后 |
| accountIds | 适用的邮箱账号，为空表示所有邮箱 |
| conditions | `{ match: 'all' \| 'any', items: [...] }`，item 为内置条件 `{ field, operator, value }` 或扩展条件 `{ type, params }`，items 为空表示总是命中 |
| actions | `[{ type, params }]`，按顺序执行 |
| priority | 越小越先执行 |
| stopProcessing | 命中后不再执行后续规则（流水线已固定短路，默认 true） |

条件字段：`from`、`to`、`cc`、`subject`、`text`、`hasAttachment`、`accountId`；操作符：`contains`、`notContains`、`equals`、`startsWith`、`endsWith`、`regex`。字符串比较均不区分大小写，地址类字段的 `equals` 会逐个地址精确匹配。

**扩展条件**：宿主注册 `evaluate` 函数实现字段匹配之外的判断，例如调用大模型判断「客户是否在申请开票」、查询 CRM 判断是否 VIP。扩展条件可声明参数表单，前端在条件字段下拉中分组展示并渲染参数。

> **关键设计**：先求值内置条件，结果已确定时跳过扩展条件；扩展条件依次求值并短路，有超时控制，异常按未命中处理，避免不必要或失控的外部调用（如 AI）。

#### 动作

| 内置动作 | 说明 | 触发时机 |
|------|------|------|
| `addLabel` | 打标签，收件箱中按标签显示为文件夹 | 收信后 / 发信后 |
| `markRead` | 标为已读 | 收信后 |
| `star` | 加星标 | 收信后 / 发信后 |
| `moveToTrash` | 移入回收站 | 收信后 / 发信后 |
| `autoReply` | 自动回复发件人，可引用邮件模版，同一发件人在间隔内只回复一次 | 收信后 |
| `forward` | 转发（含附件）给指定地址 | 收信后 / 发信后 |
| `blockSend` | 拦截发送，发件人看到拦截提示 | 发信前 |
| `modifySubject` | 主题加前缀 / 后缀，支持变量，不重复添加 | 发信前 |
| `appendContent` | 正文顶部或底部追加内容（免责声明、签名等） | 发信前 |
| `addRecipients` | 追加抄送 / 密送，已有地址不重复添加 | 发信前 |
| `webhook` | POST JSON 到指定地址，可选 HMAC 签名；发信前可由接口返回结果拦截或修改邮件 | 全部 |

> **关键设计**：发信前规则在 SMTP 发送前执行，邮件尚未入库。动作按顺序把修改传给下一个动作，任一动作出错或标记拦截都不发送，发件人收到明确的错误提示；从草稿发送被拦截时草稿保留。

> **关键设计**：自动回复和转发发出的邮件带 `Auto-Submitted` 头且不再触发发信规则；自动回复会跳过自动生成邮件、邮件列表、群发和 no-reply 发件人，避免邮件循环。

> **关键设计**：自动回复模板只做 `{{path}}` 变量替换（只读取自有属性），不执行表达式，规则配置不会带来代码执行风险。

#### 系统默认与自定义模版

模版分类与模版都分**系统默认**（`level: 0`）和**自定义**（`level: 1`），做法与 `@kne/fastify-message` 的系统模版一致：

| 类型 | 来源 | 可做的操作 |
|------|------|------|
| 系统默认 | `templateDir` 目录，每次启动按 `code` 覆盖内容 | 启停、排序、复制、预览；不可修改、删除 |
| 自定义 | 界面 / 接口新建、复制系统模版得到 | 全部操作 |

目录中子目录 `{code}_{名称}` 为分类，文件 `{code}_{名称}.html` 为模版，文件内用 `<!-- subject -->`、`<!-- description -->`、`<!-- html -->` 分段。随版本发布的标准模版放进目录即可下发到每个部署，界面上调整过的启停和排序在重启后保留。

### 主要特性

| 特性 | 说明 |
|------|------|
| 邮箱托管 | 添加时校验 IMAP/SMTP 连通性；密码 AES-256-GCM 加密存储，接口永不返回 |
| 增量同步 | cron 定时同步所有启用邮箱，也可手动立即同步；历史邮件用 sync-history 异步分批拉取；并发保护，同一邮箱不会同时同步 |
| 邮件管理 | 收件箱 / 已发送 / 草稿 / 回收站，已读、星标、标签、回收站恢复、彻底删除 |
| 标签文件夹 | 邮箱专属标签 + 全局标签，提供各文件夹和标签的总数 / 未读数；可配置 `defaultLabels` 启动载入系统默认全局标签 |
| 草稿 | 保存、更新、发送草稿，发送后草稿转为已发送 |
| 回复链 | 回复时自动维护 `In-Reply-To` 与 `References` |
| 规则中间件 | 条件 + 动作，支持试运行（只判断是否命中，不执行动作）和执行日志 |
| 邮件模版 | 分类管理富文本模版，支持变量渲染、预览、复制、启停；系统默认模版启动时从目录载入；写信时一键套用，自动回复可直接引用模版 |
| 联系人 | 维护常用收发件人，地址去重，供写信和规则地址输入框选择 |
| 扩展 | 宿主注册自定义动作、扩展条件（前端自动渲染参数表单），以及 `onReceive` / `beforeSend` / `afterSend` 钩子 |

### 使用方法

```js
const path = require('node:path');
const qs = require('qs');
// 列表接口的筛选以 filter[keyword]=xx 形式传递，须用 qs 解析 querystring 才能得到 filter 对象
const fastify = require('fastify')({ querystringParser: str => qs.parse(str) });

// 依赖：fastify-sequelize（必须）、fastify-account（默认鉴权与用户模型）、fastify-file-manager（默认附件存储，可选）
fastify.register(require('@kne/fastify-sequelize'), { db: { dialect: 'sqlite', storage: 'data.db' } });
fastify.register(require('@kne/fastify-account'), { prefix: '/api/v1/account' });
fastify.register(require('@kne/fastify-file-manager'), { prefix: '/api/v1/static', root: './static' });

fastify.register(require('@kne/fastify-mail-gateway'), {
  secretKey: process.env.MAIL_GATEWAY_SECRET_KEY,
  // 系统默认模版目录，启动时载入
  templateDir: path.resolve(__dirname, './templates'),
  // 系统默认全局标签，启动时按 code 载入 / 覆盖（不可修改、删除）
  defaultLabels: [
    { code: 'important', name: '重要', color: '#f5222d' },
    { code: 'todo', name: '待办', color: '#fa8c16' }
  ],
  // 宿主注册扩展条件：如由 AI 判断邮件意图
  conditions: {
    aiJudge: {
      label: 'AI 判断',
      formSchema: { blocks: [{ kind: 'formInfo', list: [{ type: 'TextArea', name: 'prompt', label: '判断描述', rule: 'REQ' }] }] },
      evaluate: async ({ mail, params }) => fastify.ai.services.judge({ prompt: params.prompt, content: mail.text })
    }
  },
  // 宿主注册自定义动作：规则命中后调用系统其他功能
  actions: {
    createTicket: {
      label: '创建工单',
      directions: ['receive'],
      // 参数子表单：@kne/form-creator 搭建 Schema，前端自动渲染，字段值即 params
      formSchema: {
        blocks: [
          {
            kind: 'formInfo',
            list: [{ type: 'Select', name: 'queue', label: '队列', rule: 'REQ', props: { options: [{ label: '售后', value: 'after-sale' }] } }]
          }
        ]
      },
      handler: async ({ mail, params, fastify }) => {
        const ticket = await fastify.ticket.services.create({ queue: params.queue, title: mail.subject, content: mail.text });
        return { ticketId: ticket.id };
      }
    }
  }
});

fastify.register(require('fastify-plugin')(async fastify => {
  await fastify.sequelize.sync();
}));
```

其他插件也可以在运行时注册动作：

```js
const { register, createFormSchema } = fastify.mailGateway.services.action;
register('notifyIm', {
  label: '发送 IM 通知',
  formSchema: createFormSchema([{ type: 'Input', name: 'userIds', label: '通知用户', rule: 'REQ' }]),
  handler: async ({ mail, params }) => {
    // 调用 IM 等系统功能
  }
});
```
