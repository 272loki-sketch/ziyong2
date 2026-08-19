import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateNovelAiImage, generateNovelAiImageCached, parseNovelAiPrompt, saveNovelAiConfig, updateNovelAiConfig, DEFAULT_NOVELAI_CONFIG } from "../src/novelai.ts";
import { splitRichContentParts } from "../web/src/richContentParts.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test("解析智慧姬 image### 场景与分角色提示词", () => {
	const p = parseNovelAiPrompt(`【窗边】\nimage###\nScene Composition:1girl, classroom;\nCharacter 1 Prompt:horikita suzune, black hair|centers:0.3,0.5;\nCharacter 1 UC:bad hands;\n###`);
	assert.equal(p.scene, "1girl, classroom;");
	assert.equal(p.characters[0]?.prompt, "horikita suzune, black hair;");
	assert.deepEqual(p.characters[0]?.center, { x: 0.3, y: 0.5 });
	assert.equal(p.characters[0]?.uc, "bad hands;");
});

test("生图请求继承配置前缀并把图片内容寻址落盘", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-nai-"));
	saveNovelAiConfig(cwd, { ...DEFAULT_NOVELAI_CONFIG, enabled: true, apiKey: "secret", positivePrefix: "artist:test," });
	let payload: Record<string, unknown> | undefined;
	const result = await generateNovelAiImage(cwd, "1girl, classroom", {
		fetchFn: (async (_url, init) => {
			payload = JSON.parse(String(init?.body));
			return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
		}) as typeof fetch,
	});
	assert.match(result.src, /^\/media\/[0-9a-f]{16}\.png$/);
	assert.match(String(payload?.input), /^artist:test,/);
});

test("剧情图片缓存：同一提示词刷新复用旧图，不再次请求 NovelAI", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-nai-cache-"));
	saveNovelAiConfig(cwd, { ...DEFAULT_NOVELAI_CONFIG, enabled: true, apiKey: "secret" });
	let requests = 0;
	const fetchFn = (async () => {
		requests++;
		return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
	}) as typeof fetch;
	const first = await generateNovelAiImageCached(cwd, "1girl, classroom", { fetchFn });
	const second = await generateNovelAiImageCached(cwd, "1girl, classroom", { fetchFn });
	assert.deepEqual(second, first);
	assert.equal(requests, 1);
	assert.equal(existsSync(join(cwd, ".liyuan", "novelai-image-cache.json")), true);
});

test("剧情图片缓存：并发相同槽位只生成一次", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-nai-pending-"));
	saveNovelAiConfig(cwd, { ...DEFAULT_NOVELAI_CONFIG, enabled: true, apiKey: "secret" });
	let requests = 0;
	const fetchFn = (async () => {
		requests++;
		await new Promise((resolve) => setTimeout(resolve, 20));
		return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
	}) as typeof fetch;
	const [first, second] = await Promise.all([
		generateNovelAiImageCached(cwd, "1girl, bus", { fetchFn }),
		generateNovelAiImageCached(cwd, "1girl, bus", { fetchFn }),
	]);
	assert.deepEqual(second, first);
	assert.equal(requests, 1);
});

test("配置更新保留掩码 key，并钳制危险参数", () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-nai-config-"));
	saveNovelAiConfig(cwd, { ...DEFAULT_NOVELAI_CONFIG, apiKey: "secret" });
	const next = updateNovelAiConfig(cwd, { apiKey: "••••••••", steps: 999, width: 1001 });
	assert.equal(next.apiKey, "secret");
	assert.equal(next.steps, 50);
	assert.equal(next.width % 64, 0);
});

test("显示层把真实 image 块转按钮，但跳过 markdown 示例", () => {
	const parts = splitRichContentParts("正文\n<image>【窗边】\nimage###1girl###</image>", null);
	assert.equal(parts.some((part) => part.kind === "imagePrompt" && part.title === "窗边"), true);
	const sample = splitRichContentParts("```xml\n<image>image###example###</image>\n```", null);
	assert.equal(sample.some((part) => part.kind === "imagePrompt"), false);
});
