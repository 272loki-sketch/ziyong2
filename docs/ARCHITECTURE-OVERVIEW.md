# 梨园（Liyuan）架构总览

> 面向 AI 助手与后续维护者的第一手结构说明：先读本文件，再按需深入各 PLAN 权威文档。
> 更新准则：任何引擎/提示词改动都要能回答「离 `docs/PLAN-ROUND-FLOW.md` 近了多少」、
> 「离 `docs/PLAN-RP-MEMORY.md` 近了多少」，并保持「状态进分支树、规则进 Skill、
> TS 只做编排与安全门禁」这条铁律。

本质一句话：**梨园把 coding-agent 的能力（skill、工具调用、决策卡、面板、世界线/分支）翻译进
角色扮演场景，让剧情模型只写正文，系统事务交给 harness 的旁路与确定性门禁。**

---

## 1. 权威边界（不可同时存在第二套）

```text
Liyuan Session Tree      = 聊天、分支、回复变体、世界线权威（f(分支)）
rp-state                 = 镜头内角色账本（time/location/characters/inventory/flags/plot_threads）
rp-world-state           = 模块化世界权威（ModularWorldState v2；旧 v1 快照内存迁移为 legacy 模块）
rp-world-manifest        = 当前分支采用的卡级世界适配版本
rp-world-audit           = 世界转移审计留痕（不进主演上下文）
rp-ecology-state         = 人物生活、地点活动、日程、通讯、认知、可错过事件
rp-outline               = 当前分支动态大纲（未来方向、人物弧线、伏笔；低于已提交事实）
rp-outline-proposal      = 大纲 pending/approved/rejected 提案与审计留痕
rp-outline-chat          = 导演室讨论记录与即时场景建议（非正文、非事实）；清空讨论追加 `rp-outline-chat-clear` 标记，`#chats()` 只读标记之后的内容
rp-summary               = 长局压缩接力摘要（**第二套事实权威**：被覆盖早期正文不进上下文后，早期事实/角色记忆以摘要为准；细节由 .liyuan-memory 归档召回）
rp-curtain-override      = 状态栏重 Roll 覆盖工件（只改展示）
rp-turn-diagnostic       = 只读结算留痕（场记结果、不成为第二套账本权威）
.liyuan/outline/research/corpus/ = 小说消化产物（documents.json / texts / digests；`documents` 入 OutlineResearchView，机制进 mechanisms.json）
.liyuan-memory           = 检索记忆（向量）：narrative 剧情库（滚动纪要 digest / 事件卡 event / 归档证据 evidence）+ external 额外库；事件卡带原文锚点 sourceRefs，两阶段召回（事件→证据）
.liyuan/world/cards/<key>/profile.json = 卡级长期世界画像（跨会话）
StageEngine              = 唯一正文所有者 + 独立谢幕格式轮唯一时机
```

禁止引入第二套 Writer、第二套持久 Session 或第二套 canonical 世界/人物/事件状态。
日历、舆情、认知展示、诊断投影都是已提交状态的只读投影，不写回权威。
记忆系统（`docs/PLAN-RP-MEMORY.md`）依循同一原则：事件卡是检索投影 + 原文锚定，
不推翻 rp-state / rp-outline；正文唯一事实源仍是 Session Tree，记忆库只做总结与召回投影。

---

## 2. 目录地图

| 路径 | 职责 |
|---|---|
| `src/stage/engine.ts` | **台上引擎**：performTurn/regenerate/regenerateCurtain/abort、拍前并行、writer 分段、记账、拍后世界/生态、压缩、场记结算留痕、`#draftForwarder` 流式转发稿件 |
| `src/stage/workspace.ts` | 回合工作区（稿纸）：beat_plan/draft_append/draft_seal/draft_edit/world_state_update、单拍边界门禁、write 工具 |
| `src/stage/assemble.ts` | 装配：字节稳定的 system prompt + 每拍末端注入；rebuildHistory 只回读正文 |
| `src/stage/tools.ts` | 台上工具 schema 与执行路由（读侧检索 / 写侧稿纸 / ask） |
| `src/stage/scribe-run.ts` | 场记兜底记账（主演未记账时） |
| `src/stage/compact.ts` | 长局压缩（rp-summary v2 两段式增量 + 事件卡提取 + 证据归档） |
| `src/memory/*` | **记忆服务**（PLAN-RP-MEMORY）：`types.ts` 事件卡/证据类型与分级保活；`store.ts` evictByPriority；`service.ts` 事件卡读写、两阶段召回、归档 sourceRefs、`memoryRecallForTurn` |
| `src/scribe.ts` | 场记提示词 + **接力摘要两段式**（初建 `RP_SUMMARY_SECTIONS` / 增量带 `<previous-summary>`） |
| `src/stage/diagnostics.ts` | **本拍诊断只读投影**：从 Session Tree 动态构造回合诊断（关联、状态判定、安全裁剪、超大型截断与来源校验） |
| `src/stage/literary-*.ts` | 文学工作流各步：连续性、Sogon/Sigon、director、world-profile、world-modular、world-transition、world-signals、ecology |
| `src/outline/` | 独立大纲系统：Schema/runtime parser、分支恢复、Proposal/Audit/Commit、研究库、消费者安全投影与 OutlineEngine |
| `src/outline/corpus.ts` | **小说长文消化管道**（PLAN-NOVEL-DIGEST）：解码/清洗/分章/分块纯函数 + 文档级最多 3 并行的 CorpusEngine（断点续跑、暂停/恢复/删除、独立取消、预算闸门、docId 幂等、模型层 9 次退避重试 + 文档级自动重试） |
| `src/outline/corpus-scheduler.ts` | 小说研究自动任务：按本地时间每日调度 Kakuyomu 搜索，候选去重后最多 3 部入 CorpusEngine；不进入正文关键路径 |
| `src/outline/kakuyomu.ts` | Kakuyomu 作品页与搜索适配器：URL 校验、候选发现、Episode 列表提取、章节正文解析（Apollo State / ruby / 连续段落），用于手动 URL 与每日自动任务 |
| `src/stage/calendar.ts` | 确定性历法/日期/跨月区间/年度重复投影（纯函数） |
| `src/stage/skill-store.ts` | Skill 装载（内置 `skills/` + 用户覆盖 `.liyuan-stage-skills/`） |
| `src/presentation.ts` | 状态栏/日历/选项原生投影（只读视图） |
| `server/main.ts` | HTTP/WS 宿主、广播、会话管理、模型路由、REST 宿主接线、大纲异步校准调度与运行时诊断状态管理 |
| `server/rest.ts` | REST API（card/config/world-profile/world-state/skills/diagnostics…） |
| `server/wire.ts` | 会话树 → 前端 wire 协议翻译；`workflowView` 安全投影导演/连续性工件 |
| `web/src/` | React 前端；`Messages.tsx` 渲染消息、世界/生态卡、本拍工作流卡 |
| `web/src/planning/` | 独立导演工作台（梨园导演室）：分组侧栏（创作对谈 / 提案审阅 / 故事脉络 / 人物成长 / 伏笔追踪 / 藏书消化 / 创作素材库 / 演出回放 / 版本与设置），七种讨论模式，每 5 秒自动刷新诊断页；支持手动选书与 Kakuyomu URL 抓取 |
| `skills/` | 内置工作流 Skill（随版本更新） |
| `.liyuan-stage-skills/` | Skill 用户覆盖（gitignore，不随版本覆盖） |
| `packages/` | `@liyuan/*` agent 内核（pi fork，file: 依赖）；`packages/ai` 含 provider 请求与重试 |

