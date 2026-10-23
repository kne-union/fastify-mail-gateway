const fp = require('fastify-plugin');
const { idParams } = require('../utils/schema');
const { userIdOf } = require('../utils/owner');
const { success, empty, label } = require('../schema/response');

const TAG = '邮件网关-标签';

const labelBody = (required = []) => ({
  type: 'object',
  required,
  properties: {
    accountId: { type: ['string', 'null'], description: '所属邮箱账号 ID，为空表示当前用户的全部邮箱共用' },
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
        tags: [TAG],
        summary: '标签列表',
        description: '返回当前用户的标签，以及 level 为 0 的系统默认标签，按排序升序。传 accountId 时再限定该邮箱专属标签和共用标签',
        querystring: { type: 'object', properties: { accountId: { type: 'string', description: '邮箱账号 ID' } } },
        response: success('标签列表（不分页）', { type: 'array', items: label })
      }
    },
    async request => await services.label.list({ accountId: request.query.accountId, userId: userIdOf(request) })
  );

  fastify.post(
    `${options.prefix}/labels`,
    {
      onRequest: options.getAuthenticate('label:manage'),
      schema: { tags: [TAG], summary: '新建标签', description: '新建自定义标签；指定 accountId 时须为当前用户的邮箱', body: labelBody(['name']), response: success('新建的标签', label) }
    },
    async request => await services.label.create(Object.assign({}, request.body, { userId: userIdOf(request) }))
  );

  fastify.put(
    `${options.prefix}/labels/:id`,
    {
      onRequest: options.getAuthenticate('label:manage'),
      schema: {
        tags: [TAG],
        summary: '修改标签',
        description: '修改标签，只更新传入的字段；系统默认标签不可修改（403）',
        params: idParams,
        body: labelBody(),
        response: success('修改后的标签', label)
      }
    },
    async request => await services.label.save(Object.assign({}, request.body, { id: request.params.id, userId: userIdOf(request) }))
  );

  fastify.delete(
    `${options.prefix}/labels/:id`,
    {
      onRequest: options.getAuthenticate('label:manage'),
      schema: { tags: [TAG], summary: '删除标签', description: '删除标签并移除邮件上的该标签；系统默认标签不可删除（403）', params: idParams, response: empty() }
    },
    async request => {
      await services.label.remove({ id: request.params.id, userId: userIdOf(request) });
      return {};
    }
  );

  fastify.post(
    `${options.prefix}/labels/sort`,
    {
      onRequest: options.getAuthenticate('label:manage'),
      schema: {
        tags: [TAG],
        summary: '标签排序',
        description: '按传入顺序把 sort 重排为 0、1、2…，可包含系统默认标签，不可见的 ID 忽略',
        body: { type: 'object', required: ['ids'], properties: { ids: { type: 'array', items: { type: 'string' }, description: '标签 ID，按期望顺序排列' } } },
        response: empty()
      }
    },
    async request => {
      await services.label.sort(Object.assign({}, request.body, { userId: userIdOf(request) }));
      return {};
    }
  );
});
