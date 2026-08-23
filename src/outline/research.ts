import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

import type { WebResearchItem } from "../tools/web-research.ts";
import type { CorpusDigest, CorpusDocument } from "./corpus.ts";

export interface OutlineResearchSource { id: string; title: string; url: string; accessedAt: string }
export interface OutlineResearchMechanism { id: string; sourceIds: string[]; mechanism: string; appliesWhen: string; failureWarning: string }
export interface OutlineResearchCard { version: 1; cardKey: string; mechanismIds: string[]; updatedAt: string }
export interface OutlineResearchView { sources: OutlineResearchSource[]; mechanisms: OutlineResearchMechanism[]; cards: OutlineResearchCard[]; documents: CorpusDocument[] }
export interface OutlineResearchExtraction { mechanism: string; appliesWhen: string; failureWarning: string; sourceIds: string[] }

const arrayFile = <T>(path: string): T[] => {
	try { const value = JSON.parse(readFileSync(path, "utf8")); return Array.isArray(value) ? value as T[] : []; } catch { return []; }
};

export class OutlineResearchStore {
	#root: string;
	#write = Promise.resolve();
	constructor(cwd: string) { this.#root = join(cwd, ".liyuan", "outline", "research"); }

	view(cardKey?: string): OutlineResearchView {
		const cardsDir = join(this.#root, "cards");
		const cards: OutlineResearchCard[] = [];
		if (existsSync(cardsDir)) {
			for (const name of readdirSync(cardsDir)) {
				if (!name.endsWith(".json")) continue;
				try { cards.push(JSON.parse(readFileSync(join(cardsDir, name), "utf8")) as OutlineResearchCard); } catch {}
			}
		}
		const allSources = arrayFile<OutlineResearchSource>(join(this.#root, "sources.json"));
		const allMechanisms = arrayFile<OutlineResearchMechanism>(join(this.#root, "mechanisms.json"));
		const documents = this.#documents();
		if (!cardKey) return { sources: allSources, mechanisms: allMechanisms, cards, documents };
		const card = cards.find((row) => row.cardKey === cardKey);
		const mechanismIds = new Set(card?.mechanismIds ?? []), mechanisms = allMechanisms.filter((row) => mechanismIds.has(row.id));
		const sourceIds = new Set(mechanisms.flatMap((row) => row.sourceIds));
		// 小说文档：只返回由该卡机制条目标注的 doc-*（避免把别的卡的小说混进来）
		const docIds = new Set(mechanisms.flatMap((row) => row.sourceIds.filter((id) => id.startsWith("doc-"))));
		return {
			sources: allSources.filter((row) => sourceIds.has(row.id)),
			mechanisms,
			cards: card ? [card] : [],
			documents: documents.filter((row) => docIds.has(row.id)),
		};
	}

	#documents(): CorpusDocument[] {
		try {
			const value = JSON.parse(readFileSync(join(this.#root, "corpus", "documents.json"), "utf8"));
			return Array.isArray(value) ? value as CorpusDocument[] : [];
		} catch { return []; }
	}

	/** 小说消化完成时把套路条目合并进研究库：mechanisms + card 关联（documents 由 CorpusEngine 自己落盘）。 */
	mergeCorpus(cardKey: string, document: CorpusDocument, _digest: CorpusDigest, extracted: OutlineResearchExtraction[]): Promise<CorpusDocument[]> {
		const task = this.#write.then(() => {
			const current = this.view();
			const mechanisms = new Map(current.mechanisms.map((row) => [row.id, row]));
			const ids: string[] = [];
			for (const item of extracted.slice(0, 80)) {
				const sourceIds = [...new Set(item.sourceIds)].filter((id) => id.startsWith("doc-"));
				if (!sourceIds.length || !item.mechanism.trim()) continue;
				const mechanism = item.mechanism.trim().slice(0, 600), appliesWhen = item.appliesWhen.trim().slice(0, 500), failureWarning = item.failureWarning.trim().slice(0, 500);
				const mechanismId = `mech-${createHash("sha256").update(`${mechanism}\n${sourceIds.sort().join(",")}`).digest("hex").slice(0, 16)}`;
				mechanisms.set(mechanismId, { id: mechanismId, sourceIds, mechanism, appliesWhen, failureWarning });
				ids.push(mechanismId);
			}
			const oldCard = current.cards.find((row) => row.cardKey === cardKey);
			const card: OutlineResearchCard = { version: 1, cardKey, mechanismIds: [...new Set([...(oldCard?.mechanismIds ?? []), ...ids])].slice(-100), updatedAt: new Date().toISOString() };
			this.#atomic(join(this.#root, "mechanisms.json"), [...mechanisms.values()]);
			this.#atomic(join(this.#root, "cards", `${safeKey(cardKey)}.json`), card);
			const scoped = this.view(cardKey);
			return scoped.documents;
		});
		this.#write = task.then(() => undefined, () => undefined);
		return task;
	}

	/** 删除只被该文档引用（sourceIds 全部指向该 doc-*）的机制条目；被 Web 来源共同支撑的保留。返回删除条数。 */
	removeCorpus(docId: string): Promise<number> {
		const task = this.#write.then(() => {
			const current = this.view();
			const removed = new Set<string>();
			const kept = current.mechanisms.filter((row) => {
				if (row.sourceIds.includes(docId) && row.sourceIds.every((id) => id.startsWith("doc-"))) {
					// 仅该 doc 支撑：删除（除非还挂在其他 doc-* —— corpus 机制不会跨文档）
					if (row.sourceIds.length === 1) { removed.add(row.id); return false; }
				}
				return true;
			});
			if (!removed.size) return 0;
			this.#atomic(join(this.#root, "mechanisms.json"), kept);
			// 卡关联也清理
			for (const card of current.cards) {
				const next = card.mechanismIds.filter((id) => !removed.has(id));
				if (next.length !== card.mechanismIds.length) {
					this.#atomic(join(this.#root, "cards", `${safeKey(card.cardKey)}.json`), { ...card, mechanismIds: next, updatedAt: new Date().toISOString() });
				}
			}
			return removed.size;
		});
		this.#write = task.then(() => undefined, () => undefined);
		return task;
	}

	merge(cardKey: string, rows: WebResearchItem[], extracted: OutlineResearchExtraction[] = []): Promise<OutlineResearchView> {
		const task = this.#write.then(() => {
			const current = this.view();
			const sources = new Map(current.sources.map((row) => [row.url, row]));
			const mechanisms = new Map(current.mechanisms.map((row) => [row.id, row]));
			const ids: string[] = [], fetchedSourceIds = new Set<string>();
			for (const item of rows) for (const result of item.results ?? []) {
				let url: string;
				try { url = new URL(result.url).toString(); } catch { continue; }
				const sourceId = `src-${createHash("sha256").update(url).digest("hex").slice(0, 16)}`;
				sources.set(url, { id: sourceId, title: result.title.trim().slice(0, 180), url, accessedAt: new Date().toISOString() });
				fetchedSourceIds.add(sourceId);
			}
			for (const item of extracted.slice(0, 80)) {
				const sourceIds = [...new Set(item.sourceIds)].filter((id) => fetchedSourceIds.has(id));
				if (!sourceIds.length || !item.mechanism.trim()) continue;
				const mechanism = item.mechanism.trim().slice(0, 600), appliesWhen = item.appliesWhen.trim().slice(0, 500), failureWarning = item.failureWarning.trim().slice(0, 500);
				const mechanismId = `mech-${createHash("sha256").update(`${mechanism}\n${sourceIds.sort().join(",")}`).digest("hex").slice(0, 16)}`;
				mechanisms.set(mechanismId, { id: mechanismId, sourceIds, mechanism, appliesWhen, failureWarning });
				ids.push(mechanismId);
			}
			const oldCard = current.cards.find((row) => row.cardKey === cardKey);
			const card: OutlineResearchCard = { version: 1, cardKey, mechanismIds: [...new Set([...(oldCard?.mechanismIds ?? []), ...ids])].slice(-100), updatedAt: new Date().toISOString() };
			this.#atomic(join(this.#root, "sources.json"), [...sources.values()]);
			this.#atomic(join(this.#root, "mechanisms.json"), [...mechanisms.values()]);
			this.#atomic(join(this.#root, "cards", `${safeKey(cardKey)}.json`), card);
			const scoped = this.view(cardKey);
			if (scoped.sources.length || scoped.mechanisms.length) return scoped;
			return { sources: [...sources.values()].filter((row) => fetchedSourceIds.has(row.id)), mechanisms: [], cards: [card] };
		});
		this.#write = task.then(() => undefined, () => undefined);
		return task;
	}

	#atomic(path: string, value: unknown): void {
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		renameSync(tmp, path);
	}
}

function safeKey(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 24); }
