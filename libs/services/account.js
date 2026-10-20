const fp = require('fastify-plugin');
const nodemailer = require('nodemailer');
const { encrypt, decrypt } = require('../utils/crypto');
const { createError } = require('../utils/error');

const requireUser = userId => {
  if (userId == null || userId === '') {
    throw createError('未登录', 401);
  }
  return userId;
};

module.exports = fp(async (fastify, options) => {
  const { models, services } = fastify[options.name];
  const { Op } = fastify.sequelize.Sequelize;

  const toConnectionConfig = ({ username, password, imap, smtp }) => ({ username, password, imap: imap || {}, smtp: smtp || {} });

  const createImapClient = config => {
    if (typeof options.createImapClient === 'function') {
      return options.createImapClient(config);
    }
    const { ImapFlow } = require('imapflow');
    return new ImapFlow({
      host: config.imap.host,
      port: config.imap.port,
      secure: config.imap.secure !== false,
      auth: { user: config.username, pass: config.password },
      logger: false
    });
  };

  const createTransport = config => {
    if (typeof options.createTransport === 'function') {
      return options.createTransport(config);
    }
    return nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure !== false,
      auth: { user: config.username, pass: config.password }
    });
  };

  const testImap = async config => {
    const client = createImapClient(config);
    try {
      await client.connect();
      const lock = await client.getMailboxLock(options.inboxPath);
      lock.release();
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    } finally {
      await Promise.resolve(client.logout && client.logout()).catch(() => {});
    }
  };

  const testSmtp = async config => {
    const transport = createTransport(config);
    try {
      await transport.verify();
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    } finally {
      transport.close && transport.close();
    }
  };

  /**
   * 测试 IMAP 与 SMTP 连通性；传 id 时使用已保存配置，传入的字段会覆盖已保存配置（用于编辑时不重填密码）
   */
  const testConnection = async ({ id, userId, ...config }) => {
    let target = config;
    if (id) {
      const account = await getWithPassword({ id, userId: requireUser(userId) });
      target = Object.assign({}, account, Object.fromEntries(Object.entries(config).filter(([, value]) => value != null && value !== '')));
    }
    const connectionConfig = toConnectionConfig(target);
    const [imap, smtp] = await Promise.all([testImap(connectionConfig), testSmtp(connectionConfig)]);
    return { success: imap.success && smtp.success, imap, smtp };
  };

  const assertConnection = async config => {
    const result = await testConnection(config);
    if (!result.success) {
      const errors = [];
      !result.imap.success && errors.push(`IMAP: ${result.imap.error}`);
      !result.smtp.success && errors.push(`SMTP: ${result.smtp.error}`);
      throw createError(`邮箱连接失败，${errors.join('；')}`);
    }
  };

  const detail = async ({ id, userId }) => {
    const where = { id };
    if (userId != null && userId !== '') {
      where.userId = userId;
    }
    const account = await models.account.findOne({ where });
    if (!account) {
      throw createError('邮箱账号不存在', 404);
    }
    return account;
  };

  /**
   * 返回包含解密后密码的普通对象，仅供服务内部收发信使用，禁止直接返回给接口
   */
  const getWithPassword = async ({ id, userId }) => {
    const where = { id };
    if (userId != null && userId !== '') {
      where.userId = userId;
    }
    const account = await models.account.scope('withPassword').findOne({ where });
    if (!account) {
      throw createError('邮箱账号不存在', 404);
    }
    const plain = account.get({ plain: true });
    return Object.assign(plain, { password: decrypt(plain.password, options.secretKey) });
  };

  const list = async ({ filter = {}, perPage = 20, currentPage = 1, userId } = {}) => {
    const where = { userId: requireUser(userId) };
    if (filter.id) {
      where.id = filter.id;
    }
    if (filter.status) {
      where.status = filter.status;
    }
    if (filter.keyword) {
      where[Op.or] = [{ name: { [Op.like]: `%${filter.keyword}%` } }, { address: { [Op.like]: `%${filter.keyword}%` } }];
    }
    const { rows, count } = await models.account.findAndCountAll({
      where,
      offset: perPage * (currentPage - 1),
      limit: perPage,
      order: [
        ['isDefault', 'DESC'],
        ['createdAt', 'DESC']
      ]
    });
    return { pageData: rows, totalCount: count };
  };

  const create = async ({ name, address, username, password, imap, smtp, skipVerify, userId }) => {
    requireUser(userId);
    if (!skipVerify) {
      await assertConnection({ username, password, imap, smtp });
    }
    const existing = await models.account.count({ where: { userId } });
    const account = await models.account.create({
      name,
      address,
      username,
      password: encrypt(password, options.secretKey),
      imap,
      smtp,
      isDefault: existing === 0,
      userId
    });
    return await detail({ id: account.id, userId });
  };

  const save = async ({ id, skipVerify, userId, ...data }) => {
    requireUser(userId);
    const account = await models.account.scope('withPassword').findOne({ where: { id, userId } });
    if (!account) {
      throw createError('邮箱账号不存在', 404);
    }
    const connectionChanged = ['username', 'password', 'imap', 'smtp'].some(key => data[key] != null && data[key] !== '');
    if (connectionChanged && !skipVerify) {
      await assertConnection(Object.assign({ id, userId }, data));
    }
    ['name', 'address', 'username', 'imap', 'smtp'].forEach(key => {
      if (data[key] != null) {
        account[key] = data[key];
      }
    });
    if (data.password) {
      account.password = encrypt(data.password, options.secretKey);
    }
    if (data.imap && account.changed('imap')) {
      account.syncState = {};
    }
    await account.save();
    return await detail({ id, userId });
  };

  const setStatus = async ({ id, status, userId }) => {
    const account = await detail({ id, userId: requireUser(userId) });
    account.status = status;
    await account.save();
    return account;
  };

  const remove = async ({ id, userId }) => {
    const account = await detail({ id, userId: requireUser(userId) });
    const mailIds = (await models.mail.findAll({ where: { accountId: id }, attributes: ['id'], raw: true })).map(item => item.id);
    if (mailIds.length > 0) {
      await models.mailLabel.destroy({ where: { mailId: mailIds } });
    }
    await models.mail.destroy({ where: { accountId: id } });
    await models.label.destroy({ where: { accountId: id } });
    await account.destroy();
    if (account.isDefault) {
      const next = await models.account.findOne({ where: { userId }, order: [['createdAt', 'ASC']] });
      if (next) {
        next.isDefault = true;
        await next.save();
      }
    }
  };

  const setDefault = async ({ id, userId }) => {
    const account = await detail({ id, userId: requireUser(userId) });
    await models.account.sequelize.transaction(async transaction => {
      await models.account.update({ isDefault: false }, { where: { userId, id: { [Op.ne]: id } }, transaction });
      account.isDefault = true;
      await account.save({ transaction });
    });
    return account;
  };

  services.account = {
    list,
    detail,
    create,
    save,
    setStatus,
    setDefault,
    remove,
    testConnection,
    getWithPassword,
    createImapClient,
    createTransport,
    toConnectionConfig
  };
});
