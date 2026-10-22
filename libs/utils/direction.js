// 规则触发时机：receive 收信后；beforeSend 发信前（可拦截或修改邮件）；send 发信后；schedule 定时（按时间窗口聚合未读邮件）
const DIRECTIONS = ['receive', 'beforeSend', 'send', 'schedule'];

// 未声明 directions 的动作 / 扩展条件只用于收信后和发信后：发信前邮件尚未入库（没有 id），定时规则处理的是一批邮件，均需显式声明才可用
const DEFAULT_DIRECTIONS = ['receive', 'send'];

module.exports = { DIRECTIONS, DEFAULT_DIRECTIONS };
