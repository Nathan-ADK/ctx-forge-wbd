'use strict';
/**
 * ctx-forge 核心：确定性上下文锻造引擎（零依赖、零 LLM 调用）。
 *
 * 独家解题思路（对比旧 ctx-suite 的关键差异）：
 *  1) 零常驻注入：每轮不往上下文塞任何宪法/规则文本 → 注入成本恒为 0（旧版每轮 192~453 token）。
 *  2) 只在压缩点做功：PreCompact / 显式调用时，把历史"锻造"成结构化锚定摘要 + 落盘正文 + 极简句柄。
 *  3) 四字段锚定摘要（intent/decisions/facts/open，业界最佳实践）：确定性抽取，不调 LLM、零幻觉。
 *  4) 分层可逆：正文永不删除，只落盘；上下文只留句柄与摘要，按需 get 调阅（可逆压缩优先）。
 *  5) micro-compact：旧工具结果/超长消息替换为占位符，正文外置。
 *  6) 净账护栏：任何输出先算 token 账，负增益自动 bypass（根治短会话压缩反增 problem）。
 */
const fs = require('fs');
const path = require('path');
const token = require('./token');

function safeId(id) { return String(id || 'default').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 90); }
function sessionDir(root, id) { return path.join(root, 'sessions', safeId(id)); }
function readJson(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return d; } }
function writeJson(p, o) { try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 2), 'utf8'); return true; } catch (_) { return false; } }
function writeText(p, s) { try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s, 'utf8'); return true; } catch (_) { return false; } }

// —— 消息清洗：剥离宿主包裹，避免 system-reminder 垃圾进正文 ——
function cleanText(t) {
  let s = String(t || '');
  s = s.replace(/<system-reminder[\s\S]*?<\/system-reminder>/g, '');
  s = s.replace(/<(user-context|identity_context|environment_context)>[\s\S]*?<\/\1>/g, '');
  s = s.replace(/<system-reminder[^>]*>/g, '');
  return s.trim();
}

