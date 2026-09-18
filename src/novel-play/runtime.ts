import type { BranchEntryLike } from "../stage/assemble.ts";
import type { NovelAnchor, NovelConflict, NovelPackage } from "./canon.ts";
import { projectNovelCandidates } from "./canon.ts";
import { loadNovelPackage } from "./store.ts";

export const NOVEL_PLAY_STATE_ENTRY_TYPE = "rp-novel-play";
const MAX_BRANCH_FACT_CHARS = 40_000;
const MAX_CANDIDATE_CHARS = 6_000;

export interface NovelPlayCardBinding { docId: string; revision: string; startNodeId: string; position: NovelAnchor["position"]; }
export interface NovelPlayRuntimeState { version: 1; card: NovelPlayCardBinding; progress: NovelAnchor; conflicts: NovelConflict[]; preparedFromLeafId: string; }
export interface NovelPlayProjection { version: 1; packageRevision: string; anchor: NovelAnchor; candidates: Array<{ nodeId: string; title: string; summary: string; actuality: "candidate" }>; blockedNodeIds: string[]; omittedNodeIds: string[]; usedChars: number; }
export interface PreparedNovelPlayTurn { projection: NovelPlayProjection; state: NovelPlayRuntimeState; }
export interface PrepareNovelPlayTurnInput {
	cwd: string; rawCard: unknown; branch: BranchEntryLike[]; expectedLeafId: string | null; skillBody: string;
	modelCall: (systemPrompt: string, userText: string) => Promise<string | undefined>;
	getLeafId: () => string | null; loadPackage?: typeof loadNovelPackage;
}

const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";

export function novelPlayCardBinding(rawCard: unknown): NovelPlayCardBinding | undefined {
	const root = record(rawCard), data = record(root?.data) ?? root, extension = record(record(data?.extensions)?.liyuanNovelPlay);
	if (!extension) return undefined;
	const docId = text(extension.docId), revision = text(extension.revision), startNodeId = text(extension.startNodeId), position = extension.position;
	if (!docId || !revision || !startNodeId || (position !== "before" && position !== "after")) return undefined;
	return { docId, revision, startNodeId, position };
}
function sameCard(a: NovelPlayCardBinding, b: NovelPlayCardBinding): boolean { return a.docId === b.docId && a.revision === b.revision && a.startNodeId === b.startNodeId && a.position === b.position; }
function validAnchor(pkg: NovelPackage, value: unknown): NovelAnchor | undefined {
	const raw = record(value), nodeId = text(raw?.nodeId), packageRevision = text(raw?.packageRevision), position = raw?.position;
	if (packageRevision !== pkg.revision || !pkg.nodes.some(node => node.id === nodeId) || (position !== "before" && position !== "after")) return undefined;
	return { packageRevision, nodeId, position };
}
function conflictsOf(pkg: NovelPackage, value: unknown, ancestorIds: ReadonlySet<string>): NovelConflict[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const conflicts: NovelConflict[] = [];
	for (const item of value) {
		const raw = record(item), nodeId = text(raw?.nodeId);
		if (text(raw?.packageRevision) !== pkg.revision || !pkg.nodes.some(node => node.id === nodeId) || !Array.isArray(raw?.sourceEntryIds)) return undefined;
		const sourceEntryIds = [...new Set(raw.sourceEntryIds.map(text).filter(Boolean))];
		if (!sourceEntryIds.length || sourceEntryIds.some(id => !ancestorIds.has(id))) return undefined;
		conflicts.push({ packageRevision: pkg.revision, nodeId, sourceEntryIds });
	}
	return conflicts;
}

export function novelPlayStateFromBranch(branch: BranchEntryLike[], binding: NovelPlayCardBinding, pkg: NovelPackage): NovelPlayRuntimeState | undefined {
	const ids = new Set(branch.map(entry => text(entry.id)).filter(Boolean));
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		if (entry.type !== "custom" || entry.customType !== NOVEL_PLAY_STATE_ENTRY_TYPE) continue;
		const raw = record(entry.data), card = record(raw?.card) as NovelPlayCardBinding | undefined;
		const progress = validAnchor(pkg, raw?.progress), conflicts = conflictsOf(pkg, raw?.conflicts, ids), preparedFromLeafId = text(raw?.preparedFromLeafId);
		if (raw?.version === 1 && card && sameCard(card, binding) && progress && conflicts && preparedFromLeafId && ids.has(preparedFromLeafId)) return { version: 1, card: binding, progress, conflicts, preparedFromLeafId };
	}
	return undefined;
}

