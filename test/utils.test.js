const { expect } = require('chai');
const { evaluateItem } = require('../libs/utils/condition');
const { normalizeAddressList } = require('../libs/utils/address');
const { encrypt, decrypt } = require('../libs/utils/crypto');
const { renderTemplate } = require('../libs/utils/template');
const { shouldSkipAutoReply } = require('../libs/actions');

describe('@kne/fastify-mail-gateway 工具函数', () => {
  const mail = {
    accountId: '1',
    from: [{ name: '张三', address: 'zhangsan@example.com' }],
    to: [{ name: '', address: 'bot@test.local' }],
    cc: [],
    subject: '【发票】九月账单',
    text: '请查收附件中的发票',
    attachments: [{ filename: 'a.pdf' }]
  };

  describe('条件求值', () => {
    it('should support all operators case-insensitively', () => {
      const cases = [
        [{ field: 'subject', operator: 'contains', value: '发票' }, true],
        [{ field: 'subject', operator: 'notContains', value: '发票' }, false],
        [{ field: 'from', operator: 'equals', value: 'ZHANGSAN@example.com' }, true],
        [{ field: 'from', operator: 'contains', value: '张三' }, true],
        [{ field: 'subject', operator: 'startsWith', value: '【发票】' }, true],
        [{ field: 'from', operator: 'endsWith', value: '@example.com>' }, true],
        [{ field: 'text', operator: 'regex', value: '发票|invoice' }, true],
        [{ field: 'hasAttachment', operator: 'equals', value: true }, true],
        [{ field: 'accountId', operator: 'equals', value: '2' }, false]
      ];
      cases.forEach(([item, expected]) => {
        expect(evaluateItem(mail, item), JSON.stringify(item)).to.equal(expected);
      });
    });

    it('should not throw on invalid regex', () => {
      expect(evaluateItem(mail, { field: 'subject', operator: 'regex', value: '(' })).to.equal(false);
    });
  });

  describe('地址解析', () => {
    it('should normalize string, array and object inputs', () => {
      expect(normalizeAddressList('a@x.com, B <b@x.com>')).to.deep.equal([
        { name: '', address: 'a@x.com' },
        { name: 'B', address: 'b@x.com' }
      ]);
      expect(normalizeAddressList(['a@x.com', { name: 'C', address: 'c@x.com' }])).to.have.length(2);
      expect(normalizeAddressList({ value: [{ name: 'D', address: 'd@x.com' }] })).to.deep.equal([{ name: 'D', address: 'd@x.com' }]);
      expect(normalizeAddressList(null)).to.deep.equal([]);
    });
  });

  describe('密码加密', () => {
    it('should encrypt and decrypt with the same key', () => {
      const encrypted = encrypt('secret', 'key');
      expect(encrypted).to.not.equal('secret');
      expect(decrypt(encrypted, 'key')).to.equal('secret');
      expect(() => decrypt(encrypted, 'other')).to.throw();
    });
  });

  describe('模板渲染', () => {
    it('should replace variables and escape html when required', () => {
      expect(renderTemplate('Re: {{mail.subject}}', { mail: { subject: 'Hi' } })).to.equal('Re: Hi');
      expect(renderTemplate('<p>{{name}}</p>', { name: '<b>x</b>' }, { html: true })).to.equal('<p>&lt;b&gt;x&lt;/b&gt;</p>');
      expect(renderTemplate('{{missing}}-{{ constructor }}', {})).to.equal('-');
    });
  });

  describe('自动回复跳过判断', () => {
    const account = { address: 'bot@test.local' };
    it('should skip auto generated, list and no-reply mails', () => {
      expect(shouldSkipAutoReply({ mail: Object.assign({}, mail, { headers: { 'auto-submitted': 'auto-replied' } }), account })).to.be.a('string');
      expect(shouldSkipAutoReply({ mail: Object.assign({}, mail, { headers: { 'list-id': 'x' } }), account })).to.be.a('string');
      expect(shouldSkipAutoReply({ mail: Object.assign({}, mail, { from: [{ address: 'no-reply@x.com' }] }), account })).to.be.a('string');
      expect(shouldSkipAutoReply({ mail: Object.assign({}, mail, { from: [{ address: 'bot@test.local' }] }), account })).to.be.a('string');
      expect(shouldSkipAutoReply({ mail: Object.assign({}, mail, { headers: {} }), account })).to.equal(null);
    });
  });
});
