/**
 * 台上引擎（PLAN-RP-HARNESS M1）——RP 原生回合循环（R1 循环自持）。
 *
 * 一拍 = 装配（f(分支)）→ 一次流式生成（M1 零工具）→ assistant 落树 → 谢幕。
 * 没有 steer/followUp 队列，没有续轮判定：harness 知道自己在哪一幕。
 *
 * 竞态两律（R9）在此落地：
 * - 回合互斥：忙时新输入进队列，本拍收尾后依序开演；
 * - 谢幕由 harness 判定：流结束即收轮，不存在模型可续的循环。
 *
 * 依赖全部注入（SessionManager / 模型 / 流函数），可用 faux provider 离线整测。
 */

import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

import { applyProjectedSamplers } from "../samplers.ts";
import { extractDraftBody, extractDraftRules } from "../draft.ts";
import {
	appendOverlayEntry,
	loreFingerprint,
	overlayPathFor,
	scanEntries,
	searchEntries,
} from "../lorebook.ts";
import { loadCodexEntries } from "../codex.ts";
import { formatPanelIndex, formatPanelSnapshot, loadPanels } from "../panels.ts";
import { dir } from "../paths.ts";
import { classifyTag, scanTaggedBlocks } from "../postprocess.ts";
import { formatRosterIndex, formatState, saveState } from "../state.ts";
import { isBackstageText } from "../stance.ts";
import type { LorebookEntry } from "../types.ts";
import {
	buildStageInjection,
	buildStageSystemPrompt,
	codexNamesFromBranch,
	detectsLanguageMismatch,
	formatLoreIndex,
	rebuildHistory,
	stateFromBranch,
	type BranchEntryLike,
} from "./assemble.ts";
import {
	assemblePresetAfter,
	constantLoreOf,
	loadStageConfig,
	loadStageMaterials,
	type AssembledPiece,
	type StageMaterials,
} from "./materials.ts";
import {
	MANUAL_MIN_COMPACT_CHARS,
	runCompaction,
	SUMMARY_ENTRY_TYPE,
	type CompactOutcome,
	type RpSummaryData,
} from "./compact.ts";
import { runScribeTurn, STATE_ENTRY_TYPE } from "./scribe-run.ts";
import {
	LITERARY_PROFILE_ENTRY_TYPE,
	buildCharacterProfilePrompt,
	buildPersonaProfilePrompt,
	literaryProfileFromBranch,
	normalizeLiteraryArtifact,
	shouldRefreshLiteraryProfile,
	countCompletedNarrativeTurns,
	type LiteraryProfileData,
} from "./literary-profile.ts";
import {
	buildLiteraryDirectorPrompt,
	formatLiteraryDirection,
	parseLiteraryDirection,
	type LiteraryDirection,
} from "./literary-director.ts";
import {
	buildLiteraryContinuityPrompt,
	parseLiteraryContinuity,
	shouldRunContinuity,
	type LiteraryContinuity,
} from "./literary-continuity.ts";
import {
	LITERARY_WORLD_ENTRY_TYPE,
	literaryWorldFromBranch,
} from "./literary-world.ts";
import {
	LITERARY_ECOLOGY_ENTRY_TYPE,
	buildEcologyCardPrompt,
	buildEcologyGlobalPrompt,
	buildEcologyRuntimePrompt,
	buildEcologySearchPlanPrompt,
	commitLiteraryEcologyRound,
	degradedLiteraryEcologyRound,
	ecologySearchQueries,
	applyEcologyUsage,
	formatLiteraryEcologyInjection,
	literaryEcologyFromBranch,
	loadEcologyPools,
	normalizeEcologyCardPool,
	normalizeEcologyGlobalPool,
	normalizeLiteraryEcologyState,
	saveEcologyPools,
	validateEcologyTransition,
	type LiteraryEcologyState,
} from "./literary-ecology.ts";
import {
	MAX_ROUNDS,
	runStageTool,
	skillReadTool,
	stageTools,
	writeTools,
	type MemoryHitLike,
	type StageTool,
	type StageToolDeps,
	type ToolRunResult,
} from "./tools.ts";
import { unifiedStageToolNames } from "../tools/adapters/stage.ts";
import {
	mcpStageTools,
	mcpStageToolNames,
	runMcpStageTool,
	type McpStageDeps,
} from "./mcp-stage.ts";
import {
	mediaStageToolNames,
	mediaStageTools,
	runMediaStageTool,
	type MediaStageResult,
} from "./media-stage.ts";
import { assistantStageTool, runAssistantStageTool } from "./assistant-stage.ts";
import type { MemoryChunkLike } from "../tools/memory.ts";
import { wantsManualWebResearch } from "../tools/web-research.ts";
import { resolveStepModel, type SideModelStep } from "../model-routing.ts";
import { workflowSkill } from "./skill-store.ts";
import { worldModuleSkillPacks } from "./skill-store.ts";
import {
	WORLD_MANIFEST_ENTRY_TYPE,
	buildWorldProfilePrompt,
	defaultCardWorldProfile,
	loadCardWorldProfile,
	manifestFromProfile,
	normalizeCardWorldProfile,
	profileNeedsAnalysis,
	saveCardWorldProfile,
	worldManifestFromBranch,
	worldCardKey,
	worldProfileFingerprint,
} from "./literary-world-profile.ts";
import {
	WORLD_AUDIT_ENTRY_TYPE,
	buildBeatFactPrompt,
	buildWorldAuditPrompt,
	buildWorldProposalPrompt,
	normalizeBeatFactEnvelope,
	normalizeWorldTransitionAudit,
	worldAuditEntry,
	worldTransitionHash,
	commitModularWorldTransition,
	dueWorldModules,
	normalizeModularWorldProposal,
	type WorldTransitionAuditEntry,
} from "./literary-world-transition.ts";
import { formatModularWorldInjection, modularWorldFromBranch, projectLiteraryWorldV1 } from "./literary-world-modular.ts";
import { ecologySignalsForWorld, worldSignalsForEcology } from "./literary-world-signals.ts";
import { buildCurtainRerollMaterials, finalizeCurtainText } from "./curtain-materials.ts";
import {
	createWorkspace,
	finalTimeline,
	splitDraftSegments,
	projectedState,
	planStepBudget,
	recordSegment,
	runWriteTool,
	type TurnWorkspace,
	type WorkspaceDeps,
} from "./workspace.ts";

// ---------------- 依赖面（结构类型，不引 @liyuan/agent-runtime） ----------------

export interface StageSessionManager {
	getBranch(): unknown[];
	getLeafId(): string | null;
	appendMessage(message: unknown): string;
	appendCustomMessageEntry(customType: string, content: string, display: boolean): string;
	/** CustomEntry（不进 LLM 上下文）：账本快照用 */
	appendCustomEntry(customType: string, data?: unknown): string;
	getSessionId(): string;
	flush(): void;
}

export interface StageModelLike {
	id: string;
	provider?: string;
	api?: unknown;
	baseUrl?: string;
	[k: string]: unknown;
}

/** @liyuan/ai streamSimple 的结构子集 */
export type StageStreamFn = (
	model: StageModelLike,
	context: { systemPrompt?: string; messages: unknown[] },
	options?: Record<string, unknown>,
) => AsyncIterable<StageStreamEvent> & { result(): Promise<AssistantMsgLike> };

export interface AssistantMsgLike {
	role: "assistant";
	content: Array<{
		type: string;
		text?: string;
		thinking?: string;
		name?: string;
		arguments?: Record<string, unknown>;
	}>;
	stopReason?: string;
	errorMessage?: string;
	[k: string]: unknown;
}

export interface StageStreamEvent {
	type: string;
	delta?: string;
	contentIndex?: number;
	toolCall?: { name?: string; arguments?: Record<string, unknown> };
	partial?: AssistantMsgLike;
	message?: AssistantMsgLike;
	error?: AssistantMsgLike;
}

export interface StageTurnEndInfo {
	aborted: boolean;
	/** 非空 = 本拍以错误收场（已通知，无正文落树） */
	error?: string;
	/** 落树的 assistant 条目 id（错误/空拍时无） */
	entryId?: string;
}

export interface StageEvents {
	onTurnStart?: () => void;
	/** 流式增量（转 WS delta 帧；kind 对应正文/思考通道） */
	/**
	 * 流式增量。draft=true 表示该增量是 draft_write 参数的转发
	 * （稿件流 = 替换语义：多稿重交原地更新，前端不得叠加）；
	 * reset=true 表示本次调用的首个分片（前端据此清掉旧稿）。
	 */
	onDelta?: (kind: "text" | "thinking", delta: string, draft?: boolean, reset?: boolean) => void;
	/**
	 * 中间轮旁白清理：稿落地前的工具轮吐出的 text（读题/计划旁白）已流式上屏，
	 * 但不是正文——通知前端把它收进过程条并从正文区移除（8/09 实弹：读题文字
	 * 先挂在正文顶部、落树后又拼到正文尾部）。
	 */
	onStreamClear?: () => void;
	/**
	 * 稿件分段重同步（修复后）：前端把屏上全部稿段**原位**替换为 segments。
	 * 与 onDelta 的稿件流互补——流式分片管「一段段长出来」，resync 管「原地变新」：
	 * draft_edit 改稿成功后按当前稿全量重切下发，修后的段就是用户看到的段。
	 */
	onDraftResync?: (segments: string[]) => void;
	onTurnEnd?: (info: StageTurnEndInfo) => void;
	/** 面向用户的告警（宏降级等）；每种只发一次 */
	onNotify?: (level: "info" | "warning" | "error", text: string) => void;
	/** 过程条短句（验收/修订进度；kind:"note" 形态，无需工具名） */
	onActivity?: (detail: string) => void;
}

export interface StageEngineDeps {
	cwd: string;
	getSessionManager: () => StageSessionManager;
	getModel: () => StageModelLike | undefined;
	/** 按 provider/id 查完整模型对象；旁路覆盖使用，不改变剧情总插头 */
	findModel?: (provider: string, id: string) => StageModelLike | undefined;
	/** 渠道改名后的侧模型重定位；仅在宿主能无歧义确定模型时返回。 */
	findModelById?: (id: string) => StageModelLike | undefined;
	getAuth: (model: StageModelLike) => Promise<{ apiKey?: string; headers?: Record<string, string> }>;
	/** 会话当前思考档（用户自由，引擎透传） */
	getThinking?: () => string | undefined;
	/** 账本磁盘缓存路径（.liyuan-state/<sessionId>.json）；给出则场记落盘（fs.watch → state 帧） */
	getStateFile?: (sessionId: string) => string | undefined;
	/** 剧情库检索（memory_search 工具用）；未注入 = 该工具恒返回无命中 */
	searchMemory?: (sessionId: string, query: string) => Promise<MemoryHitLike[]>;
	/**
	 * 向量库写侧三件（M-D3）。均由宿主按「当前对话 + 当前卡」绑定 MemoryScope 后注入——
	 * **作用域不经模型**（PLAN-RP-TOOLING M-D3：scope 全隐藏），引擎只透传 sessionId。
	 * 未注入 = 台上无对应工具（依赖缺失的工具不上清单）。
	 */
	addMemory?: (
		sessionId: string,
		input: { text: string; title?: string },
	) => Promise<{ added: number; total: number; chunks: number }>;
	listMemory?: (sessionId: string, storeId: string) => MemoryChunkLike[];
	deleteMemory?: (sessionId: string, storeId: string, id: string) => boolean;
	/** 按需联网查证。隐私、查询额度、代理和网络请求由宿主执行。 */
	webResearch?: (queries: string[], maxResults: number, signal?: AbortSignal) => Promise<import("../tools/web-research.ts").WebResearchItem[]>;
	/**
	 * 面板读写（M-D5）。由宿主按当前会话绑定 artifacts 文件后注入。
	 * 未注入 = 台上无面板工具（依赖缺失的工具不上清单）。
	 */
	loadPanels?: (sessionId: string) => Record<string, { name: string; kind: "markdown" | "svg" | "html"; content: string; archived?: boolean }>;
	writePanel?: (sessionId: string, input: { name: string; kind: string; content: string }) => { ok: true; created: boolean; reopened: boolean; activeCount: number; overLimit: boolean } | { ok: false; error: string };
	closePanel?: (sessionId: string, name: string) => { ok: boolean; error?: string };
	/** 被压缩裁掉的早期正文归档进剧情库（供 memory_search 召回细节）；未注入 = 只落摘要不归档 */
	archiveCompacted?: (sessionId: string, text: string) => Promise<void>;
	/**
	 * 世界书条目启停落盘（lorebook_toggle 工具用，M-D2）：写 config.disabledLore 并重装素材。
	 * 由宿主注入——落盘与热重载归 server/ 侧（引擎不碰 server 的 writeJsonWithBackup）。
	 * 未注入 = 台上无 lorebook_toggle 工具。
	 */
	setDisabledLore?: (fingerprints: string[], enabled: boolean) => number;
	/**
	 * MCP 外设（8/06 重新接线）：宿主注入 hub 的两个能力，台上据此挂 mcp__ 工具。
	 * 未注入 = 台上无 MCP 工具（依赖缺失的工具不上清单）。
	 * hub 单例由宿主持有——引擎不自建，避免第二个实例（见 src/mcp.ts 的 globalThis 槽）。
	 */
	mcp?: McpStageDeps;
	/**
	 * 媒体交付工具（8/06 重接）：show_image/audio/video/html + tts。
	 * 与 MCP 同源的断链——消费端（wire.ts）一直健在，缺的是台上生产端。
	 * false/省略 = 不挂（tts 另需服务端 TTS 环境，由 ttsAvailable 决定）。
	 */
	media?: boolean;
	/** TTS 环境是否就绪（未就绪则 tts 不上清单——依赖缺失的工具不上清单） */
	ttsAvailable?: () => boolean;
	/**
	 * 剧情决策询问（ask 工具，P7 接回）：弹出选择卡等用户应答。
	 * 应答 = 用户选择的选项原文（作为新输入回喂模型，计划据此重拟）；
	 * undefined = 用户停止（笔还给用户，本拍收束）。
	 * 未注入 = 台上无 ask 工具（依赖缺失的工具不上清单）。
	 */
	askUser?: (question: string, options: string[], signal?: AbortSignal) => Promise<string | undefined>;
	streamFn: StageStreamFn;
	events?: StageEvents;
}

// ---------------- 引擎 ----------------

const nowMsg = (text: string) => ({
	role: "user",
	content: [{ type: "text", text }],
	timestamp: Date.now(),
});

const textOfAssistant = (m: AssistantMsgLike | null): string => {
	if (!m) return "";
	return m.content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("")
		.trim();
};

// ---------------- 五注入（PLAN-RECTIFY §2.3：轮次层全部送模文案，文案即规格） ----------------

/** 规划卡：每拍第 1 轮随末端注入送达（工作区新建必空） */
export const PLAN_CARD =
	"【第 1 步·规划】本拍还没有计划。读题、探索（工具自取）；用户这句输入引出的未定变量——" +
	"取不同值这拍走向会分岔、且设定里查不到的——先 `ask` 请用户定，再用 `beat_plan` 列路标。" +
	"你的任务是列出抽象的路标的同时为路标的具体内容留下充分的可发挥余地，" +
	"让下面每个剧情轮次扮演路标时拥有极大的发挥空间以给用户带来更多的剧情可能性。" +
	"没有戏的拍可 `draft_write` 一次交完；用户本轮在求方向/递笔的，直接 `ask`。";

/** 记账注入：seal（含兜底封笔）之后第一件事；本拍已有落账（结构信号）时跳过 */
export const LEDGER_INJECTION =
	"【记账】已封笔。核对本拍变动并落账：世界状态用 `world_state_update`（物品/时间/位置/关系），" +
	"表格与面板用 `panel_write` 同步。没有变动就直接停。";

export const DEFAULT_MAIN_MAX_TOKENS = 8192;
export const FIRST_CALL_MAX_TOKENS = 4096;
/** 格式收尾沿用主演本拍上下文，只放宽输出容量，不再重复送料完整卡与预设。 */
export const CURTAIN_MAX_TOKENS = 32768;

/** maxTokens 是单次 provider 总输出上限（含供应商计入其中的 thinking），不是整拍正文上限。 */
export function mainStageMaxTokens(
	model: StageModelLike,
	wordRange?: { min: number; max: number },
): number {
	const wanted = wordRange
		? Math.max(4096, Math.min(16384, Math.ceil(wordRange.max * 2) + 2048))
		: DEFAULT_MAIN_MAX_TOKENS;
	const modelCap = typeof model.maxTokens === "number" && model.maxTokens > 0 ? model.maxTokens : wanted;
	return Math.min(wanted, modelCap);
}

export interface StageRerollPrep {
	literaryContinuity?: LiteraryContinuity;
	literaryDirection?: string;
	literaryDirectionData?: LiteraryDirection;
	literaryEcology?: LiteraryEcologyState;
}

/** 主演格式收尾的独立容量：触顶收场同样必须使用，不能退回正文轮的 8k。 */
export function curtainMaxTokens(model: StageModelLike): number {
	return typeof model.maxTokens === "number" && model.maxTokens > 0
		? model.maxTokens
		: CURTAIN_MAX_TOKENS;
}

