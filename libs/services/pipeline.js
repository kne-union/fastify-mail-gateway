const fp = require('fastify-plugin');
const { createError } = require('../utils/error');

// 发信前动作可修改的邮件字段
const MUTABLE_FIELDS = ['subject', 'html', 'text', 'to', 'cc', 'bcc', 'headers'];

const pickMailPatch = patch => Object.fromEntries(MUTABLE_FIELDS.filter(key => patch[key] !== undefined).map(key => [key, patch[key]]));

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

  const loadRules = async ({ direction, userId }) => {
    if (userId == null || userId === '') {
      return [];
    }
    return await models.rule.findAll({
      where: { direction, status: 'enabled', userId },
      order: [
        ['priority', 'ASC'],
        ['createdAt', 'ASC']
      ]
    });
  };

  /**
   * 执行规则动作并写日志。发信前（beforeSend）：动作返回的 output.mail 依次合并进待发送邮件，output.block 标记拦截；
   * 任一动作出错即停止后续动作（出错不放行）；返回值额外带 mail（修改后的邮件）、block、logId
   */
  const executeRule = async ({ rule, mail = null, mails, account, direction }) => {
    const isBeforeSend = direction === 'beforeSend';
    const startTime = process.hrtime.bigint();
    const results = [];
    let current = mail;
    let block = null;
    let draft = false;
    for (const item of rule.actions || []) {
      try {
        const { output, logs } = await services.action.execute({ type: item.type, params: item.params || {}, mail: current, mails, account, rule: toPlainMail(rule), direction });
        results.push({ type: item.type, success: true, output, logs });
        if (isBeforeSend && output && typeof output === 'object') {
          if (output.mail && typeof output.mail === 'object') {
            current = Object.assign({}, current, pickMailPatch(output.mail));
          }
          if (output.block) {
            block = { reason: typeof output.block === 'string' ? output.block : '' };
          }
          if (output.draft) {
            draft = true;
          }
        }
      } catch (e) {
        fastify.log.error(e, `[fastify-mail-gateway] 规则「${rule.name}」动作 ${item.type} 执行失败`);
        results.push({ type: item.type, success: false, error: e.message });
        if (isBeforeSend) {
          break;
        }
      }
    }
    const executionTime = Number((process.hrtime.bigint() - startTime) / 1000000n);
    const failedCount = results.filter(item => !item.success).length;
    const status = failedCount === 0 ? 'success' : failedCount === results.length ? 'failed' : 'partial';
    const log = await models.ruleLog.create({
      ruleId: rule.id,
      mailId: (mail && mail.id) || null,
      mailIds: mails ? mails.map(item => item.id) : null,
      accountId: mail ? mail.accountId : account && account.id,
      userId: account && account.userId,
      direction,
      status,
      results,
      executionTime
    });
    const execution = { ruleId: rule.id, name: rule.name, status, results };
    return isBeforeSend ? Object.assign(execution, { mail: current, block, draft, logId: log.id }) : execution;
  };

  const findMatchedRule = async ({ direction, mail, account }) => {
    const rules = (await loadRules({ direction, userId: account && account.userId })).filter(rule => ruleMatchesAccount(rule, mail.accountId));
    for (const rule of rules) {
      const { matched } = await services.condition.evaluate({ conditions: rule.conditions, mail, account, rule: toPlainMail(rule), direction });
      if (matched) {
        return rule;
      }
    }
    return null;
  };

  /**
   * 对一封邮件执行指定方向的规则：按优先级依次求值，命中则执行动作并写日志；
   * 短路：任一规则命中后不再求值/执行后续规则（stopProcessing 恒生效，字段保留兼容旧数据）
   */
  const run = async ({ direction, mail, account }) => {
    const plainMail = toPlainMail(mail);
    const publicAccount = toPublicAccount(account) || toPlainMail(await services.account.detail({ id: plainMail.accountId }));
    const rule = await findMatchedRule({ direction, mail: plainMail, account: publicAccount });
    return rule ? [await executeRule({ rule, mail: plainMail, account: publicAccount, direction })] : [];
  };

  /**
   * 发信前规则：命中第一条规则后执行其动作，返回修改后的邮件与日志 id（发送成功后回填 mailId）；
   * draft=true 表示动作要求不发送、改存草稿。
   * 与 dispatch 不同，异常不吞：动作出错或被拦截时抛错，由 mail.send 中止发送
   */
  const beforeSend = async ({ mail, account }) => {
    const publicAccount = toPublicAccount(account);
    const rule = await findMatchedRule({ direction: 'beforeSend', mail, account: publicAccount });
    if (!rule) {
      return { mail, logIds: [], draft: false };
    }
    const execution = await executeRule({ rule, mail, account: publicAccount, direction: 'beforeSend' });
    const failed = execution.results.find(item => !item.success);
    if (failed) {
      const action = services.action.get(failed.type);
      throw createError(`发信前规则「${rule.name}」的动作「${action ? action.label : failed.type}」执行失败：${failed.error}`);
    }
    if (execution.block) {
      throw createError(`邮件已被规则「${rule.name}」拦截${execution.block.reason ? `：${execution.block.reason}` : ''}`);
    }
    return { mail: execution.mail, logIds: [execution.logId], draft: execution.draft };
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

  services.pipeline = { run, dispatch, beforeSend, executeRule };
});
