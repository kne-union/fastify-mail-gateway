const fp = require('fastify-plugin');
const { idParams, pageQuery, statusBody } = require('../utils/schema');

const categoryBody = (required = []) => ({
  type: 'object',
  required,
  properties: {
    name: { type: 'string', description: '分类名称' },
    description: { type: 'string', description: '分类描述' },
    sort: { type: 'integer', description: '排序' }
  }
});

const templateBody = (required = []) => ({
  type: 'object',
  required,
  properties: {
    categoryId: { type: ['string', 'null'], description: '分类 ID，为空表示未分类' },
    name: { type: 'string', description: '模版名称' },
    subject: { type: 'string', description: '邮件主题，支持 {{mail.subject}} 等变量' },
    html: { type: 'string', description: '富文本正文，支持 {{mail.from[0].name}}、{{account.name}} 等变量' },
    description: { type: 'string', description: '模版说明' },
    status: { type: 'string', enum: ['enabled', 'disabled'], description: '状态' },
    sort: { type: 'integer', description: '排序' }
  }
});

module.exports = fp(async (fastify, options) => {
  const { services } = fastify[options.name];

  fastify.get(
    `${options.prefix}/template-categories`,
    {
      onRequest: options.getAuthenticate('template'),
      schema: { summary: '模版分类列表', description: '返回全部分类及各分类下的模版数量，uncategorizedCount 为未分类模版数量' }
    },
    async () => await services.template.categoryList()
  );

  fastify.post(
    `${options.prefix}/template-categories`,
    {
      onRequest: options.getAuthenticate('template:manage'),
      schema: { summary: '新建模版分类', description: '新建模版分类', body: categoryBody(['name']) }
    },
    async request => await services.template.categoryCreate(request.body)
  );

  fastify.post(
    `${options.prefix}/template-categories/sort`,
    {
      onRequest: options.getAuthenticate('template:manage'),
      schema: {
        summary: '模版分类排序',
        description: '按传入顺序重排分类',
        body: { type: 'object', required: ['ids'], properties: { ids: { type: 'array', items: { type: 'string' } } } }
      }
    },
    async request => {
      await services.template.categorySort(request.body);
      return {};
    }
  );

  fastify.put(
    `${options.prefix}/template-categories/:id`,
    {
      onRequest: options.getAuthenticate('template:manage'),
      schema: { summary: '修改模版分类', description: '修改模版分类，系统默认分类不可修改（403）', params: idParams, body: categoryBody() }
    },
    async request => await services.template.categorySave(Object.assign({}, request.body, { id: request.params.id }))
  );

  fastify.delete(
    `${options.prefix}/template-categories/:id`,
    {
      onRequest: options.getAuthenticate('template:manage'),
      schema: { summary: '删除模版分类', description: '删除分类，分类下的模版转为未分类；系统默认分类不可删除（403）', params: idParams }
    },
    async request => {
      await services.template.categoryRemove({ id: request.params.id });
      return {};
    }
  );

  fastify.get(
    `${options.prefix}/templates`,
    {
      onRequest: options.getAuthenticate('template'),
      schema: {
        summary: '邮件模版列表',
        description: '分页查询邮件模版，filter.categoryId 传 none 查询未分类模版',
        querystring: pageQuery({
          categoryId: { type: 'string', description: '分类 ID，none 表示未分类' },
          status: { type: 'string', enum: ['enabled', 'disabled'], description: '状态' },
          level: { type: 'integer', enum: [0, 1], description: '级别：0 系统默认，1 自定义' },
          keyword: { type: 'string', description: '按名称、主题模糊搜索' }
        })
      }
    },
    async request => await services.template.list(request.query)
  );

  fastify.post(
    `${options.prefix}/templates/render`,
    {
      onRequest: options.getAuthenticate('template'),
      schema: {
        summary: '渲染邮件模版',
        description: '用邮件、邮箱账号和额外变量渲染模版，返回 { subject, html }；传 template 时渲染未保存的内容（预览）',
        body: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '模版 ID' },
            template: {
              type: 'object',
              description: '未保存的模版内容 { subject, html }，优先于 id',
              properties: { subject: { type: 'string' }, html: { type: 'string' } }
            },
            mailId: { type: 'string', description: '邮件 ID，提供 mail 变量' },
            accountId: { type: 'string', description: '邮箱账号 ID，提供 account 变量；不传时取邮件所属邮箱' },
            data: { type: 'object', additionalProperties: true, description: '额外变量' }
          }
        }
      }
    },
    async request => await services.template.render(request.body)
  );

  fastify.get(
    `${options.prefix}/templates/:id`,
    {
      onRequest: options.getAuthenticate('template'),
      schema: { summary: '邮件模版详情', description: '邮件模版详情', params: idParams }
    },
    async request => await services.template.detail({ id: request.params.id })
  );

  fastify.post(
    `${options.prefix}/templates`,
    {
      onRequest: options.getAuthenticate('template:manage'),
      schema: { summary: '新建邮件模版', description: '新建邮件模版', body: templateBody(['name']) }
    },
    async request => await services.template.create(request.body)
  );

  fastify.put(
    `${options.prefix}/templates/:id`,
    {
      onRequest: options.getAuthenticate('template:manage'),
      schema: { summary: '修改邮件模版', description: '修改邮件模版，系统默认模版不可修改（403），可复制后修改副本', params: idParams, body: templateBody() }
    },
    async request => await services.template.save(Object.assign({}, request.body, { id: request.params.id }))
  );

  fastify.post(
    `${options.prefix}/templates/:id/status`,
    {
      onRequest: options.getAuthenticate('template:manage'),
      schema: { summary: '启用/停用邮件模版', description: '停用后写信与规则中不可选', params: idParams, body: statusBody }
    },
    async request => await services.template.setStatus({ id: request.params.id, status: request.body.status })
  );

  fastify.post(
    `${options.prefix}/templates/:id/copy`,
    {
      onRequest: options.getAuthenticate('template:manage'),
      schema: { summary: '复制邮件模版', description: '复制为停用状态的自定义模版副本', params: idParams }
    },
    async request => await services.template.copy({ id: request.params.id })
  );

  fastify.delete(
    `${options.prefix}/templates/:id`,
    {
      onRequest: options.getAuthenticate('template:manage'),
      schema: { summary: '删除邮件模版', description: '删除邮件模版，系统默认模版不可删除（403）', params: idParams }
    },
    async request => {
      await services.template.remove({ id: request.params.id });
      return {};
    }
  );
});
