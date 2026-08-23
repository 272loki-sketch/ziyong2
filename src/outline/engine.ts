import { createHash, randomUUID } from "node:crypto";

import type { SideModelStep } from "../model-routing.ts";
import type { BranchEntryLike } from "../stage/assemble.ts";
import type { StageMaterials } from "../stage/materials.ts";
import { workflowSkill } from "../stage/skill-store.ts";
import type { WebResearchItem } from "../tools/web-research.ts";
import { buildOutlineAuditPrompt, buildOutlineChatPrompt } from "./prompts.ts";
import { projectOutline, projectCorpusWorkspace } from "./projection.ts";
import { OutlineResearchStore, type OutlineResearchExtraction } from "./research.ts";
import { parseOutlineAudit, parseOutlineProposal } from "./runtime.ts";
import type { OutlineAudit, OutlineChatEntry, OutlineChatResult, OutlineDiscussionFocus, OutlineProposal, OutlineProposalEntry, OutlineSceneAdvice, OutlineSource } from "./schema.ts";
import { OUTLINE_CHAT_ENTRY_TYPE, OUTLINE_ENTRY_TYPE, OUTLINE_PROPOSAL_ENTRY_TYPE } from "./schema.ts";
import { outlineHistoryFromBranch } from "./state.ts";
import { pendingOutlineProposalsFromBranch } from "./store.ts";
import { validateOutlineProposal } from "./validation.ts";

export type OutlineMode = "manual" | "suggest" | "auto";
export type OutlineResearchMode = "off" | "manual" | "auto";
export interface OutlineSettings { mode: OutlineMode; researchMode: OutlineResearchMode }
export interface OutlineSessionManager {
	getBranch(): unknown[];
	getLeafId(): string | null;
	getSessionId(): string;
	appendCustomEntry(customType: string, data?: unknown): string;
	flush(): void;
}
export interface OutlineContext {
	cardKey: string;
	card?: unknown;
	history?: unknown;
	rpState?: unknown;
	world?: unknown;
	ecology?: unknown;
	literaryProfiles?: unknown;
	directorArtifacts?: unknown;
}
export interface OutlineEngineDeps {
	cwd: string;
	getSessionManager: () => OutlineSessionManager;
	loadMaterials: () => StageMaterials;
	runSideModel: (step: SideModelStep, systemPrompt: string, userText: string, options?: { maxTokens?: number; signal?: AbortSignal; onDelta?: (event: { kind: "text"; delta: string } | { kind: "error"; text: string }) => void }) => Promise<string | { error: string }>;
	webResearch?: (queries: string[], maxResults: number, signal?: AbortSignal) => Promise<WebResearchItem[]>;
	getContext?: () => OutlineContext;
	onState?: (view: OutlineView) => void;
}
export interface OutlineView {
	state: ReturnType<typeof outlineHistoryFromBranch>["current"];
	projection: ReturnType<typeof projectOutline>;
	pending: ReturnType<typeof pendingOutlineProposalsFromBranch>;
	settings: OutlineSettings;
	invalidEntries: number;
	proposalRisks: Record<string, OutlinePendingRisk>;
	chats: OutlineChatEntry[];
}
export interface OutlinePendingRisk { highRisk: string[]; issues: OutlineAudit["issues"]; requiresConfirmation: boolean }
interface OutlineCapture { sessionId: string; leafId: string; state: OutlineView["state"]; trustedSources: OutlineSource[]; trustedSourceIds: Set<string> }

export class OutlineConflictError extends Error { statusCode = 409; }

