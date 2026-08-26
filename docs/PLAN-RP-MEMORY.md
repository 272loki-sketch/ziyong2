# PLAN-RP-MEMORY：数据库式两级纪要 + 证据召回记忆系统

> 2026-08-26 立项。本设计承接用户定案：
> **采用 pi harness（`packages/agent`）已成熟的总结范式**——结构化固定格式、
> 初建/增量两套提示词、保留旧有效信息、无依据不编造；
> 并确认：**摘要 = 第二套事实权威**（正文不可能全量长期发送，长局必然只保留最近几楼
> 原文 + 早期摘要/记忆）。本文件是记忆系统改造的唯一决策契约。

## 0. 为什么采纳数据库的范式

梨园换引擎时 `session.compact()` 退场，长局压缩由台上自管 `rp-summary` 承担。但
pi harness 的 compaction/branch-summarization 系经过长期验证，有三个梨园当前
`rp-summary` 没有、但长局精确回照必须的东西：

1. **初建 / 增量两套提示词**（`SUMMARIZATION_PROMPT` / `UPDATE_SUMMARIZATION_PROMPT`）：
   - 初次：从零生成固定结构摘要；
   - 增量：`<previous-summary>` 传回旧摘要，明确「PRESERVE 旧有效信息 / ADD 新信息 /
     UPDATE 状态 / 不再相关可删 / 保留精确名称」——**不是摘要的摘要，是带旧底稿的改写**。
2. **固定输出结构**：不让模型自由发挥版式，字段把「事实」「进度」「决策」分开。
3. **无依据不编造**：摘要系统与 `memory_search` 都写明「不续写、不臆造、缺失令其模糊化」。

梨园复用其**范式与规则**，替换其**领域字段**（coding 的 Goal/Progress/Key Decisions →
RP 的 Story Phase/Characters/Events/Promises/Facts/Current Scene/Recall Index）。

## 1. 权威边界（本设计新增的部分，不推翻既有权威）

```text
Session Tree          = 正文/分支/用户输入的原始事实源（不被记忆库覆盖）
rp-state              = 镜头内角色账本（权威不变）
rp-world-state        = 模块化世界权威（权威不变）
rp-ecology-state      = 生态权威（权威不变）
rp-outline            = 动态大纲（权威不变）
rp-summary            = 长期故事纪要（**第二套事实权威**：覆盖区正文不进上下文后，
                        后续主演对早期事实以摘要为准；原始正文仍由 Session Tree 保留）
rp-event-digest       = 一级事件纪要（检索投影 + 原文锚定；不推翻 rp-state/outline）
memory archive        = 被裁原文证据（可与 rp-summary 冲突，赛氏以「摘要管事实、
                        归档管细节」为原则：细节以归档原文为准，事实以摘要+状态为准）
```

**不引入**第二套正文 Writer、第二套持久 Session、第二套 canonical 世界/人物/事件状态。

## 2. 两级纪要 + 证据归档

### 2.1 一级纪要：事件卡（event digest）

每轮/每场景生成短事件候选人，高价值事件晋升为长期保活卡。附原文锚点。

```ts
interface RpEventDigest {
  kind: "rp-event-digest";
  id: string;                // canonical id = event_<sha1(session|card|sourceRef|title)>，代码生成，非面板可改
  sourceKey?: string;        // 模型/提示词输出的稳定来源键；最终 id 由代码按 sourceRef 生成
  status: "candidate" | "active" | "resolved" | "retired";
  importance: "core" | "major" | "normal" | "minor";
  title: string;
  turnRange?: { from: number; to: number };
  sourceRefs: Array<{ entryId: string; entryType: string; turn?: number; charFrom?: number; charTo?: number }>;  // 原文锚点（可精确到字符区间）
  participants?: string[];
  time?: string;
  location?: string;
  tags: string[];
  recallAnchors: string[];    // 历史回照措辞（「那把伞」「第一次见面」「当年」）
  summary: string;            // 短事件摘要
  evidenceLevel: "source-backed" | "summary-only";
  branchLeafId?: string;      // 生成时分支叶；子孙分支可继承
}
```

### 2.2 二级纪要：长期故事纪要（rp-summary v2）

沿用现有 `rp-summary` 条目（CustomEntry），但由数据库式统一提示词生成：

