module.exports = ({ DataTypes, options }) => {
  return {
    model: {
      name: {
        type: DataTypes.STRING,
        comment: '联系人名称'
      },
      address: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: '邮箱地址，统一存小写，同一用户下不可重复'
      },
      avatar: {
        type: DataTypes.STRING,
        comment: '头像文件 id'
      },
      remark: {
        type: DataTypes.TEXT,
        comment: '备注'
      }
    },
    associate: ({ contact }) => {
      contact.belongsTo(options.getUserModel(), {
        foreignKey: 'userId',
        as: 'user',
        constraints: false,
        comment: '所属用户'
      });
    },
    options: {
      comment: '邮件联系人，按用户隔离',
      indexes: [{ fields: ['user_id'] }, { fields: ['user_id', 'address'] }]
    }
  };
};
