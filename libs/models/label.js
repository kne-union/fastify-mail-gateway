module.exports = ({ DataTypes, definePrimaryType }) => {
  return {
    model: {
      accountId: definePrimaryType('accountId', {
        comment: '所属邮箱账号，为空表示所有邮箱共用'
      }),
      name: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: '标签名称，在收件箱中显示为文件夹'
      },
      color: {
        type: DataTypes.STRING,
        comment: '标签颜色'
      },
      sort: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: '排序，越小越靠前'
      }
    },
    associate: ({ label, account, mail, mailLabel }) => {
      label.belongsTo(account, { foreignKey: 'accountId', as: 'account', constraints: false });
      label.belongsToMany(mail, { through: mailLabel, foreignKey: 'labelId', otherKey: 'mailId', as: 'mails', constraints: false });
    },
    options: {
      comment: '邮件标签',
      indexes: [{ fields: ['account_id'] }, { fields: ['sort'] }]
    }
  };
};
