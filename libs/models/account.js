module.exports = ({ DataTypes, options }) => {
  return {
    model: {
      name: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: '邮箱名称'
      },
      address: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: '邮箱地址，发信时作为 from'
      },
      username: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: 'IMAP/SMTP 登录用户名'
      },
      password: {
        type: DataTypes.TEXT,
        allowNull: false,
        comment: '登录密码或授权码，AES 加密存储'
      },
      imap: {
        type: DataTypes.JSON,
        comment: 'IMAP 配置 { host, port, secure }'
      },
      smtp: {
        type: DataTypes.JSON,
        comment: 'SMTP 配置 { host, port, secure }'
      },
      status: {
        type: DataTypes.ENUM('enabled', 'disabled'),
        defaultValue: 'enabled',
        comment: '状态：enabled 启用，disabled 停用（停用后不再同步和发信）'
      },
      syncState: {
        type: DataTypes.JSON,
        defaultValue: {},
        comment: '同步游标 { uidValidity, lastUid }'
      },
      lastSyncAt: {
        type: DataTypes.DATE,
        comment: '最后一次同步时间'
      },
      lastError: {
        type: DataTypes.TEXT,
        comment: '最后一次同步错误信息'
      }
    },
    associate: ({ account }) => {
      account.belongsTo(options.getUserModel(), {
        foreignKey: 'userId',
        as: 'user',
        constraints: false,
        comment: '创建人'
      });
    },
    options: {
      comment: '托管邮箱账号',
      defaultScope: {
        attributes: { exclude: ['password'] }
      },
      scopes: {
        withPassword: {}
      },
      indexes: [{ fields: ['status'] }, { fields: ['address'] }]
    }
  };
};
