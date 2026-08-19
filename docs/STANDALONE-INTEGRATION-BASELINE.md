# 脱离 Luker 的整合基线

## 当前落点

当前本地部署以 Liyuan 作为独立 Web RP 产品层，并保留其现有 Pi 0.80.3 fork 作为短期稳定运行时。上游 Pi 0.84.1 已独立安装，`@xicode/pi-roleplay` 0.5.0 也已安装用于验证其 Session Tree、审计、审批和状态治理设计，但暂不与 Liyuan 同时拥有同一会话的状态写权限。

短期保持以下权威边界：

```text
Liyuan Session Tree  = 聊天、分支、回复变体和世界线权威
rp-state             = Liyuan 角色账本权威（time/location/characters/inventory/flags/plot_threads）
rp-world-state       = 模块化世界权威（ModularWorldState v2；旧 v1 快照内存迁移为 legacy 模块）
rp-world-manifest    = 当前分支采用的卡级适配版本
rp-world-audit       = 世界转移审计留痕
.liyuan-memory       = Liyuan 检索记忆
StageEngine          = 唯一正文所有者 + 独立谢幕格式轮唯一时机
rp-curtain-override  = 状态栏重 Roll 覆盖工件（只改展示，不改正文/账本/世界）
rp-ecology-state     = 人物生活、地点活动、日程与可错过事件的分支权威
```

禁止同时引入第二个正文 Writer、第二套持久 Session 或第二套 canonical state。

鲜活世界另有两个素材层：`.liyuan/ecology/global-pool.json` 是跨卡通用叙事原型池，
`.liyuan/ecology/cards/<card-key>.json` 是按卡复用的适配池；两者只保存可能性，不是会话事实。
角色卡级世界画像保存在 `.liyuan/world/cards/<card-key>/profile.json`，是跨会话的长期适配。

## 文学工作流 Skill 化（当前形态）

Pi 文学工作流的职责以 **标准 Skill** 接入 Liyuan，代码负责阶段编排与硬安全门禁，Skill 负责
可编辑、可见、可覆盖的提示词。世界引擎以「角色卡世界画像 + 世界推演 + 事实信封 + 世界审计 +
世界模块包」构成完整链路：

| Skill（扩展能力 → Skill） | workflow | 在流程中的角色 |
|---|---|---|
| `文学连续性` | continuity | 复杂场景/长摘要/转场时补充位置、动作、知情边界、未决选择，不重述 rp-state；与生态 arrival 并行 |
| `Sogon角色深度` | character | 周期角色画像：大五人格、OOC 风险、关系动力、状态贴片、推进上限；**后台生成，下一拍生效** |
| `Sigon用户偏好` | persona | 周期用户画像：D.E.S.I.R.E.、WritingStyle、规避区、候选剧情方向；**后台生成，下一拍生效** |
| `Stitches拍前导演` | director | 每拍唯一导演：场景压力、角色主动性、个人线、幕后线、关系上限、玩家停点；硬性单拍边界；同时吸收 arrival 与 continuity 结果 |
| `主演分段演出` | writer | 主演拍前注入：beat_plan 短路标 + draft_append 分段演出 + draft_seal |
| `独立谢幕格式` | curtain | 正文封笔、记账后，agent 重新读取完整卡/预设/冻结正文/最终状态，自主生成该卡要求的全部非正文格式 |
| `角色卡世界画像` | world-profile | 从卡、选中开场、世界书、预设与近期实弹生成卡级长期适配；**后台分析，下一拍播种** |
| `世界推演`（用户 Skill） | world | 模块化世界转移提案；规则唯一权威在 `.liyuan-stage-skills/世界推演/`，gitignore |
| `拍后事实信封` | world-facts | 从用户原话、冻结正文、最终账本提取带证据事实、信息边界与经过时间 |
| `世界转移审计` | world-audit | 独立检查因果、信息边界、时间尺度、模块权限与用户主权；只能批准或拒绝 |
| `世界模块-制度日历` 等 | world-module: institution 等 | 各领域演化规则，按本拍到期模块动态装载 |
| `通用叙事原型池` | ecology-global | 联网搜索规划（≤12 查询）+ 吸收搜索结果为跨卡原型；**后台备料，供后续拍消费** |
| `角色卡生态池` | ecology-card | 把全局原型适配为当前作品的世界语法、人物行动语法与模板 |
| `人物与场所生态` | ecology-runtime | arrival（拍前匹配可见世界）与 aftermath（拍后推进人物/场所/事件/秘密） |

