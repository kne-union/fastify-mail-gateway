const fp = require('fastify-plugin');
const { createError } = require('../utils/error');

module.exports = fp(async (fastify, options) => {
  const { models, services } = fastify[options.name];
  const { Op } = fastify.sequelize.Sequelize;

  const normalizeAddress = address =>
    String(address || '')
      .trim()
      .toLowerCase();

  const requireUser = userId => {
    if (userId == null || userId === '') {
      throw createError('未登录', 401);
    }
    return userId;
  };

  const list = async ({ filter = {}, perPage = 20, currentPage = 1, userId } = {}) => {
    const where = { userId: requireUser(userId) };
    if (filter.keyword) {
      where[Op.or] = [{ name: { [Op.like]: `%${filter.keyword}%` } }, { address: { [Op.like]: `%${normalizeAddress(filter.keyword)}%` } }];
    }
    if (filter.address) {
      where.address = normalizeAddress(filter.address);
    }
    const { rows, count } = await models.contact.findAndCountAll({
      where,
      offset: perPage * (currentPage - 1),
      limit: perPage,
      order: [['createdAt', 'DESC']]
    });
    return { pageData: rows, totalCount: count };
  };

  const detail = async ({ id, userId }) => {
    const contact = await models.contact.findOne({ where: { id, userId: requireUser(userId) } });
    if (!contact) {
      throw createError('联系人不存在', 404);
    }
    return contact;
  };

  const checkAddress = async (address, userId, excludeId) => {
    const exists = await models.contact.findOne({ where: { address, userId } });
    if (exists && String(exists.id) !== String(excludeId)) {
      throw createError(`联系人 ${address} 已存在`, 409);
    }
  };

  const create = async ({ name, address, avatar, remark, userId }) => {
    const ownerId = requireUser(userId);
    const target = normalizeAddress(address);
    await checkAddress(target, ownerId);
    return await models.contact.create({ name: name || '', address: target, avatar, remark, userId: ownerId });
  };

  const save = async ({ id, userId, ...data }) => {
    const contact = await detail({ id, userId });
    if (data.address !== undefined) {
      const target = normalizeAddress(data.address);
      await checkAddress(target, userId, id);
      contact.address = target;
    }
    ['name', 'avatar', 'remark'].forEach(key => {
      if (data[key] !== undefined) {
        contact[key] = data[key];
      }
    });
    await contact.save();
    return contact;
  };

  const remove = async ({ id, userId }) => {
    const contact = await detail({ id, userId });
    await contact.destroy();
  };

  services.contact = { list, detail, create, save, remove };
});
