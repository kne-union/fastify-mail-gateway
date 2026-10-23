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
    filter: { type: 'object', default: {}, description: '筛选条件，querystring 中写作 filter[字段]=值', properties: filterProperties }
  }
});

const addressField = { description: "地址，支持 'a@x.com, B <b@x.com>' 字符串或 [{ name, address }] 数组" };

const attachmentsField = {
  type: 'array',
  description: '附件 [{ id, filename, contentType, size, url }]，id 为文件系统中的文件 id；引用尚未下载的收信附件时传 { mailId, index }，发送前会先下载',
  items: {
    type: 'object',
    additionalProperties: true,
    properties: {
      id: { description: '文件存储中的文件 ID' },
      filename: { description: '文件名' },
      contentType: { description: 'MIME 类型' },
      size: { description: '大小（字节）' },
      url: { description: '附件地址，无文件 ID 时按 url 读取' },
      mailId: { description: '引用收信附件时的邮件 ID，与 index 一起使用' },
      index: { description: '引用收信附件时附件在该邮件 attachments 中的下标' }
    }
  }
};

const statusBody = {
  type: 'object',
  required: ['status'],
  properties: { status: { type: 'string', enum: ['enabled', 'disabled'], description: '状态：enabled 启用，disabled 停用' } }
};

module.exports = { idParams, idsBody, pageQuery, addressField, attachmentsField, statusBody };
