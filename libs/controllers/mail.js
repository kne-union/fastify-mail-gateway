const fp = require('fastify-plugin');
const { idParams, idsBody, pageQuery, addressField, attachmentsField } = require('../utils/schema');
const { userIdOf } = require('../utils/owner');

const composeProperties = {
  accountId: { type: 'string', description: '发信邮箱账号 ID' },
  to: addressField,
  cc: addressField,
  bcc: addressField,
  subject: { type: 'string', description: '主题' },
  html: { type: 'string', description: 'HTML 正文' },
  attachments: attachmentsField,
  inReplyTo: { type: 'string', description: '回复的邮件 Message-ID' },
  references: { type: 'array', items: { type: 'string' }, description: 'References 邮件链' }
};

module.exports = fp(async (fastify, options) => {
  const { services } = fastify[options.name];

  fastify.get(
    `${options.prefix}/mails`,
    {
      onRequest: options.getAuthenticate('mail'),
      schema: {
        summary: '邮件列表',
        description: '按文件夹/标签分页获取邮件，列表不含正文，返回 summary 摘要',
        querystring: pageQuery({
          accountId: { type: 'string', description: '邮箱账号 ID' },
          folder: { type: 'string', enum: ['inbox', 'sent', 'draft', 'trash'], description: '文件夹，默认 inbox' },
          labelId: { type: 'string', description: '标签 ID' },
          keyword: { type: 'string', description: '主题或正文关键词，正文同时匹配纯文本和 HTML' },
          isRead: { type: 'boolean', description: '是否已读' },
          isStarred: { type: 'boolean', description: '是否星标' }
        })
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
        summary: '文件夹与标签计数',
        description: '返回各文件夹总数/未读数以及收件箱中各标签的总数/未读数',
        querystring: { type: 'object', properties: { accountId: { type: 'string', description: '邮箱账号 ID' } } }
      }
    },
    async request => await services.mail.folderStats({ accountId: request.query.accountId, userId: userIdOf(request) })
  );

  fastify.get(
    `${options.prefix}/mails/:id`,
    {
      onRequest: options.getAuthenticate('mail'),
      schema: {
        summary: '邮件详情',
        description: '获取邮件详情，默认自动标为已读',
        params: idParams,
        querystring: { type: 'object', properties: { markRead: { type: 'boolean', default: true, description: '是否标为已读' } } }
      }
    },
    async request => await services.mail.detail({ id: request.params.id, markRead: request.query.markRead, userId: userIdOf(request) })
  );

  fastify.post(
    `${options.prefix}/mails/:id/attachments/:index/download`,
    {
      onRequest: options.getAuthenticate('mail'),
      schema: {
        summary: '下载附件',
        description: '收信附件按需下载：首次调用从 IMAP 取回并保存到文件存储，之后直接返回已保存的附件 { id, filename, contentType, size }',
        params: {
          type: 'object',
          required: ['id', 'index'],
          properties: {
            id: { type: 'string', description: '邮件 ID' },
            index: { type: 'integer', minimum: 0, description: '附件在 attachments 中的下标' }
          }
        }
      }
    },
    async request => await services.mail.downloadAttachment({ id: request.params.id, index: request.params.index, userId: userIdOf(request) })
  );

  fastify.post(
    `${options.prefix}/mails/read`,
    {
      onRequest: options.getAuthenticate('mail'),
      schema: { summary: '设置已读/未读', description: '批量设置已读状态', body: idsBody({ isRead: { type: 'boolean', default: true } }) }
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
      schema: { summary: '设置星标', description: '批量设置星标', body: idsBody({ isStarred: { type: 'boolean', default: true } }) }
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
        summary: '设置邮件标签',
        description: '用传入的标签覆盖邮件现有标签',
        params: idParams,
        body: { type: 'object', required: ['labelIds'], properties: { labelIds: { type: 'array', items: { type: 'string' } } } }
      }
    },
    async request => await services.mail.setLabels({ id: request.params.id, labelIds: request.body.labelIds, userId: userIdOf(request) })
  );

  fastify.post(
    `${options.prefix}/mails/trash`,
    {
      onRequest: options.getAuthenticate('mail'),
      schema: { summary: '移入回收站', description: '批量移入回收站', body: idsBody() }
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
      schema: { summary: '从回收站恢复', description: '恢复到移入回收站前的文件夹', body: idsBody() }
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
      schema: { summary: '彻底删除邮件', description: '批量删除邮件（仅删除本地记录，不影响邮件服务器）', body: idsBody() }
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
        summary: '发送邮件',
        description: '通过指定邮箱的 SMTP 发送邮件，并存入已发送、执行发信规则',
        body: { type: 'object', required: ['accountId', 'to'], properties: composeProperties }
      }
    },
    async request => await services.mail.send(Object.assign({}, request.body, { userId: userIdOf(request) }))
  );

  fastify.post(
    `${options.prefix}/drafts`,
    {
      onRequest: options.getAuthenticate('mail:send'),
      schema: { summary: '新建草稿', description: '保存为草稿', body: { type: 'object', required: ['accountId'], properties: composeProperties } }
    },
    async request => await services.draft.save(Object.assign({}, request.body, { userId: userIdOf(request) }))
  );

  fastify.put(
    `${options.prefix}/drafts/:id`,
    {
      onRequest: options.getAuthenticate('mail:send'),
      schema: { summary: '保存草稿', description: '更新草稿内容', params: idParams, body: { type: 'object', required: ['accountId'], properties: composeProperties } }
    },
    async request => await services.draft.save(Object.assign({}, request.body, { id: request.params.id, userId: userIdOf(request) }))
  );

  fastify.delete(
    `${options.prefix}/drafts/:id`,
    {
      onRequest: options.getAuthenticate('mail:send'),
      schema: { summary: '删除草稿', description: '删除草稿', params: idParams }
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
      schema: { summary: '发送草稿', description: '发送草稿；body 中传入的字段会先保存到草稿再发送', params: idParams, body: { type: 'object', properties: composeProperties } }
    },
    async request => await services.draft.send(Object.assign({}, request.body, { id: request.params.id, userId: userIdOf(request) }))
  );
});
