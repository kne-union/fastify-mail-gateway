const fp = require('fastify-plugin');
const { idParams, pageQuery, statusBody } = require('../utils/schema');
const { userIdOf } = require('../utils/owner');
const { str, num, obj, arr, success, empty, templateCategory, template, page } = require('../schema/response');

const TAG = '邮件网关-邮件模版';
const CATEGORY_TAG = '邮件网关-模版分类';

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
      schema: {
        tags: [CATEGORY_TAG],
        summary: '模版分类列表',
        description: '返回当前用户的分类与系统默认分类（按排序），及各分类下的模版数量，uncategorizedCount 为未分类模版数量',
        response: success('模版分类列表', {
          type: 'object',
          additionalProperties: true,
          properties: {
            pageData: arr('全部分类', obj('模版分类', Object.assign({}, templateCategory.properties, { templateCount: num('分类下的模版数量') }))),
            totalCount: num('分类总数'),
            uncategorizedCount: num('未分类模版数量')
          }
        })
      }
    },
    async request => await services.template.categoryList({ userId: userIdOf(request) })
  );

  fastify.post(
    `${options.prefix}/template-categories`,
    {
      onRequest: options.getAuthenticate('template:manage'),
      schema: { tags: [CATEGORY_TAG], summary: '新建模版分类', description: '新建自定义模版分类', body: categoryBody(['name']), response: success('新建的分类', templateCategory) }
    },
    async request => await services.template.categoryCreate(Object.assign({}, request.body, { userId: userIdOf(request) }))
  );

  fastify.post(
    `${options.prefix}/template-categories/sort`,
    {
      onRequest: options.getAuthenticate('template:manage'),
      schema: {
        tags: [CATEGORY_TAG],
        summary: '模版分类排序',
        description: '按传入顺序把 sort 重排为 0、1、2…，可包含系统默认分类，不可见的 ID 忽略',
        body: { type: 'object', required: ['ids'], properties: { ids: { type: 'array', items: { type: 'string' }, description: '分类 ID，按期望顺序排列' } } },
        response: empty()
      }
    },
    async request => {
      await services.template.categorySort(Object.assign({}, request.body, { userId: userIdOf(request) }));
      return {};
    }
  );

  fastify.put(
    `${options.prefix}/template-categories/:id`,
    {
      onRequest: options.getAuthenticate('template:manage'),
      schema: {
        tags: [CATEGORY_TAG],
        summary: '修改模版分类',
        description: '修改模版分类，只更新传入的字段；系统默认分类不可修改（403）',
        params: idParams,
        body: categoryBody(),
        response: success('修改后的分类', templateCategory)
      }
    },
    async request => await services.template.categorySave(Object.assign({}, request.body, { id: request.params.id, userId: userIdOf(request) }))
  );

  fastify.delete(
    `${options.prefix}/template-categories/:id`,
    {
      onRequest: options.getAuthenticate('template:manage'),
      schema: { tags: [CATEGORY_TAG], summary: '删除模版分类', description: '删除分类，分类下的模版转为未分类；系统默认分类不可删除（403）', params: idParams, response: empty() }
    },
    async request => {
      await services.template.categoryRemove({ id: request.params.id, userId: userIdOf(request) });
      return {};
    }
  );

  fastify.get(
    `${options.prefix}/templates`,
    {
      onRequest: options.getAuthenticate('template'),
      schema: {
        tags: [TAG],
        summary: '邮件模版列表',
        description: '分页查询当前用户的模版与系统默认模版，按排序升序；filter.categoryId 传 none 查询未分类模版',
        querystring: pageQuery({
          categoryId: { type: 'string', description: '分类 ID，none 表示未分类' },
          status: { type: 'string', enum: ['enabled', 'disabled'], description: '状态' },
          level: { type: 'integer', enum: [0, 1], description: '级别：0 系统默认，1 自定义' },
          keyword: { type: 'string', description: '按名称、主题模糊搜索' }
        }),
        response: success('邮件模版分页列表', page('当前页模版', template))
      }
    },
    async request => await services.template.list(Object.assign({}, request.query, { userId: userIdOf(request) }))
  );

  fastify.post(
    `${options.prefix}/templates/render`,
    {
      onRequest: options.getAuthenticate('template'),
      schema: {
        tags: [TAG],
        summary: '渲染邮件模版',
        description: '用邮件、邮箱账号和额外变量渲染模版，返回 { subject, html }；传 template 时渲染未保存的内容（预览）',
        body: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '模版 ID' },
            template: {
              type: 'object',
              description: '未保存的模版内容 { subject, html }，优先于 id',
              properties: { subject: { type: 'string', description: '主题模版' }, html: { type: 'string', description: '正文模版' } }
            },
            mailId: { type: 'string', description: '邮件 ID，提供 mail 变量' },
            accountId: { type: 'string', description: '邮箱账号 ID，提供 account 变量；不传时取邮件所属邮箱' },
            data: { type: 'object', additionalProperties: true, description: '额外变量' }
          }
        },
        response: success('渲染结果', obj('渲染结果', { subject: str('渲染后的主题'), html: str('渲染后的正文（变量值已 HTML 转义）') }))
      }
    },
    async request => await services.template.render(Object.assign({}, request.body, { userId: userIdOf(request) }))
  );

  fastify.get(
    `${options.prefix}/templates/:id`,
    {
      onRequest: options.getAuthenticate('template'),
      schema: { tags: [TAG], summary: '邮件模版详情', description: '邮件模版详情（含所属分类），不可见时返回 404', params: idParams, response: success('邮件模版', template) }
    },
    async request => await services.template.detail({ id: request.params.id, userId: userIdOf(request) })
  );

  fastify.post(
    `${options.prefix}/templates`,
    {
      onRequest: options.getAuthenticate('template:manage'),
      schema: { tags: [TAG], summary: '新建邮件模版', description: '新建自定义邮件模版，状态默认 enabled', body: templateBody(['name']), response: success('新建的模版', template) }
    },
    async request => await services.template.create(Object.assign({}, request.body, { userId: userIdOf(request) }))
  );

  fastify.put(
    `${options.prefix}/templates/:id`,
    {
      onRequest: options.getAuthenticate('template:manage'),
      schema: {
        tags: [TAG],
        summary: '修改邮件模版',
        description: '修改邮件模版，只更新传入的字段；系统默认模版不可修改（403），可复制后修改副本',
        params: idParams,
        body: templateBody(),
        response: success('修改后的模版', template)
      }
    },
    async request => await services.template.save(Object.assign({}, request.body, { id: request.params.id, userId: userIdOf(request) }))
  );

  fastify.post(
    `${options.prefix}/templates/:id/status`,
    {
      onRequest: options.getAuthenticate('template:manage'),
      schema: {
        tags: [TAG],
        summary: '启用/停用邮件模版',
        description: '停用后写信与规则中不可选；系统默认模版也可启停',
        params: idParams,
        body: statusBody,
        response: success('修改后的模版', template)
      }
    },
    async request => await services.template.setStatus({ id: request.params.id, status: request.body.status, userId: userIdOf(request) })
  );

  fastify.post(
    `${options.prefix}/templates/:id/copy`,
    {
      onRequest: options.getAuthenticate('template:manage'),
      schema: { tags: [TAG], summary: '复制邮件模版', description: '复制为停用状态的自定义模版副本，名称追加「（副本）」', params: idParams, response: success('新建的模版副本', template) }
    },
    async request => await services.template.copy({ id: request.params.id, userId: userIdOf(request) })
  );

  fastify.delete(
    `${options.prefix}/templates/:id`,
    {
      onRequest: options.getAuthenticate('template:manage'),
      schema: { tags: [TAG], summary: '删除邮件模版', description: '删除邮件模版，系统默认模版不可删除（403）', params: idParams, response: empty() }
    },
    async request => {
      await services.template.remove({ id: request.params.id, userId: userIdOf(request) });
      return {};
    }
  );
});
