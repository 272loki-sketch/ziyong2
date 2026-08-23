import { useEffect, useMemo, useRef, useState } from "react";
import { IconClose, IconRefresh } from "../components/icons.tsx";
import { ConfirmButton } from "../components/kit.tsx";
import {
	bootstrapOutline, confirmOutlineProposal, getOutline, getOutlineResearch, createCorpus, deleteCorpus, getCorpusDetail, listCorpus, pauseCorpus, resumeCorpus,
	getOutlineVersions, getTurnDiagnostics, putOutlineSettings, reconcileOutline, refreshOutlineResearch, rejectOutlineProposal, streamOutlineChat,
} from "./client.ts";
import { uploadFile } from "../api.ts";
import type {
	CorpusArcDigest, CorpusDetailResponse, CorpusDigest, CorpusDocument, CorpusWorkbenchResponse,
	ForeshadowingStatus, OutlineChatResponse, OutlineDiscussionFocus, OutlineHistoryResponse, OutlineMode, OutlineNode,
	OutlineProposalView, OutlineResearchMode, OutlineResearchView, OutlineSceneAdvice, OutlineViewResponse,
	TurnDiagnosticStage, TurnDiagnosticView, TurnDiagnosticsResponse,
} from "./types.ts";

type Tab = "room" | "diagnostics" | "map" | "characters" | "foreshadowing" | "proposals" | "archive" | "corpus";
type Toast = (level: "info" | "warning" | "error", text: string) => void;
type ChatLine = { role: "user" | "assistant"; text: string; options?: string[]; warnings?: string[]; focus?: OutlineDiscussionFocus; sceneAdvice?: OutlineSceneAdvice };
type ResearchDisplayItem = {
	id: string;
	title: string;
	url?: string;
	note?: string;
	excerpt?: string;
	mechanism?: string;
	appliesWhen?: string;
	sourceIds?: string[];
	warnings?: string[];
	failureWarnings?: string[];
};

const TABS: Array<[Tab, string]> = [
	["room", "编剧室"], ["diagnostics", "本拍诊断"], ["map", "故事地图"], ["characters", "人物弧线"],
	["foreshadowing", "伏笔板"], ["proposals", "建议箱"], ["corpus", "小说研究"], ["archive", "版本 / 研究"],
];
const DISCUSSION_MODES: Array<{ id: OutlineDiscussionFocus; label: string; note: string; prompt: string }> = [
	{ id: "open", label: "综合编剧", note: "长期路线与当前场景一起讨论", prompt: "结合当前剧情，判断接下来最值得发展的方向，并给出几种体验不同的方案。" },
	{ id: "next-beat", label: "下一拍", note: "下一段从哪里起、停在哪里", prompt: "分析当前场景的下一拍应该怎么走：从什么动作起手，角色会主动做什么，压力从哪里来，最后停在哪里把选择交给我。" },
	{ id: "dialogue", label: "下一段对白", note: "意图、潜台词与信息交换", prompt: "设计下一段对话的走法：双方各自想得到什么、哪些话不会直说、怎样交换信息，并给少量可参考的对白语气。" },
	{ id: "character", label: "角色反应", note: "人物此刻会怎么主动行动", prompt: "结合角色卡和最近剧情，分析当前关键人物此刻最自然的反应、主动动作、顾虑和绝不会做的事。" },
	{ id: "diagnose", label: "节奏诊断", note: "检查拖沓、跳跃、重复和失焦", prompt: "诊断当前剧情的节奏与角色主动性：哪里拖沓、跳跃、重复或推进过快，下一拍怎样修正最自然。" },
];
const FOCUS_LABEL: Record<OutlineDiscussionFocus, string> = Object.fromEntries(DISCUSSION_MODES.map((item) => [item.id, item.label])) as Record<OutlineDiscussionFocus, string>;
const FORESHADOW_LABEL: Record<ForeshadowingStatus, string> = {
	conceived: "仅构想", prepared: "已准备", planted: "正文已埋设", reinforced: "已强化",
	activated: "已启动", "partially-revealed": "部分揭示", resolved: "已回收", abandoned: "已放弃", invalidated: "已失效",
};

