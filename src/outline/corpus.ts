import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import * as Base from "./corpus-base.ts";

export * from "./corpus-base.ts";

/** Keep persisted corpus metadata derived from the persisted clean text. */
export class CorpusEngine extends Base.CorpusEngine {
	#cwd: string;

	constructor(deps: Base.CorpusEngineDeps, maxCallsPerDoc = 800) {
		let engine: CorpusEngine | undefined;
		const wrapped: Base.CorpusEngineDeps = {
			...deps,
			runSideModel: async (...args) => {
				engine?.#repairPersistedMetadata();
				return deps.runSideModel(...args);
			},
			onReady: async (document, digest, extractions) => {
				engine?.#repairPersistedMetadata();
				await deps.onReady?.(document, digest, extractions);
			},
		};
		super(wrapped, maxCallsPerDoc);
		this.#cwd = deps.cwd;
		engine = this;
		this.#repairPersistedMetadata();
	}

	#repairPersistedMetadata(): void {
		let changed = false;
		for (const doc of this.view().documents) {
			const textPath = `${Base.corpusTextsDir(this.#cwd)}/${doc.id}.txt`;
			if (!existsSync(textPath)) continue;
			const text = readFileSync(textPath, "utf8");
			if (!text) continue;
			const { chapters, detected } = Base.splitChapters(text);
			const chunks = Base.chunkText(chapters, Base.CHUNK_CHARS, Base.MAX_CHUNKS);
			const chapterCount = detected ? chapters.length : 0;
			if (doc.chars === text.length && doc.chunkCount === chunks.length && doc.chapterCount === chapterCount) continue;
			doc.chars = text.length;
			doc.chunkCount = chunks.length;
			doc.chapterCount = chapterCount;
			doc.updatedAt = new Date().toISOString();
			changed = true;
		}
		if (!changed) return;
		const path = Base.corpusDocumentsFile(this.#cwd);
		const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(this.view().documents, null, 2)}\n`, "utf8");
		renameSync(tmp, path);
	}
}
