const addressparser = require('nodemailer/lib/addressparser');

const flattenAddress = list => {
  return list.flatMap(item => {
    if (item.group) {
      return flattenAddress(item.group);
    }
    return item.address ? [{ name: item.name || '', address: item.address }] : [];
  });
};

/**
 * 统一地址格式为 [{ name, address }]
 * 支持：'a@x.com, B <b@x.com>'、['a@x.com']、[{ name, address }]、mailparser 的 { value: [...] }
 */
const normalizeAddressList = input => {
  if (!input) {
    return [];
  }
  if (typeof input === 'string') {
    return flattenAddress(addressparser(input));
  }
  if (Array.isArray(input)) {
    return input.flatMap(item => normalizeAddressList(item));
  }
  if (Array.isArray(input.value)) {
    return flattenAddress(input.value);
  }
  if (input.address) {
    return [{ name: input.name || '', address: input.address }];
  }
  return [];
};

const formatAddressList = list => {
  return (list || []).map(({ name, address }) => (name ? `${name} <${address}>` : address)).join(', ');
};

module.exports = { normalizeAddressList, formatAddressList };
