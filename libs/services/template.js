const fp = require('fastify-plugin');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createError } = require('../utils/error');
const { renderTemplate, parseTemplateFile } = require('../utils/template');

const LEVEL_SYSTEM = 0;
const LEVEL_CUSTOM = 1;
const CATEGORY_DESCRIPTION_FILE = '_description.txt';

// 文件 / 目录名约定为 {code}_{名称}，没有名称部分时以编码作名称
const parseCodeName = filename => {
  const [code, ...rest] = filename.split('_');
  return { code, name: rest.join('_') || code };
};

const isIgnoredEntry = name => name.startsWith('.') || name.startsWith('_');

module.exports = fp(async (fastify, options) => {
  const { models, services } = fastify[options.name];
  const { Op } = fastify.sequelize.Sequelize;

  const assertCustom = (target, message) => {
    if (Number(target.level) === LEVEL_SYSTEM) {
      throw createError(message, 403);
    }
  };

  /**
   * 分类列表，附带每个分类下的模版数量；uncategorizedCount 为未分类模版数量
   */
  const categoryList = async () => {
    const categories = await models.templateCategory.findAll({
      order: [
        ['sort', 'ASC'],
        ['createdAt', 'ASC']
      ]
    });
    const counts = await models.template.findAll({
      attributes: ['categoryId', [fastify.sequelize.instance.fn('COUNT', fastify.sequelize.instance.col('id')), 'count']],
      group: ['categoryId'],
      raw: true
    });
    const countMap = new Map(counts.map(item => [item.categoryId == null ? null : String(item.categoryId), Number(item.count)]));
    return {
      pageData: categories.map(item => Object.assign(item.get({ plain: true }), { templateCount: countMap.get(String(item.id)) || 0 })),
      totalCount: categories.length,
      uncategorizedCount: countMap.get(null) || 0
    };
  };

  const categoryDetail = async ({ id }) => {
    const category = await models.templateCategory.findByPk(id);
    if (!category) {
      throw createError('模版分类不存在', 404);
    }
    return category;
  };

  const categoryCreate = async ({ name, description, sort }) => {
    return await models.templateCategory.create({ name, description, sort: sort || 0, level: LEVEL_CUSTOM });
  };

  const categorySave = async ({ id, ...data }) => {
    const category = await categoryDetail({ id });
    assertCustom(category, '系统默认分类不可修改');
    ['name', 'description', 'sort'].forEach(key => {
      if (data[key] !== undefined) {
        category[key] = data[key];
      }
    });
    await category.save();
    return category;
  };

  /**
   * 删除分类，分类下的模版转为未分类
   */
  const categoryRemove = async ({ id }) => {
    const category = await categoryDetail({ id });
    assertCustom(category, '系统默认分类不可删除');
    await models.template.update({ categoryId: null }, { where: { categoryId: id } });
    await category.destroy();
  };

  const categorySort = async ({ ids }) => {
    for (let index = 0; index < ids.length; index++) {
      await models.templateCategory.update({ sort: index }, { where: { id: ids[index] } });
    }
  };

  /**
   * 模版列表，filter.categoryId 传 'none' 查询未分类模版
   */
  const list = async ({ filter = {}, perPage = 20, currentPage = 1 } = {}) => {
    const where = {};
    if (filter.categoryId === 'none') {
      where.categoryId = null;
    } else if (filter.categoryId) {
      where.categoryId = filter.categoryId;
    }
    if (filter.status) {
      where.status = filter.status;
    }
    if (filter.level !== undefined && filter.level !== '') {
      where.level = Number(filter.level);
    }
    if (filter.keyword) {
      where[Op.or] = [{ name: { [Op.like]: `%${filter.keyword}%` } }, { subject: { [Op.like]: `%${filter.keyword}%` } }];
    }
    const { rows, count } = await models.template.findAndCountAll({
      where,
      include: [{ model: models.templateCategory, as: 'category', attributes: ['id', 'name'] }],
      offset: perPage * (currentPage - 1),
      limit: perPage,
      order: [
        ['sort', 'ASC'],
        ['createdAt', 'DESC']
      ]
    });
    return { pageData: rows, totalCount: count };
  };

  const detail = async ({ id }) => {
    const template = await models.template.findByPk(id, {
      include: [{ model: models.templateCategory, as: 'category', attributes: ['id', 'name'] }]
    });
    if (!template) {
      throw createError('邮件模版不存在', 404);
    }
    return template;
  };

  const checkCategory = async categoryId => {
    if (categoryId) {
      await categoryDetail({ id: categoryId });
    }
  };

  const create = async ({ categoryId, name, subject, html, description, status, sort }) => {
    await checkCategory(categoryId);
    return await models.template.create({
      categoryId: categoryId || null,
      name,
      subject,
      html,
      description,
      status: status || 'enabled',
      sort: sort || 0,
      level: LEVEL_CUSTOM
    });
  };

  const save = async ({ id, ...data }) => {
    const template = await detail({ id });
    assertCustom(template, '系统默认模版不可修改，可复制后修改副本');
    if (data.categoryId !== undefined) {
      await checkCategory(data.categoryId);
      template.categoryId = data.categoryId || null;
    }
    ['name', 'subject', 'html', 'description', 'status', 'sort'].forEach(key => {
      if (data[key] !== undefined) {
        template[key] = data[key];
      }
    });
    await template.save();
    return template;
  };

  const setStatus = async ({ id, status }) => {
    const template = await detail({ id });
    template.status = status;
    await template.save();
    return template;
  };

  const remove = async ({ id }) => {
    const template = await detail({ id });
    assertCustom(template, '系统默认模版不可删除，可停用');
    await template.destroy();
  };

  const copy = async ({ id }) => {
    const template = await detail({ id });
    const { categoryId, name, subject, html, description, sort } = template.get({ plain: true });
    return await models.template.create({ categoryId, name: `${name}（副本）`, subject, html, description, sort, status: 'disabled', level: LEVEL_CUSTOM });
  };

  const readEntries = async dir => {
    const names = (await fs.readdir(dir)).filter(name => !isIgnoredEntry(name)).sort();
    const entries = [];
    for (const name of names) {
      const stat = await fs.stat(path.join(dir, name));
      entries.push({ name, isDirectory: stat.isDirectory(), isFile: stat.isFile() });
    }
    return entries;
  };

  const readCategoryDescription = async dir => {
    try {
      return (await fs.readFile(path.join(dir, CATEGORY_DESCRIPTION_FILE), 'utf8')).trim();
    } catch (e) {
      return null;
    }
  };

  const upsertSystemCategory = async ({ code, name, description, sort }) => {
    const category = await models.templateCategory.findOne({ where: { code, level: LEVEL_SYSTEM } });
    if (category) {
      Object.assign(category, { name, description });
      await category.save();
      fastify.log.info(`[fastify-mail-gateway] update template category: ${code}`);
      return category;
    }
    fastify.log.info(`[fastify-mail-gateway] create template category: ${code}`);
    return await models.templateCategory.create({ code, name, description, sort, level: LEVEL_SYSTEM });
  };

  const upsertSystemTemplate = async ({ file, categoryId, sort }) => {
    const { code, name } = parseCodeName(path.basename(file, path.extname(file)));
    const { subject, html, description } = parseTemplateFile(await fs.readFile(file, 'utf8'));
    const data = { name, subject, html, description, categoryId };
    const template = await models.template.findOne({ where: { code, level: LEVEL_SYSTEM } });
    if (template) {
      Object.assign(template, data);
      await template.save();
      fastify.log.info(`[fastify-mail-gateway] update template: ${code}`);
      return;
    }
    await models.template.create(Object.assign(data, { code, sort, level: LEVEL_SYSTEM, status: 'enabled' }));
    fastify.log.info(`[fastify-mail-gateway] create template: ${code}`);
  };

  const loadTemplateDir = async dir => {
    if (!dir) {
      return;
    }
    try {
      await fs.access(dir);
    } catch (e) {
      fastify.log.info(`[fastify-mail-gateway] template dir not exists: ${dir}`);
      return;
    }
    fastify.log.info('[fastify-mail-gateway] ------start include template------');
    const entries = await readEntries(dir);
    for (const [index, entry] of entries.entries()) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isFile) {
        await upsertSystemTemplate({ file: entryPath, categoryId: null, sort: index });
        continue;
      }
      if (!entry.isDirectory) {
        continue;
      }
      const category = await upsertSystemCategory(Object.assign(parseCodeName(entry.name), { description: await readCategoryDescription(entryPath), sort: index }));
      const files = (await readEntries(entryPath)).filter(item => item.isFile);
      for (const [fileIndex, item] of files.entries()) {
        await upsertSystemTemplate({ file: path.join(entryPath, item.name), categoryId: category.id, sort: fileIndex });
      }
    }
    fastify.log.info('[fastify-mail-gateway] ------end include template------');
  };

  let includeQueue = Promise.resolve();

  /**
   * 从目录载入系统默认分类与模版（按 code 新建或覆盖名称、主题、正文、说明、所属分类；保留状态与排序）。
   * 子目录 {code}_{名称} 为分类，其中可放 _description.txt 作分类描述；文件 {code}_{名称}.html 为模版，直接放在根目录的为未分类模版。
   * 串行执行，重复调用不会产生重复记录
   */
  const includeTemplate = dir => {
    includeQueue = includeQueue.catch(() => {}).then(() => loadTemplateDir(dir));
    return includeQueue;
  };

  /**
   * 渲染模版：mailId 提供 mail 变量（回复场景），accountId 提供 account 变量，data 为额外变量
   * 返回 { subject, html }；变量值在 html 中会被转义
   */
  const render = async ({ id, template: inlineTemplate, mailId, accountId, data = {} }) => {
    const target = inlineTemplate || (await detail({ id })).get({ plain: true });
    const context = Object.assign({}, data);
    if (mailId) {
      const mail = await services.mail.getInstance({ id: mailId });
      context.mail = mail.get({ plain: true });
    }
    const targetAccountId = accountId || (context.mail && context.mail.accountId);
    if (targetAccountId) {
      context.account = (await services.account.detail({ id: targetAccountId })).get({ plain: true });
    }
    return {
      subject: renderTemplate(target.subject, context),
      html: renderTemplate(target.html, context, { html: true })
    };
  };

  services.template = {
    categoryList,
    categoryDetail,
    categoryCreate,
    categorySave,
    categoryRemove,
    categorySort,
    list,
    detail,
    create,
    save,
    setStatus,
    remove,
    copy,
    render,
    includeTemplate
  };
});
