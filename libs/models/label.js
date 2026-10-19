module.exports = ({ DataTypes, definePrimaryType, options }) => {
  return {
    model: {
      accountId: definePrimaryType('accountId', {
        comment: '所属邮箱账号，为空表示该用户的全部邮箱共用；系统默认标签同样为空，且不属于任何用户'
      }),
      code: {
        type: DataTypes.STRING,
        comment: '系统默认标签编码（options.defaultLabels），自定义标签为空'
      },
      name: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: '标签名称，在收件箱中显示为文件夹'
      },
      color: {
        type: DataTypes.STRING,
        comment: '标签颜色'
      },
      level: {
        type: DataTypes.INTEGER,
        defaultValue: 1,
        comment: '级别：0 系统默认（启动时载入，不可修改、删除），1 自定义'
      },
      sort: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: '排序，越小越靠前'
      }
    },
    associate: ({ label, account, mail, mailLabel }) => {
      label.belongsTo(account, { foreignKey: 'accountId', as: 'account', constraints: false });
      label.belongsTo(options.getUserModel(), { foreignKey: 'userId', as: 'user', constraints: false, comment: '所属用户，系统默认标签为空' });
      label.belongsToMany(mail, { through: mailLabel, foreignKey: 'labelId', otherKey: 'mailId', as: 'mails', constraints: false });
    },
    options: {
      comment: '邮件标签',
      // 不在 indexes 中声明 code/level：已有 SQLite 库 sync 不会自动 ADD COLUMN，却会先 CREATE INDEX 导致启动失败
      indexes: [{ fields: ['account_id'] }, { fields: ['user_id'] }, { fields: ['sort'] }]
    }
  };
};