---

## 3. 一拍完整流程（普通拍骨架）

```text
用户输入
  ├─ 追加 user 条目、捕获 expectedTurnLeafId（用户消息后固定，≤这个叶之内配套门禁）
  ├─（无 Manifest 时：检测到已存在卡级 profile → 只播种 Manifest，不改变预期叶）
  ├─ 后台：世界画像 / Sogon / Sigon 后台生成，下一拍生效（不阻塞正文首字）
  ├─ 并行：
  │   生态 arrival  ─┐
  │   文学连续性      ─┴→ Promise.all（条件触发）
  ├─ Stitches 导演（吸收 arrival + continuity + profile）
  ├─ writer 分轮：beat_plan → draft_append（硬件级门禁：每轮只受理一段，同轮第二个被拒收并计入 appendRejects）→ 回看/重拟 → draft_seal
  ├─ 主演记账（world_state_update → rp-state）；未记则由场记兜底
  │   └─ 场记结算留痕（rp-turn-diagnostic，记录跳过/失败/丢弃原因）
  ├─ 拍后（并行计算、顺序落树）：
  │   世界链：事实信封 → 到期模块提案 → 独立审计 → TS 门禁 → 原子 commit → rp-world-audit
  │   生态 aftermath → rp-ecology-state
  ├─ 独立谢幕格式轮 → rpCurtain（格式卡在 agent loop 内生成）
  ├─ agent end 后：OutlineEngine 按 manual/suggest/auto 异步校准（不阻塞正文；下一拍生效）
  │   └─ 异步校准状态：pending → stable / committed / proposal / failed
  ├─ 压缩（按 everyNTurns，0=关闭自动）
  └─ onTurnEnd → agent:end → resyncAll（hello 全量重放）
```

