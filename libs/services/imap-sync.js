const fp = require('fastify-plugin');

/**
 * 把本地的已读 / 移入回收站操作回写到 IMAP 服务器；只处理收件箱中带 uid 的邮件，
 * 按邮箱分组、每个邮箱只建一次连接。回写失败只记日志，不影响本地状态（options.syncFlagsToServer=false 时关闭）
 */
module.exports = fp(async (fastify, options) => {
  const { services } = fastify[options.name];

  const groupByAccount = mails => {
    const groups = new Map();
    (mails || []).forEach(mail => {
      if (mail.folder !== 'inbox' || mail.uid == null) {
        return;
      }
      const key = String(mail.accountId);
      if (!groups.has(key)) {
        groups.set(key, { accountId: mail.accountId, uids: [] });
      }
      groups.get(key).uids.push(Number(mail.uid));
    });
    return [...groups.values()];
  };

  const withInbox = async (accountId, callback) => {
    const account = await services.account.getWithPassword({ id: accountId });
    const client = services.account.createImapClient(services.account.toConnectionConfig(account));
    await client.connect();
    try {
      const lock = await client.getMailboxLock(options.inboxPath);
      try {
        return await callback(client);
      } finally {
        lock.release();
      }
    } finally {
      await Promise.resolve(client.logout()).catch(() => {});
    }
  };

  const runEach = async (mails, label, callback) => {
    if (!options.syncFlagsToServer) {
      return;
    }
    for (const { accountId, uids } of groupByAccount(mails)) {
      try {
        await withInbox(accountId, client => callback(client, uids));
      } catch (e) {
        fastify.log.warn(e, `[fastify-mail-gateway] 邮箱 ${accountId} ${label}回写邮件服务器失败`);
      }
    }
  };

  const setSeen = ({ mails, seen = true }) => runEach(mails, seen ? '标为已读' : '标为未读', (client, uids) => (seen ? client.messageFlagsAdd(uids, ['\\Seen'], { uid: true }) : client.messageFlagsRemove(uids, ['\\Seen'], { uid: true })));

  // 优先移入服务器的回收站文件夹（special-use \Trash），没有时打 \Deleted 标记
  const moveToTrash = ({ mails }) =>
    runEach(mails, '移入回收站', async (client, uids) => {
      const trash = ((await client.list()) || []).find(item => item.specialUse === '\\Trash');
      if (trash) {
        await client.messageMove(uids, trash.path, { uid: true });
      } else {
        await client.messageFlagsAdd(uids, ['\\Deleted'], { uid: true });
      }
    });

  services.imapSync = { setSeen, moveToTrash };
});