// —— 解析 transcript（JSONL messages 或纯文本）——
function parseTranscript(raw) {
  const msgs = [];
  for (const line of String(raw || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let o = null; try { o = JSON.parse(line); } catch (_) { continue; }
    if (!o || o.type !== 'message') continue;
    const role = o.role === 'user' ? 'user' : (o.role === 'assistant' ? 'assistant' : 'note');
    let text = '';
    if (Array.isArray(o.content)) { for (const c of o.content) if (c && typeof c.text === 'string') text += c.text + '\n'; }
    else if (typeof o.content === 'string') text = o.content;
    text = cleanText(text);
    if (text && !/^(429|\d{3}\s|WorkBuddy AI:)/.test(text)) msgs.push({ role, text });
  }
  if (!msgs.length && String(raw || '').trim()) msgs.push({ role: 'note', text: cleanText(raw) });
  return msgs;
}

// —— 分块：每轮 user+assistant 为一块，长消息再切 ——
const MAX_BLOCK_CHARS = 900;
function chunkMessages(msgs) {
  const blocks = [];
  let n = 0;
  for (const m of msgs) {
    const parts = [];
    const text = m.text;
    for (let i = 0; i < text.length; i += MAX_BLOCK_CHARS) parts.push(text.slice(i, i + MAX_BLOCK_CHARS));
    for (const p of parts) {
      n++;
      blocks.push({ id: 'F' + String(n).padStart(4, '0'), seq: n, role: m.role, text: p, tokens: token.count(p) });
    }
  }
  return blocks;
}

// —— 四字段锚定摘要（确定性抽取，零 LLM）——
// intent: 用户目标/请求；decisions: 决定与结论；facts: 数字/路径/版本/验收；open: 未决问题/下一步
function extractAnchors(blocks) {
  const A = { intent: [], decisions: [], facts: [], open: [] };
  const hit = (s, re) => re.test(s);
  for (const b of blocks) {
    const t = b.text;
    // 目标：user 首句 / 请求式
    if (b.role === 'user' && !A.intent.length) {
      const line = t.split(/[。！？\n]/).filter(Boolean)[0] || '';
      if (line.trim()) A.intent.push(line.trim().slice(0, 80));
    }
    for (const s of t.split(/[。！？\n；;]/)) {
      const x = s.trim(); if (x.length < 4 || x.length > 160) continue;
      // 决定/结论
      if (hit(x, /(决定|已定|采用|不采用|确定|放弃|保持|结论|最终|必须|不得|选择|回归|通过|未通过|验收)/)) {
        if (A.decisions.length < 12) A.decisions.push(x.slice(0, 60));
      }
      // 事实：数字/路径/版本/百分比/状态
      if (hit(x, /\d/) && hit(x, /(token|%|版本|v\d|\.py|\.js|\.json|\/|[A-Za-z]:\\|行|项|个|通过|失败|GB|MB|ms|秒|轮)/)) {
        if (A.facts.length < 16) A.facts.push(x.slice(0, 70));
      }
      // 未决/下一步
      if (hit(x, /(待|未完成|下一步|遗留|风险|还需|TODO|未决|悬而未决|下一步|问题：|疑问)/)) {
        if (A.open.length < 10) A.open.push(x.slice(0, 120));
      }
    }
  }
  // 去重保序
  for (const k of Object.keys(A)) A[k] = Array.from(new Set(A[k])).slice(0, k === 'facts' ? 12 : 8);
  return A;
}

function renderAnchors(A) {
  const L = [];
  if (A.intent.length) L.push('[目标] ' + A.intent.join('；'));
  if (A.decisions.length) L.push('[决定] ' + A.decisions.join('；'));
  if (A.facts.length) L.push('[事实] ' + A.facts.join('；'));
  if (A.open.length) L.push('[未决] ' + A.open.join('；'));
  return L.join('\n');
}

// —— 落盘：会话正文 + 块 + 锚定摘要 ——
function ingest(root, input, opts = {}) {
  const id = opts.sessionId || 'default';
  const d = sessionDir(root, id);
  const msgs = typeof input === 'string' ? parseTranscript(input) : (Array.isArray(input) ? input : []);
  const blocks = chunkMessages(msgs);
  if (!blocks.length) return { ok: false, error: 'no messages' };
  const old = readJson(path.join(d, 'blocks.json'), []);
  const merged = opts.append ? old.concat(blocks) : blocks;
  const anchors = extractAnchors(merged);
  const originalTokens = merged.reduce((a, b) => a + (b.tokens || token.count(b.text)), 0);
  writeJson(path.join(d, 'blocks.json'), merged);
  writeJson(path.join(d, 'anchors.json'), anchors);
  writeText(path.join(d, 'full.md'), merged.map((b) => `[${b.id}][${b.role}] ${b.text}`).join('\n\n'));
  writeJson(path.join(d, 'meta.json'), { id, count: merged.length, originalTokens, at: new Date().toISOString(), format: opts.format || 'auto' });
  return { ok: true, sessionId: id, blocks: merged.length, originalTokens, anchorTokens: token.count(renderAnchors(anchors)) };
}

// —— 句柄装填：正文落盘，上下文只留锚定摘要 + 极简句柄目录（按需 get）——
const OV = 18;
function buildContext(root, id, opts = {}) {
  const d = sessionDir(root, id);
  const blocks = readJson(path.join(d, 'blocks.json'), null);
  if (!blocks) return { ok: false, error: 'session not found: ' + id };
  const meta = readJson(path.join(d, 'meta.json'), {});
  const A = readJson(path.join(d, 'anchors.json'), {});
  const budget = Math.max(80, Number(opts.budget) || 600);
  const originalTokens = meta.originalTokens || blocks.reduce((a, b) => a + (b.tokens || 0), 0);

  // L0 锚定摘要（永留）
  const anchorText = renderAnchors(A);
  let used = OV + token.count(anchorText);
  // L1 极简句柄目录：每行 = F编号 + 角色 + 8~18字摘要（索引，不是内容）
  const handles = [];
  for (const b of blocks) {
    const brief = b.text.replace(/\s+/g, ' ').slice(0, 24);
    const line = `${b.id}[${b.role === 'user' ? '问' : b.role === 'assistant' ? '答' : '记'}] ${brief}`;
    if (used + token.count(line) + 1 > budget) break;
    used += token.count(line) + 1;
    handles.push(line);
  }
  const head = `[ctx-forge 上下文锻造 · ${blocks.length} 块正文已落盘]\n` +
    (anchorText ? anchorText + '\n' : '') +
    (handles.length ? '[索引] ' + handles.join(' | ') + '\n' : '') +
    `按需调阅：ctx-forge get <F编号> --session-key ${id}（正文未丢失，不随压缩消失）`;
  const text = head;
  const compTokens = token.count(text);
  return {
    ok: true, sessionId: id, blocks: blocks.length,
    originalTokens, tokens: compTokens,
    savedRatio: originalTokens ? +((1 - compTokens / originalTokens) * 100).toFixed(1) : 0,
    withinBudget: compTokens <= budget, text,
  };
}

// —— 净账护栏：相对原文若非净省，则 bypass ——
function forge(root, id, opts = {}) {
  const r = buildContext(root, id, opts);
  if (!r.ok) return r;
  const minGain = Number(opts.minGain) || 0; // 至少省这么多 token，否则 bypass
  const saved = r.originalTokens - r.tokens;
  if (saved <= minGain) return Object.assign({}, r, { mode: 'bypass', reason: 'net gain <= threshold, keep original', text: '' });
  return Object.assign({}, r, { mode: 'forge' });
}

function getBlock(root, id, blockId) {
  const blocks = readJson(path.join(sessionDir(root, id), 'blocks.json'), []);
  return blocks.find((b) => b.id === blockId) || null;
}
function stat(root, id) {
  const d = sessionDir(root, id);
  if (!fs.existsSync(d)) return { ok: false, error: 'not found' };
  const meta = readJson(path.join(d, 'meta.json'), {});
  return { ok: true, sessionId: id, blocks: meta.count || 0, originalTokens: meta.originalTokens || 0, at: meta.at || '' };
}
function list(root) {
  const d = path.join(root, 'sessions');
  let dirs = []; try { dirs = fs.readdirSync(d); } catch (_) { return []; }
  return dirs.map((x) => stat(root, x)).filter((s) => s.ok);
}
function remove(root, id) {
  const d = sessionDir(root, id);
  try { fs.rmSync(d, { recursive: true, force: true }); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = {
  safeId, sessionDir, cleanText, parseTranscript, chunkMessages, extractAnchors, renderAnchors,
  ingest, buildContext, forge, getBlock, stat, list, remove, readJson, writeJson, writeText,
};
