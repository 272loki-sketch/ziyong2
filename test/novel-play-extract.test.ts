import assert from "node:assert/strict";
import test from "node:test";
import { extractNovelEvents, type NovelExtractionModelCall } from "../src/novel-play/extract.ts";
import type { NovelSource } from "../src/novel-play/source.ts";

const skillBody = "Extract events from the supplied chunk as strict JSON.";
const source: NovelSource = {
	version: 1,
	docId: "novel-1",
	title: "测试小说",
	fingerprint: "fingerprint-a",
	chunkChars: 100,
	chunks: [
		{ index: 0, chars: 16, chapters: ["第一章"], text: "甲推开门。雨落下来。" },
		{ index: 1, chars: 15, chapters: [], text: "钟声响起。众人离开。" },
	],
};

const result = (nodes: unknown[]): string => JSON.stringify({ nodes });
const event = (overrides: Record<string, unknown> = {}) => ({
	key: "door",
	title: "开门",
	summary: "甲推开门。",
	visibility: "public",
	dependsOn: [],
	quote: "甲推开门。",
	...overrides,
});

function sequence(outputs: Array<string | Error>, calls: { count: number }): NovelExtractionModelCall {
	return async () => {
		const output = outputs[calls.count++];
		if (output instanceof Error) throw output;
		if (output === undefined) throw new Error("unexpected model call");
		return output;
	};
}

test("extracts one stage per chunk, resolves exact offsets, visibility and local dependencies", async () => {
	const calls = { count: 0 };
	const extracted = await extractNovelEvents(source, {
		skillBody,
		modelCall: sequence([
			result([
				event(),
				event({ key: "rain", title: "下雨", summary: "雨开始落下。", visibility: "secret", dependsOn: ["door"], quote: "雨落下来。" }),
			]),
			result([event({ key: "bell", title: "钟响", summary: "钟声响起。", quote: "钟声响起。" })]),
		], calls),
	});
	assert.equal(calls.count, 2);
	assert.deepEqual(extracted.package.stages.map(stage => stage.title), ["第一章", "分块 2"]);
	assert.equal(extracted.package.nodes[0].sourceRefs[0].start, 0);
	assert.equal(extracted.package.nodes[0].sourceRefs[0].end, "甲推开门。".length);
	assert.equal(extracted.package.nodes[1].visibility, "secret");
	assert.deepEqual(extracted.package.nodes[1].dependsOn, [extracted.package.nodes[0].id]);
	assert.match(extracted.package.nodes[0].id, /^canon-[a-f0-9]{24}$/);
});

test("retries invalid JSON and stops after at most two attempts", async () => {
	const calls = { count: 0 };
	await assert.rejects(
		extractNovelEvents({ ...source, chunks: [source.chunks[0]] }, {
			skillBody,
			maxAttempts: 99,
			modelCall: sequence(["not json", "still not json", result([event()])], calls),
		}),
		/failed for chunk 0 after 2 attempt\(s\)/,
	);
	assert.equal(calls.count, 2);
});

test("rejects duplicate and nonmatching evidence quotes", async () => {
	const duplicateSource: NovelSource = {
		...source,
		chunks: [{ index: 0, chars: 8, chapters: ["重复"], text: "门开。门开。" }],
	};
	const duplicateCalls = { count: 0 };
	await assert.rejects(extractNovelEvents(duplicateSource, {
		skillBody,
		maxAttempts: 1,
		modelCall: sequence([result([event({ quote: "门开。" })])], duplicateCalls),
	}), /quote must occur exactly once/);

	const missingCalls = { count: 0 };
	await assert.rejects(extractNovelEvents({ ...source, chunks: [source.chunks[0]] }, {
		skillBody,
		maxAttempts: 1,
		modelCall: sequence([result([event({ quote: "不存在。" })])], missingCalls),
	}), /quote must occur exactly once/);
});

test("fails a chunk explicitly when it has no evidenced events", async () => {
	const calls = { count: 0 };
	await assert.rejects(extractNovelEvents({ ...source, chunks: [source.chunks[0]] }, {
		skillBody,
		maxAttempts: 1,
		modelCall: sequence([result([])], calls),
	}), /chunk must contain between 1 and 100 evidenced events/);
});

test("honors an already aborted signal without calling the model", async () => {
	const controller = new AbortController();
	controller.abort();
	let called = false;
	await assert.rejects(extractNovelEvents(source, {
		skillBody,
		signal: controller.signal,
		modelCall: async () => { called = true; return result([event()]); },
	}), (error: unknown) => error instanceof Error && error.name === "AbortError");
	assert.equal(called, false);
});

test("reuses valid checkpoint chunks only when the fingerprint, layout and skill hash key match", async () => {
	const firstCalls = { count: 0 };
	const first = await extractNovelEvents(source, {
		skillBody,
		modelCall: sequence([
			result([event()]),
			result([event({ key: "bell", title: "钟响", summary: "钟声响起。", quote: "钟声响起。" })]),
		], firstCalls),
	});
	let resumedCalls = 0;
	const resumed = await extractNovelEvents(source, {
		skillBody,
		checkpoint: first.checkpoint,
		modelCall: async () => { resumedCalls++; throw new Error("must not run"); },
	});
	assert.equal(resumedCalls, 0);
	assert.equal(resumed.package.revision, first.package.revision);

	const changedCalls = { count: 0 };
	await extractNovelEvents({ ...source, fingerprint: "fingerprint-b" }, {
		skillBody,
		checkpoint: first.checkpoint,
		modelCall: sequence([
			result([event()]),
			result([event({ key: "bell", title: "钟响", summary: "钟声响起。", quote: "钟声响起。" })]),
		], changedCalls),
	});
	assert.equal(changedCalls.count, 2);
});

test("validates cached output with the same rules and replaces an invalid cached chunk", async () => {
	const seedCalls = { count: 0 };
	const seed = await extractNovelEvents({ ...source, chunks: [source.chunks[0]] }, {
		skillBody,
		modelCall: sequence([result([event()])], seedCalls),
	});
	seed.checkpoint.completed["0"] = result([event({ quote: "不存在。" })]);
	const retryCalls = { count: 0 };
	const recovered = await extractNovelEvents({ ...source, chunks: [source.chunks[0]] }, {
		skillBody,
		checkpoint: seed.checkpoint,
		modelCall: sequence([result([event()])], retryCalls),
	});
	assert.equal(retryCalls.count, 1);
	assert.equal(recovered.package.nodes.length, 1);
});
