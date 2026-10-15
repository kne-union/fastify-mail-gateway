const fp = require('fastify-plugin');
const { idParams } = require('../utils/schema');

const labelBody = (required = []) => ({
  type: 'object',
  required,
  properties: {
    accountId: { type: ['string', 'null'], description: '所属邮箱账号 ID，为空表示全局标签' },
    name: { type: 'string', description: '标签名称' },
    color: { type: 'string', description: '颜色' },
    sort: { type: 'integer', description: '排序' }
  }
});

module.exports = fp(async (fastify, options) => {
  const { services } = fastify[options.name];

  fastify.get(
    `${options.prefix}/labels`,
    {
      onRequest: options.getAuthenticate('label'),
      schema: {
        summary: '标签列表',
        description: '传 accountId 时返回该邮箱专属标签和全局标签，不传返回全部',
        querystring: { type: 'object', properties: { accountId: { type: 'string', description: '邮箱账号 ID' } } }
      }
    },
    async request => await services.label.list({ accountId: request.query.accountId })
  );

  fastify.post(
    `${options.prefix}/labels`,
    {
      onRequest: options.getAuthenticate('label:manage'),
      schema: { summary: '新建标签', description: '新建标签', body: labelBody(['name']) }
    },
    async request => await services.label.create(request.body)
  );

  fastify.put(
    `${options.prefix}/labels/:id`,
    {
      onRequest: options.getAuthenticate('label:manage'),
      schema: { summary: '修改标签', description: '修改标签', params: idParams, body: labelBody() }
    },
    async request => await services.label.save(Object.assign({}, request.body, { id: request.params.id }))
  );

  fastify.delete(
    `${options.prefix}/labels/:id`,
    {
      onRequest: options.getAuthenticate('label:manage'),
      schema: { summary: '删除标签', description: '删除标签并移除邮件上的该标签', params: idParams }
    },
    async request => {
      await services.label.remove({ id: request.params.id });
      return {};
    }
  );

  fastify.post(
    `${options.prefix}/labels/sort`,
    {
      onRequest: options.getAuthenticate('label:manage'),
      schema: {
        summary: '标签排序',
        description: '按传入顺序重排标签',
        body: { type: 'object', required: ['ids'], properties: { ids: { type: 'array', items: { type: 'string' } } } }
      }
    },
    async request => {
      await services.label.sort(request.body);
      return {};
    }
  );
});
