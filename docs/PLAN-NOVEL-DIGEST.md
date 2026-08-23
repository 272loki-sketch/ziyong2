# PLAN-NOVEL-DIGEST：小说长文消化与研究库扩容

> 2026-08-23 定稿设计。定位：**导演室研究系统的扩容**——研究材料从「搜索结果摘要」升级为
> 「作品本体全文」，让大纲系统能基于真实小说文本总结剧情结构、人物弧线与叙事套路。
> 本文是实施唯一依据：新会话按本文动手，遇与现状冲突处以本文为准并回报。

---

## 实现状态（2026-08-23 实弹落地）

**阶段 1（上传 → 后台消化 → 梗概+套路 → 入研究库 → 导演室页签）已实现并在 VPS 实弹验证。**

落地提交：`51a47d9`（管道/研究库/投影/插头）→ `e60a50e`（REST+接线）→ `5f158a1`（前端页签）→
`ae63040`/`14ee496`（失败路径清理 + 诊断日志）。全部在 `local` 分支，工作区干净。

实弹验收（564KB / 40 章 / ~20 万字 txt）：分章 40 → 分块 10 → map≈10 块 → reduce-arc →
reduce-final → extract **13 条套路**入 `mechanisms.json` 且 sourceIds=`doc-*`、关联当前卡；
删除精确清理 `removedMechanisms=13`、磁盘/文档/机制归零。详见 §15 勾选。

阶段 1 只实现「上传」入口；**URL 抓取（§12 阶段 2）未做**，schema 已留（`sourceKind:"url"`、
`CorpusEngineDeps` 可直接复用、REST 未暴露该端点）。未做事项细节见 §17。

## 0. 一句话与原则

**给导演室加一条「上传小说 → 后台消化 → 剧情梗概 + 套路库」的管道；产物进现有研究库
（OutlineResearchStore 的扩容），注入现有 researchWorkspace；全程后台，不进正文关键路径。**

三条铁律的映射：

1. **状态进分支树/研究库，不新增第二套权威**：消化产物（文档/梗概/套路）全部落在
   `.liyuan/outline/research/` 下，与现有 sources/mechanisms 同仓同语义；不新建平行知识库。
2. **规则进 Skill**：map/reduce/extract 三步的提示词全部写在新 Skill `skills/小说消化/`
   （`workflow: novel-digest`），TS 只做编排、分块与校验，不写提示词正文。
3. **TS 只做编排与安全门禁**：章节切分、编码检测、预算闸门、断点续跑、JSON 校验全在 TS；
   模型只负责读块写摘要、读梗概出套路。

非目标（明确不做）：

- 不做台上（stage）工具，不给剧情模型直接读全文——第一版只在导演室（planning）侧。
- 不改 StageEngine / 一拍流程，`PLAN-ROUND-FLOW.md` 的流程零改动。
- 不内置任何盗版站点；阶段 2 的 URL 抓取是通用「给 URL 就抓」，不点名站点。
- 不做 epub 在线书城搜索；来源=用户上传（阶段 1）或用户给的目录页 URL（阶段 2）。

## 1. 现状与差距（为什么做）

现状（`src/outline/engine.ts` `research()` + `server/web-research.ts`）：

- 只搜不读：DuckDuckGo/Bing 返回的 `title+url+snippet`，snippet 截 600 字喂提炼模型，
  搜到的页面正文从未被打开。
- `skills/叙事研究提炼/` 的输入就是书评/影评摘要（二手解读），给不出桥段结构、
  钩子节奏、多卷伏笔铺法这类「只存在于正文里」的东西。
- 研究库 schema（`sources.json`/`mechanisms.json`）只认 URL 型来源。

本设计补的缺口：长文本获取（上传）→ 清洗分块 → 分层摘要（map-reduce）→
结构化提炼（剧情链/人物弧/桥段套路/钩子节奏/失败模式）→ 入库 → 注入大纲上下文。

## 2. 总体流程

