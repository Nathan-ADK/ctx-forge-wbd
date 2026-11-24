'use strict';
// 零依赖 token 估算：CJK 近似 1.5 字/token，其余 4 字符/token。可插拔后端。
function count(text) {
  if (!text) return 0;
  const s = String(text);
  const cjk = (s.match(/[一-鿿]/g) || []).length;
  const other = s.length - cjk;
  return Math.ceil(cjk / 1.5 + other / 4);
}
function ratio(before, after) {
  const b = count(before) || 1;
  return +((1 - count(after) / b) * 100).toFixed(1);
}
module.exports = { count, ratio };
