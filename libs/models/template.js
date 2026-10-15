module.exports = ({ DataTypes, definePrimaryType }) => {
  return {
    model: {
      categoryId: definePrimaryType('categoryId', {
        comment: '所属分类，为空表示未分类'
      }),
      name: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: '模版名称'
      },
      subject: {
        type: DataTypes.STRING(1000),
        comment: '邮件主题，支持 {{mail.subject}} 等变量'
      },
      html: {
        type: DataTypes.TEXT,
        comment: '富文本正文，支持 {{mail.from[0].name}}、{{account.name}} 等变量'
      },
      description: {
        type: DataTypes.TEXT,
        comment: '模版说明'
      },
      code: {
        type: DataTypes.STRING,
        comment: '模版编码，系统默认模版启动载入时按编码匹配'
      },
      level: {
        type: DataTypes.INTEGER,
        defaultValue: 1,
        comment: '级别：0 系统默认（启动时从 templateDir 载入，不可修改、删除，可启用/停用、复制），1 自定义'
      },
      status: {
        type: DataTypes.ENUM('enabled', 'disabled'),
        defaultValue: 'enabled',
        comment: '状态：enabled 可用，disabled 停用（写信与规则中不可选）'
      },
      sort: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: '排序，越小越靠前'
      }
    },
    associate: ({ template, templateCategory }) => {
      template.belongsTo(templateCategory, { foreignKey: 'categoryId', as: 'category', constraints: false });
    },
    options: {
      comment: '邮件模版',
      indexes: [{ fields: ['category_id'] }, { fields: ['status'] }, { fields: ['code', 'level'] }]
    }
  };
};
