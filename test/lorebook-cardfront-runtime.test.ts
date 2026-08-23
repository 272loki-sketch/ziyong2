import assert from "node:assert/strict";
import test from "node:test";

import { loadStageMaterials } from "../src/stage/materials.ts";
import { prepareDisplayText } from "../src/postprocess.ts";
import { buildCardFrontSnapshot } from "../src/cardfront.ts";
import { loadLorebookRegexScripts } from "../src/lorebook.ts";

test("运行时装载外挂世界书 regex_scripts：贴吧、表情和小剧场皮肤不掉", () => {
	const cwd = new URL("..", import.meta.url).pathname;
	const materials = loadStageMaterials(cwd);
	const lorebookPath = `${cwd}/assets/lorebooks/日式中专大乱斗.json`;
	const skin = buildCardFrontSnapshot(
		{ card: materials.config.card, userName: materials.config.userName },
		materials.rawCard,
		materials.card.name,
		[
			...(materials.presetDoc?.raw ? [{ source: "preset", scripts: [] }] : []),
			{ source: "lorebook", scripts: loadLorebookRegexScripts(lorebookPath) },
		],
	);
	assert.ok(skin.rules.some((rule) => rule.name === "贴吧前端2"), "首屏 cardfront 也必须包含外挂世界书规则");
	const source = `<Small_theater>\nAPPname: 高度育成高中 校园BBS\ntitle: 测试\n\n须藤健 [https://example.com/a.png] (LV.9): 你好[表情13]\n</Small_theater>`;
	const display = prepareDisplayText(source, { rules: skin.rules, charName: materials.card.name, userName: materials.config.userName });
	assert.match(display, /<!DOCTYPE html>/);
	assert.match(display, /image_emoticon13\.png/);
});
