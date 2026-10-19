const fp = require('fastify-plugin');
const { idParams, pageQuery } = require('../utils/schema');
const { userIdOf } = require('../utils/owner');

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
        summary: '联系人列表',
        description: '分页查询联系人，写信和规则中的地址输入框用它做候选',
        querystring: pageQuery({
          keyword: { type: 'string', description: '按名称、邮箱地址模糊搜索' },
          address: { type: 'string', description: '按邮箱地址精确查询' }
        })
      }
    },
    async request => await services.contact.list(Object.assign({}, request.query, { userId: userIdOf(request) }))
  );

  fastify.post(
    `${options.prefix}/contacts`,
    {
      onRequest: options.getAuthenticate('contact:manage'),
      schema: { summary: '新建联系人', description: '新建联系人，邮箱地址已存在时返回 409', body: contactBody(['address']) }
    },
    async request => await services.contact.create(Object.assign({}, request.body, { userId: userIdOf(request) }))
  );

  fastify.put(
    `${options.prefix}/contacts/:id`,
    {
      onRequest: options.getAuthenticate('contact:manage'),
      schema: { summary: '修改联系人', description: '修改联系人', params: idParams, body: contactBody() }
    },
    async request => await services.contact.save(Object.assign({}, request.body, { id: request.params.id, userId: userIdOf(request) }))
  );

  fastify.delete(
    `${options.prefix}/contacts/:id`,
    {
      onRequest: options.getAuthenticate('contact:manage'),
      schema: { summary: '删除联系人', description: '删除联系人', params: idParams }
    },
    async request => {
      await services.contact.remove({ id: request.params.id, userId: userIdOf(request) });
      return {};
    }
  );
});
