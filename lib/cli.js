'use strict';
const os = require('os');
const path = require('path');
function defaultRoot() {
  if (process.env.CTXFORGE_HOME) return process.env.CTXFORGE_HOME;
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'wbd-home.json'), 'utf8'));
    if (lock.home && fs.existsSync(path.join(lock.home, 'sessions'))) return lock.home;
  } catch (_) {}
  const driveRoot = path.resolve(__dirname, '..', '..', '..', '..', '..');
  const wbdRoot = path.join(driveRoot, 'AI-项目', 'WBD');
  try { if (fs.existsSync(path.join(wbdRoot, 'sessions'))) return wbdRoot; } catch (_) {}
  return path.join(os.homedir(), '.ctxforge');
}
const ROOT = defaultRoot();
const forge = require('./forge');

function out(s) { process.stdout.write(String(s) + '\n'); }
function usage() {
  out('ctx-forge — 零常驻注入的上下文锻造器');
  out('用法: ctx-forge ingest <文件|-> --session-key <键>');
  out('      ctx-forge forge  --session-key <键> [--budget 600]');
  out('      ctx-forge get <F编号> --session-key <键>');
  out('      ctx-forge status [--session-key <键>]');
  out('      ctx-forge rm --session-key <键>');
}
function argv(args) {
  const o = { _: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--session-key' || args[i] === '-s') o.key = args[++i];
    else if (args[i] === '--budget' || args[i] === '-b') o.budget = Number(args[++i]);
    else if (args[i] === '--append') o.append = true;
    else if (args[i] === '--level' || args[i] === '-l') o.level = args[++i];
    else o._.push(args[i]);
  }
  return o;
}
function readFile(p) {
  if (p === '-' || !p) return require('fs').readFileSync(0, 'utf8');
  return require('fs').readFileSync(p, 'utf8');
}

function main(args) {
  const o = argv(args);
  const cmd = o._[0];
  const key = o.key || 'default';
  try {
    if (cmd === 'ingest') {
      const raw = readFile(o._[1]);
      const r = forge.ingest(ROOT, raw, { sessionId: key, append: !!o.append });
      out(r.ok ? `已归档 ${key}：${r.blocks} 块 / 原始 ${r.originalTokens} token / 锚定 ${r.anchorTokens} token` : ('失败：' + r.error));
    } else if (cmd === 'forge' || cmd === 'compact') {
      const f = forge.forge(ROOT, key, { budget: o.budget || 600 });
      if (!f.ok) out('失败：' + f.error);
      else if (f.mode === 'bypass') out(`净账非正，跳过：原 ${f.originalTokens} / 压 ${f.tokens}`);
      else out(`[省 ${f.savedRatio}%] ${f.originalTokens} → ${f.tokens} token\n` + f.text);
    } else if (cmd === 'deep') {
      let deep; try { deep = require('./deep'); } catch (_) { out('深度模块缺失'); return; }
      const level = o.level || 'max';
      const d = deep.deepForge(ROOT, key, { level });
      if (!d.ok) out('失败：' + d.error);
      else out(`[${level}·省${d.savedRatio}%·达标95=${d.target95}] ${d.originalTokens}→${d.tokens}token\n` + d.text);
    } else if (cmd === 'get') {
      const b = forge.getBlock(ROOT, key, o._[1]);
      out(b ? `[${b.id}][${b.role}] ${b.text}` : '未找到该编号');
    } else if (cmd === 'status') {
      if (o.key) {
        const s = forge.stat(ROOT, key);
        out(s.ok ? `${s.sessionId}｜${s.blocks}块｜${s.originalTokens}token｜${s.at}` : '未找到会话：' + key);
      } else {
        const list = forge.list(ROOT);
        out(list.length ? list.map((s) => `${s.sessionId}｜${s.blocks}块｜${s.originalTokens}token`).join('\n') : '无归档会话');
      }
    } else if (cmd === 'rm' || cmd === 'delete') {
      const r = forge.remove(ROOT, key);
      out(r.ok ? '已删除本地归档：' + key : ('失败：' + r.error));
    } else usage();
  } catch (e) { out('错误：' + (e && e.message ? e.message : e)); process.exitCode = 1; }
}
module.exports = { main, usage, ROOT };
