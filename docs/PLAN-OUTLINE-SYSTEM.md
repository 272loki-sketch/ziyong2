# PLAN-OUTLINE-SYSTEM：动态大纲系统

> 2026-08-19。本文描述当前已实现的大纲核心契约。运行代码中的 collection patch 是唯一协议；Skill、审计、持久化与后续 API 接线不得另建 operations 协议。

## 1. 边界与原则

- Session Tree、已提交正文、用户选择、`rp-state`、`rp-world-state`、`rp-ecology-state` 高于大纲。
- `rp-outline` 是分支上的未来方向快照，不是正文事实；`rp-outline-proposal` 是 pending/approved/rejected 审计记录。
- `OutlineEngine`（`src/outline/engine.ts`）是 Proposal/Audit/Commit 的主路径。StageEngine 仍是唯一正文所有者。
- 五份工作流规则只在 `skills/*/SKILL.md`；`src/outline/*` 负责严格解析、确定性门禁、持久化恢复与安全投影。
- 计划是假设，已写下的戏更算数。自然偏航应改纲，不得纠正正文迁就旧纲。

## 1.1 故事导演讨论室

前端“导演室”是 OutlineEngine 的讨论入口，不是第二个 Writer。它提供五种即时讨论重心：

- `open` 综合编剧：长期路线与当前场景一起讨论；
- `next-beat` 下一拍：从当前已提交正文往下，给起手动作、角色主动性、压力、玩家空间和自然停点；
- `dialogue` 下一段对白：给对话意图、潜台词、信息交换和少量语气参考，不生成需要直接落树的正文；
- `character` 角色反应：说明当前人物最自然的反应、主动行动、顾虑和行为上限；
- `diagnose` 节奏诊断：检查拖沓、跳跃、重复、失焦和关系推进过快，并给修正建议。

即时建议通过 `sceneAdvice` 返回，包含推荐下一拍、起手、角色动作、建议聊天对象、切入话题、风险、对白线索、玩家空间、混合路线和停点。如果当前不宜直接找人，导演必须给出“先观察/先做事/等待条件变化，再找谁”的混合路线。

讨论消息以 `rp-outline-chat` 作为当前分支条目保存，随回档、变体和世界线恢复；它不进入主演正文历史，也不改变 `rp-state`、世界或生态权威。只有大纲 `proposal` 经用户在建议箱确认后才写入 `rp-outline`。

## 2. 当前数据模型

`OutlineState.version` 固定为 `1`，含 `revision/parentHash/hash/premise/currentFocus/alignment/sources` 及七个集合：

```text
constraints | arcs | characterArcs | threads | milestones | foreshadowing | settings
```

普通节点共同字段：

```text
id title summary
status: candidate|active|blocked|fulfilled|bypassed|abandoned|contradicted
rigidity: hard|soft|open
visibility: public|spoiler|secret
actuality: plan|guidance|established
sourceRefs[] dependsOn[]
```

集合专有字段以 `src/outline/schema.ts` 为准：arc 有 `beats`；character arc 有 `character/from/toward`；thread 有 `question/nextPressure`；milestone 有 `criteria`；setting 有 `key/value`；foreshadowing 有 `foreshadowingStatus/setup/payoff/evidenceRefs`。

伏笔九状态统一为：

```text
conceived → prepared → planted → reinforced/activated → partially-revealed → resolved
```

`abandoned|invalidated` 是终止出口。终态不可重开，不能从 conceived 直达 resolved，也不能从 resolved 回退。

## 3. 唯一 Proposal 协议

```json
{
  "version": 1,
  "id": "proposal_1",
  "mode": "manual",
  "baseRevision": 0,
  "baseHash": "64 位当前 OutlineState hash",
  "baseLeafId": "当前分支叶 id",
  "kind": "chat|bootstrap|reconcile|foreshadowing",
  "rationale": "变更理由",
  "researchInspirationIds": [],
  "patch": {
    "premise": "可选",
    "currentFocus": [],
    "alignment": {"summary":"","confidence":0.5,"conflicts":[],"updatedFromRefs":[]},
    "addSources": [],
    "collections": [
      {"collection":"threads","upsert":[],"deleteIds":[]}
    ]
  }
}
```

