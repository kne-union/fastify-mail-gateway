const fp = require('fastify-plugin');
const { CONDITION_FIELDS, CONDITION_OPERATORS } = require('../utils/condition');
const { createError } = require('../utils/error');

module.exports = fp(async (fastify, options) => {
  const { models, services } = fastify[options.name];
  const { Op } = fastify.sequelize.Sequelize;

  const validateConditions = (conditions, direction) => services.condition.validate({ conditions, direction });

  const detail = async ({ id }) => {
    const rule = await models.rule.findByPk(id);
    if (!rule) {
      throw createError('规则不存在', 404);
    }
    return rule;
  };

  const list = async ({ filter = {}, perPage = 20, currentPage = 1 } = {}) => {
    const where = {};
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

  const create = async ({ name, description, direction = 'receive', accountIds = [], conditions, actions = [], priority = 0, stopProcessing = false, status = 'enabled' }) => {
    const normalizedConditions = validateConditions(conditions, direction);
    services.action.validate({ actions, direction });
    return await models.rule.create({ name, description, direction, accountIds, conditions: normalizedConditions, actions, priority, stopProcessing, status });
  };

  const save = async ({ id, ...data }) => {
    const rule = await detail({ id });
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

  const setStatus = async ({ id, status }) => {
    const rule = await detail({ id });
    rule.status = status;
    await rule.save();
    return rule;
  };

  const remove = async ({ id }) => {
    const rule = await detail({ id });
    await rule.destroy();
  };

  /**
   * 按传入顺序重排优先级
   */
  const sort = async ({ ids }) => {
    for (let index = 0; index < ids.length; index++) {
      await models.rule.update({ priority: index }, { where: { id: ids[index] } });
    }
  };

  /**
   * 试运行：用已保存规则或传入的规则配置判断某封邮件是否命中，不执行任何动作
   */
  const test = async ({ id, conditions, accountIds, direction, mailId }) => {
    const rule = id ? await detail({ id }) : null;
    const targetDirection = direction || (rule ? rule.direction : 'receive');
    const targetConditions = conditions !== undefined ? validateConditions(conditions, targetDirection) : rule ? rule.conditions : { match: 'all', items: [] };
    const targetAccountIds = (accountIds !== undefined ? accountIds : rule ? rule.accountIds : []) || [];
    const mail = await services.mail.getInstance({ id: mailId });
    const plainMail = mail.get({ plain: true });
    const accountMatched = targetAccountIds.length === 0 || targetAccountIds.map(String).includes(String(plainMail.accountId));
    const { password, ...account } = (await services.account.detail({ id: plainMail.accountId })) || {};
    const { matched, details } = await services.condition.evaluate({
      conditions: targetConditions,
      mail: plainMail,
      account,
      rule: rule ? rule.get({ plain: true }) : null,
      direction: targetDirection
    });
    return { matched: accountMatched && matched, accountMatched, details };
  };

  const logList = async ({ filter = {}, perPage = 20, currentPage = 1 } = {}) => {
    const where = {};
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

  services.rule = { list, detail, create, save, setStatus, remove, sort, test, logList, conditionOptions };
});
