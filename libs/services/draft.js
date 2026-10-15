const fp = require('fastify-plugin');
const { normalizeAddressList } = require('../utils/address');
const { stripHtml } = require('../utils/condition');
const { createError } = require('../utils/error');

module.exports = fp(async (fastify, options) => {
  const { models, services } = fastify[options.name];

  const getDraft = async ({ id }) => {
    const draft = await models.mail.findOne({ where: { id, folder: 'draft' } });
    if (!draft) {
      throw createError('草稿不存在', 404);
    }
    return draft;
  };

  /**
   * 保存草稿：不传 id 新建，传 id 更新
   */
  const save = async ({ id, accountId, to, cc, bcc, subject, html, attachments, inReplyTo, references }) => {
    const account = await services.account.detail({ id: accountId });
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
    if (id) {
      const draft = await getDraft({ id });
      await draft.update(data);
      return draft;
    }
    return await models.mail.create(data);
  };

  const remove = async ({ id }) => {
    const draft = await getDraft({ id });
    await draft.destroy();
  };

  /**
   * 发送草稿；可同时传入最新的邮件字段，先保存再发送
   */
  const send = async ({ id, ...data }) => {
    const draft = Object.keys(data).length > 0 ? await save(Object.assign({ id }, data)) : await getDraft({ id });
    return await services.mail.send({
      accountId: draft.accountId,
      to: draft.to,
      cc: draft.cc,
      bcc: draft.bcc,
      subject: draft.subject,
      html: draft.html,
      attachments: draft.attachments,
      inReplyTo: draft.inReplyTo,
      references: draft.references,
      draftId: draft.id
    });
  };

  services.draft = { save, remove, send };
});
