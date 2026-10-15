module.exports = ({ definePrimaryType }) => {
  return {
    model: {
      mailId: definePrimaryType('mailId', {
        allowNull: false,
        comment: '邮件'
      }),
      labelId: definePrimaryType('labelId', {
        allowNull: false,
        comment: '标签'
      })
    },
    options: {
      comment: '邮件与标签关联',
      paranoid: false,
      indexes: [{ fields: ['mail_id', 'label_id'], unique: true }, { fields: ['label_id'] }]
    }
  };
};
