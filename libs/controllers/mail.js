const fp = require('fastify-plugin');
const { idParams, idsBody, pageQuery, addressField, attachmentsField } = require('../utils/schema');
const { userIdOf } = require('../utils/owner');
const { num, any, str, obj, arr, success, empty, mail, mailListItem, attachment, page } = require('../schema/response');

const TAG = '邮件网关-邮件';
const DRAFT_TAG = '邮件网关-草稿';

const composeProperties = {
  accountId: { type: 'string', description: '发信邮箱账号 ID' },
  to: Object.assign({}, addressField, { description: `收件人，${addressField.description}` }),
  cc: Object.assign({}, addressField, { description: `抄送，${addressField.description}` }),
  bcc: Object.assign({}, addressField, { description: `密送，${addressField.description}` }),
  subject: { type: 'string', description: '主题' },
  html: { type: 'string', description: 'HTML 正文' },
  attachments: attachmentsField,
  inReplyTo: { type: 'string', description: '回复的邮件 Message-ID' },
  references: { type: 'array', items: { type: 'string' }, description: 'References 邮件链' },
  headers: { description: '附加邮件头 { 名称: 值 }；保存草稿时不传则保留草稿原有邮件头' }
};

const sendProperties = Object.assign({}, composeProperties, {
  text: { description: '纯文本正文，不传时由 HTML 正文生成' }
});

const sendResponse = success('发送成功返回已发送邮件（folder 为 sent）；被发信前规则改存草稿时不发送，返回 folder 为 draft 的草稿', mail);

