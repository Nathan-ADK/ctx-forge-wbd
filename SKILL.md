---
name: ctx-forge
description: 零常驻注入的可逆上下文锻造器（WorkBuddy 侧省 token 插件）。平时静默、零每轮注入成本，只在 PreCompact/SessionEnd 压缩点归档锻造正文并回注锚定摘要+句柄；需要历史时按需 get 调阅。触发词：省token、压缩上下文、锻造、ctx-forge、归档正文、调阅历史块。
---

# ctx-forge — 零常驻注入的上下文锻造器

## 这是什么
WorkBuddy 侧的省 token 插件（对应 DSH 侧的 ctx-forge DSH 宿主版，二者同源不同宿主）。
核心：把每轮固定注入成本降为 0，正文外置落盘，上下文只留四字段锚定摘要 + 极简句柄，可逆、零丢失。

## 何时用
- 长会话、上下文快爆、想省 token 时。
- 需要把已完成的大段工作归档、之后按需调阅某一块原文时。
- 想压缩当前会话历史但保留可逆调阅能力时。

## 用法（CLI）
```
ctx-forge ingest <文件|-> --session-key <键>      # 归档正文（会话/文件）
ctx-forge forge --session-key <键> [--budget 600]  # 锻造压缩正文，回注锚定摘要+句柄
ctx-forge get F0003 --session-key <键>            # 按需调阅某一原文块
ctx-forge status [--session-key <键>]             # 查看归档会话状态
ctx-forge rm --session-key <键>                   # 删除某会话归档
ctx-forge deep --session-key <键> --level max     # 深度锻造冲 95%+ 压缩
```

## 钩子（自动，零注入零拦截）
WorkBuddy command hook 挂 4 事件：
- UserPromptSubmit：完全静默放行，零注入。
- Stop：事后极简闸门（≤3 行、每行 ≤40 字、禁填充/过程外显），合规零成本，违规才 block 重写。
- PreCompact：归档 + 深度锻造回注（默认 lite，可用 CTXFORGE_LEVEL=balanced|max 提档）。
- SessionEnd：归档，不回注。

## 环境变量
- `CTXFORGE_HOME`：归档根目录（默认 `~/.ctxforge`，可移植，跨机器通用）。
- `CTXFORGE_BUDGET`：回注预算 token（默认 600）。
- `CTXFORGE_LEVEL`：深度锻造档位 lite|balanced|max（默认 lite）。
- `CTXFORGE_GATE`：Stop 闸门开关（默认 on，off 关闭）。
- `CTXFORGE_LINE_CHARS`：Stop 闸门单行字数上限（默认 40）。

## 两个终极目标
1. **token 最大节省**：把每轮固定注入成本降为 **0**，压缩增益只在压缩点产生。
2. **上下文极致压缩**：正文外置落盘、上下文只留四字段锚定摘要 + 极简句柄，可逆、零丢失。

## 为什么推翻旧 ctx-suite（净账实测）
- 旧版每轮注入宪法：v2.0=453 / v2.1=221 / 1.3.8=192 token，20轮注入成本 9060/4420/3840。
- 旧版压缩是一次性收益（4171→582 省 3589），20轮口径净亏 5471/831。
- 结论：任何"每轮注入"都是负资产；输出约束靠模型遵守、非解码硬约束，不可计为确定收益。

## 独家解题思路（四条）
1. **零常驻注入**：UserPromptSubmit / Stop / SessionStart 一律静默放行，不塞任何规则文本、不拦截输出。
2. **只在压缩点做功**：PreCompact / SessionEnd 触发锻造；正文落盘 full.md，上下文回注锚定摘要 + 句柄索引。
3. **四字段锚定摘要**（业界最佳实践）：intent 目标 / decisions 决定 / facts 事实 / open 未决。确定性抽取，零 LLM 调用、零幻觉。
4. **净账护栏 + 分层可逆**：压缩输出先算 token 账，非净省自动 bypass；正文永不删除，按需 `ctx-forge get <F编号>` 调阅。