```text
导演室「小说研究」页签
  ├─ 上传 txt/epub（走现有 POST /api/uploads → .liyuan-uploads/）
  ├─ POST /api/outline/corpus { file: "xxx.txt" }  → 建文档、入队、立即返回
  ▼
后台消化管道（CorpusEngine，串行任务链，服务重启可续）
  1) 取件：从 .liyuan-uploads 复制到 corpus 工作区（uploads 原件不动）
  2) 解码：utf-8 严格失败 → gbk/gb18030 → big5（TextDecoder，Node 22 全 ICU）
  3) 清洗：去站点水印/广告行；epub 走 ziplite 解压 → container.xml → opf spine → 拼接
  4) 分章：章节标题正则切分；无标题结构则按段落边界定长切块
  5) 分块：块 = 1~3 章，≤ CHUNK_CHARS(默认 20000)；超长章在段落边界硬切
  6) map：逐块调模型（novelDigest 插头）出「块摘要」——每块完成即落盘（断点续跑点）
  7) reduce：块摘要 → 每卷/每 50 块「弧线摘要」 → 全书梗概 + 结构化字段
  8) extract：从弧线摘要+梗概出「套路条目」（mechanism/appliesWhen/failureWarning）
  9) 入库：merge 进研究库（documents + digests + mechanisms，关联当前卡）
  ▼
导演室轮询 GET /api/outline/corpus（5 秒，同诊断页模式）看进度
完成后：大纲模型下一拍经 researchWorkspace 读到「可用小说资产」
```

## 3. 数据模型

全部落在现有研究库根 `.liyuan/outline/research/` 下（`OutlineResearchStore` 扩容，
不另起炉灶）：

```text
.liyuan/outline/research/
├── sources.json            # 现有：URL 型来源（不动）
├── mechanisms.json         # 现有：套路/机制条目（扩：sourceIds 可引用 doc-*）
├── cards/<key>.json        # 现有：卡 → mechanismIds 关联（不动，复用）
└── corpus/                 # ★ 新增
    ├── documents.json      # 文档清单（含任务状态）
    ├── texts/<docId>.txt   # 清洗后的全文（唯一正文副本）
    └── digests/<docId>.json # 消化产物 + 进度
```

TS 接口（写在 `src/outline/corpus.ts`）：

```ts
export type CorpusDocStatus = "pending" | "cleaning" | "mapping" | "reducing"
  | "extracting" | "ready" | "failed" | "paused";

export interface CorpusDocument {
  id: string;               // doc-<sha256(originName+size).slice(0,16)>
  title: string;            // 文件名去扩展名，≤120 字
  sourceKind: "upload" | "url";
  originName: string;       // uploads 文件名或目录页 URL
  chars: number;            // 清洗后总字数
  encoding: string;         // "utf-8" | "gb18030" | ...
  chapterCount: number;
  chunkCount: number;
  status: CorpusDocStatus;
  error?: string;           // failed 原因
  createdAt: string; updatedAt: string;
}

export interface CorpusChunkDigest {
  index: number;            // 0-based
  chars: number;
  chapters: string[];       // 覆盖的章节标题（≤30 字/个）
  summary: string;          // 块摘要，≤1500 字
}

export interface CorpusArcDigest {
  title: string;            // 卷名或"第 N 段（块 a–b）"
  chunkRange: [number, number];
  summary: string;          // 弧线摘要，≤2000 字
}

export interface CorpusDigest {
  version: 1;
  docId: string;
  chunks: CorpusChunkDigest[];   // map 产物，逐块追加落盘
  arcs: CorpusArcDigest[];       // reduce 第一层
  synopsis: string;              // 全书梗概，≤3000 字
  structure: {                   // reduce 结构化字段（各 ≤2000 字）
    plotSpine: string;           // 主线事件链（因果链不是流水账）
    characterArcs: string;       // 主要人物弧线与关系演变
    hooksAndPacing: string;      // 卡章钩子/爽点节奏/张弛观察
  };
  extractedCount: number;        // extract 出的套路条数
  updatedAt: string;
}
```

研究库扩展（改 `src/outline/research.ts`）：

- `OutlineResearchView` 增加 `documents: CorpusDocument[]`（只读投影，含 status）。
- `merge` 保持签名不变；新增 `mergeCorpus(cardKey, document, digest, extracted)`：
  把套路条目写进 `mechanisms.json`（sourceIds 引用 `doc-xxx`，id 规则
  `mech-<sha256(mechanism+docId)>`），文档进 `documents.json`，并像现有 merge 一样
  把 mechanismIds 累进 `cards/<key>.json`（上限 100 不变）。
