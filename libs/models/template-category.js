module.exports = ({ DataTypes, options }) => {
  return {
    model: {
      name: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: '分类名称'
      },
      description: {
        type: DataTypes.TEXT,
        comment: '分类描述'
      },
      code: {
        type: DataTypes.STRING,
        comment: '分类编码，系统默认分类启动载入时按编码匹配'
      },
      level: {
        type: DataTypes.INTEGER,
        defaultValue: 1,
        comment: '级别：0 系统默认（启动时从 templateDir 载入，不可修改、删除），1 自定义'
      },
      sort: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: '排序，越小越靠前'
      }
    },
    associate: ({ templateCategory, template }) => {
      templateCategory.hasMany(template, { foreignKey: 'categoryId', as: 'templates', constraints: false });
      templateCategory.belongsTo(options.getUserModel(), { foreignKey: 'userId', as: 'user', constraints: false, comment: '所属用户，系统默认分类为空' });
    },
    options: {
      comment: '邮件模版分类',
      indexes: [{ fields: ['sort'] }, { fields: ['code', 'level'] }]
    }
  };
};