## 对比旧版（真实会话 3528 token）
| 维度 | ctx-suite 2.1 | ctx-forge 1.0 |
|---|---|---|
| 每轮注入 | 221 token | **0** |
| 输出拦截 | Stop block | **无，彻底放开** |
| 压缩比 | 86% | 83%（同量级） |
| 20轮净账 | 亏 831 | **正（仅压缩收益，无注入成本）** |
| 可逆性 | 句柄+落盘 | 锚定摘要+落盘+get 调阅 |
| 幻觉风险 | 规则文本 | 确定性抽取，零 LLM |

## 使用
```
ctx-forge ingest <文件|-> --session-key <键>       # 归档正文
ctx-forge forge --session-key <键> --budget 600     # 锻造压缩正文
ctx-forge get F0003 --session-key <键>             # 按需调阅原文
ctx-forge status / rm --session-key <键>
```

## 双平台
- WorkBuddy：command hook，仅挂 PreCompact / SessionEnd（零注入零拦截）。
- DSH：cordis 原生适配器，零注入、零 stream 拦截，仅归档锻造。
- 环境变量：`CTXFORGE_HOME`（数据目录）、`CTXFORGE_BUDGET`（回注预算，默认600）。

## 诚实边界
- 压缩是确定性的（token 账可复算）；输出风格不再被插件约束，由模型+系统提示+提问决定。
- 锚定摘要为规则抽取，非语义理解：能保留决定/数字/路径，不能替代模型级摘要。
- 正文落盘不删，但调阅需显式 `get`，未调阅的历史对模型不可见（这是压缩的代价）。


## v1.1 增量：不注入前提下的输出约束（纯 Stop 事后闸门）
- 关键区分：注入=每轮往上下文塞规则文本（旧192~453token，负资产）；Stop闸门=事后拦截，不违规零成本、不占每轮输入token。
- 恢复1.3.8级极简：过程允许≤8字状态词（核查中/已完成）或零输出；结论≤3行；禁填充/英文叙述/长流程播报；仅详述单次豁免行数。
- 闸门只在违规时 block 重写，不违规时对 token/上下文零影响——这才是"不注入又极简"的正解。
- 老插件本地数据（.ctxpack 330K/9会话）已迁移进 .ctxforge：5会话/80块/3564token，正文不浪费、可按需 get 调阅。

## 输出约束三问三答（诚实边界）
1. 不注入能否约束输出？能，靠 Stop 事后拦截（违规才拦截重写），但这是"事后纠错"非"事前预防"——首次输出仍可能超标被拦，重在最终结果极简。
2. 老数据有节省吗？数据本身是历史正文落盘，不占当前上下文；价值在"按需调阅避免重读原文"。新插件已迁移可读取，沉睡资产已激活；不调阅时零成本。
3. 与旧插件谁更优？token账：新插件优（零每轮注入，20轮净省vs旧亏831）；输出约束：两者最终效果相当（同一套判定），但新插件零注入成本；压缩：同级（83% vs 86%）；老数据：已迁移，新插件可用。综合新插件更优。


## v1.2 深度锻造：突破 95%（超越业界 84%）
- 三级档位 CTXFORGE_LEVEL=lite|balanced|max（默认 balanced）。
- 原理：正文100%落盘，回注只留"极简决策码(目/决/实/未)+分片指针(F0001-F00NN)"；按句截断去宿主包裹，非硬切字符。
- 实测真实会话 3528token：lite省93.9% / balanced省97.3%(94tok) / max省98.7%(47tok)——均超95%。
- 诚实边界：越高档可直接看到的历史越少，更多依赖按需 get；95%不是信息塞进176token，而是正文外置后上下文只留导航+锚点。可逆(正文不删)。
- CLI: ctx-forge deep --session-key <键> --level max


## v1.4 生成层硬限制（实打实省 output token）
- 突破：DSH 的 llm/stream waterfall 的 options 是传给底层 pi-ai 的请求参数，options.maxTokens 映射到 API 的 max_tokens。
- 做法：在 waterfall 里设 options.maxTokens=CTXFORGE_MAX_TOKENS(默认0关闭)，模型物理上无法生成超限回复——这是生成层真省，非生成后截断。
- 流式兜底仍保留（去套话/限行/限字），仅改善呈现。
- WorkBuddy 无等价 llm/stream 钩子，只能事后Stop拦截，做不到生成层硬限制。
- 验证：测试48/0，options.maxTokens 被正确从8000压到配置值。