- 新增 `removeCorpus(docId)`：删 texts/digests/documents 行，并删除**只**被该文档
  引用的 mechanisms（被 Web 来源共同支撑的条目保留）。
- `view(cardKey?)`：无 cardKey 时 documents 全量返回；有 cardKey 时返回与该卡关联的
  （cards 条目里 mechanismIds 反查 doc-* 来源）。

## 4. 文本获取与清洗（阶段 1 = 上传）

### 4.1 入口与取件

- 前端复用现有上传通道（`POST /api/uploads`，原始字节 + 文件名走 query，
  见 `server/rest.ts` 1115 行附近；落 `.liyuan-uploads/`）。
- `POST /api/outline/corpus { file: "<uploads 文件名>" }`：
  - 校验文件存在、扩展名 `.txt`/`.epub`、大小 ≤ 50MB；
  - **复制**（非移动）到 `corpus/work/<docId>.raw`，uploads 原件不动；
  - 建 `CorpusDocument{status:"pending"}` 写入 documents.json，唤醒管道，立即返回 docId。
- 同一文件重复提交：按 originName+size 哈希幂等，返回已有 docId（不重复消化）。

### 4.2 解码

```ts
function decodeText(bytes: Buffer): { text: string; encoding: string } {
  for (const enc of ["utf-8", "gb18030", "big5"]) {
    try { return { text: new TextDecoder(enc, { fatal: true }).decode(bytes), encoding: enc }; }
    catch { /* 下一种 */ }
  }
  return { text: new TextDecoder("utf-8").decode(bytes), encoding: "utf-8(lossy)" };
}
```

utf-8 严格模式在前（合法 utf-8 必然成功，GBK 大概率含非法序列被排除）；
三者都失败退化为替换符解码（记 encoding 备查）。

### 4.3 清洗规则（TS 确定性，逐行过滤）

删除命中以下模式的**整行**（对清洗后文本做，逐行正则，大小写不敏感）：

- 站点水印：`本书首发|首发域名|笔趣|leshu|feiku|最新章节|请记住|无弹窗|广告|域名一|域名二`
- 站内导航：`上一章|下一章|返回目录|目录 页|加入书签|书页|章节错误|点此举报|报错`
- 空洞行：去首尾空白后长度 0 的连续行压成单个换行。
- 不做激进去重（防误删重复对白），不做同义改写。

### 4.4 epub 解析（复用 `src/ziplite.ts`，零新依赖）

`extractZipFile` 到临时目录 → 读 `META-INF/container.xml` 拿 opf 路径 → 解析 opf
的 `<manifest>` + `<spine>` 得到 xhtml 顺序 → 逐文件 `<h1-h6>` 转章节标题、正文剥标签、
`<p>` 转段落 → 拼成与 txt 相同结构的纯文本 → 走同一条分章/分块管道。

### 4.5 分章

```ts
const CHAPTER_RE = /^\s*(?:第\s*[0-9〇零一二三四五六七八九十百千两]+\s*[章节卷回部集话話幕]|(?:序章|序言|楔子|尾声|后记|番外))\s*[:：\s\S]{0,40}$/;
```

- 逐行扫描命中即切章；标题行保留为章节名。
- 全文命中 < 5 处视为「无章节结构」：跳过分章，直接定长切块。
- 章节名为空时用 `第 N 节` 占位。

### 4.6 分块

- 目标块 ≤ `CHUNK_CHARS`（默认 20000，配置可调，硬上限 50000）。
- 贪心装箱：从当前章开始累加整章；加下一章会超限则封块；单章超限则在**段落边界**
  （`\n\n`）二分硬切，切出的块标记同章节名。
- 块数上限 `MAX_CHUNKS = 600`（≈1200 万字封顶，超出直接 failed：`文档过大`）。

## 5. 消化管道（CorpusEngine）

新文件 `src/outline/corpus.ts`，模式照抄研究库的串行写链 + 生态双池的 running/ready 语义：