内置 Skill 位于 `skills/`，跟随 GitHub 更新；面板编辑过的副本落在 `.liyuan-stage-skills/`（gitignore），
不会被 `git pull` 覆盖，删除副本即回内置。世界模块包按 `world-module` frontmatter 装载。

## 权威边界细节

- **正文**：StageEngine 稿纸是唯一入口，`draft_append/draft_write/draft_seal`。硬门禁：正文夹带图片/日历/选项/HTML 等格式块、以及跨到放学/夜晚/次日等跨场景内容会被拒收，格式必须留在独立谢幕轮。
- **格式**：不使用输出合约、白名单或固定标签识别。封笔、记账后同一 agent 进入独立谢幕轮，读取完整角色卡原始 JSON、完整启用预设、本拍求值 postHistory、冻结正文和最终投影世界状态，自行判断并生成该卡要求的全部格式。
- **工件分离**：落树时正文（`rpNarrative`）与格式（`rpCurtain`）分别持久化在 details 中；用户看到两者拼接，但下一拍 `rebuildHistory` 只回读 `rpNarrative`，任意格式不会污染剧情历史。
- **旁路模型**：连续性、Sogon、Sigon、导演、世界画像、事实信封、世界推演、世界审计、生态各步有独立模型插头（`literaryContinuity` / `literaryCharacter` / `literaryPersona` / `literaryDirector` / `worldProfile` / `literaryWorldFacts` / `literaryWorld` / `literaryWorldAudit` / `ecologySearch` / `ecologyGlobal` / `ecologyCard` / `ecologyRuntime`），默认继承剧情总插头，前端可分别覆盖。
- **请求重试**：主演与所有旁路调用在 provider 层自动重试，初次请求之外最多 **9 次**，遵循退避与 `Retry-After`；用户取消经 abort signal 立即停止。中断或耗尽重试后，若已有正文会按未完成回复落树，不继续记账/世界/生态。（引入：8/19 真实流程测试确认远端 429/断流后，由原 0 重试改为 9。）
- **卡级世界画像**：`.liyuan/world/cards/<card-key>/profile.json`，内容身份哈希；保存标签/尺度/时间步长/活跃度/模块(kind、skillPack、mode、cadence、confidence)/用户长期要求/实弹优化记录/待确认问题/stable 状态。draft 每 8 拍复盘，stable 停止自动重建；userRequirements 并集保留不可被模型删除。
- **分支 Manifest**：`rp-world-manifest` 保存当前分支采用的画像版本；同一卡不同开场/世界书/预设由 `playKey` 区分玩法槽；回档后不被卡级最新画像静默覆盖。
- **模块化世界**：`rp-world-state` 为 `ModularWorldState v2`（kernel + 按卡建立的模块）；旧 v1 快照内存迁移为 legacy 模块；`LiteraryWorldState v1` 保留为兼容投影。
- **世界转移**：事实信封 → 模块提案 → 独立审计 → TS 门禁 → 原子 commit；`rp-world-audit` 留痕；fail closed（任一失败保留上一快照，不自动重试）。
- **后台世界**：主演只收到裁剪注入【后台世界动态】；黑盒与 secret 记录只对主演与前端露「存在未公开信息」的边界。规则唯一权威在 `workflow: world` Skill——内置回退在 `skills/世界推演/`，用户覆盖在 `.liyuan-stage-skills/世界推演/`，缺 Skill 时整条世界链人会表现为不运行（8/19 实测后已内置回退）。开关 `literaryWorldEnabled` 默认关。
- **鲜活世界生态**：三层权威；双池更新为 running/ready 后台备料，当前正文不等，成熟候选在后续拍原子合并；所有池写入走串行写链并写前重读。arrival 与连续性并行；世界与 aftermath 并行计算、顺序落树；aftermath 失败落 `degraded` 快照。开关 `literaryEcologyEnabled` 默认关。详见 `docs/PLAN-LIVING-ECOLOGY.md`。
- **两级重 Roll**：重Roll正文复用 `details.rpPrep` 从 writer 重写、下游记账/世界/状态栏重跑；重Roll状态栏只重做 `rpCurtain`，写 `rp-curtain-override` 覆盖工件，不碰正文/账本/世界，残缺结果拒绝覆盖且不自动重试。
- **中断/错误降级**：取消时，已由 `draft_append/draft_write` 正式接收的稿段，加上仍在工具参数流中、已实际送显但尚未受理的当前半截，都按 `stopReason=aborted` 的未完成回复落树；`finalTimeline` 保留全部已接收稿段并把半截作独立末段。被 `stream:clear` 标记的计划旁白不会复活。中断或后续 provider 报错（如 429）时已写前段同样保留，且不记账、不推进世界/生态、不落媒体交付。（引入：8/19 实际取消后半截丢失，由 `#draftForwarder.pendingText()` 修复。）
- **关键路径分级**：Sogon/Sigon 画像、卡级世界画像、生态双池备料全部移出正文关键路径（后台生成、下一拍生效）；writer 固定捕获 user 叶，生成期间切分支整份丢弃；排队输入绑定提交时会话/卡；生态池写入串行化。
- **联网检索**：DuckDuckGo 人机验证熔断 30 分钟后自动走 Bing；旁路流式失败自动做一次非流式降级。配置 `LIYUAN_WEB_RESEARCH_PROXY`（默认 127.0.0.1:7890）与可选 `LIYUAN_WEB_RESEARCH_URL`。

