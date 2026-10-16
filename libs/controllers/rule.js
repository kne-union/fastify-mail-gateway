const fp = require('fastify-plugin');
const { idParams, pageQuery, statusBody } = require('../utils/schema');

const conditionsSchema = {
  type: 'object',
  description: "条件 { match: 'all'|'any', items: [{ field, operator, value } | { type, params }] }",
  properties: {
    match: { type: 'string', enum: ['all', 'any'], default: 'all' },
    items: {
      type: 'array',
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

const ruleBody = (required = []) => ({
  type: 'object',
  required,
  properties: {
    name: { type: 'string', description: '规则名称' },
    description: { type: 'string', description: '描述' },
    direction: { type: 'string', enum: ['receive', 'send'], description: '触发方向' },
    accountIds: { type: 'array', items: { type: 'string' }, description: '适用邮箱账号，为空表示全部' },
    conditions: conditionsSchema,
    actions: {
      type: 'array',
      description: '动作 [{ type, params }]',
      items: {
        type: 'object',
        required: ['type'],
        properties: { type: { type: 'string' }, params: { type: 'object', additionalProperties: true } }
      }
    },
    priority: { type: 'integer', description: '优先级，越小越先执行' },
    stopProcessing: { type: 'boolean', description: '命中后停止执行后续规则（流水线已固定短路，默认 true）' },
    status: { type: 'string', enum: ['enabled', 'disabled'], description: '状态' }
  }
});

module.exports = fp(async (fastify, options) => {
  const { services } = fastify[options.name];

  fastify.get(
    `${options.prefix}/actions`,
    {
      onRequest: options.getAuthenticate('rule'),
      schema: {
        summary: '可用动作列表',
        description: '返回已注册动作的元数据（内置 + 宿主注册），前端据此渲染动作参数表单',
        querystring: { type: 'object', properties: { direction: { type: 'string', enum: ['receive', 'send'] } } }
      }
    },
    async request => services.action.list({ direction: request.query.direction })
  );

  fastify.get(
    `${options.prefix}/rules/options`,
    {
      onRequest: options.getAuthenticate('rule'),
      schema: {
        summary: '条件可选项',
        description: '返回内置条件的字段、操作符，以及已注册扩展条件的元数据（extensions，含 formSchema）',
        querystring: { type: 'object', properties: { direction: { type: 'string', enum: ['receive', 'send'] } } }
      }
    },
    async request => services.rule.conditionOptions({ direction: request.query.direction })
  );

  fastify.get(
    `${options.prefix}/rules`,
    {
      onRequest: options.getAuthenticate('rule'),
      schema: {
        summary: '规则列表',
        description: '按优先级分页获取规则',
        querystring: pageQuery({
          keyword: { type: 'string', description: '规则名称' },
          direction: { type: 'string', enum: ['receive', 'send'] },
          status: { type: 'string', enum: ['enabled', 'disabled'] }
        })
      }
    },
    async request => {
      const { filter, perPage, currentPage } = request.query;
      return await services.rule.list({ filter, perPage: Math.min(perPage, 100), currentPage });
    }
  );

  fastify.get(
    `${options.prefix}/rules/:id`,
    {
      onRequest: options.getAuthenticate('rule'),
      schema: { summary: '规则详情', description: '规则详情', params: idParams }
    },
    async request => await services.rule.detail({ id: request.params.id })
  );

  fastify.post(
    `${options.prefix}/rules`,
    {
      onRequest: options.getAuthenticate('rule:manage'),
      schema: { summary: '新建规则', description: '新建收发规则，会校验条件和动作配置', body: ruleBody(['name', 'direction']) }
    },
    async request => await services.rule.create(request.body)
  );

  fastify.put(
    `${options.prefix}/rules/:id`,
    {
      onRequest: options.getAuthenticate('rule:manage'),
      schema: { summary: '修改规则', description: '修改收发规则', params: idParams, body: ruleBody() }
    },
    async request => await services.rule.save(Object.assign({}, request.body, { id: request.params.id }))
  );

  fastify.delete(
    `${options.prefix}/rules/:id`,
    {
      onRequest: options.getAuthenticate('rule:manage'),
      schema: { summary: '删除规则', description: '删除规则', params: idParams }
    },
    async request => {
      await services.rule.remove({ id: request.params.id });
      return {};
    }
  );

  fastify.post(
    `${options.prefix}/rules/:id/status`,
    {
      onRequest: options.getAuthenticate('rule:manage'),
      schema: { summary: '启停规则', description: '启用或停用规则', params: idParams, body: statusBody }
    },
    async request => await services.rule.setStatus({ id: request.params.id, status: request.body.status })
  );

  fastify.post(
    `${options.prefix}/rules/sort`,
    {
      onRequest: options.getAuthenticate('rule:manage'),
      schema: {
        summary: '规则排序',
        description: '按传入顺序重排优先级',
        body: { type: 'object', required: ['ids'], properties: { ids: { type: 'array', items: { type: 'string' } } } }
      }
    },
    async request => {
      await services.rule.sort(request.body);
      return {};
    }
  );

  fastify.post(
    `${options.prefix}/rules/test`,
    {
      onRequest: options.getAuthenticate('rule'),
      schema: {
        summary: '试运行规则',
        description: '判断邮件是否命中规则条件，不执行动作；mailId 与 mailIds 二选一（最多 20 封）；可传 id 使用已保存规则，也可直接传 conditions/accountIds',
        body: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '规则 ID' },
            mailId: { type: 'string', description: '单封邮件 ID（与 mailIds 二选一）' },
            mailIds: { type: 'array', items: { type: 'string' }, maxItems: 20, description: '多封邮件 ID，最多 20' },
            conditions: conditionsSchema,
            accountIds: { type: 'array', items: { type: 'string' } },
            direction: { type: 'string', enum: ['receive', 'send'], description: '传入 conditions 时按该方向校验扩展条件，默认取规则方向或 receive' }
          }
        }
      }
    },
    async request => await services.rule.test(request.body)
  );

  fastify.post(
    `${options.prefix}/rules/:id/execute`,
    {
      onRequest: options.getAuthenticate('rule:manage'),
      schema: {
        summary: '手动执行规则',
        description: '对指定邮件求值已保存规则，命中则执行规则动作并写执行日志；mailId 与 mailIds 二选一（最多 20 封）；未命中不执行，不受规则启停状态影响',
        params: idParams,
        body: {
          type: 'object',
          properties: {
            mailId: { type: 'string', description: '单封邮件 ID（与 mailIds 二选一）' },
            mailIds: { type: 'array', items: { type: 'string' }, maxItems: 20, description: '多封邮件 ID，最多 20' }
          }
        }
      }
    },
    async request => await services.rule.execute({ id: request.params.id, mailId: request.body.mailId, mailIds: request.body.mailIds })
  );

  fastify.get(
    `${options.prefix}/rule-logs`,
    {
      onRequest: options.getAuthenticate('rule'),
      schema: {
        summary: '规则执行日志',
        description: '分页获取命中规则的执行记录',
        querystring: pageQuery({
          ruleId: { type: 'string' },
          mailId: { type: 'string' },
          accountId: { type: 'string' },
          direction: { type: 'string', enum: ['receive', 'send'] },
          status: { type: 'string', enum: ['success', 'partial', 'failed'] }
        })
      }
    },
    async request => {
      const { filter, perPage, currentPage } = request.query;
      return await services.rule.logList({ filter, perPage: Math.min(perPage, 100), currentPage });
    }
  );
});
