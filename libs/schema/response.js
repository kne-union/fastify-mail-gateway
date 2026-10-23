// 响应 schema 只用于 OpenAPI 文档：字段可空、对象允许额外字段，避免序列化改变实际输出
const str = description => ({ type: 'string', nullable: true, description });
const num = description => ({ type: 'number', nullable: true, description });
const bool = description => ({ type: 'boolean', nullable: true, description });
// ID（BIGINT）、外键、日期、JSON 列可能是 number / string / Date / 任意结构，不声明类型，原样输出
const any = description => ({ description });
const obj = (description, properties) => ({ type: 'object', nullable: true, additionalProperties: true, description, properties });
const arr = (description, items) => ({ type: 'array', items, description });

const success = (description, schema) => ({ 200: Object.assign({}, schema || { type: 'object' }, { description }) });
const empty = description => success(description || '操作成功，返回空对象');

const timestamps = {
  createdAt: any('创建时间'),
  updatedAt: any('更新时间'),
  deletedAt: any('删除时间，未删除为 null')
};

const STATUS = '状态：enabled 启用，disabled 停用';
const DIRECTION = '触发时机：receive 收信后，beforeSend 发信前，send 发信后，schedule 定时';
const LEVEL = '级别：0 系统默认（不可修改、删除），1 自定义';

const account = obj('邮箱账号（不含密码）', {
  id: any('邮箱账号 ID'),
  name: str('邮箱名称'),
  address: str('邮箱地址，发信时作为 from'),
  username: str('IMAP/SMTP 登录用户名'),
  imap: any('IMAP 配置 { host, port, secure }'),
  smtp: any('SMTP 配置 { host, port, secure }'),
  status: str(`${STATUS}（停用后不再同步和发信）`),
  isDefault: bool('是否为当前用户的默认邮箱'),
  syncState: any('同步游标 { uidValidity, lastUid, oldestUid, history: { status, limit, fetched, startedAt, finishedAt, error } }'),
  lastSyncAt: any('最后一次同步时间'),
  lastError: str('最后一次同步错误信息'),
  userId: any('所属用户 ID'),
  ...timestamps
});

const labelBrief = obj('邮件上的标签', {
  id: any('标签 ID'),
  name: str('标签名称'),
  color: str('标签颜色')
});

const mailFields = {
  id: any('邮件 ID'),
  accountId: any('所属邮箱账号 ID'),
  folder: str('文件夹：inbox 收件箱，sent 已发送，draft 草稿，trash 回收站'),
  originFolder: str('移入回收站前所在文件夹，用于恢复'),
  uid: num('IMAP UID，仅收件箱邮件有值'),
  messageId: str('邮件 Message-ID'),
  inReplyTo: str('回复的邮件 Message-ID'),
  from: any('发件人 [{ name, address }]'),
  to: any('收件人 [{ name, address }]'),
  cc: any('抄送 [{ name, address }]'),
  bcc: any('密送 [{ name, address }]'),
  subject: str('主题'),
  date: any('邮件日期（收信为发送时间，发信为发出时间，草稿为最后保存时间）'),
  isRead: bool('是否已读'),
  isStarred: bool('是否星标'),
  attachments: any('附件 [{ id, filename, contentType, size, cid, checksum }]，收信附件下载后才有 id'),
  size: num('邮件大小（字节）'),
  ...timestamps
};

const mail = obj('邮件', {
  ...mailFields,
  references: any('References 邮件链'),
  html: str('HTML 正文'),
  text: str('纯文本正文'),
  headers: any('部分原始邮件头，用于规则判断（如 auto-submitted、list-id）'),
  labels: arr('邮件标签（发送 / 保存草稿返回的新记录不含该字段）', labelBrief)
});

const mailListItem = obj('邮件列表项（不含正文、邮件头和 References）', {
  ...mailFields,
  summary: str('正文摘要，取纯文本或去掉标签的 HTML 前 120 个字符'),
  labels: arr('邮件标签', labelBrief)
});

const attachment = obj('附件', {
  id: any('文件存储中的文件 ID'),
  filename: str('文件名'),
  contentType: str('MIME 类型'),
  size: num('大小（字节）'),
  cid: str('内嵌图片 Content-ID'),
  checksum: str('附件内容校验值')
});

const label = obj('标签', {
  id: any('标签 ID'),
  accountId: any('所属邮箱账号 ID，为空表示该用户全部邮箱共用'),
  code: str('系统默认标签编码，自定义标签为空'),
  name: str('标签名称'),
  color: str('标签颜色'),
  level: num(LEVEL),
  sort: num('排序，越小越靠前'),
  userId: any('所属用户 ID，系统默认标签为空'),
  ...timestamps
});

const contact = obj('联系人', {
  id: any('联系人 ID'),
  name: str('联系人名称'),
  address: str('邮箱地址（小写）'),
  avatar: str('头像文件 ID'),
  remark: str('备注'),
  userId: any('所属用户 ID'),
  ...timestamps
});