```ts
export interface CorpusEngineDeps {
  cwd: string;
  runSideModel: OutlineEngineDeps["runSideModel"];  // 同一签名，step 用 "novelDigest"
  loadSkill: () => string | undefined;              // workflowSkill(skills, "novel-digest")?.body
  cardKey: () => string;                            // getContext()?.cardKey ?? config.card
}

export class CorpusEngine {
  enqueue(doc: CorpusDocument): void;               // 唤醒串行链
  status(): { running?: { docId: string; step: string; done: number; total: number } };
  pause(docId: string): void;                       // 当前块完成后停
  resume(docId: string): void;                      // 重扫 digests 续跑
  retry(docId: string): void;                       // failed → pending，保留已完成块
  remove(docId: string): Promise<void>;
}
```

要点：

1. **串行单飞**：同一时刻只消化一个文档（`#chain = #chain.then(...)` 同研究库写链）。
   文档内 map 逐块串行——flash 级模型不需要并发，串行最好控预算和断点。
2. **断点续跑**：每块 map 完成**立即**把 `CorpusChunkDigest` 追加写进
   `digests/<docId>.json`（原子写，tmp+rename 同现有 `#atomic`）。`resume`/`retry`
   重扫已有 chunk.index，跳过已完成块。服务重启后 `enqueue` 恢复时同样跳过。
3. **每步的模型调用**（step 一律 `"novelDigest"`）：
   - map：`runSideModel("novelDigest", skill, JSON({task:"digest-map", ...块内容}), { maxTokens: 4096 })`
   - reduce-arc：输入为该弧线的块摘要串（不再进原文），`maxTokens: 4096`
   - reduce-final：全部弧线摘要 → synopsis + structure，`maxTokens: 8192`
   - extract：arcs + synopsis + structure → 套路条目数组，`maxTokens: 8192`
4. **JSON 校验与降级**：沿用 `parseObject` 的严格校验（`src/outline/` 内已有）；
   map 输出非法 → 该块重试 1 次，仍非法 → 该块 summary 记
   `"(本块摘要生成失败，仅保留章节列表)"`，不中断整书；reduce/extract 失败 → 任务
   `failed` 留 error，已完成块保留，可 retry。
5. **预算闸门（TS 硬门禁）**：
   - 建 doc 时预估调用数 = chunkCount + ceil(chunkCount/50) + 2，随 `POST corpus`
   响应返回 `estimatedCalls`，前端确认框显示（「约 N 次旁路模型调用」）；
   - `novelDigest.maxCallsPerDoc` 默认 800，超预估算直接拒绝建档；
   - 每次调用前查 `paused/aborted`。
6. **进度对外**：`GET /api/outline/corpus` 返回 documents + running 的
   `{step, done, total}`；不做 WS 推送，前端 5 秒轮询（同诊断页）。

## 6. Skill：`skills/小说消化/SKILL.md`

frontmatter（对齐 `叙事研究提炼` 的格式）：

```yaml
---
name: 小说消化
description: 分块摘要小说文本并提炼剧情结构、人物弧线与叙事套路，不复刻原文。
workflow: novel-digest
resident: false
每轮: false
---
```

正文为一个系统提示词管三个 task（task 字段在 user JSON 里区分，同 `故事编剧室`
一 Skill 多 task 的先例）。**提示词全文如下，落地时可微调措辞但结构不变**：

