const fp = require('fastify-plugin');
const { idParams, pageQuery, statusBody } = require('../utils/schema');

const serverConfig = {
  type: 'object',
  required: ['host', 'port'],
  properties: {
    host: { type: 'string', description: '服务器地址' },
    port: { type: 'integer', description: '端口' },
    secure: { type: 'boolean', default: true, description: '是否使用 SSL/TLS' }
  }
};

const accountBody = (required = []) => ({
  type: 'object',
  required,
  properties: {
    name: { type: 'string', description: '邮箱名称' },
    address: { type: 'string', description: '邮箱地址' },
    username: { type: 'string', description: '登录用户名' },
    password: { type: 'string', description: '密码或授权码，编辑时不传表示不修改' },
    imap: serverConfig,
    smtp: serverConfig,
    skipVerify: { type: 'boolean', description: '跳过连接校验' }
  }
});

module.exports = fp(async (fastify, options) => {
  const { services } = fastify[options.name];

  fastify.get(
    `${options.prefix}/accounts`,
    {
      onRequest: options.getAuthenticate('account'),
      schema: {
        summary: '邮箱账号列表',
        description: '分页获取托管邮箱账号，不返回密码',
        querystring: pageQuery({
          id: { type: 'string', description: '邮箱账号 ID' },
          keyword: { type: 'string', description: '名称或邮箱地址' },
          status: { type: 'string', enum: ['enabled', 'disabled'], description: '状态' }
        })
      }
    },
    async request => {
      const { filter, perPage, currentPage } = request.query;
      return await services.account.list({ filter, perPage: Math.min(perPage, 100), currentPage });
    }
  );

  fastify.get(
    `${options.prefix}/accounts/:id`,
    {
      onRequest: options.getAuthenticate('account'),
      schema: { summary: '邮箱账号详情', description: '获取邮箱账号详情，不返回密码', params: idParams }
    },
    async request => await services.account.detail({ id: request.params.id })
  );

  fastify.post(
    `${options.prefix}/accounts`,
    {
      onRequest: options.getAuthenticate('account:manage'),
      schema: {
        summary: '添加邮箱账号',
        description: '添加托管邮箱，默认会先校验 IMAP 与 SMTP 连通性',
        body: accountBody(['name', 'address', 'username', 'password', 'imap', 'smtp'])
      }
    },
    async request => await services.account.create(Object.assign({}, request.body, { userId: request.userInfo && request.userInfo.id }))
  );

  fastify.put(
    `${options.prefix}/accounts/:id`,
    {
      onRequest: options.getAuthenticate('account:manage'),
      schema: { summary: '修改邮箱账号', description: '修改邮箱账号，连接配置变化时会重新校验连通性', params: idParams, body: accountBody() }
    },
    async request => await services.account.save(Object.assign({}, request.body, { id: request.params.id }))
  );

  fastify.delete(
    `${options.prefix}/accounts/:id`,
    {
      onRequest: options.getAuthenticate('account:manage'),
      schema: { summary: '删除邮箱账号', description: '删除邮箱账号及其邮件和专属标签', params: idParams }
    },
    async request => {
      await services.account.remove({ id: request.params.id });
      return {};
    }
  );

  fastify.post(
    `${options.prefix}/accounts/:id/status`,
    {
      onRequest: options.getAuthenticate('account:manage'),
      schema: { summary: '启停邮箱账号', description: '停用后不再同步和发信', params: idParams, body: statusBody }
    },
    async request => await services.account.setStatus({ id: request.params.id, status: request.body.status })
  );

  fastify.post(
    `${options.prefix}/accounts/test-connection`,
    {
      onRequest: options.getAuthenticate('account:manage'),
      schema: {
        summary: '测试邮箱连接',
        description: '测试 IMAP 与 SMTP 连通性；传 id 时未填写的字段使用已保存配置',
        body: Object.assign(accountBody(), { properties: Object.assign({ id: { type: 'string', description: '已保存的账号 ID' } }, accountBody().properties) })
      }
    },
    async request => await services.account.testConnection(request.body)
  );

  fastify.post(
    `${options.prefix}/accounts/:id/sync`,
    {
      onRequest: options.getAuthenticate('account:manage'),
      schema: { summary: '立即同步邮件', description: '立即从 IMAP 拉取新邮件并执行收信规则', params: idParams }
    },
    async request => await services.sync.syncAccount({ id: request.params.id })
  );
});
