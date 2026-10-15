const fp = require('fastify-plugin');
const { createError } = require('../utils/error');

module.exports = fp(async (fastify, options) => {
  const { models, services } = fastify[options.name];
  const { Op } = fastify.sequelize.Sequelize;

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
    return await models.label.create({ accountId: accountId || null, name, color, sort: sort || 0 });
  };

  const save = async ({ id, ...data }) => {
    const label = await detail({ id });
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

  services.label = { list, detail, create, save, remove, sort };
});
