const fp = require('fastify-plugin');

module.exports = fp(async (fastify, options) => {
  const { models, services } = fastify[options.name];

  const toPlainMail = mail => (mail && typeof mail.get === 'function' ? mail.get({ plain: true }) : mail);

  const toPublicAccount = account => {
    if (!account) {
      return null;
    }
    const { password, ...rest } = toPlainMail(account);
    return rest;
  };

  const ruleMatchesAccount = (rule, accountId) => {
    const accountIds = (rule.accountIds || []).map(String);
    return accountIds.length === 0 || accountIds.includes(String(accountId));
  };

  const loadRules = async ({ direction }) => {
    return await models.rule.findAll({
      where: { direction, status: 'enabled' },
      order: [
        ['priority', 'ASC'],
        ['createdAt', 'ASC']
      ]
    });
  };

  const executeRule = async ({ rule, mail, account, direction }) => {
    const startTime = process.hrtime.bigint();
    const results = [];
    for (const item of rule.actions || []) {
      try {
        const { output, logs } = await services.action.execute({ type: item.type, params: item.params || {}, mail, account, rule: toPlainMail(rule), direction });
        results.push({ type: item.type, success: true, output, logs });
      } catch (e) {
        fastify.log.error(e, `[fastify-mail-gateway] 规则「${rule.name}」动作 ${item.type} 执行失败`);
        results.push({ type: item.type, success: false, error: e.message });
      }
    }
    const executionTime = Number((process.hrtime.bigint() - startTime) / 1000000n);
    const failedCount = results.filter(item => !item.success).length;
    const status = failedCount === 0 ? 'success' : failedCount === results.length ? 'failed' : 'partial';
    await models.ruleLog.create({ ruleId: rule.id, mailId: mail.id, accountId: mail.accountId, direction, status, results, executionTime });
    return { ruleId: rule.id, name: rule.name, status, results };
  };

  /**
   * 对一封邮件执行指定方向的规则：按优先级依次求值，命中则顺序执行动作并写日志，stopProcessing 时中断
   */
  const run = async ({ direction, mail, account }) => {
    const plainMail = toPlainMail(mail);
    const publicAccount = toPublicAccount(account) || toPlainMail(await services.account.detail({ id: plainMail.accountId }));
    const rules = (await loadRules({ direction })).filter(rule => ruleMatchesAccount(rule, plainMail.accountId));
    const executed = [];
    for (const rule of rules) {
      const { matched } = await services.condition.evaluate({ conditions: rule.conditions, mail: plainMail, account: publicAccount, rule: toPlainMail(rule), direction });
      if (!matched) {
        continue;
      }
      executed.push(await executeRule({ rule, mail: plainMail, account: publicAccount, direction }));
      if (rule.stopProcessing) {
        break;
      }
    }
    return executed;
  };

  /**
   * 收发流程中调用：先执行代码级 onReceive 钩子（仅收信），再执行规则；任何异常只记日志，不影响收发主流程
   */
  const dispatch = async ({ direction, mail, account }) => {
    try {
      if (direction === 'receive' && typeof options.onReceive === 'function') {
        await options.onReceive({ mail, account: toPublicAccount(account), fastify });
      }
    } catch (e) {
      fastify.log.error(e, '[fastify-mail-gateway] onReceive 执行失败');
    }
    try {
      return await run({ direction, mail, account });
    } catch (e) {
      fastify.log.error(e, `[fastify-mail-gateway] ${direction} 规则执行失败`);
      return [];
    }
  };

  services.pipeline = { run, dispatch };
});
