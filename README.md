# fastify-mail-gateway

### 描述

邮件网关 Fastify 插件：托管 IMAP/SMTP 邮箱，收取、发送和管理邮件，支持标签、草稿，以及可动态配置的收发规则中间件（打标签、自动回复、转发、webhook、自定义动作）

### 关键词

fastify, fastify-plugin, mail, email, imap, smtp, mail-gateway, inbox, auto-reply, mail-rules

### 安装

```shell
npm i --save @kne/fastify-mail-gateway
```

### 概述

#### 项目概述

`@kne/fastify-mail-gateway` 是一个邮件网关 Fastify 插件：托管已有邮箱账号（IMAP 收信 + SMTP 发信），把邮件同步到本地数据库，提供收件箱、已发送、草稿、回收站和标签管理接口；并对收到和发出的邮件执行**可动态配置的规则中间件**（条件 + 动作），例如打标签分类、自动回复、转发、调用 Webhook，或调用宿主系统注册的自定义动作。

配套前端为 `components-admin` 中的 `MailGateway` 模块。

#### 核心架构与流程

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
  SMTP 发送 → 存入 sent
        ↓
  规则管道（direction=send，规则动作内发信不触发）→ afterSend 钩子

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
| 规则日志 | 只记录命中的规则，包含每个动作的结果、错误和耗时 |

#### 核心概念详解

##### 规则

规则由**方向**、**适用邮箱**、**条件**、**动作**组成：

| 概念 | 说明 |
|------|------|
| direction | `receive` 收到邮件时触发，`send` 发出邮件后触发 |
| accountIds | 适用的邮箱账号，为空表示所有邮箱 |
| conditions | `{ match: 'all' \| 'any', items: [...] }`，item 为内置条件 `{ field, operator, value }` 或扩展条件 `{ type, params }`，items 为空表示总是命中 |
| actions | `[{ type, params }]`，按顺序执行 |
| priority | 越小越先执行 |
| stopProcessing | 命中后不再执行后续规则（流水线已固定短路，默认 true） |

条件字段：`from`、`to`、`cc`、`subject`、`text`、`hasAttachment`、`accountId`；操作符：`contains`、`notContains`、`equals`、`startsWith`、`endsWith`、`regex`。字符串比较均不区分大小写，地址类字段的 `equals` 会逐个地址精确匹配。

**扩展条件**：宿主注册 `evaluate` 函数实现字段匹配之外的判断，例如调用大模型判断「客户是否在申请开票」、查询 CRM 判断是否 VIP。扩展条件可声明参数表单，前端在条件字段下拉中分组展示并渲染参数。

> **关键设计**：先求值内置条件，结果已确定时跳过扩展条件；扩展条件依次求值并短路，有超时控制，异常按未命中处理，避免不必要或失控的外部调用（如 AI）。

##### 动作

| 内置动作 | 说明 | 方向 |
|------|------|------|
| `addLabel` | 打标签，收件箱中按标签显示为文件夹 | 收 / 发 |
| `markRead` | 标为已读 | 收 |
| `star` | 加星标 | 收 / 发 |
| `moveToTrash` | 移入回收站 | 收 / 发 |
| `autoReply` | 自动回复发件人，可引用邮件模版，同一发件人在间隔内只回复一次 | 收 |
| `forward` | 转发（含附件）给指定地址 | 收 / 发 |
| `webhook` | POST JSON 到指定地址，可选 HMAC 签名 | 收 / 发 |

> **关键设计**：自动回复和转发发出的邮件带 `Auto-Submitted` 头且不再触发发信规则；自动回复会跳过自动生成邮件、邮件列表、群发和 no-reply 发件人，避免邮件循环。

> **关键设计**：自动回复模板只做 `{{path}}` 变量替换（只读取自有属性），不执行表达式，规则配置不会带来代码执行风险。

##### 系统默认与自定义模版

模版分类与模版都分**系统默认**（`level: 0`）和**自定义**（`level: 1`），做法与 `@kne/fastify-message` 的系统模版一致：

| 类型 | 来源 | 可做的操作 |
|------|------|------|
| 系统默认 | `templateDir` 目录，每次启动按 `code` 覆盖内容 | 启停、排序、复制、预览；不可修改、删除 |
| 自定义 | 界面 / 接口新建、复制系统模版得到 | 全部操作 |

