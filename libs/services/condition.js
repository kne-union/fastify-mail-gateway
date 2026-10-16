const fp = require('fastify-plugin');
const { createError } = require('../utils/error');
const { evaluateItem, CONDITION_FIELDS, CONDITION_OPERATORS } = require('../utils/condition');
const { normalizeFormSchema, collectFields, isRequiredField, getPathValue } = require('../utils/form-schema');

const DIRECTIONS = ['receive', 'send'];
const DEFAULT_TIMEOUT = 30000;

const isExtensionItem = item => !!item && typeof item.type === 'string' && item.type !== '' && item.type !== 'field';

const withTimeout = (promise, timeout, label) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`条件「${label}」判断超时（${timeout}ms）`)), timeout);
    })
  ]).finally(() => clearTimeout(timer));
};

module.exports = fp(async (fastify, options) => {
  const { models, services } = fastify[options.name];
  const registry = new Map();

  /**
   * 注册扩展条件，同名覆盖
   * @param {string} type 条件类型，规则中 conditions.items[].type 引用它
   * @param {object} condition { label, description, directions, formSchema, validate, evaluate, timeout }
   *   formSchema: 可选，@kne/form-creator 搭建 Schema，前端在条件行内渲染参数表单，字段值即 params
   *   evaluate: async ({ mail, account, params, rule, direction, fastify, services, models, log }) => boolean | { matched, reason }
   *   timeout: 可选，单次判断超时毫秒数，超时视为未命中
   */
  const register = (type, condition) => {
    if (!type || typeof type !== 'string' || type === 'field') {
      throw new Error('条件类型 type 必须为非空字符串且不能为 field');
    }
    const target = typeof condition === 'function' ? { evaluate: condition } : Object.assign({}, condition);
    if (typeof target.evaluate !== 'function') {
      throw new Error(`条件 ${type} 缺少 evaluate`);
    }
    if (target.formSchema != null && (typeof target.formSchema !== 'object' || !(Array.isArray(target.formSchema.blocks) || Array.isArray(target.formSchema.list)))) {
      throw new Error(`条件 ${type} 的 formSchema 须为包含 blocks 的 form-creator Schema`);
    }
    const formSchema = normalizeFormSchema(target.formSchema);
    registry.set(type, {
      type,
      label: target.label || type,
      description: target.description || '',
      directions: (target.directions || DIRECTIONS).filter(item => DIRECTIONS.includes(item)),
      formSchema,
      fields: collectFields(formSchema),
      timeout: target.timeout > 0 ? target.timeout : DEFAULT_TIMEOUT,
      validate: typeof target.validate === 'function' ? target.validate : null,
      evaluate: target.evaluate
    });
  };

  const unregister = type => {
    registry.delete(type);
  };

  const get = type => registry.get(type);

  /**
   * 扩展条件元数据列表（不含 evaluate），供前端渲染条件行
   */
  const list = ({ direction } = {}) => {
    return Array.from(registry.values())
      .filter(item => !direction || item.directions.includes(direction))
      .map(({ evaluate, validate, fields, ...meta }) => meta);
  };

  const validateParams = (condition, params = {}) => {
    condition.fields.filter(isRequiredField).forEach(field => {
      const value = getPathValue(params, field.path);
      if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) {
        throw createError(`条件「${condition.label}」缺少参数「${field.label || field.name}」`);
      }
    });
    if (condition.validate) {
      try {
        condition.validate(params);
      } catch (e) {
        throw createError(`条件「${condition.label}」${e.message}`);
      }
    }
  };

  const validateBuiltInItem = item => {
    if (!CONDITION_FIELDS.includes(item.field)) {
      throw createError(`条件字段 ${item.field} 不支持，可选：${CONDITION_FIELDS.join('/')}，或使用已注册的扩展条件 type`);
    }
    if (!CONDITION_OPERATORS.includes(item.operator)) {
      throw createError(`条件操作符 ${item.operator} 不支持，可选：${CONDITION_OPERATORS.join('/')}`);
    }
    if (item.operator === 'regex') {
      try {
        new RegExp(String(item.value));
      } catch (e) {
        throw createError(`正则表达式无效：${item.value}`);
      }
    }
    return { field: item.field, operator: item.operator, value: item.value };
  };

  /**
   * 校验并规范化规则条件：内置条件为 { field, operator, value }，扩展条件为 { type, params }
   */
  const validate = ({ conditions, direction } = {}) => {
    const { match = 'all', items = [] } = conditions || {};
    if (!['all', 'any'].includes(match)) {
      throw createError('conditions.match 只能为 all 或 any');
    }
    const normalizedItems = items.map(item => {
      if (!isExtensionItem(item)) {
        return validateBuiltInItem(item || {});
      }
      const condition = registry.get(item.type);
      if (!condition) {
        throw createError(`条件类型 ${item.type} 未注册`);
      }
      if (direction && !condition.directions.includes(direction)) {
        throw createError(`条件「${condition.label}」不支持 ${direction} 方向的规则`);
      }
      const params = item.params || {};
      validateParams(condition, params);
      return { type: item.type, params };
    });
    return { match, items: normalizedItems };
  };

  const runExtension = async ({ item, mail, account, rule, direction }) => {
    const condition = registry.get(item.type);
    const base = { type: item.type, label: condition ? condition.label : item.type, params: item.params || {} };
    if (!condition) {
      return Object.assign(base, { matched: false, error: `条件类型 ${item.type} 未注册` });
    }
    const logs = [];
    try {
      validateParams(condition, base.params);
      const result = await withTimeout(
        Promise.resolve(
          condition.evaluate({
            mail,
            account,
            params: base.params,
            rule,
            direction,
            fastify,
            services,
            models,
            options,
            log: (...args) => logs.push(args.map(value => (typeof value === 'string' ? value : JSON.stringify(value))).join(' '))
          })
        ),
        condition.timeout,
        condition.label
      );
      const matched = result && typeof result === 'object' ? !!result.matched : !!result;
      const reason = result && typeof result === 'object' && result.reason != null ? String(result.reason) : undefined;
      return Object.assign(base, { matched }, reason !== undefined ? { reason } : {}, logs.length ? { logs } : {});
    } catch (e) {
      fastify.log.warn(e, `[fastify-mail-gateway] 条件「${base.label}」判断失败，按未命中处理`);
      return Object.assign(base, { matched: false, error: e.message }, logs.length ? { logs } : {});
    }
  };

  /**
   * 判断邮件是否满足规则条件，items 为空时视为总是命中。
   * 先求值内置条件，结果已确定时（all 遇到未命中 / any 遇到命中）跳过扩展条件，避免不必要的外部调用（如 AI）；
   * 扩展条件按配置顺序依次求值，同样短路。返回的 details 与 items 顺序一致，被跳过的条目 skipped=true
   */
  const evaluate = async ({ conditions, mail, account, rule, direction }) => {
    const { match = 'all', items = [] } = conditions || {};
    if (items.length === 0) {
      return { matched: true, details: [] };
    }
    const details = new Array(items.length);
    const isDecided = matched => (match === 'any' ? matched : !matched);
    let decided = false;
    // 先求值内置条件（按配置顺序，已决定则短路跳过后续内置项）
    items.forEach((item, index) => {
      if (isExtensionItem(item)) {
        return;
      }
      if (decided) {
        details[index] = { field: item.field, operator: item.operator, value: item.value, matched: false, skipped: true };
        return;
      }
      const matched = evaluateItem(mail, item);
      details[index] = { field: item.field, operator: item.operator, value: item.value, matched };
      if (isDecided(matched)) {
        decided = true;
      }
    });
    // 扩展条件按配置顺序求值；all 已未命中 / any 已命中时跳过，避免多余外部调用
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      if (!isExtensionItem(item)) {
        continue;
      }
      if (decided) {
        const condition = registry.get(item.type);
        details[index] = { type: item.type, label: condition ? condition.label : item.type, params: item.params || {}, matched: false, skipped: true };
        continue;
      }
      details[index] = await runExtension({ item, mail, account, rule, direction });
      if (isDecided(details[index].matched)) {
        decided = true;
      }
    }
    const evaluated = details.filter(item => !item.skipped);
    const matched = match === 'any' ? evaluated.some(item => item.matched) : evaluated.every(item => item.matched);
    return { matched, details };
  };

  services.condition = { register, unregister, get, list, validate, evaluate, DIRECTIONS };
});