```markdown
# 小说消化

你只负责消化研究材料，不为当前故事写剧情。输入是脱敏后的小说文本或其摘要层，
按 task 分工。所有输出只返回 JSON，不输出 Markdown 或 JSON 外文字。

## task: digest-map
输入：{ task, doc_title, chunk: { index, chapters, text } }
写出这一块的剧情摘要，≤1500 字。必须包含：
- 事件链：这块发生了什么（因果顺序，不是流水账）
- 人物动态：谁出场、动机与关系变化
- 悬置物：新抛出的悬念/伏笔/未回收的承诺（原样列出）
- 钩子：块末如何收（卡在哪、凭什么让读者往下翻）
禁止：评论文学质量；引用原文连续超过 40 字。
返回：{ "summary": string, "chapters": string[] }

## task: digest-reduce-arc
输入：{ task, doc_title, arc_title, chunk_summaries: string[] }
把这组块摘要归并成弧线摘要，≤2000 字：这段的主线推进、关键转折点（块定位）、
人物弧线走向、已回收/仍悬置的伏笔清单。返回：{ "summary": string }

## task: digest-reduce-final
输入：{ task, doc_title, arc_summaries: string[] }
产出全书级结论。返回：
{
  "synopsis": string,          // 全书梗概 ≤3000 字（按因果链写）
  "structure": {
    "plotSpine": string,       // 主线事件链：起爆点→升级→转折→高潮→收束
    "characterArcs": string,   // 主要人物弧线与关系演变阶段
    "hooksAndPacing": string   // 卡章钩子手法、爽点/松弛节奏规律
  }
}

## task: digest-extract
输入：{ task, doc_title, synopsis, structure, arc_summaries }
提炼**可复用的叙事套路**，不是复述剧情。每条必须：
- mechanism：去掉作品专名后的可复用手法（桥段结构/信息分配/节奏手段/关系推进方式）
- appliesWhen：适用的人物动机、关系阶段、压力与前置条件
- failureWarning：这套手法用滥/用错会怎么翻车（OOC、拖节奏、伏笔崩）
- sourceIds：固定填输入里的 docId（形如 ["doc-..."]），locator 用"第X–Y章"
禁止：输出原作专名、台词、标志性场景序列、完整反转、可识别的换皮方案；
不能从输入确认的内容不要编造。最多 40 条，材料不足返回空数组。
返回：{ "tropes": [{ "mechanism": string, "appliesWhen": string,
  "failureWarning": string, "locator": string }] }
```

extract 产物在 TS 侧转成 `OutlineResearchExtraction`（locator 并入 mechanism 末尾
`（出处：第X–Y章）`），走 `mergeCorpus` 入 mechanisms.json。

## 7. 研究工作区投影（注入与 token 预算）

`OutlineEngine.#modelContext` 现有 `researchWorkspace: this.#research.view(cardKey)`。
扩容后 view 多了 documents/digests，**不能整包注入**，做安全投影（`src/outline/projection.ts`
加一个纯函数 `projectCorpusWorkspace(view, { maxDocs: 3 })`）：

```ts
// 注入大纲模型的东西（严控体积）：
{ documents: [{ title, chars, synopsis: 前400字, tropeCount }],
  mechanisms: [...] }   // 现有机制条目照旧（含 corpus 来的，全局共享）
```

- 只注入 `status === "ready"` 且与当前卡关联的文档，按关联时间倒序取前 3。
- 块摘要/弧线摘要**不进**大纲上下文——它们只在导演室 UI 展示与 extract 输入。
- 讨论中模型若要细节：导演室前端可把某文档 synopsis 全文「钉进」下次 chat 的
  context（复用现有 `POST /api/outline/chat` 的 focus/上下文通道，阶段 1 可不做）。

## 8. REST API 契约（加在 `server/rest.ts` outline 区块后）

| Method & Path | Body | Resp | 错误 |
|---|---|---|---|
| `POST /api/outline/corpus` | `{ file: string }`（uploads 文件名） | `201 { doc, estimatedCalls }` | 400 文件不存在/类型不符/超 50MB/超块数上限；409 已在消化 |
| `GET /api/outline/corpus` | — | `{ documents, running? }` | — |
| `GET /api/outline/corpus/:id` | — | `{ doc, digest }`（ready 才含 digest 全文） | 404 |
| `POST /api/outline/corpus/:id/pause` | — | `200 { doc }` | 404/409（非运行态） |
| `POST /api/outline/corpus/:id/resume` | — | `200 { doc }`（幂等：pending/failed 也走这里续跑） | 404 |
| `DELETE /api/outline/corpus/:id` | — | `200 { ok: true, removedMechanisms: n }` | 404 |

- 全部走现有 `/api` 全局鉴权（access password 生效时）。
- 路由风格照抄 outline 区块（`case "GET /api/outline/corpus"` + 正则取 `:id`）。

## 9. 前端：导演室「小说研究」页签

`web/src/planning/` 内改三处：

1. `client.ts`：加 `corpusList/corpusCreate/corpusGet/corpusPause/corpusResume/corpusDelete`
   六个 fetch 封装（照现有 outline 函数风格）。
2. `types.ts`：`CorpusDocument/CorpusDigest` 与后端接口对齐（可从后端 import 类型或复制）。
3. `StoryPlanningWorkbench.tsx`：新增页签「小说研究」：

