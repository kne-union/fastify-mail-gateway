const crypto = require('node:crypto');

const DEFAULT_SECRET = 'fastify-mail-gateway-default-secret';
const PREFIX = 'enc:v1:';

const getKey = secretKey =>
  crypto
    .createHash('sha256')
    .update(String(secretKey || DEFAULT_SECRET))
    .digest();

const encrypt = (text, secretKey) => {
  if (text == null || text === '') {
    return text;
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(secretKey), iv);
  const encrypted = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, encrypted]).toString('base64');
};

const decrypt = (payload, secretKey) => {
  if (typeof payload !== 'string' || !payload.startsWith(PREFIX)) {
    return payload;
  }
  const buffer = Buffer.from(payload.slice(PREFIX.length), 'base64');
  const iv = buffer.subarray(0, 12);
  const tag = buffer.subarray(12, 28);
  const encrypted = buffer.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(secretKey), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
};

module.exports = { encrypt, decrypt };
