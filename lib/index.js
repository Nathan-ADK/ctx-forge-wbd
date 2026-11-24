'use strict';
/**
 * ctx-forge 公共入口（Node 库 + DSH cordis 协议合一）。
 *  - WBD / WorkBuddy：导出 forge / hook / cli / token / deep / gate。
 *  - DSH 宿主（cordis）：导出 { name, inject, apply }（经 dsh/adapter 惰性挂载）。
 * 公共 npm / GitHub 包 files 仅含 WBD 路径；DSH 宿主独立入口 dsh/index.js，
 * 不随公共包发布。adapter 惰性 require，WBD 侧不依赖 DSH 运行时。
 */
const forge = require('./forge');
const api = Object.assign({}, forge, {
  hook: require('./hook'),
  cli: require('./cli'),
  token: require('./token'),
  deep: (() => { try { return require('./deep'); } catch (_) { return {}; } })(),
  gate: (() => { try { return require('./gate'); } catch (_) { return {}; } })(),
});
// DSH cordis 协议（惰性，仅在 dsh/adapter 存在时挂载；WBD 公共包不含 dsh/，自动跳过）
try {
  const adapter = require('../dsh/adapter');
  api.name = adapter.name;
  api.inject = adapter.inject;
  api.apply = adapter.apply;
} catch (_) { /* WBD-only：无 dsh/ 时静默跳过 */ }
module.exports = api;
