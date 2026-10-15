const { expect } = require('chai');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createFastify, accountPayload } = require('./helpers/app');

describe('@kne/fastify-mail-gateway', function () {
  this.timeout(20000);

  let fastify;

  const inject = async (method, url, payload) => {
    const response = await fastify.inject({ method, url: `/api/mail-gateway${url}`, payload });
    const body = response.body ? JSON.parse(response.body) : null;
    if (response.statusCode >= 400) {
      const error = new Error(body && body.message);
      error.statusCode = response.statusCode;
      throw error;
    }
    return body;
  };

  const createAccount = async (overrides = {}) => inject('POST', '/accounts', accountPayload(overrides));

  afterEach(async () => {
    if (fastify) {
      await fastify.close();
      fastify = null;
    }
  });

  describe('插件注册', () => {
    it('should decorate namespace and register built-in actions', async () => {
      fastify = await createFastify();
      expect(fastify.mailGateway).to.exist;
      expect(fastify.mailGateway.models.mail.getTableName()).to.equal('t_mail_gateway_mail');
      const actions = await inject('GET', '/actions');
      expect(actions.map(item => item.type)).to.include.members(['addLabel', 'markRead', 'star', 'moveToTrash', 'autoReply', 'forward', 'webhook']);
      expect(actions[0]).to.not.have.property('handler');
    });

    it('should register custom actions from options and at runtime', async () => {
      const calls = [];
      fastify = await createFastify({
        actions: {
          createTicket: {
            label: '创建工单',
            directions: ['receive'],
            formSchema: {
              blocks: [
                {
                  kind: 'formInfo',
                  list: [{ type: 'Select', name: 'queue', label: '队列', rule: 'REQ', props: { options: [{ label: '售后', value: 'after-sale' }] } }]
                }
              ]
            },
            handler: async ({ mail, params }) => {
              calls.push({ subject: mail.subject, queue: params.queue });
              return { ticketId: 'T-1' };
            }
          }
        }
      });
      fastify.mailGateway.services.action.register('notify', async () => 'ok');
      const receiveActions = await inject('GET', '/actions?direction=receive');
      expect(receiveActions.map(item => item.type)).to.include.members(['createTicket', 'notify']);
      const sendActions = await inject('GET', '/actions?direction=send');
      expect(sendActions.map(item => item.type)).to.not.include('createTicket');
      const createTicket = receiveActions.find(item => item.type === 'createTicket');
      expect(createTicket.formSchema.blocks[0].id).to.equal('block-0');
      expect(createTicket.formSchema.blocks[0].list[0].id).to.equal('block-0-queue');
      expect(createTicket).to.not.have.property('fields');
      const addLabel = receiveActions.find(item => item.type === 'addLabel');
      expect(addLabel.formSchema.blocks[0].list[0]).to.include({ type: 'MailLabelSelect', name: 'labelIds', rule: 'REQ' });
      expect(() => fastify.mailGateway.services.action.register('bad', { formSchema: { foo: 1 }, handler: async () => {} })).to.throw(/formSchema/);
      expect(calls).to.have.length(0);
    });
  });

  describe('邮箱账号', () => {
    beforeEach(async () => {
      fastify = await createFastify();
    });

    it('should create account with encrypted password and never return it', async () => {
      const account = await createAccount();
      expect(account).to.not.have.property('password');
      const stored = await fastify.mailGateway.models.account.scope('withPassword').findByPk(account.id);
      expect(stored.password).to.match(/^enc:v1:/);
      const list = await inject('GET', '/accounts');
      expect(list.totalCount).to.equal(1);
      expect(list.pageData[0]).to.not.have.property('password');
      const withPassword = await fastify.mailGateway.services.account.getWithPassword({ id: account.id });
      expect(withPassword.password).to.equal('p@ss');
    });

    it('should filter account list by id', async () => {
      const account = await createAccount();
      await createAccount({ name: '财务部', address: 'finance@example.com', username: 'finance@example.com' });
      const list = await inject('GET', `/accounts?filter[id]=${account.id}`);
      expect(list.totalCount).to.equal(1);
      expect(list.pageData[0].id).to.equal(account.id);
    });

    it('should reject creation when imap connection fails', async () => {
      fastify.testContext.imap.state.connectError = new Error('auth failed');
      try {
        await createAccount();
        expect.fail('should throw');
      } catch (e) {
        expect(e.statusCode).to.equal(400);
        expect(e.message).to.include('IMAP: auth failed');
      }
    });

    it('should keep password when saving without password and support status/remove', async () => {
      const account = await createAccount();
      await inject('PUT', `/accounts/${account.id}`, { name: '新名称' });
      const withPassword = await fastify.mailGateway.services.account.getWithPassword({ id: account.id });
      expect(withPassword.name).to.equal('新名称');
      expect(withPassword.password).to.equal('p@ss');
      const result = await inject('POST', '/accounts/test-connection', { id: account.id });
      expect(result.success).to.equal(true);
      await inject('POST', `/accounts/${account.id}/status`, { status: 'disabled' });
      expect((await inject('GET', `/accounts/${account.id}`)).status).to.equal('disabled');
      await inject('DELETE', `/accounts/${account.id}`);
      expect((await inject('GET', '/accounts')).totalCount).to.equal(0);
    });
  });

  describe('收信同步', () => {
    beforeEach(async () => {
      fastify = await createFastify({ syncBatchSize: 2 });
    });

    it('should sync incrementally, parse mails and keep attachment metadata only', async () => {
      const { imap } = fastify.testContext;
      const account = await createAccount();
      await imap.addMessage({ subject: 'm1', messageId: '<m1@x>' });
      await imap.addMessage({ subject: 'm2', messageId: '<m2@x>', attachments: [{ filename: 'a.txt', content: 'hello' }] });
      await imap.addMessage({ subject: 'm3', messageId: '<m3@x>' });

      // 首次同步只取最新一批（batch=2）
      const first = await inject('POST', `/accounts/${account.id}/sync`);
      expect(first.count).to.equal(2);
      let list = await inject('GET', `/mails?filter[accountId]=${account.id}`);
      expect(list.pageData.map(item => item.subject)).to.deep.equal(['m3', 'm2']);
      const m2 = list.pageData.find(item => item.subject === 'm2');
      expect(m2.attachments[0]).to.include({ filename: 'a.txt' });
      expect(m2.attachments[0]).to.not.have.property('id');
      expect(m2).to.not.have.property('html');
      expect(m2.summary).to.be.a('string');

      await imap.addMessage({ subject: 'm4', messageId: '<m4@x>' });
      await imap.addMessage({ subject: 'm4-dup', messageId: '<m4@x>' });
      const second = await inject('POST', `/accounts/${account.id}/sync`);
      expect(second.count).to.equal(1);
      list = await inject('GET', `/mails?filter[accountId]=${account.id}`);
      expect(list.totalCount).to.equal(3);

      const stored = await fastify.mailGateway.models.account.findByPk(account.id);
      expect(stored.syncState.lastUid).to.equal(5);
      expect(stored.lastError).to.equal(null);
    });

    it('should download attachments on demand and reuse the stored file', async () => {
      const { imap } = fastify.testContext;
      const account = await createAccount();
      await imap.addMessage({
        subject: 'with files',
        messageId: '<files@x>',
        attachments: [
          { filename: 'a.txt', content: 'hello' },
          { filename: 'b.txt', content: 'world!' },
          { filename: 'c.txt', content: 'forward me' }
        ]
      });
      await inject('POST', `/accounts/${account.id}/sync`);
      const [mail] = (await inject('GET', `/mails?filter[accountId]=${account.id}`)).pageData;
      const clientCount = imap.state.clients.length;

      const downloaded = await inject('POST', `/mails/${mail.id}/attachments/1/download`);
      expect(downloaded).to.include({ id: 'file-b.txt', filename: 'b.txt' });
      expect(imap.state.clients.length).to.equal(clientCount + 1);

      const again = await inject('POST', `/mails/${mail.id}/attachments/1/download`);
      expect(again.id).to.equal('file-b.txt');
      expect(imap.state.clients.length).to.equal(clientCount + 1);

      const detail = await inject('GET', `/mails/${mail.id}`);
      expect(detail.attachments.map(item => item.id || null)).to.deep.equal([null, 'file-b.txt', null]);

      // 发信时引用未下载的收信附件 { mailId, index } 会先下载
      const sent = await inject('POST', '/mails/send', {
        accountId: account.id,
        to: 'a@x.com',
        subject: 'Fwd',
        html: 'x',
        attachments: [{ mailId: mail.id, index: 2, filename: 'c.txt' }]
      });
      expect(sent.attachments[0]).to.include({ id: 'file-c.txt', filename: 'c.txt' });
      expect(fastify.testContext.sentMails[0].attachments[0].filename).to.equal('c.txt');

      // UID 已变化时按 Message-ID 找回原邮件
      await fastify.mailGateway.models.mail.update({ uid: 999 }, { where: { id: mail.id } });
      const first = await inject('POST', `/mails/${mail.id}/attachments/0/download`);
      expect(first.id).to.equal('file-a.txt');

      const error = await inject('POST', `/mails/${mail.id}/attachments/5/download`).catch(e => e);
      expect(error.statusCode).to.equal(404);
    });

    it('should record lastError when sync fails', async () => {
      const account = await createAccount();
      fastify.testContext.imap.state.connectError = new Error('network down');
      const results = await fastify.mailGateway.services.sync.syncAll();
      expect(results[0]).to.include({ success: false, error: 'network down' });
      const stored = await fastify.mailGateway.models.account.findByPk(account.id);
      expect(stored.lastError).to.equal('network down');
    });
  });

  describe('邮件管理与发送', () => {
    let account;

    beforeEach(async () => {
      fastify = await createFastify();
      account = await createAccount();
      await fastify.testContext.imap.addMessage({ subject: '你好', messageId: '<hello@x>', from: '客户 <customer@example.com>', html: '<p>hi</p>' });
      await fastify.mailGateway.services.sync.syncAccount({ id: account.id });
    });

    it('should mark read on detail, star, label and trash', async () => {
      const list = await inject('GET', `/mails?filter[accountId]=${account.id}&filter[isRead]=false`);
      expect(list.totalCount).to.equal(1);
      const id = list.pageData[0].id;

      const detail = await inject('GET', `/mails/${id}`);
      expect(detail.html).to.equal('<p>hi</p>');
      expect(detail.isRead).to.equal(true);

      await inject('POST', '/mails/star', { ids: [id] });
      const label = await inject('POST', '/labels', { name: '客户', accountId: account.id });
      const globalLabel = await inject('POST', '/labels', { name: '重要' });
      const labeled = await inject('PUT', `/mails/${id}/labels`, { labelIds: [label.id, globalLabel.id] });
      expect(labeled.labels.map(item => item.name).sort()).to.deep.equal(['客户', '重要']);

      const byLabel = await inject('GET', `/mails?filter[labelId]=${label.id}`);
      expect(byLabel.totalCount).to.equal(1);
      expect(byLabel.pageData[0].isStarred).to.equal(true);

      await inject('POST', '/mails/read', { ids: [id], isRead: false });
      const stats = await inject('GET', `/mails/stats?accountId=${account.id}`);
      expect(stats.folders.inbox).to.deep.equal({ total: 1, unread: 1 });
      expect(stats.labels.find(item => item.name === '客户')).to.include({ total: 1, unread: 1 });

      await inject('POST', '/mails/trash', { ids: [id] });
      expect((await inject('GET', `/mails/stats?accountId=${account.id}`)).folders.trash.total).to.equal(1);
      await inject('POST', '/mails/restore', { ids: [id] });
      expect((await inject('GET', `/mails/${id}`)).folder).to.equal('inbox');
      await inject('POST', '/mails/remove', { ids: [id] });
      expect((await inject('GET', `/mails?filter[accountId]=${account.id}`)).totalCount).to.equal(0);
    });

    it('should send mail with reply headers and save to sent', async () => {
      const { sentMails } = fastify.testContext;
      const mail = await inject('POST', '/mails/send', {
        accountId: account.id,
        to: '客户 <customer@example.com>',
        cc: ['boss@example.com'],
        subject: 'Re: 你好',
        html: '<p>收到</p>',
        inReplyTo: '<hello@x>',
        attachments: [{ id: 'f1', filename: 'f1.txt' }]
      });
      expect(mail.folder).to.equal('sent');
      expect(mail.messageId).to.equal('<sent-1@test.local>');
      expect(sentMails[0].from).to.deep.equal({ name: '测试邮箱', address: 'bot@test.local' });
      expect(sentMails[0].references).to.deep.equal(['<hello@x>']);
      expect(sentMails[0].attachments[0].filename).to.equal('f1.txt');
      expect(sentMails[0].text).to.equal('收到');
      const sent = await inject('GET', `/mails?filter[folder]=sent`);
      expect(sent.totalCount).to.equal(1);
    });

    it('should save, update and send draft', async () => {
      const draft = await inject('POST', '/drafts', { accountId: account.id, to: 'a@x.com', subject: '草稿' });
      await inject('PUT', `/drafts/${draft.id}`, { accountId: account.id, to: 'a@x.com', subject: '草稿-改' });
      let stats = await inject('GET', `/mails/stats?accountId=${account.id}`);
      expect(stats.folders.draft.total).to.equal(1);
      const sent = await inject('POST', `/drafts/${draft.id}/send`, {});
      expect(sent.id).to.equal(draft.id);
      expect(sent.folder).to.equal('sent');
      expect(fastify.testContext.sentMails[0].subject).to.equal('草稿-改');
      stats = await inject('GET', `/mails/stats?accountId=${account.id}`);
      expect(stats.folders.draft.total).to.equal(0);
      expect(stats.folders.sent.total).to.equal(1);
    });

    it('should apply beforeSend and afterSend hooks', async () => {
      await fastify.close();
      const after = [];
      fastify = await createFastify({
        beforeSend: async ({ mailOptions }) => Object.assign({}, mailOptions, { subject: `[网关] ${mailOptions.subject}` }),
        afterSend: async ({ mail }) => after.push(mail.subject)
      });
      account = await createAccount();
      await inject('POST', '/mails/send', { accountId: account.id, to: 'a@x.com', subject: 'hello', html: 'x' });
      expect(fastify.testContext.sentMails[0].subject).to.equal('[网关] hello');
      expect(after).to.deep.equal(['[网关] hello']);

      await fastify.close();
      fastify = await createFastify({ beforeSend: async () => false });
      account = await createAccount();
      try {
        await inject('POST', '/mails/send', { accountId: account.id, to: 'a@x.com', subject: 'blocked' });
        expect.fail('should throw');
      } catch (e) {
        expect(e.message).to.include('beforeSend');
      }
    });
  });

  describe('规则管道', () => {
    let account;
    let calls;
    let aiCalls;

    const receive = async mail => {
      await fastify.testContext.imap.addMessage(mail);
      await fastify.mailGateway.services.sync.syncAccount({ id: account.id });
      const list = await inject('GET', `/mails?filter[accountId]=${account.id}`);
      return list.pageData[0];
    };

    beforeEach(async () => {
      calls = [];
      aiCalls = [];
      fastify = await createFastify({
        actions: {
          collect: {
            label: '收集',
            formSchema: { blocks: [{ id: 'params', kind: 'formInfo', list: [{ id: 'tag', type: 'Input', name: 'tag', rule: 'REQ' }] }] },
            handler: async ({ mail, params, direction }) => {
              calls.push({ subject: mail.subject, tag: params.tag, direction });
              return { ok: true };
            }
          },
          broken: async () => {
            throw new Error('boom');
          }
        },
        conditions: {
          aiJudge: {
            label: 'AI 判断',
            directions: ['receive'],
            formSchema: { blocks: [{ id: 'params', kind: 'formInfo', list: [{ id: 'prompt', type: 'TextArea', name: 'prompt', rule: 'REQ' }] }] },
            evaluate: async ({ mail, params, account }) => {
              aiCalls.push({ subject: mail.subject, prompt: params.prompt, hasPassword: 'password' in account });
              const matched = mail.subject.includes(params.prompt);
              return { matched, reason: matched ? `主题包含「${params.prompt}」` : '不相关' };
            }
          },
          aiBroken: async () => {
            throw new Error('model unavailable');
          },
          aiSlow: {
            timeout: 50,
            evaluate: () => new Promise(resolve => setTimeout(() => resolve(true), 500))
          }
        }
      });
      account = await createAccount();
    });

    it('should validate rule conditions and actions', async () => {
      const invalidCases = [
        { name: 'x', direction: 'receive', conditions: { items: [{ field: 'unknown', operator: 'contains', value: 'a' }] } },
        { name: 'x', direction: 'receive', conditions: { items: [{ field: 'subject', operator: 'regex', value: '(' }] } },
        { name: 'x', direction: 'receive', actions: [{ type: 'notExists' }] },
        { name: 'x', direction: 'send', actions: [{ type: 'autoReply', params: { html: 'x' } }] },
        { name: 'x', direction: 'receive', actions: [{ type: 'collect', params: {} }] },
        { name: 'x', direction: 'receive', conditions: { items: [{ type: 'notExists' }] } },
        { name: 'x', direction: 'receive', conditions: { items: [{ type: 'aiJudge', params: {} }] } },
        { name: 'x', direction: 'send', conditions: { items: [{ type: 'aiJudge', params: { prompt: '发票' } }] } }
      ];
      for (const body of invalidCases) {
        try {
          await inject('POST', '/rules', body);
          expect.fail(`should reject ${JSON.stringify(body)}`);
        } catch (e) {
          expect(e.statusCode, e.message).to.equal(400);
        }
      }
    });

    it('should label matched mails, honor priority and stopProcessing, and write logs', async () => {
      const label = await inject('POST', '/labels', { name: '发票' });
      await inject('POST', '/rules', {
        name: '发票归档',
        direction: 'receive',
        priority: 1,
        stopProcessing: true,
        conditions: { match: 'any', items: [{ field: 'subject', operator: 'contains', value: '发票' }] },
        actions: [{ type: 'addLabel', params: { labelIds: [label.id] } }, { type: 'markRead' }, { type: 'collect', params: { tag: 'invoice' } }]
      });
      await inject('POST', '/rules', {
        name: '兜底',
        direction: 'receive',
        priority: 2,
        actions: [{ type: 'collect', params: { tag: 'fallback' } }]
      });
      await inject('POST', '/rules', {
        name: '其他邮箱',
        direction: 'receive',
        priority: 0,
        accountIds: ['not-this-account'],
        actions: [{ type: 'collect', params: { tag: 'other' } }]
      });

      const invoice = await receive({ subject: '九月发票', messageId: '<inv@x>' });
      expect(invoice.labels.map(item => item.name)).to.deep.equal(['发票']);
      expect(invoice.isRead).to.equal(true);
      expect(calls.map(item => item.tag)).to.deep.equal(['invoice']);

      await receive({ subject: '普通邮件', messageId: '<normal@x>' });
      expect(calls.map(item => item.tag)).to.deep.equal(['invoice', 'fallback']);

      const logs = await inject('GET', '/rule-logs');
      expect(logs.totalCount).to.equal(2);
      const invoiceLog = logs.pageData.find(item => item.rule.name === '发票归档');
      expect(invoiceLog.status).to.equal('success');
      expect(invoiceLog.results.map(item => item.type)).to.deep.equal(['addLabel', 'markRead', 'collect']);
      expect(invoiceLog.mail.subject).to.equal('九月发票');
    });

    it('should isolate failing actions and mark log as partial', async () => {
      await inject('POST', '/rules', {
        name: '部分失败',
        direction: 'receive',
        actions: [{ type: 'broken' }, { type: 'star' }]
      });
      const mail = await receive({ subject: 'x', messageId: '<x@x>' });
      expect(mail.isStarred).to.equal(true);
      const logs = await inject('GET', '/rule-logs');
      expect(logs.pageData[0].status).to.equal('partial');
      expect(logs.pageData[0].results[0]).to.include({ success: false, error: 'boom' });
    });

    it('should auto reply once per sender within interval', async () => {
      await inject('POST', '/rules', {
        name: '自动回复',
        direction: 'receive',
        actions: [{ type: 'autoReply', params: { subject: '自动回复: {{mail.subject}}', html: '<p>您好 {{mail.from[0].name}}，已收到</p>', intervalHours: 24 } }]
      });
      await receive({ subject: '咨询', messageId: '<q1@x>', from: '李四 <lisi@example.com>' });
      await receive({ subject: '再次咨询', messageId: '<q2@x>', from: '李四 <lisi@example.com>' });
      await receive({ subject: '通知', messageId: '<n1@x>', from: 'no-reply@example.com' });
      const { sentMails } = fastify.testContext;
      expect(sentMails).to.have.length(1);
      expect(sentMails[0].subject).to.equal('自动回复: 咨询');
      expect(sentMails[0].html).to.equal('<p>您好 李四，已收到</p>');
      expect(sentMails[0].inReplyTo).to.equal('<q1@x>');
      expect(sentMails[0].headers['Auto-Submitted']).to.equal('auto-replied');
    });

    it('should auto reply with mail template and require template or html', async () => {
      try {
        await inject('POST', '/rules', { name: 'x', direction: 'receive', actions: [{ type: 'autoReply', params: { subject: 'x' } }] });
        expect.fail('should require templateId or html');
      } catch (e) {
        expect(e.statusCode).to.equal(400);
        expect(e.message).to.include('请选择邮件模版或填写回复内容');
      }
      const template = await inject('POST', '/templates', {
        name: '受理通知',
        subject: '已受理：{{mail.subject}}',
        html: '<p>{{mail.from[0].name}} 您好，{{account.name}} 已收到您的来信</p>'
      });
      await inject('POST', '/rules', {
        name: '模版回复',
        direction: 'receive',
        actions: [{ type: 'autoReply', params: { templateId: template.id, subject: 'Re: {{mail.subject}}', intervalHours: 0 } }]
      });
      await receive({ subject: '报价咨询', messageId: '<t1@x>', from: '王五 <wangwu@example.com>' });
      const { sentMails } = fastify.testContext;
      expect(sentMails).to.have.length(1);
      expect(sentMails[0].subject).to.equal('已受理：报价咨询');
      expect(sentMails[0].html).to.equal('<p>王五 您好，测试邮箱 已收到您的来信</p>');

      await inject('POST', `/templates/${template.id}/status`, { status: 'disabled' });
      await receive({ subject: '再次咨询', messageId: '<t2@x>', from: '王五 <wangwu@example.com>' });
      expect(sentMails).to.have.length(1);
      const logs = await inject('GET', '/rule-logs');
      expect(logs.pageData[0].results[0].error).to.include('已停用');
    });

    it('should forward mails and run send rules without recursion', async () => {
      await inject('POST', '/rules', {
        name: '转发',
        direction: 'receive',
        actions: [{ type: 'forward', params: { to: ['ops@example.com'], comment: '请处理' } }]
      });
      await inject('POST', '/rules', {
        name: '发信收集',
        direction: 'send',
        actions: [{ type: 'collect', params: { tag: 'sent' } }]
      });
      await receive({ subject: '故障', messageId: '<f1@x>', attachments: [{ filename: 'log.txt', content: 'err' }] });
      const { sentMails } = fastify.testContext;
      expect(sentMails).to.have.length(1);
      expect(sentMails[0].subject).to.equal('Fwd: 故障');
      expect(sentMails[0].attachments).to.have.length(1);
      expect(calls).to.have.length(0);

      await inject('POST', '/mails/send', { accountId: account.id, to: 'a@x.com', subject: 'manual', html: 'x' });
      expect(calls.map(item => item.direction)).to.deep.equal(['send']);
    });

    it('should call webhook with signature', async () => {
      const received = [];
      const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => (body += chunk));
        req.on('end', () => {
          received.push({ headers: req.headers, body: JSON.parse(body) });
          res.end('ok');
        });
      });
      await new Promise(resolve => server.listen(0, resolve));
      try {
        await inject('POST', '/rules', {
          name: 'webhook',
          direction: 'receive',
          actions: [{ type: 'webhook', params: { url: `http://127.0.0.1:${server.address().port}/hook`, secret: 's' } }]
        });
        await receive({ subject: 'hook', messageId: '<h@x>' });
        expect(received).to.have.length(1);
        expect(received[0].headers['x-mail-gateway-signature']).to.match(/^sha256=/);
        expect(received[0].body.event).to.equal('receive');
        expect(received[0].body.mail.subject).to.equal('hook');
        expect(received[0].body.account).to.not.have.property('password');
      } finally {
        server.close();
      }
    });

    it('should evaluate extension conditions after built-in ones and short-circuit', async () => {
      await inject('POST', '/rules', {
        name: 'AI 发票',
        direction: 'receive',
        conditions: {
          match: 'all',
          items: [
            { type: 'aiJudge', params: { prompt: '发票' } },
            { field: 'from', operator: 'contains', value: 'finance' }
          ]
        },
        actions: [{ type: 'collect', params: { tag: 'ai' } }]
      });

      await receive({ subject: '发票通知', from: 'other@x.com', messageId: '<ai-1@x>' });
      expect(aiCalls, 'built-in miss should skip AI').to.have.length(0);
      expect(calls).to.have.length(0);

      await receive({ subject: '九月发票', from: 'finance@x.com', messageId: '<ai-2@x>' });
      expect(aiCalls).to.deep.equal([{ subject: '九月发票', prompt: '发票', hasPassword: false }]);
      expect(calls.map(item => item.tag)).to.deep.equal(['ai']);

      await receive({ subject: '会议邀请', from: 'finance@x.com', messageId: '<ai-3@x>' });
      expect(aiCalls).to.have.length(2);
      expect(calls).to.have.length(1);
    });

    it('should treat failed or timed out extension conditions as unmatched', async () => {
      const mail = await receive({ subject: '发票', messageId: '<ai-err@x>' });
      const broken = await inject('POST', '/rules/test', { mailId: mail.id, conditions: { items: [{ type: 'aiBroken' }] } });
      expect(broken.matched).to.equal(false);
      expect(broken.details[0]).to.include({ type: 'aiBroken', matched: false, error: 'model unavailable' });

      const slow = await inject('POST', '/rules/test', { mailId: mail.id, conditions: { items: [{ type: 'aiSlow' }] } });
      expect(slow.matched).to.equal(false);
      expect(slow.details[0].error).to.match(/超时/);

      const any = await inject('POST', '/rules/test', {
        mailId: mail.id,
        conditions: { match: 'any', items: [{ type: 'aiBroken' }, { type: 'aiJudge', params: { prompt: '发票' } }, { type: 'aiSlow' }] }
      });
      expect(any.matched).to.equal(true);
      expect(any.details.map(item => [item.type, item.matched, !!item.skipped])).to.deep.equal([
        ['aiBroken', false, false],
        ['aiJudge', true, false],
        ['aiSlow', false, true]
      ]);
      expect(any.details[1]).to.include({ label: 'AI 判断', reason: '主题包含「发票」' });
    });

    it('should list extension conditions in rule options by direction', async () => {
      const receiveOptions = await inject('GET', '/rules/options?direction=receive');
      expect(receiveOptions.fields).to.include('subject');
      expect(receiveOptions.extensions.map(item => item.type)).to.deep.equal(['aiJudge', 'aiBroken', 'aiSlow']);
      expect(receiveOptions.extensions[0]).to.include({ label: 'AI 判断' });
      expect(receiveOptions.extensions[0].formSchema.blocks).to.have.length(1);
      expect(receiveOptions.extensions[0]).to.not.have.property('evaluate');
      const sendOptions = await inject('GET', '/rules/options?direction=send');
      expect(sendOptions.extensions.map(item => item.type)).to.deep.equal(['aiBroken', 'aiSlow']);
    });

    it('should test rule without executing actions', async () => {
      const mail = await receive({ subject: '测试命中', messageId: '<t@x>' });
      const rule = await inject('POST', '/rules', {
        name: '试运行',
        direction: 'receive',
        status: 'disabled',
        conditions: { items: [{ field: 'subject', operator: 'contains', value: '命中' }] },
        actions: [{ type: 'collect', params: { tag: 'never' } }]
      });
      const result = await inject('POST', '/rules/test', { id: rule.id, mailId: mail.id });
      expect(result.matched).to.equal(true);
      expect(result.details[0].matched).to.equal(true);
      const adhoc = await inject('POST', '/rules/test', { mailId: mail.id, conditions: { items: [{ field: 'subject', operator: 'contains', value: '不存在' }] } });
      expect(adhoc.matched).to.equal(false);
      expect(calls).to.have.length(0);
    });

    it('should support rule status, sort, update and remove', async () => {
      const a = await inject('POST', '/rules', { name: 'a', direction: 'receive' });
      const b = await inject('POST', '/rules', { name: 'b', direction: 'receive' });
      await inject('POST', '/rules/sort', { ids: [b.id, a.id] });
      let list = await inject('GET', '/rules');
      expect(list.pageData.map(item => item.name)).to.deep.equal(['b', 'a']);
      await inject('PUT', `/rules/${a.id}`, { name: 'a2', actions: [{ type: 'star' }] });
      await inject('POST', `/rules/${a.id}/status`, { status: 'disabled' });
      const detail = await inject('GET', `/rules/${a.id}`);
      expect(detail).to.include({ name: 'a2', status: 'disabled' });
      await inject('DELETE', `/rules/${b.id}`);
      list = await inject('GET', '/rules');
      expect(list.totalCount).to.equal(1);
      const conditionOptions = await inject('GET', '/rules/options');
      expect(conditionOptions.fields).to.include('subject');
    });
  });

  describe('邮件模版', () => {
    beforeEach(async () => {
      fastify = await createFastify();
    });

    it('should manage categories with template counts and sort', async () => {
      const service = await inject('POST', '/template-categories', { name: '客服回复' });
      const finance = await inject('POST', '/template-categories', { name: '财务通知' });
      await inject('POST', '/templates', { name: '受理通知', categoryId: service.id, html: '<p>已收到</p>' });
      await inject('POST', '/templates', { name: '催款提醒', categoryId: finance.id, html: '<p>请付款</p>' });
      await inject('POST', '/templates', { name: '通用签名', html: '<p>此致</p>' });

      await inject('POST', '/template-categories/sort', { ids: [finance.id, service.id] });
      let categories = await inject('GET', '/template-categories');
      expect(categories.pageData.map(item => [item.name, item.templateCount])).to.deep.equal([
        ['财务通知', 1],
        ['客服回复', 1]
      ]);
      expect(categories.uncategorizedCount).to.equal(1);

      await inject('PUT', `/template-categories/${service.id}`, { name: '客服' });
      await inject('DELETE', `/template-categories/${finance.id}`);
      categories = await inject('GET', '/template-categories');
      expect(categories.pageData.map(item => item.name)).to.deep.equal(['客服']);
      expect(categories.uncategorizedCount).to.equal(2);
      const uncategorized = await inject('GET', '/templates?filter[categoryId]=none');
      expect(uncategorized.pageData.map(item => item.name).sort()).to.deep.equal(['催款提醒', '通用签名'].sort());
    });

    it('should create, filter, update, copy, set status and remove templates', async () => {
      const category = await inject('POST', '/template-categories', { name: '招聘' });
      const template = await inject('POST', '/templates', {
        name: '面试邀请',
        categoryId: category.id,
        subject: '面试邀请：{{position}}',
        html: '<p>{{name}} 您好，诚邀您参加面试</p>',
        description: '发送给候选人'
      });
      expect(template.status).to.equal('enabled');

      try {
        await inject('POST', '/templates', { name: 'x', categoryId: 'not-exists' });
        expect.fail('should reject unknown category');
      } catch (e) {
        expect(e.statusCode).to.equal(404);
      }

      await inject('PUT', `/templates/${template.id}`, { subject: '【面试邀请】{{position}}' });
      const detail = await inject('GET', `/templates/${template.id}`);
      expect(detail.subject).to.equal('【面试邀请】{{position}}');
      expect(detail.category.name).to.equal('招聘');

      const copied = await inject('POST', `/templates/${template.id}/copy`);
      expect(copied).to.include({ name: '面试邀请（副本）', status: 'disabled', categoryId: category.id });

      const byKeyword = await inject('GET', '/templates?filter[keyword]=面试&filter[status]=enabled');
      expect(byKeyword.pageData.map(item => item.id)).to.deep.equal([template.id]);
      const byCategory = await inject('GET', `/templates?filter[categoryId]=${category.id}`);
      expect(byCategory.totalCount).to.equal(2);

      await inject('POST', `/templates/${template.id}/status`, { status: 'disabled' });
      expect((await inject('GET', `/templates/${template.id}`)).status).to.equal('disabled');
      await inject('DELETE', `/templates/${copied.id}`);
      expect((await inject('GET', `/templates?filter[categoryId]=${category.id}`)).totalCount).to.equal(1);
    });

    it('should render template with mail, account and extra variables and escape html', async () => {
      const account = await createAccount();
      await fastify.testContext.imap.addMessage({ subject: '合作咨询', messageId: '<r@x>', from: '赵六 <zhaoliu@example.com>' });
      await fastify.mailGateway.services.sync.syncAccount({ id: account.id });
      const mail = (await inject('GET', '/mails')).pageData[0];
      const template = await inject('POST', '/templates', {
        name: '回复',
        subject: 'Re: {{mail.subject}}',
        html: '<p>{{mail.from[0].name}} 您好，我是 {{account.name}} 的 {{agent}}</p>'
      });
      const rendered = await inject('POST', '/templates/render', { id: template.id, mailId: mail.id, data: { agent: '<小王>' } });
      expect(rendered.subject).to.equal('Re: 合作咨询');
      expect(rendered.html).to.equal('<p>赵六 您好，我是 测试邮箱 的 &lt;小王&gt;</p>');

      const preview = await inject('POST', '/templates/render', { template: { subject: '{{account.address}}', html: '<b>{{missing}}</b>' }, accountId: account.id });
      expect(preview).to.deep.equal({ subject: 'bot@test.local', html: '<b></b>' });
    });
  });

  describe('系统默认模版', () => {
    let templateDir;

    const writeFile = async (relativePath, content) => {
      const file = path.join(templateDir, relativePath);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content);
    };

    beforeEach(async () => {
      templateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mail-gateway-templates-'));
      await writeFile('customer-service_客服回复/_description.txt', '客户来信的标准回复\n');
      await writeFile(
        'customer-service_客服回复/receipt-notice_来信受理通知.html',
        '<!-- subject -->\n已收到：{{mail.subject}}\n<!-- description -->\n自动回复用\n<!-- html -->\n<p>{{mail.from[0].name}} 您好，已收到来信</p>\n'
      );
      await writeFile('finance_财务通知/invoice-issued_发票已开具.html', '<p>发票已开具</p>');
      await writeFile('signature_通用签名.html', '<p>此致</p>');
      await writeFile('.DS_Store', 'ignored');
      fastify = await createFastify({ templateDir });
      await fastify.mailGateway.services.template.includeTemplate(templateDir);
    });

    afterEach(async () => {
      await fs.rm(templateDir, { recursive: true, force: true });
    });

    it('should load system categories and templates from templateDir without duplicates', async () => {
      const categories = await inject('GET', '/template-categories');
      expect(categories.pageData.map(item => [item.code, item.name, item.level, item.description, item.templateCount])).to.deep.equal([
        ['customer-service', '客服回复', 0, '客户来信的标准回复', 1],
        ['finance', '财务通知', 0, null, 1]
      ]);
      expect(categories.uncategorizedCount).to.equal(1);

      const templates = await inject('GET', '/templates?filter[level]=0');
      expect(templates.totalCount).to.equal(3);
      const receipt = templates.pageData.find(item => item.code === 'receipt-notice');
      expect(receipt).to.include({ name: '来信受理通知', subject: '已收到：{{mail.subject}}', description: '自动回复用', status: 'enabled', level: 0 });
      expect(receipt.html).to.equal('<p>{{mail.from[0].name}} 您好，已收到来信</p>');
      expect(receipt.category.name).to.equal('客服回复');
      expect(templates.pageData.find(item => item.code === 'invoice-issued')).to.include({ subject: '', html: '<p>发票已开具</p>' });
      expect(templates.pageData.find(item => item.code === 'signature')).to.include({ name: '通用签名', categoryId: null });
    });

    it('should forbid editing or removing system records but allow status, copy and sort', async () => {
      const [service, finance] = (await inject('GET', '/template-categories')).pageData;
      const receipt = (await inject('GET', '/templates?filter[keyword]=受理')).pageData[0];
      const expectForbidden = async (method, url, payload) => {
        try {
          await inject(method, url, payload);
          expect.fail(`${method} ${url} should be forbidden`);
        } catch (e) {
          expect(e.statusCode).to.equal(403);
        }
      };

      await expectForbidden('PUT', `/templates/${receipt.id}`, { subject: 'x' });
      await expectForbidden('DELETE', `/templates/${receipt.id}`);
      await expectForbidden('PUT', `/template-categories/${service.id}`, { name: 'x' });
      await expectForbidden('DELETE', `/template-categories/${service.id}`);

      await inject('POST', `/templates/${receipt.id}/status`, { status: 'disabled' });
      const copied = await inject('POST', `/templates/${receipt.id}/copy`);
      expect(copied).to.include({ level: 1, categoryId: service.id, status: 'disabled' });
      expect(copied.code == null).to.equal(true);
      await inject('PUT', `/templates/${copied.id}`, { subject: '改过的主题' });

      const custom = await inject('POST', '/templates', { name: '自定义', categoryId: finance.id, html: '<p>x</p>' });
      expect(custom.level).to.equal(1);
      expect((await inject('GET', '/templates?filter[level]=1')).totalCount).to.equal(2);

      await inject('POST', '/template-categories/sort', { ids: [finance.id, service.id] });
      expect((await inject('GET', '/template-categories')).pageData.map(item => item.code)).to.deep.equal(['finance', 'customer-service']);
    });

    it('should overwrite content on reload while keeping status and sort', async () => {
      const [service, finance] = (await inject('GET', '/template-categories')).pageData;
      const receipt = (await inject('GET', '/templates?filter[keyword]=受理')).pageData[0];
      await inject('POST', `/templates/${receipt.id}/status`, { status: 'disabled' });
      await inject('POST', '/template-categories/sort', { ids: [finance.id, service.id] });

      await writeFile('customer-service_客服回复/receipt-notice_来信受理通知.html', '<!-- subject -->\n新主题\n<!-- html -->\n<p>新正文</p>');
      await fs.rename(path.join(templateDir, 'signature_通用签名.html'), path.join(templateDir, 'finance_财务通知', 'signature_落款签名.html'));
      await fastify.mailGateway.services.template.includeTemplate(templateDir);

      const detail = await inject('GET', `/templates/${receipt.id}`);
      expect(detail).to.include({ subject: '新主题', html: '<p>新正文</p>', description: null, status: 'disabled' });
      const signature = (await inject('GET', '/templates?filter[keyword]=签名')).pageData;
      expect(signature.map(item => [item.name, item.categoryId])).to.deep.equal([['落款签名', finance.id]]);
      expect((await inject('GET', '/templates')).totalCount).to.equal(3);
      expect((await inject('GET', '/template-categories')).pageData.map(item => item.code)).to.deep.equal(['finance', 'customer-service']);
    });
  });

  describe('联系人', () => {
    beforeEach(async () => {
      fastify = await createFastify();
    });

    it('should manage contacts with keyword search and normalized address', async () => {
      const zhang = await inject('POST', '/contacts', { name: '张三', address: 'ZhangSan@Example.com', remark: '客户' });
      expect(zhang.address).to.equal('zhangsan@example.com');
      await inject('POST', '/contacts', { name: '李四', address: 'lisi@partner.com' });

      expect((await inject('GET', '/contacts')).totalCount).to.equal(2);
      expect((await inject('GET', `/contacts?filter[keyword]=${encodeURIComponent('张')}`)).pageData.map(item => item.name)).to.deep.equal(['张三']);
      expect((await inject('GET', '/contacts?filter[keyword]=PARTNER')).pageData.map(item => item.name)).to.deep.equal(['李四']);
      expect((await inject('GET', '/contacts?filter[address]=ZHANGSAN@example.com')).totalCount).to.equal(1);

      const saved = await inject('PUT', `/contacts/${zhang.id}`, { name: '张三丰', avatar: 'file-avatar-1' });
      expect(saved.name).to.equal('张三丰');
      expect(saved.avatar).to.equal('file-avatar-1');
      await inject('DELETE', `/contacts/${zhang.id}`);
      expect((await inject('GET', '/contacts')).pageData.map(item => item.name)).to.deep.equal(['李四']);
    });

    it('should reject duplicated or invalid address', async () => {
      const contact = await inject('POST', '/contacts', { name: '张三', address: 'zhangsan@example.com' });
      const other = await inject('POST', '/contacts', { name: '李四', address: 'lisi@example.com' });

      const duplicated = await inject('POST', '/contacts', { address: 'ZHANGSAN@example.com' }).catch(e => e);
      expect(duplicated.statusCode).to.equal(409);
      const conflict = await inject('PUT', `/contacts/${other.id}`, { address: 'zhangsan@example.com' }).catch(e => e);
      expect(conflict.statusCode).to.equal(409);
      await inject('PUT', `/contacts/${contact.id}`, { address: 'zhangsan@example.com', name: '张三' });

      const invalid = await inject('POST', '/contacts', { address: 'not-an-email' }).catch(e => e);
      expect(invalid.statusCode).to.equal(400);
    });
  });
});