## 配置

```json
{
  "literaryQuality": "off" | "profile" | "guided",
  "literaryProfileEveryNTurns": 8,
  "webResearchMode": "off" | "auto" | "manual",
  "literaryWorldEnabled": false,
  "literaryEcologyEnabled": false,
  "stepModels": { "worldProfile": {provider,id}, "literaryWorldFacts": …, "literaryWorld": …, "literaryWorldAudit": …, "ecologySearch": …, "ecologyGlobal": …, "ecologyCard": …, "ecologyRuntime": … }
}
```

- `guided`：连续性（条件触发）+ Sogon/Sigon（周期，后台）+ 每拍拍前导演 + 独立谢幕格式轮。
- `profile`：只做周期画像，不跑每拍导演。
- `off`：不增加任何旁路调用。
- 独立谢幕格式轮是引擎不变量，只要有正文就触发，与 `literaryQuality` 无关。
- 后台世界引擎由独立开关 `literaryWorldEnabled` 控制（默认关），与 `literaryQuality` 无关。
- 鲜活世界生态由独立开关 `literaryEcologyEnabled` 控制（默认关）；生态四步插头可分别指定模型。
- 世界画像/事实/审计插头未配置时继承剧情总插头。

## REST 与数据管理

- `GET /api/world-profile`：当前卡画像与素材变化状态。
- `POST /api/world-profile/analyze`：主动重新分析当前卡（分支/卡漂移时结果丢弃）。
- `PUT /api/world-profile`：保存稳定状态、后台活跃度、模块状态、长期要求与优化笔记。
- `GET /api/world-state`：当前 v2 状态、模块视图、v1 投影、Manifest、审计投影。
- `DELETE /api/world-state/module?moduleId=…`：清空某模块当前分支运行态（拒绝 streaming）。
- 数据目录：`.liyuan/world/cards/<key>/profile.json`、`.liyuan/ecology/`、`.liyuan-state/` 等均为纯 JSON/文件。

