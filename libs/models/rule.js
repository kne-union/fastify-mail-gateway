const { DIRECTIONS } = require('../utils/direction');

module.exports = ({ DataTypes, options }) => {
  return {
    model: {
      name: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: '规则名称'
      },
      description: {
        type: DataTypes.TEXT,
        comment: '描述'
      },
      direction: {
        type: DataTypes.ENUM(...DIRECTIONS),
        allowNull: false,
        defaultValue: 'receive',
        comment: '触发时机：receive 收信后，beforeSend 发信前（可拦截或修改），send 发信后'
      },
      accountIds: {
        type: DataTypes.JSON,
        defaultValue: [],
        comment: '适用的邮箱账号 id 列表，为空表示该用户的全部邮箱'
      },
      conditions: {
        type: DataTypes.JSON,
        defaultValue: { match: 'all', items: [] },
        comment: "条件 { match: 'all'|'any', items: [{ field, operator, value }] }，items 为空表示总是命中"
      },
      actions: {
        type: DataTypes.JSON,
        defaultValue: [],
        comment: '动作 [{ type, params }]，按顺序执行'
      },
      priority: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: '优先级，越小越先执行'
      },
      stopProcessing: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
        comment: '命中后是否停止执行后续规则（流水线已固定短路，此字段保留兼容）'
      },
      status: {
        type: DataTypes.ENUM('enabled', 'disabled'),
        defaultValue: 'enabled',
        comment: '状态'
      }
    },
    associate: ({ rule }) => {
      rule.belongsTo(options.getUserModel(), { foreignKey: 'userId', as: 'user', constraints: false, comment: '所属用户' });
    },
    options: {
      comment: '邮件收发规则，按用户隔离',
      indexes: [{ fields: ['user_id'] }, { fields: ['direction', 'status', 'priority'] }]
    }
  };
};
