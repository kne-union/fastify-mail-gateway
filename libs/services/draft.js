const fp = require('fastify-plugin');
const { normalizeAddressList } = require('../utils/address');
const { stripHtml } = require('../utils/condition');
const { createError } = require('../utils/error');

module.exports = fp(async (fastify, options) => {
  const { models, services } = fastify[options.name];

  const getDraft = async ({ id, userId }) => {
    const draft = await models.mail.findOne({ where: { id, folder: 'draft' } });
    if (!draft) {
      throw createError('草稿不存在', 404);
    }
    if (userId != null && userId !== '') {
      const account = await models.account.findOne({ where: { id: draft.accountId, userId } });
      if (!account) {
        throw createError('草稿不存在', 404);
      }
    }
    return draft;
  };

  /**
   * 保存草稿：不传 id 新建，传 id 更新
   */
  const save = async ({ id, accountId, to, cc, bcc, subject, html, attachments, inReplyTo, references, headers, userId }) => {
    const account = await services.account.detail({ id: accountId, userId });
    const data = {
      accountId,
      folder: 'draft',
      isRead: true,
      from: [{ name: account.name, address: account.address }],
      to: normalizeAddressList(to),
      cc: normalizeAddressList(cc),
      bcc: normalizeAddressList(bcc),
      subject: subject || '',
      html: html || '',
      text: html ? stripHtml(html).replace(/\s+/g, ' ').trim() : '',
      attachments: attachments || [],
      inReplyTo: inReplyTo || null,
      references: references ? [].concat(references) : null,
      date: new Date()
    };
    // 规则存入的草稿会带标记头（如已翻译），前端编辑保存不传 headers 时保留
    if (headers !== undefined) {
      data.headers = headers;
    }
    if (id) {
      const draft = await getDraft({ id, userId });
      await draft.update(data);
      return draft;
    }
    return await models.mail.create(data);
  };

  const remove = async ({ id, userId }) => {
    const draft = await getDraft({ id, userId });
    await draft.destroy();
  };

  /**
   * 发送草稿；可同时传入最新的邮件字段，先保存再发送
   */
  const send = async ({ id, userId, ...data }) => {
    const draft = Object.keys(data).length > 0 ? await save(Object.assign({ id, userId }, data)) : await getDraft({ id, userId });
    return await services.mail.send({
      userId,
      accountId: draft.accountId,
      to: draft.to,
      cc: draft.cc,
      bcc: draft.bcc,
      subject: draft.subject,
      html: draft.html,
      attachments: draft.attachments,
      inReplyTo: draft.inReplyTo,
      references: draft.references,
      headers: draft.headers || undefined,
      draftId: draft.id
    });
  };

  services.draft = { save, remove, send };
});