目录中子目录 `{code}_{名称}` 为分类，文件 `{code}_{名称}.html` 为模版，文件内用 `<!-- subject -->`、`<!-- description -->`、`<!-- html -->` 分段。随版本发布的标准模版放进目录即可下发到每个部署，界面上调整过的启停和排序在重启后保留。

#### 主要特性

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

#### 使用方法

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


### 示例

### API

#### 配置项

| 属性名 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|------|------|
| name | string | 否 | `'mailGateway'` | 命名空间，服务挂在 `fastify[name]` |
| prefix | string | 否 | `'/api/v1/mail-gateway'` | 接口前缀 |
| dbTableNamePrefix | string | 否 | `'t_'` | 表名前缀，实际表名如 `t_mail_gateway_mail` |
| syncCronTime | string / false | 否 | `'*/5 * * * *'` | 定时同步 cron 表达式，`false` 关闭定时同步 |
| syncBatchSize | number | 否 | `50` | 每个邮箱每次同步最多拉取的邮件数 |
| inboxPath | string | 否 | `'INBOX'` | IMAP 收件箱路径 |
| secretKey | string | 否 | `null` | 邮箱密码加密密钥；未设置时使用内置默认密钥并打印警告，生产环境务必配置 |
| templateDir | string | 否 | `null` | 系统默认模版目录，数据库同步完成后载入，格式见「系统默认模版」；目录不存在时跳过 |
| actions | object | 否 | `{}` | 注册时一并注册的自定义动作 `{ [type]: action }`，格式见「动作注册」 |
| conditions | object | 否 | `{}` | 注册时一并注册的扩展条件 `{ [type]: condition }`，格式见「扩展条件」 |
| onReceive | function | 否 | `null` | `async ({ mail, account, fastify }) => {}`，新邮件入库后、执行收信规则前调用 |
| beforeSend | function | 否 | `null` | `async ({ mailOptions, account, fastify }) => mailOptions \| false`，返回对象替换 nodemailer 参数，返回 `false` 拦截发送 |
| afterSend | function | 否 | `null` | `async ({ mail, info, account, fastify }) => {}`，发送并执行发信规则后调用 |
| uploadAttachment | function | 否 | 使用 `fastify.fileManager` | `async ({ filename, contentType, content }) => ({ id })`，保存收信附件。同步时只记录附件元数据，首次查看 / 转发时才从 IMAP 取回内容并调用本函数，之后直接使用返回的 `id` |
| resolveAttachment | function | 否 | 使用 `fastify.fileManager` / `url` | `async attachment => nodemailerAttachment`，把发信附件 `{ id, filename, url }` 转为 nodemailer 附件 |
| createImapClient | function | 否 | `ImapFlow` | `config => client`，自定义 IMAP 客户端（测试或代理场景） |
| createTransport | function | 否 | `nodemailer.createTransport` | `config => transport`，自定义 SMTP 发送器 |
| getUserModel | function | 否 | `fastify.account.models.user` | 用户模型，用于记录邮箱创建人 |
| getAuthenticate | function | 否 | `[authenticate.user, authenticate.admin]` | `type => onRequest[]`，按功能分类返回鉴权中间件 |

`getAuthenticate` 的 type：

| type | 涉及接口 |
|------|------|
| `account` | 邮箱账号列表、详情 |
| `account:manage` | 添加、修改、删除、启停、测试连接、立即同步、拉取历史邮件 |
| `mail` | 邮件列表、详情、计数、已读、星标、标签、回收站、删除 |
| `mail:send` | 发送邮件、草稿 |
| `label` / `label:manage` | 标签列表 / 标签增删改、排序 |
| `rule` / `rule:manage` | 规则列表、详情、试运行、日志、动作列表 / 规则增删改、启停、排序、手动执行 |
| `template` / `template:manage` | 模版分类与模版列表、详情、渲染 / 分类与模版增删改、排序、启停、复制 |
| `contact` / `contact:manage` | 联系人列表 / 联系人增删改 |

#### 接口

以下路径均以 `prefix`（默认 `/api/v1/mail-gateway`）开头。分页接口参数为 `currentPage`、`perPage`、`filter`，返回 `{ pageData, totalCount }`。

