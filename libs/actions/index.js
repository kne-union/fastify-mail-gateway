const crypto = require('node:crypto');
const { renderTemplate } = require('../utils/template');
const { formatAddressList, normalizeAddressList } = require('../utils/address');

const NO_REPLY_PATTERN = /(no-?reply|do-?not-?reply|mailer-daemon|postmaster)/i;
const BULK_PRECEDENCE = ['bulk', 'list', 'junk'];

/**
 * 判断是否不应自动回复：自动生成的邮件、邮件列表、群发、no-reply 发件人、自己发给自己
 */
const shouldSkipAutoReply = ({ mail, account }) => {
  const headers = mail.headers || {};
  const sender = (mail.from || [])[0];
  if (!sender || !sender.address) {
    return '发件人为空';
  }
  if (account && sender.address.toLowerCase() === String(account.address).toLowerCase()) {
    return '发件人为当前邮箱';
  }
  if (headers['auto-submitted'] && String(headers['auto-submitted']).toLowerCase() !== 'no') {
    return '自动生成的邮件';
  }
  if (headers['list-id'] || headers['list-unsubscribe']) {
    return '邮件列表邮件';
  }
  if (headers['precedence'] && BULK_PRECEDENCE.includes(String(headers['precedence']).toLowerCase())) {
    return '群发邮件';
  }
  if (NO_REPLY_PATTERN.test(sender.address)) {
    return 'no-reply 发件人';
  }
  return null;
};

const quoteOriginal = mail => {
  const lines = [`From: ${formatAddressList(mail.from)}`, `Date: ${mail.date ? new Date(mail.date).toISOString() : ''}`, `To: ${formatAddressList(mail.to)}`, `Subject: ${mail.subject || ''}`];
  const header = lines.map(line => line.replace(/</g, '&lt;').replace(/>/g, '&gt;')).join('<br/>');
  return `<br/><div>---------- Forwarded message ----------<br/>${header}</div><br/>${mail.html || (mail.text || '').replace(/\n/g, '<br/>')}`;
};

const escapeHtml = value =>
  String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const toMailHtml = mail => mail.html || escapeHtml(mail.text).replace(/\n/g, '<br/>');

const DIGEST_SNIPPET_LENGTH = 200;

