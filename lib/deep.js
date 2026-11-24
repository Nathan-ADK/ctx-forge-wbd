'use strict';
/**
 * ctx-forge 深度锻造（分级）——冲 95%+ 压缩比。
 *
 * 核心思路：把"回注内容"从"锚定摘要+全句柄"压缩到"极简决策码+分片指针"。
 *  - 正文 100% 落盘（可逆、零丢失），上下文只承载"足够定位与恢复"的最小信息。
 *  - 三级质量档：lite(保真优先) / balanced(均衡) / max(极限压缩，目标≥95%)。
 *  - 决策码：从四字段锚定里只取每字段最强的 N 条，极限档每条压到极短。
 *  - 分片指针：不给每块摘要，只给"共 N 块，区间 F0001-F00NN，按需 get"。
 *
 * 诚实边界：压缩比越高，模型可直接看到的历史越少（更多依赖按需 get）。
 * 95% 不是"信息无损地塞进176token"，而是"正文外置后，上下文只留导航+关键锚点"。
 */
const fs = require('fs');
const path = require('path');
const forge = require('./forge');
const token = require('./token');

const LEVELS = {
  lite:     { perField: 4, slice: 90, handleMode: 'brief', head: 'full' },
  balanced: { perField: 2, slice: 50, handleMode: 'range', head: 'short' },
  max:      { perField: 1, slice: 34, handleMode: 'range', head: 'min' },
};

function compactAnchor(items, n, slice) {
  return (items || []).slice(0, n).map((x) => {
    let s = String(x).replace(/\s+/g, ' ').trim();
    s = s.replace(/^<user_query>|^[>\s]*|<\/user_query>/g, ''); // 去宿主包裹
    s = s.replace(/[*`#>]/g, '').trim();                        // 去 markdown 噪声
    if (s.length <= slice) return s;
    // 在 slice 内找最后一个中文标点断句，避免切在词中间
    const win = s.slice(0, slice);
    const cut = Math.max(win.lastIndexOf('，'), win.lastIndexOf('、'), win.lastIndexOf('；'), win.lastIndexOf('：'));
    return (cut > slice * 0.5 ? win.slice(0, cut) : win).replace(/[，、；：]$/, '') + '…';
  }).filter(Boolean);
}

function deepForge(root, id, opts = {}) {
  const level = LEVELS[opts.level] ? opts.level : 'max';
  const cfg = LEVELS[level];
  const d = forge.sessionDir(root, id);
  const blocks = forge.readJson(path.join(d, 'blocks.json'), null);
  if (!blocks) return { ok: false, error: 'session not found: ' + id };
  const meta = forge.readJson(path.join(d, 'meta.json'), {});
  const A = forge.readJson(path.join(d, 'anchors.json'), {});
  const originalTokens = meta.originalTokens || blocks.reduce((a, b) => a + (b.tokens || 0), 0);

  // 极简头（随档位）
  const heads = {
    full: `[ctx-forge 深度锻造·${level}]\n正文 ${blocks.length} 块已落盘，按需 get。\n`,
    short: `[锻造·${level}·${blocks.length}块落盘]\n`,
    min: `[锻·${blocks.length}块]\n`,
  };
  const head = heads[cfg.head];

  // 决策码：每字段取最强 N 条，极限档截短
  const code = [];
  const tag = { intent: '目', decisions: '决', facts: '实', open: '未' };
  for (const k of ['intent', 'decisions', 'facts', 'open']) {
    const items = compactAnchor(A[k], cfg.perField, cfg.slice);
    if (items.length) code.push(`[${tag[k]}]` + items.join('；'));
  }
  const codeText = code.join('\n');

  // 分片指针：不给逐块摘要，只给区间
  const idx = cfg.handleMode === 'range'
    ? `[#]F0001-F${String(blocks.length).padStart(4, '0')} 全文已落盘,get调阅`
    : '';

  const text = [head, codeText, idx].filter(Boolean).join('\n');
  const tokens = token.count(text);
  const savedRatio = originalTokens ? +((1 - tokens / originalTokens) * 100).toFixed(1) : 0;
  return {
    ok: true, sessionId: id, level, blocks: blocks.length,
    originalTokens, tokens, savedRatio, text,
    target95: savedRatio >= 95,
  };
}

module.exports = { deepForge, LEVELS };
