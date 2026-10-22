const Fastify = require('fastify');
const { DataTypes } = require('sequelize');
const qs = require('qs');
const { createMockImapFactory } = require('./mock-imap');

const createTestUserModel = sequelize => {
  return sequelize.define(
    'user',
    {
      id: { type: DataTypes.STRING, primaryKey: true },
      username: { type: DataTypes.STRING }
    },
    { tableName: 't_user', timestamps: false }
  );
};

const createFastify = async (options = {}) => {
  const fastify = Fastify({
    routerOptions: {
      querystringParser: str => qs.parse(str)
    }
  });

  await fastify.register(require('@kne/fastify-sequelize'), {
    db: { dialect: 'sqlite', storage: ':memory:', logging: false },
    modelsPath: false,
    sqlPath: false
  });

  const UserModel = createTestUserModel(fastify.sequelize.instance);
  const imap = createMockImapFactory();
  const sentMails = [];
  fastify.decorate('testContext', { imap, sentMails });

  fastify.addHook('onRequest', async request => {
    request.userInfo = { id: request.headers['x-test-user'] || '1' };
  });

  await fastify.register(require('../../index'), {
    prefix: '/api/mail-gateway',
    syncCronTime: false,
    scheduleCronTime: false,
    secretKey: 'test-secret-key',
    getUserModel: () => UserModel,
    getAuthenticate: () => [],
    createImapClient: imap.create,
    createTransport: () => ({
      verify: async () => true,
      sendMail: async mail => {
        sentMails.push(mail);
        return { messageId: `<sent-${sentMails.length}@test.local>` };
      },
      close: () => {}
    }),
    uploadAttachment: async ({ filename, contentType, content }) => ({ id: `file-${filename}`, filename, contentType, size: content.length }),
    resolveAttachment: async attachment => ({ filename: attachment.filename, content: Buffer.from('mock') }),
    ...options
  });

  await fastify.ready();
  await fastify.sequelize.sync({ force: true });

  return fastify;
};

const accountPayload = (overrides = {}) =>
  Object.assign(
    {
      name: '测试邮箱',
      address: 'bot@test.local',
      username: 'bot@test.local',
      password: 'p@ss',
      imap: { host: 'imap.test.local', port: 993, secure: true },
      smtp: { host: 'smtp.test.local', port: 465, secure: true }
    },
    overrides
  );

module.exports = { createFastify, accountPayload };