function list<T>(value: T[] | undefined | null): T[] { return Array.isArray(value) ? value : []; }
function textOptions(value: OutlineChatResponse["options"]): string[] {
	return list(value).map((item) => {
		if (typeof item === "string") return item;
		const title = item.title || item.label || item.text || item.value || item.experience || item.mechanism || "";
		const detail = [item.experience, item.mechanism, ...(Array.isArray(item.tradeoffs) ? item.tradeoffs : item.tradeoffs ? [item.tradeoffs] : [])]
			.filter((part) => part && part !== title).join(" · ");
		return detail ? `${title}：${detail}` : title;
	}).filter(Boolean);
}
function pendingProposals(outline: OutlineViewResponse): OutlineProposalView[] {
	if (outline.pending?.length) return outline.pending.map(({ entry }) => ({
		...entry.proposal,
		proposalHash: entry.proposalHash || entry.proposal.proposalHash || "",
		audit: entry.audit,
		status: entry.status,
		risk: outline.proposalRisks?.[entry.proposal.id]?.requiresConfirmation ? "high" : undefined,
	}));
	return list(outline.proposals);
}
function researchItems(view: OutlineResearchView): ResearchDisplayItem[] {
	return [
		...list(view.sources).map((source) => ({ id: source.id, title: source.title, url: source.url, note: `访问时间：${new Date(source.accessedAt).toLocaleString()}` })),
		...list(view.mechanisms).map((item) => ({ id: item.id, title: item.mechanism, note: `适用时机：${item.appliesWhen}\n来源：${item.sourceIds.join("、") || "未关联"}`, mechanism: item.mechanism, appliesWhen: item.appliesWhen, sourceIds: item.sourceIds, failureWarnings: [item.failureWarning] })),
	];
}
function patchSummary(patch: Record<string, unknown> | undefined): string[] {
	if (!patch) return ["未附带补丁摘要"];
	const rows: string[] = [];
	if (typeof patch.premise === "string") rows.push("更新故事前提");
	if (Array.isArray(patch.currentFocus)) rows.push(`调整当前焦点（${patch.currentFocus.length} 项）`);
	if (patch.alignment) rows.push("更新剧情对齐判断");
	if (Array.isArray(patch.collections)) {
		for (const raw of patch.collections as Array<Record<string, unknown>>) {
			const upserts = Array.isArray(raw.upsert) ? raw.upsert.length : 0;
			const deletes = Array.isArray(raw.deleteIds) ? raw.deleteIds.length : 0;
			rows.push(`${String(raw.collection || "集合")}：新增/修改 ${upserts}，删除 ${deletes}`);
		}
	}
	return rows.length ? rows : Object.keys(patch).map((key) => `修改 ${key}`);
}
const CORPUS_STATUS: Record<string, string> = {
	pending: "排队中", cleaning: "清洗中", mapping: "分块摘要", reducing: "弧线归并", extracting: "提炼套路",
	ready: "已完成", failed: "失败", paused: "已暂停",
};
function corpusMeta(doc: CorpusDocument): string {
	const size = doc.chars > 10000 ? `${Math.round(doc.chars / 10000) / 100}万字` : `${doc.chars}字`;
	return `${size} · ${doc.chunkCount}块 · ${CORPUS_STATUS[doc.status] ?? doc.status}`;
}
function CorpusDigestCard({ doc, detail }: { doc: CorpusDocument; detail: CorpusDetailResponse | undefined }) {
	const digest: CorpusDigest | undefined = detail?.digest ?? undefined;
	if (!digest) return <div className="planning-empty">该文档尚未完成消化，暂时没有可展示的梗概。</div>;
	return <div className="planning-digest">
		<section><h3>全书梗概</h3><p>{digest.synopsis}</p></section>
		<div className="planning-section-head"><h3 className="planning-section-title">结构</h3><span>{digest.extractedCount} 条套路</span></div>
		<div className="planning-grid">
			{([["主线事件链", digest.structure.plotSpine], ["人物弧线", digest.structure.characterArcs], ["钩子与节奏", digest.structure.hooksAndPacing]] as Array<[string, string]>).map(([label, text]) => <article className="planning-research-card" key={label}><h4>{label}</h4><p>{text || "（未提炼）"}</p></article>)}
		</div>
		<section><h3 className="planning-section-title">弧线摘要</h3>{list(digest.arcs).map((arc: CorpusArcDigest) => <details key={arc.title} className="planning-arc"><summary>{arc.title}<span>块 {arc.chunkRange[0] + 1}–{arc.chunkRange[1] + 1}</span></summary><p>{arc.summary}</p></details>)}<div className="planning-page-note">块摘要与提炼出的可复用套路：套路条目会出现在「版本 / 研究 → 研究灵感」中，块摘要仅用于本卡参考、不会注入大纲模型。</div></section>
	</div>;
}
function nodeCard(node: OutlineNode, extra?: React.ReactNode) {
	return <article className="planning-card" key={node.id}>
		<div className="planning-card-head"><strong>{node.title || "未命名节点"}</strong><span>{node.status || "candidate"}</span></div>
		{node.summary && <p>{node.summary}</p>}{extra}
		<div className="planning-tags"><span>{node.rigidity || "open"}</span><span>{node.actuality || "plan"}</span></div>
	</article>;
}

function SceneAdviceCard({ advice }: { advice: OutlineSceneAdvice }) {
	const rows: Array<[string, string | string[]]> = [
		["推荐下一拍", advice.recommendedBeat], ["起手", advice.openingMove], ["角色主动动作", advice.characterMoves],
		["对白线索", advice.dialogueCues], ["压力", advice.pressure], ["玩家空间", advice.playerSpace],
		["自然停点", advice.stopPoint], ["备选走法", advice.alternatives], ["混合路线", advice.mixedRoute],
	];
	return <div className="planning-advice"><strong>即时导演建议</strong>{advice.conversationTargets.length > 0 && <div className="planning-targets"><span>建议聊天对象</span>{advice.conversationTargets.map((target) => <article key={target.character}><b>{target.character}</b><p>{target.reason}</p><small>切入：{target.openingTopic}{target.risk ? ` · 风险：${target.risk}` : ""}</small></article>)}</div>}{rows.map(([label, value]) => {
		const values = Array.isArray(value) ? value : value ? [value] : [];
		return values.length > 0 && <div className="planning-advice-row" key={label}><span>{label}</span><div>{values.map((item) => <p key={item}>{item}</p>)}</div></div>;
	})}<small>这是当前场景建议，不是已发生正文；长期修改仍需在建议箱确认。</small></div>;
}