关键设计：

- **正文唯一入口是稿纸**；`draft_append` 一次模型生成轮只接一段（硬门禁）。
- **计划是假设，不是剧本**：每段后重新评估，可重拟。
- **单拍边界**：默认只能推进当前场景；用户明确要求时间跳转才放行（`transitionAuthorized`）。
- 正文 `rpNarrative` 与格式 `rpCurtain` 分工件落树；历史只回读正文。
- 拍后世界/生态在 `agent end` 前完成，保证下拍读到完整分支。
- 诊断数据只从已落树的 assistant `details`、`rp-turn-diagnostic` 和拍后 custom 条目读取，不新增权威状态。

---

## 4. 关键机制的当前形态

### 4.0 记忆系统（PLAN-RP-MEMORY，2026-08-26）
- **两级纪要 + 原文证据**：一级事件卡（检索投影 + sourceRefs 原文锚定）、二级长期纪要（rp-summary v2）。
- **数据库式两段提示词**（对齐 pi harness compaction）：初建 / 增量两套固定结构；
  增量显式「PRESERVE 旧有效信息 / ADD 新事件 / UPDATE 状态 / MOVE 已兑现 → 历史结果」，
  传 `<previous-summary>` 回读，杜绝「摘要的摘要」漂白。
- **拍前自动召回**：先用轻量历史触发预判，命中后按用户输入经 `recallForTurn` → 事件 →
  `recallEvidence` 两阶段召回，注入【剧情记忆】（事件/纪要/证据分标）；不依赖主演主动调
  `memory_search`。召回有 15 秒预算；缺失/超时/叶切换 → 整块丢弃（降级为摘要+状态照常演）。
- **分级保活**：`evictByPriority` 替代纯 FIFO——core/major 事件卡保活；原文 evidence 是可回源缓存，
  允许在容量不足时淘汰，命中事件后优先按 sourceRefs 回 Session Tree，避免数据库无限增长。
- **摘要 = 第二套事实权威**：早期正文被压缩后不再进上下文，角色记忆/早期事实以
  rp-summary v2 为准；细节以 .liyuan-memory 归档证据为准（两阶段召回 sourceRefs）。
- **事件候选提取**：统一摘要 envelope 优先一次生成 `summaryMarkdown + events`；旧 Markdown 才
  走兼容事件提取。统一事件 ID 由代码生成，压缩/事件旁路 fire-and-forget，不阻塞正文；规则在 Skill，不在 TS。
- **旁路超时与分级重试**：主演 writer 15 分钟、压缩 120s、事件提取 60s、其余旁路 90s；
  memoryEvents 只重试 1 次，避免旁路拖死 `agent end`。
