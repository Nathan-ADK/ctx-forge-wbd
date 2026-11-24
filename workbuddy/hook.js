#!/usr/bin/env node
'use strict';
/**
 * ctx-forge WorkBuddy command hook（挂 PreCompact / SessionEnd，零常驻注入）。
 * 从 stdin 读 WorkBuddy 传入的 JSON：{ session_id, transcript_path, cwd, hook_event_name }。
 * 行为：把 transcript（对话 JSONL）作为正文源，用 session_id 做 key 调 ctx-forge ingest 归档。
 * 永远退出 0（放行）——钩子只静默归档，不拦截、不阻塞、不改工具参数。
 * 零成本：每次调用只做一次本地文件落盘，不往上下文回注任何东西。
 */
const fs = require('fs');
const forge = require('../lib/forge');
const os = require('os');
const path = require('path');
function defaultRoot() {
  if (process.env.CTXFORGE_HOME) return process.env.CTXFORGE_HOME;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'home.json'), 'utf8'));
    if (cfg.home && typeof cfg.home === 'string') return cfg.home;
  } catch (_) {}
  return path.join(os.homedir(), '.ctxforge');
}
const ROOT = defaultRoot();

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (buf += d));
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(''));
    // 兜底：1s 没数据也走（防止 hook 卡住阻塞主流程）
    setTimeout(() => resolve(buf), 1000);
  });
}

async function main() {
  let key = 'default';
  let transcript = '';
  try {
    const raw = await readStdin();
    const j = raw && raw.trim() ? JSON.parse(raw) : {};
    key = String(j.session_id || j.generation_id || 'default');
    transcript = j.transcript_path ? fs.readFileSync(j.transcript_path, 'utf8') : '';
  } catch (_) {
    transcript = '';
  }
  // 无正文可归档（transcript 缺失/为空）→ 直接放行，不落盘、不报错
  if (!transcript || !transcript.trim()) { process.exit(0); }
  try {
    const r = forge.ingest(ROOT, transcript, { sessionId: key, append: true });
    // 静默：不输出（stdout 输出会被 hook 当作反馈塞进上下文，违背零注入）
    if (r && r.ok && process.env.CTXFORGE_HOOK_DEBUG === '1') {
      console.error(`[ctx-forge] ${key}: ${r.blocks} blocks / ${r.originalTokens}tok`);
    }
  } catch (_) {}
  // 钩子契约：永远 0 放行
  process.exit(0);
}

main();
