module.exports = ({ DataTypes }) => {
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
        type: DataTypes.ENUM('receive', 'send'),
        allowNull: false,
        defaultValue: 'receive',
        comment: '触发方向：receive 收到邮件，send 发出邮件'
      },
      accountIds: {
        type: DataTypes.JSON,
        defaultValue: [],
        comment: '适用的邮箱账号 id 列表，为空表示所有邮箱'
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
        defaultValue: false,
        comment: '命中后是否停止执行后续规则'
      },
      status: {
        type: DataTypes.ENUM('enabled', 'disabled'),
        defaultValue: 'enabled',
        comment: '状态'
      }
    },
    options: {
      comment: '邮件收发规则',
      indexes: [{ fields: ['direction', 'status', 'priority'] }]
    }
  };
};
