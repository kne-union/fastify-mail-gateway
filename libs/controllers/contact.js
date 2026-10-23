const fp = require('fastify-plugin');
const { idParams, pageQuery } = require('../utils/schema');
const { userIdOf } = require('../utils/owner');
const { success, empty, contact, page } = require('../schema/response');

const TAG = '邮件网关-联系人';

const contactBody = (required = []) => ({
  type: 'object',
  required,
  properties: {
    name: { type: 'string', description: '联系人名称' },
    address: { type: 'string', format: 'email', description: '邮箱地址，同一用户下不可重复' },
    avatar: { type: 'string', description: '头像文件 id' },
    remark: { type: 'string', description: '备注' }
  }
});

module.exports = fp(async (fastify, options) => {
  const { services } = fastify[options.name];

  fastify.get(
    `${options.prefix}/contacts`,
    {
      onRequest: options.getAuthenticate('contact'),
      schema: {
        tags: [TAG],
        summary: '联系人列表',
        description: '分页查询当前用户的联系人，按创建时间倒序；写信和规则中的地址输入框用它做候选',
        querystring: pageQuery({
          keyword: { type: 'string', description: '按名称、邮箱地址模糊搜索' },
          address: { type: 'string', description: '按邮箱地址精确查询' }
        }),
        response: success('联系人分页列表', page('当前页联系人', contact))
      }
    },
    async request => await services.contact.list(Object.assign({}, request.query, { userId: userIdOf(request) }))
  );

  fastify.post(
    `${options.prefix}/contacts`,
    {
      onRequest: options.getAuthenticate('contact:manage'),
      schema: {
        tags: [TAG],
        summary: '新建联系人',
        description: '新建联系人，邮箱地址统一转小写；已存在时返回 409',
        body: contactBody(['address']),
        response: success('新建的联系人', contact)
      }
    },
    async request => await services.contact.create(Object.assign({}, request.body, { userId: userIdOf(request) }))
  );

  fastify.put(
    `${options.prefix}/contacts/:id`,
    {
      onRequest: options.getAuthenticate('contact:manage'),
      schema: {
        tags: [TAG],
        summary: '修改联系人',
        description: '修改联系人，只更新传入的字段；修改后的邮箱地址与其它联系人重复时返回 409',
        params: idParams,
        body: contactBody(),
        response: success('修改后的联系人', contact)
      }
    },
    async request => await services.contact.save(Object.assign({}, request.body, { id: request.params.id, userId: userIdOf(request) }))
  );

  fastify.delete(
    `${options.prefix}/contacts/:id`,
    {
      onRequest: options.getAuthenticate('contact:manage'),
      schema: { tags: [TAG], summary: '删除联系人', description: '删除联系人', params: idParams, response: empty() }
    },
    async request => {
      await services.contact.remove({ id: request.params.id, userId: userIdOf(request) });
      return {};
    }
  );
});