const toSnippet = mail =>
  String(mail.text || String(mail.html || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DIGEST_SNIPPET_LENGTH);

const formatDate = date => (date ? new Date(date).toISOString().replace('T', ' ').slice(0, 16) : '');

/**
 * 汇总邮件列表：逐封列出发件人、时间、主题与正文片段
 */
const buildDigestHtml = mails =>
  `<ol>${mails
    .map(mail => `<li><p><strong>${escapeHtml(mail.subject || '（无主题）')}</strong><br/>${escapeHtml(formatAddressList(mail.from))} · ${escapeHtml(formatDate(mail.date))}</p><p>${escapeHtml(toSnippet(mail))}</p></li>`)
    .join('')}</ol>`;

// 批量动作：定时规则处理 mails，其它方向处理单封 mail
const targetIds = ({ mail, mails }) => (mails ? mails.map(item => item.id) : [mail.id]);

// webhook 在发信前可返回 { block, mail } 拦截或修改邮件
const readWebhookDecision = async response => {
  if (!String(response.headers.get('content-type') || '').includes('application/json')) {
    return {};
  }
  const data = await response.json().catch(() => null);
  if (!data || typeof data !== 'object') {
    return {};
  }
  return Object.fromEntries(['block', 'mail'].filter(key => data[key] !== undefined && data[key] !== null).map(key => [key, data[key]]));
};

/**
 * 内置动作参数表单的字段 type 除 form-creator 内置类型（Input / TextArea / InputNumber 等）外，
 * 还用到前端 components-admin MailGateway 注册的 MailLabelSelect / MailTemplateSelect / MailContactSelect / MailEditor / MailTemplateText / MailJson
 */
module.exports = ({ register, createFormSchema }) => {
  register('addLabel', {
    builtIn: true,
    label: '打标签',
    description: '给邮件添加标签，收件箱中按标签显示为文件夹',
    formSchema: createFormSchema([{ type: 'MailLabelSelect', name: 'labelIds', label: '标签', rule: 'REQ' }]),
    handler: async ({ mail, params, services }) => {
      const labelIds = [].concat(params.labelIds || []);
      await services.mail.addLabels({ id: mail.id, labelIds });
      return { labelIds };
    }
  });

  register('markRead', {
    builtIn: true,
    label: '标为已读',
    description: '把邮件标为已读，并同步到邮件服务器；未读邮件规则中处理本次统计到的全部邮件',
    directions: ['receive', 'schedule'],
    handler: async ({ mail, mails, account, services }) => {
      const ids = targetIds({ mail, mails });
      await services.mail.setRead({ ids, isRead: true, userId: account && account.userId });
      return mails ? { count: ids.length } : undefined;
    }
  });

  register('star', {
    builtIn: true,
    label: '加星标',
    handler: async ({ mail, account, services }) => {
      await services.mail.setStar({ ids: [mail.id], isStarred: true, userId: account && account.userId });
    }
  });

  register('moveToTrash', {
    builtIn: true,
    label: '移入回收站',
    description: '把邮件移入回收站，并同步到邮件服务器；未读邮件规则中处理本次统计到的全部邮件',
    directions: ['receive', 'send', 'schedule'],
    handler: async ({ mail, mails, account, services }) => {
      const ids = targetIds({ mail, mails });
      await services.mail.moveToTrash({ ids, userId: account && account.userId });
      return mails ? { count: ids.length } : undefined;
    }
  });

  register('autoReply', {
    builtIn: true,
    label: '自动回复',
    description: '用当前邮箱回复发件人。可选择邮件模版或直接填写回复内容，支持 {{mail.subject}}、{{mail.from[0].name}}、{{account.name}} 等变量；自动跳过自动生成邮件、邮件列表和 no-reply 发件人',
    directions: ['receive'],
    formSchema: createFormSchema([
      { type: 'MailTemplateSelect', name: 'templateId', label: '邮件模版', description: '选择模版后使用模版的主题与正文，模版主题为空时使用下方回复主题' },
      { type: 'MailTemplateText', name: 'subject', label: '回复主题', props: { defaultValue: 'Re: {{mail.subject}}' } },
      { type: 'MailEditor', name: 'html', label: '回复内容', description: '未选择模版时必填' },
      { type: 'InputNumber', name: 'intervalHours', label: '同一发件人最短回复间隔（小时）', props: { defaultValue: 24, min: 0 } }
    ]),
    validate: params => {
      if (!params.templateId && !params.html) {
        throw new Error('请选择邮件模版或填写回复内容');
      }
    },
    handler: async ({ mail, account, params, services, models, fastify }) => {
      const skipReason = shouldSkipAutoReply({ mail, account });
      if (skipReason) {
        return { skipped: true, reason: skipReason };
      }
      const sender = mail.from[0];
      const intervalHours = params.intervalHours == null || params.intervalHours === '' ? 24 : Number(params.intervalHours);
      if (intervalHours > 0) {
        const { Op } = fastify.sequelize.Sequelize;
        const recent = await models.mail.findAll({
          where: { accountId: mail.accountId, folder: 'sent', date: { [Op.gte]: new Date(Date.now() - intervalHours * 3600 * 1000) } },
          attributes: ['to', 'headers']
        });
        const replied = recent.some(item => (item.headers || {})['auto-submitted'] === 'auto-replied' && (item.to || []).some(to => String(to.address).toLowerCase() === sender.address.toLowerCase()));
        if (replied) {
          return { skipped: true, reason: `${intervalHours} 小时内已自动回复过该发件人` };
        }
      }
      let template = { subject: params.subject, html: params.html };
      if (params.templateId) {
        const templateId = typeof params.templateId === 'object' ? params.templateId.id || params.templateId.value : params.templateId;
        const target = await services.template.detail({ id: templateId, userId: account && account.userId });
        if (target.status !== 'enabled') {
          throw new Error(`邮件模版「${target.name}」已停用`);
        }
        template = { subject: target.subject || params.subject, html: target.html };
      }
      const data = { mail, account };
      const reply = await services.mail.send({
        userId: account && account.userId,
        accountId: mail.accountId,
        to: [sender],
        subject: renderTemplate(template.subject || 'Re: {{mail.subject}}', data),
        html: renderTemplate(template.html, data, { html: true }),
        inReplyTo: mail.messageId,
        references: mail.references,
        headers: { 'Auto-Submitted': 'auto-replied', 'X-Auto-Response-Suppress': 'All' },
        skipRules: true
      });
      return { replyMailId: reply.id, to: sender.address, templateId: params.templateId || null };
    }
  });

  register('forward', {
    builtIn: true,
    label: '转发',
    description: '用当前邮箱把邮件（含附件）转发给指定地址',
    formSchema: createFormSchema([
      { type: 'MailContactSelect', name: 'to', label: '转发给', rule: 'REQ' },
      { type: 'TextArea', name: 'comment', label: '附言', props: { rows: 3 } }
    ]),
    handler: async ({ mail, account, params, services, log }) => {
      const comment = params.comment ? `<div>${String(params.comment).replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br/>')}</div>` : '';
      const attachments = [];
      for (const [index, item] of (mail.attachments || []).entries()) {
        try {
          attachments.push(item.id || item.url ? item : await services.mail.downloadAttachment({ id: mail.id, index, userId: account && account.userId }));
        } catch (e) {
          log(`附件未转发: ${item.filename}`, e.message);
        }
      }
      const forwarded = await services.mail.send({
        userId: account && account.userId,
        accountId: mail.accountId,
        to: params.to,
        subject: `Fwd: ${mail.subject || ''}`,
        html: comment + quoteOriginal(mail),
        attachments,
        headers: { 'Auto-Submitted': 'auto-forwarded' },
        skipRules: true
      });
      return { forwardMailId: forwarded.id };
    }
  });

  register('digestForward', {
    builtIn: true,
    label: '汇总转发',
    description: '未读邮件规则中把本次统计到的未读邮件汇总成一封邮件（逐封列出发件人、时间、主题和正文片段），用当前邮箱发给指定地址；主题支持 {{count}}、{{account.name}} 等变量',
    directions: ['schedule'],
    formSchema: createFormSchema([
      { type: 'MailContactSelect', name: 'to', label: '转发给', rule: 'REQ' },
      { type: 'MailTemplateText', name: 'subject', label: '主题', props: { defaultValue: '未读邮件汇总（{{count}} 封）' } },
      { type: 'TextArea', name: 'comment', label: '附言', props: { rows: 3 } }
    ]),
    handler: async ({ mails, account, params, services }) => {
      const list = mails || [];
      if (list.length === 0) {
        return { skipped: true, reason: '没有需要汇总的邮件' };
      }
      const comment = params.comment ? `<p>${escapeHtml(params.comment).replace(/\n/g, '<br/>')}</p>` : '';
      const data = { count: list.length, account };
      const sent = await services.mail.send({
        userId: account && account.userId,
        accountId: account.id,
        to: params.to,
        subject: renderTemplate(params.subject || '未读邮件汇总（{{count}} 封）', data),
        html: comment + buildDigestHtml(list),
        headers: { 'Auto-Submitted': 'auto-generated' },
        skipRules: true
      });
      return { digestMailId: sent.id, count: list.length };
    }
  });

  register('blockSend', {
    builtIn: true,
    label: '拦截发送',
    description: '不发送这封邮件，发件人会看到拦截提示；可与其它动作组合，如先调用 Webhook 通知再拦截',
    directions: ['beforeSend'],
    formSchema: createFormSchema([{ type: 'TextArea', name: 'message', label: '拦截提示', props: { rows: 3, placeholder: '如：外部邮件不允许携带附件' } }]),
    handler: async ({ mail, params }) => ({
      block: params.message || '邮件被拦截',
      subject: mail.subject,
      to: formatAddressList(mail.to)
    })
  });

  register('modifySubject', {
    builtIn: true,
    label: '修改主题',
    description: '给主题加前缀或后缀，支持 {{mail.subject}}、{{account.name}} 等变量；主题已带相同前缀 / 后缀时不重复添加',
    directions: ['beforeSend'],
    formSchema: createFormSchema([
      { type: 'MailTemplateText', name: 'prefix', label: '前缀' },
      { type: 'MailTemplateText', name: 'suffix', label: '后缀' }
    ]),
    validate: params => {
      if (!params.prefix && !params.suffix) {
        throw new Error('请填写前缀或后缀');
      }
    },
    handler: async ({ mail, account, params }) => {
      const data = { mail, account };
      const prefix = params.prefix ? renderTemplate(params.prefix, data) : '';
      const suffix = params.suffix ? renderTemplate(params.suffix, data) : '';
      let subject = mail.subject || '';
      if (prefix && !subject.startsWith(prefix)) {
        subject = prefix + subject;
      }
      if (suffix && !subject.endsWith(suffix)) {
        subject = subject + suffix;
      }
      return { mail: { subject } };
    }
  });

  register('appendContent', {
    builtIn: true,
    label: '正文追加内容',
    description: '在正文顶部或底部追加内容，如免责声明、签名；支持 {{mail.subject}}、{{account.name}} 等变量',
    directions: ['beforeSend'],
    formSchema: createFormSchema([
      { type: 'MailEditor', name: 'html', label: '追加内容', rule: 'REQ' },
      {
        type: 'RadioGroup',
        name: 'position',
        label: '位置',
        props: {
          defaultValue: 'bottom',
          options: [
            { label: '正文底部', value: 'bottom' },
            { label: '正文顶部', value: 'top' }
          ]
        }
      }
    ]),
    handler: async ({ mail, account, params }) => {
      const content = renderTemplate(params.html, { mail, account }, { html: true });
      const body = toMailHtml(mail);
      return { mail: { html: params.position === 'top' ? content + body : body + content } };
    }
  });

  register('addRecipients', {
    builtIn: true,
    label: '添加抄送 / 密送',
    description: '给邮件追加抄送或密送地址，已在收件人、抄送、密送中的地址不重复添加',
    directions: ['beforeSend'],
    formSchema: createFormSchema([
      { type: 'MailContactSelect', name: 'cc', label: '抄送' },
      { type: 'MailContactSelect', name: 'bcc', label: '密送' }
    ]),
    validate: params => {
      if (normalizeAddressList(params.cc).length === 0 && normalizeAddressList(params.bcc).length === 0) {
        throw new Error('请填写抄送或密送地址');
      }
    },
    handler: async ({ mail, params }) => {
      const existing = new Set([...(mail.to || []), ...(mail.cc || []), ...(mail.bcc || [])].map(item => String(item.address).toLowerCase()));
      const pick = list =>
        normalizeAddressList(list).filter(item => {
          const key = String(item.address).toLowerCase();
          if (existing.has(key)) {
            return false;
          }
          existing.add(key);
          return true;
        });
      const cc = pick(params.cc);
      const bcc = pick(params.bcc);
      return { mail: { cc: [...(mail.cc || []), ...cc], bcc: [...(mail.bcc || []), ...bcc] }, added: { cc: formatAddressList(cc), bcc: formatAddressList(bcc) } };
    }
  });

  register('webhook', {
    builtIn: true,
    label: '调用 Webhook',
    description: 'POST JSON 到指定地址，可选用 secret 对请求体做 HMAC-SHA256 签名（请求头 X-Mail-Gateway-Signature）；发信前规则中，接口返回 JSON { block, mail } 可拦截或修改邮件',
    directions: ['receive', 'beforeSend', 'send'],
    formSchema: createFormSchema([
      { type: 'Input', name: 'url', label: '地址', rule: 'REQ' },
      { type: 'Password', name: 'secret', label: '签名密钥' },
      { type: 'MailJson', name: 'headers', label: '自定义请求头', description: '键值对 JSON，如 {"Authorization": "Bearer xxx"}', props: { defaultValue: { 'Content-Type': 'application/json' } } },
      { type: 'InputNumber', name: 'timeout', label: '超时（毫秒）', props: { defaultValue: 10000, min: 0 } }
    ]),
    handler: async ({ mail, account, params, rule, direction }) => {
      const body = JSON.stringify({
        event: direction,
        rule: rule ? { id: rule.id, name: rule.name } : null,
        account: account ? { id: account.id, name: account.name, address: account.address } : null,
        mail
      });
      const headers = Object.assign({ 'Content-Type': 'application/json' }, typeof params.headers === 'object' && params.headers ? params.headers : {});
      if (params.secret) {
        headers['X-Mail-Gateway-Signature'] = `sha256=${crypto.createHmac('sha256', String(params.secret)).update(body).digest('hex')}`;
      }
      const response = await fetch(params.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(Number(params.timeout) || 10000) });
      if (!response.ok) {
        throw new Error(`Webhook 返回 ${response.status}`);
      }
      return Object.assign({ status: response.status }, direction === 'beforeSend' ? await readWebhookDecision(response) : {});
    }
  });
};

module.exports.shouldSkipAutoReply = shouldSkipAutoReply;
module.exports.buildDigestHtml = buildDigestHtml;
