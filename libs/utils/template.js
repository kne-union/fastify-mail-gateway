const { renderTemplate: renderLiquid, validateTemplateHtml } = require('@kne/message-template');

/**
 * Liquid 子集渲染（@kne/message-template）：{{ path }} 变量、{% if %} 条件；html 模式下变量值转义
 */
const renderTemplate = (template, data, { html = false } = {}) => {
  return renderLiquid(String(template || ''), data || {}, html ? {} : { type: 'text' });
};

// 旧模版的 {{mail.from[0].name}} 渲染没问题，但校验只认点号路径，校验时按等价的 .first 处理
const normalizeFirstIndex = template => String(template || '').replace(/({{[\s\S]*?}}|{%[\s\S]*?%})/g, tag => tag.replace(/\[0\]/g, '.first'));

/**
 * 校验模版语法（标签闭合、条件表达式），不通过时返回错误信息
 */
const validateTemplate = template => {
  const { ok, error } = validateTemplateHtml(normalizeFirstIndex(template));
  return ok ? null : error;
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

module.exports = { renderTemplate, validateTemplate, parseTemplateFile };
