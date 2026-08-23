import type { ForeshadowingStatus, OutlineCollectionName, OutlineNode, OutlineState } from "./schema.ts";
import type { OutlineResearchView } from "./research.ts";

export type OutlineConsumer = "continuity" | "director" | "writer" | "world" | "ecology" | "public";
export interface SafeOutlineNode { id: string; title: string; summary: string; status: OutlineNode["status"]; rigidity: OutlineNode["rigidity"]; visibility: OutlineNode["visibility"]; actuality: OutlineNode["actuality"]; dependsOn: string[]; foreshadowingStatus?: ForeshadowingStatus }
export interface OutlineProjection { revision: number; hash: string; premise: string; currentFocus: string[]; alignment?: { summary: string; confidence: number; conflicts: string[] }; collections: Partial<Record<OutlineCollectionName, SafeOutlineNode[]>>; nonFactGuidance?: true }
const COLLECTIONS: OutlineCollectionName[] = ["constraints", "arcs", "characterArcs", "threads", "milestones", "foreshadowing", "settings"];
const safe = (node: OutlineNode, collection: OutlineCollectionName): SafeOutlineNode => ({ id: node.id, title: node.title, summary: node.summary, status: node.status, rigidity: node.rigidity, visibility: node.visibility, actuality: node.actuality, dependsOn: [...node.dependsOn], ...(collection === "foreshadowing" ? { foreshadowingStatus: (node as { foreshadowingStatus: ForeshadowingStatus }).foreshadowingStatus } : {}) });

export function projectOutline(state: OutlineState, consumer: OutlineConsumer): OutlineProjection {
	const guidance = consumer === "world" || consumer === "ecology", collections: OutlineProjection["collections"] = {};
	let remaining = consumer === "director" ? 16 : Number.POSITIVE_INFINITY;
	if (!guidance) for (const collection of COLLECTIONS) {
		let rows = (state[collection] as OutlineNode[]).filter((node) => node.visibility !== "secret");
		if (consumer === "public") rows = rows.filter((node) => node.visibility === "public");
		if (consumer === "writer") rows = rows.filter((node) => node.visibility === "public" && (node.rigidity === "hard" || state.currentFocus.includes(node.id) || ["active", "blocked"].includes(node.status)));
		if (consumer === "director") {
			rows = rows
				.filter((node) => node.rigidity === "hard" || state.currentFocus.includes(node.id) || ["active", "blocked"].includes(node.status))
				.sort((a, b) => Number(b.rigidity === "hard") - Number(a.rigidity === "hard") || Number(state.currentFocus.includes(b.id)) - Number(state.currentFocus.includes(a.id)))
				.slice(0, remaining);
			remaining -= rows.length;
		}
		if (consumer === "continuity") rows = rows.filter((node) => node.actuality === "established" || node.status === "fulfilled" || (collection === "foreshadowing" && !["conceived", "prepared"].includes(String((node as { foreshadowingStatus?: string }).foreshadowingStatus))));
		collections[collection] = rows.map((node) => safe(node, collection));
	}
	const visibleIds = new Set(Object.values(collections).flatMap((rows) => rows ?? []).map((node) => node.id));
	return { revision: state.revision, hash: state.hash, premise: consumer === "public" || consumer === "writer" || guidance ? "" : state.premise, currentFocus: state.currentFocus.filter((id) => visibleIds.has(id)), ...(consumer === "continuity" || consumer === "director" ? { alignment: { summary: state.alignment.summary, confidence: state.alignment.confidence, conflicts: [...state.alignment.conflicts] } } : {}), collections, ...(guidance ? { nonFactGuidance: true as const } : {}) };
}

export interface CorpusWorkspaceProjection {
	documents: Array<{ title: string; chars: number; synopsis: string; tropeCount: number }>;
	mechanisms: OutlineResearchView["mechanisms"];
}

/**
 * 大纲模型看到的「小说资产」安全投影：只注入 ready 且与当前卡关联的文档，
 * 每条只给 title / chars / synopsis 前 400 字 / tropeCount，绝不整包注入 block 与弧线摘要。
 */
export function projectCorpusWorkspace(view: OutlineResearchView, options: { maxDocs?: number } = {}): CorpusWorkspaceProjection {
	const maxDocs = Math.max(1, Math.min(10, options.maxDocs ?? 3));
	const documents = view.documents
		.filter((doc) => doc.status === "ready")
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
		.slice(0, maxDocs)
		.map((doc) => ({
			title: doc.title,
			chars: doc.chars,
			synopsis: (doc.synopsisPreview ?? "").slice(0, 400),
			tropeCount: doc.tropeCount ?? 0,
		}));
	return { documents, mechanisms: view.mechanisms };
}
