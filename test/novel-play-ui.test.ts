import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const client = readFileSync(new URL("../web/src/planning/novel-play-client.ts", import.meta.url), "utf8");
const ui = readFileSync(new URL("../web/src/planning/novel-play.tsx", import.meta.url), "utf8");
const corpus = readFileSync(new URL("../web/src/planning/modules/CorpusModule.tsx", import.meta.url), "utf8");

test("novel play UI uses the exact server route contract", () => {
	for (const route of ["/api/novel-play/build", "/api/novel-play/status", "/api/novel-play/start", "/api/novel-play/preview"]) assert.match(client, new RegExp(route.replaceAll("/", "\\/")));
	assert.match(client, /method: "DELETE"|apiDelete/);
	assert.match(client, /previewToken/);
	assert.doesNotMatch(client + ui, /snapshot|JSON\.parse|manual/i);
});

test("novel play UI guards jobs, stale requests, and explicit confirmation", () => {
	assert.match(ui, /AbortController/);
	assert.match(ui, /generation\.current/);
	assert.match(ui, /if \(busy/);
	assert.match(ui, /取消构建/);
	assert.match(ui, /重试构建/);
	assert.match(ui, /确认并开演/);
	assert.match(ui, /一次性令牌/);
	assert.match(ui, /publicCharacterProfiles/);
	assert.match(ui, /publicWorldFacts/);
	assert.match(ui, /openingNarration/);
	assert.match(corpus, /doc\.status === "ready"/);
	assert.match(corpus, /<NovelPlayDialog docId=\{playing\.id\}/);
});