/** 净正文字数（不含格式区块、不计空白），仅用于流程门与观测指标。 */
const draftBodyCharsOf = (ws: TurnWorkspace): number =>
	ws.draft.trim() ? extractDraftBody(ws.draft).replace(/\s+/g, "").length : 0;
/** 初次请求之外的自动重试次数；429、短暂网关错误和网络错误由 provider 按退避处理。 */
const MODEL_MAX_RETRIES = 9;

const trimContentBodyRepeat = (body: string, inner: string): string => {
	const draft = body.trim();
	const content = inner.trimStart();
	if (!draft || !content) return inner;
	for (let size = Math.min(draft.length, content.length); size > 0; size--) {
		if (content.startsWith(draft.slice(-size))) {
			const rest = content.slice(size).trim();
			return rest ? `\n${rest}` : "";
		}
	}
	return inner;
};

/**
 * 进度行：每轮替换语义（替代开工卡/回看卡）。只投影路标和段数。
 * 拍前导演工件与当前稿是每轮的事实源，不再通过 skill 工具制造额外停顿。
 * wordRange 只调节 provider 容量，不在轮次层测量或授权新增事件；单拍边界由工作区预算负责。
 */
export function progressLine(ws: TurnWorkspace, packNames?: string[], forcedSkills?: string[]): string {
	const parts: string[] = [];
	if (ws.plan.length > 0) {
		const i = ws.plan.findIndex((s) => !s.done);
		if (i >= 0) parts.push(`路标 ${i + 1}/${ws.plan.length}「${ws.plan[i]!.text}」`);
	}
	parts.push(`已演 ${ws.appends} 段`);
	const packs = packNames?.length ? `可读场面包：${packNames.join(" / ")}。` : "";
	const forced = forcedSkills?.length ? `每个路标落笔前先 \`skill_read\`${forcedSkills.map((name) => `「${name}」`).join("")}构思本路标。` : "";
	return `【进度】${parts.join("；")}。${packs}${forced}`;
}

/** 判定注入：收笔前一次性；不回报篇幅，续写/ask/收笔归模型判断。 */
export function verdictInjection(userName: string): string {
	return `【判定】继续写、必要时 \`ask\`，或 \`draft_seal\` 收笔——你判断；一般走向自行决定，只有用户主权未定且此刻不定就无法继续时才询问。`;
}

/** 进度行替换语义：移除 convo 里上一条【进度】再推新行（判定/记账/谢幕一次性，不替换） */
function replaceProgressLine(convo: unknown[], line: string): void {
	for (let k = convo.length - 1; k >= 0; k--) {
		const msg = convo[k] as { role?: string; content?: Array<{ type?: string; text?: string }> };
		const txt = Array.isArray(msg.content) ? msg.content.map((c) => c.text ?? "").join("") : "";
		if (msg.role === "user" && txt.startsWith("【进度】")) {
			convo.splice(k, 1);
			break;
		}
	}
	convo.push(nowMsg(line));
}

/**
 * 定稿合并：稿件为主体；text 通道里**格式特征**的尾巴（状态栏占位 / catsay / w2g…）
 * 拼回，纯文本增量（闲聊收笔）丢弃——树上正文 = 用户最终该看到的全部内容。
 *
 * 模型常把 draft_write 理解成「交正文」，把格式栈尾巴走普通 text 通道输出。
 * 旧逻辑 `ws.draft.trim() ? ws.draft : text` 是二选一，尾巴连同 token 一起被丢弃
 * （8/05 实锤：模型思考里宣告「body, status bar, and cat commentary」，
 * draft_write 只交了 679 字正文，状态栏与咪咪点评凭空蒸发）。
 * 但也不能无脑全拼——纯文本尾巴（"就这样吧。"）是收笔闲聊，不该进正文。
 */
const TAG_NAME_SRC = "[A-Za-z_\\u4e00-\\u9fff][\\w\\u4e00-\\u9fff.\\-]*";
const FENCE_LINE_RE = /^```/m;
const FENCE_BLOCK_RE = /```[\s\S]*?```/g;
/** 逐个扫标签名，用于跳过 fold/strip 类（它们不是格式内容） */
const TAG_SCAN_RE = new RegExp(`<(${TAG_NAME_SRC})(?:\\s[^>]*)?\\/?\\s*>`, "g");
/** 成对块，用于把 fold/strip 类整块从尾巴里剔掉 */
const SELF_CLOSING_RE = new RegExp(`<(${TAG_NAME_SRC})(?:\\s[^>]*)?\\/\\s*>`, "g");

/**
 * 尾巴里格式内容的起点（第一个尖括号标签或行首 ``` 围栏）；没有 → -1。
 *
 * 8/10 实弹收口：旧口径整串检验、整串拼接——元话语（收笔自检逐条、ask 开场白
 * 起了又劝退）挂在格式块前面时跟着一起进定稿（HK 5 会话 11 拍：7 个裸尾巴段
 * 里 3 个带元话语，41 个稿段 0 违约）。改为**只取格式内容**：从第一个标签/围栏
 * 起切，之前的自由文本一律丢弃；纯自由文本尾巴（闲聊收笔）仍整段不进正文。
 */
export const formatTailStart = (tail: string): number => {
	TAG_SCAN_RE.lastIndex = 0;
	let tag = -1;
	for (let m = TAG_SCAN_RE.exec(tail); m; m = TAG_SCAN_RE.exec(tail)) {
		if (classifyTag(m[1]!) === "unwrap") {
			tag = m.index;
			break;
		}
	}
	const fence = FENCE_LINE_RE.exec(tail)?.index ?? -1;
	if (tag < 0) return fence;
	return fence < 0 ? tag : Math.min(tag, fence);
};



/**
 * 尾巴 → **只留格式内容**：格式类标签块 + ``` 围栏块，按原序拼回；块之外的自由文本
 * 一律丢弃。
 *
 * 8/10 只挡了「格式块之前」的自由文本（起点切一刀）。8/16 实弹暴露另一半：模型在
 * 尾巴里把**整段正文重述了一遍**，夹在 `<time_format>` 与 `<options>` 之间——起点切
 * 不到它（它在第一个格式块之后），`trimContentBodyRepeat` 也管不到（它只认
 * `<content>` 包裹的重述）。于是定稿里正文出现两遍。
 *
 * 判据仍是「块 vs 非块」，不认名字：块＝成对标签（policy 由 classifyTag 定，fold/strip
 * 类不算格式内容）或 ``` 围栏。
 */
const formatContentOnly = (tail: string): string => {
	type Span = { start: number; end: number; text: string };
	const spans: Span[] = [];
	// 先剥 HTML 注释再扫块（同 extractDraftBody）：注释里的 `<Prism>` 这类会被当成无闭合
	// 标签，一路吃到文末，把注释后面的裸重述正文整段包进「格式块」（8/16 实弹踩到）。
	const src = tail.replace(/<!--[\s\S]*?-->/g, "");
	FENCE_BLOCK_RE.lastIndex = 0;
	for (let m = FENCE_BLOCK_RE.exec(src); m; m = FENCE_BLOCK_RE.exec(src)) {
		spans.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
	}
	for (const b of scanTaggedBlocks(src)) {
		if (b.policy !== "unwrap") continue; // fold/strip 类不是格式内容
		if (b.hanging) continue; // 无闭合＝不是成形的格式块，别拿它当筐把正文装进来
		spans.push({ start: b.start, end: b.end, text: b.raw });
	}
	// 自闭合格式标签（`<StatusPlaceHolderImpl/>` 这类占位符）——scanTaggedBlocks 只找成对块
	SELF_CLOSING_RE.lastIndex = 0;
	for (let m = SELF_CLOSING_RE.exec(src); m; m = SELF_CLOSING_RE.exec(src)) {
		if (classifyTag(m[1]!) !== "unwrap") continue;
		spans.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
	}
	spans.sort((a, b) => a.start - b.start || b.end - a.end);
	const kept: Span[] = [];
	for (const s of spans) {
		const last = kept[kept.length - 1];
		if (last && s.start < last.end) continue; // 被前一块覆盖（嵌套/重叠）
		kept.push(s);
	}
	return kept
		.map((s) => s.text.trim())
		.filter(Boolean)
		.join("\n\n");
};

/**
 * 逐字相同的格式块去重（8/10 实弹：预设状态栏规则＋谢幕注入双指令源下，
 * 模型把同一份状态栏在一条尾巴里输出了两遍）。零名单零识别——块＝任意
 * `<Tag>…</Tag>`，只删与已见块**完全相同**的重复，内容有任何差异都不动。
 */
export const dedupeIdenticalBlocks = (s: string): string => {
	const seen = new Set<string>();
	return s
		.replace(/<([A-Za-z][\w-]*)>[\s\S]*?<\/\1>/g, (block) => {
			const key = block.trim();
			if (seen.has(key)) return "";
			seen.add(key);
			return block;
		})
		.replace(/\n{3,}/g, "\n\n")
		.trim();
};

/**
 * 有些 ST 卡要求谢幕时重交 `<main_output><content>正文…` 整包。梨园的正文已经在
 * 稿纸里，若照收会把同一段故事落树两次。这里保留卡的容器与 content 内格式件，
 * 但以稿纸替换 content 里的自由文本；正文仍只有一个权威来源。
 */