- **可观测性**：本拍诊断新增「剧情记忆召回」「记忆压缩与事件索引」节点；`GET /api/memory/events`
  暴露事件卡数据面。普通拍不再发云端 embedding 查询（`shouldRecallHistory` 预判门控）。
- **实弹验证（2026-08-26，实教二年级篇）**：`zhuzhan` 渠道（magicv4.ltd，`deepseek-v4-pro`，见
  `liyuan-profiles/zhuzhan.json`）演正文稳定（流式不断流），拍前自动召回命中滚动入库记忆、
  记账/世界链/生态/诊断/滚动入库全链路落树正常。选用正文渠道时优先流式稳定的 provider——hajimi
  流式端点为概率性 `all cf workers failed to stream`（实测 2/5~4/8），旁路非流式可用。

### 4.1 中断 / 错误降级（8/19 实测修复）
- `#draftForwarder` 记录已实际送显的 `draft_write/append` 参数片段，返回 `pendingText()`。
- 取消或后续 provider 报错（429/断流）时，已受理稿段 + 当前半截合并为
  `stopReason: aborted` 的未完成回复落树；`finalTimeline` 保留前段、半截作独立末段。
- 被 `stream:clear` 标记的计划旁白不会复活。
- 中断/失败稿不记账、不推进世界/生态、不落媒体交付。
- 没有 provider final 时，只要有稿，也会合成 aborted assistant 记录。

### 4.2 请求重试
- 主演与所有旁路调用：provider 层自动重试，初次之外最多 9 次，遵循退避与 `Retry-After`。
- abort signal 立即停止；耗尽重试后已写正文不丢。

### 4.3 ask 决策门禁
- `ask` 工具在宿主注入 `askUser`（选择卡通道）时才会装配；`creationMode: ask` 才有意义。
- 触发：用户求方向、开局未定变量、演段后自然分岔。
- ask 结果是「这一拍有戏」的结构信号（lookups++）。

### 4.4 生态门禁（validateEcologyTransition）
- 终态不可重开；`message` 认知只来自已送达且收件人匹配的通讯。
- 公共事件/外部公告（OAA、广播）**不要求**引用当前 actor 工作集或当前跨域信号（避免首次建态误拒）。
- 仅本域 `occurrence:/secret:` 引用严格校验；通讯终态（delivered/failed/cancelled）不可倒退。

### 4.5 世界画像 / Manifest / 世界链
- 卡级 profile 按内容身份哈希；`draft` 每 8 拍复盘，`stable` 锁定。
- 已存在 profile 而分支无 Manifest：下一拍直接播种（不依赖后台候选）。
- `workflow: world` 缺内置回退时会整链停摆的教训已内置 `skills/世界推演/`。
- 世界只推进到期模块；秘密保持 secret；跨域用 `originRefs/kernel.links` 引用不复制。

### 4.5.1 大纲弧线角色与导演建议精度（8/24）

- **弧线形状末端锚定**：`computeArcShapeRole()` 纯函数从活跃 beats 序列确定性派生 `setup|rising|hardest|climax` 角色——高潮永远绑定最后一个活跃 beat、hardest 永远绑定倒数第二个，跳过或重构中间 beats 不漂移。
- **Goal/Objective 分离**：`sceneAdvice` 新增 `playerObjective / naturalReason / intendedConsequence` 三个字段，把导演建议拆成「幕后方向」（`recommendedBeat`）与「用户可见动作」（`playerObjective`）两层——用户不需要知道幕后秘密也能合理行动。
- **研究证据门禁**：小说提炼以块级/弧线级 evidence ID 绑定来源，独立审计后入库；研究可信度分旧定位、系统定位、审计通过。日常剧情固定三张、做结构差异检查并要求当前剧情接入钩子；这些都是导演旁路工件，不改变 StageEngine 正文所有权。
- **beat 兑现五态**：`OutlineArcBeatOutcome` 替代二元完成/未完成，区分 `progressing`（已有迹象但不够）/ `uncertain`（证据不足不提前揭晓）/ `fulfilled`（可信证据成立）/ `failed`（后果保留，旧尾段退役、新尾段新 ID 追加）/ `rerouted`（偏航时退役软 beats，已 fulfilled 不动）。
- **节奏意图**：`OutlinePaceIntent` 提供 `seed|normal|push|building|climaxing`——用户可表达的短期节奏信号，只影响未来编译，不改变既有事实，不越级推进 `rp-state`。
- 以上均在 `src/outline/schema.ts|projection.ts` 中；规则在 `skills/故事编剧室/SKILL.md` 和 `skills/剧情自动校准/SKILL.md`。