```text
## Story Phase         当前阶段 + 阶段目标 + 阶段起点
## Story Progress      时间序重大推进（谁做了什么 → 结果 → 影响哪条线）
## Characters          核心人物状态 + 关系演变 + 称呼习惯
## Core Events         稳定 id 列表（不重复写全文）
## Promises & Threads  未兑现承诺 / 未解决误会 / 未揭露真相 / 活跃伏笔
## Canon Facts         已确认时间线 / 物品归属 / 身体状态 / 身份 / 关键数值
## Knowledge Boundaries 谁知道什么 / 谁不知道什么 / 不能泄露的后台秘密
## Compression Boundary 被压缩区间结束时的时间/地点/人物/动作（早期摘要边界，不是续演点）
## Current Continuity   续演点：由最近保留正文与 rp-state 提供；不得用压缩旧场景冒充
## Recall Index        历史回照词 + 事件 id + 别名
```

### 2.3 证据归档（memory archive）

被压缩正文完整归档进剧情库（现状已做），本次增强：
- 分块时携带 `entryId` / `entryType` sourceRefs；
- meta 增加 `kind: "evidence"`；
- 核心事件卡标注 `importance: "core"`，不受普通 FIFO 淘汰；evidence 是可回源缓存，
  容量不足时允许淘汰，命中事件后优先沿 sourceRefs 回 Session Tree。

## 3. 提示词：数据库式两段

### 3.1 一级纪要（随压缩 envelope 产出）

一级纪要不单独调一次模型。它与二级纪要一起，由**同一次压缩旁路**返回统一 envelope
（§3.5）：`{"version":2,"summaryMarkdown":"...","events":[...]}`。只有兼容路径
（旧模型只回 Markdown）才走 `workflow: memory` Skill 的补丁提取。

system：
> 你是长篇角色扮演的记忆整理旁路。从给定正文/状态提取事件候选（随摘要 envelope 返回）。
> 只记录已发生事实，不续写剧情、不替角色作决定、不评论。人物名/物品名保持剧中写法。
> 证据不足的事件只能 `summary-only`，不得 `source-backed`。每条候选必须带 sourceRefs
> （正文里的 entryId 或拍序），且引用必须落在本次输入范围内。无重要事件则输出空列表。

user：`<conversation>` 本拍/本场景正文序列化 + `<state>` rp-state 快照 + `<previous-events>` 既有候选
　→ 输出：`{"version":2,"summaryMarkdown":"...","events":[{...}]}` JSON。

### 3.2 二级纪要·初建（复用数据库范式）

system：
> 你是长篇角色扮演的记忆整理旁路。读取已发生剧情，生成固定结构的长期故事纪要。不续写正文。

user：`<conversation>` 早期剧情 + `<state>` 状态快照
　→ 输出统一 envelope：`{"version":2,"summaryMarkdown":"(§2.2 十节)","events":[]}`。

### 3.3 二级纪要·增量（核心，对齐 UPDATE_PROMPT）

system：
> 你是长篇角色扮演的记忆整理旁路。读取「新剧情」并把它并入旧长期纪要。
> RULES：
> - PRESERVE 旧纪要中仍有效的信息；
> - ADD 新事件、新关系变化、新事实；
> - UPDATE Story Phase / Characters / Compression Boundary（写被压缩区间末端场景）；
> - MOVE 已兑现的承诺从未解决区 -> 历史结果（不丢事件 id）；
> - REMOVE 已不再相关且低价值的细节；
> - PRESERVE 人物姓名写法、物品名、事件 id、Recall Index、Knowledge Boundaries；
> - 不确定候选不得升级为事实；无足够证据的细节不补写；
> - 不续写剧情；只输出统一 envelope（`{"version":2,"summaryMarkdown":"...","events":[]}`）。

user：`<previous-summary>` 旧纪要 + `<new-events>` 新事件卡 + `<new-narrative>` 新正文
　→ 输出更新后的统一 envelope。

### 3.4 召回提示词（沿用现有 memory_search，补两阶段）

现有 `memory_search` 语义保留（合并两库取前 N、无命中不得臆造、可以模糊化）。
增量说明：
- 命中 `kind:event` 条目 → 是事件定位，可概括回忆，不得伪装逐字记忆；
- 命中 `kind:evidence` 条目 → 是原文证据，可准确回忆动作/物品/关键对白，但不得整段照抄，
  并按角色知情边界自然表达；
- 纪要与证据冲突时：事实以 rp-summary / rp-state / 当前分支为准，细节以证据原文为准。

### 3.5 统一摘要 envelope

压缩旁路一次调用，同时返回长期纪要 + 事件候选，避免「摘要模型」与「事件模型」各自
生成两套命名：