const SETTINGS_TYPE = "rp-outline-settings";
const parseObject = (text: string): Record<string, unknown> | null => {
	for (const candidate of [text.trim(), text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1], text.match(/\{[\s\S]*\}/)?.[0]]) {
		if (!candidate) continue;
		try { const value = JSON.parse(candidate); if (value && typeof value === "object" && !Array.isArray(value)) return value; } catch {}
	}
	return null;
};
const proposalHash = (proposal: OutlineProposal): string => createHash("sha256").update(JSON.stringify(proposal)).digest("hex");
const DISCUSSION_FOCUS = new Set<OutlineDiscussionFocus>(["open", "next-beat", "dialogue", "character", "diagnose"]);
const cleanText = (value: unknown, max = 1200): string => typeof value === "string" ? value.trim().slice(0, max) : "";
const cleanList = (value: unknown, maxItems = 8, maxChars = 500): string[] => Array.isArray(value) ? value.flatMap((item) => typeof item === "string" && item.trim() ? [item.trim().slice(0, maxChars)] : []).slice(0, maxItems) : [];
const conversationTargetsOf = (value: unknown): Array<{ character: string; reason: string; openingTopic: string; risk: string }> => Array.isArray(value) ? value.flatMap((item) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) return [];
		const row = item as Record<string, unknown>;
		const target = { character: cleanText(row.character, 160), reason: cleanText(row.reason), openingTopic: cleanText(row.openingTopic), risk: cleanText(row.risk) };
		return target.character && target.reason && target.openingTopic ? [target] : [];
	}).slice(0, 4) : [];
const sceneAdviceOf = (value: unknown): OutlineSceneAdvice | undefined => {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const row = value as Record<string, unknown>;
	const advice = {
		recommendedBeat: cleanText(row.recommendedBeat), openingMove: cleanText(row.openingMove),
		characterMoves: cleanList(row.characterMoves), conversationTargets: conversationTargetsOf(row.conversationTargets), dialogueCues: cleanList(row.dialogueCues),
		pressure: cleanText(row.pressure), playerSpace: cleanText(row.playerSpace), stopPoint: cleanText(row.stopPoint), alternatives: cleanList(row.alternatives, 4),
		mixedRoute: cleanText(row.mixedRoute),
	};
	return Object.values(advice).some((item) => Array.isArray(item) ? item.length > 0 : !!item) ? advice : undefined;
};

