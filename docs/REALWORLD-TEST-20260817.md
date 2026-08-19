# 实教二年级篇实弹测试记录（2026-08-17）

测试卡：`assets/cards/实教v3.9(二年级篇)肘击赢哈基米3版.png`
环境：正式 Node 22 systemd 服务（端口 7620）+ 真实模型链（deepseek-v4-flash 兼容中转），非离线夹具。

## 测试剧情

围绕朱耀良与一年 C 班椿樱子的搭档考试试探连续运行多拍：追问考试意图、约定携卷、次日核卷、
识破刻意控分、暂缓搭档关系、放学后向堀北班保留候选信息、推进次日棋局准备。正文、`rp-state`、
生态、世界审计全部真实落入会话树（`01a00999-…`）。

## 第一轮：链路打通与画像正确性

### 发现与修复

1. **画像输出截断**（输出只剩 `{` 或代码围栏）。卡/世界书/预设全文输入过大 + 兼容中转 SSE 对
   结构化长输出不稳。修复：画像输入裁成卡核心字段、40 条世界书工作集、预设启用块名、最近 8 条
   短历史；REST 旁路加非流式降级；失败原始输出留档 `.liyuan/world/profile-last-invalid.txt`。
2. **事实引文过严**（模型轻微改写引号/标点导致整拍 fact-failed）。修复：NFKC + 中英文引号 +
   标点归一核对；单条坏证据只丢对应事实并写入 uncertainties；用户自愿行动仍必须有有效
   `latest-user` 引文，主权门禁未放松。
3. **Proposal 拿不到代码计算的 base hash**（正确提案也会 hash 不匹配）。修复：prompt 显式下发
   `base_state_hash`，Skill 要求逐字照抄，TS 提交前仍校验。
4. **模型提交未到期模块**（`per-arc` 的 quest-objective 在短对话被尝试提交，被程序拒绝）。
   修复：prompt 只传 `due_module_ids` 与裁剪后的到期 Manifest，TS 保留第二道 cadence/revision 检查。
5. **Manifest 自动升级语义**：已有分支 Manifest 时周期复盘不得静默改写。改为新分支播种；
   已有分支继续用当时版本；用户主动“重新分析适配”才追加当前分支。Manifest 增加 `playKey`。
6. **第一轮审计不可见**（世界 round 0 或提案被拒时前端不显示）。修复：有 `worldAudit` 即显示模块卡，
   标注已提交/未提交。
7. **旁路空输出**（`deepseek-v4-flash` 兼容中转偶发空文本）。facts/audit 容量提至 8192；REST 画像
   加非流式降级；失败完整落 `rp-world-audit`，fail closed 保留旧世界，生态正常提交。

### 实教画像结果（真实分析）

institutional 尺度、day 默认步长、normal 活跃度；启用 `institution-calendar`（on-time-advance）、
`public-information`（on-trigger）、`relationship-dynamics`（on-trigger）、`quest-objective`
（per-arc）；禁用战争/市场/修仙/魔法/科技/战斗/生存/区域环境/家庭/城市设施/骰点等无关模块。
长期要求：不得预知未发生剧情、严格时间线、NPC 只按个人所见所闻行动。

## 第二轮：关键路径分级与并发安全

### 变更

- Sogon/Sigon 文学画像、卡级世界画像、生态双池备料全部移出正文关键路径（后台生成，下一拍采用）。
- 生态双池拆 `running/ready`，同刻单飞、ready 才消费、所有池写入串行化并在写前重读最新池。
- writer 固定捕获 user 叶；生成期间切分支整份结果丢弃（正文/账本/世界/生态都不误写）。
- 排队输入绑定提交时会话/卡；`await performTurn()` 代表真实执行完成；停止当前拍会取消队列。
- 拍后各阶段检查 AbortSignal，停止后不再写世界/生态/压缩。

### 验证

- 相关领域测试（画像/事实/提案/审计/生态/模块化世界）通过。
- Web 构建通过；systemd 重启后 hello 正常。
- `npx tsx` 缓存命令曾在本机阻塞，改用已安装 tsx CLI 后正常（环境问题，非项目代码）。

## 仍需观察

- 正式世界三旁路在当前 `deepseek-v4-flash` 兼容中转上偶发“最终消息无文本”，fail closed 保留旧世界，
  生态正常提交。建议实弹时为 `worldProfile / literaryWorldFacts / literaryWorldAudit` 插头配置
  结构化输出更稳定的模型。
- 一拍总耗时约 5–14 分钟，主要来自主演分段演出、文学/生态旁路与当前模型/中转响应速度，
  不是 v2 reducer。后续可优化旁路模型路由与频率，但不能以牺牲审计、主权、分支一致性换速度。
- 生态 aftermath 偶尔会主动把场景推进到“返回宿舍并开始推演棋局”，相对当前镜头略快；
  属生态 Skill 节奏问题，不是世界 v2 状态错误，后续可收紧 aftermath 单拍时间边界。
