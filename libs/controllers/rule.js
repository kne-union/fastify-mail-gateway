const fp = require('fastify-plugin');
const { userIdOf } = require('../utils/owner');
const { idParams, pageQuery, statusBody } = require('../utils/schema');
const { DIRECTIONS } = require('../utils/direction');
const { num, obj, arr, str, success, empty, rule, ruleLog, ruleTestItem, ruleExecuteItem, meta, page } = require('../schema/response');

const TAG = '邮件网关-收发规则';
const LOG_TAG = '邮件网关-规则执行日志';
const DIRECTION = '触发时机：receive 收信后，beforeSend 发信前，send 发信后，schedule 定时';

const conditionsSchema = {
  type: 'object',
  description: "条件 { match: 'all'|'any', items: [{ field, operator, value } | { type, params }] }",
  properties: {
    match: { type: 'string', enum: ['all', 'any'], default: 'all', description: '组合方式：all 全部满足，any 任一满足' },
    items: {
      type: 'array',
      description: '条件项，为空表示总是命中',
      items: {
        type: 'object',
        properties: {
          field: { type: 'string', description: '内置条件字段：from/to/cc/subject/text/hasAttachment/accountId' },
          operator: { type: 'string', description: '内置条件操作符：contains/notContains/equals/startsWith/endsWith/regex' },
          value: { description: '内置条件比较值' },
          type: { type: 'string', description: '扩展条件类型（services.condition.register 注册），设置后忽略 field/operator/value' },
          params: { type: 'object', additionalProperties: true, description: '扩展条件参数' }
        }
      }
    }
  }
};

const mailIdsProperties = {
  mailId: { type: 'string', description: '单封邮件 ID（与 mailIds 二选一）' },
  mailIds: { type: 'array', items: { type: 'string' }, maxItems: 20, description: '多封邮件 ID，最多 20' }
};

const ruleBody = (required = []) => ({
  type: 'object',
  required,
  properties: {
    name: { type: 'string', description: '规则名称' },
    description: { type: 'string', description: '描述' },
    direction: { type: 'string', enum: DIRECTIONS, description: DIRECTION },
    accountIds: { type: 'array', items: { type: 'string' }, description: '适用邮箱账号，为空表示全部' },
    conditions: conditionsSchema,
    trigger: {
      type: 'object',
      nullable: true,
      description: '定时规则触发配置，仅 schedule 方向必填：时间窗口内未读邮件达到阈值时触发',
      properties: {
        windowDays: { type: 'number', description: '统计时间窗口（天），只统计该时间段内收到的未读邮件' },
        minCount: { type: 'number', description: '未读邮件数量阈值，达到即触发' },
        cooldownMinutes: { type: 'number', description: '两次触发的最短间隔（分钟），默认等于时间窗口' }
      }
    },
    actions: {
      type: 'array',
      description: '动作 [{ type, params }]',
      items: {
        type: 'object',
        required: ['type'],
        properties: {
          type: { type: 'string', description: '动作类型，见可用动作列表' },
          params: { type: 'object', additionalProperties: true, description: '动作参数，按动作的 formSchema 填写' }
        }
      }
    },
    priority: { type: 'integer', description: '优先级，越小越先执行' },
    stopProcessing: { type: 'boolean', description: '命中后停止执行后续规则（流水线已固定短路，默认 true）' },
    status: { type: 'string', enum: ['enabled', 'disabled'], description: '状态' }
  }
});

const batchResult = (description, item, extra = {}) =>
  obj(
    description,
    Object.assign(
      {
        results: arr('逐封结果', item),
        matchedCount: num('命中的邮件数'),
        total: num('邮件总数')
      },
      extra,
      // 只传一封邮件时，单封结果的字段同时展开在顶层，兼容旧调用
      item.properties
    )
  );

