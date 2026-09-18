import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { buildNovelPackage } from "../src/novel-play/canon.ts";
import { novelNodeId, prepareNovelSource } from "../src/novel-play/source.ts";
import { saveNovelPackage } from "../src/novel-play/store.ts";
import { saveStageSkill } from "../src/stage/skill-store.ts";
import { NOVEL_PLAY_LIMITS, handleNovelPlayApiRequest, novelPlayCounters } from "../server/novel-play-api.ts";
import type { RestHost } from "../server/rest.ts";

const proposal = JSON.stringify({
	time: { text: "晨钟响起", quote: "晨钟响起" },
	place: { text: "城门", quote: "城门" },
	sceneText: { text: "晨钟响起", quote: "晨钟响起" },
	openingNarration: { text: "旅人推开城门", quote: "旅人推开城门" },
	publicCharacterProfiles: [],
	publicWorldFacts: [],
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

function root(): string {
	return join(tmpdir(), `liyuan-novel-adversarial-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function skill(cwd: string, dir: string, body: string): void {
	saveStageSkill(cwd, { dir, name: dir, description: "adversarial fixture", resident: false, everyBeat: false, body });
}

function corpus(cwd: string): { docId: string; text: string; revision: string; nodeId: string } {
	const docId = "doc-safe-id";
	const text = "第一章\n晨钟响起。旅人推开城门。";
	const dir = join(cwd, ".liyuan", "outline", "research", "corpus");
	mkdirSync(join(dir, "texts"), { recursive: true });
	writeFileSync(join(dir, "documents.json"), JSON.stringify([{
		id: docId, title: "测试小说", sourceKind: "upload", originalName: "novel.txt",
		chars: text.length, encoding: "utf-8", chapterCount: 1, chunkCount: 1, status: "ready",
		cardKey: "card", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
	}]));
	writeFileSync(join(dir, "texts", `${docId}.txt`), text);
	const source = prepareNovelSource({ id: docId, title: "测试小说", status: "ready", chars: text.length, chunkCount: 1 }, text);
	const quote = "。";
	const start = text.lastIndexOf(quote);
	const ref = { chunkIndex: 0, start, end: start + quote.length, quote };
	const pkg = buildNovelPackage(source, [{ id: "chapter-0", order: 0, title: "第一章" }], [{
		id: novelNodeId(source, ref, "bell"), key: "bell", stageId: "chapter-0", order: 0,
		title: "晨钟", summary: "晨钟响起", visibility: "public", dependsOn: [], sourceRefs: [ref],
	}]);
	saveNovelPackage(cwd, source, pkg);
	return { docId, text, revision: pkg.revision, nodeId: pkg.nodes[0].id };
}

function cardAndConfig(cwd: string): string {
	const card = "assets/cards/default_Qingwu.json";
	mkdirSync(join(cwd, "assets", "cards"), { recursive: true });
	writeFileSync(join(cwd, card), JSON.stringify({ spec: "chara_card_v2", spec_version: "2.0", data: {
		name: "normal", description: "", personality: "", scenario: "", first_mes: "", mes_example: "",
		system_prompt: "", post_history_instructions: "", creator_notes: "", alternate_greetings: [], tags: [],
	} }));
	writeFileSync(join(cwd, "liyuan.config.json"), JSON.stringify({
		card, userName: "old", userPersona: "", language: "zh-CN", scanDepth: 6, maxLoreInjections: 5,
	}));
	return card;
}

function prepare(cwd: string) {
	const data = corpus(cwd);
	skill(cwd, "小说事件构建", "extract exact events");
	skill(cwd, "小说开场提取", "opening extraction");
	skill(cwd, "小说开演边界", "boundary");
	cardAndConfig(cwd);
	return data;
}

class Request extends PassThrough {
	method: string;
	url: string;
	constructor(method: string, url: string) { super(); this.method = method; this.url = url; }
	send(value?: unknown): void { if (value !== undefined) this.write(JSON.stringify(value)); this.end(); }
}

class Response extends EventEmitter {
	statusCode = 0;
	headers: Record<string, string> = {};
	text = "";
	writableEnded = false;
	destroyed = false;
	writeHead(code: number, headers: Record<string, string>): void { this.statusCode = code; this.headers = headers; }
	end(value = ""): void { this.text += value; this.writableEnded = true; }
	json(): any { return JSON.parse(this.text); }
}

function makeHost(cwd: string, runSideText: RestHost["runSideText"], overrides: Partial<RestHost> = {}): RestHost {
	return {
		cwd,
		isStreaming: () => false,
		runSideText,
		memoryScope: () => ({ sessionId: "session-a", card: "assets/cards/default_Qingwu.json" }),
		switchToCard: async () => "created",
		...overrides,
	} as RestHost;
}

async function request(host: RestHost, method: string, url: string, payload?: unknown) {
	const req = new Request(method, url);
	const res = new Response();
	const handled = handleNovelPlayApiRequest(req as never, res as never, host);
	req.send(payload);
	assert.equal(await handled, true);
	return { status: res.statusCode, body: res.json(), req, res };
}

async function preview(host: RestHost, input: ReturnType<typeof prepare>) {
	return request(host, "POST", "/api/novel-play/preview", {
		docId: input.docId, revision: input.revision, nodeId: input.nodeId, position: "before",
		player: { name: "阿岚", identity: "异乡旅人" },
	});
}

async function waitFor(check: () => boolean): Promise<void> {
	for (let i = 0; i < 100 && !check(); i++) await new Promise<void>(resolve => setImmediate(resolve));
	assert.ok(check(), "condition was not reached");
}

test("same preview token cannot be consumed twice while concurrent request bodies are still arriving", async () => {
	const cwd = root();
	const input = prepare(cwd);
	const startGate = deferred<"created">();
	let switches = 0;
	const host = makeHost(cwd, async () => proposal, { switchToCard: async () => { switches++; return startGate.promise; } });
	const made = await preview(host, input);
	assert.equal(made.status, 200);
	const token = made.body.preview.token;
	const firstReq = new Request("POST", "/api/novel-play/start");
	const secondReq = new Request("POST", "/api/novel-play/start");
	const firstRes = new Response();
	const secondRes = new Response();
	const first = handleNovelPlayApiRequest(firstReq as never, firstRes as never, host);
	const second = handleNovelPlayApiRequest(secondReq as never, secondRes as never, host);
	firstReq.write(`{"previewToken":"${token}"`);
	secondReq.write(`{"previewToken":"${token}"`);
	firstReq.end("}");
	secondReq.end("}");
	await waitFor(() => switches === 1 && (firstRes.statusCode === 409 || secondRes.statusCode === 409));
	startGate.resolve("created");
	await Promise.all([first, second]);
	assert.deepEqual([firstRes.statusCode, secondRes.statusCode].sort(), [201, 409]);
	assert.equal(switches, 1);
});

test("cancelling a build remains final when the model ignores abort and resolves later", async () => {
	const cwd = root();
	const input = prepare(cwd);
	const model = deferred<string>();
	const host = makeHost(cwd, async () => model.promise);
	const made = await request(host, "POST", "/api/novel-play/build", { docId: input.docId });
	assert.equal(made.status, 202);
	const id = made.body.job.id;
	await waitFor(() => novelPlayCounters(host).buildOperations === 1);
	const cancelled = await request(host, "DELETE", `/api/novel-play/status/${id}`);
	assert.equal(cancelled.body.job.status, "cancelled");
	model.resolve(JSON.stringify({ nodes: [{ key: "bell", title: "晨钟", summary: "晨钟响起", visibility: "public", dependsOn: [], quote: "晨钟响起" }] }));
	await waitFor(() => novelPlayCounters(host).buildOperations === 0);
	const status = await request(host, "GET", `/api/novel-play/status/${id}`);
	assert.equal(status.body.job.status, "cancelled");
	assert.equal("result" in status.body.job, false);
});

test("preview rejects a stale session when binding changes before the model returns", async () => {
	const cwd = root();
	const input = prepare(cwd);
	const model = deferred<string>();
	let sessionId = "session-a";
	const host = makeHost(cwd, async () => model.promise, { memoryScope: () => ({ sessionId, card: "assets/cards/default_Qingwu.json" }) });
	const pending = preview(host, input);
	await waitFor(() => novelPlayCounters(host).previewOperations === 1);
	sessionId = "session-b";
	model.resolve(proposal);
	const result = await pending;
	assert.equal(result.status, 409);
	assert.equal(novelPlayCounters(host).previews, 0);
});

test("preview capacity rejects excess work before invoking a third model", async () => {
	const cwd = root();
	const input = prepare(cwd);
	const gates = [deferred<string>(), deferred<string>()];
	let calls = 0;
	const host = makeHost(cwd, async () => gates[calls++].promise);
	const one = preview(host, input);
	const two = preview(host, input);
	await waitFor(() => calls === NOVEL_PLAY_LIMITS.maxPreviewOperations);
	const excess = await preview(host, input);
	assert.equal(excess.status, 429);
	assert.equal(calls, 2);
	gates[0].resolve(proposal);
	gates[1].resolve(proposal);
	assert.deepEqual((await Promise.all([one, two])).map(value => value.status), [200, 200]);
});

test("preview deadline returns without waiting for a model that ignores abort", async t => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const cwd = root();
	const input = prepare(cwd);
	const never = deferred<string>();
	const host = makeHost(cwd, async () => never.promise);
	const pending = preview(host, input);
	await waitFor(() => novelPlayCounters(host).previewOperations === 1);
	t.mock.timers.tick(NOVEL_PLAY_LIMITS.previewDeadlineMs);
	const result = await pending;
	assert.equal(result.status, 504);
	never.resolve(proposal);
	await Promise.resolve();
});

test("an external config write during a failed switch is neither overwritten nor deleted", async () => {
	const cwd = root();
	const input = prepare(cwd);
	const external = `${JSON.stringify({ card: "assets/cards/external.json", userName: "external", marker: "keep" }, null, "\t")}\n`;
	const host = makeHost(cwd, async () => proposal, {
		switchToCard: async () => {
			writeFileSync(join(cwd, "liyuan.config.json"), external);
			throw new Error("post-side-effect switch failure");
		},
	});
	const made = await preview(host, input);
	const started = await request(host, "POST", "/api/novel-play/start", { previewToken: made.body.preview.token });
	assert.equal(started.status, 202);
	assert.equal(started.body.started.session, "recovery-required");
	assert.equal(readFileSync(join(cwd, "liyuan.config.json"), "utf8"), external);
	const generated = readdirSync(join(cwd, "assets", "cards")).filter(name => name.startsWith("novel-play-") && name.endsWith(".json"));
	assert.equal(generated.length, 1);
	assert.equal(existsSync(join(cwd, "assets", "cards", generated[0])), true);
});

test("corpus reads reject a symlink that escapes the corpus text directory", async () => {
	const cwd = root();
	const input = prepare(cwd);
	const external = join(cwd, "outside.txt");
	writeFileSync(external, input.text);
	const textFile = join(cwd, ".liyuan", "outline", "research", "corpus", "texts", `${input.docId}.txt`);
	unlinkSync(textFile);
	symlinkSync(external, textFile);
	const host = makeHost(cwd, async () => { throw new Error("model must not run for an escaped source"); });
	const result = await request(host, "POST", "/api/novel-play/build", { docId: input.docId });
	assert.equal(result.status, 400);
	assert.equal(novelPlayCounters(host).buildOperations, 0);
});