module.exports = fp(async (fastify, options) => {
  const { services } = fastify[options.name];

  fastify.get(
    `${options.prefix}/mails`,
    {
      onRequest: options.getAuthenticate('mail'),
      schema: {
        tags: [TAG],
        summary: '邮件列表',
        description: '按文件夹/标签分页获取当前用户邮箱的邮件，按邮件日期倒序；列表不含正文，返回 summary 摘要；perPage 最大 100',
        querystring: pageQuery({
          accountId: { type: 'string', description: '邮箱账号 ID' },
          folder: { type: 'string', enum: ['inbox', 'sent', 'draft', 'trash'], description: '文件夹，默认 inbox' },
          labelId: { type: 'string', description: '标签 ID' },
          keyword: { type: 'string', description: '主题或正文关键词，正文同时匹配纯文本和 HTML' },
          isRead: { type: 'boolean', description: '是否已读' },
          isStarred: { type: 'boolean', description: '是否星标' }
        }),
        response: success('邮件分页列表', page('当前页邮件', mailListItem))
      }
    },
    async request => {
      const { filter, perPage, currentPage } = request.query;
      return await services.mail.list({ filter, perPage: Math.min(perPage, 100), currentPage, userId: userIdOf(request) });
    }
  );

  fastify.get(
    `${options.prefix}/mails/stats`,
    {
      onRequest: options.getAuthenticate('mail'),
      schema: {
        tags: [TAG],
        summary: '文件夹与标签计数',
        description: '返回各文件夹总数/未读数以及收件箱中各标签的总数/未读数',
        querystring: { type: 'object', properties: { accountId: { type: 'string', description: '邮箱账号 ID，不传统计当前用户全部邮箱' } } },
        response: success(
          '计数结果',
          obj('计数结果', {
            folders: obj('各文件夹计数', {
              inbox: obj('收件箱', { total: num('总数'), unread: num('未读数') }),
              sent: obj('已发送', { total: num('总数') }),
              draft: obj('草稿', { total: num('总数') }),
              trash: obj('回收站', { total: num('总数') })
            }),
            labels: arr('可见标签在收件箱中的计数', obj('标签计数', { id: any('标签 ID'), name: str('标签名称'), color: str('标签颜色'), total: num('收件箱中带该标签的邮件数'), unread: num('其中未读数') }))
          })
        )
      }
    },
    async request => await services.mail.folderStats({ accountId: request.query.accountId, userId: userIdOf(request) })
  );

  fastify.get(
    `${options.prefix}/mails/:id`,
    {
      onRequest: options.getAuthenticate('mail'),
      schema: {
        tags: [TAG],
        summary: '邮件详情',
        description: '获取邮件详情（含正文和标签），默认自动标为已读并异步回写 IMAP 已读标记',
        params: idParams,
        querystring: { type: 'object', properties: { markRead: { type: 'boolean', default: true, description: '是否标为已读' } } },
        response: success('邮件详情', mail)
      }
    },
    async request => await services.mail.detail({ id: request.params.id, markRead: request.query.markRead, userId: userIdOf(request) })
  );

  fastify.post(
    `${options.prefix}/mails/:id/attachments/:index/download`,
    {
      onRequest: options.getAuthenticate('mail'),
      schema: {
        tags: [TAG],
        summary: '下载附件',
        description: '收信附件按需下载：首次调用从 IMAP 取回并保存到文件存储，之后直接返回已保存的附件 { id, filename, contentType, size }',
        params: {
          type: 'object',
          required: ['id', 'index'],
          properties: {
            id: { type: 'string', description: '邮件 ID' },
            index: { type: 'integer', minimum: 0, description: '附件在 attachments 中的下标' }
          }
        },
        response: success('已保存到文件存储的附件，id 为文件 ID', attachment)
      }
    },
    async request => await services.mail.downloadAttachment({ id: request.params.id, index: request.params.index, userId: userIdOf(request) })
  );

  fastify.post(
    `${options.prefix}/mails/read`,
    {
      onRequest: options.getAuthenticate('mail'),
      schema: {
        tags: [TAG],
        summary: '设置已读/未读',
        description: '批量设置已读状态，并回写 IMAP 已读标记（options.syncFlagsToServer）',
        body: idsBody({ isRead: { type: 'boolean', default: true, description: '是否已读，默认 true' } }),
        response: empty()
      }
    },
    async request => {
      await services.mail.setRead(Object.assign({}, request.body, { userId: userIdOf(request) }));
      return {};
    }
  );

  fastify.post(
    `${options.prefix}/mails/star`,
    {
      onRequest: options.getAuthenticate('mail'),
      schema: {
        tags: [TAG],
        summary: '设置星标',
        description: '批量设置星标',
        body: idsBody({ isStarred: { type: 'boolean', default: true, description: '是否星标，默认 true' } }),
        response: empty()
      }
    },
    async request => {
      await services.mail.setStar(Object.assign({}, request.body, { userId: userIdOf(request) }));
      return {};
    }
  );

  fastify.put(
    `${options.prefix}/mails/:id/labels`,
    {
      onRequest: options.getAuthenticate('mail'),
      schema: {
        tags: [TAG],
        summary: '设置邮件标签',
        description: '用传入的标签覆盖邮件现有标签；不可见或不属于该邮箱的标签会被忽略',
        params: idParams,
        body: { type: 'object', required: ['labelIds'], properties: { labelIds: { type: 'array', items: { type: 'string' }, description: '标签 ID 列表，传空数组清空标签' } } },
        response: success('设置后的邮件详情', mail)
      }
    },
    async request => await services.mail.setLabels({ id: request.params.id, labelIds: request.body.labelIds, userId: userIdOf(request) })
  );

  fastify.post(
    `${options.prefix}/mails/trash`,
    {
      onRequest: options.getAuthenticate('mail'),
      schema: { tags: [TAG], summary: '移入回收站', description: '批量移入回收站，并把收件箱邮件移入服务器回收站（options.syncFlagsToServer）', body: idsBody(), response: empty() }
    },
    async request => {
      await services.mail.moveToTrash(Object.assign({}, request.body, { userId: userIdOf(request) }));
      return {};
    }
  );

  fastify.post(
    `${options.prefix}/mails/restore`,
    {
      onRequest: options.getAuthenticate('mail'),
      schema: { tags: [TAG], summary: '从回收站恢复', description: '恢复到移入回收站前的文件夹（不回写服务器）', body: idsBody(), response: empty() }
    },
    async request => {
      await services.mail.restore(Object.assign({}, request.body, { userId: userIdOf(request) }));
      return {};
    }
  );

  fastify.post(
    `${options.prefix}/mails/remove`,
    {
      onRequest: options.getAuthenticate('mail'),
      schema: { tags: [TAG], summary: '彻底删除邮件', description: '批量删除邮件（仅删除本地记录，不影响邮件服务器）', body: idsBody(), response: empty() }
    },
    async request => {
      await services.mail.remove(Object.assign({}, request.body, { userId: userIdOf(request) }));
      return {};
    }
  );

  fastify.post(
    `${options.prefix}/mails/send`,
    {
      onRequest: options.getAuthenticate('mail:send'),
      schema: {
        tags: [TAG],
        summary: '发送邮件',
        description: '通过指定邮箱的 SMTP 发送邮件：依次执行 beforeSend 钩子、发信前规则（可拦截、修改或改存草稿）、发送、存入已发送、发信后规则和 afterSend 钩子',
        body: { type: 'object', required: ['accountId', 'to'], properties: sendProperties },
        response: sendResponse
      }
    },
    async request => await services.mail.send(Object.assign({}, request.body, { userId: userIdOf(request) }))
  );

  fastify.post(
    `${options.prefix}/drafts`,
    {
      onRequest: options.getAuthenticate('mail:send'),
      schema: {
        tags: [DRAFT_TAG],
        summary: '新建草稿',
        description: '保存为草稿（folder 为 draft），纯文本正文由 HTML 生成',
        body: { type: 'object', required: ['accountId'], properties: composeProperties },
        response: success('新建的草稿', mail)
      }
    },
    async request => await services.draft.save(Object.assign({}, request.body, { userId: userIdOf(request) }))
  );

  fastify.put(
    `${options.prefix}/drafts/:id`,
    {
      onRequest: options.getAuthenticate('mail:send'),
      schema: {
        tags: [DRAFT_TAG],
        summary: '保存草稿',
        description: '用传入内容整体覆盖草稿（未传的收件人、主题、正文等会被清空）',
        params: idParams,
        body: { type: 'object', required: ['accountId'], properties: composeProperties },
        response: success('保存后的草稿', mail)
      }
    },
    async request => await services.draft.save(Object.assign({}, request.body, { id: request.params.id, userId: userIdOf(request) }))
  );

  fastify.delete(
    `${options.prefix}/drafts/:id`,
    {
      onRequest: options.getAuthenticate('mail:send'),
      schema: { tags: [DRAFT_TAG], summary: '删除草稿', description: '删除草稿', params: idParams, response: empty() }
    },
    async request => {
      await services.draft.remove({ id: request.params.id, userId: userIdOf(request) });
      return {};
    }
  );

  fastify.post(
    `${options.prefix}/drafts/:id/send`,
    {
      onRequest: options.getAuthenticate('mail:send'),
      schema: {
        tags: [DRAFT_TAG],
        summary: '发送草稿',
        description: '发送草稿，成功后草稿转为已发送；body 中传入任意字段时会先按保存草稿的规则整体保存再发送（此时须传 accountId）',
        params: idParams,
        body: { type: 'object', properties: composeProperties },
        response: sendResponse
      }
    },
    async request => await services.draft.send(Object.assign({}, request.body, { id: request.params.id, userId: userIdOf(request) }))
  );
});