```json
{
  "version": 2,
  "summaryMarkdown": "## Story Phase\n…（完整 10 节 Markdown）",
  "events": [
    { "id": "source_exam_announced", "sourceKey": "source_exam_announced", "title": "…", "importance": "core", "tags": [], "recallAnchors": [], "summary": "…", "sourceRefs": [...] }
  ]
}
```

代码在入库前将每个事件的 sourceKey **重写成 canonical id**
（`event_<sha1(session|card|sourceRef|title)>`），并把摘要 Markdown 中的旧别名一并替换，
保证 Core Events / Recall Index / 事件卡引用同一 id。旧模型只回纯 Markdown 时，走
§3.1 补丁提取，但 canonical 化规则不变。

## 4. 两阶段召回（主演拍前自动接入）

不再只依赖主演主动调 `memory_search`；拍前装配由确定性注入：

### 4.1 召回构造

输入信号（无模型调用、纯装配侧）：
- 用户本轮原文 `lastUserText` **先过轻量历史回照预判** `shouldRecallHistory()`——
  命中「第一次/当年/还记得/那把……」等信号才发起云端 embedding 召回；普通拍不发查询；
- Roster 中已不在当前状态的条目名（离场/离失/了结）；
- 当前活跃 plot_threads / outline 伏笔标题；
- 当前在场人物名 + 地点 + 物品。

输出（两阶段）：
1. `recall-for-turn(query)` → `memoryRecallForTurn`（受 `injectOnTurn` + 预判双重门控）：
   合并检索事件/纪要 + 证据，**按当前分支祖先链过滤**（`visibleEntryIds`），去重后取最多 6 条；
2. 命中的事件再沿 `recallEvidence`/sourceRefs 回 **Session Tree 原文**；缺 sourceRefs 或
   树条目不可读时退回 evidence 向量缓存。

召回预算 15 秒；事件 kind 的注入块以「标题+摘要+标签」可读文本呈现，不把 JSON 原样塞进主演上下文。

### 4.2 注入位置（不破坏用户原话最后一句）

在 `buildStageInjection` 末尾、`【预设末端指令】` 之前插入：

```text
【剧情记忆】
本拍可能触及以下历史（按需自然融入，勿逐字照抄）：
- 〔初遇事件 · event_first_meeting_001〕……
- 〔早期归档 · 原文证据〕……
```

用户当拍原话仍然必须是上下文最后一句（既有约束不变）。

### 4.3 预算与降级

- 召回不进入正文首字关键路径：拍前装配时按并行旁路等待，超时/失败 → 无【剧情记忆】，
  主演按摘要 + 状态照常演；
- 召回结果受叶守卫：本拍期间切换分支 → 整块丢弃（与拍前生态/连续性同一律）。

## 5. 触发与保活

### 5.1 触发

| 时机 | 动作 |
|---|---|
| 每拍收尾（定稿且记账后） | 低成本候选事件提取（旁路，不进正文关键路径） |
| 事件达 core/major | 立即持久化为长期卡 |
| 场景结束（确定性信号） | 固化场景纪要，可能晋升 major |
| 周期性（everyNTurns/压缩时） | 二级纪要增量更新 |

不每拍跑高成本大摘要；普通拍只做候选提取或延迟合并。

### 5.2 分级保活（替代纯 FIFO shift）

```ts
// 现在的做法（保留，仅对 normal/minor 生效）：
while (chunks.length > maxChunks) chunks.shift();
// 改为：按优先级淘汰 —— core / major / active 事件与证据不淘汰；
//        先淘汰 minor 普通块，再 normal，reinforce/re-ranking 不清 core。
```

具体实现：新增 `evictByPriority(chunks, maxChunks)`，按
`kind/importance → createdAt` 排序淘汰；core/major 事件卡永不自动删，evidence 不作为
永久副本，必须保留 sourceRefs 以便回源。

## 6. 分支隔离

- 每个 event/evidence 记录 `branchLeafId` + `sourceRefs`（entryId 本身就在分支上，天然可逆）；
- 召回时：`getPathToRoot(leaf)` 得到当前分支祖先 id 集合；只返回 sourceRefs 全部落在这个
  祖先链上的条目（或 entryId 在当前分支可见）；
- 后台候选任务带 `expectedLeafId`，结束时比对，变了整体丢弃（沿用 R9 叶守卫）。
- evidence 回读优先直接从当前 Session Tree 按 sourceRefs 取原文；只有旧数据缺 sourceRefs
  或树条目不可读时才退回 evidence 向量缓存。

## 7. 现有数据迁移