const DIAGNOSTIC_STATUS: Record<string, string> = {
	success: "成功", degraded: "降级", skipped: "跳过", reused: "复用", failed: "失败", committed: "已提交", rejected: "被拒绝", pending: "待确认", stable: "稳定", unavailable: "不可用", approved: "审计通过",
};

function diagnosticScalar(value: unknown): string {
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
	return "";
}

function DiagnosticStageCard({ stage }: { stage: TurnDiagnosticStage }) {
	const rows = Object.entries(stage.details ?? {}).flatMap(([key, value]) => {
		if (Array.isArray(value)) return value.length ? [[key, value.join("、")]] : [];
		const rendered = diagnosticScalar(value);
		return rendered ? [[key, rendered]] : [];
	});
	return <article className={`diagnostic-stage ${stage.status}`}>
		<header><span className={`diagnostic-dot ${stage.status}`} /><strong>{stage.label}</strong><b>{DIAGNOSTIC_STATUS[stage.status] || stage.status}</b></header>
		<p>{stage.summary}</p>
		{rows.length > 0 && <details><summary>查看结构化工件</summary><dl>{rows.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl></details>}
	</article>;
}

function DiagnosticTurn({ turn }: { turn: TurnDiagnosticView }) {
	const workflow = turn.artifacts.workflow ?? {};
	return <article className="diagnostic-turn">
		<header className="diagnostic-turn-head"><div><span>TURN · {turn.entryId.slice(0, 12)}</span><h3>本拍演出诊断</h3></div><small>{turn.narrativeChars} 字正文 · {turn.curtainChars} 字格式</small></header>
		<div className="diagnostic-metrics"><span>思考 {turn.timeline.thinking} 段</span><span>工具 {turn.timeline.tools} 组</span><span>正文 {turn.timeline.text} 段</span><span>稿件 {diagnosticScalar(workflow.appends) || "0"} 段</span><span>拒收 {diagnosticScalar(workflow.appendRejects) || "0"}</span><span>耗时 {workflow.durationMs ? `${Math.round(Number(workflow.durationMs) / 100) / 10}s` : "—"}</span></div>
		<div className="diagnostic-stages">{turn.stages.map((stage) => <DiagnosticStageCard key={stage.id} stage={stage} />)}</div>
		{turn.artifacts.commits.length > 0 && <details className="diagnostic-commits"><summary>分支提交记录 · {turn.artifacts.commits.length}</summary>{turn.artifacts.commits.map((commit, index) => <div key={`${commit.type}-${index}`}><strong>{commit.type}</strong><span className={commit.status}>{commit.status ? DIAGNOSTIC_STATUS[commit.status] : "已记录"}</span><p>{commit.summary}</p></div>)}</details>}
		{turn.artifacts.curtain && <details className="diagnostic-commits"><summary>独立谢幕格式原文{turn.artifacts.curtainTruncated ? "（已截断）" : ""}</summary><pre>{turn.artifacts.curtain}</pre></details>}
		{turn.artifacts.patchAudit && turn.artifacts.patchAudit.length > 0 && <details className="diagnostic-commits"><summary>账本修改审计 · {turn.artifacts.patchAudit.length}</summary><pre>{JSON.stringify(turn.artifacts.patchAudit, null, 2)}</pre></details>}
	</article>;
}

function DiagnosticsPage({ diagnostics, loading, error, onReload }: { diagnostics: TurnDiagnosticsResponse | null; loading: boolean; error: string; onReload: () => void }) {
	return <div className="planning-page diagnostics-page">
		<div className="planning-page-note"><strong>这是执行诊断，不是第二套剧情状态。</strong> 这里展示当前分支已有的拍前工件、主演工作流、门禁结果和拍后提交；模型秘密与隐藏推理不在此页面展开。</div>
		<div className="diagnostic-toolbar"><span>{diagnostics?.turns.length ?? 0} 拍可查看</span><button className="drawer-btn" onClick={onReload} disabled={loading}>{loading ? "刷新中…" : "刷新诊断"}</button></div>
		{error && <div className="panel-error planning-error">{error}</div>}
		{loading && !diagnostics && <div className="planning-empty">正在读取本拍工件…</div>}
		{!loading && diagnostics?.turns.length === 0 && <div className="planning-empty">当前分支还没有可诊断的角色回复。</div>}
		{diagnostics?.turns.map((turn) => <DiagnosticTurn key={turn.entryId} turn={turn} />)}
	</div>;
}

export function StoryPlanningWorkbench({ onClose, toast }: { onClose: () => void; toast: Toast }) {
	const [tab, setTab] = useState<Tab>("room");
	const [full, setFull] = useState(false);
	const [data, setData] = useState<OutlineViewResponse | null>(null);
	const [history, setHistory] = useState<OutlineHistoryResponse["history"]>([]);
	const [research, setResearch] = useState<ResearchDisplayItem[]>([]);
	const [diagnostics, setDiagnostics] = useState<TurnDiagnosticsResponse | null>(null);
	const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
	const [diagnosticsError, setDiagnosticsError] = useState("");
	const [researchWarnings, setResearchWarnings] = useState<string[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [action, setAction] = useState("");
	const [liveText, setLiveText] = useState("");
	const [messages, setMessages] = useState<ChatLine[]>([]);
	const [input, setInput] = useState("");
	const [wish, setWish] = useState("");
	const [researchQuestion, setResearchQuestion] = useState("");
	const [revealed, setRevealed] = useState<Set<string>>(() => new Set());
	const [mode, setMode] = useState<OutlineMode>("manual");
	const [researchMode, setResearchMode] = useState<OutlineResearchMode>("off");
	const [discussionFocus, setDiscussionFocus] = useState<OutlineDiscussionFocus>("open");
	const transcriptRef = useRef<HTMLDivElement>(null);
	const diagnosticsRequest = useRef(0);
	const [corpus, setCorpus] = useState<CorpusWorkbenchResponse | null>(null);
	const [corpusLoading, setCorpusLoading] = useState(false);
	const [corpusError, setCorpusError] = useState("");
	const [corpusDetail, setCorpusDetail] = useState<Record<string, CorpusDetailResponse>>({});
	const [corpusUploading, setCorpusUploading] = useState(false);
	const corpusRequest = useRef(0);
	const corpusFileRef = useRef<HTMLInputElement>(null);

	const load = async () => {
		setError("");
		try {
			const [outline, versions, researchRaw] = await Promise.all([getOutline(), getOutlineVersions(), getOutlineResearch()]);
			setData(outline);
			setHistory(list(versions.history));
			setResearch(researchItems(researchRaw));
			setResearchWarnings([]);
			setMode(outline.settings?.mode ?? "manual");
			setResearchMode(outline.settings?.researchMode ?? "off");
			setMessages(list(outline.chats).flatMap((chat): ChatLine[] => [
				{ role: "user", text: chat.user, focus: chat.focus },
				{ role: "assistant", text: chat.answer, focus: chat.focus, options: textOptions(chat.options), warnings: list(chat.warnings), sceneAdvice: chat.sceneAdvice },
			]));
		} catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
		finally { setLoading(false); }
	};
	const loadDiagnostics = async () => {
		const request = ++diagnosticsRequest.current;
		setDiagnosticsLoading(true); setDiagnosticsError("");
		try { const result = await getTurnDiagnostics(20); if (request === diagnosticsRequest.current) setDiagnostics(result); }
		catch (cause) { if (request === diagnosticsRequest.current) setDiagnosticsError(cause instanceof Error ? cause.message : String(cause)); }
		finally { if (request === diagnosticsRequest.current) setDiagnosticsLoading(false); }
	};
	const loadCorpus = async () => {
		const request = ++corpusRequest.current;
		setCorpusLoading(true); setCorpusError("");
		try { const result = await listCorpus(); if (request === corpusRequest.current) setCorpus(result); }
		catch (cause) { if (request === corpusRequest.current) setCorpusError(cause instanceof Error ? cause.message : String(cause)); }
		finally { if (request === corpusRequest.current) setCorpusLoading(false); }
	};
	const uploadCorpusFile = async (file: File) => {
		setCorpusUploading(true);
		try {
			const uploaded = await uploadFile(file);
			const created = await createCorpus(uploaded.file);
			if (created.estimatedCalls > 200) {
				const ok = window.confirm(`「${created.doc.title}」需要约 ${created.estimatedCalls} 次旁路模型调用，继续吗？`);
				if (!ok) { toast("info", "已取消建档（可在上传区删除该文件）"); return; }
			}
			toast("info", `已创建文档：${created.doc.title}（预计 ${created.estimatedCalls} 次辅助调用）`);
			await loadCorpus();
		} catch (cause) { toast("error", cause instanceof Error ? cause.message : String(cause)); }
		finally { setCorpusUploading(false); if (corpusFileRef.current) corpusFileRef.current.value = ""; }
	};
	const toggleCorpusDetail = async (doc: CorpusDocument) => {
		if (corpusDetail[doc.id]) { setCorpusDetail((c) => { const next = { ...c }; delete next[doc.id]; return next; }); return; }
		try {
			const detail = await getCorpusDetail(doc.id);
			setCorpusDetail((c) => ({ ...c, [doc.id]: detail }));
		} catch (cause) { toast("error", cause instanceof Error ? cause.message : String(cause)); }
	};
	const corpusAction = async (doc: CorpusDocument, kind: "pause" | "resume" | "delete") => {
		try {
			if (kind === "pause") { await pauseCorpus(doc.id); toast("info", "已暂停：当前块完成后停止"); }
			else if (kind === "resume") { await resumeCorpus(doc.id); toast("info", "已恢复消化"); }
			else {
				if (!window.confirm(`删除「${doc.title}」？将同时清除其独立套路条目与研究文件。`)) return;
				const result = await deleteCorpus(doc.id);
				setCorpusDetail((c) => { const next = { ...c }; delete next[doc.id]; return next; });
				toast("info", `已删除（清理 ${result.removedMechanisms} 条独占套路）`);
			}
			await loadCorpus();
		} catch (cause) { toast("error", cause instanceof Error ? cause.message : String(cause)); }
	};

	useEffect(() => { void load(); }, []);
	useEffect(() => {
		if (tab !== "diagnostics") return;
		void loadDiagnostics();
		const timer = window.setInterval(() => void loadDiagnostics(), 5_000);
		return () => { window.clearInterval(timer); diagnosticsRequest.current++; };
	}, [tab]);
	useEffect(() => {
		if (tab !== "corpus") return;
		void loadCorpus();
		const timer = window.setInterval(() => void loadCorpus(), 5_000);
		return () => { window.clearInterval(timer); corpusRequest.current++; };
	}, [tab]);
	useEffect(() => {
		const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
		window.addEventListener("keydown", key);
		document.body.classList.add("planning-open");
		return () => { window.removeEventListener("keydown", key); document.body.classList.remove("planning-open"); };
	}, [onClose]);
	useEffect(() => { transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" }); }, [messages, action]);

	const state = data?.state ?? data?.publicView ?? null;
	const proposals = data ? pendingProposals(data) : [];
	const busy = !!action;
	const runChat = async (kind: "chat" | "bootstrap" | "reconcile", message?: string) => {
		const userText = message?.trim();
		if (kind === "chat" && !userText) return;
		if (userText) setMessages((current) => [...current, { role: "user", text: userText }]);
		setAction(kind);
		setLiveText("");
		try {
			let answer = "";
			let proposalCreated = false;
			if (kind === "chat") {
				let streaming = "";
				const result = await streamOutlineChat(userText!, researchMode, discussionFocus, (delta) => {
					streaming += delta;
					setLiveText(streaming);
				});
				setLiveText("");
				answer = result.reply || "讨论已完成。";
				proposalCreated = !!result.proposal;
				setMessages((current) => [...current, { role: "assistant", text: answer, focus: result.focus ?? discussionFocus, options: textOptions(result.options), warnings: list(result.warnings), sceneAdvice: result.sceneAdvice }]);
			} else if (kind === "bootstrap") {
				await bootstrapOutline(wish.trim() || undefined);
				answer = "首次规划提案已生成，请在建议箱审阅。";
				proposalCreated = true;
				setMessages((current) => [...current, { role: "assistant", text: answer }]);
			} else {
				const result = await reconcileOutline();
				proposalCreated = !!result.proposal && !result.committed;
				answer = result.stable ? "校准完成：当前大纲无需调整。"
					: result.committed ? "校准提案已通过审计并自动提交。"
					: result.proposal ? "校准提案已生成，请在建议箱审阅。" : "校准已完成。";
				setMessages((current) => [...current, { role: "assistant", text: answer }]);
			}
			setInput("");
			await load();
			if (proposalCreated) { setTab("proposals"); toast("info", "新提案已放入建议箱"); }
			else if (kind === "reconcile") toast("info", answer);
		} catch (cause) { toast("error", cause instanceof Error ? cause.message : String(cause)); }
		finally { setAction(""); }
	};
	const refreshResearch = async () => {
		setAction("research");
		try {
			const result = await refreshOutlineResearch(researchQuestion.trim() || undefined);
			setResearch(researchItems(result)); setResearchWarnings([]);
			toast("info", "研究灵感已刷新"); setTab("archive");
		} catch (cause) { toast("error", cause instanceof Error ? cause.message : String(cause)); }
		finally { setAction(""); }
	};
	const saveSettings = async (nextMode: OutlineMode, nextResearch: OutlineResearchMode) => {
		setMode(nextMode); setResearchMode(nextResearch); setAction("settings");
		try { const result = await putOutlineSettings({ mode: nextMode, researchMode: nextResearch }); setMode(result.settings.mode); setResearchMode(result.settings.researchMode); toast("info", "规划模式已保存"); }
		catch (cause) { toast("error", cause instanceof Error ? cause.message : String(cause)); await load(); }
		finally { setAction(""); }
	};
	const proposalAction = async (proposal: OutlineProposalView, accept: boolean) => {
		setAction(proposal.id);
		try {
			if (accept) {
				if (!proposal.proposalHash) throw new Error("提案缺少 proposalHash，请刷新后重试");
				await confirmOutlineProposal(proposal.id, proposal.proposalHash);
			}
			else await rejectOutlineProposal(proposal.id, "用户在建议箱拒绝");
			toast("info", accept ? "提案已接受并写入大纲" : "提案已拒绝"); await load();
		} catch (cause) { toast("error", cause instanceof Error ? cause.message : String(cause)); }
		finally { setAction(""); }
	};

	const foreshadowGroups = useMemo(() => {
		const groups = new Map<string, OutlineNode[]>();
		for (const node of list(state?.foreshadowing)) {
			const status = node.foreshadowingStatus || "conceived";
			groups.set(status, [...(groups.get(status) || []), node]);
		}
		return groups;
	}, [state?.foreshadowing]);

	return <div className="planning-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
		<section className={`planning-workbench ${full ? "is-full" : ""}`} role="dialog" aria-modal="true" aria-label="故事规划导演室">
			<header className="planning-head">
				<div><span className="planning-kicker">STORY DESK · 剧本批注</span><h2>故事规划 <small>导演室</small></h2></div>
				<div className="planning-head-actions"><span className="planning-revision">REV {state?.revision ?? "—"}</span><button className="icon-btn planning-full-btn" onClick={() => setFull((value) => !value)}>{full ? "退出全屏" : "全屏"}</button><button className="icon-btn" title="关闭 (Esc)" onClick={onClose}><IconClose size={18} /></button></div>
			</header>
			<nav className="planning-tabs" aria-label="规划页面">{TABS.map(([id, label]) => <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>{label}{id === "proposals" && proposals.length > 0 && <b>{proposals.length}</b>}</button>)}</nav>
			<div className="planning-body">
				{tab === "diagnostics" && <DiagnosticsPage diagnostics={diagnostics} loading={diagnosticsLoading} error={diagnosticsError} onReload={() => void loadDiagnostics()} />}
				{tab !== "diagnostics" && loading && !data && <div className="planning-empty">正在摊开剧本和索引卡…</div>}
				{tab !== "diagnostics" && error && <div className="panel-error planning-error">{error}<button className="drawer-btn" onClick={() => { setLoading(true); void load(); }}>重试</button></div>}
				{tab !== "diagnostics" && !loading && !error && !state && <div className="planning-empty"><strong>这张编剧桌还是空的</strong><span>填写体验愿望后点击“首次规划”，建立第一版故事地图。</span></div>}

				{tab === "room" && <div className="planning-room">
					<div className="planning-transcript" ref={transcriptRef}>
						{messages.length === 0 && <div className="planning-room-intro"><span>给导演的便签</span><h3>直接讨论你想经历什么，不必写成命令。</h3><p>导演室会读取当前剧情、人物状态、世界与生态工件。可以讨论关系路线、下一阶段节奏、伏笔或你不想出现的走向；方案只有在建议箱接受后才写入权威大纲。</p></div>}
						{messages.map((message, index) => <article key={index} className={`planning-chat ${message.role}`}><small>{message.role === "user" ? "你" : "导演"}{message.focus && ` · ${FOCUS_LABEL[message.focus]}`}</small><p>{message.text}</p>{message.sceneAdvice && <SceneAdviceCard advice={message.sceneAdvice} />}{list(message.warnings).map((warning) => <div className="planning-warning" key={warning}>{warning}</div>)}{list(message.options).length > 0 && <div className="planning-options">{message.options!.map((option) => <button key={option} onClick={() => setInput(option)}>{option}</button>)}</div>}</article>)}
						{action && (liveText ? <article className="planning-chat assistant planning-live"><small>导演 · {FOCUS_LABEL[discussionFocus]}</small><p>{liveText}</p></article> : <div className="planning-typing">导演正在翻阅剧情、人物和故事卡…</div>)}
					</div>
					<div className="planning-mode-strip">{DISCUSSION_MODES.map((modeItem) => <button type="button" key={modeItem.id} className={discussionFocus === modeItem.id ? "active" : ""} title={modeItem.note} onClick={() => { setDiscussionFocus(modeItem.id); if (!input.trim()) setInput(modeItem.prompt); }}><b>{modeItem.label}</b><span>{modeItem.note}</span></button>)}</div>
					<div className="planning-compose"><textarea value={input} onChange={(event) => setInput(event.target.value)} placeholder={`${FOCUS_LABEL[discussionFocus]}：${DISCUSSION_MODES.find((item) => item.id === discussionFocus)?.note ?? "讨论当前剧情"}…`} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void runChat("chat", input); } }} /><button className="drawer-btn primary" disabled={busy || !input.trim()} onClick={() => void runChat("chat", input)}>问导演</button></div>
					<div className="planning-tools"><input value={wish} onChange={(event) => setWish(event.target.value)} placeholder="首次规划的用户体验愿望（可选）" /><button disabled={busy} onClick={() => void runChat("bootstrap")}>首次规划</button><button disabled={busy || !state} onClick={() => void runChat("reconcile")}>校准</button><button disabled={busy} onClick={() => void refreshResearch()}><IconRefresh size={13} />研究灵感</button></div>
				</div>}

				{tab === "map" && state && <div className="planning-page"><section className="planning-premise"><span>LOGLINE / 故事前提</span><h3>{state.premise || "尚未形成明确前提"}</h3></section><div className="planning-focus"><strong>当前焦点</strong>{list(state.currentFocus).length ? state.currentFocus!.map((item) => <span key={item}>{item}</span>) : <em>未标记</em>}</div><section><h3 className="planning-section-title">主弧线</h3><div className="planning-grid">{list(state.arcs).map((node) => nodeCard(node, list(node.beats).length ? <ol>{node.beats!.map((beat) => <li key={beat}>{beat}</li>)}</ol> : null))}</div></section><section><h3 className="planning-section-title">开放线索</h3><div className="planning-grid">{list(state.threads).map((node) => nodeCard(node, <><p className="planning-question">{node.question}</p>{node.nextPressure && <small>下一压力：{node.nextPressure}</small>}</>))}</div></section><section><h3 className="planning-section-title">里程碑</h3><div className="planning-grid">{list(state.milestones).map((node) => nodeCard(node, <ul>{list(node.criteria).map((item) => <li key={item}>{item}</li>)}</ul>))}</div></section><section className="planning-alignment"><strong>剧情对齐 · {Math.round((state.alignment?.confidence ?? 0) * 100)}%</strong><p>{state.alignment?.summary || "暂无对齐分析"}</p>{list(state.alignment?.conflicts).map((item) => <div className="planning-warning" key={item}>{item}</div>)}</section></div>}

				{tab === "characters" && state && <div className="planning-page"><div className="planning-page-note">人物弧线是写作方向，不会把角色锁死。要调整时回编剧室用自然语言讨论。</div><div className="planning-character-grid">{list(state.characterArcs).map((node) => <article className="planning-character" key={node.id}><div className="planning-card-head"><strong>{node.character || node.title}</strong><span>{node.status || "candidate"}</span></div><h4>{node.title}</h4><div className="planning-arc-route"><span><small>FROM</small>{node.from || "未定义"}</span><i>→</i><span><small>TOWARD</small>{node.toward || "未定义"}</span></div>{node.summary && <p>{node.summary}</p>}<div className="planning-rigidity">约束强度：<b>{node.rigidity || "open"}</b></div></article>)}</div>{list(state.characterArcs).length === 0 && <div className="planning-empty">暂无人物弧线</div>}</div>}

				{tab === "foreshadowing" && state && <div className="planning-page"><div className="planning-legend"><span className="conceived">仅构想：尚未进入正文</span><span className="planted">已埋设：有正文证据</span></div>{[...foreshadowGroups.entries()].map(([status, nodes]) => <section className="planning-foreshadow-group" key={status}><h3>{FORESHADOW_LABEL[status as ForeshadowingStatus] || status}<b>{nodes.length}</b></h3><div className="planning-grid">{nodes.map((node) => { const secret = node.visibility === "secret" && !revealed.has(node.id); return <article className={`planning-card planning-foreshadow ${status}`} key={node.id}><div className="planning-card-head"><strong>{secret ? "机密伏笔" : node.title}</strong><span>{list(node.evidenceRefs).length} 条证据</span></div>{secret ? <button className="planning-reveal" onClick={() => setRevealed((current) => new Set(current).add(node.id))}>本地揭示机密内容</button> : <><p>{node.setup || node.summary}</p>{node.payoff && <div className="planning-payoff">预期回收：{node.payoff}</div>}</>}</article>; })}</div></section>)}{foreshadowGroups.size === 0 && <div className="planning-empty">暂无伏笔记录</div>}</div>}

				{tab === "proposals" && <div className="planning-page"><div className="planning-page-note">提案只有接受后才写入权威大纲；高风险修改必须在此明确确认。</div>{proposals.map((proposal) => { const issues = list(proposal.audit?.issues); const highRisk = proposal.audit?.verdict === "reject" || issues.some((issue) => issue.severity === "error") || /high|高/i.test(proposal.risk || ""); return <article className={`planning-proposal ${highRisk ? "high-risk" : ""}`} key={proposal.id}><header><div><span>PROPOSAL · {proposal.id.slice(0, 8)} · {proposal.status}</span><h3>{proposal.rationale || "大纲修改建议"}</h3></div><b>{highRisk ? "高风险 · 需确认" : proposal.audit?.verdict === "approve" ? "审计通过" : "待审阅"}</b></header><div className="planning-patch">{patchSummary(proposal.patch).map((row) => <span key={row}>{row}</span>)}</div>{proposal.audit?.summary && <p>{proposal.audit.summary}</p>}{issues.map((issue, index) => <div className={`planning-warning ${issue.severity === "error" ? "error" : ""}`} key={`${issue.code}-${index}`}>{issue.message || issue.code}</div>)}<footer><ConfirmButton className="drawer-btn primary" disabled={busy} confirmText={highRisk ? "再次确认高风险修改" : "再次确认接受"} onConfirm={() => void proposalAction(proposal, true)}>接受提案</ConfirmButton><ConfirmButton className="drawer-btn" disabled={busy} confirmText="再次确认拒绝" onConfirm={() => void proposalAction(proposal, false)}>拒绝</ConfirmButton></footer></article>; })}{proposals.length === 0 && <div className="planning-empty">建议箱已清空。编剧室产生的新方案会自动来到这里。</div>}</div>}

				{tab === "corpus" && <div className="planning-page planning-corpus"><div className="planning-page-note"><strong>小说研究 · 后台消化。</strong>上传 txt/epub 小说后，系统在后台分块摘要成「剧情梗概 + 结构 + 弧线 + 可复用套路」，产物进研究库供大纲模型参考。请仅上传你有权使用的文本。正文只发往你选择的小说消化模型，不进入台上剧情。</div>
				<div className="planning-research-refresh"><button className="drawer-btn primary" disabled={corpusUploading || busy} onClick={() => corpusFileRef.current?.click()}>{corpusUploading ? "上传中…" : "上传 txt/epub"}</button><input ref={corpusFileRef} type="file" hidden accept=".txt,.epub,text/plain" onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadCorpusFile(f); }} /><span>{corpusLoading ? "同步中…" : "5 秒自动刷新"}</span></div>
				{corpusError && <div className="panel-error planning-error">{corpusError}</div>}
				{!corpusLoading && !corpus && <div className="planning-empty">正在读取小说研究任务…</div>}
				{corpus && list(corpus.documents).length === 0 && <div className="planning-empty">还没有上传过小说。txt / epub 会在后台自动分块消化。</div>}
				{corpus?.running && <div className="planning-warning">正在消化：{corpus.documents.find((d) => d.id === corpus.running!.docId)?.title ?? corpus.running.docId} · {CORPUS_STATUS[corpus.running.step] ?? corpus.running.step} {corpus.running.done}/{corpus.running.total}</div>}
				{list(corpus?.documents).map((doc) => {
					const running = corpus?.running?.docId === doc.id;
					const detail = corpusDetail[doc.id];
					return <article className="planning-proposal planning-corpus-item" key={doc.id}>
						<header><div><span>{doc.status === "ready" ? "DOCUMENT · READY" : `DOCUMENT · ${CORPUS_STATUS[doc.status] ?? doc.status}`}</span><h3>{doc.title}</h3></div><b>{corpusMeta(doc)}{doc.error ? ` · ${doc.error}` : ""}</b></header>
						<div className="planning-corpus-acts">
							{doc.status === "ready" && <button className="drawer-btn" disabled={busy} onClick={() => void toggleCorpusDetail(doc)}>{detail ? "收起" : "梗概▾"}</button>}
							{doc.status === "failed" && <button className="drawer-btn" disabled={busy} onClick={() => void corpusAction(doc, "resume")}>重试</button>}
							{doc.status === "paused" && <button className="drawer-btn" disabled={busy} onClick={() => void corpusAction(doc, "resume")}>续跑</button>}
							{(doc.status === "mapping" || doc.status === "cleaning" || running) && doc.status !== "paused" && <button className="drawer-btn" disabled={busy} onClick={() => void corpusAction(doc, "pause")}>暂停</button>}
							<ConfirmButton className="drawer-btn" disabled={busy} confirmText={`确认删除「${doc.title}」`} onConfirm={() => void corpusAction(doc, "delete")}>删除</ConfirmButton>
						</div>
						{detail && <CorpusDigestCard doc={doc} detail={detail} />}
					</article>;
				})}
			</div>}

				{tab === "archive" && <div className="planning-page planning-archive"><section className="planning-settings"><h3>工作模式</h3><label>规划决策<select value={mode} disabled={busy} onChange={(event) => void saveSettings(event.target.value as OutlineMode, researchMode)}><option value="manual">manual · 只记录，手动接受</option><option value="suggest">suggest · 主动给建议</option><option value="auto">auto · 低风险自动执行</option></select></label><label>研究方式<select value={researchMode} disabled={busy} onChange={(event) => void saveSettings(mode, event.target.value as OutlineResearchMode)}><option value="off">off · 关闭</option><option value="manual">manual · 明确要求时</option><option value="auto">auto · 按需研究</option></select></label></section><section><div className="planning-section-head"><h3 className="planning-section-title">版本记录</h3><span>当前 revision {state?.revision ?? "—"}</span></div><div className="planning-history">{history.map((item, index) => <article key={`${item.revision}-${index}`}><b>REV {item.revision ?? "—"}</b><span>{item.summary || item.rationale || "大纲快照"}</span><time>{item.createdAt || item.timestamp ? new Date(item.createdAt || item.timestamp || "").toLocaleString() : ""}</time></article>)}{history.length === 0 && <div className="planning-empty">暂无历史版本</div>}</div></section><section><div className="planning-section-head"><h3 className="planning-section-title">研究灵感</h3><div className="planning-research-refresh"><input value={researchQuestion} onChange={(event) => setResearchQuestion(event.target.value)} placeholder="想研究什么机制或类型？"/><button className="drawer-btn" disabled={busy} onClick={() => void refreshResearch()}>刷新研究</button></div></div>{researchWarnings.map((warning) => <div className="planning-warning" key={warning}>{warning}</div>)}<div className="planning-grid">{research.map((item, index) => <article className="planning-research-card" key={item.id || index}><h4>{item.url ? <a href={item.url} target="_blank" rel="noreferrer">{item.title || item.url}</a> : item.title || "未命名来源"}</h4>{item.excerpt && <blockquote>{item.excerpt}</blockquote>}<p>{item.mechanism || item.note}</p>{list(item.failureWarnings ?? item.warnings).map((warning) => <div className="planning-warning" key={warning}>失败警告：{warning}</div>)}</article>)}</div>{research.length === 0 && <div className="planning-empty">暂无研究来源。研究只提供灵感，不会自动成为剧情事实。</div>}</section></div>}
			</div>
		</section>
	</div>;
}
