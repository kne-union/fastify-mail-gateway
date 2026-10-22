const { DIRECTIONS } = require('../utils/direction');

module.exports = ({ DataTypes, definePrimaryType, options }) => {
  return {
    model: {
      ruleId: definePrimaryType('ruleId', {
        allowNull: false,
        comment: '规则'
      }),
      mailId: definePrimaryType('mailId', {
        comment: '邮件；发信前规则拦截的邮件未入库、定时规则处理一批邮件时为空'
      }),
      mailIds: {
        type: DataTypes.JSON,
        comment: '定时规则本次处理的邮件 id 列表'
      },
      accountId: definePrimaryType('accountId', {
        comment: '邮箱账号'
      }),
      direction: {
        type: DataTypes.ENUM(...DIRECTIONS),
        comment: '触发时机'
      },
      status: {
        type: DataTypes.ENUM('success', 'partial', 'failed'),
        defaultValue: 'success',
        comment: '执行结果：success 全部动作成功，partial 部分失败，failed 全部失败'
      },
      results: {
        type: DataTypes.JSON,
        defaultValue: [],
        comment: '各动作执行结果 [{ type, success, output, error }]'
      },
      executionTime: {
        type: DataTypes.INTEGER,
        comment: '执行耗时（毫秒）'
      }
    },
    associate: ({ ruleLog, rule, mail }) => {
      ruleLog.belongsTo(rule, { foreignKey: 'ruleId', as: 'rule', constraints: false });
      ruleLog.belongsTo(mail, { foreignKey: 'mailId', as: 'mail', constraints: false });
      ruleLog.belongsTo(options.getUserModel(), { foreignKey: 'userId', as: 'user', constraints: false, comment: '所属用户' });
    },
    options: {
      comment: '规则执行日志（仅记录命中的规则）',
      indexes: [{ fields: ['rule_id'] }, { fields: ['mail_id'] }, { fields: ['created_at'] }]
    }
  };
};
