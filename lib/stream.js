'use strict';
/**
 * ctx-forge 流式实时截断（DSH llm/stream waterfall）。
 *
 * 成本账：不缓冲整段、不重写、不回注违规原因——那会生成两遍，是负资产。
 * 本模块在 chunk 到达时就地计数行数/字数，一旦超限立即停读上游并补一个终止 chunk。
 * 效果：输出被物理掐断在预算内（配合 maxTokens 生成层硬限，从源头+末端双层省 token）。
 */
const DEFAULT = { enabled: true, maxChars: 600, maxLines: 3 };

function guard(upstream, cfg = {}) {
  const c = Object.assign({}, DEFAULT, cfg);
  if (!c.enabled || !upstream || typeof upstream[Symbol.asyncIterator] !== 'function') return upstream;

  async function* wrapped() {
    const iter = upstream[Symbol.asyncIterator]();
    let lines = 0, chars = 0, finished = false;
    try {
      while (!finished) {
        const { value, done } = await iter.next();
        if (done) break;
        const isObj = value && typeof value === 'object';
        // 只统计文本类 chunk；reasoning/工具 chunk 原样放行，避免误伤工具调用与思考。
        if (isObj && value.type && value.type !== 'text') {
          yield value;
          continue;
        }
        // 文本源：字符串 chunk 直接取；对象 chunk 取 .text 字段，不把它 String 成 [object Object]。
        const chunk = isObj ? String(value.text || '') : String(value || '');
        // 逐字符累计，超限即截断本 chunk 并结束流。
        // 允许 maxLines-1 个换行符（即最多 maxLines 行）；遇到第 maxLines 个换行符即停。
        let kept = '';
        for (const ch of chunk) {
          if (ch === '\n') {
            if (lines >= c.maxLines - 1) { finished = true; break; }
            lines++;
          }
          chars++;
          if (chars > c.maxChars) { finished = true; break; }
          kept += ch;
        }
        if (kept) {
          if (isObj) yield Object.assign({}, value, { text: kept });
          else yield kept;
        }
        if (finished) {
          try { if (iter.return) await iter.return(); } catch (_) {}
          break;
        }
      }
    } catch (e) {
      // 上游出错：不吞已收到内容，但也不重写
      throw e;
    }
  }
  return wrapped();
}

// 生成后规范化保留给 CLI/离线分析用（不在流式热路径调用）。
function normalize(text, c = {}) {
  const cfg = Object.assign({}, DEFAULT, c);
  let s = String(text || '').replace(/<system-reminder[\s\S]*?<\/system-reminder>/g, '');
  s = s.replace(/^(好的[，,]?\s*)?(我来帮你|我来|以下是)[^\n。！？]{0,12}[。！？]/gm, '');
  s = s.replace(/(希望(这|以下)?[^。\n]{0,20}(有帮助|对你有用))/g, '');
  const lines = s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(0, cfg.maxLines);
  let out = lines.join('\n');
  if (out.length > cfg.maxChars) out = out.slice(0, cfg.maxChars).replace(/[，、；：]$/, '') + '…';
  return out || s.slice(0, cfg.maxChars);
}

module.exports = { guard, normalize, DEFAULT };