### 4.6 前端可观测性

**消息内工作流卡（`rpWorkflowView`）**：
- 消息下默认折叠「本拍工作流」卡：连续性、导演、生态抵达、主演分段、谢幕 + 主演指标。
- 展开可看安全的导演工件（压力/主动性/候选拍点/停点）；幕后线、暂扣信息、知情边界只显数量。
- 该卡绝不发送 prompt、原始模型输出或隐藏 reasoning。

**导演室「本拍诊断」页面**：
- 最近最多 20 回合按拍倒序展示，每拍拆成 12 个独立诊断节点：
  - 文学连续性 / Stitches 导演 / 生态抵达
  - 主演分段演出 / 角色账本
  - 拍后事实信封 / 世界转移提案 / 世界转移审计 / 世界原子提交
  - 生态 aftermath / 独立谢幕格式 / 大纲异步校准
- 节点状态覆盖完整生命周期：成功、降级、跳过、复用、失败、被拒绝、待确认、审计通过、稳定、已提交、不可用。
- 可查看主演轮次、稿段、拒收次数、耗时、token、账本修改审计、分支提交摘要和独立谢幕格式原文。
- 账本状态精确区分：成功提交、场记确认无变化、场记输出不可解析、场记因分支变化被丢弃。
- 世界链失败可定位到具体阶段：事实信封失败 / Proposal 预审拒绝 / 独立审计拒绝 / Audit 调用失败。
- 大纲异步校准显示：后台运行中 / 当前大纲稳定 / 等待用户确认 / 低风险自动提交 / 校准失败。
- 数据由 Session Tree、assistant `details`、`rp-turn-diagnostic` 和拍后已提交条目动态投影。
- 切换会话、导航分支、清空模块时缓存自动失效。
- 安全投影：不发送完整 prompt、生态秘密/幕后真相、世界书来源路径、隐藏 reasoning。
- 谢幕格式上限 32,000 字符，超出明确标记「已截断」。
- 旧会话缺少工作流工件的消息自动跳过，不生造假失败诊断。
- 手动大纲操作（编剧讨论/首次规划/手动确认）不混入本拍自动校准。
- 打开诊断页后每 5 秒自动刷新；后台校准完成后无需手动刷新。

### 4.7 本拍诊断 REST 接口
- `GET /api/turn-diagnostics?limit=N`（1–20，默认 12）—— 无模型调用、只读投影。
- `Cache-Control: no-store`，非法/浮点/超限 limit 均规范化。
- 安全性：在实例配置了 access password 时受全局 /api 鉴权保护。

---

## 5. 权威文档导航