`filter` 以 `filter[keyword]=xx` 的嵌套形式出现在 querystring 中，宿主 fastify 须配置 `querystringParser: str => qs.parse(str)`（使用 [qs](https://www.npmjs.com/package/qs)），否则筛选条件不生效。

##### 邮箱账号

| 方法 路径 | 说明 |
|------|------|
| `GET /accounts` | 账号列表，filter：`id`、`keyword`、`status` |
| `GET /accounts/{id}` | 账号详情 |
| `POST /accounts` | 添加账号，默认先校验连接 |
| `PUT /accounts/{id}` | 修改账号，`password` 不传表示不修改；连接配置变化时重新校验 |
| `DELETE /accounts/{id}` | 删除账号及其邮件、专属标签 |
| `POST /accounts/{id}/status` | 启停，body：`{ status: 'enabled' \| 'disabled' }` |
| `POST /accounts/test-connection` | 测试连接；传 `id` 时未填写的字段使用已保存配置 |
| `POST /accounts/{id}/sync` | 立即同步新邮件，返回 `{ skipped, count, hasMore }`；首次仅拉最新一批 |
| `POST /accounts/{id}/sync-history` | 异步拉取历史邮件：`{ limit? }`（0/空=全部），立即返回 `{ started, skipped?, history }`，进度在 `syncState.history` |

添加账号请求体：

| 属性名 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|------|------|
| name | string | 是 | - | 邮箱名称，发信时作为发件人名称 |
| address | string | 是 | - | 邮箱地址 |
| username | string | 是 | - | 登录用户名 |
| password | string | 是 | - | 密码或授权码 |
| imap | object | 是 | - | `{ host, port, secure }` |
| smtp | object | 是 | - | `{ host, port, secure }` |
| skipVerify | boolean | 否 | `false` | 跳过连接校验 |

测试连接返回：

```json
{
  "success": false,
  "imap": { "success": true },
  "smtp": { "success": false, "error": "Invalid login" }
}
```

##### 邮件

| 方法 路径 | 说明 |
|------|------|
| `GET /mails` | 邮件列表，filter：`accountId`、`folder`（默认 `inbox`）、`labelId`、`keyword`、`isRead`、`isStarred`；列表不含正文，返回 `summary` 摘要和 `labels` |
| `GET /mails/stats?accountId=` | 文件夹与标签计数 |
| `GET /mails/{id}` | 邮件详情，默认自动标为已读（`markRead=false` 关闭） |
| `POST /mails/{id}/attachments/{index}/download` | 下载第 `index` 个附件：未下载时从 IMAP 取回原邮件（UID 失效则按 Message-ID 查找）并经 `uploadAttachment` 保存，已下载直接返回；返回 `{ id, filename, contentType, size }` |
| `POST /mails/read` | `{ ids, isRead }` |
| `POST /mails/star` | `{ ids, isStarred }` |
| `PUT /mails/{id}/labels` | `{ labelIds }`，覆盖邮件标签 |
| `POST /mails/trash` | `{ ids }` 移入回收站 |
| `POST /mails/restore` | `{ ids }` 恢复到原文件夹 |
| `POST /mails/remove` | `{ ids }` 彻底删除本地记录 |
| `POST /mails/send` | 发送邮件 |

计数返回：

```json
{
  "folders": {
    "inbox": { "total": 12, "unread": 3 },
    "sent": { "total": 5 },
    "draft": { "total": 1 },
    "trash": { "total": 0 }
  },
  "labels": [{ "id": "1", "name": "发票", "color": "#1677ff", "total": 4, "unread": 1 }]
}
```

发送邮件请求体（草稿接口相同）：

| 属性名 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|------|------|
| accountId | string | 是 | - | 发信邮箱 |
| to | string / array | 是 | - | `'a@x.com, B <b@x.com>'` 或 `[{ name, address }]` |
| cc | string / array | 否 | - | 抄送 |
| bcc | string / array | 否 | - | 密送 |
| subject | string | 否 | `''` | 主题 |
| html | string | 否 | - | HTML 正文，纯文本正文自动生成 |
| attachments | array | 否 | `[]` | `[{ id, filename, contentType, size, url }]`；引用尚未下载的收信附件时传 `{ mailId, index, filename }`，发送前自动下载 |
| inReplyTo | string | 否 | - | 回复的 Message-ID，会自动追加到 References |
| references | array | 否 | - | References 邮件链 |

##### 草稿

| 方法 路径 | 说明 |
|------|------|
| `POST /drafts` | 新建草稿 |
| `PUT /drafts/{id}` | 更新草稿 |
| `DELETE /drafts/{id}` | 删除草稿 |
| `POST /drafts/{id}/send` | 发送草稿；body 中的字段会先保存再发送 |

##### 标签

| 方法 路径 | 说明 |
|------|------|
| `GET /labels?accountId=` | 标签列表；传 accountId 返回该邮箱专属标签 + 全局标签 |
| `POST /labels` | `{ name, color, accountId, sort }`，accountId 为空表示全局标签 |
| `PUT /labels/{id}` | 修改标签 |
| `DELETE /labels/{id}` | 删除标签并移除邮件上的该标签 |
| `POST /labels/sort` | `{ ids }` 按顺序重排 |

##### 规则

| 方法 路径 | 说明 |
|------|------|
| `GET /actions?direction=` | 可用动作元数据（不含 handler） |
| `GET /rules/options?direction=` | 条件可用的 `fields`、`operators`，以及已注册扩展条件的元数据 `extensions`（含 `formSchema`，不含 `evaluate`） |
| `GET /rules` | 规则列表（按优先级），filter：`keyword`、`direction`、`status` |
| `GET /rules/{id}` | 规则详情 |
| `POST /rules` | 新建规则，会校验条件字段、操作符、正则、动作类型、动作方向与必填参数 |
| `PUT /rules/{id}` | 修改规则 |
| `DELETE /rules/{id}` | 删除规则 |
| `POST /rules/{id}/status` | 启停 |
| `POST /rules/sort` | `{ ids }` 按顺序重排优先级 |
| `POST /rules/test` | 试运行：`{ id?, mailId, conditions?, accountIds?, direction? }`，不执行动作（扩展条件会真实执行判断） |
| `POST /rules/{id}/execute` | 手动执行：`{ mailId }`，对该邮件求值已保存规则，命中则执行动作并写日志（不受启停状态影响）；返回试运行结果 + `executed`、`execution`（`{ ruleId, name, status, results }`），未命中时 `executed: false`。需 `rule:manage` |
| `GET /rule-logs` | 执行日志，filter：`ruleId`、`mailId`、`accountId`、`direction`、`status` |

规则请求体示例：

```json
{
  "name": "发票归档并通知财务系统",
  "direction": "receive",
  "accountIds": [],
  "conditions": {
    "match": "any",
    "items": [
      { "field": "subject", "operator": "contains", "value": "发票" },
      { "field": "from", "operator": "endsWith", "value": "@invoice.example.com" },
      { "type": "aiJudge", "params": { "prompt": "客户是否在申请开具发票" } }
    ]
  },
  "actions": [
    { "type": "addLabel", "params": { "labelIds": ["1"] } },
    { "type": "webhook", "params": { "url": "https://finance.example.com/hooks/mail", "secret": "xxx" } }
  ],
  "priority": 0,
  "stopProcessing": true,
  "status": "enabled"
}
```

试运行返回：

```json
{
  "matched": true,
  "accountMatched": true,
  "details": [
    { "field": "subject", "operator": "contains", "value": "发票", "matched": true },
    { "field": "from", "operator": "endsWith", "value": "@invoice.example.com", "matched": false },
    { "type": "aiJudge", "label": "AI 判断", "params": { "prompt": "客户是否在申请开具发票" }, "matched": false, "skipped": true }
  ]
}
```

`details` 与 `items` 顺序一致；扩展条件项带 `label`，以及 `reason`（判断理由）、`logs`、`error`（判断失败时）、`skipped`（结果已确定而跳过）。

##### 邮件模版

| 方法 路径 | 说明 |
|------|------|
| `GET /template-categories` | 分类列表，每项带 `templateCount`、`level`；`uncategorizedCount` 为未分类模版数 |
| `POST /template-categories` | `{ name, description, sort }`，新建为自定义分类 |
| `PUT /template-categories/{id}` | 修改分类；系统默认分类返回 403 |
| `DELETE /template-categories/{id}` | 删除分类，分类下的模版转为未分类；系统默认分类返回 403 |
| `POST /template-categories/sort` | `{ ids }` 按顺序重排（系统默认分类也可排序） |
| `GET /templates` | 模版列表，filter：`categoryId`（`none` 表示未分类）、`status`、`level`（`0` 系统默认 / `1` 自定义）、`keyword`（名称、主题） |
| `GET /templates/{id}` | 模版详情，含 `category` |
| `POST /templates` | `{ name, categoryId, subject, html, description, status, sort }`，新建为自定义模版，可放在系统默认分类下 |
| `PUT /templates/{id}` | 修改模版；系统默认模版返回 403 |
| `DELETE /templates/{id}` | 删除模版；系统默认模版返回 403（可停用） |
| `POST /templates/{id}/status` | 启停（系统默认模版也可启停）；停用后规则中引用该模版的自动回复会失败并记入日志 |
| `POST /templates/{id}/copy` | 复制为停用状态的自定义副本；需要改系统默认模版时复制后修改副本 |
| `POST /templates/render` | 渲染模版，返回 `{ subject, html }` |

渲染请求体：

| 属性名 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|------|------|
| id | string | 否 | - | 模版 ID |
| template | object | 否 | - | 未保存的 `{ subject, html }`，优先于 `id`，用于编辑时预览 |
| mailId | string | 否 | - | 提供 `mail` 变量，如回复时的原邮件 |
| accountId | string | 否 | 邮件所属邮箱 | 提供 `account` 变量 |
| data | object | 否 | `{}` | 额外变量，如 `{{name}}` |

模版变量写法为 `{{path}}`，如 `{{mail.subject}}`、`{{mail.from[0].name}}`、`{{account.name}}`；只做取值替换不执行表达式，正文中的变量值会做 HTML 转义，缺失变量替换为空。

##### 联系人

| 方法 路径 | 说明 |
|------|------|
| `GET /contacts` | 联系人列表，filter：`keyword`（名称、地址模糊）、`address`（精确） |
| `POST /contacts` | `{ name, address, avatar, remark }`，地址统一存小写，已存在返回 409；`avatar` 为头像文件 id |
| `PUT /contacts/{id}` | 修改联系人，地址与其它联系人重复时返回 409 |
| `DELETE /contacts/{id}` | 删除联系人 |

#### 程序化 API

服务挂在 `fastify[options.name].services`（默认 `fastify.mailGateway.services`）。

| 方法签名 | 说明 |
|------|------|
| `account.list({ filter, perPage, currentPage })` | 账号列表 |
| `account.create(data)` / `account.save({ id, ...data })` | 添加 / 修改账号 |
| `account.testConnection({ id?, username, password, imap, smtp })` | 测试连接 |
| `account.getWithPassword({ id })` | 取解密后的账号配置（仅供内部使用） |
| `sync.syncAccount({ id })` / `sync.syncAll()` | 同步单个 / 全部启用邮箱 |
| `mail.list(...)` / `mail.detail({ id, markRead })` | 邮件列表 / 详情 |
| `mail.downloadAttachment({ id, index })` | 按需下载收信附件并保存，已下载直接返回；同一附件并发调用只下载一次 |
| `sync.fetchMessage({ account, uid, messageId })` | 从收件箱重新拉取并解析一封邮件 |
| `mail.send({ accountId, to, cc, bcc, subject, html, attachments, inReplyTo, references, headers, skipRules })` | 发送邮件；`skipRules` 为 true 时不执行发信规则 |
| `mail.addLabels({ id, labelIds })` / `mail.setLabels({ id, labelIds })` | 追加 / 覆盖标签 |
| `mail.folderStats({ accountId })` | 文件夹与标签计数 |
| `draft.save(data)` / `draft.send({ id })` | 保存 / 发送草稿 |
| `label.list({ accountId })` | 标签列表 |
| `rule.create(data)` / `rule.test({ id, mailId })` / `rule.execute({ id, mailId })` | 新建规则 / 试运行 / 手动执行（命中才执行动作） |
| `pipeline.run({ direction, mail, account })` | 对一封邮件执行规则，返回命中规则的执行结果 |
| `template.list(...)` / `template.detail({ id })` | 模版列表 / 详情 |
| `template.render({ id, template, mailId, accountId, data })` | 渲染模版，返回 `{ subject, html }` |
| `template.includeTemplate(dir)` | 从目录载入系统默认分类与模版，串行执行，可重复调用 |
| `contact.list(...)` / `contact.create({ name, address, remark })` | 联系人列表 / 新建联系人 |
| `action.register(type, action)` / `action.unregister(type)` | 注册 / 注销动作 |
| `action.list({ direction })` | 动作元数据 |
| `condition.register(type, condition)` / `condition.unregister(type)` | 注册 / 注销扩展条件 |
| `condition.list({ direction })` | 扩展条件元数据 |
| `condition.evaluate({ conditions, mail, account, rule, direction })` | 判断条件，返回 `{ matched, details }` |

##### 动作注册

```js
fastify.mailGateway.services.action.register('createTicket', {
  label: '创建工单',
  description: '收到客户邮件后创建售后工单',
  directions: ['receive'], // 默认 ['receive', 'send']
  formSchema: {
    blocks: [
      {
        id: 'params',
        kind: 'formInfo',
        column: 1,
        list: [
          { id: 'queue', type: 'Select', name: 'queue', label: '队列', rule: 'REQ', props: { options: [{ label: '售后', value: 'after-sale' }], defaultValue: 'after-sale' } },
          { id: 'assignee', type: 'Input', name: 'assignee', label: '处理人', description: '留空则按队列自动分配' }
        ]
      }
    ]
  },
  handler: async ({ mail, account, params, rule, direction, fastify, services, models, log }) => {
    log('创建工单', params.queue);
    return { ticketId: 'T-1' }; // 写入规则日志 results[].output
  }
});
```

| 属性名 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|------|------|
| label | string | 否 | type | 显示名称 |
| description | string | 否 | `''` | 说明 |
| directions | array | 否 | `['receive', 'send']` | 支持的规则方向 |
| formSchema | object | 否 | - | 参数子表单，`@kne/form-creator` 搭建 Schema，前端用 `SchemaRendererInner` 渲染，字段值即 `params`；不传表示无参数 |
| validate | function | 否 | - | `params => void`，参数间有依赖时抛错，保存规则和执行前都会调用 |
| handler | function | 是 | - | 执行函数，抛出异常视为该动作失败 |

`formSchema` 字段：`type`、`name`、`label`、`rule`、`description`、`tips`、`block`、`props`（透传给控件，默认值写在 `props.defaultValue`）。注册时自动补齐缺失的区块 / 字段 `id`（如 `block-0`、`block-0-queue`），避免前端反复重新挂载；`formInfo` / `object` 区块中 `rule` 含 `REQ` 的字段在保存规则和执行前校验必填（列表类区块仅前端校验）。

`services.action.createFormSchema(list)` 可把字段数组包装为单个 `formInfo` 区块的 Schema。

字段 `type` 可用 FormCreator 内置类型（`Input`、`TextArea`、`InputNumber`、`Switch`、`Select`、`RadioGroup` 等），以及 `components-admin` MailGateway 注册的邮件字段：

| type | 前端控件 |
|------|------|
| `MailLabelSelect` | 标签选择（多选） |
| `MailTemplateSelect` | 邮件模版选择 |
| `MailContactSelect` | 邮箱地址多值输入 |
| `MailEditor` / `MailTemplateText` | 富文本正文 / 单行模版文本，支持模版变量 |
| `MailJson` | JSON 编辑器，以对象保存 |

其他控件由宿主前端通过 FormCreator `preset({ fields })` 注册后在 `formSchema` 中引用。

内置 `autoReply` 支持 `templateId` 参数：选择模版时使用模版主题与正文（模版主题为空时用 `subject`），否则 `html` 必填。

##### Webhook 请求体

```json
{
  "event": "receive",
  "rule": { "id": "1", "name": "发票归档并通知财务系统" },
  "account": { "id": "1", "name": "客服邮箱", "address": "service@example.com" },
  "mail": { "id": "10", "subject": "九月发票", "from": [{ "name": "", "address": "a@x.com" }], "html": "...", "text": "..." }
}
```

设置 `secret` 时带请求头 `X-Mail-Gateway-Signature: sha256=<HMAC-SHA256(secret, body) hex>`。

##### 扩展条件

内置条件只做字段文本匹配。需要外部判断（如调用 AI 判断邮件意图、查询 CRM 是否为 VIP 客户）时，宿主注册扩展条件；插件只提供注册与执行机制，不内置 AI 调用。

```js
fastify.mailGateway.services.condition.register('aiJudge', {
  label: 'AI 判断',
  description: '由大模型判断邮件是否符合描述',
  directions: ['receive'], // 默认 ['receive', 'send']
  timeout: 15000, // 默认 30000，超时视为未命中
  formSchema: {
    blocks: [{ kind: 'formInfo', list: [{ type: 'TextArea', name: 'prompt', label: '判断描述', rule: 'REQ' }] }]
  },
  evaluate: async ({ mail, params, log }) => {
    const { matched, reason } = await fastify.ai.services.judge({ prompt: params.prompt, content: `${mail.subject}\n${mail.text}` });
    log('AI 结果', matched);
    return { matched, reason }; // 也可直接返回 boolean
  }
});
```

| 属性名 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|------|------|
| label | string | 否 | type | 显示名称，前端在条件字段下拉的「扩展条件」分组中展示 |
| description | string | 否 | `''` | 说明 |
| directions | array | 否 | `['receive', 'send']` | 支持的规则方向 |
| formSchema | object | 否 | - | 参数表单，规则与动作相同；字段值即 `params`，`rule` 含 `REQ` 的字段保存规则和执行前校验必填 |
| validate | function | 否 | - | `params => void`，参数间有依赖时抛错 |
| evaluate | function | 是 | - | `async ({ mail, account, params, rule, direction, fastify, services, models, options, log }) => boolean \| { matched, reason }` |
| timeout | number | 否 | `30000` | 单次判断超时毫秒数 |

`register` 第二个参数也可直接传 `evaluate` 函数；`type` 不能为 `field`，同名覆盖。

规则中扩展条件写为 `{ type, params }`，与内置条件 `{ field, operator, value }` 混用，同样受 `match`（all / any）约束：

- 先求值全部内置条件；结果已确定时（`all` 遇到未命中、`any` 遇到命中）跳过扩展条件，不产生外部调用
- 扩展条件按配置顺序依次求值，同样短路
- `evaluate` 抛错或超时按未命中处理，错误写入试运行 `details[].error` 并打印日志，不影响其它规则
- 规则引用的扩展条件未注册时保存报错；已保存规则在执行时遇到未注册条件按未命中处理

##### 系统默认模版

与 `@kne/fastify-message` 的系统模版做法一致：配置 `templateDir` 后，数据库同步完成时把目录中的分类与模版载入为系统默认（`level: 0`）；界面和接口新建的为自定义（`level: 1`）。

目录结构：

```
templates/
├── customer-service_客服回复/          # 分类：{code}_{名称}
│   ├── _description.txt               # 可选，分类描述
│   ├── receipt-notice_来信受理通知.html  # 模版：{code}_{名称}.html
│   └── ticket-closed_问题已解决回访.html
├── finance_财务通知/
│   └── invoice-issued_发票已开具.html
└── welcome_欢迎邮件.html                # 根目录下的文件为未分类模版
```

- 名称按第一个 `_` 拆分，`_` 前为 `code`（因此 `code` 中不能含 `_`，建议用 `kebab-case`），之后为名称；没有 `_` 时以 `code` 作名称
- 以 `.` 或 `_` 开头的文件和目录被忽略；分类目录只读一层
- 按文件名排序，新建记录时以此作为初始 `sort`

模版文件内容：

```html
<!-- subject -->
已收到：{{mail.subject}}
<!-- description -->
自动回复规则「客服邮箱自动回复」在使用
<!-- html -->
<p>您好 {{mail.from[0].name}}，</p>
<p>我们已收到您的来信，将在 1 个工作日内回复。</p>
```

`subject`、`description`、`html` 三段均可省略；文件中没有任何段落标记时，全文作为 `html`。

载入规则：

| 项目 | 说明 |
|------|------|
| 匹配 | 按 `code` + `level: 0` 匹配，不存在时新建（模版默认启用） |
| 覆盖 | 每次启动覆盖名称、主题、正文、说明、所属分类（文件移到其它分类目录即改分类）；分类覆盖名称、描述 |
| 保留 | 状态、排序保留界面上的调整 |
| 删除 | 从目录中移除的文件不会删除已有记录，需要时手动停用 |
| 幂等 | 载入串行执行，多次调用 `includeTemplate` 不产生重复记录 |

系统默认分类与模版不可修改、删除（接口返回 403），可启停、排序、复制；复制得到的副本为自定义模版。自定义模版可以放在系统默认分类下。

#### 数据模型

##### account

| 属性名 | 类型 | 说明 |
|------|------|------|
| name | string | 邮箱名称 |
| address | string | 邮箱地址 |
| username | string | 登录用户名 |
| password | string | 加密后的密码，默认 scope 不查询 |
| imap / smtp | object | `{ host, port, secure }` |
| status | string | `enabled` / `disabled` |
| syncState | object | `{ uidValidity, lastUid }` |
| lastSyncAt | Date | 最后同步时间 |
| lastError | string | 最后同步错误 |
| userId | string | 创建人 |

##### mail

| 属性名 | 类型 | 说明 |
|------|------|------|
| accountId | string | 所属邮箱 |
| folder | string | `inbox` / `sent` / `draft` / `trash` |
| originFolder | string | 移入回收站前的文件夹 |
| uid | number | IMAP UID（仅收件箱） |
| messageId / inReplyTo | string | Message-ID / 回复的 Message-ID |
| references | array | References |
| from / to / cc / bcc | array | `[{ name, address }]` |
| subject / html / text | string | 主题 / HTML 正文 / 纯文本正文 |
| date | Date | 邮件日期 |
| isRead / isStarred | boolean | 已读 / 星标 |
| attachments | array | `[{ id, filename, contentType, size, cid, checksum }]`，收信附件未下载前没有 `id` |
| headers | object | 部分原始头：auto-submitted、precedence、list-id、list-unsubscribe 等 |
| size | number | 大小（字节） |

唯一约束：`(account_id, folder, uid)`（未删除记录）。

##### label

| 属性名 | 类型 | 说明 |
|------|------|------|
| accountId | string | 所属邮箱，为空表示全局标签 |
| name | string | 名称 |
| color | string | 颜色 |
| sort | number | 排序 |

##### mailLabel

邮件与标签的关联表（`mailId`、`labelId`），不做软删除，`(mail_id, label_id)` 唯一。

##### rule

| 属性名 | 类型 | 说明 |
|------|------|------|
| name / description | string | 名称 / 描述 |
| direction | string | `receive` / `send` |
| accountIds | array | 适用邮箱，为空表示全部 |
| conditions | object | 条件，`items` 为内置条件 `{ field, operator, value }` 或扩展条件 `{ type, params }` |
| actions | array | 动作 |
| priority | number | 优先级，越小越先执行 |
| stopProcessing | boolean | 命中后停止 |
| status | string | `enabled` / `disabled` |

##### templateCategory

| 属性名 | 类型 | 说明 |
|------|------|------|
| name / description | string | 名称 / 描述 |
| code | string | 系统默认分类的编码（目录名中的 code），自定义分类为空 |
| level | number | `0` 系统默认 / `1` 自定义 |
| sort | number | 排序 |

##### template

| 属性名 | 类型 | 说明 |
|------|------|------|
| categoryId | string | 所属分类，为空表示未分类 |
| name / description | string | 名称 / 说明 |
| code | string | 系统默认模版的编码（文件名中的 code），自定义模版为空 |
| level | number | `0` 系统默认 / `1` 自定义 |
| subject / html | string | 主题 / 富文本正文，支持变量 |
| status | string | `enabled` / `disabled` |
| sort | number | 排序 |

##### contact

| 属性名 | 类型 | 说明 |
|------|------|------|
| name | string | 名称 |
| address | string | 邮箱地址，小写存储，不可重复 |
| avatar | string | 头像文件 id |
| remark | string | 备注 |

##### ruleLog

| 属性名 | 类型 | 说明 |
|------|------|------|
| ruleId / mailId / accountId | string | 规则 / 邮件 / 邮箱 |
| direction | string | 触发方向 |
| status | string | `success` / `partial` / `failed` |
| results | array | `[{ type, success, output, logs, error }]` |
| executionTime | number | 耗时（毫秒） |

#### 机制说明

> **同步去重**：收件箱邮件按 `(accountId, Message-ID)` 去重，uidValidity 变化导致的重复拉取不会产生重复邮件。

> **失败隔离**：规则执行、`onReceive`、`afterSend` 中的异常只写日志，不影响收信入库和发信结果；单个动作失败时规则日志状态为 `partial`。

> **规则内发信不再触发规则**：`autoReply`、`forward` 内部发信使用 `skipRules: true`，避免规则互相触发形成循环。

> **只操作本地数据**：已读、星标、标签、回收站、删除只修改本地记录，不回写邮件服务器。