```text
┌─ 文档列表 ────────────────────────────────────┐
│ [上传 txt/epub]（复用现有上传逻辑，选完即 POST corpus）│
│ ┌──────────────────────────────────────────┐ │
│ │ 书名.txt   ready   2,340,000字 · 128块      │ │
│ │   [梗概▾] [删除]                            │ │
│ │ 《另一本》  mapping 45/130  ▓▓▓▓░░ [暂停]    │ │
│ └──────────────────────────────────────────┘ │
└──────────────────────────────────────────────┘
展开 ready 文档：synopsis / structure 三字段 / 弧线摘要折叠列表 / 套路条目表
（mechanism·appliesWhen·failureWarning·locator，样式复用研究库条目卡）
```

- 进度轮询 5 秒（进页签才开，离开即停，照诊断页模式）。
- `POST corpus` 返回 estimatedCalls > 200 时弹确认（「约 N 次旁路调用，继续？」）。
- 消化完成时页签角标 +1（不弹窗打扰）。

## 10. 配置与模型插头

- `src/model-routing.ts`：`SIDE_MODEL_STEPS` 数组加 `"novelDigest"`（加在
  `"outlineResearch"` 之后）。`normalizeStepModels` 自动支持覆盖；**回退顺序**：
  `novelDigest` 覆盖 → `outlineResearch` 覆盖 → 总插头。在解析覆盖的 fallback 处
  加一行即可（现有代码按步骤直查，需补这条链式回退）。
- 设置面板若按 SIDE_MODEL_STEPS 枚举插头，同步加标签「小说消化」（查
  `ModelPlugSelector.tsx`/`SettingsPanel.tsx` 的步骤名→中文映射，有映射表就补一行）。
- `liyuan.config.json` 新增（example 同步）：

```json
"novelDigest": { "enabled": true, "chunkChars": 20000, "maxCallsPerDoc": 800 }
```

  `enabled: false` 时 REST 返回 403、前端页签显示「未启用」。默认 true（纯手动
  触发，无后台自动成本，与 literaryWorldEnabled 默认关的场景不同）。

## 11. 安全、版权与预算护栏

- **全文不出服务器**：`corpus/texts/` 只被 map 步读块；不进任何 web 请求、不进
  大纲上下文（只有投影后的 synopsis 摘要进）、不进台上 stage。
- **防复刻**：Skill 三处硬禁令（连续引用 ≤40 字 / extract 禁专名 / 禁换皮方案），
  与 `叙事研究提炼` 同一护栏级别。
- **版权边界**：文档由用户主动上传至自己服务器用于个人研究，产品不提供任何内容源、
  不内置站点；README/页签加一句「请仅上传你有权使用的文本」。
- **预算**：建档前预估调用数确认 + maxCallsPerDoc 硬顶 + 串行执行（最坏情况也只是
  慢，不会并发烧钱）；pause 粒度=当前块完成。
- **磁盘**：50MB/文档 × 上限默认 20 文档（documents.json 超限时 POST 拒绝），
  删除即级联清磁盘。

## 12. 阶段 2：URL 抓取（本阶段只留接口，不实现）

- `server/web-research.ts` 导出 `requestText`（现为模块私有，加 export 即可）。
- `POST /api/outline/corpus/url { tocUrl }`：抓目录页 → 启发式取「同域最大同构链接组」
  为章节列表（≥5 条才算）→ 逐章抓取（间隔 ≥2s，复用代理与超时）→ 边抓边落
  `texts/<docId>.part` → 全部完成后走同一条清洗/分块/消化管道。
- 护栏：章节数 ≤3000；私人角色名不得出现在 URL（复用 `sanitizeWebResearchQuery`
  的脱敏思路）；抓取失败章节记占位 `(抓取失败)`，不中断。
- `CorpusDocument.sourceKind: "url"`、originName 记目录页 URL——schema 阶段 1 已留好。

## 13. 落地文件清单（逐文件）