export const mergeWrappedContent = (draft: string, text: string): string | null => {
	const open = /<content(?:\s[^>]*)?>/i.exec(text);
	if (!open || open.index === undefined) return null;
	const bodyStart = open.index + open[0].length;
	const close = /<\/content\s*>/i.exec(text.slice(bodyStart));
	if (!close || close.index === undefined) return null;
	const bodyEnd = bodyStart + close.index;
	const inner = text.slice(bodyStart, bodyEnd);
	const blocks = inner.match(/<([A-Za-z_][\w.-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1\s*>|<([A-Za-z_][\w.-]*)(?:\s[^>]*)?\s*\/>|```[\s\S]*?```/g) ?? [];
	const beforeDraft: string[] = [];
	const afterDraft: string[] = [];
	for (const block of blocks) {
		const tag = /^<([A-Za-z_][\w.-]*)/i.exec(block)?.[1]?.toLowerCase();
		if (tag === "time" || tag === "ai_guide") beforeDraft.push(block.trim());
		else afterDraft.push(block.trim());
	}
	const content = [...beforeDraft, draft.trim(), ...afterDraft].filter(Boolean).join("\n\n");
	return `${text.slice(0, bodyStart)}\n${content}\n${text.slice(bodyEnd)}`.trim();
};

export const mergeFinalText = (draft: string, text: string): string => {
	const d = draft.trim();
	const t = text.trim();
	if (!d) {
		// 空工作区不能让状态栏或样式围栏冒充正文落树。普通直出正文仍原样保留。
		const body = extractDraftBody(t);
		const formatOnly = !body || /^```(?:css|html)?\s*[\s\S]*```$/i.test(body);
		return formatOnly ? "" : dedupeIdenticalBlocks(t);
	}
	if (!t || d === t) return d;
	// 稿件已包含 text（模型边写边交，text 是半截）：稿件已是全量
	if (d.includes(t)) return d;
	// ST 整包格式兼容：容器保留，content 的自由文本由权威稿纸替换。
	const wrapped = mergeWrappedContent(d, t);
	if (wrapped) return dedupeIdenticalBlocks(wrapped);
	// text 含稿件且稿件之前没有格式块时，取稿件之后的增量；格式在稿件两侧时必须整段扫块。
	const idx = t.indexOf(d);
	const prefix = idx > 0 ? t.slice(0, idx) : "";
	const tail = idx >= 0 && formatTailStart(prefix) < 0 ? t.slice(idx + d.length) : t;
	const from = formatTailStart(tail);
	if (from < 0) return d;
	// 尾巴只留格式内容（块之外的自由文本／重述正文一律丢）；`<content>` 里重述的正文再裁一次
	const tailPart = formatContentOnly(tail.slice(from))
		.replace(/<content>([\s\S]*?)<\/content>/g, (whole, inner: string) => {
			const trimmed = trimContentBodyRepeat(d, inner);
			return trimmed ? `<content>${trimmed}</content>` : "";
		})
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return dedupeIdenticalBlocks([d, tailPart].filter(Boolean).join("\n\n"));
};

export class StageEngine {
	#deps: StageEngineDeps;
	#busy = false;
	#queue: Array<{ text: string; sessionId: string; cardPath: string; resolve: () => void; reject: (error: unknown) => void }> = [];
	#abort: AbortController | null = null;
	#warnedMacros = "";
	#warnedAuditDrop = 0;
	#warnedProtocolDrop = "";
	#warnedSideModelFallbacks = new Set<string>();
	#lastAssemblyJson = "";
	/** 当前拍在后台准备的双池任务；不阻塞正文，下一拍开始前消费并合并。 */
	#ecologyPoolPrep: Promise<{ cardPath: string; cardName: string; pools: ReturnType<typeof loadEcologyPools>; warnings: string[] }> | null = null;
	#ecologyPoolReady: { cardPath: string; cardName: string; pools: ReturnType<typeof loadEcologyPools>; warnings: string[] } | null = null;
	#ecologyPoolWrite = Promise.resolve();
	/** 非关键路径候选：本拍开始后台算，下一拍只在原分支后代上采用；永不阻塞当前正文。 */
	#literaryProfilePrepRunning = false;
	#literaryProfileReady: { sessionId: string; cardPath: string; sourceLeafId: string; data: LiteraryProfileData } | null = null;
	#worldProfilePrepRunning = false;
	#worldProfileReady: { sessionId: string; cardPath: string; sourceLeafId: string; profile: import("./literary-world-profile.ts").CardWorldProfile } | null = null;

	constructor(deps: StageEngineDeps) {
		this.#deps = deps;
	}

	get isStreaming(): boolean {
		return this.#busy;
	}

	/** 用户新输入开一拍：先落 user 消息再开演；忙时排队（流式中送达的输入不打断叙事） */
	async performTurn(userText: string): Promise<void> {
		if (this.#busy) {
			const sm = this.#deps.getSessionManager();
			const cardPath = loadStageConfig(this.#deps.cwd).card;
			return new Promise<void>((resolve, reject) => this.#queue.push({ text: userText, sessionId: sm.getSessionId(), cardPath, resolve, reject }));
		}
		await this.#run(userText);
		await this.#drain();
	}

	/** 正文阶段再生成：叶已钉在 user，复用上一版拍前工件，直接从 writer 开始。 */
	async regenerate(prep?: StageRerollPrep): Promise<void> {
		if (this.#busy) return;
		await this.#run(null, prep);
		await this.#drain();
	}

	/** 只重生成当前回复的非正文格式；正文、账本和后台世界快照均保持不动。 */
	async regenerateCurtain(): Promise<void> {
		if (this.#busy) return;
		const ev = this.#deps.events ?? {};
		this.#busy = true;
		this.#abort = new AbortController();
		ev.onTurnStart?.();
		try {
			const sm = this.#deps.getSessionManager();
			const branch = sm.getBranch() as BranchEntryLike[];
			let target: BranchEntryLike | undefined;
			for (let i = branch.length - 1; i >= 0; i--) {
				const entry = branch[i];
				const details = entry.message?.details;
				if (entry.type === "message" && entry.message?.role === "assistant" && details && typeof details === "object" && typeof (details as Record<string, unknown>).rpNarrative === "string") {
					target = entry;
					break;
				}
			}
			if (!target?.id || !target.message?.details || typeof target.message.details !== "object") {
				ev.onNotify?.("error", "当前分支没有可重生成状态栏的正文。");
				return;
			}
			const details = target.message.details as Record<string, unknown>;
			const narrative = String(details.rpNarrative ?? "").trim();
			if (!narrative) {
				ev.onNotify?.("error", "当前回复没有独立正文工件。");
				return;
			}
			const materials = loadStageMaterials(this.#deps.cwd);
			const curtainSkill = workflowSkill(materials.skillFiles, "curtain");
			const boundedMaterials = buildCurtainRerollMaterials({ card: materials.card, entries: materials.entries, preset: materials.preset, statusBarFormats: materials.statusBarFormats });
			const systemPrompt = `你在执行梨园的独立格式收尾。正文已经冻结，禁止复述、改写、概括或包裹正文。只生成 materials.formatPlan.modelTags；deterministicTags 由代码补齐，nativeTags 由梨园权威状态投影，forbiddenTags 禁止输出。不得借用历史回复或其他角色卡的格式。输出完整闭合后立即结束。\n\n# 工作流 Skill\n${curtainSkill?.body ?? "严格依据 formatPlan 生成当前卡要求的模型格式。"}`;
			const userText = JSON.stringify({
				materials: boundedMaterials,
				frozen_narrative: narrative,
				current_state: stateFromBranch(branch),
				current_world: literaryWorldFromBranch(branch),
				previous_curtain: typeof details.rpCurtain === "string" ? details.rpCurtain : "",
			}, null, 2);
			ev.onActivity?.(`状态栏重Roll素材：${userText.length.toLocaleString()} 字（已裁剪，未送料 rawCard/完整世界书）`);
			ev.onActivity?.("状态栏重Roll：复用正文，仅重做非正文格式");
			// 不替用户决定思考档：省略 reasoning，让 writer 模型完全采用上游默认行为。
			const result = await this.#sideText("writer", systemPrompt, userText, 32768, undefined);
			if (typeof result !== "string") {
				ev.onNotify?.("error", `状态栏重Roll失败：${result.error}`);
				return;
			}
			const nextCurtain = finalizeCurtainText(result, boundedMaterials.formatPlan);
			// 只接受像完整交付的结果。上游默认思考偶尔会只吐出一个起始“<”；
			// 这种截断不能覆盖当前可用状态栏，更不能落树永久污染刷新结果。
			const tagStack: string[] = [];
			for (const match of nextCurtain.matchAll(/<\/?([A-Za-z][\w:-]*)\b[^>]*>/g)) {
				const full = match[0];
				const name = match[1].toLowerCase();
				if (/^<\//.test(full)) {
					if (tagStack[tagStack.length - 1] === name) tagStack.pop();
				} else if (!/\/>$/.test(full) && !["br", "hr", "img", "input", "meta", "link"].includes(name)) {
					tagStack.push(name);
				}
			}
			if (nextCurtain.length < 8 || nextCurtain === "<" || tagStack.length > 0) {
				ev.onNotify?.("error", "状态栏重Roll结果不完整，已保留原状态栏。系统不会自动重试；如需再试，请手动点击“重Roll状态栏”。");
				return;
			}
			if (sm.getLeafId() !== branch[branch.length - 1]?.id) {
				ev.onNotify?.("warning", "状态栏结果已丢弃：生成期间切换了分支。");
				return;
			}
			sm.appendCustomEntry("rp-curtain-override", {
				targetEntryId: target.id,
				curtain: nextCurtain,
				createdAt: Date.now(),
			});
			sm.flush();
			ev.onActivity?.("状态栏已生成新版本");
		} catch (error) {
			ev.onNotify?.("error", `状态栏重Roll失败：${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.#abort = null;
			this.#busy = false;
			// 没有新正文 entryId：宿主据此不会把状态栏重Roll误当成新剧情归档。
			ev.onTurnEnd?.({ aborted: false });
		}
	}

	/** 强制停止本拍：已流出的部分正文仍落树可见 */
	abort(): void {
		this.#abort?.abort();
		const queued = this.#queue.splice(0);
		for (const item of queued) item.reject(new Error("本拍已停止，排队输入已取消"));
	}

	async #drain(): Promise<void> {
		while (this.#queue.length > 0 && !this.#busy) {
			const next = this.#queue.shift();
			if (!next) continue;
			const sm = this.#deps.getSessionManager();
			if (sm.getSessionId() !== next.sessionId || loadStageConfig(this.#deps.cwd).card !== next.cardPath) {
				next.reject(new Error("排队期间切换了会话或角色卡，输入已取消"));
				continue;
			}
			try { await this.#run(next.text); next.resolve(); } catch (error) { next.reject(error); }
		}
	}

	#consumeEcologyPoolPrep(cardPath: string, cardName: string): void {
		const candidate = this.#ecologyPoolReady;
		if (!candidate) return;
		if (candidate.cardPath !== cardPath) { this.#ecologyPoolReady = null; return; }
		this.#ecologyPoolReady = null;
		this.#ecologyPoolWrite = this.#ecologyPoolWrite.then(() => {
			// 重新读取最新池再合并，避免覆盖 aftermath 刚累计的 useCount。
			const latest = loadEcologyPools(this.#deps.cwd, cardPath, cardName);
			const global = normalizeEcologyGlobalPool(candidate.pools.global, latest.global) ?? latest.global;
			const card = normalizeEcologyCardPool(candidate.pools.card, latest.card) ?? latest.card;
			saveEcologyPools(this.#deps.cwd, cardPath, { global, card });
			for (const warning of candidate.warnings) this.#deps.events?.onActivity?.(warning);
			this.#deps.events?.onActivity?.(`鲜活世界备料完成：全局 ${global.prototypes.length} 原型 / 本卡 ${card.templates.length} 模板`);
		}).catch(() => undefined);
	}

	#branchContains(branch: BranchEntryLike[], entryId: string): boolean {
		return branch.some((entry) => entry.id === entryId);
	}

	/** 下一拍采用已完成的文学画像；尚在运行就继续用旧画像，不等待。 */
	#consumeLiteraryProfileReady(cardPath: string): void {
		const ready = this.#literaryProfileReady;
		if (!ready) return;
		const sm = this.#deps.getSessionManager();
		if (ready.sessionId !== sm.getSessionId() || ready.cardPath !== cardPath || !this.#branchContains(sm.getBranch() as BranchEntryLike[], ready.sourceLeafId)) {
			this.#literaryProfileReady = null;
			return;
		}
		sm.appendCustomEntry(LITERARY_PROFILE_ENTRY_TYPE, ready.data);
		sm.flush();
		this.#literaryProfileReady = null;
		this.#deps.events?.onActivity?.("文学画像：后台候选已在本拍采用");
	}

	#startLiteraryProfilePrep(materials: StageMaterials, branch: BranchEntryLike[]): void {
		if (this.#literaryProfilePrepRunning || this.#literaryProfileReady) return;
		const { config, card } = materials;
		if (config.literaryQuality !== "profile" && config.literaryQuality !== "guided") return;
		if (!shouldRefreshLiteraryProfile(branch, config.literaryProfileEveryNTurns ?? 8)) return;
		const sm = this.#deps.getSessionManager();
		const sourceLeafId = sm.getLeafId();
		if (!sourceLeafId) return;
		const sessionId = sm.getSessionId();
		const { history, summary } = rebuildHistory(branch);
		const state = stateFromBranch(branch);
		const previous = literaryProfileFromBranch(branch);
		const characterPrompt = buildCharacterProfilePrompt({ card, state, summary, history, userName: config.userName });
		const personaPrompt = buildPersonaProfilePrompt({ userPersona: config.userPersona, userMessages: history.filter((message) => message.role === "user").map((message) => message.text), summary, recentStory: history, userName: config.userName });
		this.#literaryProfilePrepRunning = true;
		this.#deps.events?.onActivity?.("文学画像：已在后台更新，完成后下一拍生效");
		void Promise.all([
			this.#sideText("literaryCharacter", `${characterPrompt.systemPrompt}\n\n# 工作流 skill：Sogon\n${workflowSkill(materials.skillFiles, "character")?.body ?? ""}`, characterPrompt.userText, 8192, "off", undefined),
			this.#sideText("literaryPersona", `${personaPrompt.systemPrompt}\n\n# 工作流 skill：Sigon\n${workflowSkill(materials.skillFiles, "persona")?.body ?? ""}`, personaPrompt.userText, 6144, "off", undefined),
		]).then(([characterResult, personaResult]) => {
			const warnings: string[] = [];
			const character = typeof characterResult === "string" ? normalizeLiteraryArtifact(characterResult, 16_000) : (warnings.push(`角色画像：${characterResult.error}`), previous?.character);
			const persona = typeof personaResult === "string" ? normalizeLiteraryArtifact(personaResult, 10_000) : (warnings.push(`用户画像：${personaResult.error}`), previous?.persona);
			if (character || persona) this.#literaryProfileReady = { sessionId, cardPath: config.card, sourceLeafId, data: { version: 1, sourceLeafId, completedTurns: countCompletedNarrativeTurns(branch), ...(character ? { character } : {}), ...(persona ? { persona } : {}), ...(warnings.length ? { warnings } : {}) } };
		}).catch((error) => console.error(`[stage-literary-profile] 后台更新失败：${error instanceof Error ? error.message : String(error)}`)).finally(() => { this.#literaryProfilePrepRunning = false; });
	}

	#consumeWorldProfileReady(materials: StageMaterials): void {
		const ready = this.#worldProfileReady;
		if (!ready) return;
		const sm = this.#deps.getSessionManager();
		const branch = sm.getBranch() as BranchEntryLike[];
		if (ready.sessionId !== sm.getSessionId() || ready.cardPath !== materials.config.card || !this.#branchContains(branch, ready.sourceLeafId)) {
			this.#worldProfileReady = null;
			return;
		}
		saveCardWorldProfile(this.#deps.cwd, materials.config.card, ready.profile, materials.card);
		if (!worldManifestFromBranch(branch, ready.profile.cardKey)) sm.appendCustomEntry(WORLD_MANIFEST_ENTRY_TYPE, manifestFromProfile(ready.profile));
		sm.flush();
		this.#worldProfileReady = null;
		this.#deps.events?.onActivity?.("角色卡世界画像：后台候选已在本拍采用");
	}

	#startWorldProfilePrep(materials: StageMaterials, branch: BranchEntryLike[]): void {
		if (this.#worldProfilePrepRunning || this.#worldProfileReady || materials.config.literaryWorldEnabled !== true) return;
		const { config, card } = materials;
		const fingerprint = worldProfileFingerprint({ card, entries: materials.entries, preset: materials.preset, greetingIndex: config.greetingIndex });
		const profile = loadCardWorldProfile(this.#deps.cwd, config.card, card.name, fingerprint, card);
		if (!profileNeedsAnalysis(profile, fingerprint, countCompletedNarrativeTurns(branch))) return;
		const skill = workflowSkill(materials.skillFiles, "world-profile");
		const sm = this.#deps.getSessionManager();
		const sourceLeafId = sm.getLeafId();
		if (!skill || !sourceLeafId) return;
		const sessionId = sm.getSessionId();
		const prompt = buildWorldProfilePrompt({ skillBody: skill.body, card, entries: materials.entries, preset: materials.preset, greetingIndex: config.greetingIndex, previous: profile, recentHistory: rebuildHistory(branch).history });
		this.#worldProfilePrepRunning = true;
		this.#deps.events?.onActivity?.("角色卡世界画像：已在后台分析，完成后下一拍生效");
		void this.#sideText("worldProfile", prompt.systemPrompt, prompt.userText, 12288, "off", undefined).then((result) => {
			if (typeof result !== "string") { this.#deps.events?.onActivity?.(`角色卡世界画像：后台分析失败（${result.error}）`); return; }
			const base = profile ?? defaultCardWorldProfile(this.#deps.cwd, config.card, card.name, fingerprint, card);
			const next = normalizeCardWorldProfile(result, base, { preserveStatus: !!profile, sourceFingerprint: fingerprint, analyzedTurns: countCompletedNarrativeTurns(branch) });
			if (next) {
				// 卡级画像不是分支运行态，生成成功即原子落盘；Manifest 仍在下一拍按来源叶采用。
				saveCardWorldProfile(this.#deps.cwd, config.card, next, card);
				this.#worldProfileReady = { sessionId, cardPath: config.card, sourceLeafId, profile: next };
			} else this.#deps.events?.onActivity?.("角色卡世界画像：输出不可解析，未覆盖旧画像");
		}).catch((error) => console.error(`[world-profile] 后台分析失败：${error instanceof Error ? error.message : String(error)}`)).finally(() => { this.#worldProfilePrepRunning = false; });
	}

	#startEcologyPoolPrep(input: {
		cardPath: string;
		card: StageMaterials["card"];
		entries: StageMaterials["entries"];
		state: ReturnType<typeof stateFromBranch>;
		history: ReturnType<typeof rebuildHistory>["history"];
		userText: string;
		userName: string;
		globalSkill: NonNullable<ReturnType<typeof workflowSkill>>;
		cardSkill: NonNullable<ReturnType<typeof workflowSkill>>;
		pools: ReturnType<typeof loadEcologyPools>;
		signal?: AbortSignal;
	}): void {
		if (this.#ecologyPoolPrep || this.#ecologyPoolReady) return;
		const task = (async () => {
			let pools = input.pools;
			const warnings: string[] = [];
			const queryPrompt = buildEcologySearchPlanPrompt(input.globalSkill.body, { global: pools.global, card: input.card, state: input.state, userText: input.userText, userName: input.userName });
			const queryResult = await this.#sideText("ecologySearch", queryPrompt.systemPrompt, queryPrompt.userText, 2048, "off", input.signal);
			if (typeof queryResult !== "string") warnings.push(`鲜活世界备料：检索规划失败（${queryResult.error}）`);
			const queries = typeof queryResult === "string" ? ecologySearchQueries(queryResult) : [];
			const batches: Promise<import("../tools/web-research.ts").WebResearchItem[]>[] = [];
			if (this.#deps.webResearch) {
				for (let index = 0; index < queries.length; index += 3) {
					batches.push(this.#deps.webResearch(queries.slice(index, index + 3), 5, input.signal).catch(() => []));
				}
			}
			const research = (await Promise.all(batches)).flat();
			const usable = research.filter((item) => (item.results?.length ?? 0) > 0);
			if (usable.length) {
				const prompt = buildEcologyGlobalPrompt(input.globalSkill.body, { global: pools.global, research: usable, card: input.card, userText: input.userText });
				const result = await this.#sideText("ecologyGlobal", prompt.systemPrompt, prompt.userText, 16384, "off", input.signal);
				if (typeof result === "string") pools = { ...pools, global: normalizeEcologyGlobalPool(result, pools.global) ?? pools.global };
				else warnings.push(`鲜活世界备料：全局池失败（${result.error}）`);
			} else warnings.push("鲜活世界备料：本拍搜索无有效结果，保留全局池");
			const cardPrompt = buildEcologyCardPrompt(input.cardSkill.body, { global: pools.global, cardPool: pools.card, card: input.card, lore: input.entries, state: input.state, history: input.history });
			const cardResult = await this.#sideText("ecologyCard", cardPrompt.systemPrompt, cardPrompt.userText, 16384, "off", input.signal);
			if (typeof cardResult === "string") pools = { ...pools, card: normalizeEcologyCardPool(cardResult, pools.card) ?? pools.card };
			else warnings.push(`鲜活世界备料：角色卡池失败（${cardResult.error}）`);
			return { cardPath: input.cardPath, cardName: input.card.name, pools, warnings };
		})().catch((error) => ({ cardPath: input.cardPath, cardName: input.card.name, pools: input.pools, warnings: [`鲜活世界备料异常：${error instanceof Error ? error.message : String(error)}`] }));
		this.#ecologyPoolPrep = task;
		void task.then((candidate) => {
			if (this.#ecologyPoolPrep === task) {
				this.#ecologyPoolReady = candidate;
				this.#ecologyPoolPrep = null;
			}
		});
	}

	async #run(userText: string | null, rerollPrep?: StageRerollPrep): Promise<void> {
		const ev = this.#deps.events ?? {};
		this.#busy = true;
		ev.onTurnStart?.();
		let endInfo: StageTurnEndInfo = { aborted: false };
		try {
			endInfo = await this.#turn(userText, rerollPrep);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			ev.onNotify?.("error", `本拍开演失败：${msg}`);
			endInfo = { aborted: false, error: msg };
		} finally {
			this.#busy = false;
			this.#abort = null;
			ev.onTurnEnd?.(endInfo);
		}
	}

	async #turn(userText: string | null, rerollPrep?: StageRerollPrep): Promise<StageTurnEndInfo> {
		const { cwd, events: rawEv = {} } = this.#deps;
		const turnStartedAt = Date.now();
		const sm = this.#deps.getSessionManager();
		const beatLog: Array<{ ts: number; ev: string; data: string }> = [];
		const _blog = (event: string, data: string) => beatLog.push({ ts: Date.now(), ev: event, data });
		const ev: typeof rawEv = {
			...rawEv,
			onDelta: (kind, delta, draft, reset) => { _blog(draft ? "draft_delta" : kind === "thinking" ? "thinking" : "text", delta); rawEv.onDelta?.(kind, delta, draft, reset); },
			onStreamClear: () => { _blog("stream_clear", ""); rawEv.onStreamClear?.(); },
			onDraftResync: (segments) => { _blog("draft_resync", segments.join("\n---\n")); rawEv.onDraftResync?.(segments); },
			onActivity: (detail) => { _blog("activity", detail); rawEv.onActivity?.(detail); },
			onNotify: (level, text) => { _blog("notify", `[${level}] ${text}`); rawEv.onNotify?.(level, text); },
		};

		// 素材现读：改卡/改预设/挂书即时生效
		const materials = loadStageMaterials(cwd);
		const { config, card } = materials;
		// 非关键候选只消费已经完成的结果；尚未完成就沿用旧工件，绝不等它们出正文。
		if (!rerollPrep) {
			this.#consumeWorldProfileReady(materials);
			this.#consumeLiteraryProfileReady(config.card);
			// 生态双池同样不等待：后台尚未完成时，本拍继续用磁盘现有池。
			this.#consumeEcologyPoolPrep(config.card, card.name);
		}
		if (materials.macroWarnings.length > 0) {
			const key = materials.macroWarnings.join(",");
			if (key !== this.#warnedMacros) {
				this.#warnedMacros = key;
				ev.onNotify?.("warning", `预设含未支持的宏（已置空处理）：${materials.macroWarnings.join("、")}`);
			}
		}

		const baseModel = this.#deps.getModel();
		if (!baseModel) {
			ev.onNotify?.("error", "尚未配置剧情模型——请先在「连接」面板选择模型。");
			return { aborted: false, error: "no-model" };
		}
		// 主演插头（writer）：正文生成可单独指定高级模型；未配置则继承剧情总插头。
		// 旁路步骤（场记/压缩/导演等）走各自插头，不受这里影响。
		const resolved = resolveStepModel(
			"writer",
			config.stepModels,
			baseModel,
			(provider, id) => this.#deps.findModel?.(provider, id),
			(id) => this.#deps.findModelById?.(id),
		);
		const model = resolved.model ?? baseModel;
		if (resolved.fallback && resolved.requested) {
			const key = `writer:${resolved.requested.provider}/${resolved.requested.id}`;
			if (!this.#warnedSideModelFallbacks.has(key)) {
				this.#warnedSideModelFallbacks.add(key);
				ev.onNotify?.("warning", `主演插头配置的模型 ${resolved.requested.provider}/${resolved.requested.id} 不可用，本次已继承剧情总插头。`);
			}
		}
		this.#abort = new AbortController();

		let expectedTurnLeafId = sm.getLeafId();
		if (userText !== null) {
			expectedTurnLeafId = sm.appendMessage(nowMsg(userText));
		}
		// 上下文 = f(分支)
		let branch = sm.getBranch() as BranchEntryLike[];
		// 卡级画像已存在但当前分支尚无 Manifest 时，直接播种；这不是模型分析，不应依赖 ready 候选。
		const profileFingerprint = worldProfileFingerprint({ card, entries: materials.entries, preset: materials.preset, greetingIndex: config.greetingIndex });
		const existingWorldProfile = loadCardWorldProfile(cwd, config.card, card.name, profileFingerprint, card);
		if (config.literaryWorldEnabled === true && existingWorldProfile && !worldManifestFromBranch(branch, existingWorldProfile.cardKey)) {
			sm.appendCustomEntry(WORLD_MANIFEST_ENTRY_TYPE, manifestFromProfile(existingWorldProfile));
			sm.flush();
			branch = sm.getBranch() as BranchEntryLike[];
			expectedTurnLeafId = sm.getLeafId();
			ev.onActivity?.("角色卡世界画像：已为当前分支采用现有画像");
		}
		if (!rerollPrep) {
			this.#startWorldProfilePrep(materials, branch);
			this.#startLiteraryProfilePrep(materials, branch);
		}
		const state = stateFromBranch(branch);
		const { history, lastUserText, lastNarrativeText, summary } = rebuildHistory(branch, materials.promptRules);
		const literaryProfile = literaryProfileFromBranch(branch);
		let literaryEcology = literaryEcologyFromBranch(branch);
		const worldManifest = worldManifestFromBranch(branch, existingWorldProfile?.cardKey);
		const modularWorld = modularWorldFromBranch(branch, worldManifest);
		const adaptiveWorldEnabled = config.literaryWorldEnabled === true && !!worldManifest;
		let literaryDirectionData = rerollPrep?.literaryDirectionData;
		let literaryDirection = rerollPrep?.literaryDirection;
		const directorRequested = !rerollPrep && config.literaryQuality === "guided" && !isBackstageText(lastUserText);
		if (!history.some((m) => m.role === "user")) {
			ev.onNotify?.("error", "没有可开演的用户输入。");
			return { aborted: false, error: "no-user-input" };
		}

		const languageMismatch = lastNarrativeText
			? detectsLanguageMismatch(lastNarrativeText, config.language)
			: false;
		const windowText = history
			.slice(-config.scanDepth)
			.map((m) => m.text)
			.join("\n");
		const activated = scanEntries(materials.entries, windowText, config.maxLoreInjections);

		// 面板快照（M1 读磁盘缓存；写侧与分支化随 M3）
		let panelIndex: string | undefined;
		try {
			const panels = loadPanels(join(dir(cwd, "artifacts"), `${sm.getSessionId()}.json`));
			panelIndex = formatPanelSnapshot(panels) ?? formatPanelIndex(panels) ?? undefined;
		} catch {
			panelIndex = undefined;
		}

		// 旧会话遗留的戏外轮：不注预设末端模板（不按剧情模板硬写）
		const legacyBackstage = !!lastUserText && isBackstageText(lastUserText);
		const ecologyGlobalSkill = workflowSkill(materials.skillFiles, "ecology-global");
		const ecologyCardSkill = workflowSkill(materials.skillFiles, "ecology-card");
		const ecologyRuntimeSkill = workflowSkill(materials.skillFiles, "ecology-runtime");
		let ecologyPools = loadEcologyPools(cwd, config.card, card.name);
		if (false && !rerollPrep && config.literaryEcologyEnabled === true && !legacyBackstage && ecologyGlobalSkill && ecologyCardSkill && ecologyRuntimeSkill) {
			const sourceLeafId = sm.getLeafId();
			if (sourceLeafId) {
				ev.onActivity?.("鲜活世界：搜索素材并更新双池");
				const queryPrompt = buildEcologySearchPlanPrompt(ecologyGlobalSkill.body, { global: ecologyPools.global, card, state, userText: lastUserText, userName: config.userName });
				const queryResult = await this.#sideText("ecologySearch", queryPrompt.systemPrompt, queryPrompt.userText, 2048);
				if (typeof queryResult !== "string") ev.onActivity?.(`鲜活世界：检索规划失败（${queryResult.error}）`);
				const queries = typeof queryResult === "string" ? ecologySearchQueries(queryResult) : [];
				const research = [] as import("../tools/web-research.ts").WebResearchItem[];
				if (queries.length && this.#deps.webResearch) {
					for (let index = 0; index < queries.length; index += 3) {
						const batch = await this.#deps.webResearch(queries.slice(index, index + 3), 5, this.#abort.signal).catch(() => []);
						research.push(...batch);
					}
				}
				const usableResearch = research.filter((item) => (item.results?.length ?? 0) > 0);
				if (usableResearch.length) {
					const globalPrompt = buildEcologyGlobalPrompt(ecologyGlobalSkill.body, { global: ecologyPools.global, research: usableResearch, card, userText: lastUserText });
					const globalResult = await this.#sideText("ecologyGlobal", globalPrompt.systemPrompt, globalPrompt.userText, 16384);
					if (typeof globalResult === "string") {
						const next = normalizeEcologyGlobalPool(globalResult, ecologyPools.global);
						if (next) ecologyPools = { ...ecologyPools, global: next };
						else ev.onActivity?.("鲜活世界：全局原型池输出不可解析，保留旧池");
					} else ev.onActivity?.(`鲜活世界：全局原型池更新失败（${globalResult.error}）`);
				} else {
					ev.onActivity?.("鲜活世界：本拍没有可用搜索结果，保留全局原型池");
				}
				const cardPrompt = buildEcologyCardPrompt(ecologyCardSkill.body, { global: ecologyPools.global, cardPool: ecologyPools.card, card, lore: materials.entries, state, history });
				const cardResult = await this.#sideText("ecologyCard", cardPrompt.systemPrompt, cardPrompt.userText, 16384);
				if (typeof cardResult === "string") {
					const next = normalizeEcologyCardPool(cardResult, ecologyPools.card);
					if (next) ecologyPools = { ...ecologyPools, card: next };
					else ev.onActivity?.("鲜活世界：角色卡生态池输出不可解析，保留旧池");
				} else ev.onActivity?.(`鲜活世界：角色卡生态池更新失败（${cardResult.error}）`);
				const arrivalPrompt = buildEcologyRuntimePrompt(ecologyRuntimeSkill.body, { phase: "arrival", ecology: literaryEcology, global: ecologyPools.global, cardPool: ecologyPools.card, state, history, userText: lastUserText });
				const arrivalResult = await this.#sideText("ecologyRuntime", arrivalPrompt.systemPrompt, arrivalPrompt.userText, 16384);
				if (sm.getLeafId() === sourceLeafId) {
					if (typeof arrivalResult === "string") {
						const next = normalizeLiteraryEcologyState(arrivalResult, literaryEcology);
						if (next) literaryEcology = next;
						else ev.onActivity?.("鲜活世界：拍前生态输出不可解析，沿用上一快照");
					} else ev.onActivity?.(`鲜活世界：拍前生态失败（${arrivalResult.error}），沿用上一快照`);
					saveEcologyPools(cwd, config.card, ecologyPools);
				} else {
					ev.onActivity?.("鲜活世界拍前结果已丢弃（期间切换了分支）");
				}
			}
		}
		let literaryContinuity: LiteraryContinuity | undefined = rerollPrep?.literaryContinuity;
		const prepLeafId = sm.getLeafId();
		const arrivalRequested = !rerollPrep && config.literaryEcologyEnabled === true && !legacyBackstage && !!ecologyRuntimeSkill;
		const continuityRequested = !rerollPrep && config.literaryQuality === "guided" && !legacyBackstage && shouldRunContinuity({ state, history, summary, userText: lastUserText });
		const arrivalPromise: Promise<LiteraryEcologyState | undefined> = arrivalRequested
			? Promise.resolve().then(async () => {
				ev.onActivity?.("鲜活世界：匹配当前人物与场所");
				const prompt = buildEcologyRuntimePrompt(ecologyRuntimeSkill.body, { phase: "arrival", ecology: literaryEcology, global: ecologyPools.global, cardPool: ecologyPools.card, state, history, userText: lastUserText });
				const result = await this.#sideText("ecologyRuntime", prompt.systemPrompt, prompt.userText, 16384);
				if (typeof result !== "string") { ev.onActivity?.(`鲜活世界：拍前生态失败（${result.error}），沿用上一快照`); return undefined; }
				const parsed = normalizeLiteraryEcologyState(result, literaryEcology);
				if (!parsed) { ev.onActivity?.("鲜活世界：拍前生态输出不可解析，沿用上一快照"); return undefined; }
				const errors = validateEcologyTransition(literaryEcology, parsed, worldSignalsForEcology(modularWorld));
				if (errors.length) { ev.onActivity?.(`鲜活世界：拍前生态候选被拒绝（${errors.join("；")}），沿用上一快照`); return undefined; }
				return parsed;
			})
			: Promise.resolve(undefined);
		const continuityPromise: Promise<LiteraryContinuity | undefined> = continuityRequested
			? Promise.resolve().then(async () => {
				ev.onActivity?.("文学连续性：补充当前场景约束");
				const prompt = buildLiteraryContinuityPrompt({
					state,
					history,
					summary,
					activatedLore: activated,
					userText: lastUserText,
					charName: card.name,
					userName: config.userName,
				});
				const result = await this.#sideText(
					"literaryContinuity",
					`${prompt.systemPrompt}\n\n# 工作流 skill：文学连续性\n${workflowSkill(materials.skillFiles, "continuity")?.body ?? ""}`,
					prompt.userText,
					2048,
				);
				if (typeof result !== "string") { ev.onActivity?.(`文学连续性：生成失败（${result.error}），本拍无补充工件`); return undefined; }
				const parsed = parseLiteraryContinuity(result);
				if (!parsed) ev.onActivity?.("文学连续性：输出不可解析，本拍无补充工件");
				return parsed;
			})
			: Promise.resolve(undefined);
		const [arrivalCandidate, continuityCandidate] = await Promise.all([arrivalPromise, continuityPromise]);
		if (sm.getLeafId() === prepLeafId) {
			if (arrivalCandidate) literaryEcology = arrivalCandidate;
			if (continuityCandidate) literaryContinuity = continuityCandidate;
		} else {
			ev.onActivity?.("拍前生态/连续性结果已丢弃（期间切换了分支）");
		}
		if (!rerollPrep && config.literaryEcologyEnabled === true && !legacyBackstage && ecologyGlobalSkill && ecologyCardSkill) {
			const poolSignal = new AbortController();
			this.#startEcologyPoolPrep({ cardPath: config.card, card, entries: materials.entries, state, history, userText: lastUserText, userName: config.userName, globalSkill: ecologyGlobalSkill, cardSkill: ecologyCardSkill, pools: ecologyPools, signal: poolSignal.signal });
			ev.onActivity?.("鲜活世界：已在后台搜索并准备下一拍素材");
		}
		if (directorRequested) {
			ev.onActivity?.("文学导演：规划当前单拍边界");
			const sourceLeafId = sm.getLeafId();
			const prompt = buildLiteraryDirectorPrompt({
				state,
				history,
				summary,
				literaryProfile,
				continuity: literaryContinuity,
				ecology: config.literaryEcologyEnabled === true ? formatLiteraryEcologyInjection(literaryEcology) : undefined,
				activatedLore: activated,
				userText: lastUserText,
				charName: card.name,
				userName: config.userName,
			});
			const result = await this.#sideText(
				"literaryDirector",
				`${prompt.systemPrompt}\n\n# 工作流 skill：拍前导演\n${workflowSkill(materials.skillFiles, "director")?.body ?? ""}`,
				prompt.userText,
				2048,
			);
			if (sm.getLeafId() === sourceLeafId && typeof result === "string") {
				literaryDirectionData = parseLiteraryDirection(result) ?? undefined;
				literaryDirection = literaryDirectionData ? formatLiteraryDirection(literaryDirectionData) : undefined;
			} else if (typeof result !== "string") {
				ev.onActivity?.(`文学导演：生成失败（${result.error}），主演将无导演工件继续`);
			}
		}

		// 历史后段每拍重装（{{lastusermessage}} 在此生效）：原文原序直通末端，不再拆层。
		const phAll = legacyBackstage ? [] : (assemblePresetAfter(materials, lastUserText) ?? []);
		// M-C2：外部插件协议条目退场（世界书/卡内嵌通道 H 类）——每套组合只播报一次
		if (materials.protocolDrops.length > 0) {
			const key = materials.protocolDrops.map((d) => `${d.family}:${d.title}`).join("|");
			if (key !== this.#warnedProtocolDrop) {
				this.#warnedProtocolDrop = key;
				const chars = materials.protocolDrops.reduce((n, d) => n + d.chars, 0);
				const titles = materials.protocolDrops.map((d) => `${d.label}「${d.title}」`).join("、");
				console.error(
					`[stage] 外部插件协议退场：${materials.protocolDrops.length} 条 / ${chars} 字（${titles}）——梨园以工具记账，无需模型手写格式块`,
				);
			}
		}

		// 装配报告落盘（PLAN §5.3 可视化）：装载期静态面 + 本拍历史后段；内容变了才写
		this.#writeAssemblyReport(cwd, materials, phAll);

		// M-A 工具组。预设 D/E 方法论直接作为本拍写作指导，不再制造 skill_read 工具轮。
		// 回合工作区 = 正文工件的落点；字数目标在此提取一次（数据，供末端注入）。
		// 读侧依赖先建：统一层按注入情况决定哪些世界书工具上清单（M-D2）。
		// 可读名单：拉取档 skill 文件（常驻档已随 system 全文送达，不重复上单）+ 进口 topic 包。
		// 必定读取（每轮）skill：受理门强制落笔前先读（认 frontmatter `每轮` 标志，不认具体名字）
		const forcedSkills = materials.skillFiles.filter((f) => f.everyBeat).map((f) => f.name);
		const skillNames = materials.skillFiles.filter((f) => !f.resident).map((f) => f.name);
		const readDeps = this.#toolDeps(lastUserText);
		// MCP 外设（8/06 重接）：hub 里本会话已连接的工具并入清单。
		// 空数组＝没启用/没连上，与「未注入 mcp 依赖」同效——都不上清单。
		const mcpTools = mcpStageTools(this.#deps.mcp);
		// 媒体交付（8/06 重接）：tts 另需服务端环境，未就绪不上清单
		const mediaOpts = { tts: this.#deps.ttsAvailable?.() === true };
		const mediaTools = this.#deps.media ? mediaStageTools(config.language, mediaOpts) : [];
		// 助手委托（8/06 重接）：runner 未注册时不上清单
		const assistantTool = assistantStageTool();
		// P7：ask 工具依赖宿主注入 askUser（选择卡通道）；未注入则从清单剔除
		const askEnabled = !!this.#deps.askUser;
		const ws = createWorkspace();
		const wsDeps: WorkspaceDeps = {
			rules: extractDraftRules([...materials.presetRuleTexts, ...phAll.map((b) => b.text)]),
			userName: config.userName,
			charName: card.name,
			baseState: state,
			loreEntries: materials.entries,
		};
		const tools = [
			...stageTools(config.language, readDeps),
			...(skillNames.length > 0 ? [skillReadTool(config.language, skillNames)] : []),
			...writeTools(config.language, planStepBudget(wsDeps.rules.wordRange)).filter((t) => t.name !== "ask" || askEnabled),
			...mediaTools,
			...(assistantTool ? [assistantTool] : []),
			...mcpTools,
		];

		const systemPrompt = buildStageSystemPrompt({
			card,
			config,
			constantLore: constantLoreOf(materials),
			// 预设装配段：原文原序，marker 已按预设作者的位置填入梨园材料
			presetBefore: materials.presetBefore.map((p) => p.text),
			declaredMarkers: materials.declaredMarkers,
			// skill 素材位（M-R2）：常驻包全文 + 拉取包 L1 索引，无包零痕迹
			skills: materials.skillFiles,
			tools: tools.length > 0,
			// MCP 外设索引进 system（不进每拍注入）：会话内字节稳定，不破前缀缓存。
			// 与旧 director.ts 同一位置——工具清单里有 mcp__ 工具，这里说明它们是什么。
			mcpTools: mcpTools.map((t) => ({ name: t.name, description: t.description })),
		});
		const injection = buildStageInjection({
			state,
			activatedLore: activated,
			card,
			config,
			presetTail: phAll.map((p) => p.text),
			languageMismatch,
			panelIndex,
			...(wsDeps.rules.wordRange ? { wordRange: wsDeps.rules.wordRange } : {}),
			loreIndex: formatLoreIndex(materials.entries),
			rosterIndex: formatRosterIndex(state),
			literaryCharacterProfile: literaryProfile?.character,
			literaryPersonaProfile: literaryProfile?.persona,
			literaryDirection,
			literaryWorld: adaptiveWorldEnabled ? formatModularWorldInjection(modularWorld, worldManifest) : undefined,
			literaryEcology: config.literaryEcologyEnabled === true ? formatLiteraryEcologyInjection(literaryEcology) : undefined,
			writerGuidance: [
				...materials.writerGuidance,
				...(workflowSkill(materials.skillFiles, "writer")
					? [{ topic: "主演工作流 skill", text: workflowSkill(materials.skillFiles, "writer")!.body }]
					: []),
			],
		});
		const curtainSkill = workflowSkill(materials.skillFiles, "curtain");
		const curtainMaterials = buildCurtainRerollMaterials({ card, entries: materials.entries, preset: materials.preset, statusBarFormats: materials.statusBarFormats });
		const curtain = curtainMaterials.formatPlan.modelTags.length || curtainMaterials.formatPlan.deterministicTags.length
			? `【主演·格式收尾】正文已在稿纸中。只生成 formatPlan.modelTags；deterministicTags 由代码补齐；nativeTags 由梨园权威状态投影；forbiddenTags 禁止输出。不得复述正文。\n\n# 工作流 skill\n${curtainSkill?.body ?? "依据当前卡材料生成非正文格式。"}\n\n# formatPlan\n${JSON.stringify(curtainMaterials, null, 2)}`
			: undefined;

		// 末端消息 = 动态注入 + 本拍用户原话。
		// 顺序要紧：用户当拍的话必须落在**整个上下文的最后一句**。
		// 注入块（世界状态/索引等）压在提问之后时，模型会把提问读成历史里的旧话，
		// 于是既不检索也不正面回应——8/03 实测：同一提问，挪到注入之后立刻触发 lorebook_search。
		const endsWithUser = history[history.length - 1]?.role === "user";
		const past = endsWithUser ? history.slice(0, -1) : history;
		// 规划卡（五注入之一）：每拍第 1 轮随末端注入送达（工作区新建必空），用户话保持最后一句。
		const injWithCard = tools.length > 0 ? `${injection}\n\n${PLAN_CARD}` : injection;
		const tailText = endsWithUser ? `${injWithCard}\n\n${history[history.length - 1].text}` : injWithCard;

		const messages: unknown[] = [
			// M4 前情提要：被 rp-summary 覆盖的早期剧情在此回读（历史里那段已整体不存在）。
			// 以 user 角色打头，措辞与 system「消息流约定」里的【前情提要】对上。
			...(summary
				? [
						{
							role: "user",
							content: [{ type: "text", text: `【前情提要】以下是更早剧情的接力摘要，是既定事实：\n\n${summary}` }],
							timestamp: 0,
						},
					]
				: []),
			...past.map((m) =>
				m.role === "user"
					? { role: "user", content: [{ type: "text", text: m.text }], timestamp: 0 }
					: {
							role: "assistant",
							content: [{ type: "text", text: m.text }],
							api: "openai-completions",
							provider: "history",
							model: "history",
							usage: {
								input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							stopReason: "stop",
							timestamp: 0,
						},
			),
			{ role: "user", content: [{ type: "text", text: tailText }], timestamp: Date.now() },
		];

		const { apiKey, headers } = await this.#deps.getAuth(model);
		const mainCallMaxTokens = mainStageMaxTokens(model, wsDeps.rules.wordRange);
		const firstCallMaxTokens = Math.min(
			FIRST_CALL_MAX_TOKENS,
			typeof model.maxTokens === "number" && model.maxTokens > 0 ? model.maxTokens : FIRST_CALL_MAX_TOKENS,
		);
		const options: Record<string, unknown> = {
			apiKey,
			headers,
			signal: this.#abort.signal,
			sessionId: sm.getSessionId(),
			maxTokens: firstCallMaxTokens,
			maxRetries: MODEL_MAX_RETRIES,
		};
		const thinking = this.#deps.getThinking?.();
		if (thinking) options.reasoning = thinking;
		const samplers = materials.presetDoc?.samplers;
		if (samplers && Object.keys(samplers).length > 0) {
			options.onPayload = (payload: unknown, m: StageModelLike) => {
				if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
				return applyProjectedSamplers(payload as Record<string, unknown>, samplers, {
					provider: m.provider,
					modelId: m.id,
					baseUrl: m.baseUrl,
					api: typeof m.api === "string" ? m.api : undefined,
				});
			};
		}

		let s = this.#deps.streamFn(model, { systemPrompt, messages, tools }, options);
		let final: AssistantMsgLike | null = null;
		let errored: string | undefined;
		let text = "";
		const fwd = this.#draftForwarder(ev);
		let loopTail = "";
		let curtainText = "";
		let interruptedDraft = "";
		// 首轮 writer 若在中途断流（未落任何稿段），自动重发整个请求，避免一次上游故障毁掉整拍。
		// 一旦已有稿段（ws.draft）则保留现有行为（交由 abort 收敛，不无脑重发）。
		for (let writerAttempt = 0; writerAttempt <= MODEL_MAX_RETRIES; writerAttempt++) {
			let eroded = false;
			for await (const e of s) {
				if (e.type === "done") {
					final = e.message ?? null;
				} else if (e.type === "error") {
					final = e.error ?? null;
					errored = final?.errorMessage || "provider error";
					eroded = true;
					break;
				} else if (e.type === "text_delta" && e.delta) {
					text += e.delta;
					ev.onDelta?.("text", e.delta);
				} else if (e.type === "thinking_delta" && e.delta) {
					recordSegment(ws, { kind: "thinking", text: e.delta });
					ev.onDelta?.("thinking", e.delta);
				} else {
					fwd.forward(e);
				}
			}
			// 用户取消：立即停止，不再重发（aborted 半拍仍走既有收敛落树）。
			if (this.#abort?.signal.aborted) break;
			if (!eroded || ws.draft.trim() || writerAttempt >= MODEL_MAX_RETRIES) break;
			// 尚未落稿且断流：带退避重发同一个请求。
			ev.onActivity?.(`主演首次生成中途断流，自动重发（第 ${writerAttempt + 1}/${MODEL_MAX_RETRIES} 次）`);
			await new Promise((r) => setTimeout(r, 400 * Math.min(2 ** writerAttempt, 8)));
			s = this.#deps.streamFn(model, { systemPrompt, messages, tools }, options);
			text = "";
		}

		// 尾巴口径（8/09）：稿落地后的 text 通道产出。稿落地前工具轮的旁白（读题/计划）
		// 不算——旁白曾被 mergeFinalText 当尾巴拼到正文尾部（实弹：读题文字跑进正文）。
		// M-A agent 循环（PLAN-RP-AGENT-EXEC §2.3）：思考→工具→看结果→再思考，直到交稿定稿。
		// 首轮无论 stopReason 都进循环——模型直出正文不调工具时由循环做宽进严出代收（D2）。
		if (final && final.stopReason !== "aborted") {
			// 首次请求即使异常结束，也让开放循环获得一次催稿/恢复机会；后续错误会由 turn 重新写回。
			errored = undefined;
			const loopOptions = { ...options, maxTokens: mainCallMaxTokens };
			const turn = await this.#agentLoop({
				model,
				options: loopOptions,
				systemPrompt,
				messages,
				first: final,
				tools,
				ws,
				wsDeps,
				language: config.language,
				readDeps,
				directText: text,
				// skill_read 名单投影 + 必定读取（每轮）skill 集合（受理门用）
				skillNames,
				forcedSkills,
				_blog,
				...(curtain ? { curtain } : {}),
			});
			if (turn.final) final = turn.final;
			if (turn.errored) errored = turn.errored;
			text += turn.text;
			loopTail = turn.tailText ?? turn.text;
			curtainText = turn.curtainText ?? "";
			interruptedDraft = turn.pendingDraft ?? "";
		}

		let aborted = final?.stopReason === "aborted" || this.#abort?.signal.aborted === true;
		if (errored && ws.draft.trim() && final) {
			final = { ...final, stopReason: "aborted" };
			aborted = true;
		}
		if (!text) text = textOfAssistant(final);

		// M-E 兜底封笔：分段续写完但模型始终没调 draft_seal（催告已给过一轮）。
		// 8/10 起封笔只是状态切换（验收已整体退役），此处仅补齐工件状态。
		if (ws.appends > 0 && !ws.sealed && ws.draft.trim()) {
			runWriteTool(ws, wsDeps, "draft_seal", {});
		}

		// 定稿 = 工作区稿（工件）；工作区空（中断半拍/循环认栽）退回直出正文
		// **但**模型常把格式栈尾巴（状态栏/catsay 等）走 text 通道而非 draft_write 参数：
		// 二选一会把那部分连内容一起扔掉（8/05 实锤：模型宣告要出「正文+状态栏+咪咪点评」，
		// draft_write 只交了正文，屏上流式见过三样、落树只剩一样）。故此处**合并**：
		// 稿件为主体，text 里**格式特征**的尾巴补回（纯文本闲聊不进正文）。
		const hasFormatPlan = curtainMaterials.formatPlan.modelTags.length > 0 || curtainMaterials.formatPlan.deterministicTags.length > 0;
		if (ws.draft.trim()) {
			if (hasFormatPlan) curtainText = finalizeCurtainText(`${text}\n\n${curtainText}`, curtainMaterials.formatPlan);
			else {
				const merged = mergeFinalText(ws.draft, loopTail || text);
				curtainText = merged.startsWith(ws.draft.trim()) ? merged.slice(ws.draft.trim().length).trim() : "";
			}
		} else curtainText = curtainText.trim();
		const pendingDraft = aborted ? interruptedDraft || fwd.pendingText() : "";
		const narrativeText = aborted
			? [ws.draft.trim(), pendingDraft.trim(), ws.draft.trim() ? "" : mergeFinalText("", text)].filter(Boolean).join("\n\n")
			: ws.draft.trim() || mergeFinalText("", text);
		const finalText = [narrativeText, curtainText].filter(Boolean).join("\n\n");

		// 全流程文字留档：beatLog 时序 + merge 四件全部落进 session JSONL
		_blog("merge_input_draft", ws.draft);
		_blog("merge_input_tail", loopTail);
		_blog("merge_output", finalText);

		// 落树：正文以定稿为准（保留思考块，剥离工具调用轨迹）；纯错误/空拍不落
		let entryId: string | undefined;
		if (!final && aborted && finalText) final = { role: "assistant", content: [], stopReason: "aborted", errorMessage: "Request was aborted" };
		if (final && finalText && sm.getLeafId() === expectedTurnLeafId) {
			const keep = (final.content ?? []).filter((c) => c.type === "thinking");
			// 时间线随 details 持久化：定稿只留最后一稿正文，但用户要看的
			// 「思考→工具→正文」全链在此保住——resyncAll 全量重放与刷新后仍在。
			// 稿段以定稿为准（工作区空时退回直出正文，时间线里也可能没有稿段）。
			const timeline = finalTimeline(ws, finalText);
			// 时间线正文同样分工件：稿段只放 narrative；谢幕作为独立末段原样保留。
			const narrativeTimeline = finalTimeline(ws, narrativeText);
			if (curtainText.trim()) narrativeTimeline.push({ kind: "text", text: curtainText.trim() });
			const prevDetails =
				final.details && typeof final.details === "object" && !Array.isArray(final.details)
					? (final.details as Record<string, unknown>)
					: undefined;
			const thinkingChars = timeline.reduce((n, segment) => n + (segment.kind === "thinking" ? segment.text.length : 0), 0);
			const usage = final.usage as { output?: number } | undefined;
			const outputTokens = typeof usage?.output === "number"
				? usage.output
				: Math.ceil((thinkingChars + finalText.length) / 4);
			const details = {
				...prevDetails,
				...(narrativeTimeline.length ? { rpTimeline: narrativeTimeline } : {}),
				...(narrativeText ? { rpNarrative: narrativeText } : {}),
				...(curtainText.trim() ? { rpCurtain: curtainText.trim() } : {}),
				rpPrep: {
					...(literaryContinuity ? { literaryContinuity } : {}),
					...(literaryDirection ? { literaryDirection } : {}),
					...(literaryDirectionData ? { literaryDirectionData } : {}),
					...(config.literaryEcologyEnabled === true ? { literaryEcology } : {}),
					workflowStatus: {
						continuity: rerollPrep?.literaryContinuity ? "reused" : continuityRequested ? (literaryContinuity ? "success" : "degraded") : "skipped",
						director: rerollPrep && (rerollPrep.literaryDirection || rerollPrep.literaryDirectionData) ? "reused" : directorRequested ? (literaryDirection ? "success" : "degraded") : "skipped",
						ecologyArrival: rerollPrep?.literaryEcology ? "reused" : arrivalRequested ? (arrivalCandidate ? "success" : "degraded") : "skipped",
					},
				},
					rpWorkflow: {
					planWrites: ws.planWrites,
					writes: ws.writes,
					appends: ws.appends,
					budgetReached: ws.appendLimitReached,
					overBudget: ws.overBudget,
					appendRejects: ws.appendRejects,
					edits: ws.edits,
					lookups: ws.lookups,
					skillReads: ws.skillReads,
					rounds: ws.rounds,
					outputTokens,
					durationMs: Date.now() - turnStartedAt,
					firstCallMaxTokens,
					perCallMaxTokens: mainCallMaxTokens,
					textChannelChars: text.length,
					thinkingChars,
					narrativeChars: draftBodyCharsOf(ws),
				},
				...(ws.patchAudit.length ? { rpPatchAudit: ws.patchAudit } : {}),
			};
			entryId = sm.appendMessage({
				...final,
				content: [...keep, { type: "text", text: finalText }],
				details,
			});
			sm.flush();
		}

		// 留档条目必须落在正文**之后**：append 会把叶移到自己身上（_appendEntry），
		// 落在正文之前就把正文垫成它的子节点、不再是 user 的直接子节点，而 swipe 变体
		// （listReplyVariants 只认 user 的直接子节点）随之一个都认不出来——v1.4.1 起
		// reroll 恒显 1/1、旧变体在树上却不可达。空拍（无 final/finalText）照样留档。
		sm.appendCustomEntry("rp-text-debug", { beatLog, draft: ws.draft, loopTail, finalText });
		sm.flush();

		// 媒体交付落树（8/06 重接）：wire 只认树上的 toolResult 出 image/audio/video/html 帧。
		// 落在正文**之后**——屏上顺序与演出顺序一致（先看正文，再看图）。
		// 正文空拍时也要落：用户可能只让「把刚才那张图再给我看看」，没有正文照样得交付。
		if (!aborted && ws.mediaDeliveries?.length) {
			for (const d of ws.mediaDeliveries) {
				sm.appendMessage({
					role: "toolResult",
					toolName: d.toolName,
					content: [{ type: "text", text: d.text }],
					details: d.details,
					isError: false,
					timestamp: Date.now(),
				});
			}
			sm.flush();
		}

		if (errored && !aborted && !entryId) {
			ev.onNotify?.("error", `生成失败：${errored}`);
			return { aborted: false, error: errored, entryId };
		}

		// 空手认栽（循环逼稿一次仍无产出）：明说，不再静默丢拍（实弹三拍 0 字正文的教训）
		if (!errored && !aborted && !finalText) {
			ev.onNotify?.("warning", "本拍模型未交出任何正文（已催稿一次仍空手）——请重试或更换模型。");
			return { aborted: false, error: "no-draft" };
		}

		// M-A：#revise 旁路停用（8/10 验收整体退役；修改由模型自发 draft_edit 承担）。
		// 记账：world_state_update 干跑验证过的 patch 在此统一落账——
		// 落树刚完成、叶即本拍新条目，无叶漂移窗口；模型是记账主体，harness 只执行。
		if (entryId && !aborted && ws.patches.length > 0) {
			const nextState = projectedState(ws, state);
			sm.appendCustomEntry(STATE_ENTRY_TYPE, nextState);
			const stateFile = this.#deps.getStateFile?.(sm.getSessionId());
			if (stateFile) {
				try {
					saveState(stateFile, nextState);
				} catch {
					// 缓存写失败不影响树上快照（账本权威在树，磁盘只是缓存）
				}
			}
			ev.onActivity?.(`记账 ${ws.patches.length} 笔（模型提交）`);
			sm.flush();
		}

		// 场记兜底（D5）：模型本拍没调 world_state_update 才旁路补账，M-B 视实弹数据决定退役。
		if (entryId && !aborted && finalText && ws.patches.length === 0) {
			const r = await runScribeTurn(
				{
					// 2048：账本+名录随剧情增长，patch 可能很长；1024 实测会截断出半截 JSON（8/03）
					sideText: (sp, ut) => this.#sideText("scribe", sp, ut, 2048),
					appendStateEntry: (s) => sm.appendCustomEntry(STATE_ENTRY_TYPE, s),
					getLeafId: () => sm.getLeafId(),
					stateFile: this.#deps.getStateFile?.(sm.getSessionId()),
					onActivity: (d) => ev.onActivity?.(d),
				},
				{
					state,
					userText: lastUserText,
					assistantText: finalText,
					charName: materials.card.name,
					userName: materials.config.userName,
				},
			);
			if (r.kind === "failed") console.error(`[stage-scribe] 记账跳过：${r.error}`);
			sm.flush();
		} else if (final && finalText && sm.getLeafId() !== expectedTurnLeafId) {
			ev.onActivity?.("正文结果已丢弃（生成期间切换了分支）");
			return { aborted: true };
		}

		// 后台世界推演：Skill 即开关、也是规则唯一权威。完整快照落当前分支，
		// 下一拍只注入裁剪投影；叶守卫防止异步推演写入用户已切换的世界线。
		const worldSkill = workflowSkill(materials.skillFiles, "world");
		if (entryId && !aborted && narrativeText && !legacyBackstage) {
			const sourceLeafId = sm.getLeafId();
			if (sourceLeafId) {
				const postBranch = sm.getBranch() as BranchEntryLike[];
				const postState = stateFromBranch(postBranch);
				const currentModularWorld = modularWorldFromBranch(postBranch, worldManifest);
				const currentWorld = projectLiteraryWorldV1(currentModularWorld);
				const currentEcology = literaryEcology;
				const previousEcologyRound = literaryEcologyFromBranch(postBranch).round;
				const currentPools = loadEcologyPools(cwd, config.card, card.name);
				const factsSkill = workflowSkill(materials.skillFiles, "world-facts");
				const auditSkill = workflowSkill(materials.skillFiles, "world-audit");
				const worldPromise = adaptiveWorldEnabled && worldSkill && factsSkill && auditSkill ? (async () => {
					ev.onActivity?.("后台世界：结算本拍事实与时间");
					const baseAudit = (status: WorldTransitionAuditEntry["status"], errors: string[], extra: Partial<WorldTransitionAuditEntry> = {}) => worldAuditEntry({
						status, narrativeEntryId: entryId, baseRound: currentWorld.round,
						...(worldManifest ? { cardKey: worldManifest.cardKey, manifestRevision: worldManifest.profileRevision } : {}),
						baseStateHash: worldTransitionHash(currentWorld), errors, ...extra,
					});
					const factPrompt = buildBeatFactPrompt(factsSkill.body, { userText: lastUserText, narrativeText, rpState: postState, world: currentWorld, history, manifest: worldManifest });
					const factText = await this.#sideText("literaryWorldFacts", factPrompt.systemPrompt, factPrompt.userText, 8192);
					if (typeof factText !== "string") return { state: undefined, audit: baseAudit("fact-failed", [factText.error]), error: `事实信封失败：${factText.error}` };
					const factResult = normalizeBeatFactEnvelope(factText, { userText: lastUserText, narrativeText });
					if (!factResult.envelope) return { state: undefined, audit: baseAudit("fact-failed", factResult.errors), error: `事实信封拒绝：${factResult.errors.join("；")}` };
					const envelope = factResult.envelope;
					ev.onActivity?.(`后台世界：已确认 ${envelope.facts.length} 条带证据事实`);
					const dueModules = dueWorldModules(worldManifest, envelope);
					if (worldManifest && dueModules.length === 0) {
						const audit = baseAudit("committed", [], { nextRound: currentModularWorld.round, envelopeHash: worldTransitionHash(envelope), nextStateHash: worldTransitionHash(currentModularWorld), elapsed: envelope.elapsed, audit: { version: 1, verdict: "approve", issues: [], summary: "本拍没有到期的世界模块，世界保持稳定。" } });
						return { state: undefined, audit, error: undefined };
					}
					const modulePacks = worldModuleSkillPacks(materials.skillFiles, dueModules);
					const proposalPrompt = buildWorldProposalPrompt(worldSkill.body, { envelope, world: currentModularWorld, rpState: postState, manifest: worldManifest, dueModuleIds: dueModules.map((module) => module.id), moduleSkillBodies: modulePacks.map((skill) => ({ name: skill.name, body: skill.body })), ecologySignals: ecologySignalsForWorld(currentEcology) });
					const proposalText = await this.#sideText("literaryWorld", proposalPrompt.systemPrompt, proposalPrompt.userText, 8192);
					if (typeof proposalText !== "string") return { state: undefined, audit: baseAudit("proposal-failed", [proposalText.error], { envelopeHash: worldTransitionHash(envelope), elapsed: envelope.elapsed }), error: `世界提案失败：${proposalText.error}` };
					const proposalResult = normalizeModularWorldProposal(proposalText, currentModularWorld, envelope, worldManifest);
					if (!proposalResult.proposal) return { state: undefined, audit: baseAudit("rejected", proposalResult.errors, { envelopeHash: worldTransitionHash(envelope), proposalHash: worldTransitionHash(proposalText), elapsed: envelope.elapsed }), error: `世界提案拒绝：${proposalResult.errors.join("；")}` };
					const proposal = proposalResult.proposal;
					ev.onActivity?.("后台世界：独立审计因果、主权与信息边界");
					const auditPrompt = buildWorldAuditPrompt(auditSkill.body, { envelope, proposal, world: currentModularWorld, rpState: postState, manifest: worldManifest, preflightWarnings: proposalResult.warnings });
					const auditText = await this.#sideText("literaryWorldAudit", auditPrompt.systemPrompt, auditPrompt.userText, 8192);
					if (typeof auditText !== "string") return { state: undefined, audit: baseAudit("audit-failed", [auditText.error], { envelopeHash: worldTransitionHash(envelope), proposalHash: worldTransitionHash(proposal), elapsed: envelope.elapsed }), error: `世界审计失败：${auditText.error}` };
					const auditResult = normalizeWorldTransitionAudit(auditText, envelope);
					if (!auditResult.audit) return { state: undefined, audit: baseAudit("audit-failed", auditResult.errors, { envelopeHash: worldTransitionHash(envelope), proposalHash: worldTransitionHash(proposal), elapsed: envelope.elapsed }), error: `世界审计不可解析：${auditResult.errors.join("；")}` };
					if (auditResult.audit.verdict !== "approve") return { state: undefined, audit: baseAudit("rejected", auditResult.audit.issues.filter((issue) => issue.severity === "error").map((issue) => issue.message), { envelopeHash: worldTransitionHash(envelope), proposalHash: worldTransitionHash(proposal), elapsed: envelope.elapsed, audit: auditResult.audit }), error: `世界提案未通过审计：${auditResult.audit.summary}` };
					const auditHash = worldTransitionHash(auditResult.audit);
					const nextState = commitModularWorldTransition(currentModularWorld, proposal, auditHash, worldManifest);
					return { state: nextState, audit: baseAudit("committed", [], { nextRound: nextState.round, envelopeHash: worldTransitionHash(envelope), proposalHash: worldTransitionHash(proposal), nextStateHash: worldTransitionHash(nextState), elapsed: envelope.elapsed, audit: auditResult.audit }), error: undefined };
				})() : Promise.resolve({ state: undefined, audit: undefined, error: undefined });
				const ecologyPromise = config.literaryEcologyEnabled === true && ecologyRuntimeSkill ? (async () => {
					ev.onActivity?.("鲜活世界：推进人物生活与场所事件");
				const prompt = buildEcologyRuntimePrompt(ecologyRuntimeSkill.body, {
					phase: "aftermath", ecology: currentEcology, global: currentPools.global, cardPool: currentPools.card,
					state: postState, history, userText: lastUserText, narrativeText, worldSignals: worldSignalsForEcology(currentModularWorld),
				});
				const result = await this.#sideText("ecologyRuntime", prompt.systemPrompt, prompt.userText, 16384);
				if (typeof result !== "string") return { state: degradedLiteraryEcologyRound(currentEcology, previousEcologyRound, "aftermath", result.error), degraded: true, error: result.error };
				const parsed = normalizeLiteraryEcologyState(result, currentEcology);
				if (!parsed) return { state: degradedLiteraryEcologyRound(currentEcology, previousEcologyRound, "aftermath", "输出不可解析"), degraded: true, error: "输出不可解析" };
				const transitionErrors = validateEcologyTransition(currentEcology, parsed, worldSignalsForEcology(currentModularWorld));
				return transitionErrors.length
					? { state: degradedLiteraryEcologyRound(currentEcology, previousEcologyRound, "aftermath", transitionErrors.join("；")), degraded: true, error: transitionErrors.join("；") }
					: { state: commitLiteraryEcologyRound(parsed, previousEcologyRound), degraded: false, error: undefined };
				})() : config.literaryEcologyEnabled === true
					? Promise.resolve({ state: degradedLiteraryEcologyRound(currentEcology, previousEcologyRound, "aftermath", "人物与场所生态 Skill 缺失"), degraded: true, error: "人物与场所生态 Skill 缺失" })
					: Promise.resolve({ state: undefined, degraded: false, error: undefined });
				const [worldResult, ecologyResult] = await Promise.all([worldPromise, ecologyPromise]);
				if (this.#abort?.signal.aborted) return { aborted: true, entryId };
				if (sm.getLeafId() !== sourceLeafId) {
					ev.onActivity?.("拍后世界/生态结果已丢弃（期间切换了分支）");
				} else {
					// 模型并发、树写入串行：审计先留痕，权威世界仍在生态之前。
					if (worldResult.audit) sm.appendCustomEntry(WORLD_AUDIT_ENTRY_TYPE, worldResult.audit);
					if (worldResult.state) { sm.appendCustomEntry(LITERARY_WORLD_ENTRY_TYPE, worldResult.state); ev.onActivity?.(`后台世界推进至第 ${worldResult.state.round} 轮（已审计）`); }
					else if (worldResult.error) ev.onActivity?.(`后台世界推演失败（${worldResult.error}），保留上一快照`);
					if (ecologyResult.state) {
						sm.appendCustomEntry(LITERARY_ECOLOGY_ENTRY_TYPE, ecologyResult.state);
						if (!ecologyResult.degraded) {
							this.#ecologyPoolWrite = this.#ecologyPoolWrite.then(() => {
								const latest = loadEcologyPools(cwd, config.card, card.name);
								saveEcologyPools(cwd, config.card, applyEcologyUsage(latest, ecologyResult.state!));
							}).catch(() => undefined);
						}
						ev.onActivity?.(ecologyResult.degraded ? `鲜活世界：已落降级快照（${ecologyResult.error}）` : `鲜活世界推进至第 ${ecologyResult.state.round} 轮`);
					}
			sm.flush();
		}
		aborted = aborted || this.#abort?.signal.aborted === true;
		if (aborted) return { aborted: true, entryId };
			}
		}

		// M4 长局压缩：攒够拍数就把早期剧情摘要成 rp-summary（装配时回读为【前情提要】）。
		// 放在谢幕前的最后一步——记账已落，摘要能读到最新账本；叶守卫在 runCompaction 内。
		// 压缩失败/未到期都只是跳过，下一拍会再判一次。
		if (entryId && !aborted && finalText) {
			await this.#compact(config.compactEveryNTurns ?? 30);
		}
		return { aborted, entryId };
	}

	/**
	 * 手动压缩（/compact）：不等周期，立刻把早期剧情摘要成 rp-summary。
	 * everyNTurns=1 + 更低的字数地板 = 「只要真有可裁的早期剧情就压」
	 * （仍守最近 KEEP_RECENT_BEATS 拍原文，续演点不动）。
	 * 流式中拒绝——压缩要改上下文，不能与正在装配的一拍打架。
	 */
	async compactNow(): Promise<CompactOutcome> {
		if (this.#busy) return { kind: "skipped", reason: "busy" };
		const model = this.#deps.getModel();
		if (!model) return { kind: "failed", error: "尚未配置剧情模型" };
		this.#busy = true;
		this.#abort = new AbortController();
		try {
			return await this.#compact(1, MANUAL_MIN_COMPACT_CHARS);
		} catch (err) {
			return { kind: "failed", error: err instanceof Error ? err.message : String(err) };
		} finally {
			this.#abort = null;
			this.#busy = false;
		}
	}

	/** 压缩一次（自动/手动共用）。失败只记日志不抛——压缩从不影响正文。 */
	async #compact(
		everyNTurns: number,
		minChars?: number,
	): Promise<CompactOutcome> {
		const ev = this.#deps.events ?? {};
		const sm = this.#deps.getSessionManager();
		const { config, card } = loadStageMaterials(this.#deps.cwd);
		try {
			const branch = sm.getBranch() as BranchEntryLike[];
			const c = await runCompaction(
				{
					// 4096：摘要要装下前情/人物/伏笔/事实账五节，且要合并上一份摘要
					sideText: (sp, ut) => this.#sideText("compaction", sp, ut, 4096),
					appendSummaryEntry: (data: RpSummaryData) => sm.appendCustomEntry(SUMMARY_ENTRY_TYPE, data),
					getLeafId: () => sm.getLeafId(),
					archive: this.#deps.archiveCompacted
						? (text) => this.#deps.archiveCompacted!(sm.getSessionId(), text)
						: undefined,
					onActivity: (d) => ev.onActivity?.(d),
				},
				{
					branch,
					state: stateFromBranch(branch),
					language: config.language,
					userName: config.userName,
					charName: card.name,
					everyNTurns,
					...(minChars !== undefined ? { minChars } : {}),
				},
			);
			if (c.kind === "failed") console.error(`[stage-compact] 压缩跳过：${c.error}`);
			if (c.kind === "compacted") sm.flush();
			return c;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`[stage-compact] 压缩异常：${msg}`);
			return { kind: "failed", error: msg };
		}
	}

	/**
	 * M-A agent 循环（开放式）。M-R1（PLAN-RECTIFY §2.3）起由五注入日程驱动：
	 * 规划卡随首轮末端注入送达；未封笔的轮次注进度行（每轮替换）/判定（一次性）；
	 * seal（含兜底封笔）之后依次给记账、谢幕席位；日程走完、模型停手即收束。
	 * 宽进严出（D2）：直出正文自动代收为 draft_write；无稿也无正文 → 逼稿一次；
	 * MAX_ROUNDS 只约束开放式工具循环；谢幕是封笔后的独立交付席位，不占该预算。
	 */
	async #agentLoop(o: {
		model: StageModelLike;
		options: Record<string, unknown>;
		systemPrompt: string;
		messages: unknown[];
		first: AssistantMsgLike;
		tools: StageTool[];
		ws: TurnWorkspace;
		wsDeps: WorkspaceDeps;
		/** 剧情语言（统一工具层按面装配描述/schema，M-D1） */
		language: string;
		/** 读侧工具依赖（装配清单与执行同源，M-D2） */
		readDeps: StageToolDeps;
		/** 首轮直出正文（调用方已流式外发） */
		directText: string;
		/** skill_read 可读名单投影（让模型知道有哪些 skill 可用） */
		skillNames: string[];
		/** 必定读取（每轮）skill 名单：落笔前受理门强制先读（制造停顿=死磕燃料） */
		forcedSkills: string[];
		/** 全流程文字留档 */
		_blog?: (event: string, data: string) => void;
		/** 有界的独立谢幕格式指令。 */
		curtain?: string;
	}): Promise<{ final: AssistantMsgLike | null; errored?: string; text: string; tailText?: string; curtainText?: string; pendingDraft?: string }> {
		const rawEv2 = this.#deps.events ?? {};
		const blog = o._blog ?? (() => {});
		const ev: typeof rawEv2 = {
			...rawEv2,
			onDelta: (kind, delta, draft, reset) => {
				blog(draft ? "draft_delta" : kind === "thinking" ? "thinking" : "text", delta);
				rawEv2.onDelta?.(kind, delta, draft, reset);
			},
			onStreamClear: () => { blog("stream_clear", ""); rawEv2.onStreamClear?.(); },
			onDraftResync: (segs) => { blog("draft_resync", segs.join("\n---\n")); rawEv2.onDraftResync?.(segs); },
			onActivity: (d) => { blog("activity", d); rawEv2.onActivity?.(d); },
		};
		const readDeps = o.readDeps;
		// 走 tools.ts 派发的工具（统一层世界书族/向量库族 + 台上读侧两件）；其余归工作区执行器。
		// 统一层含写侧（lorebook_write/toggle、memory_add/delete），但它们写的是设定集/记忆库
		// 而不是本拍草稿，故仍走 tools.ts 而非 workspace——「读/写」在此不是路由依据，工件归属才是。
		const READ_TOOLS = new Set([
			...unifiedStageToolNames(readDeps),
			"world_state_get",
			"skill_read",
		]);
		// MCP 外设（8/06 重接）：只认**本会话已连接**的限定名——不能只看 mcp__ 前缀，
		// 否则模型幻觉出的服务器名会被当成 MCP 调用，错过「未知工具」的正常报错路径。
		const MCP_TOOLS = mcpStageToolNames(this.#deps.mcp);
		// 媒体交付（8/06 重接）：结果带 details.rp*，收尾时落成 toolResult 条目供 wire 出帧
		const MEDIA_TOOLS = this.#deps.media
			? mediaStageToolNames({ tts: this.#deps.ttsAvailable?.() === true })
			: new Set<string>();
		// 写账工具（记账轮的结构信号——§2.3：判据必须是结构信号，禁止文本识别）
		const LEDGER_TOOLS = new Set(["world_state_update", "panel_write", "panel_close"]);
		const convo = [...o.messages];
		let last: AssistantMsgLike = o.first;
		let text = "";
		let nudged = false; // 空手逼稿只给一轮机会，防空转
		let sealNudged = false; // 封笔催告（逐路标续写完但忘了 draft_seal），只给一轮
		let userStopped = false; // P7：用户在 ask 选择卡上点了停止——本拍收束
		let lastConsumed = 0; // 本轮开始时 text 长度——判定「本轮新产出文本」用
		// 五注入日程状态（D9：进度行替换语义；判定/记账/谢幕一次性）
		let verdictInjected = false;
		// 必定读取（每轮）受理门：每条路标落笔前必须先读完所有 forcedSkills
		// （8/16：重置点从「交段」搬到「勾路标」，与送模文案同步改口径。停顿本身是设计
		// ——工具调用是模型可靠执行的动作、思考指令不是——只是计价单位从段落改成路标：
		// 一条路标内接着演的段落不再重复强制读。）
		const readThisStep = new Set<string>(); // 本条路标已读的 forcedSkill 名
		let forcedNudgedForStep = false; // 本条路标已催过一次（防空转安全阀）
		const skillReadDone = new Set<string>(); // 重复读瘦身：本拍已读过全文的 skill 名
		let ledgerInjected = false;
		let ledgerDone = false;
		let curtainInjected = false;
		let curtainText = "";
		let loopExhausted = false;
		const inject = (text: string) => { blog("injection", text); return nowMsg(text); };
		// 稿首次落地时的 text 长度：之前的 text 是读题/计划旁白（工具轮的 text 通道产出），
		// 不算正文也不算尾巴；之后的 text 才是尾巴候选（状态栏等）。-1 = 稿未落地。
		let tailStart = -1;
		// 尾巴口径：稿落地后的 text 通道产出（未落地=全量，直出正文路径要整段保留）
		const tailOf = () => (tailStart >= 0 ? text.slice(tailStart) : text);
		// 稿外直出记账（8/10 实弹：规划轮直出的开头因同轮带工具调用不触发代收，
		// 前端当旁白清屏、引擎侧永不入稿——定稿凭空缺前半场）。这里只记事实：
		// 代收消费过的部分不算，稿落地后的尾巴不算；余下的就是「流出去但不在稿内」。
		let directConsumed = false; // o.directText 已被代收进稿
		let strayFrom = 0; // 代收已消费的 text 前缀长度

		for (let round = 0; round < MAX_ROUNDS; round++) {
			o.ws.rounds = round + 1;
			lastConsumed = text.length; // 本轮之前的累计文本
			const calls = (last.content ?? []).filter(
				(c): c is { type: string; id?: string; name?: string; arguments?: Record<string, unknown> } =>
					c.type === "toolCall",
			);
			let ledgerCallThisRound = false;

			if (calls.length === 0) {
				// 模型停手：按五注入日程决定下一站，没有下一站才收束。
				if (o.ws.draft.trim()) {
					convo.push(last);
					if (!o.ws.sealed && o.ws.appends > 0 && !sealNudged) {
						// 催封笔（§2.4，只给一次）
						sealNudged = true;
						convo.push(inject(`已续写 ${o.ws.appends} 个路标未封笔。写完就 draft_seal，没写完接着写。`));
					} else {
						// 停手分支补判定（8/12）：模型勾完路标后直接停手（不调 seal、不调工具），
						// 工具轮判定分支只跑在模型还在调工具时，停手分支原先整个没有判定逻辑——
						// ask 裁决席位同样消失。兜底封笔前补一次（verdictInjected 守卫防循环）。
						if (!verdictInjected && o.ws.plan.length > 0 && draftBodyCharsOf(o.ws) > 0) {
							verdictInjected = true;
							convo.push(nowMsg(verdictInjection(o.wsDeps.userName)));
						} else {
							// 兜底封笔（催告已给过/全量稿天然封笔）→ 记账：停手不越站
							if (!o.ws.sealed) runWriteTool(o.ws, o.wsDeps, "draft_seal", {});
							if (!ledgerDone && !ledgerInjected && o.ws.patches.length === 0 && o.ws.panelWrites === 0) {
								ledgerInjected = true;
								convo.push(inject(LEDGER_INJECTION));
							} else if (o.curtain && !curtainInjected) {
								ledgerDone = true;
								curtainInjected = true;
								convo.push(inject(`${o.curtain}\n\n【最终投影状态】\n${JSON.stringify(projectedState(o.ws, o.wsDeps.baseState), null, 2)}`));
							} else {
								break; // 日程走完：本拍收束
							}
						}
					}
				} else {
					const direct = `${o.directText}${text}`.trim();
					if (direct) {
						const directBody = extractDraftBody(direct);
						const formatOnly = !directBody || /^```(?:css|html)?\s*[\s\S]*```$/i.test(directBody);
						if (formatOnly) {
							if (nudged) break;
							nudged = true;
							convo.push(last);
							convo.push(nowMsg("工作区仍无正文；请用 draft_append 或 draft_write 提交正文。"));
							continue;
						}
						// 宽进严出：直出正文代收为 draft_write（已流式外发过，不重复上屏）。
						// internal=true 跳过门禁——代收是兜底，被拦下就等于把这拍正文丢了。
						const r = runWriteTool(o.ws, o.wsDeps, "draft_write", { content: direct }, true);
						directConsumed = r.ok;
						if (r.ok) {
							strayFrom = text.length;
							o.ws.strayText = "";
						}
						ev.onActivity?.(r.ok ? "直出正文已代收为 draft_write" : "直出正文代收失败");
						convo.push(last);
						convo.push(nowMsg(r.ok ? "正文已代收为 draft_write。需要改就重交，不需要就结束。" : r.text));
					} else {
						// 空手停笔（实弹三拍 0 字正文的病灶）：逼稿一次，仍空手才认栽
						if (nudged) break;
						nudged = true;
						convo.push(last);
						convo.push(nowMsg("你还没有落笔。用 draft_append 演出，或 draft_write 一次交完，否则本拍无产出。"));
					}
				}
			} else {
				convo.push(last);
				let appendedThisRound = false;
				for (const call of calls) {
					const name = call.name ?? "";
					let r: ToolRunResult | MediaStageResult;
					// P7：ask 工具——弹出选择卡等用户应答，答案作为新输入回喂模型。
					// 用户停止（undefined）→ 本拍收束：不再续轮，直接以现稿定稿。
					if (name === "ask" && this.#deps.askUser) {
						const q = String(call.arguments?.question ?? "").trim() || "请你定夺";
						const raw = call.arguments?.options;
						const options = Array.isArray(raw)
							? raw.map((s) => String(s).trim()).filter(Boolean)
							: [];
						// 停下来等用户：回合制共创，不设超时；abort 信号透传（用户点停止即收敛）
						const answer = await this.#deps.askUser(q, options, this.#abort?.signal);
						o.ws.lookups++; // 用户参与选择＝这一拍有戏（draft_write 门禁判据）
						if (answer === undefined) {
							// 用户停止：笔还给用户，本拍收束——标记后跳出循环
							ev.onActivity?.(`ask「${q.slice(0, 24)}」· 用户停止`);
							userStopped = true;
							recordSegment(o.ws, {
								kind: "tool",
								activity: { kind: "tool_start", name: "ask", detail: "用户停止——笔还给用户" },
							});
							break;
						}
						r = {
							text: `用户已作答：「${answer}」。`,
							activity: `ask「${q.slice(0, 24)}」· 用户作答`,
						};
						ev.onActivity?.(r.activity);
						recordSegment(o.ws, {
							kind: "tool",
							activity: { kind: "tool_start", name: "ask", detail: r.activity },
						});
						convo.push({
							role: "toolResult",
							toolCallId: call.id,
							toolName: "ask",
							content: [{ type: "text", text: r.text }],
							timestamp: Date.now(),
						});
						continue;
					}
					// 记账轮的结构信号（§2.3）：写账工具被调＝记账仍在进行；面板写入计数进工作区
					if (LEDGER_TOOLS.has(name)) ledgerCallThisRound = true;
					if (name === "panel_write" || name === "panel_close") o.ws.panelWrites++;
					// 必定读取（每轮）受理门（复现 8/11「强制调用」，泛化为认 `每轮` 标志不认名字）：
					// 一条路标落笔前必须先 skill_read 完所有 forcedSkills——没读全就交，本次首交不受理
					// （回执指路）；模型执意重交则放行（每条路标只拦一次，防空转，安全阀同封笔催告）。
					const skillReadName =
						name === "skill_read" ? (call.arguments as { name?: string } | undefined)?.name : undefined;
					if (skillReadName && o.forcedSkills.includes(skillReadName)) readThisStep.add(skillReadName);
					const unreadForced = o.forcedSkills.filter((n) => !readThisStep.has(n));
					if (name === "draft_append" && unreadForced.length > 0 && !forcedNudgedForStep) {
						forcedNudgedForStep = true;
						r = {
							text: `本次未受理：先 \`skill_read\`${unreadForced.map((n) => `「${n}」`).join("")}构思这个路标，再重交。`,
							activity: "交稿暂缓——先读必定 skill",
							ok: false,
						};
					} else if (
						// 抢跑 seal 时序保证（PLAN-ASK §2.2）：判定是唯一 ask 裁决席位，模型直接封笔会整个
						// 跳过它（8/11 实弹）。首次抢跑不受理，回执即判定文案（同一席位提前送达）；下一轮再调
						// seal 照常受理。8/12 放宽：不再要求路标全勾——模型没勾完就封笔同样会跳过判定
						// （实弹：勾 2/3 直接封笔，判定整个消失），判定送达不该依赖模型自觉勾选。
						// 无计划的分段拍与 harness 内部兜底封笔不走此分支。
						name === "draft_seal" &&
						!verdictInjected &&
						!o.ws.sealed &&
						o.ws.plan.length > 0 &&
						draftBodyCharsOf(o.ws) > 0
					) {
						verdictInjected = true;
						r = {
							text: verdictInjection(o.wsDeps.userName),
							activity: "封笔暂缓——先判定",
							ok: false,
						};
					} else {
					// 三态路由 +MCP：统一层/台上读侧 → tools.ts；MCP 外设 → hub；其余 → 工作区。
					// MCP 走网络/子进程，可能很慢——把本拍 abort 信号透传下去，用户点停止能立刻中断。
					r = name === "assistant_run"
						? ((await runAssistantStageTool(name, call.arguments ?? {}, this.#abort?.signal)) ?? {
								text: `未知工具「${name}」。`,
								isError: true,
							})
						: MCP_TOOLS.has(name)
							? ((await runMcpStageTool(
									this.#deps.mcp!,
									name,
									call.arguments ?? {},
									this.#abort?.signal,
								)) ?? { text: `未知工具「${name}」。`, isError: true })
							: MEDIA_TOOLS.has(name)
								? ((await runMediaStageTool(this.#deps.cwd, name, call.arguments ?? {})) ?? {
										text: `未知工具「${name}」。`,
										isError: true,
									})
								: READ_TOOLS.has(name)
									? await this.#runReadTool(o, readDeps, name, call.arguments ?? {})
									: runWriteTool(o.ws, o.wsDeps, name, call.arguments ?? {});
						}
					if (name === "draft_append" && r.ok !== false) appendedThisRound = true;
					// 媒体交付要落成 toolResult 条目（wire 只认树上的 toolResult 出媒体帧）——
					// 台上引擎默认剥离工具轨迹，故在此单独收集，谢幕后随正文一起落树。
					const mediaDetails = (r as MediaStageResult).details;
					if (MEDIA_TOOLS.has(name) && mediaDetails && (r as MediaStageResult).isError !== true) {
						o.ws.mediaDeliveries = o.ws.mediaDeliveries ?? [];
						o.ws.mediaDeliveries.push({ toolName: name, details: mediaDetails, text: r.text });
					}
					// 必定读取受理门：本条路标勾掉了 → 清空已读、下一条路标重新计门
					// （8/16：原先挂在 draft_append 上＝按段计费；改挂 beat_step_done＝按路标计费。）
					if (name === "beat_step_done" && r.ok !== false) {
						readThisStep.clear();
						forcedNudgedForStep = false;
					}
					// 重复读瘦身：名单内 skill 首读成功后记名（未知名回落直写不记，避免把 miss 记成已读）
					if (skillReadName && o.skillNames.includes(skillReadName) && r.ok !== false) {
						skillReadDone.add(skillReadName);
						o.ws.skillReads++;
					}
					// 每轮修复可见性（8/09 输出形式定案）：draft_edit 修改后**分段重同步**——
					// 前端把全部稿段原位替换成修后分段，该段原地变新，无重复、不塌段。
					// （旧做法发「全稿 + reset」只替换末段，前面稿段还在屏上 → 正文重复。）
					if (name === "draft_edit" && r.ok !== false && o.ws.draft.trim()) {
						ev.onDraftResync?.(splitDraftSegments(o.ws.draft));
					}
					// 时间线：工具按调用位置入档（draft_write/edit 的正文另由 #recordDraft 记）
					recordSegment(o.ws, { kind: "tool", activity: { kind: "tool_start", name, detail: r.activity ?? "" } });
					if (r.activity) ev.onActivity?.(r.activity);
					convo.push({
						role: "toolResult",
						toolCallId: call.id,
						toolName: name,
						content: [{ type: "text", text: r.text }],
						// MCP 失败必须如实标记：模型据此改道或如实告知用户，而不是当成功往下演
						isError: (r as { isError?: boolean }).isError === true,
						timestamp: Date.now(),
					});
				}
			}

			// P7：用户停止（ask 卡上点了停止）——本拍收束，不再续轮
			if (userStopped) break;

			// 预算触顶后的第一轮仍给模型一次显式封笔机会；第二轮仍未封则由工作区
			// 兜底封笔。后续记账与谢幕照常走既有日程，不等 MAX_ROUNDS。
			// 中间轮旁白（8/09 实弹）：稿落地前、工具轮里流出的 text 是读题/计划旁白——
			// 通知前端清掉（收进过程条）；tailStart 一旦标记（稿已落地），之后的 text
			// 归尾巴候选，不再清（状态栏后调记账的场景，状态栏不能被当旁白删掉）。
			// round 0 的旁白在 performTurn 首轮流里（o.directText），不在本层 text 统计中。
			if (tailStart < 0) {
				const talked = text.length > lastConsumed || (round === 0 && o.directText.trim().length > 0);
				if (calls.length > 0 && talked) ev.onStreamClear?.();
				if (o.ws.draft.trim()) tailStart = text.length;
			}

			// 稿外直出 = 未被代收的首轮直出 + 稿落地前流出的 text（尾巴与已消费部分除外）。
			// 每轮更新，seal 回执（runCheck）把它作为事实补认。
			if (o.ws.draft.trim()) {
				o.ws.strayText = `${directConsumed ? "" : o.directText}${text.slice(
					strayFrom,
					tailStart >= 0 ? Math.max(strayFrom, tailStart) : text.length,
				)}`.trim();
			}

			// 五注入日程（工具轮后半程）：seal 之后记账→谢幕；未封笔注进度/判定（§2.3）。
			// 停手轮的日程已在上方分支处理；这里只管模型还在干活的轮。
			if (calls.length > 0) {
				if (o.ws.sealed) {
					if (!ledgerDone) {
						if (!ledgerInjected) {
							// 本拍已有落账（结构信号：patch 队列/面板写入）→ 跳过记账注入
							if (o.ws.patches.length > 0 || o.ws.panelWrites > 0) ledgerDone = true;
							else {
								ledgerInjected = true;
								convo.push(nowMsg(LEDGER_INJECTION));
							}
						} else if (!ledgerCallThisRound) {
							ledgerDone = true; // 记账轮结束（模型停止调用写账工具）
						}
					}
					if (ledgerDone && o.curtain && !curtainInjected) {
						curtainInjected = true;
						convo.push(inject(`${o.curtain}\n\n【最终投影状态】\n${JSON.stringify(projectedState(o.ws, o.wsDeps.baseState), null, 2)}`));
					}
				} else if (o.ws.plan.length > 0 || o.ws.draft.trim()) {
					const allDone = o.ws.plan.length > 0 && o.ws.plan.every((s) => s.done);
					// 判定以稿非空为门（8/10 实弹：0 字连勾两条也触发了判定＝勾选表演）；
					// 勾完但没落笔 → 继续进度行，判定等正文真出现
					if (allDone && !verdictInjected && draftBodyCharsOf(o.ws) > 0) {
						verdictInjected = true;
						convo.push(nowMsg(verdictInjection(o.wsDeps.userName)));
					} else {
						replaceProgressLine(convo, progressLine(o.ws));
					}
				}
				// 工作区仍空（纯探索轮）：不注入——规划卡已随首轮末端注入送达
			}

			// 安全阀最后一轮撤掉工具：模型只能收笔（触阀后以现稿/直出定稿）
			const lastRound = round >= MAX_ROUNDS - 1;
			if (lastRound) loopExhausted = true;
			const ctx: Record<string, unknown> = { systemPrompt: o.systemPrompt, messages: convo };
			if (!lastRound) {
				ctx.tools = o.tools;
			}
			else {
				// 触阀收场（D16）：只收场，不点名任何格式块——输出格式归卡/预设作者的散文与正则
				convo.push(inject("【收场】本拍轮次已达上限，工具已收起，就此收场。"));
			}

			// 格式复杂的 ST 卡可能有多个状态栏/日历块。只在本轮刚注入谢幕卡时
			// 放宽容量，避免普通记账轮继承谢幕状态后也无谓使用大窗口。
			const lastConvo = convo[convo.length - 1] as
				| { role?: string; content?: Array<{ text?: string }> }
				| undefined;
			const curtainCall =
				curtainInjected &&
				lastConvo?.role === "user" &&
				lastConvo.content?.some((part) => part.text?.includes("【主演·格式收尾】"));
			const callOptions = curtainCall
				? {
						...o.options,
						// 谢幕保留用户为主演选择的推理强度；高推理模型可能先长考再交付。
						maxTokens: curtainMaxTokens(o.model),
					}
				: o.options;
			if (curtainCall) ev.onActivity?.("主演格式收尾：按本拍已读的角色卡与预设输出格式");
			const s = this.#deps.streamFn(o.model, ctx as never, callOptions);
			let final: AssistantMsgLike | null = null;
			const fwd = this.#draftForwarder(ev);
			// thinking_delta 入时间线（思考→工具→正文全链）
			for await (const e of s) {
				if (e.type === "done") final = e.message ?? null;
				else if (e.type === "error") {
					return { final: e.error ?? null, errored: e.error?.errorMessage || "provider error", text, tailText: tailOf(), pendingDraft: fwd.pendingText() };
				} else if (e.type === "text_delta" && e.delta) {
					text += e.delta;
					if (curtainCall) curtainText += e.delta;
					// 稿已存在后的正文外产出（状态栏/catsay 等格式尾巴）入时间线按序记档；
					// 定稿时由 finalTimeline 吸收进稿段（内容以 mergeFinalText 为准）。
					if (o.ws.draft.trim()) recordSegment(o.ws, { kind: "text", text: e.delta });
					ev.onDelta?.("text", e.delta);
				} else if (e.type === "thinking_delta" && e.delta) {
					recordSegment(o.ws, { kind: "thinking", text: e.delta });
					ev.onDelta?.("thinking", e.delta);
				} else {
					fwd.forward(e);
				}
			}
			if (!final) return { final: last, text, tailText: tailOf() };
			last = final;
			if (final.stopReason === "aborted") break;
		}
		// 工具循环触阀时，模型可能已在 reasoning 中完成格式，却尚未产生 text。
		// 谢幕是正文之外的独立席位：额外给一次无工具交付机会，不受 MAX_ROUNDS 挤占。
		if (loopExhausted && o.curtain && o.ws.draft.trim() && !curtainText.trim() && last.stopReason !== "aborted") {
			convo.push(last);
			convo.push(nowMsg(`${o.curtain}\n\n【独立交付】上一轮没有产生可见格式。请完成思考后把全部非正文格式输出到正文通道；不要调用工具。\n\n【最终投影状态】\n${JSON.stringify(projectedState(o.ws, o.wsDeps.baseState), null, 2)}`));
			ev.onActivity?.("主演格式收尾：独立交付席位");
			const s = this.#deps.streamFn(
				o.model,
				{ systemPrompt: o.systemPrompt, messages: convo },
				{ ...o.options, maxTokens: curtainMaxTokens(o.model) },
			);
			let final: AssistantMsgLike | null = null;
			for await (const e of s) {
				if (e.type === "done") final = e.message ?? null;
				else if (e.type === "error") {
					return { final: e.error ?? last, errored: e.error?.errorMessage || "provider error", text, tailText: tailOf(), curtainText };
				} else if (e.type === "text_delta" && e.delta) {
					text += e.delta;
					curtainText += e.delta;
					recordSegment(o.ws, { kind: "text", text: e.delta });
					ev.onDelta?.("text", e.delta);
				} else if (e.type === "thinking_delta" && e.delta) {
					recordSegment(o.ws, { kind: "thinking", text: e.delta });
					ev.onDelta?.("thinking", e.delta);
				}
			}
			if (final) last = final;
		}
		return { final: last, text, tailText: tailOf(), curtainText };
	}

	/**
	 * 台上读侧工具，并把「查过世界」记进工作区。
	 *
	 * lookups 是 draft_write 门禁的判据（见 workspace.ts runWriteTool）：查过设定/旧账/
	 * 账本＝这一拍中途确实有要停下来处理的事＝有戏，本该一段一段演。
	 */
	async #runReadTool(
		o: { ws: TurnWorkspace; language: string },
		readDeps: StageToolDeps,
		name: string,
		args: Record<string, unknown>,
	): Promise<ToolRunResult> {
		o.ws.lookups++;
		return runStageTool(readDeps, name, args, o.language);
	}

	/**
	 * D1：draft_write / draft_append 的正文参数流式转发——工件正文照常逐字上屏。
	 * toolcall_delta 用渐进解析的 arguments（openai-completions 每帧重解 partialArgs）；
	 * toolcall_end 兜底补齐后缀（faux 等不做渐进解析的 provider 在此整段上屏）。
	 * 每条流各建一个（sent 按 contentIndex 记已发长度，保证不重发）。
	 *
	 * M-E：draft_append 是**追加**语义，reset 必须为 false——已上屏的段落是
	 * 已经发生的事，续写不能把它擦掉重排（那正是分段续写要消除的体验）。
	 */
	#draftForwarder(ev = this.#deps.events ?? {}): { forward: (e: StageStreamEvent) => void; pendingText: () => string } {
		const sent = new Map<number, number>();
		const drafts = new Map<number, { text: string; append: boolean }>();
		const forward = (idx: number, content: unknown, append = false) => {
			if (typeof content !== "string") return;
			const prev = sent.get(idx) ?? 0;
			if (content.length <= prev) return;
			// draft=true：稿件流是替换语义（重交不叠加）——与 runWriteTool 的
			// replaceDraftSegment 同语义，wire 层透传给前端时间线。
			// reset=true：本次 draft_write 调用的首个分片——前端用它清掉旧稿。
			const isFirst = !append && !sent.has(idx);
			ev.onDelta?.("text", content.slice(prev), true, isFirst);
			sent.set(idx, content.length);
			drafts.set(idx, { text: content, append });
		};
		/** 取正文参数：draft_write 用 content，draft_append 用 segment */
		const pick = (name: string | undefined, args: Record<string, unknown> | undefined) => {
			if (name === "draft_write") return { text: args?.content, append: false };
			if (name === "draft_append") return { text: args?.segment, append: true };
			return undefined;
		};
		const forwardEvent = (e: StageStreamEvent) => {
			const idx = e.contentIndex;
			if (typeof idx !== "number") return;
			if (e.type === "toolcall_delta") {
				const block = e.partial?.content?.[idx];
				if (block?.type !== "toolCall") return;
				const p = pick(block.name, block.arguments);
				if (p) forward(idx, p.text, p.append);
			} else if (e.type === "toolcall_end") {
				const p = pick(e.toolCall?.name, e.toolCall?.arguments);
				if (p) forward(idx, p.text, p.append);
			}
		};
		return {
			forward: forwardEvent,
			pendingText: () => [...drafts.entries()].sort(([a], [b]) => a - b).map(([, row]) => row.text).filter(Boolean).join("\n\n"),
		};
	}

	/**
	 * 台上工具的执行依赖（每次取用现读素材/账本——工具看到的世界与装配同源）。
	 * lastUserText 供写入门禁判定（M-D2）：门禁问的是「用户本拍有没有要求记录」。
	 */
	#toolDeps(lastUserText = "", webResearchEnabled = false): StageToolDeps {
		const cwd = this.#deps.cwd;
		const sm = this.#deps.getSessionManager();
		/** 台上补充设定集路径（写侧落点；卡未装载时为空＝无 lorebook_write） */
		const overlayOf = (): string => {
			try {
				const m = loadStageMaterials(cwd);
				return overlayPathFor(cwd, m.card.name);
			} catch {
				return "";
			}
		};
		let remainingWebQueries = 3;
		return {
			searchLore: (query, limit) => {
				const m = loadStageMaterials(cwd);
				// 语料 = 世界书 + 补充设定集（materials 已剥离外部插件协议条目）+ 当前分支挂载的知识库。
				// 知识库此前只有扩展侧搜得到，台上描述却一直承诺「已挂载知识库」——M-D1 补齐（PLAN-RP-TOOLING）。
				const codex: LorebookEntry[] = [];
				for (const name of codexNamesFromBranch(sm.getBranch() as BranchEntryLike[])) {
					try {
						codex.push(...(loadCodexEntries(cwd, name) ?? []));
					} catch {
						// 单个库读不出不该拖垮整次检索
					}
				}
				return searchEntries(codex.length > 0 ? [...m.entries, ...codex] : m.entries, query, limit);
			},
			// ---- M-D2 世界书族 ----
			writeLore: (input) => {
				const overlay = overlayOf();
				if (!overlay) return null;
				return appendOverlayEntry(overlay, input);
			},
			listLore: () => loadStageMaterials(cwd).entries,
			fingerprint: loreFingerprint,
			...(this.#deps.setDisabledLore ? { toggleLore: this.#deps.setDisabledLore } : {}),
			gate: () => ({ lastUserText, creationMode: loadStageConfig(cwd).creationMode }),
			searchMemory: async (query) => {
				const search = this.#deps.searchMemory;
				if (!search) return [];
				return search(sm.getSessionId(), query);
			},
			// ---- M-D3 向量库写侧：scope 由宿主绑定，模型只给内容（作用域不经模型） ----
			...(this.#deps.addMemory
				? { addMemory: (input: { text: string; title?: string }) => this.#deps.addMemory!(sm.getSessionId(), input) }
				: {}),
			...(this.#deps.listMemory
				? { listMemory: (storeId: string) => this.#deps.listMemory!(sm.getSessionId(), storeId) }
				: {}),
			...(this.#deps.deleteMemory
				? { deleteMemory: (storeId: string, id: string) => this.#deps.deleteMemory!(sm.getSessionId(), storeId, id) }
				: {}),
			...(webResearchEnabled && this.#deps.webResearch ? {
				webResearch: async (queries: string[], maxResults: number) => {
					const accepted = queries.slice(0, remainingWebQueries);
					remainingWebQueries -= accepted.length;
					if (!accepted.length) return [{ query: "", rejected: "本拍最多执行三个联网查询，额度已用完" }];
					return this.#deps.webResearch!(accepted, maxResults, this.#abort?.signal);
				},
			} : {}),
			// ---- M-D4 角色库：只读卡面 ----
			readCard: () => {
				const m = loadStageMaterials(cwd);
				const c = m.card;
				if (!c) return null;
				return {
					name: c.name,
					description: c.description,
					personality: c.personality,
					scenario: c.scenario,
					firstMes: c.firstMes,
					mesExample: c.mesExample,
					systemPrompt: c.systemPrompt,
					creatorNotes: c.creatorNotes,
					tags: c.tags,
					alternateGreetings: c.alternateGreetings,
				};
			},
			// ---- M-D5 面板：读/写/关（依赖由宿主按 session 注入） ----
			...(this.#deps.loadPanels
				? {
						loadPanels: () => this.#deps.loadPanels!(sm.getSessionId()),
						writePanel: (input: { name: string; kind: string; content: string }) =>
							this.#deps.writePanel!(sm.getSessionId(), input),
						closePanel: (name: string) => this.#deps.closePanel!(sm.getSessionId(), name),
					}
				: {}),
			getState: () => stateFromBranch(sm.getBranch() as BranchEntryLike[]),
			formatState,
			getSkill: (name: string) => loadStageMaterials(cwd).skillFiles.find((skill) => skill.name === name)?.body,
		};
	}

	/** 装配报告写盘（.liyuan/preset-assembly.json）——每块预设去向可查；内容不变不写 */
	#writeAssemblyReport(cwd: string, materials: StageMaterials, phAfter: AssembledPiece[]): void {
		try {
			const chars = (a: AssembledPiece[]) => a.reduce((n, p) => n + p.text.length, 0);
			const report = {
				preset: materials.presetDoc?.name ?? null,
				kind: materials.presetDoc?.kind ?? null,
				/** 送模字数：历史前段 + 本拍历史后段（深度注入数据层保真，尚未消费） */
				chars: {
					before: chars(materials.presetBefore),
					after: chars(phAfter),
					depth: chars(materials.presetDepth),
				},
				declaredMarkers: [...materials.declaredMarkers],
				// M-C2：世界书/卡内嵌通道被判死的外部插件协议条目（判据可回溯）
				protocolDrops: materials.protocolDrops,
				blocks: materials.presetAssembly,
			};
			const json = JSON.stringify(report, null, "\t");
			if (json === this.#lastAssemblyJson) return;
			this.#lastAssemblyJson = json;
			const outDir = join(cwd, ".liyuan");
			mkdirSync(outDir, { recursive: true });
			writeFileSync(join(outDir, "preset-assembly.json"), json, "utf8");
		} catch {
			// 报告写失败不影响演出
		}
	}

	// M-A 起 #revise 精修旁路退役（8/10 验收整体退役，revise.ts 已删除）。

	/** 旁路文本调用（精修/场记用）：静默收集，不外发增量；失败返回 {error} */
	async #sideText(
		step: SideModelStep,
		systemPrompt: string,
		userText: string,
		maxTokens = 8192,
		reasoning: string | undefined = "off",
		signal: AbortSignal | undefined = this.#abort?.signal,
	): Promise<string | { error: string }> {
		const config = loadStageConfig(this.#deps.cwd);
		const resolved = resolveStepModel(
			step,
			config.stepModels,
			this.#deps.getModel(),
			(provider, id) => this.#deps.findModel?.(provider, id),
			(id) => this.#deps.findModelById?.(id),
		);
		const model = resolved.model;
		if (!model) return { error: "尚未配置剧情模型" };
		if (resolved.fallback && resolved.requested) {
			const key = `${step}:${resolved.requested.provider}/${resolved.requested.id}`;
			if (!this.#warnedSideModelFallbacks.has(key)) {
				this.#warnedSideModelFallbacks.add(key);
				this.#deps.events?.onNotify?.("warning", `步骤 ${step} 配置的模型 ${resolved.requested.provider}/${resolved.requested.id} 不可用，本次已继承剧情总插头。`);
			}
		}
		let auth: { apiKey?: string; headers?: Record<string, string> };
		try {
			auth = await this.#deps.getAuth(model);
		} catch (error) {
			return { error: error instanceof Error ? error.message : String(error) };
		}
		const options: Record<string, unknown> = {
			apiKey: auth.apiKey,
			headers: auth.headers,
			maxTokens,
			signal,
			// 精修/场记/压缩是 harness 的机械窄题，默认强制关思考：zen go 对 low/high 无可靠节流
			//（8/02 实测），放开推理会把 maxTokens 整个烧在隐形思考里、正文零输出。
			// 合约声明是判断题（整卡+预设通读），由调用点透传会话思考档（undefined＝随供应商默认）。
			...(reasoning !== undefined ? { reasoning } : {}),
		};
		const call = async (attempt: number): Promise<string | { error: string }> => {
			// 旁路是结构化窄任务。第一次优先非流式；若返回空文本，再用原模型形态补试。
			// 每次底层请求自身最多重试九次，并遵守 provider 退避；流式中途错误同样按退避重试。
			const callModel = attempt === 0
				? { ...model, compat: { ...((model.compat as Record<string, unknown> | undefined) ?? {}), streaming: false } }
				: model;
			// 限流与瞬时网络错误交给 provider 的退避策略，避免本层无间隔连打形成请求风暴。
			const callOptions = { ...options, maxRetries: MODEL_MAX_RETRIES };
			try {
			const s = this.#deps.streamFn(
				callModel,
				{
					systemPrompt,
					messages: [{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }],
				},
				callOptions,
			);
			let final: AssistantMsgLike | null = null;
			for await (const e of s) {
				if (e.type === "done") final = e.message ?? null;
				else if (e.type === "error") {
					const error = e.error?.errorMessage || `stopReason=${e.error?.stopReason ?? "?"}`;
					// 流式中途失败（如上游 worker 断流）也应退避重试；耗尽后才如实失败。
					if (attempt < MODEL_MAX_RETRIES) {
						await new Promise((r) => setTimeout(r, 600 * Math.min(2 ** attempt, 8)));
						return call(attempt + 1);
					}
					return { error };
				}
			}
			if (!final) {
				if (attempt < MODEL_MAX_RETRIES) {
					await new Promise((r) => setTimeout(r, 500));
					return call(attempt + 1);
				}
				return { error: "流未产出最终消息" };
			}
			const text = textOfAssistant(final);
			if (text) return text;
			if (attempt < MODEL_MAX_RETRIES) return call(attempt + 1);
			// 部分 OpenAI 兼容层在 SSE/compat 非流式均可能只返回空 content；最后使用
			// 原 model + response-format 倾向的非流式兼容再试一次，仍失败才如实停链。
			return { error: "最终消息无文本" };
		} catch (err) {
			return attempt < MODEL_MAX_RETRIES ? call(attempt + 1) : { error: err instanceof Error ? err.message : String(err) };
		}
		};
		return call(0);
	}
}
