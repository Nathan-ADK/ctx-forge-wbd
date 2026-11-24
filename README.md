# ctx-forge（WorkBuddy / WBD 侧）

**WBD 侧的省 token 插件**：零常驻注入、可逆的上下文锻造器。把每轮固定注入成本降为 0，正文外置落盘，上下文只留四字段锚定摘要 + 极简句柄，可逆、零丢失。零依赖，Node 18+。

> 本包发布的是 **WorkBuddy（WBD）宿主版本**：钩子走 WBD command hook，CLI 走 `bin/ctx-forge.js`。
> **不含 DSH 宿主代码**（DSH 侧是独立入口 `dsh/index.js`，仅供 DSH 宿主使用，不随本公共包发布）。

## 与 REA 是两个完全不同的插件

- **功能不同**：ctx-forge 负责「让大模型精简输出 + 压缩上下文」；REA 负责「逆向分析按需调用」。二者解决的是两类问题，互不隶属。
- **零代码依赖**：ctx-forge 不 import 任何 REA 模块、不读 REA 脚本/运行时、不改 REA 配置。二者可各自独立安装、独立卸载，互不干扰。
- **卸载 ctx-forge**：删 `~/.workbuddy/skills/ctx-forge` 链接，并从 `~/.workbuddy/settings.json` 的 `hooks` 里移除指向 `ctx-forge/lib/hook.js` 的 4 条命令即可；不影响 REA。

## 目标
- token 最大节省：每轮注入成本 = 0（UserPromptSubmit 完全静默，零规则注入）。
- 上下文极致压缩：正文落盘 + 四字段锚定摘要（intent/decisions/facts/open）+ 极简句柄，可逆调阅。

## 安装
```bash
npm install -g ctx-forge
# 或本地：
npm install ctx-forge
```

## 钩子（自动，零注入零拦截）
在 WBD 4 个 hook 事件挂载：
```
node <ctx-forge包>/lib/hook.js
```
- `UserPromptSubmit`：完全静默放行，零注入。
- `Stop`：事后极简闸门（≤3 行、每行 ≤40 字、禁填充/过程外显），合规零成本，违规才 block 重写。
- `PreCompact`：归档 + 深度锻造回注（默认 lite）。
- `SessionEnd`：归档，不回注。

## 命令（CLI）
```
ctx-forge ingest <文件|-> --session-key <键>      # 归档正文
ctx-forge forge --session-key <键> [--budget 600]  # 锻造压缩正文
ctx-forge get F0003 --session-key <键>            # 按需调阅原文块
ctx-forge status [--session-key <键>]             # 查看归档会话
ctx-forge rm --session-key <键>                   # 删除会话归档
ctx-forge deep --session-key <键> --level max     # 深度锻造冲 95%+
```

## 归档目录
优先级：`CTXFORGE_HOME` 环境变量 > 本机 `wbd-home.json` 覆盖文件 / 同级 WBD 根（会话落其 `sessions/` 子目录）> `~/.ctxforge`（用户主目录，跨机器可移植）。
`wbd-home.json` 为可选的本机配置文件（发布包不含）；不配置时自动回退主目录。

## 环境变量
`CTXFORGE_HOME` · `CTXFORGE_BUDGET`(默认600) · `CTXFORGE_LEVEL`(lite|balanced|max, 默认lite) · `CTXFORGE_GATE`(on/off, 默认on) · `CTXFORGE_LINE_CHARS`(默认40)

## 测试
`npm test`（或 `node test/forge-test.js`）。

MIT 许可。
