# 模型调用输入预算

> 2026-08-18：由 `日式中专大乱斗` 巨型卡状态栏重Roll 116 万 token 超限事故建立。

## 原则

- 任何旁路不得发送 `rawCard`、完整 `character_book`、完整挂载世界书或无界历史。
- “限制消息条数”不等于输入有界；所有历史、lore、正文都要同时有单项和总字符预算。
- 上下文缓存只能省费用/延迟，不能解决 context length。
- 结构化任务失败时 fail closed，不通过自动压缩插件掩盖错误输入设计。

## 当前硬边界

| 调用 | 输入边界 |
|---|---|
| 状态栏重Roll | `buildCurtainRerollMaterials`：卡/预设格式材料总计 <60K；无 rawCard/book/regex |
| 生态卡池 | 卡 dossier 无 book；lore ≤40K；历史 ≤60K |
| 生态 arrival/aftermath | 历史 ≤60K；用户 ≤8K；正文 ≤20K |
| Sogon/Sigon | 历史单条 ≤6K、总计 ≤60K；用户消息单条 ≤4K |
| 连续性/导演 | 历史 ≤60K；激活 lore ≤24K；用户 ≤8K |
| 世界事实信封 | 历史 ≤60K；用户 ≤8K；冻结正文 ≤24K |
| 场记 | 用户 ≤8K；正文 ≤30K |
| 长局压缩 | 单次 conversation ≤120K，按完整树条目选最大安全前缀，后续滚动继续压 |
| 世界画像 | 卡字段、40 条 lore 工作集和 8 条短历史均有既有裁剪 |
| 输出合约（当前关闭） | 卡书 ≤15K、预设 ≤60K，已有边界 |

公共实现：`src/stage/prompt-budget.ts`（`clipPromptText / boundedHistory / boundedLore`）。

## 仍需后续治理

- 主 writer 的 system + 常驻 lore + live history 在每个 agent round 重发，尚需统一 context preflight；
- assistant `story_read` 应增加总字符上限；
- world/ecology 状态增长到 schema 上限时，应按 due module / active working set 进一步裁剪；
- 视觉 MCP 多图数量应设上限。
