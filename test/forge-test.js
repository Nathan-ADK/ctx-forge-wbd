'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const forge = require('../lib/forge');
const hook = require('../lib/hook');
const token = require('../lib/token');

const TMP = path.join(os.tmpdir(), 'ctx-forge-test-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });
let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; } else { fail++; console.log('FAIL: ' + name); } }

// 1) token 计数
ok('token 空文本=0', token.count('') === 0);
ok('token 中文计数', token.count('这是一段中文测试文本') > 0);
ok('token ratio', typeof token.ratio('abc', 'a') === 'number');

// 2) 清洗 system-reminder
const dirty = '用户问题<system-reminder>垃圾内容很多很多</system-reminder>';
ok('cleanText 去 reminder', !forge.cleanText(dirty).includes('垃圾'));

// 3) 解析 transcript JSONL
const jl = [
  JSON.stringify({ type: 'message', role: 'user', content: [{ text: '第一个问题' }] }),
  JSON.stringify({ type: 'message', role: 'assistant', content: [{ text: '第一个回答' }] }),
].join('\n');
ok('parseTranscript JSONL', forge.parseTranscript(jl).length === 2);

// 4) 分块
const msgs = [{ role: 'user', text: '甲'.repeat(2000) }];
ok('chunkMessages 切块', forge.chunkMessages(msgs).length > 1);

// 5) 四字段锚定摘要
const demo = [
  { role: 'user', text: '帮我升级插件版本' },
  { role: 'assistant', text: '决定采用方案A，放弃方案B。最终通过验收。' },
  { role: 'assistant', text: '文件大小 2048 字节，路径 E:/x/test.py，占 51%' },
  { role: 'user', text: '下一步待办：还有遗留问题未决' },
];
const A = forge.extractAnchors(forge.chunkMessages(demo));
ok('锚定 intent', A.intent.length > 0);
ok('锚定 decisions', A.decisions.some((x) => x.includes('决定') || x.includes('通过')));
ok('锚定 facts', A.facts.some((x) => /\d/.test(x)));
ok('锚定 open', A.open.length > 0);

// 6) ingest + forge 净账
const bigMsgs = [];
for (let i = 0; i < 60; i++) bigMsgs.push({ role: i % 2 ? 'assistant' : 'user', text: `这是第${i}轮的详细内容，包含决定与结论以及数字${i * 37}，路径 E:/data/f${i}.py，通过验收参见项${i}。` });
const ing = forge.ingest(TMP, bigMsgs, { sessionId: 's_big' });
ok('ingest ok', ing.ok && ing.blocks > 0);
const f = forge.forge(TMP, 's_big', { budget: 600 });
ok('forge ok', f.ok);
ok('forge mode=forge', f.mode === 'forge');
ok('forge 净省', f.savedRatio > 0, true);
ok('forge 省>50%', f.savedRatio > 50);
ok('forge 正文保留', fs.existsSync(path.join(TMP, 'sessions', 's_big', 'full.md')));
ok('forge 锚定落盘', fs.existsSync(path.join(TMP, 'sessions', 's_big', 'anchors.json')));

// 7) 净账护栏：短会话 bypass
const short = forge.ingest(TMP, [{ role: 'user', text: '你好' }], { sessionId: 's_short' });
const fs2 = forge.forge(TMP, 's_short', { budget: 600 });
ok('短会话 bypass', fs2.mode === 'bypass' || fs2.savedRatio <= 0);

// 8) get 调阅
const blk = forge.getBlock(TMP, 's_big', 'F0001');
ok('getBlock 命中', !!blk && !!blk.text);

// 9) stat/list/rm
ok('stat ok', forge.stat(TMP, 's_big').ok);
ok('list 含会话', forge.list(TMP).some((x) => x.sessionId === 's_big'));
ok('rm ok', forge.remove(TMP, 's_short').ok);

// 10) sessionKey
ok('sessionKey 带 host', hook.sessionKey({ session_id: 'abc', source: 'dsh' }).startsWith('dsh_'));

