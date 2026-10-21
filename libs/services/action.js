const fp = require('fastify-plugin');
const { createError } = require('../utils/error');
const { createFormSchema, normalizeFormSchema, collectFields, isRequiredField, getPathValue } = require('../utils/form-schema');
const { DIRECTIONS, DEFAULT_DIRECTIONS } = require('../utils/direction');

module.exports = fp(async (fastify, options) => {
  const { models, services } = fastify[options.name];
  const registry = new Map();

  /**
   * 注册动作，同名覆盖
   * @param {string} type 动作类型，规则中 actions[].type 引用它
   * @param {object} action { label, description, directions, formSchema, handler }
   *   formSchema: 可选，@kne/form-creator 搭建 Schema，前端用 SchemaRendererInner 渲染参数表单，字段值即 params；
   *     字段 rule 含 REQ 时保存与执行前校验必填，默认值写在字段 props.defaultValue
   *   validate: 可选，(params) => void，参数之间存在依赖时抛错
   *   directions: 可选，默认 ['receive', 'send']；发信前（beforeSend）需显式声明
   *   handler: async ({ mail, account, params, rule, direction, fastify, services, models, log }) => output
   *     beforeSend 时 output 可带 { mail: { subject, html, text, to, cc, bcc, headers } } 修改待发送邮件，
   *     或 { block: true | '拦截原因' } 拦截发送；后续动作拿到的是已修改的邮件
   */
  const register = (type, action) => {
    if (!type || typeof type !== 'string') {
      throw new Error('动作类型 type 必须为非空字符串');
    }
    const target = typeof action === 'function' ? { handler: action } : Object.assign({}, action);
    if (typeof target.handler !== 'function') {
      throw new Error(`动作 ${type} 缺少 handler`);
    }
    const directions = (target.directions || DEFAULT_DIRECTIONS).filter(item => DIRECTIONS.includes(item));
    if (target.formSchema != null && (typeof target.formSchema !== 'object' || !(Array.isArray(target.formSchema.blocks) || Array.isArray(target.formSchema.list)))) {
      throw new Error(`动作 ${type} 的 formSchema 须为包含 blocks 的 form-creator Schema`);
    }
    const formSchema = normalizeFormSchema(target.formSchema);
    registry.set(type, {
      type,
      label: target.label || type,
      description: target.description || '',
      directions,
      formSchema,
      fields: collectFields(formSchema),
      builtIn: !!target.builtIn,
      validate: typeof target.validate === 'function' ? target.validate : null,
      handler: target.handler
    });
  };

  const unregister = type => {
    registry.delete(type);
  };

  const get = type => registry.get(type);

  /**
   * 动作元数据列表（不含 handler），供前端渲染规则配置
   */
  const list = ({ direction } = {}) => {
    return Array.from(registry.values())
      .filter(item => !direction || item.directions.includes(direction))
      .map(({ handler, validate, fields, ...meta }) => meta);
  };

  const validateParams = (action, params = {}) => {
    action.fields.filter(isRequiredField).forEach(field => {
      const value = getPathValue(params, field.path);
      if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) {
        throw createError(`动作「${action.label}」缺少参数「${field.label || field.name}」`);
      }
    });
    if (action.validate) {
      try {
        action.validate(params);
      } catch (e) {
        throw createError(`动作「${action.label}」${e.message}`);
      }
    }
  };

  /**
   * 校验规则里的动作配置：类型已注册、方向匹配、必填参数齐全
   */
  const validate = ({ actions = [], direction }) => {
    actions.forEach(item => {
      const action = registry.get(item.type);
      if (!action) {
        throw createError(`动作类型 ${item.type} 未注册`);
      }
      if (direction && !action.directions.includes(direction)) {
        throw createError(`动作「${action.label}」不支持 ${direction} 方向的规则`);
      }
      validateParams(action, item.params);
    });
  };

  const execute = async ({ type, params = {}, mail, account, rule, direction }) => {
    const action = registry.get(type);
    if (!action) {
      throw new Error(`动作类型 ${type} 未注册`);
    }
    validateParams(action, params);
    const logs = [];
    const output = await action.handler({
      mail,
      account,
      params,
      rule,
      direction,
      fastify,
      services,
      models,
      options,
      log: (...args) => logs.push(args.map(item => (typeof item === 'string' ? item : JSON.stringify(item))).join(' '))
    });
    return { output: output === undefined ? null : output, logs };
  };

  services.action = { register, unregister, get, list, validate, execute, createFormSchema, DIRECTIONS };
});