| 文件 | 动作 | 内容 |
|---|---|---|
| `src/model-routing.ts` | 改 | SIDE_MODEL_STEPS + novelDigest；覆盖回退链 |
| `skills/小说消化/SKILL.md` | 新建 | §6 全文 |
| `src/outline/corpus.ts` | 新建 | 解码/清洗/分章/分块（纯函数，导出可测）+ CorpusEngine（§5） |
| `src/outline/research.ts` | 改 | documents 投影、mergeCorpus、removeCorpus、view 扩展（§3） |
| `src/outline/projection.ts` | 改 | projectCorpusWorkspace（§7） |
| `src/outline/engine.ts` | 改 | #modelContext 的 researchWorkspace 换投影函数（约 3 行） |
| `server/main.ts` | 改 | 实例化 CorpusEngine 挂到 host（cwd/runSideModel/skill/cardKey），启动时恢复未完成任务 |
| `server/rest.ts` | 改 | §8 六个端点（照 outline 区块风格） |
| `src/uploads.ts` | 不动 | 复用 |
| `web/src/planning/client.ts` / `types.ts` / `StoryPlanningWorkbench.tsx` | 改 | §9 |
| `web/src/components/ModelPlugSelector.tsx` 或 SettingsPanel | 改 | 插头标签（如有映射表） |
| `liyuan.config.example.json`（及配置默认值处，查 `src/agent-config.ts`） | 改 | novelDigest 默认值 |
| `test/novel-digest.test.ts` | 新建 | §14 |
| `docs/PLAN-NOVEL-DIGEST.md` | 本文档 | — |

预计规模：后端 ~600 行、Skill ~90 行、前端 ~350 行、测试 ~250 行。

## 14. 测试计划（faux provider 离线，照 `test/*.test.ts` 现有风格）

1. **解码**：utf-8 / gb18030 / 混杂坏字节退化三分支。
2. **清洗**：水印行删除、空行压缩、正常对白不误删。
3. **分章**：标准「第N章」、序章/番外、无章节结构退化、超长章节段落二分。
4. **分块**：贪心装箱不超 CHUNK_CHARS、块数上限拒绝、章节名正确携带。
5. **管道**：faux provider 返回合法 JSON → 走到 ready；map 返回非法 JSON → 重试一次后
   占位不中断；reduce 失败 → failed 且 chunks 保留；retry 从断点续（faux 计数验证
   只补缺失块）。
6. **入库**：mergeCorpus 写 mechanisms/cards 原子性；removeCorpus 只删独占条目、
   保留 Web 来源共撑条目。
7. **投影**：synopsis 截 400 字、maxDocs=3、非 ready 不注入。
8. **REST**：六端点 happy path + 400/404/409；鉴权开启时 401（照现有 access 测试）。
9. **回归**：`npx tsx --test test/*.test.ts` 全绿；`npm --prefix web run typecheck`。

## 15. 验收清单

- [x] 上传 ≥50 万字 txt：**实弹 564KB/~20 万字通过**（未试 50MB 上限与 600 块上限，逻辑由单测覆盖）
- [x] ready 后：导演室能看到梗概/结构/弧线/套路条目；套路条目进入研究库视图——**实弹 13 条入库并关联卡**
- [x] 大纲模型下一拍上下文含 documents 投影（synopsis 400 字 × ≤3 本）——`projectCorpusWorkspace` 接入 `#modelContext`，单测覆盖
- [x] epub 全流程：**epub 解析已实现（ziplite + container.xml/OPF/spine）但尚未实弹验过一本真实 .epub**——待补
- [x] 删除文档后研究库不留孤儿 mechanisms，磁盘清干净——实弹 `removedMechanisms=13`、目录清空
- [x] 全部测试绿：`novel-digest` 12 项 + `model-routing` 2 项全绿；全量 `802/806`，其余 4 个失败为改动前 HEAD 已存在的旧用例（curtain-reroll×2 / novelai-ui / prompt-budgets），与本功能无关
- [x] 正文关键路径（一拍流程）无任何新增 await——管道完全在导演室侧，`StageEngine` 零改动

## 16. 边界与已知取舍

- 块摘要质量受 flash 级模型限制；插头可换强模型（这正是 novelDigest 独立插头的理由）。
- 一本文档不跨卡共享套路（关联到建档时的卡）；跨卡复用后续用 attach API 补，阶段 1 不做。
- 2000 万字级超长文会被 MAX_CHUNKS 拒绝——是有意的，不做滑动窗口抽样消化。
- URL 抓取的反爬对抗（五秒盾等）不在承诺范围，失败章节占位降级。

