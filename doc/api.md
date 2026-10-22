### 配置项

| 属性名 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|------|------|
| name | string | 否 | `'mailGateway'` | 命名空间，服务挂在 `fastify[name]` |
| prefix | string | 否 | `'/api/v1/mail-gateway'` | 接口前缀 |
| dbTableNamePrefix | string | 否 | `'t_'` | 表名前缀，实际表名如 `t_mail_gateway_mail` |
| syncCronTime | string / false | 否 | `'*/5 * * * *'` | 定时同步 cron 表达式，`false` 关闭定时同步 |
| syncBatchSize | number | 否 | `50` | 每个邮箱每次同步最多拉取的邮件数 |
| scheduleCronTime | string / false | 否 | `'*/5 * * * *'` | 未读邮件规则（`direction: 'schedule'`）的检查频率，`false` 关闭 |
| syncFlagsToServer | boolean | 否 | `true` | 标为已读 / 未读、移入回收站时是否回写 IMAP 服务器 |
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

### 接口

以下路径均以 `prefix`（默认 `/api/v1/mail-gateway`）开头。分页接口参数为 `currentPage`、`perPage`、`filter`，返回 `{ pageData, totalCount }`。

`filter` 以 `filter[keyword]=xx` 的嵌套形式出现在 querystring 中，宿主 fastify 须配置 `querystringParser: str => qs.parse(str)`（使用 [qs](https://www.npmjs.com/package/qs)），否则筛选条件不生效。

#### 邮箱账号

| 方法 路径 | 说明 |
|------|------|
| `GET /accounts` | 账号列表，filter：`id`、`keyword`、`status` |
| `GET /accounts/{id}` | 账号详情 |
| `POST /accounts` | 添加账号，默认先校验连接 |
| `PUT /accounts/{id}` | 修改账号，`password` 不传表示不修改；连接配置变化时重新校验 |
| `DELETE /accounts/{id}` | 删除账号及其邮件、专属标签 |
| `POST /accounts/{id}/status` | 启停，body：`{ status: 'enabled' \| 'disabled' }` |
| `POST /accounts/{id}/default` | 设为当前用户的默认邮箱，其它邮箱取消默认 |
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

#### 邮件

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

#### 草稿

| 方法 路径 | 说明 |
|------|------|
| `POST /drafts` | 新建草稿 |
| `PUT /drafts/{id}` | 更新草稿 |
| `DELETE /drafts/{id}` | 删除草稿 |
| `POST /drafts/{id}/send` | 发送草稿；body 中的字段会先保存再发送 |

`POST /mails/send` 与 `POST /drafts/{id}/send` 被发信前规则改存草稿时不发送，返回 `folder` 为 `draft` 的草稿（从草稿发送时更新原草稿）。

#### 标签

| 方法 路径 | 说明 |
|------|------|
| `GET /labels?accountId=` | 标签列表；传 accountId 返回该邮箱专属标签 + 全局标签 |
| `POST /labels` | `{ name, color, accountId, sort }`，accountId 为空表示全局标签 |
| `PUT /labels/{id}` | 修改标签 |
| `DELETE /labels/{id}` | 删除标签并移除邮件上的该标签 |
| `POST /labels/sort` | `{ ids }` 按顺序重排 |

#### 规则

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

**未读邮件规则**：`direction` 为 `schedule` 时必填 `trigger`，按 `scheduleCronTime` 定时检查：统计各适用邮箱在 `windowDays` 天内收到的收件箱未读邮件（再按 `conditions` 逐封过滤，条件为空表示全部计入），达到 `minCount` 封时把这批邮件交给动作处理；两次触发至少间隔 `cooldownMinutes` 分钟（默认等于时间窗口，即 `windowDays × 1440`）。可用动作需声明 `schedule`，内置 `digestForward`（汇总转发）、`markRead`、`moveToTrash`。未读邮件规则不支持对单封邮件手动执行。

```json
{
  "name": "未读汇总",
  "direction": "schedule",
  "trigger": { "windowDays": 1, "minCount": 10, "cooldownMinutes": 60 },
  "actions": [
    { "type": "digestForward", "params": { "to": ["boss@example.com"], "subject": "未读邮件汇总（{{count}} 封）" } },
    { "type": "markRead" }
  ]
}
```

#### 邮件模版

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

#### 联系人

| 方法 路径 | 说明 |
|------|------|
| `GET /contacts` | 联系人列表，filter：`keyword`（名称、地址模糊）、`address`（精确） |
| `POST /contacts` | `{ name, address, avatar, remark }`，地址统一存小写，已存在返回 409；`avatar` 为头像文件 id |
| `PUT /contacts/{id}` | 修改联系人，地址与其它联系人重复时返回 409 |
| `DELETE /contacts/{id}` | 删除联系人 |

### 程序化 API

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
| `mail.send({ accountId, to, cc, bcc, subject, html, attachments, inReplyTo, references, headers, skipRules })` | 发送邮件；`skipRules` 为 true 时不执行发信前 / 发信后规则 |
| `mail.addLabels({ id, labelIds })` / `mail.setLabels({ id, labelIds })` | 追加 / 覆盖标签 |
| `mail.folderStats({ accountId })` | 文件夹与标签计数 |
| `draft.save(data)` / `draft.send({ id })` | 保存 / 发送草稿 |
| `label.list({ accountId })` | 标签列表 |
| `rule.create(data)` / `rule.test({ id, mailId })` / `rule.execute({ id, mailId })` | 新建规则 / 试运行 / 手动执行（命中才执行动作；发信前规则不支持手动执行） |
| `pipeline.run({ direction, mail, account })` | 对一封邮件执行规则，返回命中规则的执行结果 |
| `pipeline.beforeSend({ mail, account })` | 执行发信前规则，返回 `{ mail, logIds, draft }`（修改后的邮件，`draft` 表示改存草稿）；被拦截或动作出错时抛错 |
| `schedule.runAll({ now })` / `schedule.runRule({ rule, now })` | 执行全部启用的未读邮件规则 / 单条未读邮件规则，返回执行结果列表 |
| `template.list(...)` / `template.detail({ id })` | 模版列表 / 详情 |
| `template.render({ id, template, mailId, accountId, data })` | 渲染模版，返回 `{ subject, html }` |
| `template.includeTemplate(dir)` | 从目录载入系统默认分类与模版，串行执行，可重复调用 |
| `contact.list(...)` / `contact.create({ name, address, remark })` | 联系人列表 / 新建联系人 |
| `action.register(type, action)` / `action.unregister(type)` | 注册 / 注销动作 |
| `action.list({ direction })` | 动作元数据 |
| `condition.register(type, condition)` / `condition.unregister(type)` | 注册 / 注销扩展条件 |
| `condition.list({ direction })` | 扩展条件元数据 |
| `condition.evaluate({ conditions, mail, account, rule, direction })` | 判断条件，返回 `{ matched, details }` |

#### 动作注册

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
| directions | array | 否 | `['receive', 'send']` | 支持的触发时机：`receive` 收信后、`beforeSend` 发信前、`send` 发信后、`schedule` 未读邮件（定时检查）；发信前、未读邮件需显式声明 |
| formSchema | object | 否 | - | 参数子表单，`@kne/form-creator` 搭建 Schema，前端用 `SchemaRendererInner` 渲染，字段值即 `params`；不传表示无参数 |
| validate | function | 否 | - | `params => void`，参数间有依赖时抛错，保存规则和执行前都会调用 |
| handler | function | 是 | - | 执行函数，抛出异常视为该动作失败 |

**发信前动作**：`directions` 含 `beforeSend` 的动作在 SMTP 发送前执行，`mail` 为待发送邮件（与入库记录同构，`id` 为空，从草稿发送时为草稿 id）。`handler` 返回值可带：

| 字段 | 说明 |
|------|------|
| `mail` | 修改邮件，可含 `subject`、`html`、`text`、`to`、`cc`、`bcc`、`headers`；后续动作拿到的是修改后的邮件；只改 `html` 时自动重算纯文本，`headers` 为追加的请求头 |
| `block` | `true` 或拦截原因字符串，拦截发送；同一规则的其它动作仍会执行（可先通知再拦截） |
| `draft` | `true` 时不发送，把（修改后的）邮件存入草稿箱，由用户核对后手动发送；`mail.headers` 会随草稿保存，可用作标记避免手动发送时重复处理 |

**未读邮件动作**：`directions` 含 `schedule` 的动作由未读邮件规则调用，`mail` 为 `null`，`mails` 为本次统计到的未读邮件（按时间升序），`account` 为所属邮箱。

任一发信前动作抛错即停止后续动作并中止发送，接口返回 400 和错误原因。

```js
fastify.mailGateway.services.action.register('dlpCheck', {
  label: '敏感信息检查',
  directions: ['beforeSend'],
  handler: async ({ mail }) => {
    if (/身份证号/.test(mail.text)) {
      return { block: '正文包含身份证号，禁止外发' };
    }
    return { mail: { subject: `[已检查] ${mail.subject}` } };
  }
});
```

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

#### Webhook 请求体

```json
{
  "event": "receive",
  "rule": { "id": "1", "name": "发票归档并通知财务系统" },
  "account": { "id": "1", "name": "客服邮箱", "address": "service@example.com" },
  "mail": { "id": "10", "subject": "九月发票", "from": [{ "name": "", "address": "a@x.com" }], "html": "...", "text": "..." }
}
```

设置 `secret` 时带请求头 `X-Mail-Gateway-Signature: sha256=<HMAC-SHA256(secret, body) hex>`。

`event` 为规则触发时机（`receive` / `beforeSend` / `send`）。发信前规则中，接口返回 `Content-Type: application/json` 的 `{ "block": "拦截原因" }` 可拦截发送，返回 `{ "mail": { "subject": "..." } }` 可修改邮件（字段同上方发信前动作）；接口非 2xx 或超时视为动作失败，邮件不发送。

#### 扩展条件

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
| directions | array | 否 | `['receive', 'send']` | 支持的触发时机；发信前（`beforeSend`）邮件尚未入库，需显式声明 |
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

#### 系统默认模版

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

### 数据模型

#### account

| 属性名 | 类型 | 说明 |
|------|------|------|
| name | string | 邮箱名称 |
| address | string | 邮箱地址 |
| username | string | 登录用户名 |
| password | string | 加密后的密码，默认 scope 不查询 |
| imap / smtp | object | `{ host, port, secure }` |
| status | string | `enabled` / `disabled` |
| isDefault | boolean | 是否为该用户的默认邮箱；用户添加的第一个邮箱自动设为默认，删除默认邮箱后由最早添加的邮箱接替；启动时为缺列的存量表补列，没有默认邮箱的用户由最早添加的邮箱接替 |
| syncState | object | `{ uidValidity, lastUid }` |
| lastSyncAt | Date | 最后同步时间 |
| lastError | string | 最后同步错误 |
| userId | string | 创建人 |

#### mail

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

#### label

| 属性名 | 类型 | 说明 |
|------|------|------|
| accountId | string | 所属邮箱，为空表示全局标签 |
| name | string | 名称 |
| color | string | 颜色 |
| sort | number | 排序 |

#### mailLabel

邮件与标签的关联表（`mailId`、`labelId`），不做软删除，`(mail_id, label_id)` 唯一。

#### rule

| 属性名 | 类型 | 说明 |
|------|------|------|
| name / description | string | 名称 / 描述 |
| direction | string | 触发时机：`receive` 收信后 / `beforeSend` 发信前 / `send` 发信后 / `schedule` 未读邮件（定时检查） |
| trigger | object | 未读邮件规则触发配置 `{ windowDays, minCount, cooldownMinutes }`，其它方向为空 |
| lastTriggeredAt | date | 未读邮件规则最近一次触发时间 |
| accountIds | array | 适用邮箱，为空表示全部 |
| conditions | object | 条件，`items` 为内置条件 `{ field, operator, value }` 或扩展条件 `{ type, params }` |
| actions | array | 动作 |
| priority | number | 优先级，越小越先执行 |
| stopProcessing | boolean | 命中后停止 |
| status | string | `enabled` / `disabled` |

#### templateCategory

| 属性名 | 类型 | 说明 |
|------|------|------|
| name / description | string | 名称 / 描述 |
| code | string | 系统默认分类的编码（目录名中的 code），自定义分类为空 |
| level | number | `0` 系统默认 / `1` 自定义 |
| sort | number | 排序 |

#### template

| 属性名 | 类型 | 说明 |
|------|------|------|
| categoryId | string | 所属分类，为空表示未分类 |
| name / description | string | 名称 / 说明 |
| code | string | 系统默认模版的编码（文件名中的 code），自定义模版为空 |
| level | number | `0` 系统默认 / `1` 自定义 |
| subject / html | string | 主题 / 富文本正文，支持变量 |
| status | string | `enabled` / `disabled` |
| sort | number | 排序 |

#### contact

| 属性名 | 类型 | 说明 |
|------|------|------|
| name | string | 名称 |
| address | string | 邮箱地址，小写存储，不可重复 |
| avatar | string | 头像文件 id |
| remark | string | 备注 |

#### ruleLog

| 属性名 | 类型 | 说明 |
|------|------|------|
| ruleId / mailId / accountId | string | 规则 / 邮件 / 邮箱；发信前规则拦截的邮件未入库，`mailId` 为空（发送成功或改存草稿后回填）；未读邮件规则 `mailId` 为空 |
| mailIds | array | 未读邮件规则本次处理的邮件 id |
| direction | string | 触发时机 |
| status | string | `success` / `partial` / `failed` |
| results | array | `[{ type, success, output, logs, error }]` |
| executionTime | number | 耗时（毫秒） |

### 机制说明

> **同步去重**：收件箱邮件按 `(accountId, Message-ID)` 去重，uidValidity 变化导致的重复拉取不会产生重复邮件。

> **失败隔离**：收信后 / 发信后规则、`onReceive`、`afterSend` 中的异常只写日志，不影响收信入库和发信结果；单个动作失败时规则日志状态为 `partial`。

> **发信前出错不放行**：发信前规则用于拦截和修改，动作出错或被拦截时中止发送并把原因返回给发件人，草稿保留。

> **规则内发信不再触发规则**：`autoReply`、`forward`、`digestForward` 内部发信使用 `skipRules: true`，不执行发信前 / 发信后规则，避免规则互相触发形成循环。

> **存量库升级**：`rule.direction`、`ruleLog.direction` 新增 `beforeSend`、`schedule` 枚举值，`ruleLog.mailId` 改为可空；`sequelize.sync` 不会修改已有表，升级前需在数据库执行对应的 ALTER（Postgres 为 `ALTER TYPE ... ADD VALUE 'beforeSend'` / `ADD VALUE 'schedule'` 与 `ALTER COLUMN mail_id DROP NOT NULL`）。新增列 `rule.trigger`、`rule.last_triggered_at`、`ruleLog.mail_ids` 在启动时自动补齐。

> **回写邮件服务器**：已读 / 未读（`\Seen` 标记）和移入回收站（移入服务器 special-use `\Trash` 文件夹，没有时打 `\Deleted` 标记）会回写 IMAP，只处理收件箱中带 uid 的邮件；回写失败只记日志，不回滚本地状态。打开邮件详情自动标已读时不等待回写。从回收站还原、星标、标签、彻底删除只修改本地记录；`syncFlagsToServer: false` 可关闭回写。