module.exports = fp(async (fastify, options) => {
  const { services } = fastify[options.name];

  fastify.get(
    `${options.prefix}/actions`,
    {
      onRequest: options.getAuthenticate('rule'),
      schema: {
        tags: [TAG],
        summary: '可用动作列表',
        description: '返回已注册动作的元数据（内置 + 宿主注册），前端据此渲染动作参数表单',
        querystring: { type: 'object', properties: { direction: { type: 'string', enum: DIRECTIONS, description: `只返回支持该触发时机的动作；${DIRECTION}` } } },
        response: success('动作元数据列表', {
          type: 'array',
          items: Object.assign(meta('动作元数据'), {
            properties: Object.assign({}, meta('动作元数据').properties, { builtIn: { type: 'boolean', nullable: true, description: '是否内置动作' } })
          })
        })
      }
    },
    async request => services.action.list({ direction: request.query.direction })
  );

  fastify.get(
    `${options.prefix}/rules/options`,
    {
      onRequest: options.getAuthenticate('rule'),
      schema: {
        tags: [TAG],
        summary: '条件可选项',
        description: '返回内置条件的字段、操作符，以及已注册扩展条件的元数据（extensions，含 formSchema）',
        querystring: { type: 'object', properties: { direction: { type: 'string', enum: DIRECTIONS, description: `只返回支持该触发时机的扩展条件；${DIRECTION}` } } },
        response: success(
          '条件可选项',
          obj('条件可选项', {
            fields: arr('内置条件字段', str('字段名')),
            operators: arr('内置条件操作符', str('操作符')),
            extensions: arr(
              '扩展条件元数据',
              Object.assign(meta('扩展条件元数据'), {
                properties: Object.assign({}, meta('扩展条件元数据').properties, { timeout: num('判断超时（毫秒）') })
              })
            )
          })
        )
      }
    },
    async request => services.rule.conditionOptions({ direction: request.query.direction })
  );

  fastify.get(
    `${options.prefix}/rules`,
    {
      onRequest: options.getAuthenticate('rule'),
      schema: {
        tags: [TAG],
        summary: '规则列表',
        description: '分页获取当前用户的规则，按优先级升序；perPage 最大 100',
        querystring: pageQuery({
          keyword: { type: 'string', description: '规则名称' },
          direction: { type: 'string', enum: DIRECTIONS, description: DIRECTION },
          status: { type: 'string', enum: ['enabled', 'disabled'], description: '状态' }
        }),
        response: success('规则分页列表', page('当前页规则', rule))
      }
    },
    async request => {
      const { filter, perPage, currentPage } = request.query;
      return await services.rule.list({ filter, perPage: Math.min(perPage, 100), currentPage, userId: userIdOf(request) });
    }
  );

  fastify.get(
    `${options.prefix}/rules/:id`,
    {
      onRequest: options.getAuthenticate('rule'),
      schema: { tags: [TAG], summary: '规则详情', description: '获取当前用户的规则详情，不存在时返回 404', params: idParams, response: success('规则', rule) }
    },
    async request => await services.rule.detail({ id: request.params.id, userId: userIdOf(request) })
  );

  fastify.post(
    `${options.prefix}/rules`,
    {
      onRequest: options.getAuthenticate('rule:manage'),
      schema: {
        tags: [TAG],
        summary: '新建规则',
        description: '新建收发规则，会校验适用邮箱归属、条件、动作配置以及定时规则的触发配置',
        body: ruleBody(['name', 'direction']),
        response: success('新建的规则', rule)
      }
    },
    async request => await services.rule.create(Object.assign({}, request.body, { userId: userIdOf(request) }))
  );

  fastify.put(
    `${options.prefix}/rules/:id`,
    {
      onRequest: options.getAuthenticate('rule:manage'),
      schema: {
        tags: [TAG],
        summary: '修改规则',
        description: '修改收发规则，只更新传入的字段；修改方向时会按新方向重新校验条件、动作和触发配置',
        params: idParams,
        body: ruleBody(),
        response: success('修改后的规则', rule)
      }
    },
    async request => await services.rule.save(Object.assign({}, request.body, { id: request.params.id, userId: userIdOf(request) }))
  );

  fastify.delete(
    `${options.prefix}/rules/:id`,
    {
      onRequest: options.getAuthenticate('rule:manage'),
      schema: { tags: [TAG], summary: '删除规则', description: '删除规则（执行日志保留）', params: idParams, response: empty() }
    },
    async request => {
      await services.rule.remove({ id: request.params.id, userId: userIdOf(request) });
      return {};
    }
  );

  fastify.post(
    `${options.prefix}/rules/:id/status`,
    {
      onRequest: options.getAuthenticate('rule:manage'),
      schema: { tags: [TAG], summary: '启停规则', description: '启用或停用规则', params: idParams, body: statusBody, response: success('修改后的规则', rule) }
    },
    async request => await services.rule.setStatus({ id: request.params.id, status: request.body.status, userId: userIdOf(request) })
  );

  fastify.post(
    `${options.prefix}/rules/sort`,
    {
      onRequest: options.getAuthenticate('rule:manage'),
      schema: {
        tags: [TAG],
        summary: '规则排序',
        description: '按传入顺序把 priority 重排为 0、1、2…，不属于当前用户的 ID 忽略',
        body: { type: 'object', required: ['ids'], properties: { ids: { type: 'array', items: { type: 'string' }, description: '规则 ID，按期望的执行顺序排列' } } },
        response: empty()
      }
    },
    async request => {
      await services.rule.sort(Object.assign({}, request.body, { userId: userIdOf(request) }));
      return {};
    }
  );

  fastify.post(
    `${options.prefix}/rules/test`,
    {
      onRequest: options.getAuthenticate('rule'),
      schema: {
        tags: [TAG],
        summary: '试运行规则',
        description: '判断邮件是否命中规则条件，不执行动作；mailId 与 mailIds 二选一（最多 20 封）；可传 id 使用已保存规则，也可直接传 conditions/accountIds',
        body: {
          type: 'object',
          properties: Object.assign({ id: { type: 'string', description: '规则 ID' } }, mailIdsProperties, {
            conditions: Object.assign({}, conditionsSchema, { description: `${conditionsSchema.description}；传入时覆盖已保存规则的条件` }),
            accountIds: { type: 'array', items: { type: 'string' }, description: '适用邮箱账号，传入时覆盖已保存规则的适用范围，为空表示全部' },
            direction: { type: 'string', enum: DIRECTIONS, description: '传入 conditions 时按该方向校验扩展条件，默认取规则方向或 receive' }
          })
        },
        response: success('试运行结果；只传一封邮件时，该封的 mailId/subject/matched/accountMatched/details 同时展开在顶层', batchResult('试运行结果', ruleTestItem))
      }
    },
    async request => await services.rule.test(Object.assign({}, request.body, { userId: userIdOf(request) }))
  );

  fastify.post(
    `${options.prefix}/rules/:id/execute`,
    {
      onRequest: options.getAuthenticate('rule:manage'),
      schema: {
        tags: [TAG],
        summary: '手动执行规则',
        description: '对指定邮件求值已保存规则，命中则执行规则动作并写执行日志；mailId 与 mailIds 二选一（最多 20 封）；未命中不执行，不受规则启停状态影响；发信前和定时规则不支持',
        params: idParams,
        body: { type: 'object', properties: mailIdsProperties },
        response: success('执行结果；只传一封邮件时，该封结果同时展开在顶层', batchResult('执行结果', ruleExecuteItem, { executedCount: num('实际执行了动作的邮件数') }))
      }
    },
    async request => await services.rule.execute({ id: request.params.id, mailId: request.body.mailId, mailIds: request.body.mailIds, userId: userIdOf(request) })
  );

  fastify.get(
    `${options.prefix}/rule-logs`,
    {
      onRequest: options.getAuthenticate('rule'),
      schema: {
        tags: [LOG_TAG],
        summary: '规则执行日志',
        description: '分页获取当前用户命中规则的执行记录，按创建时间倒序；perPage 最大 100',
        querystring: pageQuery({
          ruleId: { type: 'string', description: '规则 ID' },
          mailId: { type: 'string', description: '邮件 ID' },
          accountId: { type: 'string', description: '邮箱账号 ID' },
          direction: { type: 'string', enum: DIRECTIONS, description: DIRECTION },
          status: { type: 'string', enum: ['success', 'partial', 'failed'], description: '执行结果：success 全部动作成功，partial 部分失败，failed 全部失败' }
        }),
        response: success('执行日志分页列表', page('当前页日志', ruleLog))
      }
    },
    async request => {
      const { filter, perPage, currentPage } = request.query;
      return await services.rule.logList({ filter, perPage: Math.min(perPage, 100), currentPage, userId: userIdOf(request) });
    }
  );
});
