const fp = require('fastify-plugin');
const { simpleParser } = require('mailparser');
const { normalizeAddressList } = require('../utils/address');
const { stripHtml } = require('../utils/condition');
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
  const historyJobs = new Map();

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
      text: String(parsed.text || '').trim() || stripHtml(parsed.html || parsed.textAsHtml || '').replace(/\s+/g, ' ').trim(),
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
        // 首次同步只拉最新一批且 hasMore=false，历史邮件改由 syncHistory / startHistorySync 拉取
        return { uidValidity, lastUid, messages, hasMore: lastUid === 0 ? false : allUids.length > uids.length };
      } finally {
        lock.release();
      }
    } finally {
      await Promise.resolve(client.logout()).catch(() => {});
    }
  };

  /**
   * 拉取早于 beforeUid 的历史邮件：按 UID 升序中取最靠近 beforeUid 的一批（先补最近的历史）
   */
  const fetchHistoryMessages = async ({ account, beforeUid, batchSize }) => {
    const client = services.account.createImapClient(services.account.toConnectionConfig(account));
    await client.connect();
    try {
      const lock = await client.getMailboxLock(options.inboxPath);
      try {
        const uidValidity = String(client.mailbox && client.mailbox.uidValidity);
        const allUids = ((await client.search({ uid: `1:${beforeUid - 1}` }, { uid: true })) || [])
          .map(Number)
          .filter(uid => uid > 0 && uid < beforeUid)
          .sort((a, b) => a - b);
        const uids = allUids.slice(-batchSize);
        const messages = [];
        if (uids.length > 0) {
          for await (const message of client.fetch(uids, { uid: true, source: true, size: true }, { uid: true })) {
            messages.push({ uid: Number(message.uid), source: message.source, size: message.size });
          }
        }
        messages.sort((a, b) => a.uid - b.uid);
        return { uidValidity, messages, hasMore: allUids.length > uids.length };
      } finally {
        lock.release();
      }
    } finally {
      await Promise.resolve(client.logout()).catch(() => {});
    }
  };

  const mergeSyncState = (prev, patch) => Object.assign({}, prev || {}, patch);

  const resolveOldestUid = async ({ accountId, syncState }) => {
    const fromState = Number(syncState?.oldestUid) || 0;
    if (fromState > 0) {
      return fromState;
    }
    const minUid = await models.mail.min('uid', { where: { accountId, folder: 'inbox' } });
    return Number(minUid) || 0;
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

  const ingestMessages = async ({ account, messages, lastUid = 0 }) => {
    const created = [];
    let currentUid = lastUid;
    let oldestUid = null;
    for (const message of messages) {
      const mail = await saveRawMail({ account, ...message });
      currentUid = Math.max(currentUid, message.uid);
      oldestUid = oldestUid == null ? message.uid : Math.min(oldestUid, message.uid);
      if (!mail) {
        continue;
      }
      created.push(mail);
      await services.pipeline.dispatch({ direction: 'receive', mail, account });
    }
    return { created, currentUid, oldestUid };
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
      const prevState = accountModel.syncState || {};
      const { uidValidity, lastUid, messages, hasMore } = await fetchNewMessages({ account });
      const { created, currentUid, oldestUid } = await ingestMessages({ account, messages, lastUid });
      const prevOldest = Number(prevState.oldestUid) || 0;
      accountModel.syncState = mergeSyncState(prevState, {
        uidValidity,
        lastUid: currentUid,
        oldestUid: oldestUid == null ? prevOldest || null : prevOldest ? Math.min(prevOldest, oldestUid) : oldestUid
      });
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

  /**
   * 同步一批历史邮件（早于当前 oldestUid）；供后台循环调用
   */
  const syncHistoryBatch = async ({ id, batchSize }) => {
    const accountModel = await models.account.findByPk(id);
    if (!accountModel) {
      throw createError('邮箱账号不存在', 404);
    }
    if (accountModel.status !== 'enabled') {
      throw createError('邮箱账号已停用');
    }
    const account = await services.account.getWithPassword({ id });
    const prevState = accountModel.syncState || {};
    let beforeUid = await resolveOldestUid({ accountId: id, syncState: prevState });
    if (!beforeUid || beforeUid <= 1) {
      // 库中尚无邮件时，从服务器最大 UID + 1 起往前捞（等同首次同步后继续补历史）
      const client = services.account.createImapClient(services.account.toConnectionConfig(account));
      await client.connect();
      try {
        const lock = await client.getMailboxLock(options.inboxPath);
        try {
          const allUids = ((await client.search({ uid: '1:*' }, { uid: true })) || []).map(Number).filter(uid => uid > 0);
          beforeUid = allUids.length ? Math.max(...allUids) + 1 : 0;
        } finally {
          lock.release();
        }
      } finally {
        await Promise.resolve(client.logout()).catch(() => {});
      }
    }
    if (!beforeUid || beforeUid <= 1) {
      return { count: 0, hasMore: false };
    }

    const size = Math.max(1, Math.min(batchSize || options.syncBatchSize, options.syncBatchSize));
    const { uidValidity, messages, hasMore } = await fetchHistoryMessages({ account, beforeUid, batchSize: size });
    const { created, currentUid, oldestUid } = await ingestMessages({
      account,
      messages,
      lastUid: Number(prevState.lastUid) || 0
    });
    const prevOldest = Number(prevState.oldestUid) || 0;
    const nextOldest = oldestUid == null ? prevOldest || null : Math.min(oldestUid, beforeUid - 1, prevOldest || oldestUid);
    accountModel.syncState = mergeSyncState(prevState, {
      uidValidity,
      lastUid: Math.max(Number(prevState.lastUid) || 0, currentUid),
      oldestUid: nextOldest
    });
    accountModel.lastSyncAt = new Date();
    accountModel.lastError = null;
    await accountModel.save();
    return { count: created.length, hasMore, fetched: created.length };
  };

  const finishHistory = async ({ accountModel, status, error = null }) => {
    const prevState = accountModel.syncState || {};
    const history = Object.assign({}, prevState.history || {}, {
      status,
      finishedAt: new Date().toISOString(),
      error
    });
    accountModel.syncState = mergeSyncState(prevState, { history });
    if (error) {
      accountModel.lastError = error;
    }
    await accountModel.save();
    return history;
  };

  const runHistoryLoop = async ({ id }) => {
    const key = String(id);
    try {
      while (true) {
        const accountModel = await models.account.findByPk(id);
        if (!accountModel) {
          return;
        }
        const history = (accountModel.syncState || {}).history;
        if (!history || history.status !== 'running') {
          return;
        }
        const limit = history.limit == null ? null : Number(history.limit);
        const fetched = Number(history.fetched) || 0;
        if (limit != null && fetched >= limit) {
          await finishHistory({ accountModel, status: 'done' });
          return;
        }
        const batchSize = limit == null ? options.syncBatchSize : Math.min(options.syncBatchSize, limit - fetched);
        if (batchSize <= 0) {
          await finishHistory({ accountModel, status: 'done' });
          return;
        }

        while (syncingAccounts.has(key)) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        syncingAccounts.add(key);
        let result;
        try {
          result = await syncHistoryBatch({ id, batchSize });
        } finally {
          syncingAccounts.delete(key);
        }

        const latest = await models.account.findByPk(id);
        if (!latest) {
          return;
        }
        const prevState = latest.syncState || {};
        const prevHistory = prevState.history || {};
        if (prevHistory.status !== 'running') {
          return;
        }
        const nextFetched = (Number(prevHistory.fetched) || 0) + (result.count || 0);
        const nextHistory = Object.assign({}, prevHistory, { fetched: nextFetched });
        const reachedLimit = nextHistory.limit != null && nextFetched >= Number(nextHistory.limit);
        if (!result.hasMore || reachedLimit) {
          nextHistory.status = 'done';
          nextHistory.finishedAt = new Date().toISOString();
          nextHistory.error = null;
          latest.syncState = mergeSyncState(prevState, { history: nextHistory });
          await latest.save();
          return;
        }
        latest.syncState = mergeSyncState(prevState, { history: nextHistory });
        await latest.save();
        await new Promise(resolve => setImmediate(resolve));
      }
    } catch (e) {
      fastify.log.error(e, `[fastify-mail-gateway] 邮箱 ${id} 历史同步失败`);
      const accountModel = await models.account.findByPk(id);
      if (accountModel) {
        await finishHistory({ accountModel, status: 'failed', error: e.message }).catch(() => {});
      }
    }
  };

  /**
   * 启动历史邮件异步拉取：limit 为空/0 表示全部；立即返回，后台按 syncBatchSize 分批执行
   */
  const startHistorySync = async ({ id, limit }) => {
    const accountModel = await models.account.findByPk(id);
    if (!accountModel) {
      throw createError('邮箱账号不存在', 404);
    }
    if (accountModel.status !== 'enabled') {
      throw createError('邮箱账号已停用');
    }
    const prevState = accountModel.syncState || {};
    if (prevState.history?.status === 'running' || historyJobs.has(String(id))) {
      return { started: false, skipped: true, history: prevState.history };
    }
    const maxCount = limit == null || limit === '' || Number(limit) === 0 ? null : Math.max(1, Math.floor(Number(limit)));
    if (maxCount != null && !Number.isFinite(maxCount)) {
      throw createError('最大条数无效');
    }
    const history = {
      status: 'running',
      limit: maxCount,
      fetched: 0,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null
    };
    accountModel.syncState = mergeSyncState(prevState, { history });
    await accountModel.save();
    const job = runHistoryLoop({ id });
    historyJobs.set(String(id), job);
    job.finally(() => {
      if (historyJobs.get(String(id)) === job) {
        historyJobs.delete(String(id));
      }
    });
    return { started: true, history };
  };

  const awaitHistorySync = id => historyJobs.get(String(id)) || Promise.resolve();

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

  services.sync = { syncAccount, syncAll, saveRawMail, fetchMessage, syncHistoryBatch, startHistorySync, awaitHistorySync };
});
