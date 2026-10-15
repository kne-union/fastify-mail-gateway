const { formatAddressList } = require('./address');

const MAX_TEXT_LENGTH = 100000;

const CONDITION_FIELDS = ['from', 'to', 'cc', 'subject', 'text', 'hasAttachment', 'accountId'];
const CONDITION_OPERATORS = ['contains', 'notContains', 'equals', 'startsWith', 'endsWith', 'regex'];

const stripHtml = html =>
  String(html || '')
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');

/**
 * 取出字段的待比较值：地址类字段返回 { text, list }，list 用于 equals 精确匹配每个地址
 */
const getFieldValue = (mail, field) => {
  switch (field) {
    case 'from':
    case 'to':
    case 'cc': {
      const list = mail[field] || [];
      return { text: formatAddressList(list), list: list.map(item => item.address) };
    }
    case 'subject':
      return { text: mail.subject || '' };
    case 'text':
      return { text: (mail.text || stripHtml(mail.html)).slice(0, MAX_TEXT_LENGTH) };
    case 'hasAttachment':
      return { text: String((mail.attachments || []).length > 0) };
    case 'accountId':
      return { text: String(mail.accountId || '') };
    default:
      return { text: '' };
  }
};

const compare = (operator, source, value) => {
  const text = source.text.toLowerCase();
  const target = String(value == null ? '' : value).toLowerCase();
  switch (operator) {
    case 'contains':
      return text.includes(target);
    case 'notContains':
      return !text.includes(target);
    case 'equals':
      if (source.list) {
        return source.list.some(item => String(item).toLowerCase() === target);
      }
      return text === target;
    case 'startsWith':
      return text.startsWith(target);
    case 'endsWith':
      return text.endsWith(target);
    case 'regex':
      try {
        return new RegExp(String(value), 'i').test(source.text);
      } catch (e) {
        return false;
      }
    default:
      return false;
  }
};

/**
 * 内置条件求值；规则整体的组合与扩展条件由 services.condition.evaluate 负责
 */
const evaluateItem = (mail, item) => {
  return compare(item.operator, getFieldValue(mail, item.field), item.value);
};

module.exports = { evaluateItem, CONDITION_FIELDS, CONDITION_OPERATORS, stripHtml };
