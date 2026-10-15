const escape = require('lodash/escape');
const toPath = require('lodash/toPath');

const getOwn = (data, path) => {
  return toPath(path).reduce((current, key) => (current != null && Object.prototype.hasOwnProperty.call(current, key) ? current[key] : undefined), data);
};

/**
 * 只做 {{path}} 变量替换（只读取自有属性），不执行任何表达式，避免规则配置带来代码执行风险
 */
const renderTemplate = (template, data, { html = false } = {}) => {
  return String(template || '').replace(/{{\s*([\w.[\]]+)\s*}}/g, (match, path) => {
    const value = getOwn(data, path);
    if (value == null) {
      return '';
    }
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return html ? escape(text) : text;
  });
};

/**
 * 解析模版文件：按 <!-- subject --> / <!-- description --> / <!-- html --> 分段；没有任何分段标记时整个文件作为 html
 */
const parseTemplateFile = text => {
  const regex = /<!--\s*(subject|description|html)\s*-->\s*([\s\S]*?)(?=\s*<!--\s*(?:subject|description|html)\s*-->|$)/g;
  const result = {};
  let match;
  while ((match = regex.exec(text)) !== null) {
    result[match[1]] = match[2].trim();
  }
  if (Object.keys(result).length === 0) {
    return { subject: '', html: String(text).trim(), description: null };
  }
  return { subject: result.subject || '', html: result.html || '', description: result.description || null };
};

module.exports = { renderTemplate, parseTemplateFile };
