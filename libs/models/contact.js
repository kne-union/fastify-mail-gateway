module.exports = ({ DataTypes }) => {
  return {
    model: {
      name: {
        type: DataTypes.STRING,
        comment: '联系人名称'
      },
      address: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: '邮箱地址，统一存小写，不可重复'
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
    options: {
      comment: '邮件联系人',
      indexes: [{ fields: ['address'] }]
    }
  };
};