| 文档 | 内容 |
|---|---|
| `docs/ARCHITECTURE-OVERVIEW.md` | 本文件：结构总览 |
| `docs/PLAN-ROUND-FLOW.md` | 分轮演出流程最终形态 + 关键路径分级 + 落地记录（**唯一流程靶子**） |
| `docs/PLAN-WORLD-ENGINE.md` | 世界引擎：画像/Manifest/事实信封/模块化状态/提案/审计/原子 commit |
| `docs/PLAN-RP-MEMORY.md` | **记忆系统**（两级纪要 + 证据召回）：数据库式两段摘要、事件卡、分级保活、分支隔离 |
| `docs/PLAN-LIVING-ECOLOGY.md` | 鲜活世界：三层权威 + running/ready 双池 + 跨域信号 + 失败语义 |
| `docs/PLAN-OUTLINE-SYSTEM.md` | 动态大纲系统：Proposal/Audit/Commit、伏笔状态机、安全投影、导演室工作台（含本拍诊断） |
| `docs/PLAN-NOVEL-DIGEST.md` | 小说长文消化与研究库扩容：上传→分块摘要→套路库（§17 含实现状态与未做事项） |
| `docs/STANDALONE-INTEGRATION-BASELINE.md` | 脱离 Luker 的整合基线：权威边界 + Skill 化 + 配置 + REST |
| `docs/DIRECTOR-ROOM.md` | 导演室用户参考：七种讨论模式、小说研究、即时建议卡、本拍诊断、建议如何转大纲 |
| `docs/LOCAL-UPSTREAM-UPDATES.md` | VPS 的 `master`/`local` 双分支、安全更新、冲突处理与恢复 |
| `docs/PRESET-SPLIT-TAXONOMY.md` | 预设拆层：A–I 类去留 |
| `docs/PLAN-RP-AGENT-EXEC.md` / `docs/PLAN-RP-AGENT.md` | RP agent 编排 |
| `docs/PLAN-RP-TOOLING.md` | 工具 schema 与写入门禁 |
| `docs/READING-THINKING.md` | 读思考记录的正确方法（先读再碰会话文件） |
| `docs/THIRD-PARTY-INSPIRATION.md` | 参考过 ST-SevenDaysCal 与 world-backstage 的能力与来源说明 |

---

## 6. 测试与验证

```bash
npx tsx --test test/*.test.ts        # 需 Node >= 22；完整后端测试
npx --yes node@22 --test --experimental-strip-types test/<file>.test.ts   # 指定文件
npm --prefix web run typecheck       # 前端类型检查
npm --prefix web run build           # 前端构建
```

- 领域/引擎测试用 `@liyuan/ai/providers/faux` 假 provider 离线整测，不联网。
- 真实供应商稳定性：远端 429/断流会造成部分拍「未完成」，本地会保留已写内容。
- 写测试优先断言「正文在树上 + 不记账」，避免把中断误标成成功定稿。
- 诊断投影测试用伪造分支条目离线验证关联、状态判定、安全裁剪与边界。
- 新增 `test/diagnostics.test.ts` 覆盖：阶段投影、世界失败、生态降级、limit 解析、旧消息排除、手动操作误归属、预审/审计区分、场记跳过/失败、超大型截断与异步大纲状态。

---

## 7. 维护要点（易踩坑）

1. **改流程先改 Skill**，不硬编码提示词进 TS。规则唯一权威在 `skills/` 与 `.liyuan-stage-skills/`。
2. **不要新增第二套状态**。要加的分支数据进 `rp-state/rp-world-state/rp-ecology-state` 对应权威，或作为只读投影（如 `rp-turn-diagnostic` 只记录场记结算摘要，不作为第二套账本权威）。
3. **叶守卫**：user 消息一旦落树即固定 expectedTurnLeafId；新增 custom 条目（如播种 Manifest）必须在捕获该叶之前，否则会被误判为「生成期间切分支」。
4. **取消/错误保留正文**：任何 provider 错误路径必须走 `#draftForwarder.pendingText()` 合并，避免半截丢失。
5. **`stream:clear` 语义**：工具轮流出的计划旁白应清屏，不能误当正文保存。
6. **`transitionAuthorized`**：明确用户推进时间才关闭单拍边界；不要在提示词里放宽或收紧正则导致误伤当前场景地点词。
7. **诊断归属不求位置**：世界链依赖 `narrativeEntryId`，状态/世界/生态依赖来源标识；不因条目紧邻某一拍就默认归属。
8. **诊断不展示原始模型输出**：安全投影字段白名单 + 明文裁剪 + 谢幕长度上限 + 提交记录数量上限；不新增不限长度的透传通道。