模型输入经 `src/outline/runtime.ts` 严格解析。缺字段、未知字段、未知集合、非法枚举、重复 ID、文本或数组超限整体拒绝；不 cast、不截断、不部分应用。模型 `addSources` 只允许 research。user/narrative/rp-state/world/lore 只能由引擎根据当前分支/context 建立 trusted evidence registry 后注入。

## 4. 证据、风险与状态门禁

- `planted|reinforced|activated|partially-revealed|resolved` 的伏笔必须用 `evidenceRefs` 引用 trusted committed source。
- `actuality=established` 与 `status=fulfilled` 同样必须引用 trusted committed source；research 与旧大纲不能建立事实。
- hard 节点与上个快照比较，禁止 hard→soft/open，也禁止删除，因此不能靠两步降级绕过。
- 普通节点 terminal 不可重开。伏笔只允许 `src/outline/validation.ts` 中明确的前进边。
- 高风险至少包括 premise、删除节点、终态化、建立事实、秘密揭示和 hard 编辑。automatic 永远拒绝；manual 必须由调用者先核对 confirmation，再把匹配当前提案的 `{proposalHash, baseLeafId}` 传给 validation。
- 审计 code 只允许：`revision-conflict|hash-conflict|leaf-conflict|invalid-patch|id-mutation|source-forgery|hard-constraint-deletion|hard-constraint-downgrade|plan-promoted-to-fact|foreshadowing-evidence|invalid-status-transition|confirmation-required|automatic-high-risk`。

## 5. Commit 与恢复

`applyOutlinePatch` 应用全量 patch 后设置 `revision+1`、`parentHash=previous.hash`，再严格 normalize 并验证 hash roundtrip。任何超限或形状漂移都整体拒绝。

分支恢复规则：

- 持久化快照必须显式 `version:1` 且 hash 正确。
- 第一份快照必须 `revision=1`、`parentHash=defaultOutlineState().hash`。
- 后续快照必须与当前分支上一个有效快照线性相接，拒绝任意 revision 锚点。
- 遇到坏快照后，该坏点之后的 `rp-outline` 都不再被认作后代，防止错误跨越断链。

Engine 提交依次 append `rp-outline-proposal(status=approved)` 和 `rp-outline`，随后同一次 `flush()`。底层没有跨两条 append 的事务保证，因此 `approved` 只表示审计批准且声明目标 state，不叫 committed；恢复权威只认通过完整链校验的 `rp-outline`。旧的不安全 `commitOutlineToBranch` 已删除。

## 6. 安全投影

`src/outline/projection.ts` 构造显式 DTO，不 spread 子类型：

- public：只给 public 节点，不给 premise、secret/spoiler、source、payoff。
- writer：只给公开且近期相关的最小方向，不给完整长期节点、secret/spoiler/payoff。
- director：给 public/spoiler 的当前压力、focus 与 hard 约束，不给 secret payoff。
- continuity：只给 established/fulfilled，以及伏笔 planted 以后状态；不含 payoff/source。
- world/ecology：collections 为空，`nonFactGuidance:true`，不得按未来计划预推进。

## 7. 工作流与模型插头

| Skill | workflow | `SideModelStep` |
|---|---|---|
| 故事编剧室 | `outline-chat` | `outlineChat` |
| 动态大纲规划 | `outline-bootstrap` | `outlineBootstrap` |
| 剧情自动校准 | `outline-reconcile` | `outlineReconcile` |
| 伏笔编织 | `outline-foreshadowing` | `outlineForeshadowing`（协议已定义，编排接线可后续补） |
| 叙事研究提炼 | `outline-research` | `outlineResearch` |
| 大纲转移审计 | `outline-audit` | `outlineAudit` |

当前路径是 `src/outline/schema.ts|runtime.ts|state.ts|validation.ts|projection.ts|store.ts|research.ts|engine.ts`。模型通过 `OutlineEngineDeps.runSideModel(step, systemPrompt, userText)` 插入，不在 outline 模块自行选模型。