const rule = obj('收发规则', {
  id: any('规则 ID'),
  name: str('规则名称'),
  description: str('描述'),
  direction: str(DIRECTION),
  trigger: any('定时规则触发配置 { windowDays, minCount, cooldownMinutes }，非 schedule 方向为 null'),
  lastTriggeredAt: any('定时规则最近一次触发时间'),
  accountIds: any('适用的邮箱账号 ID 列表，为空表示全部邮箱'),
  conditions: any("条件 { match: 'all'|'any', items: [...] }"),
  actions: any('动作 [{ type, params }]'),
  priority: num('优先级，越小越先执行'),
  stopProcessing: bool('命中后是否停止执行后续规则（保留兼容）'),
  status: str(STATUS),
  userId: any('所属用户 ID'),
  ...timestamps
});

const ruleLog = obj('规则执行日志', {
  id: any('日志 ID'),
  ruleId: any('规则 ID'),
  mailId: any('邮件 ID；发信前被拦截未入库、定时规则批量处理时为空'),
  mailIds: any('定时规则本次处理的邮件 ID 列表'),
  accountId: any('邮箱账号 ID'),
  direction: str(DIRECTION),
  status: str('执行结果：success 全部动作成功，partial 部分失败，failed 全部失败'),
  results: any('各动作执行结果 [{ type, success, output, logs, error }]'),
  executionTime: num('执行耗时（毫秒）'),
  userId: any('所属用户 ID'),
  rule: obj('规则（含已删除）', { id: any('规则 ID'), name: str('规则名称'), direction: str(DIRECTION) }),
  mail: obj('邮件（含已删除），无关联邮件时为 null', {
    id: any('邮件 ID'),
    subject: str('主题'),
    from: any('发件人 [{ name, address }]'),
    to: any('收件人 [{ name, address }]'),
    folder: str('文件夹'),
    date: any('邮件日期')
  }),
  ...timestamps
});

const ruleTestItem = obj('单封邮件的试运行结果', {
  mailId: any('邮件 ID'),
  subject: str('邮件主题'),
  matched: bool('是否命中（邮箱范围与条件同时满足）'),
  accountMatched: bool('邮件所属邮箱是否在规则适用范围内'),
  details: arr(
    '各条件的求值明细，与 conditions.items 顺序一致',
    obj('条件求值明细：内置条件含 field/operator/value，扩展条件含 type/label/params/reason/logs/error；短路跳过的条目 skipped 为 true', {
      matched: bool('该条件是否命中')
    })
  )
});

const ruleExecuteItem = obj('单封邮件的执行结果', {
  ...ruleTestItem.properties,
  executed: bool('是否执行了动作（仅命中时执行）'),
  execution: obj('执行结果，未执行时不返回', {
    ruleId: any('规则 ID'),
    name: str('规则名称'),
    status: str('执行结果：success / partial / failed'),
    results: any('各动作执行结果 [{ type, success, output, logs, error }]')
  })
});

const templateCategory = obj('模版分类', {
  id: any('分类 ID'),
  name: str('分类名称'),
  description: str('分类描述'),
  code: str('分类编码，系统默认分类按编码匹配'),
  level: num(LEVEL),
  sort: num('排序，越小越靠前'),
  userId: any('所属用户 ID，系统默认分类为空'),
  ...timestamps
});

const template = obj('邮件模版', {
  id: any('模版 ID'),
  categoryId: any('所属分类 ID，为空表示未分类'),
  name: str('模版名称'),
  subject: str('邮件主题，支持变量'),
  html: str('富文本正文，支持变量'),
  description: str('模版说明'),
  code: str('模版编码，系统默认模版按编码匹配'),
  level: num(LEVEL),
  status: str('状态：enabled 可用，disabled 停用（写信与规则中不可选）'),
  sort: num('排序，越小越靠前'),
  userId: any('所属用户 ID，系统默认模版为空'),
  category: obj('所属分类，未分类为 null', { id: any('分类 ID'), name: str('分类名称') }),
  ...timestamps
});

const meta = description =>
  obj(description, {
    type: str('类型标识'),
    label: str('显示名称'),
    description: str('说明'),
    directions: arr('支持的触发时机', str('触发时机')),
    formSchema: any('@kne/form-creator 参数表单 Schema，无参数时为 null')
  });

const page = (description, item) => ({
  type: 'object',
  additionalProperties: true,
  properties: {
    pageData: arr(description, item),
    totalCount: num('符合条件的总数')
  }
});

module.exports = {
  str,
  num,
  bool,
  any,
  obj,
  arr,
  success,
  empty,
  account,
  mail,
  mailListItem,
  attachment,
  label,
  contact,
  rule,
  ruleLog,
  ruleTestItem,
  ruleExecuteItem,
  templateCategory,
  template,
  meta,
  page
};
