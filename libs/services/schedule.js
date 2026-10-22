const fp = require('fastify-plugin');

module.exports = fp(async (fastify, options) => {
  const { models, services } = fastify[options.name];
  const { Op } = fastify.sequelize.Sequelize;

  const toPlain = item => (item && typeof item.get === 'function' ? item.get({ plain: true }) : item);

  const loadAccounts = async rule => {
    const where = { userId: rule.userId, status: 'enabled' };
    const accountIds = (rule.accountIds || []).map(String);
    if (accountIds.length > 0) {
      where.id = accountIds;
    }
    return (await models.account.findAll({ where })).map(toPlain);
  };

  /**
   * 统计邮箱在时间窗口内收到的未读邮件，并按规则条件逐封过滤（条件为空则全部计入），按时间升序返回
   */
  const collectMails = async ({ rule, account, since }) => {
    const mails = (
      await models.mail.findAll({
        where: { accountId: account.id, folder: 'inbox', isRead: false, date: { [Op.gte]: since } },
        order: [['date', 'ASC']]
      })
    ).map(toPlain);
    const plainRule = toPlain(rule);
    const matched = [];
    for (const mail of mails) {
      const { matched: hit } = await services.condition.evaluate({ conditions: rule.conditions, mail, account, rule: plainRule, direction: 'schedule' });
      if (hit) {
        matched.push(mail);
      }
    }
    return matched;
  };

  /**
   * 执行一条定时规则：冷却期内跳过；各适用邮箱未读数达到阈值时，把这批邮件交给规则动作处理
   */
  const runRule = async ({ rule, now = new Date() }) => {
    const { windowDays, minCount, cooldownMinutes } = rule.trigger || {};
    if (!windowDays || !minCount) {
      return [];
    }
    const windowMs = windowDays * 24 * 60 * 60 * 1000;
    const cooldown = cooldownMinutes == null ? windowMs : cooldownMinutes * 60 * 1000;
    if (rule.lastTriggeredAt && now.getTime() - new Date(rule.lastTriggeredAt).getTime() < cooldown) {
      return [];
    }
    const since = new Date(now.getTime() - windowMs);
    const executions = [];
    for (const account of await loadAccounts(rule)) {
      const mails = await collectMails({ rule, account, since });
      if (mails.length < minCount) {
        continue;
      }
      executions.push(await services.pipeline.executeRule({ rule, mails, account, direction: 'schedule' }));
    }
    if (executions.length > 0) {
      rule.lastTriggeredAt = now;
      await rule.save();
    }
    return executions;
  };

  let running = false;

  /**
   * 定时任务入口：依次执行所有启用的定时规则；上一轮未结束时跳过本轮，单条规则出错只记日志
   */
  const runAll = async ({ now = new Date() } = {}) => {
    if (running) {
      return [];
    }
    running = true;
    try {
      const rules = await models.rule.findAll({
        where: { direction: 'schedule', status: 'enabled' },
        order: [
          ['priority', 'ASC'],
          ['createdAt', 'ASC']
        ]
      });
      const executions = [];
      for (const rule of rules) {
        try {
          executions.push(...(await runRule({ rule, now })));
        } catch (e) {
          fastify.log.error(e, `[fastify-mail-gateway] 定时规则「${rule.name}」执行失败`);
        }
      }
      return executions;
    } finally {
      running = false;
    }
  };

  services.schedule = { runAll, runRule };
});
