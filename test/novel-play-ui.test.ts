import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
	buildNovelPlay, cancelNovelPlayJob, getNovelPlayJob, getNovelPlayStartOptions,
	listNovelPlayJobs, previewNovelPlay, startNovelPlay,
} from "../web/src/planning/novel-play-client.ts";

const client = readFileSync(new URL("../web/src/planning/novel-play-client.ts", import.meta.url), "utf8");
const ui = readFileSync(new URL("../web/src/planning/novel-play.tsx", import.meta.url), "utf8");
const corpus = readFileSync(new URL("../web/src/planning/modules/CorpusModule.tsx", import.meta.url), "utf8");
const server = readFileSync(new URL("../server/novel-play-api.ts", import.meta.url), "utf8");
const application = readFileSync(new URL("../src/novel-play/application.ts", import.meta.url), "utf8");

const jsonResponse = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

test("novel play client sends the exact route methods and DTO bodies", async () => {
	const calls: Array<{ url: string; method: string; body: unknown }> = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		calls.push({ url, method, body });
		if (url === "/api/novel-play/status") return jsonResponse({ jobs: [] });
		if (method === "DELETE") return jsonResponse({ job: { id: "a".repeat(32), docId: "doc id", status: "cancelled", createdAt: "c", updatedAt: "u" } });
		if (url.startsWith("/api/novel-play/status/")) return jsonResponse({ job: { id: "a".repeat(32), docId: "doc id", status: "running", createdAt: "c", updatedAt: "u" } });
		if (method === "GET") return jsonResponse({ package: { docId: "doc id", revision: "rev/value", title: "Book", nodes: [{ nodeId: "public-1", title: "Visible" }] } });
		if (url.endsWith("/build")) return jsonResponse({ job: { id: "a".repeat(32), docId: "doc id", status: "queued", createdAt: "c", updatedAt: "u" } }, 202);
		if (url.endsWith("/preview")) return jsonResponse({ preview: { token: "one-time", expiresAt: "x", package: { docId: "doc id", revision: "rev/value" }, anchor: { packageRevision: "rev/value", nodeId: "public-1", position: "before" }, draft: { user: { name: "N", identity: "I" }, time: "T", place: "P", sceneText: "S", openingNarration: "O", publicCharacterProfiles: [], publicWorldFacts: [] } } });
		return jsonResponse({ started: { card: "card.json", session: "created" } }, 201);
	};
	try {
		const built = await buildNovelPlay("doc id");
		await listNovelPlayJobs();
		await getNovelPlayJob("a".repeat(32));
		await cancelNovelPlayJob("a".repeat(32));
		const options = await getNovelPlayStartOptions("doc id", "rev/value");
		const preview = await previewNovelPlay({ docId: "doc id", revision: "rev/value", nodeId: "public-1", position: "before", player: { name: "N", identity: "I" } });
		const started = await startNovelPlay("one-time");
		assert.equal(built.job.status, "queued");
		assert.deepEqual(options.package.nodes, [{ nodeId: "public-1", title: "Visible" }]);
		assert.equal(preview.preview.draft.openingNarration, "O");
		assert.equal(started.started.session, "created");
	} finally { globalThis.fetch = originalFetch; }

	assert.deepEqual(calls, [
		{ url: "/api/novel-play/build", method: "POST", body: { docId: "doc id" } },
		{ url: "/api/novel-play/status", method: "GET", body: undefined },
		{ url: `/api/novel-play/status/${"a".repeat(32)}`, method: "GET", body: undefined },
		{ url: `/api/novel-play/status/${"a".repeat(32)}`, method: "DELETE", body: undefined },
		{ url: "/api/novel-play/start?docId=doc%20id&revision=rev%2Fvalue", method: "GET", body: undefined },
		{ url: "/api/novel-play/preview", method: "POST", body: { docId: "doc id", revision: "rev/value", nodeId: "public-1", position: "before", player: { name: "N", identity: "I" } } },
		{ url: "/api/novel-play/start", method: "POST", body: { previewToken: "one-time" } },
	]);
});

test("server start options expose only public node ids and titles", () => {
	assert.match(application, /nodes: value\.package\.nodes\.filter\(\(node\) => node\.visibility === "public"\)\.map\(\(node\) => \(\{ nodeId: node\.id, title: node\.title \}\)\)/);
	assert.doesNotMatch(client.match(/interface NovelPlayStartOptions[^\n]+/)?.[0] ?? "", /summary|visibility|sourceRefs|dependsOn/);
	assert.match(server, /send\(res, 200, \{ package: startOptions/);
	assert.match(server, /const output: PreviewPublicDto = \{ token, expiresAt:/);
});

test("novel play UI cleans polls, preserves cancel semantics, and explains limits", () => {
	assert.match(ui, /window\.clearTimeout\(timer\); abort\.abort\(\)/);
	assert.match(ui, /const close = \(\) => \{ invalidate\(\); onClose\(\); \}/);
	assert.match(ui, /cancelNovelPlayJob\(job\.id\)/);
	assert.doesNotMatch(ui, /deleteCorpus|内置运行时仍在接入中/);
	assert.match(ui, /关闭窗口只停止前端查询/);
	assert.match(ui, /取消不会删除藏书/);
	assert.match(ui, /当前作品阶段按原文分块生成，不代表语义章节/);
	assert.match(ui, /仅支持创建新玩家角色/);
	assert.match(ui, /selectedNodeIndex === 0 && position === "before"/);
	assert.match(ui, /首个节点之前可能没有可提取的原文/);
	assert.match(ui, /节点之后/);
	assert.match(ui, /更后的公开节点/);
	assert.match(corpus, /doc\.status === "ready"/);
	assert.match(corpus, /<NovelPlayDialog docId=\{playing\.id\}/);
});
