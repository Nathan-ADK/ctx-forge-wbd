'use strict';
/**
 * ctx-forge 输出闸门（纯 Stop 事后拦截，零每轮注入）。
 *
 * 关键洞察：约束输出有三条路——
 *  ① 每轮 hook 注入规则（旧 1.3.8/2.x：192~453 token/轮，负资产，已废弃）
 *  ② Stop 事后拦截（本模块：不违规零成本，违规才 block 重写，不算注入）
 *  ③ 解码层硬约束（插件做不到）
 * 本模块走 ②：把 1.3.8 的判定逻辑移植为纯事后闸门，满足"不注入但要极简"。
 *
 * 极简状态回复：过程允许 ≤8 字状态词（核查中/已完成/测试中），禁止长解释；
 * 结论 ≤3 行；禁填充/英文叙述/流程播报。详述请求单次豁免行数。
 */
const PROTECT = /(```[\s\S]*?```|`[^`\n]+`|https?:\/\/[^\s)]+|<\/?[a-zA-Z][^>]*>|(?:[A-Za-z]:\/|\/)[^\s，。；、 `'"]+)/g;
function mask(t) {
  const store = [];
  const out = String(t || '').replace(PROTECT, (m) => { store.push(m); return '\u0000P' + (store.length - 1) + '\u0000'; });
  return out;
}
const FILLER = [
  /好的[，,]?\s*我来/g, /我来帮你|让我来帮你|我先帮你/g, /以下是[^。\n]{0,24}[：:]/g,
  /希望(这|以下)?[^。\n]{0,20}(有帮助|对你有用)/g, /让我(先|来)?(想|看|读|分析|检查)/g, /我先(梳理|想|看|读|分析|检查|确认|查)/g,
  /(^|[\n。])\s*(首先|其次|接下来)[，,]/g, /众所周知/g, /需要注意的是/g,
  /(^|[\n])\s*(let me|let's|i['’]ll|i will|firstly|next,|based on|looking at|note:|summary:)/i,
  /\b(sure|okay|certainly|of course|hope this helps)\b/i
];
const STATUS_WORD = /^[\u4e00-\u9fffA-Za-z0-9]{1,8}$/;
const FUNC = new Set(('the a an is are was were be been to of and or in on for with this that these those i we it you my our your not no from as at by but if so than then when while will would can could should have has had do does did let please now just also here there what which who how why all any each need about into over after before because').split(/\s+/));
function isEn(s) { const w = s.match(/[A-Za-z][A-Za-z'’\-]*/g) || []; if (!w.length) return false; let fn = 0; for (const x of w) if (FUNC.has(x.toLowerCase())) fn++; return (w.length >= 5 && fn >= 2) || (w.length >= 2 && w.length <= 4 && fn >= 2); }

function check(text, opts = {}) {
  const v = [];
  if (!text || !String(text).trim()) return { violations: v, lines: 0 };
  const lines = String(text).split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const allStatus = lines.length > 0 && lines.every((l) => STATUS_WORD.test(l.replace(/^[·\-•\s]+/, '')));
  // 纯状态词放行，但仍受行数上限约束（≤3 行）
  if (allStatus && lines.length <= (opts.maxLines === undefined ? 3 : opts.maxLines)) return { violations: v, lines: lines.length, mode: 'status' };
  const out = mask(text);
  for (const re of FILLER) { re.lastIndex = 0; const m = out.match(re); if (m) v.push('填充语：' + m[0].trim().slice(0, 30)); }
  for (const s of out.split(/[。！？\n.!?；;]/)) {
    const x = s.replace(/^\s*[#>*\-\d.\s]+/, '').trim();
    if (x.includes('\u0000') || x.length < 4) continue;
    if (isEn(x)) v.push('英文叙述：' + x.slice(0, 50));
    if (/正在|现在|首先|然后|接着|接下来|先|准备|尝试|研究|收集|梳理/.test(x) && x.length > 16 && /[一-鿿]/.test(x)) v.push('过程外显：' + x.slice(0, 40));
  }
  const limit = opts.maxLines === undefined ? 3 : opts.maxLines;
  if (limit > 0 && !opts.allowDetailed && lines.length > limit) v.push(`行数超限：${lines.length}>${limit}`);
  // 邪修核心：单行字数上限。旧判定只查行数/填充/英文，一行78字长句零违规=绵长真凶。
  // 结论每行≤maxCharsPerLine字（默认40）；超限即拦，逼出极简短句。
  const cpl = opts.maxCharsPerLine === undefined ? 40 : opts.maxCharsPerLine;
  if (cpl > 0 && !opts.allowDetailed) {
    for (const l of lines) {
      if (l.length > cpl) { v.push(`单行过长：${l.length}字>${cpl}字（须拆成短句/精简）`); break; }
    }
  }
  return { violations: v, lines: lines.length, mode: 'check' };
}
// 邪修核心：拦截时直接给出合规答案，模型只需照抄，重写一次到位（不反复耗 output token）。
function autoFix(text, opts = {}) {
  const maxLines = opts.maxLines || 3, maxChars = opts.maxCharsPerLine || 40;
  let s = String(text || '').replace(/<system-reminder[\s\S]*?<\/system-reminder>/g, '');
  for (const re of FILLER) { re.lastIndex = 0; s = s.replace(re, ''); }
  const parts = s.split(/[。！？\n；;]/).map((x) => x.trim().replace(/^[·\-•\s]+/, '')).filter((x) => x.length >= 2);
  const out = [];
  for (const p of parts) {
    if (out.length >= maxLines) break;
    let line = p;
    if (line.length > maxChars) {
      const win = line.slice(0, maxChars);
      const cut = Math.max(win.lastIndexOf('，'), win.lastIndexOf('、'), win.lastIndexOf('：'));
      line = (cut > maxChars * 0.5 ? win.slice(0, cut) : win).replace(/[，、：]$/, '') + '…';
    }
    if (line) out.push(line);
  }
  return out.join('\n') || '完成。';
}
function blockReason(res, originalText) {
  const top = (res.violations || []).slice(0, 2).map((x) => '· ' + x).join('\n');
  // 不再回显压缩答案让模型照抄（会与用户可见的 feedback 重复两遍）；只点违规+给式样。
  return '[闸门] ' + top + '\n式样：根因：值 / 修复：值（每行≤12字，≤3行，无句号）。';
}
function isDetail(prompt) { return /详述这段|展开这段|详细说明这段|逐步解释这段|请详述|请展开/.test(String(prompt || '')); }

module.exports = { check, blockReason, autoFix, isDetail, mask };