- `rp-summary` 旧条目：保留，读时按 v2 结构解析失败则兼容展示（legacy）；
- narrative 滚动摘要 / archive：meta 补 `kind("digest"/"evidence")` 与 `importance` 缺省值；
  无 sourceRefs 的旧块标记 `evidenceLevel:"summary-only"`，不得直接当逐字证据；
- 不阻塞、不断言一次性破坏性迁移。

## 8. 落点（文件边界）

| 文件 | 改动 |
|---|---|
| `src/scribe.ts` | `buildRpSummaryInitialPrompt` / `buildRpSummaryUpdatePrompt` / `validateRpSummaryMarkdown`；摘要结构含 Compression Boundary + Current Continuity |
| `src/stage/compact.ts` | 压缩走统一 envelope：`parseRpSummaryEnvelope` 解析 `summaryMarkdown + events`；archive/事件写入带上界 sourceRefs（entryId/entryType/turn/charFrom/charTo）+ fire-and-forget |
| `src/memory/event-id.ts` | `canonicalEventId()`：按 session+card+sourceRef+title 生成 `event_<sha1>` |
| `src/memory/types.ts` | meta 增加 `kind / importance / sourceRefs / recallAnchors / evidenceLevel / eventId / branchLeafId`；`RpEventDigest` 含 `sourceKey`、sourceRef 精确到字符区间 |
| `src/memory/store.ts` | `evictByPriority` 分级保活（core/major 事件卡保活，evidence 可淘汰） |
| `src/memory/service.ts` | 事件卡 upsert 统一 canonical id；`memoryEvidenceForEvent` 按 evidence kind 预过滤 + 精确 sourceRef 回读；`memoryRecallForTurn` 分支可见性过滤 |
| `src/stage/assemble.ts` | `buildStageInjection` 增 `memoryRecall` 注入块；释义表补纪要与证据之分 |
| `src/stage/engine.ts` | 拍前 `shouldRecallHistory` 预判 + 两阶段召回 + 15s 预算 + 去重 + 分支过滤；`#sideText` 绝对超时与分级重试；摘要 canonical id 重写；诊断留痕 |
| `src/stage/diagnostics.ts` | 新增「剧情记忆召回」「记忆压缩与事件索引」诊断节点 |
| `src/model-routing.ts` | SideModelStep 增 `memoryEvents`（独立超时/重试档） |
| `server/main.ts` | stage deps 注入 recallForTurn/recallEvidence/shouldRecallForTurn/upsertEventDigest；召回按当前分支事件 id 过滤 + Session Tree 原文回源 |
| `server/rest.ts` | 新增 `GET /api/memory/events` |
| `src/tools/memory.ts` | `memory_search` 描述补纪要与证据之分；命中正文 / 事件卡可读化 |
| `skills/剧情记忆摘要/SKILL.md` | 事件提取 Skill：sourceKey 语义 + sourceRef 限定 + JSON 输出 |

规则提示词正文优先落 `skills/`（用户覆盖在 `.liyuan-stage-skills/`），不硬编码进 TS。

## 9. 验收目标（1000 楼回照场景）

- 第 1 楼初遇（递伞+误会）→ 产生 `event_first_meeting`（source-backed）；
- 长局压缩数次后 rp-summary v2 中仍有 Core Events 条目（事件不丢）；
- 第 1000 楼用户「还记得第一次见面吗」→ 拍前自动注入【剧情记忆】命中初遇事件，
  主演不必先主动调 `memory_search`；
- 追问「那天你递给我什么」→ 沿 sourceRefs 命中第 1 楼 archive 原文块，能答出信物；
- 分支 A 澄清 vs 分支 B 加深：各自召回只见祖先链内容，不串味；
- 中断/无命中：主演按摘要模糊化，不臆造原话。

## 10. 不做

1. 不把每拍正文全送给高成本模型做摘要（预算闸门 + 候选延迟合并）；
2. 不让事件卡推翻 rp-state / rp-outline；
3. 不新增第二套正文权威 / 第二套持久会话；
4. 不要求云端 embedding 才可工作（core 事件靠标签 + sourceRef 保证可回源）；
5. 不让记忆注入压住用户原话；
6. 不让后台记忆任务直接写正文。

## 11. 落地状态（2026-08-26）