## 暂不整合的阶段

- Research Planner 固定阶段：由 `web_research` 按需工具替代，不照搬每轮至少三搜。
- Pi Writer：不能与 StageEngine 争夺 canonical narrative；分段演出 Skill 只是注入指导，正文仍由主演 agent 分段落笔。
- Style Revision 全文重写：保留 `draft_edit` 定点修改能力，不做默认的全文审修重写。
- Pi 的 Format Continuation / 冻结槽位：不采用。梨园利用 agent 分轮重新思考，正文与格式天然分轮，无需服务端冻结插槽。

## 上游 Pi 迁移

Liyuan 当前 fork 不能直接替换为 Pi 0.84.1，主要阻断是：

- `.liyuan/extensions` 不会被上游默认的 `.pi` 资源发现加载。
- 旧 `ModelRegistry/AuthStorage` 已变为异步 `ModelRuntime`。
- 服务端直接依赖 `session.agent.state` 和 SessionManager 内部操作。
- Jiti 扩展仍引用 `@liyuan/*` 虚拟模块。

迁移顺序固定为：

1. 在 Liyuan 内建立 runtime、model gateway、session tree 三个适配层，短期仍调用 fork。
2. 把 `roleplay.ts` 改为显式 extension factory，不依赖 `.liyuan` 自动发现。
3. 用 `ModelRuntime` gateway 替代所有 `modelRegistry/authStorage` 访问。
4. 用会话 facade 集中 branch、append、rebuild 和 flush。
5. 在同一套测试下双跑 fork 与上游 0.84.1。
6. 上游稳定后删除 `packages/ai`、`packages/agent`、`packages/coding-agent` 和 `packages/tui`。

迁移期间每个进程只能选择一套完整 Pi 底座，禁止跨版本混用 Model、SessionManager、AgentSession 或 TypeBox schema。

## pi-roleplay 的定位

`pi-roleplay` 的优势是 evidence-backed Commit、Checkpoint、Audit、Review 和 Session Tree 一致性。长期有两种合法方向：

1. Liyuan 保留产品层和领域能力，但把状态治理迁到 `pi-roleplay`，届时必须停止写 `rp-state` 作为第二权威。
2. 保留 Liyuan 状态治理，只借鉴 `pi-roleplay` 的证据校验、风险审批和 checkpoint 设计，不同时运行其 finalize 状态链。

在状态迁移器完成前采用第二种方向，避免双状态。世界引擎已借鉴该方向的证据校验与审计语义
（事实信封 → Proposal → Audit → Commit），但不引入第二套 canonical state。

## 后续优先级

1. 将「正文完成」与「后台结算完成」拆成两个 UI 状态，让输入框在正文后立即可用（需 pending commit 与拍间依赖）。
2. 为 `web_research` 增加逐角色 Canon 来源元数据，替代当前卡级公开出处判断。
3. 用多张格式差异明显的角色卡各跑一轮实弹，验证 `rpCurtain` 对状态栏/日历/选项/图片/程序卡格式的无损表现。
4. 建立上游 Pi 兼容层并开始双底座 conformance 测试。

## 验收基线

- `npm test`：领域层通过。
- `npm --prefix web run typecheck`：通过。
- `npm --prefix web run build`：通过。
- `node scripts/smoke-web.mjs`：无 LLM 冒烟通过。
- Liyuan 使用独立 `LIYUAN_CODING_AGENT_DIR`，不与全局 Pi 会话目录共用。
- 文学画像默认关闭，关闭时不增加任何模型调用和注入；独立谢幕格式轮不受该开关影响。
- 世界引擎默认关闭（`literaryWorldEnabled: false`），开启后按卡画像/Manifest 运行模块化世界。
