import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import "./novel-digest-base.test.ts";
import { CorpusEngine, chunkText, splitChapters } from "../src/outline/corpus.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "novel-url-metadata-"));

function digestResponse(task: string): string {
	if (task === "digest-map") return JSON.stringify({ summary: "块摘要", chapters: [] });
	if (task === "digest-reduce-arc") return JSON.stringify({ summary: "弧线" });
	if (task === "digest-reduce-final") return JSON.stringify({ synopsis: "梗概", structure: { plotSpine: "主线", characterArcs: "人物", hooksAndPacing: "节奏" } });
	if (task === "digest-extract-mechanisms") return JSON.stringify({ tropes: [] });
	if (task === "digest-extract-daily") return JSON.stringify({ dailyPatterns: [] });
	if (task === "digest-extract-assets") return JSON.stringify({ assets: [] });
	return JSON.stringify({ version: 1, verdict: "approve", issues: [], summary: "ok" });
}

function deps(cwd: string) {
	return {
		cwd,
		runSideModel: async (_step: string, _system: string, userText: string) => digestResponse(JSON.parse(userText).task),
		loadSkill: () => "skill-body",
		cardKey: () => "card-a",
		fetchText: async (url: URL): Promise<string> => {
			if (!url.pathname.includes("/episodes/")) return '<h1><a title="测试作品"></a></h1>{"Episode:1":{"title":"第一章"}}';
			return [
				'<p class="widget-episodeTitle">第一章</p>',
				'<p id="p1">正文第一行。</p>',
				'<p id="p2">本书首发于某站，请记住本站域名。</p>',
				'<p id="p3">上一章 目录 下一章</p>',
				'<p id="p4">正文第二行。</p>',
			].join("\n");
		},
	};
}

function textPath(cwd: string, id: string): string {
	return join(cwd, ".liyuan", "outline", "research", "corpus", "texts", `${id}.txt`);
}

function documentsPath(cwd: string): string {
	return join(cwd, ".liyuan", "outline", "research", "corpus", "documents.json");
}

test("URL ready 元数据取自已清洗的持久化文本", async () => {
	const cwd = tmp();
	try {
		const engine = new CorpusEngine(deps(cwd));
		const { doc } = await engine.createUrl("https://kakuyomu.jp/works/metadata_test");
		await engine.waitIdle();
		const text = readFileSync(textPath(cwd, doc.id), "utf8");
		const ready = engine.getDoc(doc.id);
		assert.equal(ready?.status, "ready");
		assert.equal(text.includes("本书首发"), false);
		assert.equal(text.includes("上一章"), false);
		assert.equal(ready?.chars, text.length);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("重启恢复时修复旧的不一致持久化元数据", async () => {
	const cwd = tmp();
	try {
		const first = new CorpusEngine(deps(cwd));
		const { doc } = await first.createUrl("https://kakuyomu.jp/works/recovery_test");
		await first.waitIdle();
		const path = documentsPath(cwd);
		const stored = JSON.parse(readFileSync(path, "utf8"));
		stored[0].status = "mapping";
		stored[0].chars = 999999;
		stored[0].chunkCount = 999;
		stored[0].chapterCount = 999;
		writeFileSync(path, `${JSON.stringify(stored, null, 2)}\n`);

		const restored = new CorpusEngine(deps(cwd));
		restored.restore();
		await restored.waitIdle();
		const text = readFileSync(textPath(cwd, doc.id), "utf8");
		const split = splitChapters(text);
		const repaired = restored.getDoc(doc.id);
		assert.equal(repaired?.status, "ready");
		assert.equal(repaired?.chars, text.length);
		assert.equal(repaired?.chunkCount, chunkText(split.chapters).length);
		assert.equal(repaired?.chapterCount, split.detected ? split.chapters.length : 0);
		const persisted = JSON.parse(readFileSync(path, "utf8"))[0];
		assert.equal(persisted.chars, text.length);
		assert.equal(persisted.chunkCount, repaired?.chunkCount);
		assert.equal(persisted.chapterCount, repaired?.chapterCount);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});
