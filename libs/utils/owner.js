const { createError } = require('./error');

const userIdOf = request => {
  const id = request.userInfo && request.userInfo.id;
  if (id == null || id === '') {
    throw createError('未登录', 401);
  }
  return id;
};

/**
 * 自定义数据按 userId 隔离；level 为 0 的系统默认标签/模版/分类全局共用，查询时 OR 进来
 */
const ownedOrSystem = (userId, Op) => ({ [Op.or]: [{ userId }, { level: 0 }] });

const sameUser = (left, right) => left != null && right != null && String(left) === String(right);

const isSystemLevel = row => Number(row && row.level) === 0;

module.exports = { userIdOf, ownedOrSystem, sameUser, isSystemLevel };
