const fp = require('fastify-plugin');
const path = require('node:path');

module.exports = fp(
  async (fastify, options) => {
    options = Object.assign(
      {},
      {
        name: 'mailGateway',
        dbTableNamePrefix: 't_',
        prefix: '/api/v1/mail-gateway',
        syncCronTime: '*/5 * * * *',
        syncBatchSize: 50,
        inboxPath: 'INBOX',
        secretKey: null,
        templateDir: null,
        /** 系统默认全局标签 [{ code, name, color, sort? }]，启动时按 code 载入 / 覆盖 */
        defaultLabels: null,
        actions: {},
        conditions: {},
        onReceive: null,
        beforeSend: null,
        afterSend: null,
        createImapClient: null,
        createTransport: null,
        uploadAttachment: async ({ filename, contentType, content }) => {
          if (!fastify.fileManager) {
            return null;
          }
          const file = await fastify.fileManager.services.fileRecord.uploadToFileSystem({
            file: { filename, mimetype: contentType, encoding: '7bit', toBuffer: async () => content }
          });
          return { id: file.id, filename, contentType, size: content ? content.length : 0 };
        },
        resolveAttachment: async attachment => {
          if (attachment.id && fastify.fileManager) {
            const file = await fastify.fileManager.services.fileRecord.getFileBlob({ id: attachment.id });
            return { filename: attachment.filename || file.filename, content: file.buffer, contentType: attachment.contentType };
          }
          if (attachment.url) {
            return { filename: attachment.filename, path: attachment.url };
          }
          return null;
        },
        getUserModel: () => {
          if (!fastify.account) {
            throw new Error('fastify-account plugin must be registered before fastify-mail-gateway,or set options.getUserModel');
          }
          return fastify.account.models.user;
        },
        getAuthenticate: () => {
          if (!fastify.account) {
            return [
              () => {
                throw new Error('fastify-account plugin must be registered before fastify-mail-gateway,or set options.getAuthenticate');
              }
            ];
          }
          const { authenticate } = fastify.account;
          return [authenticate.user, authenticate.admin];
        }
      },
      options
    );

    if (!options.secretKey) {
      fastify.log.warn('[fastify-mail-gateway] options.secretKey 未设置，邮箱密码将使用内置默认密钥加密，生产环境请务必配置');
    }

    if (options.syncCronTime && !fastify.hasDecorator('cron')) {
      const cronPlugin = require('fastify-cron');
      await fastify.register(cronPlugin.default || cronPlugin);
    }

    fastify.register(require('@kne/fastify-namespace'), {
      options,
      name: options.name,
      modules: [
        ['controllers', path.resolve(__dirname, './libs/controllers')],
        [
          'models',
          await fastify.sequelize.addModels(path.resolve(__dirname, './libs/models'), {
            prefix: options.dbTableNamePrefix,
            getUserModel: options.getUserModel,
            modelPrefix: options.name
          })
        ],
        ['services', path.resolve(__dirname, './libs/services')]
      ]
    });

    fastify.register(
      fp(async fastify => {
        const { services } = fastify[options.name];
        require('./libs/actions')({ register: services.action.register, createFormSchema: services.action.createFormSchema, options });
        Object.entries(options.actions || {}).forEach(([type, action]) => {
          services.action.register(type, action);
        });
        Object.entries(options.conditions || {}).forEach(([type, condition]) => {
          services.condition.register(type, condition);
        });

        fastify.sequelize.syncPromise
          .then(() => services.ownership.prepare())
          .then(() => (options.templateDir ? services.template.includeTemplate(options.templateDir) : null))
          .then(() => (Array.isArray(options.defaultLabels) && options.defaultLabels.length > 0 ? services.label.includeDefaultLabels(options.defaultLabels) : null))
          .catch(e => fastify.log.error(e, '[fastify-mail-gateway] 初始化用户隔离或系统默认数据失败'));

        if (options.syncCronTime) {
          fastify.cron.createJob({
            cronTime: options.syncCronTime,
            onTick: async () => {
              try {
                await services.sync.syncAll();
              } catch (e) {
                fastify.log.error(e, '[fastify-mail-gateway] 定时同步邮件失败');
              }
            },
            start: true
          });
        }
      })
    );
  },
  {
    name: 'fastify-mail-gateway'
  }
);