export class OutlineEngine {
	#deps: OutlineEngineDeps;
	#research: OutlineResearchStore;
	#commit = Promise.resolve();
	#abort = new AbortController();
	constructor(deps: OutlineEngineDeps) { this.#deps = deps; this.#research = new OutlineResearchStore(deps.cwd); }

	cancel(): void { this.#abort.abort(); this.#abort = new AbortController(); }

	getView(): OutlineView {
		const branch = this.#branch();
		const history = outlineHistoryFromBranch(branch);
		const pending = pendingOutlineProposalsFromBranch(branch), trustedSourceIds = new Set(this.#trustedSources(branch).map((source) => source.id));
		const proposalRisks = Object.fromEntries(pending.map(({ entry }) => {
			const result = validateOutlineProposal(history.current, entry.proposal, { trustedSourceIds });
			return [entry.proposal.id, { highRisk: result.highRisk, issues: result.audit.issues, requiresConfirmation: result.highRisk.length > 0 }];
		}));
		return { state: history.current, projection: projectOutline(history.current, "public"), pending, settings: this.#settings(branch), invalidEntries: history.invalidEntries, proposalRisks, chats: this.#chats(branch) };
	}

	history(): ReturnType<typeof outlineHistoryFromBranch> { return outlineHistoryFromBranch(this.#branch()); }

	async chat(message: string, options: { research?: boolean; focus?: OutlineDiscussionFocus; onDelta?: (event: { kind: "text"; delta: string } | { kind: "error"; text: string }) => void } = {}): Promise<OutlineChatResult & { options?: unknown[]; proposalHash?: string }> {
		const wish = message.trim();
		if (!wish) throw new Error("缺少 message");
		const base = this.#capture();
		if (options.research) { await this.research(wish); this.#guard(base); }
		const materials = this.#deps.loadMaterials();
		const skill = workflowSkill(materials.skillFiles, "outline-chat");
		if (!skill) throw new Error("缺少 workflow: outline-chat 的 Skill");
		const focus = options.focus && DISCUSSION_FOCUS.has(options.focus) ? options.focus : "open";
		const request = { requestId: randomUUID(), message: wish, mode: "manual" as const, baseRevision: base.state.revision, baseHash: base.state.hash, selectedNodeIds: [], research: [], focus };
		const prompt = buildOutlineChatPrompt(skill.body, { request, outline: base.state, context: this.#modelContext(base.leafId) });
		const raw = await this.#call("outlineChat", prompt.systemPrompt, prompt.userText, 12288, options.onDelta);
		this.#guard(base);
		const parsed = parseObject(raw);
		if (!parsed) {
			const detail = raw.trim().slice(0, 600);
			throw new Error(detail ? `编剧室输出不可解析（${raw.trim().length} 字）：${detail}` : "编剧室输出为空");
		}
		const proposal = this.#proposal(parsed.proposal, "chat", base);
		const answer = String(parsed.answer ?? parsed.reply ?? "").trim();
		const responseOptions = Array.isArray(parsed.options) ? parsed.options.slice(0, 6) : [];
		const sceneAdvice = sceneAdviceOf(parsed.sceneAdvice);
		const warnings = cleanList(parsed.warnings, 8, 500);
		const sm = this.#deps.getSessionManager();
		sm.appendCustomEntry(OUTLINE_CHAT_ENTRY_TYPE, { version: 1, requestId: request.requestId, baseLeafId: base.leafId, focus, user: wish.slice(0, 4000), answer: answer.slice(0, 8000), options: responseOptions, warnings, ...(sceneAdvice ? { sceneAdvice } : {}), createdAt: new Date().toISOString() } satisfies OutlineChatEntry);
		sm.flush();
		if (proposal) this.#storePending(proposal);
		else this.#emit();
		return { requestId: request.requestId, reply: answer, focus, ...(responseOptions.length ? { options: responseOptions } : {}), ...(sceneAdvice ? { sceneAdvice } : {}), ...(proposal ? { proposal, proposalHash: proposal.proposalHash } : {}), warnings };
	}

	async bootstrap(experienceWish = ""): Promise<OutlineProposal> {
		const base = this.#capture();
		if (this.getView().settings.researchMode === "auto") { await this.research(experienceWish || "当前题材的长线结构、人物弧线、伏笔与常见失败模式"); this.#guard(base); }
		return this.#generate("outline-bootstrap", "outlineBootstrap", "bootstrap", experienceWish);
	}

	async reconcile(leafId?: string): Promise<{ proposal?: OutlineProposal; committed?: boolean; stable?: boolean }> {
		const settings = this.getView().settings;
		const base = this.#capture();
		if (leafId && base.leafId !== leafId) throw new OutlineConflictError("leaf revision conflict");
		if (settings.researchMode === "auto") { await this.research("当前篇章的长线结构、人物弧线、伏笔回收与常见失败模式"); this.#guard(base); }
		const proposal = await this.#generate("outline-reconcile", "outlineReconcile", "reconcile", "", false);
		const checked = validateOutlineProposal(base.state, proposal, { trustedSourceIds: base.trustedSourceIds });
		if (checked.nextState?.hash === base.state.hash) return { stable: true };
		if (settings.mode === "auto") {
			const automatic = validateOutlineProposal(base.state, { ...proposal, mode: "automatic" }, { trustedSourceIds: base.trustedSourceIds });
			if (automatic.audit.verdict === "approve") { await this.#commitProposal({ ...proposal, mode: "automatic" }, false); return { proposal, committed: true }; }
		}
		this.#storePending(proposal);
		return { proposal, committed: false };
	}

	async confirm(id: string, hash: string): Promise<{ state: OutlineView["state"]; audit: OutlineAudit }> {
		const pending = this.getView().pending.find((row) => row.entry.proposal.id === id);
		if (!pending) throw new Error("待确认 proposal 不存在");
		if (!hash || hash !== pending.entry.proposalHash) throw new OutlineConflictError("proposal hash conflict");
		return this.#commitProposal(pending.entry.proposal, true);
	}

	reject(id: string, reason = "用户拒绝"): void {
		const pending = this.getView().pending.find((row) => row.entry.proposal.id === id);
		if (!pending) throw new Error("待确认 proposal 不存在");
		const sm = this.#deps.getSessionManager();
		sm.appendCustomEntry(OUTLINE_PROPOSAL_ENTRY_TYPE, { ...pending.entry, status: "rejected", reason, createdAt: new Date().toISOString() } satisfies OutlineProposalEntry);
		sm.flush(); this.#emit();
	}

	settings(next?: Partial<OutlineSettings>): OutlineSettings {
		if (!next) return this.getView().settings;
		const current = this.getView().settings;
		const value: OutlineSettings = { mode: ["manual", "suggest", "auto"].includes(String(next.mode)) ? next.mode! : current.mode, researchMode: ["off", "manual", "auto"].includes(String(next.researchMode)) ? next.researchMode! : current.researchMode };
		const sm = this.#deps.getSessionManager(); sm.appendCustomEntry(SETTINGS_TYPE, value); sm.flush(); this.#emit(); return value;
	}

	researchView(): ReturnType<OutlineResearchStore["view"]> { return this.#research.view(this.#deps.getContext?.().cardKey ?? this.#deps.loadMaterials().config.card); }

	/** 小说消化完成入库（CorpusEngine onReady 钩子）。 */
	async digestReady(document: import("./corpus.ts").CorpusDocument, digest: import("./corpus.ts").CorpusDigest, extracted: OutlineResearchExtraction[]): Promise<import("./research.ts").OutlineResearchView["documents"]> {
		return this.#research.mergeCorpus(document.cardKey, document, digest, extracted);
	}

	/** 删除文档后清理只被该文档引用的机制条目（CorpusEngine onRemoved 钩子）。 */
	removeCorpus(docId: string): Promise<number> { return this.#research.removeCorpus(docId); }

	async research(topic = ""): Promise<ReturnType<OutlineResearchStore["view"]>> {
		if (!this.#deps.webResearch) throw new Error("当前环境没有启用联网研究");
		const context = this.#deps.getContext?.();
		const queries = this.#safeQueries(topic, context);
		const rows = await this.#deps.webResearch(queries, 5, this.#abort.signal);
		const materials = this.#deps.loadMaterials(), skill = workflowSkill(materials.skillFiles ?? [], "outline-research");
		let extracted: OutlineResearchExtraction[] = [];
		if (skill) {
			const sourceRows = rows.flatMap((item) => item.results.map((result) => {
				let url = ""; try { url = new URL(result.url).toString(); } catch { return null; }
				return { id: `src-${createHash("sha256").update(url).digest("hex").slice(0, 16)}`, query: item.query, title: result.title.slice(0, 180), snippet: result.snippet.slice(0, 600), url };
			}).filter((row): row is NonNullable<typeof row> => !!row)).slice(0, 30);
			if (sourceRows.length) {
				const parsed = parseObject(await this.#call("outlineResearch", skill.body, JSON.stringify({ task: "outline-research", sources: sourceRows }, null, 2), 8192));
				if (Array.isArray(parsed?.mechanisms)) extracted = parsed.mechanisms.flatMap((item): OutlineResearchExtraction[] => {
					if (!item || typeof item !== "object" || Array.isArray(item)) return [];
					const row = item as Record<string, unknown>;
					if (typeof row.mechanism !== "string" || typeof row.appliesWhen !== "string" || typeof row.failureWarning !== "string" || !Array.isArray(row.sourceIds) || !row.sourceIds.every((id) => typeof id === "string")) return [];
					return [{ mechanism: row.mechanism, appliesWhen: row.appliesWhen, failureWarning: row.failureWarning, sourceIds: row.sourceIds }];
				});
			}
		}
		return this.#research.merge(context?.cardKey ?? materials.config.card, rows, extracted);
	}

	async #generate(workflow: "outline-bootstrap" | "outline-reconcile", step: SideModelStep, kind: "bootstrap" | "reconcile", wish: string, store = true): Promise<OutlineProposal> {
		const base = this.#capture(), materials = this.#deps.loadMaterials(), skill = workflowSkill(materials.skillFiles, workflow);
		if (!skill) throw new Error(`缺少 workflow: ${workflow} 的 Skill`);
		const raw = await this.#call(step, skill.body, JSON.stringify({ task: workflow, baseLeafId: base.leafId, current_outline: base.state, experience_wish: wish, context: this.#modelContext(base.leafId) }, null, 2), 16384);
		this.#guard(base);
		const proposal = this.#proposal(parseObject(raw), kind, base);
		if (!proposal) throw new Error(`${workflow} 输出没有可解析 proposal`);
		if (store) this.#storePending(proposal);
		return proposal;
	}

	#proposal(value: unknown, kind: OutlineProposal["kind"], base: OutlineCapture): OutlineProposal | null {
		const parsed = parseOutlineProposal(value, { modelInput: true });
		if (!parsed || parsed.kind !== kind || parsed.baseRevision !== base.state.revision || parsed.baseHash !== base.state.hash || parsed.baseLeafId !== base.leafId) return null;
		const referenced = new Set((parsed.patch.collections ?? []).flatMap((row) => (row.upsert ?? []).flatMap((node) => [...node.sourceRefs, ...(row.collection === "foreshadowing" ? (node as { evidenceRefs?: string[] }).evidenceRefs ?? [] : [])])));
		const injected = base.trustedSources.filter((source) => referenced.has(source.id) && !base.state.sources.some((old) => old.id === source.id));
		const proposal: OutlineProposal = { ...parsed, patch: { ...parsed.patch, ...(injected.length ? { addSources: [...(parsed.patch.addSources ?? []), ...injected] } : {}) }, createdAt: new Date().toISOString() };
		proposal.proposalHash = proposalHash(proposal);
		return proposal;
	}

	async #commitProposal(proposal: OutlineProposal, confirmed: boolean): Promise<{ state: OutlineView["state"]; audit: OutlineAudit }> {
		let output!: { state: OutlineView["state"]; audit: OutlineAudit };
		const task = this.#commit.then(async () => {
			const base = this.#capture();
			const pendingMarker = this.#pendingMarker(proposal.id);
			const baseLeafStillInBranch = this.#branch().some((row) => row.id === proposal.baseLeafId);
			if (base.state.revision !== proposal.baseRevision || base.state.hash !== proposal.baseHash || !baseLeafStillInBranch || (confirmed && !pendingMarker)) throw new OutlineConflictError("outline revision conflict");
			if (this.#storyAdvancedAfter(pendingMarker?.entryId ?? proposal.baseLeafId!)) throw new OutlineConflictError("提案生成后剧情已继续，请基于当前剧情重新讨论");
			const confirmation = confirmed && proposal.proposalHash && proposal.baseLeafId ? { proposalHash: proposal.proposalHash, baseLeafId: proposal.baseLeafId } : undefined;
			const deterministic = validateOutlineProposal(base.state, confirmed ? proposal : { ...proposal, mode: "automatic" }, { trustedSourceIds: base.trustedSourceIds, ...(confirmation ? { confirmation } : {}) });
			if (!deterministic.nextState) throw new Error(deterministic.audit.summary);
			let audit = deterministic.audit;
			const skill = workflowSkill(this.#deps.loadMaterials().skillFiles, "outline-audit");
			if (skill) {
				const prompt = buildOutlineAuditPrompt(skill.body, { outline: base.state, proposal, deterministicIssues: deterministic.audit.issues, execution: { requestedMode: confirmed ? "manual" : "automatic", confirmed, confirmedProposalHash: confirmed ? proposal.proposalHash : null, confirmedBaseLeafId: confirmed ? proposal.baseLeafId : null, pendingMarkerMatched: confirmed ? !!pendingMarker : false } });
				const parsed = parseOutlineAudit(parseObject(await this.#call("outlineAudit", prompt.systemPrompt, prompt.userText, 4096)));
				if (!parsed) throw new Error("大纲审计输出无效");
				audit = parsed;
				if (audit.verdict !== "approve") {
					this.#guard(base);
					const sm = this.#deps.getSessionManager();
					sm.appendCustomEntry(OUTLINE_PROPOSAL_ENTRY_TYPE, { version: 1, proposal, proposalHash: proposal.proposalHash, audit, status: "rejected", reason: audit.summary, createdAt: new Date().toISOString() } satisfies OutlineProposalEntry);
					sm.flush(); this.#emit();
					throw new Error(audit.summary || "大纲审计拒绝提案");
				}
			}
			this.#guard(base);
			const sm = this.#deps.getSessionManager();
			// Write the approved proposal first, but do not claim it committed before the state append succeeds.
			const entry: OutlineProposalEntry = { version: 1, proposal, proposalHash: proposal.proposalHash, audit, status: "approved", committedRevision: deterministic.nextState.revision, committedHash: deterministic.nextState.hash, createdAt: new Date().toISOString() };
			sm.appendCustomEntry(OUTLINE_PROPOSAL_ENTRY_TYPE, entry);
			sm.appendCustomEntry(OUTLINE_ENTRY_TYPE, deterministic.nextState);
			sm.flush(); output = { state: deterministic.nextState, audit }; this.#emit();
		});
		this.#commit = task.then(() => undefined, () => undefined); await task; return output;
	}

	#storePending(proposal: OutlineProposal): void { const sm = this.#deps.getSessionManager(); sm.appendCustomEntry(OUTLINE_PROPOSAL_ENTRY_TYPE, { version: 1, proposal, proposalHash: proposal.proposalHash, status: "pending", createdAt: new Date().toISOString() } satisfies OutlineProposalEntry); sm.flush(); this.#emit(); }
	#capture(): OutlineCapture { const sm = this.#deps.getSessionManager(), leafId = sm.getLeafId(); if (!leafId) throw new Error("当前会话没有分支叶"); const branch = sm.getBranch() as BranchEntryLike[], trustedSources = this.#trustedSources(branch); return { sessionId: sm.getSessionId(), leafId, state: outlineHistoryFromBranch(branch).current, trustedSources, trustedSourceIds: new Set(trustedSources.map((source) => source.id)) }; }
	#guard(base: OutlineCapture): void { const now = this.#capture(); if (now.sessionId !== base.sessionId || now.leafId !== base.leafId || now.state.revision !== base.state.revision || now.state.hash !== base.state.hash) throw new OutlineConflictError("outline revision conflict"); }
	#branch(): BranchEntryLike[] { return this.#deps.getSessionManager().getBranch() as BranchEntryLike[]; }
	#pendingMarker(id: string): { entryId: string } | undefined { return pendingOutlineProposalsFromBranch(this.#branch()).find((row) => row.entry.proposal.id === id); }
	#storyAdvancedAfter(baseLeafId: string): boolean {
		const branch = this.#branch(), at = branch.findIndex((row) => row.id === baseLeafId);
		if (at < 0) return true;
		return branch.slice(at + 1).some((row) => {
			if (row.type === "user" || row.type === "assistant" || row.message?.role === "user" || row.message?.role === "assistant") return true;
			return row.type === "custom" && ![OUTLINE_CHAT_ENTRY_TYPE, OUTLINE_PROPOSAL_ENTRY_TYPE, SETTINGS_TYPE].includes(String(row.customType));
		});
	}
	#chats(branch: BranchEntryLike[]): OutlineChatEntry[] {
		return branch.flatMap((row): OutlineChatEntry[] => {
			if (row.type !== "custom" || row.customType !== OUTLINE_CHAT_ENTRY_TYPE || !row.data || typeof row.data !== "object" || Array.isArray(row.data)) return [];
			const raw = row.data as Partial<OutlineChatEntry>;
			if (raw.version !== 1 || typeof raw.requestId !== "string" || typeof raw.baseLeafId !== "string" || typeof raw.user !== "string" || typeof raw.answer !== "string" || !DISCUSSION_FOCUS.has(raw.focus as OutlineDiscussionFocus)) return [];
			return [{ version: 1, requestId: raw.requestId, baseLeafId: raw.baseLeafId, focus: raw.focus as OutlineDiscussionFocus, user: raw.user.slice(0, 4000), answer: raw.answer.slice(0, 8000), options: Array.isArray(raw.options) ? raw.options.slice(0, 6) : [], warnings: cleanList(raw.warnings, 8, 500), ...(raw.sceneAdvice ? { sceneAdvice: sceneAdviceOf(raw.sceneAdvice) } : {}), createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "" }];
		}).slice(-80);
	}
	#settings(branch: BranchEntryLike[]): OutlineSettings { for (let i = branch.length - 1; i >= 0; i--) { const row = branch[i]; if (row.type === "custom" && row.customType === SETTINGS_TYPE && row.data && typeof row.data === "object") { const data = row.data as Partial<OutlineSettings>; return { mode: ["manual", "suggest", "auto"].includes(String(data.mode)) ? data.mode! : "manual", researchMode: ["off", "manual", "auto"].includes(String(data.researchMode)) ? data.researchMode! : "off" }; } } return { mode: "manual", researchMode: "off" }; }
	#modelContext(leafId: string): unknown { const context = this.#deps.getContext?.() ?? { cardKey: this.#deps.loadMaterials().config.card }; return { baseLeafId: leafId, ...context, trustedEvidenceRegistry: this.#trustedSources(this.#branch()).map(({ id, kind, title, locator }) => ({ id, kind, title, locator })), researchWorkspace: projectCorpusWorkspace(this.#research.view(context.cardKey), { maxDocs: 3 }) }; }
	#trustedSources(branch: BranchEntryLike[]): OutlineSource[] { return branch.flatMap((row): OutlineSource[] => { const id = typeof row.id === "string" && row.id ? `branch:${row.id}` : ""; if (!id) return []; const kind: OutlineSource["kind"] | null = row.type === "assistant" || row.message?.role === "assistant" || ["rp-greeting", "rp-edited-reply"].includes(String(row.customType)) ? "narrative" : row.type === "user" || row.message?.role === "user" ? "user" : row.customType === "rp-state" ? "rp-state" : row.customType === "rp-world-state" || row.customType === "rp-ecology-state" ? "world" : null; return kind ? [{ id, kind, title: `${kind} ${row.id}`, locator: String(row.id), note: "由当前分支引擎注册的已提交证据" }] : []; }); }
	#safeQueries(topic: string, context?: OutlineContext): string[] {
		const source = topic.toLowerCase(), abstractTopic = [
			/关系|感情|恋爱|慢热/.test(source) ? "慢热关系与互信推进" : "",
			/悬疑|谜|伏笔|秘密/.test(source) ? "悬疑伏笔与公平回收" : "",
			/校园|考试|班级|竞争|联盟/.test(source) ? "封闭校园制度竞争与联盟博弈" : "",
			/人物|人设|角色/.test(source) ? "人物弧线与角色主动性" : "",
		].filter(Boolean).join(" ") || "长篇故事人物弧线与结构";
		const tags = [`${abstractTopic} 叙事压力 选择 后果`, `${abstractTopic} 书评 影评 节奏 失败原因`, `${abstractTopic} 异质题材 可复用结构 负面案例`];
		const forbidden = [this.#deps.loadMaterials().card.name, this.#deps.loadMaterials().config.userName, context?.cardKey ?? ""].filter((x): x is string => typeof x === "string" && x.length >= 2);
		return tags.map((query) => forbidden.reduce((safe, secret) => safe.replaceAll(secret, " "), query).replace(/\s+/g, " ").trim()).filter(Boolean);
	}
	async #call(step: SideModelStep, system: string, user: string, maxTokens: number, onDelta?: (event: { kind: "text"; delta: string } | { kind: "error"; text: string }) => void): Promise<string> { const result = await this.#deps.runSideModel(step, system, user, { maxTokens, signal: this.#abort.signal, ...(onDelta ? { onDelta } : {}) }); if (typeof result !== "string") throw new Error(result.error); return result; }
	#emit(): void { this.#deps.onState?.(this.getView()); }
}
