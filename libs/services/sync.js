const fp = require('fastify-plugin');
const { simpleParser } = require('mailparser');
const { normalizeAddressList } = require('../utils/address');
const { createError } = require('../utils/error');

const PICK_HEADERS = ['auto-submitted', 'precedence', 'list-id', 'list-unsubscribe', 'x-auto-response-suppress', 'reply-to', 'return-path'];

const headerToString = value => {
  if (value == null) {
    return null;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (value.text) {
    return value.text;
  }
  if (value.value != null) {
    return typeof value.value === 'string' ? value.value : JSON.stringify(value.value);
  }
  return JSON.stringify(value);
};

module.exports = fp(async (fastify, options) => {
  const { models, services } = fastify[options.name];
  const syncingAccounts = new Set();

  const pickHeaders = headers => {
    const result = {};
    PICK_HEADERS.forEach(key => {
      if (headers && headers.has(key)) {
        result[key] = headerToString(headers.get(key));
      }
    });
    return result;
  };

  // 同步时只记录附件元数据，内容在首次查看时由 services.mail.downloadAttachment 从 IMAP 取回并上传
  const toAttachmentMeta = attachments =>
    (attachments || []).map(attachment => ({
      filename: attachment.filename || 'attachment',
      contentType: attachment.contentType,
      size: attachment.size,
      cid: attachment.cid || null,
      checksum: attachment.checksum || null
    }));

  /**
   * 把 IMAP 拉到的原始邮件解析并写入收件箱，按 Message-ID 去重；返回新建的邮件，重复则返回 null
   */
  const saveRawMail = async ({ account, uid, source, size }) => {
    const parsed = await simpleParser(source);
    if (parsed.messageId) {
      const exists = await models.mail.findOne({ where: { accountId: account.id, folder: 'inbox', messageId: parsed.messageId }, attributes: ['id'] });
      if (exists) {
        return null;
      }
    }
    const references = parsed.references ? [].concat(parsed.references) : null;
    return await models.mail.create({
      accountId: account.id,
      folder: 'inbox',
      uid,
      messageId: parsed.messageId || null,
      inReplyTo: parsed.inReplyTo || null,
      references,
      from: normalizeAddressList(parsed.from),
      to: normalizeAddressList(parsed.to),
      cc: normalizeAddressList(parsed.cc),
      subject: parsed.subject || '',
      html: parsed.html || parsed.textAsHtml || '',
      text: parsed.text || '',
      date: parsed.date || new Date(),
      attachments: toAttachmentMeta(parsed.attachments),
      headers: pickHeaders(parsed.headers),
      size: size || (source ? source.length : 0)
    });
  };

  const fetchNewMessages = async ({ account }) => {
    const client = services.account.createImapClient(services.account.toConnectionConfig(account));
    await client.connect();
    try {
      const lock = await client.getMailboxLock(options.inboxPath);
      try {
        const uidValidity = String(client.mailbox && client.mailbox.uidValidity);
        const syncState = account.syncState || {};
        const lastUid = syncState.uidValidity === uidValidity ? Number(syncState.lastUid) || 0 : 0;
        const allUids = ((await client.search({ uid: `${lastUid + 1}:*` }, { uid: true })) || [])
          .map(Number)
          .filter(uid => uid > lastUid)
          .sort((a, b) => a - b);
        const batchSize = options.syncBatchSize;
        // 首次同步只取最新的一批，之后按 UID 升序增量追赶
        const uids = lastUid === 0 ? allUids.slice(-batchSize) : allUids.slice(0, batchSize);
        const messages = [];
        if (uids.length > 0) {
          for await (const message of client.fetch(uids, { uid: true, source: true, size: true }, { uid: true })) {
            messages.push({ uid: Number(message.uid), source: message.source, size: message.size });
          }
        }
        messages.sort((a, b) => a.uid - b.uid);
        return { uidValidity, lastUid, messages, hasMore: lastUid === 0 ? false : allUids.length > uids.length };
      } finally {
        lock.release();
      }
    } finally {
      await Promise.resolve(client.logout()).catch(() => {});
    }
  };

  /**
   * 按 UID 从收件箱重新拉取并解析一封邮件；UID 对应的不是同一封（Message-ID 不一致）时按 Message-ID 查找
   */
  const fetchMessage = async ({ account, uid, messageId }) => {
    const client = services.account.createImapClient(services.account.toConnectionConfig(account));
    await client.connect();
    try {
      const lock = await client.getMailboxLock(options.inboxPath);
      try {
        const fetchParsed = async uids => {
          const result = [];
          for await (const message of client.fetch(uids, { uid: true, source: true }, { uid: true })) {
            result.push(await simpleParser(message.source));
          }
          return result;
        };
        const isTarget = parsed => !messageId || parsed.messageId === messageId;
        const [byUid] = uid != null ? await fetchParsed([Number(uid)]) : [];
        if (byUid && isTarget(byUid)) {
          return byUid;
        }
        if (messageId) {
          const uids = ((await client.search({ header: { 'message-id': messageId } }, { uid: true })) || []).map(Number);
          if (uids.length > 0) {
            const found = (await fetchParsed(uids)).find(isTarget);
            if (found) {
              return found;
            }
          }
        }
        throw createError('邮件服务器上已找不到该邮件', 404);
      } finally {
        lock.release();
      }
    } finally {
      await Promise.resolve(client.logout()).catch(() => {});
    }
  };

  const syncAccount = async ({ id }) => {
    if (syncingAccounts.has(String(id))) {
      return { skipped: true, count: 0 };
    }
    syncingAccounts.add(String(id));
    const accountModel = await models.account.findByPk(id);
    try {
      if (!accountModel) {
        throw createError('邮箱账号不存在', 404);
      }
      if (accountModel.status !== 'enabled') {
        throw createError('邮箱账号已停用');
      }
      const account = await services.account.getWithPassword({ id });
      const { uidValidity, lastUid, messages, hasMore } = await fetchNewMessages({ account });

      const created = [];
      let currentUid = lastUid;
      for (const message of messages) {
        const mail = await saveRawMail({ account, ...message });
        currentUid = Math.max(currentUid, message.uid);
        if (!mail) {
          continue;
        }
        created.push(mail);
        await services.pipeline.dispatch({ direction: 'receive', mail, account });
      }

      accountModel.syncState = { uidValidity, lastUid: currentUid };
      accountModel.lastSyncAt = new Date();
      accountModel.lastError = null;
      await accountModel.save();
      return { skipped: false, count: created.length, hasMore };
    } catch (e) {
      if (accountModel) {
        accountModel.lastSyncAt = new Date();
        accountModel.lastError = e.message;
        await accountModel.save().catch(() => {});
      }
      throw e;
    } finally {
      syncingAccounts.delete(String(id));
    }
  };

  const syncAll = async () => {
    const accounts = await models.account.findAll({ where: { status: 'enabled' }, attributes: ['id'] });
    const results = [];
    for (const { id } of accounts) {
      try {
        results.push(Object.assign({ id, success: true }, await syncAccount({ id })));
      } catch (e) {
        fastify.log.error(e, `[fastify-mail-gateway] 邮箱 ${id} 同步失败`);
        results.push({ id, success: false, error: e.message });
      }
    }
    return results;
  };

  services.sync = { syncAccount, syncAll, saveRawMail, fetchMessage };
});
