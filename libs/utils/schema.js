const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', description: 'ID' } }
};

const idsBody = (extra = {}) => ({
  type: 'object',
  required: ['ids'],
  properties: Object.assign({ ids: { type: 'array', items: { type: 'string' }, description: 'ID 列表' } }, extra)
});

const pageQuery = filterProperties => ({
  type: 'object',
  properties: {
    currentPage: { type: 'integer', default: 1, description: '页码' },
    perPage: { type: 'integer', default: 20, description: '每页数量' },
    filter: { type: 'object', default: {}, properties: filterProperties }
  }
});

const addressField = { description: "地址，支持 'a@x.com, B <b@x.com>' 字符串或 [{ name, address }] 数组" };

const attachmentsField = {
  type: 'array',
  description: '附件 [{ id, filename, contentType, size, url }]，id 为文件系统中的文件 id',
  items: { type: 'object', additionalProperties: true }
};

const statusBody = {
  type: 'object',
  required: ['status'],
  properties: { status: { type: 'string', enum: ['enabled', 'disabled'], description: '状态' } }
};

module.exports = { idParams, idsBody, pageQuery, addressField, attachmentsField, statusBody };