## 17. 未做事项与后续启动清单（防重造轮子）

> 读完这一节即知：哪些已实现、哪些只是留了 schema、哪里已经踩过坑。新会话不必从头考古。

### 17.1 未实现（阶段 2：URL 抓取）

状态：**schema 已留，功能未做**。`CorpusDocument.sourceKind` 已支持 `"url"`，REST 未暴露
`corpus/url` 端点。要实现时按原 §12：

- `server/web-research.ts` 导出 `requestText`（现为模块私有，加 `export` 即可）。
- 新增 `POST /api/outline/corpus/url { tocUrl }`：抓目录页 → 启发式选「同域最大同构链接组」
  ≥5 条作为章节列表 → 逐章抓取（间隔 ≥2s，复用代理与超时）→ 边抓边落 `texts/<docId>.part`
  → 完成后走同一条 清洗/分块/消化 管道。
- 护栏：章节数 ≤3000；私人角色名不得出现在 URL（复用以有脱敏思路）；失败章节记 `(抓取失败)` 占位。
- `CorpusEngine.create()` 目前只吃上传文件名（校验 `.liyuan-uploads` 顶层文件）；url 模式需要
  `create` 增加一个 `sourceKind:"url"` 分支或新方法，`originName` 存目录页 URL。

### 17.2 功能缺口 / 已知未覆盖

1. **epub 未实弹验收**：解析代码在，但阶段 1 只实弹了 txt。建议用一本真实 epub 跑完整流程
   （上传 → ready → 删除），确认 ziplite 对常见 epub 的兼容（分卷/嵌套目录/加密 epub 不承诺）。
2. **docId 幂等用 originName+size**（设计如此），同名同大小不同内容会误判已有——这是原设计的已知
   取舍，属「可能不想改」；若要内容哈希需动 `create()` 的 stableId 生成与测试。
3. **reduce 失败不留错误细节给前端**：failed 只留 error 字符串；块级占位 `(本块摘要生成失败...)`
   可见于 digest.chunks，但没有单独 REST 把它暴露成结构化审计。
4. **full 吞吐上限**：串行单飞 + flash 模型，50 万字约十余分钟；没有并发/队列优先。这是有意的预算换稳定。
5. **`running.step` 不准**：写链空闲后 `view()` 的 running 字段立即消失；跨进程/多实例同时跑会串
   （服务是单实例 systemd，无锁）。若将来多实例需加锁文件。

### 17.3 已落地但易被误判为「没做」的点

- **投影注入大纲**：`engine.ts #modelContext` 已把 `researchWorkspace` 换成
  `projectCorpusWorkspace(view, { maxDocs: 3 })`——不要再去手塞完整 digest。
- **卡级隔离**：文档卡片在 `CorpusDocument.cardKey` 建档时快照；`view(cardKey)` 只反查该卡
  机制条目标注的 `doc-*`——不要改成全局可见。
- **删除语义**：`removeCorpus` 只删「sourceIds 全部是 doc-* 且仅此一条」的机制，Web 来源共撑的保留
  （机制 id 是 `sha256(mechanism+sourceIds)`，跨 doc/web 天然不同 id）。
- **novelDigest 回退链**：`resolveStepModel` 加了第 6 参数 fallbackChain，`novelDigest` 显式走
  `["outlineResearch"]`；`server/main.ts runSideText` 注入。线上强烈建议在 `liyuan.config.json`
  `stepModels.novelDigest` 显式指定（默认回退到 hajimi/gemini 曾遇 403，配 `new/deepseek-v4-flash` 正常）。
- **测试用的是 faux 离线**：`test/novel-digest.test.ts` 编译 `CorpusEngine` 直接造，不联网、不调真实模型。

### 17.4 回归与验证命令（与 §14 一致）

```bash
cd /root/Liyuan
PATH=/opt/node22/bin:$PATH npx tsx --test test/novel-digest.test.ts test/model-routing.test.ts
PATH=/opt/node22/bin:$PATH npx tsx --test test/*.test.ts          # 全量（注意 4 个 pre-existing 失败）
PATH=/opt/node22/bin:$PATH npm --prefix web run typecheck
PATH=/opt/node22/bin:$PATH npm --prefix web run build            # 产出 web/dist，服务直接托管
