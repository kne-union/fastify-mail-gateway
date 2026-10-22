const fp = require('fastify-plugin');
const escape = require('lodash/escape');
const { normalizeAddressList } = require('../utils/address');
const { stripHtml } = require('../utils/condition');
const { createError } = require('../utils/error');
const { isSystemLevel, sameUser } = require('../utils/owner');

const requireUser = userId => {
  if (userId == null || userId === '') {
    throw createError('未登录', 401);
  }
  return userId;
};

const SUMMARY_LENGTH = 120;

module.exports = fp(async (fastify, options) => {
  const { models, services } = fastify[options.name];
  const { Op } = fastify.sequelize.Sequelize;
  const sequelize = fastify.sequelize.instance;

  const likeOp = () => (sequelize.getDialect() === 'postgres' ? Op.iLike : Op.like);

  const labelInclude = () => ({ model: models.label, as: 'labels', attributes: ['id', 'name', 'color'], through: { attributes: [] } });

  const toListItem = mail => {
    const plain = mail.get({ plain: true });
    const summary = (plain.text || stripHtml(plain.html)).replace(/\s+/g, ' ').trim().slice(0, SUMMARY_LENGTH);
    delete plain.text;
    delete plain.html;
    return Object.assign(plain, { summary });
  };

  const ownedAccountIds = async userId => {
    const rows = await models.account.findAll({ where: { userId: requireUser(userId) }, attributes: ['id'], raw: true });
    return rows.map(item => item.id);
  };

  const scopeAccounts = async ({ accountId, userId }) => {
    const ids = await ownedAccountIds(userId);
    if (accountId) {
      if (!ids.map(String).includes(String(accountId))) {
        throw createError('邮箱账号不存在', 404);
      }
      return accountId;
    }
    return ids;
  };

  const getMailIdsByLabel = async (labelId, userId) => {
    const label = await models.label.findOne({ where: { id: labelId, [Op.or]: [{ userId }, { level: 0 }] } });
    if (!label) {
      return [];
    }
    const rows = await models.mailLabel.findAll({ where: { labelId }, attributes: ['mailId'], raw: true });
    return rows.map(item => item.mailId);
  };

  const list = async ({ filter = {}, perPage = 20, currentPage = 1, userId } = {}) => {
    const scoped = await scopeAccounts({ accountId: filter.accountId, userId });
    if (Array.isArray(scoped) && scoped.length === 0) {
      return { pageData: [], totalCount: 0 };
    }
    const where = { folder: filter.folder || 'inbox', accountId: Array.isArray(scoped) ? { [Op.in]: scoped } : scoped };
    if (filter.isRead != null && filter.isRead !== '') {
      where.isRead = filter.isRead === true || filter.isRead === 'true';
    }
    if (filter.isStarred != null && filter.isStarred !== '') {
      where.isStarred = filter.isStarred === true || filter.isStarred === 'true';
    }
    if (filter.keyword) {
      const op = likeOp();
      const pattern = `%${filter.keyword}%`;
      where[Op.or] = [{ subject: { [op]: pattern } }, { text: { [op]: pattern } }, { html: { [op]: pattern } }];
    }
    if (filter.labelId) {
      const mailIds = await getMailIdsByLabel(filter.labelId, userId);
      where.id = { [Op.in]: mailIds.length > 0 ? mailIds : ['0'] };
    }
    const { rows, count } = await models.mail.findAndCountAll({
      where,
      attributes: { exclude: ['headers', 'references'] },
      include: [labelInclude()],
      distinct: true,
      offset: perPage * (currentPage - 1),
      limit: perPage,
      order: [
        ['date', 'DESC'],
        ['createdAt', 'DESC']
      ]
    });
    return { pageData: rows.map(toListItem), totalCount: count };
  };

  const getInstance = async ({ id, userId }) => {
    const mail = await models.mail.findByPk(id, { include: [labelInclude()] });
    if (!mail) {
      throw createError('邮件不存在', 404);
    }
    if (userId != null && userId !== '') {
      const account = await models.account.findOne({ where: { id: mail.accountId, userId } });
      if (!account) {
        throw createError('邮件不存在', 404);
      }
    }
    return mail;
  };

  const detail = async ({ id, markRead = true, userId }) => {
    const mail = await getInstance({ id, userId: requireUser(userId) });
    if (markRead && !mail.isRead) {
      mail.isRead = true;
      await mail.save();
      // 打开邮件不等待服务器回写，避免拖慢详情接口
      services.imapSync.setSeen({ mails: [mail], seen: true });
    }
    return mail;
  };

  const assertOwnedMails = async ({ ids, userId }) => {
    const uniqueIds = [
      ...new Set(
        []
          .concat(ids || [])
          .filter(Boolean)
          .map(String)
      )
    ];
    const list = uniqueIds.length === 0 ? [] : await models.mail.findAll({ where: { id: uniqueIds } });
    if (list.length !== uniqueIds.length) {
      throw createError('邮件不存在', 404);
    }
    const accountIds = [...new Set(list.map(item => String(item.accountId)))];
    const owned = await models.account.findAll({ where: { id: accountIds, userId: requireUser(userId) }, attributes: ['id'], raw: true });
    if (owned.length !== accountIds.length) {
      throw createError('邮件不存在', 404);
    }
    return list;
  };

  const setRead = async ({ ids, isRead = true, userId }) => {
    const mails = await assertOwnedMails({ ids, userId });
    await models.mail.update({ isRead }, { where: { id: ids } });
    await services.imapSync.setSeen({ mails: mails.filter(mail => !!mail.isRead !== !!isRead), seen: isRead });
  };

  const setStar = async ({ ids, isStarred = true, userId }) => {
    await assertOwnedMails({ ids, userId });
    await models.mail.update({ isStarred }, { where: { id: ids } });
  };

  const allowedLabelIds = async ({ mail, labelIds }) => {
    const account = await models.account.findByPk(mail.accountId);
    const labels = await models.label.findAll({ where: { id: labelIds } });
    return labels
      .filter(label => {
        const visible = isSystemLevel(label) || sameUser(label.userId, account && account.userId);
        const accountOk = !label.accountId || String(label.accountId) === String(mail.accountId);
        return visible && accountOk;
      })
      .map(label => String(label.id));
  };

  const addLabels = async ({ id, labelIds }) => {
    const mail = await models.mail.findByPk(id);
    if (!mail) {
      throw createError('邮件不存在', 404);
    }
    const allowed = await allowedLabelIds({ mail, labelIds });
    const exists = (await models.mailLabel.findAll({ where: { mailId: id }, attributes: ['labelId'], raw: true })).map(item => String(item.labelId));
    const target = allowed.filter(labelId => !exists.includes(labelId));
    if (target.length > 0) {
      await models.mailLabel.bulkCreate(target.map(labelId => ({ mailId: id, labelId })));
    }
  };

  const removeLabels = async ({ id, labelIds }) => {
    const mail = await models.mail.findByPk(id);
    if (!mail) {
      throw createError('邮件不存在', 404);
    }
    const allowed = await allowedLabelIds({ mail, labelIds });
    if (allowed.length === 0) {
      return;
    }
    await models.mailLabel.destroy({ where: { mailId: id, labelId: allowed } });
  };

  const setLabels = async ({ id, labelIds = [], userId }) => {
    const mail = await getInstance({ id, userId: requireUser(userId) });
    await models.mailLabel.destroy({ where: { mailId: id } });
    await addLabels({ id, labelIds });
    return await getInstance({ id, userId });
  };

  const moveToTrash = async ({ ids, userId }) => {
    await assertOwnedMails({ ids, userId });
    const mails = await models.mail.findAll({ where: { id: ids, folder: { [Op.ne]: 'trash' } } });
    const serverMails = mails.map(mail => mail.get({ plain: true }));
    for (const mail of mails) {
      mail.originFolder = mail.folder;
      mail.folder = 'trash';
      await mail.save();
    }
    // 从回收站还原不回写服务器：邮件在服务器上移动后 uid 已变化
    await services.imapSync.moveToTrash({ mails: serverMails });
  };

  const restore = async ({ ids, userId }) => {
    await assertOwnedMails({ ids, userId });
    const mails = await models.mail.findAll({ where: { id: ids, folder: 'trash' } });
    for (const mail of mails) {
      mail.folder = mail.originFolder || 'inbox';
      mail.originFolder = null;
      await mail.save();
    }
  };

  const remove = async ({ ids, userId }) => {
    await assertOwnedMails({ ids, userId });
    await models.mailLabel.destroy({ where: { mailId: ids } });
    await models.mail.destroy({ where: { id: ids } });
  };

  /**
   * 文件夹与标签的计数，供前端侧栏显示：标签只统计收件箱中的邮件
   */
  const folderStats = async ({ accountId, userId } = {}) => {
    const scoped = await scopeAccounts({ accountId, userId });
    if (Array.isArray(scoped) && scoped.length === 0) {
      return {
        folders: { inbox: { total: 0, unread: 0 }, sent: { total: 0 }, draft: { total: 0 }, trash: { total: 0 } },
        labels: []
      };
    }
    const base = Array.isArray(scoped) ? { accountId: { [Op.in]: scoped } } : { accountId: scoped };
    const [inboxTotal, inboxUnread, sent, draft, trash] = await Promise.all([
      models.mail.count({ where: Object.assign({ folder: 'inbox' }, base) }),
      models.mail.count({ where: Object.assign({ folder: 'inbox', isRead: false }, base) }),
      models.mail.count({ where: Object.assign({ folder: 'sent' }, base) }),
      models.mail.count({ where: Object.assign({ folder: 'draft' }, base) }),
      models.mail.count({ where: Object.assign({ folder: 'trash' }, base) })
    ]);
    const labels = await services.label.list({ accountId, userId });
    const labelStats = await Promise.all(
      labels.map(async label => {
        const include = [{ model: models.mailLabel, as: 'mailLabels', where: { labelId: label.id }, attributes: [], required: true }];
        const [total, unread] = await Promise.all([
          models.mail.count({ where: Object.assign({ folder: 'inbox' }, base), include, distinct: true }),
          models.mail.count({ where: Object.assign({ folder: 'inbox', isRead: false }, base), include, distinct: true })
        ]);
        return { id: label.id, name: label.name, color: label.color, total, unread };
      })
    );
    return {
      folders: {
        inbox: { total: inboxTotal, unread: inboxUnread },
        sent: { total: sent },
        draft: { total: draft },
        trash: { total: trash }
      },
      labels: labelStats
    };
  };

  const isAttachmentReady = attachment => !!(attachment && (attachment.id || attachment.url));

  const findSourceAttachment = (list, target, index) => {
    const sameFile = item => (item.filename || 'attachment') === target.filename && (target.size == null || item.size === target.size);
    const matches = item => !!item && (target.checksum ? item.checksum === target.checksum : sameFile(item));
    return matches(list[index]) ? list[index] : list.find(matches);
  };

  const pendingDownloads = new Map();

  /**
   * 收信附件按需下载：首次调用时从 IMAP 取回原邮件、上传到文件存储并记录文件 id，之后直接返回已保存的附件
   */
  const downloadAttachment = async ({ id, index, userId }) => {
    const key = `${id}:${index}`;
    if (pendingDownloads.has(key)) {
      return await pendingDownloads.get(key);
    }
    const task = (async () => {
      const mail = await getInstance({ id, userId: requireUser(userId) });
      const attachment = (mail.attachments || [])[index];
      if (!attachment) {
        throw createError('附件不存在', 404);
      }
      if (isAttachmentReady(attachment)) {
        return attachment;
      }
      if (mail.uid == null) {
        throw createError(`附件无法下载: ${attachment.filename}`);
      }
      if (typeof options.uploadAttachment !== 'function') {
        throw createError('未配置附件存储 options.uploadAttachment');
      }
      const account = await services.account.getWithPassword({ id: mail.accountId });
      const parsed = await services.sync.fetchMessage({ account, uid: mail.uid, messageId: mail.messageId });
      const source = findSourceAttachment(parsed.attachments || [], attachment, index);
      if (!source) {
        throw createError(`邮件服务器上找不到附件: ${attachment.filename}`, 404);
      }
      const uploaded = await options.uploadAttachment({ filename: attachment.filename, contentType: attachment.contentType, content: source.content });
      if (!uploaded || !uploaded.id) {
        throw createError(`附件保存失败: ${attachment.filename}`);
      }
      // 重新读取再写入，避免覆盖同一封邮件其它附件并发下载的结果
      const latest = await models.mail.findByPk(id);
      const attachments = [...(latest.attachments || [])];
      attachments[index] = Object.assign({}, attachments[index], { id: uploaded.id, error: undefined });
      latest.attachments = attachments;
      latest.changed('attachments', true);
      await latest.save();
      return attachments[index];
    })();
    pendingDownloads.set(key, task);
    try {
      return await task;
    } finally {
      pendingDownloads.delete(key);
    }
  };

  // 转发 / 回复时引用的收信附件可能还没下载过：传 { mailId, index } 的附件先下载再发送
  const prepareAttachments = async (attachments, userId) => {
    const result = [];
    for (const attachment of attachments || []) {
      if (!isAttachmentReady(attachment) && attachment.mailId != null && attachment.index != null) {
        result.push(await downloadAttachment({ id: attachment.mailId, index: Number(attachment.index), userId }));
      } else {
        result.push(attachment);
      }
    }
    return result;
  };

  const resolveAttachments = async attachments => {
    const result = [];
    for (const attachment of attachments || []) {
      const resolved = typeof options.resolveAttachment === 'function' ? await options.resolveAttachment(attachment) : null;
      if (!resolved) {
        throw createError(`附件无法读取: ${attachment.filename || attachment.id}`);
      }
      result.push(resolved);
    }
    return result;
  };

  const buildReferences = (references, inReplyTo) => {
    const list = [].concat(references || []).filter(Boolean);
    if (inReplyTo && !list.includes(inReplyTo)) {
      list.push(inReplyTo);
    }
    return list.length > 0 ? list : null;
  };

  const toHeaderRecord = headers => Object.fromEntries(Object.entries(headers || {}).map(([key, value]) => [key.toLowerCase(), String(value)]));

  // 发信前规则看到的邮件：与入库记录同构，便于复用条件求值与动作
  const toOutgoingMail = ({ mailOptions, account, attachments, draftId }) => ({
    id: draftId || null,
    accountId: account.id,
    folder: 'sent',
    from: [{ name: account.name, address: account.address }],
    to: normalizeAddressList(mailOptions.to),
    cc: normalizeAddressList(mailOptions.cc),
    bcc: normalizeAddressList(mailOptions.bcc),
    subject: mailOptions.subject,
    html: mailOptions.html || '',
    text: mailOptions.text || '',
    attachments: (attachments || []).map(({ id, filename, contentType, size, url }) => ({ id, filename, contentType, size, url })),
    headers: toHeaderRecord(mailOptions.headers),
    inReplyTo: mailOptions.inReplyTo || null,
    references: mailOptions.references || null,
    date: new Date()
  });

  // 把发信前规则修改后的邮件写回 mailOptions；只改了 html 时同步重算纯文本
  const applyOutgoingMail = (mailOptions, outgoing, original) => {
    const htmlChanged = outgoing.html !== original.html;
    const textChanged = outgoing.text !== original.text;
    const headersChanged = outgoing.headers !== original.headers;
    const recipientsChanged = ['to', 'cc', 'bcc'].some(key => outgoing[key] !== original[key]);
    if (recipientsChanged && normalizeAddressList(outgoing.to).length === 0) {
      throw createError('发信前规则修改后收件人为空');
    }
    return Object.assign({}, mailOptions, {
      to: normalizeAddressList(outgoing.to),
      cc: normalizeAddressList(outgoing.cc),
      bcc: normalizeAddressList(outgoing.bcc),
      subject: outgoing.subject || '',
      html: outgoing.html || undefined,
      text: textChanged ? outgoing.text || '' : htmlChanged ? stripHtml(outgoing.html).replace(/\s+/g, ' ').trim() : mailOptions.text,
      headers: headersChanged ? Object.assign({}, mailOptions.headers, outgoing.headers) : mailOptions.headers
    });
  };

  /**
   * 发送邮件：beforeSend 钩子 → 发信前规则（可拦截 / 修改 / 改存草稿）→ SMTP 发送 → 存入已发送 → 发信后规则 → afterSend 钩子；
   * 被规则改存草稿时不发送，返回 folder 为 draft 的草稿
   * 传 draftId 时把草稿转为已发送；skipRules 用于自动回复/转发等规则内发信，避免规则循环触发
   */
  const send = async ({ accountId, to, cc, bcc, subject, html, text, attachments = [], inReplyTo, references, headers, draftId, skipRules = false, userId }) => {
    const account = await services.account.getWithPassword({ id: accountId, userId });
    if (account.status !== 'enabled') {
      throw createError('邮箱账号已停用，无法发送邮件');
    }
    const toList = normalizeAddressList(to);
    if (toList.length === 0) {
      throw createError('收件人不能为空');
    }
    const ccList = normalizeAddressList(cc);
    const bccList = normalizeAddressList(bcc);
    const referenceList = buildReferences(references, inReplyTo);
    attachments = await prepareAttachments(attachments, userId);
    let mailOptions = {
      from: { name: account.name, address: account.address },
      to: toList,
      cc: ccList,
      bcc: bccList,
      subject: subject || '',
      html: html || undefined,
      text: text || (html ? stripHtml(html).replace(/\s+/g, ' ').trim() : ''),
      attachments: await resolveAttachments(attachments),
      inReplyTo: inReplyTo || undefined,
      references: referenceList || undefined,
      headers: headers || undefined
    };

    if (typeof options.beforeSend === 'function') {
      const result = await options.beforeSend({ mailOptions, account, fastify });
      if (result === false) {
        throw createError('邮件发送被 beforeSend 拦截');
      }
      if (result && typeof result === 'object') {
        mailOptions = result;
      }
    }

    let beforeSendLogIds = [];
    if (!skipRules) {
      const outgoing = toOutgoingMail({ mailOptions, account, attachments, draftId });
      const { mail: modified, logIds, draft: toDraft } = await services.pipeline.beforeSend({ mail: outgoing, account });
      mailOptions = applyOutgoingMail(mailOptions, modified, outgoing);
      beforeSendLogIds = logIds;
      // 发信前规则要求改存草稿：不发送，保存修改后的邮件（folder 为 draft），用户核对后手动发送
      if (toDraft) {
        const saved = await services.draft.save({
          id: draftId,
          accountId,
          to: mailOptions.to,
          cc: mailOptions.cc,
          bcc: mailOptions.bcc,
          subject: mailOptions.subject,
          html: mailOptions.html || escape(mailOptions.text || '').replace(/\n/g, '<br/>'),
          attachments,
          inReplyTo,
          references: referenceList,
          headers: toHeaderRecord(mailOptions.headers),
          userId: account.userId
        });
        if (beforeSendLogIds.length > 0) {
          await models.ruleLog.update({ mailId: saved.id }, { where: { id: beforeSendLogIds } });
        }
        return saved;
      }
    }

    const transport = services.account.createTransport(services.account.toConnectionConfig(account));
    let info;
    try {
      info = await transport.sendMail(mailOptions);
    } finally {
      transport.close && transport.close();
    }

    const record = {
      accountId,
      folder: 'sent',
      isRead: true,
      messageId: (info && info.messageId) || null,
      inReplyTo: inReplyTo || null,
      references: referenceList,
      from: [{ name: account.name, address: account.address }],
      to: normalizeAddressList(mailOptions.to),
      cc: normalizeAddressList(mailOptions.cc),
      bcc: normalizeAddressList(mailOptions.bcc),
      subject: mailOptions.subject,
      html: mailOptions.html || '',
      text: mailOptions.text || '',
      date: new Date(),
      attachments: (attachments || []).map(({ id, filename, contentType, size, url }) => ({ id, filename, contentType, size, url })),
      headers: toHeaderRecord(mailOptions.headers)
    };

    let mail;
    const draft = draftId ? await models.mail.findOne({ where: { id: draftId, folder: 'draft', accountId: account.id } }) : null;
    if (draftId && !draft) {
      throw createError('草稿不存在', 404);
    }
    if (draft) {
      await draft.update(record);
      mail = draft;
    } else {
      mail = await models.mail.create(record);
    }

    if (beforeSendLogIds.length > 0) {
      await models.ruleLog.update({ mailId: mail.id }, { where: { id: beforeSendLogIds } });
    }

    if (!skipRules) {
      await services.pipeline.dispatch({ direction: 'send', mail, account });
    }

    if (typeof options.afterSend === 'function') {
      try {
        await options.afterSend({ mail, info, account, fastify });
      } catch (e) {
        fastify.log.error(e, '[fastify-mail-gateway] afterSend 执行失败');
      }
    }

    return mail;
  };

  services.mail = {
    list,
    detail,
    getInstance,
    setRead,
    setStar,
    addLabels,
    removeLabels,
    setLabels,
    moveToTrash,
    restore,
    remove,
    folderStats,
    downloadAttachment,
    send
  };
});
