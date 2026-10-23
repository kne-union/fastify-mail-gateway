const { expect } = require('chai');
const Fastify = require('fastify');
const { DataTypes } = require('sequelize');

describe('@kne/fastify-mail-gateway 接口文档', function () {
  this.timeout(20000);

  it('所有路由都有 tags、summary，参数都有用途说明，并声明 200 响应', async () => {
    const routes = [];
    const fastify = Fastify({ logger: false });
    fastify.addHook('onRoute', route => route.method !== 'HEAD' && routes.push(route));
    await fastify.register(require('@kne/fastify-sequelize'), {
      db: { dialect: 'sqlite', storage: ':memory:', logging: false },
      modelsPath: false,
      sqlPath: false
    });
    const UserModel = fastify.sequelize.instance.define('user', { id: { type: DataTypes.STRING, primaryKey: true } }, { tableName: 't_user', timestamps: false });
    await fastify.register(require('../index'), {
      syncCronTime: false,
      scheduleCronTime: false,
      secretKey: 'test-secret-key',
      getUserModel: () => UserModel,
      getAuthenticate: () => []
    });
    await fastify.ready();

    const missing = [];
    const checkProps = (where, schema) => {
      if (!schema) return;
      [].concat(schema.oneOf || [], schema.anyOf || [], schema).forEach(item => {
        Object.entries(item.properties || {}).forEach(([key, prop]) => {
          if (!prop.description) missing.push(`${where}.${key}`);
          checkProps(`${where}.${key}`, prop);
          if (prop.items) checkProps(`${where}.${key}[]`, prop.items);
        });
      });
    };
    routes.forEach(route => {
      const { schema = {} } = route;
      const name = `${route.method} ${route.url}`;
      if (!(schema.tags && schema.tags.length)) missing.push(`${name} tags`);
      if (!schema.summary) missing.push(`${name} summary`);
      if (!(schema.response && schema.response[200] && schema.response[200].description)) missing.push(`${name} response`);
      checkProps(`${name} body`, schema.body);
      checkProps(`${name} query`, schema.querystring || schema.query);
      checkProps(`${name} params`, schema.params);
    });
    await fastify.close();
    expect(routes.length).to.equal(59);
    expect(missing).to.deep.equal([]);
  });
});