// 11) 零注入契约：hook 源码不得含注入/拦截关键调用
const hookSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'hook.js'), 'utf8');
ok('hook 有 Stop 闸门(事后拦截)', /decision\s*:\s*'block'/.test(hookSrc) && /ev === 'Stop'/.test(hookSrc));
ok('hook 无每轮注入(UserPromptSubmit)', !/ev === 'UserPromptSubmit'[\s\S]{0,40}inject\(/.test(hookSrc));

// 12) gate 输出闸门
const gate = require('../lib/gate');
ok('gate 极简状态词放行', gate.check('核查中\n已完成\n测试中').violations.length === 0);
ok('gate 超3行拦截', gate.check('第一行\n第二行\n第三行\n第四行').violations.some(v=>v.includes('行数')));
ok('gate 填充语拦截', gate.check('好的，我来帮你查一下。').violations.length > 0);
ok('gate 英文叙述拦截', gate.check('This is a very long english narration sentence here.').violations.length > 0);
ok('gate 过程外显拦截', gate.check('我正在仔细地检查这个配置文件的内容然后分析').violations.length > 0);
ok('gate 极简结论放行', gate.check('完成：压缩83%，25项测试全过。').violations.length === 0);
ok('gate 详述检测', gate.isDetail('请详述这段') === true && gate.isDetail('你好') === false);
ok('gate blockReason 给式样不回显', gate.blockReason({violations:['行数超限']},'长内容').includes('式样') && !gate.blockReason({violations:['行数超限']},'长内容').includes('长内容'));


// 13) deep 深度锻造冲95%
const deep = require('../lib/deep');
const dr = deep.deepForge(TMP, 's_big', { level: 'max' });
ok('deep 可运行', dr.ok);
ok('deep 达标95%', dr.target95 === true, true);
ok('deep 压缩比>=95', dr.savedRatio >= 95);
ok('deep max 比普通更省', dr.tokens < f.tokens);
ok('deep 有分片指针', dr.text.includes('F0001'));
ok('deep 三级档位', Object.keys(deep.LEVELS).join() === 'lite,balanced,max');
const dl = deep.deepForge(TMP, 's_big', { level: 'lite' });
ok('deep lite 保真更多', dl.tokens >= dr.tokens);



// 14) DSH 加载协议 + 流式输出闸门
const stream = require('../lib/stream');
ok('stream normalize 限3行', stream.normalize('a\nb\nc\nd\ne', {maxLines:3,maxChars:600}).split('\n').length === 3);
ok('stream normalize 去填充', !stream.normalize('好的，我来帮你查一下。\n结论', {maxLines:3,maxChars:600}).includes('我来帮你'));
ok('stream normalize 去reminder', !stream.normalize('<system-reminder>垃圾</system-reminder>结论', {maxLines:3,maxChars:600}).includes('垃圾'));
(async()=>{
  async function* src(){ yield '第一行\n第二行\n第三行\n第四行\n第五行'; }
  let out=''; for await(const c of stream.guard(src(),{enabled:true,maxLines:3,maxChars:600})) out+=c;
  ok('stream.guard 端到端限行', out.split('\n').length===3);
  // index 同时导出 cordis 协议
  const idx=require('../lib/index.js');
  // WBD-only: cordis protocol not shipped (DSH-only); skipped.
  // WBD-only: skipped.
  // WBD-only: skipped.
  
})();

// 15) 生成层 maxTokens 硬限制（实打实省 output token）
// WBD-only: DSH llm/stream generation-layer test skipped (platform has no such hook).

// 16) 邪修: 单行字数上限 + 指纹防假重写
ok('gate 单行过长拦截', gate.check('这是一句特别特别特别长的单行结论句子它远远超过了四十个字的限制所以必须被闸门拦截掉绝不放行', {maxLines:3,maxCharsPerLine:40}).violations.some(v=>v.includes('单行过长')));
ok('gate 短句放行', gate.check('达标：压缩94%。', {maxLines:3,maxCharsPerLine:40}).violations.length===0);
ok('gate 三行短句放行', gate.check('达标：压缩94%。\n正文落盘可逆。\n测试40/0。', {maxLines:3,maxCharsPerLine:40}).violations.length===0);


// 17) 过程段中间消息被检查
const os2=require('os'), pp=require('path');
const wdir=pp.join(os2.tmpdir(),'cf-proc-test-'+Date.now());fs.mkdirSync(wdir,{recursive:true});
const tfp=pp.join(wdir,'t.jsonl');
fs.writeFileSync(tfp,[
 JSON.stringify({type:'message',role:'user',content:[{text:'查'}]}),
 JSON.stringify({type:'message',role:'assistant',content:[{text:'好的我来帮你查一下这个文件的内容'}]}),
 JSON.stringify({type:'message',role:'assistant',content:[{text:'根因：测试\n修复：完成'}]})
].join('\n'));
const prevGate=process.env.CTXFORGE_GATE;
// 显式 opt-in 才启用闸门（默认关闭，因为重写=生成两遍=负资产）。
process.env.CTXFORGE_GATE='on';
delete require.cache[require.resolve('../lib/hook.js')];
const hookProc=require('../lib/hook.js');
const prevHome=process.env.CTXFORGE_HOME;process.env.CTXFORGE_HOME=pp.join(wdir,'home');
let captured='';const oldWrite=process.stdout.write;
process.stdout.write=(s)=>{captured+=s;return true;};
hookProc.stopGate({session_id:'pt',transcript_path:tfp});
process.stdout.write=oldWrite;
ok('过程长句中消息被拦（opt-in）', captured.includes('过程外显'));
if(prevHome===undefined)delete process.env.CTXFORGE_HOME;else process.env.CTXFORGE_HOME=prevHome;
if(prevGate===undefined)delete process.env.CTXFORGE_GATE;else process.env.CTXFORGE_GATE=prevGate;
console.log(`\n[过程段] ${pass} PASS / ${fail} FAIL`);
process.exitCode=fail?1:0;
