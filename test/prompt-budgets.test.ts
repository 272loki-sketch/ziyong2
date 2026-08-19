import assert from "node:assert/strict";
import test from "node:test";

import { loadStageMaterials } from "../src/stage/materials.ts";
import { buildEcologyCardPrompt } from "../src/stage/literary-ecology.ts";
import { loadEcologyPools } from "../src/stage/literary-ecology.ts";
import { buildCurtainRerollMaterials } from "../src/stage/curtain-materials.ts";
import { defaultState } from "../src/state.ts";

test("模型调用预算：巨型卡生态适配不再重复发送完整 card.book", () => {
	const materials = loadStageMaterials(process.cwd());
	const pools = loadEcologyPools(process.cwd(), materials.config.card, materials.card.name);
	const prompt = buildEcologyCardPrompt("规则", { global: pools.global, cardPool: pools.card, card: materials.card, lore: materials.entries, state: defaultState(), history: Array.from({ length: 20 }, (_, index) => ({ role: index % 2 ? "assistant" as const : "user" as const, text: "长历史".repeat(10_000) })) });
	assert.ok(JSON.stringify(materials.rawCard).length > 1_000_000, "夹具必须保持巨型原始卡");
	assert.ok(prompt.userText.length < 140_000, `生态适配 prompt 应有界，实际 ${prompt.userText.length}`);
	assert.equal(prompt.userText.includes('"book"'), false);
});

test("模型调用预算：状态栏重Roll材料保持小于60K", () => {
	const materials = loadStageMaterials(process.cwd());
	const compact = buildCurtainRerollMaterials({ card: materials.card, preset: materials.preset, statusBarFormats: materials.statusBarFormats });
	assert.ok(JSON.stringify(compact).length < 60_000);
});
