const fp = require('fastify-plugin');
const { createError } = require('../utils/error');

module.exports = fp(async (fastify, options) => {
  const { models, services } = fastify[options.name];
  const { Op } = fastify.sequelize.Sequelize;

  const normalizeAddress = address =>
    String(address || '')
      .trim()
      .toLowerCase();

  const list = async ({ filter = {}, perPage = 20, currentPage = 1 } = {}) => {
    const where = {};
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

  const detail = async ({ id }) => {
    const contact = await models.contact.findByPk(id);
    if (!contact) {
      throw createError('联系人不存在', 404);
    }
    return contact;
  };

  const checkAddress = async (address, excludeId) => {
    const exists = await models.contact.findOne({ where: { address } });
    if (exists && String(exists.id) !== String(excludeId)) {
      throw createError(`联系人 ${address} 已存在`, 409);
    }
  };

  const create = async ({ name, address, avatar, remark }) => {
    const target = normalizeAddress(address);
    await checkAddress(target);
    return await models.contact.create({ name: name || '', address: target, avatar, remark });
  };

  const save = async ({ id, ...data }) => {
    const contact = await detail({ id });
    if (data.address !== undefined) {
      const target = normalizeAddress(data.address);
      await checkAddress(target, id);
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

  const remove = async ({ id }) => {
    const contact = await detail({ id });
    await contact.destroy();
  };

  services.contact = { list, detail, create, save, remove };
});
