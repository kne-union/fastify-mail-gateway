/**
 * 动作参数表单使用 @kne/form-creator 的搭建 Schema：{ blocks: [{ id, kind, list: [{ id, type, name, label, rule, description, props }] }] }
 * 前端用 SchemaRendererInner 渲染，字段值即动作 params。
 */

const createFormSchema = (list, block = {}) => ({
  blocks: [Object.assign({ id: 'params', kind: 'formInfo', column: 1 }, block, { list })]
});

const CHILD_BLOCK_KEYS = ['blocks', 'itemBlocks'];

/**
 * 补齐 block / field 的 id：form-creator 对缺失 id 每次渲染都会生成随机 id，导致字段反复重新挂载
 */
const normalizeFormSchema = schema => {
  if (!schema) {
    return null;
  }
  const normalizeList = (list, prefix) => (list || []).map((field, index) => Object.assign({}, field, { id: field.id || `${prefix}-${field.name || index}` }));
  const normalizeBlock = (block, prefix) => {
    const id = block.id || prefix;
    const next = Object.assign({}, block, { id, list: normalizeList(block.list, id) });
    CHILD_BLOCK_KEYS.forEach(key => {
      if (Array.isArray(block[key])) {
        next[key] = block[key].map((child, index) => normalizeBlock(child, `${id}-${key}-${index}`));
      }
    });
    if (Array.isArray(block.options)) {
      next.options = block.options.map((option, index) => normalizeBlock(option, `${id}-option-${index}`));
    }
    if (Array.isArray(block.items)) {
      next.items = block.items.map((item, index) => normalizeBlock(item, `${id}-item-${index}`));
    }
    return next;
  };
  const blocks = Array.isArray(schema.blocks) ? schema.blocks : Array.isArray(schema.list) ? [{ kind: 'formInfo', column: 1, list: schema.list }] : [];
  return Object.assign({}, schema, { blocks: blocks.map((block, index) => normalizeBlock(block, `block-${index}`)) });
};

/**
 * 收集 formInfo / object 区块（含嵌套子区块）里的字段，name 为 params 中的取值路径
 * list / tableList 等列表区块的必填项仅由前端校验
 */
const collectFields = schema => {
  const fields = [];
  const walk = (blocks, prefix) => {
    (blocks || []).forEach(block => {
      const kind = block.kind || 'formInfo';
      if (kind !== 'formInfo' && kind !== 'object') {
        return;
      }
      const namePrefix = kind === 'object' && block.name ? [...prefix, block.name] : prefix;
      (block.list || []).forEach(field => {
        if (field.name && !field.hidden) {
          fields.push(Object.assign({}, field, { path: [...namePrefix, ...String(field.name).split('.')] }));
        }
      });
      walk(block.blocks, namePrefix);
    });
  };
  walk(schema?.blocks, []);
  return fields;
};

const isRequiredField = field =>
  String(field.rule || '')
    .split(/\s+/)
    .includes('REQ');

const getPathValue = (target, path) => path.reduce((value, key) => (value == null ? undefined : value[key]), target);

module.exports = { createFormSchema, normalizeFormSchema, collectFields, isRequiredField, getPathValue };