function branchFacts(branch: BranchEntryLike[]): Array<{ entryId: string; kind: string; text?: string; data?: unknown }> {
	const rows: Array<{ entryId: string; kind: string; text?: string; data?: unknown }> = [];
	let used = 0;
	for (const entry of branch) {
		const entryId = text(entry.id); if (!entryId) continue;
		let row: (typeof rows)[number] | undefined;
		const message = record(entry.message), role = text(message?.role) || text(entry.type);
		if (role === "user" || role === "assistant") {
			const parts = Array.isArray(message?.content) ? message.content : [], details = record(message?.details);
			const body = parts.map(part => record(part)?.type === "text" ? text(record(part)?.text) : "").filter(Boolean).join("");
			row = { entryId, kind: role, text: text(details?.rpNarrative) || body };
		} else if (entry.type === "custom" && ["rp-state", "rp-world-state", "rp-ecology-state", "rp-summary"].includes(text(entry.customType))) row = { entryId, kind: text(entry.customType), data: entry.data };
		else if (entry.type === "custom_message" && ["rp-greeting", "rp-edited-reply", "rp-import"].includes(text(entry.customType))) row = { entryId, kind: text(entry.customType), text: text(entry.content) };
		if (!row) continue;
		const chars = JSON.stringify(row).length;
		while (rows.length && used + chars > MAX_BRANCH_FACT_CHARS) used -= JSON.stringify(rows.shift()).length;
		if (chars <= MAX_BRANCH_FACT_CHARS) { rows.push(row); used += chars; }
	}
	return rows;
}
function parseModelResult(value: string): Record<string, unknown> | undefined { try { return record(JSON.parse(value)); } catch { return undefined; } }

/** Read-only per-turn projection. Canon summaries are candidates, never facts. Source chunks and card books are never model input. */
export async function prepareNovelPlayTurn(input: PrepareNovelPlayTurnInput): Promise<PreparedNovelPlayTurn | undefined> {
	const binding = novelPlayCardBinding(input.rawCard);
	if (!binding || !input.expectedLeafId || input.getLeafId() !== input.expectedLeafId || !input.skillBody.trim()) return undefined;
	const pkg = (input.loadPackage ?? loadNovelPackage)(input.cwd, binding.docId, binding.revision).package;
	const ids = new Set(input.branch.map(entry => text(entry.id)).filter(Boolean));
	if (!ids.has(input.expectedLeafId)) return undefined;
	const prior = novelPlayStateFromBranch(input.branch, binding, pkg);
	const startingAnchor: NovelAnchor = prior?.progress ?? { packageRevision: pkg.revision, nodeId: binding.startNodeId, position: binding.position };
	const startNode = pkg.nodes.find(node => node.id === startingAnchor.nodeId);
	if (!validAnchor(pkg, startingAnchor) || !startNode) return undefined;
	const canonical = pkg.nodes.filter(node => node.stageId === startNode.stageId && node.visibility === "public").map(node => ({ nodeId: node.id, order: node.order, title: node.title, summary: node.summary, dependsOn: node.dependsOn }));
	let modelText: string | undefined;
	try { modelText = await input.modelCall(input.skillBody, JSON.stringify({ binding, startingAnchor, canonical_candidates_not_facts: canonical, current_authoritative_branch: branchFacts(input.branch) })); }
	catch { return undefined; }
	if (!modelText || input.getLeafId() !== input.expectedLeafId) return undefined;
	const parsed = parseModelResult(modelText), progress = parsed?.version === 1 ? validAnchor(pkg, parsed.progress) : undefined, conflicts = parsed?.version === 1 ? conflictsOf(pkg, parsed.conflicts, ids) : undefined;
	const progressNode = progress ? pkg.nodes.find(node => node.id === progress.nodeId) : undefined;
	if (!progress || !progressNode || !conflicts || progressNode.stageId !== startNode.stageId || progressNode.visibility !== "public" || progressNode.order < startNode.order) return undefined;
	const projected = projectNovelCandidates(pkg, progress, { ancestorEntryIds: ids, conflicts, conflictsReady: true, maxChars: MAX_CANDIDATE_CHARS });
	return { projection: { version: 1, packageRevision: pkg.revision, anchor: progress, ...projected }, state: { version: 1, card: binding, progress, conflicts, preparedFromLeafId: input.expectedLeafId } };
}

/** Persist validated metadata only. It never stores canon text or a second fact set. */
export function commitNovelPlayState(input: { prepared: PreparedNovelPlayTurn | undefined; expectedLeafId: string | null; getLeafId: () => string | null; appendCustomEntry: (customType: string, data?: unknown) => string; }): string | undefined {
	if (!input.prepared || !input.expectedLeafId || input.getLeafId() !== input.expectedLeafId) return undefined;
	return input.appendCustomEntry(NOVEL_PLAY_STATE_ENTRY_TYPE, input.prepared.state);
}