- ✅ memory 类型 + 分级保活 + sourceRefs（P1A types / P1B store / P1C service）
- ✅ 摘要两段提示词（scribe.ts）+ compact 增量接线
- ✅ 拍前自动召回（assemble 注入块 + engine 调用 + main.ts 依赖）
- ✅ 事件候选提取 + archive sourceRefs 增强；旁路事件写入 fire-and-forget，不阻塞 agent end
- ✅ 分支可见性过滤 + 叶守卫 + 诊断投影 + 针对性测试
- ✅ 摘要/事件统一 envelope：`version=2 + summaryMarkdown + events`；兼容旧 Markdown
- ✅ 事件 canonical id 由代码按 session/card/sourceRef/title 生成（`src/memory/event-id.ts`），模型 id 只作 source key
- ✅ 摘要提交门禁：`validateRpSummaryMarkdown` 校验 Story Phase→Current Continuity 共 10 节，缺结构 fail closed
- ✅ 摘要字段修正：新增 `## Compression Boundary`（压缩区间末端），`## Current Continuity` 只作续演点提示
- ✅ 证据召回先按 `kind=evidence/source=archive` 过滤，再取 topK；有 sourceRefs 时**优先回 Session Tree 取原文**，缓存兜底
- ✅ `#sideText` 旁路超时与分级重试：主演 15 分钟，普通旁路 90 秒，压缩 120 秒，事件提取 60 秒
- ✅ 历史回照预判 `shouldRecallHistory()`：普通拍不发云端 embedding 查询；召回 15s 预算 + 去重 + 上限 6 条
- ✅ 诊断投影新增「剧情记忆召回」「记忆压缩与事件索引」节点；`GET /api/memory/events` 数据面
- ✅ 测试：`test/rp-memory.test.ts`（9 条）+ `test/rp-memory-longrun.test.ts`（1000 楼冲刷模拟）

### 实弹（2026-08-26，实教二年级篇 + zhuzhan/deepseek-v4-pro）

- ✅ writer 演正文稳定：多条完整正史落树（最长 9710 字），工具轮/分段/封笔全正常；
  hajimi 流式端点为概率性 `all cf workers failed to stream`（2/5~4/8），故正文渠道改用
  `zhuzhan`（magicv4.ltd `deepseek-v4-pro`，见 `liyuan-profiles/zhuzhan.json`）。
- ✅ 拍前自动召回实弹命中：「查剧情库『八神拓也 朱耀良 搭档笔试』· 1 条」来自滚动入库记忆。
- ✅ 滚动入库生效：narrative chunks 按 everyNTurns 合并（counter=3 触发）。
- ✅ 世界链 / 生态 / 记账 / 诊断逐拍落树；旁路 90s 超时按降级路径处理，不断正文。
- 摘要 v2 + 事件卡需压缩线（活拍≥7）实弹触达，当前由单测覆盖；继续实弹见 §12。

**归档**：本实现以本地 git 提交落盘（见 `docs/LOCAL-UPSTREAM-UPDATES.md` §6.1）——
`4b2680e` 仅提交到 `local` 分支，**不推向 GitHub**；恢复点
`/root/backups/liyuan-update-20260826-200338/repository.bundle`。

### P0 约束补充

- 摘要旁路优先输出统一 envelope：`{"version":2,"summaryMarkdown":"...","events":[]}`；
  旧模型返回纯 Markdown 时保留兼容路径，但事件提取属于补偿路径。
- 模型事件 id/sourceKey 不作为 canonical id；代码用 `session + card + sourceRef + title` 生成
  `event_<sha1>`，并在摘要中的旧别名位置重写为 canonical id，避免摘要和事件库各自命名。
- 事件卡事件引用只接受当前压缩输入提供的 sourceRefs；证据回读优先从当前 Session Tree
  按 sourceRefs 取原文，取不到才搜 evidence 缓存。
- 普通拍不自动发云端记忆查询；只有「第一次/当年/还记得/那把……」等历史回照信号才触发
  `recallForTurn`。召回结果去重并限制为最多 6 条。
- `memory-recall` 与 `memory-settlement` 已进入本拍诊断投影；召回失败/超时显示降级，
  不把失败伪装成未触发。

## 12. 后续优化（P1/P2 剩余）

- 将世界/生态/压缩后台结算与「正文完成」拆成两个 UI 状态；当前旁路有超时和降级，
  但 `performTurn()` 仍会等待拍后结算后才完全结束（待用户拍板再拆）。
- 导演室增加记忆诊断与事件卡管理页面：触发原因、命中事件/证据数、超时、悬空引用、
  来源楼层、手动升/降重要性。已提供 `GET /api/memory/events` 数据面。
- 「正文完成」与「后台结算完成」拆分、真实 API 低频回照回归测试继续补齐。
