const fp = require('fastify-plugin');

const USER_SCOPED = ['contact', 'label', 'template', 'templateCategory', 'rule', 'ruleLog'];

module.exports = fp(async (fastify, options) => {
  const { models } = fastify[options.name];
  const { Op, DataTypes } = fastify.sequelize.Sequelize;

  const tableOf = model => {
    const tableName = model.getTableName();
    return {
      table: typeof tableName === 'object' ? tableName.tableName : tableName,
      schema: typeof tableName === 'object' ? tableName.schema : undefined
    };
  };

  const ensureUserColumn = async model => {
    const queryInterface = model.sequelize.getQueryInterface();
    const { table, schema } = tableOf(model);
    const describe = await queryInterface.describeTable(table, schema ? { schema } : undefined);
    if (describe.user_id || describe.userId) {
      return;
    }
    const dialect = model.sequelize.getDialect();
    await queryInterface.addColumn(table, 'user_id', { type: dialect === 'sqlite' ? DataTypes.STRING : DataTypes.BIGINT, allowNull: true }, schema ? { schema } : undefined);
    fastify.log.info(`[fastify-mail-gateway] ${table} 补齐列 user_id`);
  };

  const ensureColumn = async (model, column, attribute, field) => {
    const queryInterface = model.sequelize.getQueryInterface();
    const { table, schema } = tableOf(model);
    const describe = await queryInterface.describeTable(table, schema ? { schema } : undefined);
    if (describe[column] || describe[field]) {
      return;
    }
    await queryInterface.addColumn(table, column, attribute, schema ? { schema } : undefined);
    fastify.log.info(`[fastify-mail-gateway] ${table} 补齐列 ${column}`);
  };

  const ensureDefaultColumn = () => ensureColumn(models.account, 'is_default', { type: DataTypes.BOOLEAN, defaultValue: false }, 'isDefault');

  // 定时规则新增的列；direction 枚举新增 schedule 需由使用方执行 SQL 迁移（sync 不修改已有枚举）
  const ensureScheduleColumns = async () => {
    await ensureColumn(models.rule, 'trigger', { type: DataTypes.JSON }, 'trigger');
    await ensureColumn(models.rule, 'last_triggered_at', { type: DataTypes.DATE }, 'lastTriggeredAt');
    await ensureColumn(models.ruleLog, 'mail_ids', { type: DataTypes.JSON }, 'mailIds');
  };

  const backfillDefault = async () => {
    const { owners } = await accountUserMap();
    for (const userId of owners) {
      if ((await models.account.count({ where: { userId, isDefault: true } })) > 0) {
        continue;
      }
      const first = await models.account.findOne({ where: { userId }, order: [['createdAt', 'ASC']] });
      if (first) {
        first.isDefault = true;
        await first.save();
      }
    }
  };

  const accountUserMap = async () => {
    const accounts = await models.account.findAll({ attributes: ['id', 'userId'], raw: true });
    const byAccount = new Map();
    const owners = [];
    accounts.forEach(item => {
      if (item.userId == null || item.userId === '') {
        return;
      }
      byAccount.set(String(item.id), item.userId);
      if (!owners.some(id => String(id) === String(item.userId))) {
        owners.push(item.userId);
      }
    });
    return { byAccount, owners };
  };

  const assignByAccount = async (model, field) => {
    const { byAccount } = await accountUserMap();
    const rows = await model.findAll({ where: { userId: null, [field]: { [Op.ne]: null } } });
    for (const row of rows) {
      if (Number(row.level) === 0) {
        continue;
      }
      const userId = byAccount.get(String(row[field]));
      if (userId == null) {
        continue;
      }
      row.userId = userId;
      await row.save();
    }
  };

  const assignToUser = async (model, userId, where) => {
    await model.update({ userId }, { where });
  };

  const clonePlain = (row, userId, extra = {}) => {
    const plain = row.get({ plain: true });
    delete plain.id;
    delete plain.createdAt;
    delete plain.updatedAt;
    delete plain.deletedAt;
    return Object.assign(plain, { userId }, extra);
  };

  const remapTemplateId = (value, map) => {
    if (value == null || value === '') {
      return value;
    }
    if (typeof value === 'object') {
      const key = String(value.id || value.value || '');
      if (!map.has(key)) {
        return value;
      }
      const next = map.get(key);
      return Object.assign({}, value, { id: next, value: next });
    }
    return map.has(String(value)) ? map.get(String(value)) : value;
  };

  const cloneSharedCustom = async owners => {
    const categories = await models.templateCategory.findAll({ where: { userId: null, level: { [Op.ne]: 0 } } });
    const templates = await models.template.findAll({ where: { userId: null, level: { [Op.ne]: 0 } } });
    const labels = await models.label.findAll({ where: { userId: null, level: { [Op.ne]: 0 }, accountId: null } });
    const contacts = await models.contact.findAll({ where: { userId: null } });
    const rules = await models.rule.findAll({ where: { userId: null } });
    const { byAccount } = await accountUserMap();

    for (const userId of owners) {
      const categoryMap = new Map();
      for (const category of categories) {
        const created = await models.templateCategory.create(clonePlain(category, userId));
        categoryMap.set(String(category.id), created.id);
      }
      const templateMap = new Map();
      for (const template of templates) {
        const categoryId = template.categoryId && categoryMap.has(String(template.categoryId)) ? categoryMap.get(String(template.categoryId)) : template.categoryId;
        const created = await models.template.create(clonePlain(template, userId, { categoryId }));
        templateMap.set(String(template.id), created.id);
      }
      for (const label of labels) {
        await models.label.create(clonePlain(label, userId));
      }
      for (const contact of contacts) {
        await models.contact.create(clonePlain(contact, userId));
      }
      const ownAccountIds = [...byAccount.entries()].filter(([, owner]) => String(owner) === String(userId)).map(([id]) => id);
      for (const rule of rules) {
        const accountIds = (rule.accountIds || []).map(String).filter(id => ownAccountIds.includes(id));
        const mentioned = (rule.accountIds || []).length > 0;
        if (mentioned && accountIds.length === 0) {
          continue;
        }
        const actions = (rule.actions || []).map(item => {
          if (!item || item.params == null || item.params.templateId == null) {
            return item;
          }
          return Object.assign({}, item, { params: Object.assign({}, item.params, { templateId: remapTemplateId(item.params.templateId, templateMap) }) });
        });
        await models.rule.create(clonePlain(rule, userId, { accountIds: mentioned ? accountIds : [], actions }));
      }
    }

    const destroyIds = async (model, rows) => {
      if (rows.length > 0) {
        await model.destroy({ where: { id: rows.map(item => item.id) } });
      }
    };
    await destroyIds(models.rule, rules);
    await destroyIds(models.contact, contacts);
    await destroyIds(models.label, labels);
    await destroyIds(models.template, templates);
    await destroyIds(models.templateCategory, categories);
  };

  const backfill = async () => {
    await assignByAccount(models.label, 'accountId');
    await assignByAccount(models.ruleLog, 'accountId');
    const { owners } = await accountUserMap();
    if (owners.length === 0) {
      return;
    }
    if (owners.length === 1) {
      const userId = owners[0];
      const custom = { userId: null, level: { [Op.ne]: 0 } };
      await assignToUser(models.contact, userId, { userId: null });
      await assignToUser(models.rule, userId, { userId: null });
      await assignToUser(models.ruleLog, userId, { userId: null });
      await assignToUser(models.label, userId, custom);
      await assignToUser(models.template, userId, custom);
      await assignToUser(models.templateCategory, userId, custom);
      return;
    }
    await cloneSharedCustom(owners);
    const { byAccount } = await accountUserMap();
    const logs = await models.ruleLog.findAll({ where: { userId: null, accountId: { [Op.ne]: null } } });
    for (const log of logs) {
      const userId = byAccount.get(String(log.accountId));
      if (userId != null) {
        log.userId = userId;
        await log.save();
      }
    }
  };

  const prepare = async () => {
    for (const name of USER_SCOPED) {
      if (models[name]) {
        await ensureUserColumn(models[name]);
      }
    }
    await ensureDefaultColumn();
    await ensureScheduleColumns();
    await backfill();
    await backfillDefault();
  };

  fastify[options.name].services.ownership = { prepare, ensureUserColumn, backfill, backfillDefault };
});
