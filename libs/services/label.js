const fp = require('fastify-plugin');
const { createError } = require('../utils/error');

const LEVEL_SYSTEM = 0;
const LEVEL_CUSTOM = 1;

module.exports = fp(async (fastify, options) => {
  const { models, services } = fastify[options.name];
  const { Op } = fastify.sequelize.Sequelize;

  const assertCustom = (target, message) => {
    if (Number(target.level) === LEVEL_SYSTEM) {
      throw createError(message, 403);
    }
  };

  /**
   * 列出标签：传 accountId 时返回该邮箱专属标签 + 全局标签
   */
  const list = async ({ accountId } = {}) => {
    const where = accountId ? { [Op.or]: [{ accountId }, { accountId: null }] } : {};
    return await models.label.findAll({
      where,
      order: [
        ['sort', 'ASC'],
        ['createdAt', 'ASC']
      ]
    });
  };

  const detail = async ({ id }) => {
    const label = await models.label.findByPk(id);
    if (!label) {
      throw createError('标签不存在', 404);
    }
    return label;
  };

  const create = async ({ accountId, name, color, sort }) => {
    return await models.label.create({
      accountId: accountId || null,
      name,
      color,
      sort: sort || 0,
      level: LEVEL_CUSTOM
    });
  };

  const save = async ({ id, ...data }) => {
    const label = await detail({ id });
    assertCustom(label, '系统默认标签不可修改');
    ['name', 'color', 'sort'].forEach(key => {
      if (data[key] !== undefined) {
        label[key] = data[key];
      }
    });
    if (data.accountId !== undefined) {
      label.accountId = data.accountId || null;
    }
    await label.save();
    return label;
  };

  const remove = async ({ id }) => {
    const label = await detail({ id });
    assertCustom(label, '系统默认标签不可删除');
    await models.mailLabel.destroy({ where: { labelId: id } });
    await label.destroy();
  };

  /**
   * 按传入顺序重排标签
   */
  const sort = async ({ ids }) => {
    for (let index = 0; index < ids.length; index++) {
      await models.label.update({ sort: index }, { where: { id: ids[index] } });
    }
  };

  /**
   * 已有库升级：补齐 code / level 列（SQLite sync 默认不 ALTER）
   */
  const ensureSystemColumns = async () => {
    const queryInterface = models.label.sequelize.getQueryInterface();
    const tableName = models.label.getTableName();
    const table = typeof tableName === 'object' ? tableName.tableName : tableName;
    const schema = typeof tableName === 'object' ? tableName.schema : undefined;
    const describe = await queryInterface.describeTable(table, schema ? { schema } : undefined);
    if (!describe.code) {
      await queryInterface.addColumn(table, 'code', { type: fastify.sequelize.Sequelize.DataTypes.STRING, allowNull: true }, schema ? { schema } : undefined);
      fastify.log.info('[fastify-mail-gateway] label 表补齐列 code');
    }
    if (!describe.level) {
      await queryInterface.addColumn(
        table,
        'level',
        { type: fastify.sequelize.Sequelize.DataTypes.INTEGER, allowNull: true, defaultValue: LEVEL_CUSTOM },
        schema ? { schema } : undefined
      );
      fastify.log.info('[fastify-mail-gateway] label 表补齐列 level');
    }
  };

  /**
   * 载入系统默认全局标签：按 code + level:0 新建或覆盖名称、颜色；保留排序
   * items: [{ code, name, color, sort? }]
   */
  const includeDefaultLabels = async (items = []) => {
    if (!Array.isArray(items) || items.length === 0) {
      return;
    }
    await ensureSystemColumns();
    fastify.log.info('[fastify-mail-gateway] ------start include default labels------');
    for (const [index, item] of items.entries()) {
      const code = String(item.code || '').trim();
      const name = String(item.name || '').trim();
      if (!code || !name) {
        continue;
      }
      const data = {
        name,
        color: item.color || null,
        accountId: null,
        level: LEVEL_SYSTEM
      };
      const existing = await models.label.findOne({ where: { code, level: LEVEL_SYSTEM } });
      if (existing) {
        Object.assign(existing, data);
        await existing.save();
        fastify.log.info(`[fastify-mail-gateway] update default label: ${code}`);
        continue;
      }
      await models.label.create(
        Object.assign(data, {
          code,
          sort: Number.isInteger(item.sort) ? item.sort : index
        })
      );
      fastify.log.info(`[fastify-mail-gateway] create default label: ${code}`);
    }
    fastify.log.info('[fastify-mail-gateway] ------end include default labels------');
  };

  services.label = { list, detail, create, save, remove, sort, includeDefaultLabels, ensureSystemColumns };
});
