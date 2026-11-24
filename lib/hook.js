'use strict';
/**
 * ctx-forge 双平台 hook 入口（WorkBuddy command hook / DSH 桥共用）。
 *
 * 与旧插件的根本差异：
 *  - UserPromptSubmit：完全静默放行，零注入（不再每轮塞宪法/规则，注入成本=0）。
 *  - Stop：不拦截、不重写，彻底放开输出。
 *  - PreCompact：归档 + 锻造回注（正文落盘、上下文只留锚定摘要+极简句柄）。
 *  - SessionEnd：仅归档，不回注。
 *  - SessionStart：可选极简状态提示（默认关），不灌正文。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const forge = require('./forge');
let gate = null; try { gate = require('./gate'); } catch (_) {}
let deep = null; try { deep = require('./deep'); } catch (_) {}

// 归档目录自适应（零硬编码，任何机器通用）：
//   1) CTXFORGE_HOME 环境变量
//   2) 包内 home.json 可选覆盖文件（安装时可生成，发布包不含）
//   3) ~/.ctxforge（用户主目录，默认）
function defaultRoot() {
  if (process.env.CTXFORGE_HOME) return process.env.CTXFORGE_HOME;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'home.json'), 'utf8'));
    if (cfg.home && typeof cfg.home === 'string') return cfg.home;
  } catch (_) {}
  return path.join(os.homedir(), '.ctxforge');
}
const ROOT = defaultRoot();
// FIX: Stop 事后拦截重写会生成两遍（负资产），默认关闭。
// 省 token 靠生成层硬限制（DSH llm/stream maxTokens），不靠重写。
const GATE_ON = String(process.env.CTXFORGE_GATE || 'off').toLowerCase() === 'on';

function emit(o) { try { process.stdout.write(JSON.stringify(o)); } catch (_) { process.stdout.write('{"continue":true}'); } }
function pass(msg) { emit({ continue: true, systemMessage: msg || undefined }); }
function inject(ev, ctx) { emit({ continue: true, hookSpecificOutput: { hookEventName: ev, additionalContext: ctx } }); }
function sessionKey(input) {
  const host = String(input.source || process.env.CTXFORGE_HOST || 'hook').toLowerCase();
  const id = String(input.session_id || input.conversation_id || '');
  return host + '_' + (id || 'latest');
}
function LEVEL_OK(l) { return l === 'lite' || l === 'balanced' || l === 'max'; }

function preCompact(input) {
  const tp = input.transcript_path;
  if (!tp || !fs.existsSync(tp)) return pass('[ctx-forge] 无 transcript，跳过锻造');
  let raw; try { raw = fs.readFileSync(tp, 'utf8'); } catch (_) { return pass('[ctx-forge] 读取失败，跳过'); }
  const id = sessionKey(input);
  const budget = Math.max(120, Math.min(4000, Number(process.env.CTXFORGE_BUDGET) || 600));
  const r = forge.ingest(ROOT, raw, { sessionId: id, format: 'transcript' });
  if (!r.ok) return pass('[ctx-forge] 归档跳过：' + (r.error || 'unknown'));
  // 深度锻造档位：CTXFORGE_LEVEL=lite|balanced|max（默认 balanced 冲≥95%）
  const level = String(process.env.CTXFORGE_LEVEL || 'lite').toLowerCase();
  if (deep && LEVEL_OK(level)) {
    const df = deep.deepForge(ROOT, id, { level });
    if (df.ok) return inject('PreCompact',
      `[ctx-forge 深度锻造·${level}]\n` + df.text +
      `\n${df.originalTokens}→${df.tokens} token（省 ${df.savedRatio}%${df.target95 ? '，达标≥95%' : ''}）；` +
      `${df.blocks} 块正文已落盘，get 可调阅。\n[结束]`);
  }
  const f = forge.forge(ROOT, id, { budget, minGain: 0 });
  if (!f.ok || f.mode !== 'forge') return pass('[ctx-forge] 净账非正，跳过回注（原文保留）');
  return inject('PreCompact',
    '[ctx-forge 锻造回注]\n' + f.text +
    `\n锻造前 ${f.originalTokens} → 锻造后 ${f.tokens} token（省 ${f.savedRatio}%）；` +
    `${f.blocks} 块正文已落盘，正文零丢失。\n[锻造结束]`);
}
function sessionEnd(input) {
  const tp = input.transcript_path;
  if (!tp || !fs.existsSync(tp)) return pass();
  let raw; try { raw = fs.readFileSync(tp, 'utf8'); } catch (_) { return pass(); }
  const id = sessionKey(input);
  const r = forge.ingest(ROOT, raw, { sessionId: id, format: 'transcript' });
  return pass(r.ok ? `[ctx-forge] 已归档 ${id}：${r.blocks} 块 / ${r.originalTokens} token` : '[ctx-forge] 归档跳过');
}

// Stop 事后闸门：不违规零成本；违规才 block 重写。不算"注入"（不占每轮输入 token）。
function textFingerprint(s) {
  try { const c = require('crypto'); return c.createHash('sha1').update(String(s || '')).digest('hex').slice(0, 16); }
  catch (_) { return String(s || '').length + '_' + String(s || '').slice(0, 12); }
}
function stopGate(input) {
  if (!GATE_ON || !gate) return emit({ continue: true });
  let text = typeof input.last_assistant_message === 'string' ? input.last_assistant_message
    : (typeof input.response === 'string' ? input.response : '');
  const tp = input.transcript_path;
  // 关键修复：收集最后一条 user 之后的所有 assistant（含过程段中间消息）。
  // 旧版只读最后一条→过程外显在中间消息里从不进闸门=漏检。
  let turnTexts = [];
  let lastUserText = '';
  if (tp && fs.existsSync(tp)) {
    try {
      const lines = fs.readFileSync(tp, 'utf8').split(/\r?\n/);
      const msgs = [];
      for (const line of lines) {
        let o = null; try { o = JSON.parse(line); } catch (_) {}
        if (!o || o.type !== 'message') continue;
        const t = Array.isArray(o.content) ? o.content.map((c) => c && c.text || '').join('\n') : String(o.content || '');
        msgs.push({ role: o.role, text: t });
      }
      let lastUser = -1;
      for (let i = 0; i < msgs.length; i++) if (msgs[i].role === 'user') { lastUser = i; lastUserText = msgs[i].text; }
      for (let i = lastUser + 1; i < msgs.length; i++) if (msgs[i].role === 'assistant' && msgs[i].text.trim()) turnTexts.push(msgs[i].text);
      if (!text && turnTexts.length) text = turnTexts[turnTexts.length - 1];
    } catch (_) {}
  }
  if (!text || !String(text).trim()) return emit({ continue: true });
  // 详述豁免：读最后一条 user
  let allowDetailed = false;
  if (tp && fs.existsSync(tp)) {
    try {
      const lines = fs.readFileSync(tp, 'utf8').split(/\r?\n/);
      for (let i = lines.length - 1; i >= 0; i--) {
        let o = null; try { o = JSON.parse(lines[i]); } catch (_) {}
        if (o && o.type === 'message' && o.role === 'user') {
          const u = Array.isArray(o.content) ? o.content.map((c) => c && c.text || '').join('') : String(o.content || '');
          allowDetailed = gate.isDetail(u); break;
        }
      }
    } catch (_) {}
  }
  const res = gate.check(text, { maxLines: 3, maxCharsPerLine: Number(process.env.CTXFORGE_LINE_CHARS) || 40, allowDetailed });
  // 过程段：最终结论之前的 assistant 消息，只允许≤8字状态词；长句/解释一律违规。
  const processTexts = turnTexts.slice(0, -1);
  for (const pt of processTexts) {
    const isStatus = String(pt).split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
      .every((l) => /^[\u4e00-\u9fffA-Za-z0-9]{1,8}$/.test(l.replace(/^[·\-•\s]+/, '')));
    if (!isStatus) res.violations.push('过程外显(须零输出或≤8字状态词)：' + String(pt).trim().slice(0, 30));
  }
  const statePath = path.join(ROOT, 'gate-rewrite-state.json');
  let st = {}; try { st = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (_) {}
  const fp = textFingerprint(text);
  if (res.violations.length) {
    // stop_hook_active 防死循环：仅在"本次内容与上次被拦内容不同"（真重写）时放行；
    // 内容指纹相同=模型没真重写→继续 block。避免一次性放行漏洞，又不无限循环。
    if (input.stop_hook_active === true && st.lastBlockedFp && st.lastBlockedFp !== fp) {
      st = {}; try { fs.writeFileSync(statePath, JSON.stringify(st), 'utf8'); } catch (_) {}
      return emit({ continue: true });
    }
    st.lastBlockedFp = fp; st.blocks = (st.blocks || 0) + 1; st.at = new Date().toISOString();
    try { fs.writeFileSync(statePath, JSON.stringify(st), 'utf8'); } catch (_) {}
    return emit({ decision: 'block', reason: gate.blockReason(res, text), systemMessage: '[ctx-forge] 闸门拦截：' + res.violations.length + ' 项（重写' + st.blocks + '次）' });
  }
  // 合规：清除拦截状态
  if (st.lastBlockedFp) { st = {}; try { fs.writeFileSync(statePath, JSON.stringify(st), 'utf8'); } catch (_) {} }
  return emit({ continue: true });
}

// 极短强注入：1.3.8 效果但仅 26 token（1.3.8 是 192）。每轮 source-of-truth，逼模型源头精简。
const MINI_RULE = '输出铁律:过程零文字或≤8字状态词;结论≤3行每行≤40字;只给结论,中文,禁填充。详述例外。';
function promptInject(input) {
  return emit({ continue: true }); // 零注入
}
function main() {
  let input = {}; try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch (_) {}
  const ev = input.hook_event_name || '';
  try {
    if (ev === 'PreCompact') return preCompact(input);
    if (ev === 'SessionEnd') return sessionEnd(input);
    if (ev === 'Stop') return stopGate(input);
    if (ev === 'UserPromptSubmit') return promptInject(input);
    return emit({ continue: true });
  } catch (e) { return emit({ continue: true, systemMessage: '[ctx-forge] 跳过：' + (e && e.message ? e.message : 'unknown') }); }
}
if (require.main === module) main();
module.exports = { preCompact, sessionEnd, stopGate, sessionKey, ROOT };
