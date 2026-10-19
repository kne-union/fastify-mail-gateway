const fp = require('fastify-plugin');
const { CONDITION_FIELDS, CONDITION_OPERATORS } = require('../utils/condition');
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

  const validateConditions = (conditions, direction) => services.condition.validate({ conditions, direction });

  const assertOwnAccounts = async (accountIds, userId) => {
    const ids = [...new Set((accountIds || []).filter(Boolean).map(String))];
    if (ids.length === 0) {
      return;
    }
    const rows = await models.account.findAll({ where: { id: ids, userId }, attributes: ['id'], raw: true });
    if (rows.length !== ids.length) {
      throw createError('邮箱账号不存在', 404);
    }
  };

  const detail = async ({ id, userId }) => {
    const rule = await models.rule.findOne({ where: { id, userId: requireUser(userId) } });
    if (!rule) {
      throw createError('规则不存在', 404);
    }
    return rule;
  };

  const list = async ({ filter = {}, perPage = 20, currentPage = 1, userId } = {}) => {
    const where = { userId: requireUser(userId) };
    if (filter.direction) {
      where.direction = filter.direction;
    }
    if (filter.status) {
      where.status = filter.status;
    }
    if (filter.keyword) {
      where.name = { [Op.like]: `%${filter.keyword}%` };
    }
    const { rows, count } = await models.rule.findAndCountAll({
      where,
      offset: perPage * (currentPage - 1),
      limit: perPage,
      order: [
        ['priority', 'ASC'],
        ['createdAt', 'ASC']
      ]
    });
    return { pageData: rows, totalCount: count };
  };

  const create = async ({ name, description, direction = 'receive', accountIds = [], conditions, actions = [], priority = 0, stopProcessing = true, status = 'enabled', userId }) => {
    const ownerId = requireUser(userId);
    await assertOwnAccounts(accountIds, ownerId);
    const normalizedConditions = validateConditions(conditions, direction);
    services.action.validate({ actions, direction });
    return await models.rule.create({ name, description, direction, accountIds, conditions: normalizedConditions, actions, priority, stopProcessing, status, userId: ownerId });
  };

  const save = async ({ id, userId, ...data }) => {
    const rule = await detail({ id, userId });
    if (data.accountIds !== undefined) {
      await assertOwnAccounts(data.accountIds, userId);
    }
    const direction = data.direction || rule.direction;
    if (data.conditions !== undefined || data.direction !== undefined) {
      rule.conditions = validateConditions(data.conditions !== undefined ? data.conditions : rule.conditions, direction);
    }
    if (data.actions !== undefined || data.direction !== undefined) {
      services.action.validate({ actions: data.actions !== undefined ? data.actions : rule.actions, direction });
    }
    ['name', 'description', 'direction', 'accountIds', 'actions', 'priority', 'stopProcessing', 'status'].forEach(key => {
      if (data[key] !== undefined) {
        rule[key] = data[key];
      }
    });
    await rule.save();
    return rule;
  };

  const setStatus = async ({ id, status, userId }) => {
    const rule = await detail({ id, userId });
    rule.status = status;
    await rule.save();
    return rule;
  };

  const remove = async ({ id, userId }) => {
    const rule = await detail({ id, userId });
    await rule.destroy();
  };

  /**
   * 按传入顺序重排优先级
   */
  const sort = async ({ ids, userId }) => {
    const ownerId = requireUser(userId);
    for (let index = 0; index < ids.length; index++) {
      await models.rule.update({ priority: index }, { where: { id: ids[index], userId: ownerId } });
    }
  };

  const MAX_TEST_MAILS = 20;

  const normalizeMailIds = ({ mailId, mailIds }) => {
    const ids = [
      ...new Set(
        []
          .concat(mailIds || [], mailId || [])
          .filter(Boolean)
          .map(String)
      )
    ];
    if (ids.length === 0) {
      throw createError('请选择邮件');
    }
    if (ids.length > MAX_TEST_MAILS) {
      throw createError(`最多选择 ${MAX_TEST_MAILS} 封邮件`);
    }
    return ids;
  };

  /**
   * 试运行单封：判断是否命中，不执行动作
   */
  const testOne = async ({ rule, targetDirection, targetConditions, targetAccountIds, mailId, userId }) => {
    const mail = await services.mail.getInstance({ id: mailId, userId });
    const plainMail = mail.get({ plain: true });
    const accountMatched = targetAccountIds.length === 0 || targetAccountIds.map(String).includes(String(plainMail.accountId));
    const { password, ...account } = (await services.account.detail({ id: plainMail.accountId, userId })).get({ plain: true });
    const { matched, details } = await services.condition.evaluate({
      conditions: targetConditions,
      mail: plainMail,
      account,
      rule: rule ? rule.get({ plain: true }) : null,
      direction: targetDirection
    });
    return {
      mailId,
      subject: plainMail.subject || '',
      matched: accountMatched && matched,
      accountMatched,
      details
    };
  };

  /**
   * 试运行：支持 mailId 或 mailIds（最多 20），返回 { results, matchedCount, total }；单封时额外展开 matched/details 兼容旧调用
   */
  const test = async ({ id, conditions, accountIds, direction, mailId, mailIds, userId }) => {
    const ownerId = requireUser(userId);
    const rule = id ? await detail({ id, userId: ownerId }) : null;
    const targetDirection = direction || (rule ? rule.direction : 'receive');
    const targetConditions = conditions !== undefined ? validateConditions(conditions, targetDirection) : rule ? rule.conditions : { match: 'all', items: [] };
    const targetAccountIds = (accountIds !== undefined ? accountIds : rule ? rule.accountIds : []) || [];
    const ids = normalizeMailIds({ mailId, mailIds });
    const results = [];
    for (const targetMailId of ids) {
      results.push(await testOne({ rule, targetDirection, targetConditions, targetAccountIds, mailId: targetMailId, userId: ownerId }));
    }
    const payload = {
      results,
      matchedCount: results.filter(item => item.matched).length,
      total: results.length
    };
    if (results.length === 1) {
      Object.assign(payload, results[0]);
    }
    return payload;
  };

  /**
   * 手动执行：对 mailId / mailIds 逐封求值，命中则执行动作并写日志；不受启停状态影响
   */
  const execute = async ({ id, mailId, mailIds, userId }) => {
    const ownerId = requireUser(userId);
    const rule = await detail({ id, userId: ownerId });
    const ids = normalizeMailIds({ mailId, mailIds });
    const results = [];
    for (const targetMailId of ids) {
      const tested = await test({ id, mailId: targetMailId, userId: ownerId });
      const item = tested.results[0];
      if (!item.matched) {
        results.push(Object.assign({}, item, { executed: false }));
        continue;
      }
      const mail = await services.mail.getInstance({ id: targetMailId, userId: ownerId });
      const plainMail = mail.get({ plain: true });
      const { password, ...account } = (await services.account.detail({ id: plainMail.accountId, userId: ownerId })).get({ plain: true });
      const execution = await services.pipeline.executeRule({ rule, mail: plainMail, account, direction: rule.direction });
      results.push(Object.assign({}, item, { executed: true, execution }));
    }
    const payload = {
      results,
      executedCount: results.filter(item => item.executed).length,
      matchedCount: results.filter(item => item.matched).length,
      total: results.length
    };
    if (results.length === 1) {
      Object.assign(payload, results[0]);
    }
    return payload;
  };

  const logList = async ({ filter = {}, perPage = 20, currentPage = 1, userId } = {}) => {
    const where = { userId: requireUser(userId) };
    ['ruleId', 'mailId', 'accountId', 'direction', 'status'].forEach(key => {
      if (filter[key]) {
        where[key] = filter[key];
      }
    });
    const { rows, count } = await models.ruleLog.findAndCountAll({
      where,
      include: [
        { model: models.rule, as: 'rule', attributes: ['id', 'name', 'direction'], paranoid: false },
        { model: models.mail, as: 'mail', attributes: ['id', 'subject', 'from', 'to', 'folder', 'date'], paranoid: false }
      ],
      offset: perPage * (currentPage - 1),
      limit: perPage,
      order: [['createdAt', 'DESC']]
    });
    return { pageData: rows, totalCount: count };
  };

  const conditionOptions = ({ direction } = {}) => ({ fields: CONDITION_FIELDS, operators: CONDITION_OPERATORS, extensions: services.condition.list({ direction }) });

  services.rule = { list, detail, create, save, setStatus, remove, sort, test, execute, logList, conditionOptions };
});