## 8. API 接线契约

当前已由 `server/main.ts` 将 OutlineEngine 作为 StageEngine 的平级服务接入，并由 `server/rest.ts` 暴露独立 API：

```text
GET  /api/outline
GET  /api/outline/versions
POST /api/outline/chat
POST /api/outline/bootstrap
POST /api/outline/reconcile
POST /api/outline/proposals/:id/confirm  { proposalHash }
POST /api/outline/proposals/:id/reject   { reason? }
GET  /api/outline/research
POST /api/outline/research/refresh
PUT  /api/outline/settings               { mode, researchMode }
```

confirm 必须查当前 pending，严格匹配 `proposalHash`；Engine 再检查 `baseRevision/baseHash/baseLeafId` 与当前分支。不得让 REST 自行 apply patch、cast proposal 或写 `rp-outline`。

拍后自动校准只在成功定稿、账本/世界/生态结算完成后的 `onTurnEnd` 由宿主异步触发；不进入 writer loop、不阻塞正文。`manual` 不触发，`suggest` 生成 pending，`auto` 只提交确定性低风险提案。下一拍导演只读取最近已提交 revision 的安全投影。

研究资料位于 `.liyuan/outline/research/`：`sources.json` 保存 URL 与来源元数据，`mechanisms.json` 保存抽象机制、适用条件和失败警告，`cards/` 保存卡级引用。它与 ecology global/card pool 相邻但不共写：前者服务长线结构、伏笔和受众经验，后者服务局部可运行事件。查询使用脱敏类别词，不发送角色名、卡全文或用户原话。

## 9. 独立前端工作台

`web/src/planning/` 是独立“故事导演”工作台，入口是主输入框右侧的显式「导演室」按钮（也保留在面板菜单与欢迎页），桌面使用宽弹窗并可全屏，移动端全屏。七个页面：综合编剧室、本拍诊断、故事地图、人物弧线、伏笔板、建议箱、版本/研究。主输入框上方是五种讨论模式（综合编剧 / 下一拍 / 下一段对白 / 角色反应 / 节奏诊断）；讨论消息以 `rp-outline-chat` 存入当前分支并随分支恢复。即时回答整理为 `sceneAdvice` 建议卡（推荐下一拍、起手、角色动作、建议聊天对象与切入话题、对白线索、压力、玩家空间、停点、混合路线、备选走法）。讨论结果与 proposal 分离；接受提案时携带 proposal hash，secret 伏笔默认遮挡并需本地明确揭示。

“本拍诊断”通过 `GET /api/turn-diagnostics` 从当前 Session Tree 动态构造只读投影，不持久化第二套状态。它按拍关联 assistant `details` 与后续已提交条目，展示连续性、Stitches 导演、生态 arrival、主演工作流、账本、事实信封、世界 Proposal/Audit/Commit、生态 aftermath、独立谢幕格式和大纲校准；失败、降级、复用、跳过、待确认与提交状态必须明确区分。投影只发送安全结构化字段和用户已可见的 `rpCurtain`，不发送 prompt、生态秘密或隐藏 reasoning。用户参考见 `docs/DIRECTOR-ROOM.md`。

## 10. 失败与非事务事实

- Skill 缐失、模型失败、JSON/schema/audit 解析失败：保留旧 state，fail closed。
- stale base/leaf、证据伪造、非法状态、超限：整体拒绝，不部分提交。
- 两条 append 后一次 flush 不是底层原子事务。崩溃恢复只以有效 `rp-outline` 线性链为准；孤立 approved marker 不是已提交状态。
- pending/approved/rejected 条目也经严格 runtime parser；坏 entry 不进入 pending 视图。

## 11. 与 PLAN-ROUND-FLOW 的距离

当前实现把“计划是假设、实弹优先”扩展到跨拍方向，并用严格 patch、证据注册、确认绑定和消费者裁剪避免长期大纲晋升为事实。它没有改变 `beat_plan → draft_append → 回看重评估 → draft_seal`、StageEngine writer loop、模型路由或世界/生态事实链，因此是在不改演出骨架的前提下更接近目标流程。
