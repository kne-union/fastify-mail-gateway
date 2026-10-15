module.exports = ({ DataTypes, definePrimaryType }) => {
  return {
    model: {
      accountId: definePrimaryType('accountId', {
        allowNull: false,
        comment: '所属邮箱账号'
      }),
      folder: {
        type: DataTypes.ENUM('inbox', 'sent', 'draft', 'trash'),
        allowNull: false,
        defaultValue: 'inbox',
        comment: '文件夹：inbox 收件箱，sent 已发送，draft 草稿，trash 回收站'
      },
      originFolder: {
        type: DataTypes.ENUM('inbox', 'sent', 'draft'),
        comment: '移入回收站前所在文件夹，用于恢复'
      },
      uid: {
        type: DataTypes.INTEGER,
        comment: 'IMAP UID，仅收件箱邮件有值'
      },
      messageId: {
        type: DataTypes.STRING,
        comment: '邮件 Message-ID'
      },
      inReplyTo: {
        type: DataTypes.STRING,
        comment: '回复的邮件 Message-ID'
      },
      references: {
        type: DataTypes.JSON,
        comment: 'References 邮件链'
      },
      from: {
        type: DataTypes.JSON,
        comment: '发件人 [{ name, address }]'
      },
      to: {
        type: DataTypes.JSON,
        comment: '收件人 [{ name, address }]'
      },
      cc: {
        type: DataTypes.JSON,
        comment: '抄送 [{ name, address }]'
      },
      bcc: {
        type: DataTypes.JSON,
        comment: '密送 [{ name, address }]'
      },
      subject: {
        type: DataTypes.TEXT,
        comment: '主题'
      },
      html: {
        type: DataTypes.TEXT,
        comment: 'HTML 正文'
      },
      text: {
        type: DataTypes.TEXT,
        comment: '纯文本正文'
      },
      date: {
        type: DataTypes.DATE,
        comment: '邮件日期（收信为发送时间，发信为发出时间，草稿为最后保存时间）'
      },
      isRead: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        comment: '是否已读'
      },
      isStarred: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        comment: '是否星标'
      },
      attachments: {
        type: DataTypes.JSON,
        defaultValue: [],
        comment: '附件 [{ id, filename, contentType, size, cid, checksum }]，收信附件首次查看时才下载并写入 id'
      },
      headers: {
        type: DataTypes.JSON,
        comment: '部分原始邮件头，用于规则判断（如 auto-submitted、list-id）'
      },
      size: {
        type: DataTypes.INTEGER,
        comment: '邮件大小（字节）'
      }
    },
    associate: ({ mail, account, label, mailLabel }) => {
      mail.belongsTo(account, { foreignKey: 'accountId', as: 'account', constraints: false });
      mail.hasMany(mailLabel, { foreignKey: 'mailId', as: 'mailLabels', constraints: false });
      mail.belongsToMany(label, { through: mailLabel, foreignKey: 'mailId', otherKey: 'labelId', as: 'labels', constraints: false });
    },
    options: {
      comment: '邮件',
      indexes: [{ fields: ['account_id', 'folder', 'uid'], unique: true, where: { deleted_at: null } }, { fields: ['account_id', 'folder', 'date'] }, { fields: ['account_id', 'message_id'] }, { fields: ['is_read'] }]
    }
  };
};
