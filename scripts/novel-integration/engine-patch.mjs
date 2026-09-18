import { readFileSync, writeFileSync } from "node:fs";

const MARKER = "novel-play-runtime-integration-v1";
const replacements = [
	['import { worldModuleSkillPacks } from "./skill-store.ts";', 'import { worldModuleSkillPacks } from "./skill-store.ts";\nimport { commitNovelPlayState, prepareNovelPlayTurn, type NovelPlayProjection, type PreparedNovelPlayTurn } from "../novel-play/runtime.ts"; // novel-play-runtime-integration-v1'],
	['\tparsePlotAdaptation,\n\ttype PlotAdaptation,', '\tparsePlotAdaptation,\n\tplotAdaptationFromNovelProjection,\n\ttype PlotAdaptation,'],
	['\tsceneConductor?: SceneConductor;\n}', '\tsceneConductor?: SceneConductor;\n\tnovelProjection?: NovelPlayProjection;\n}'],
	['\t\tlet sceneConductor = rerollPrep?.sceneConductor;\n\t\tlet planFact: PlanFactComparison | undefined;', '\t\tlet sceneConductor = rerollPrep?.sceneConductor;\n\t\tlet novelProjection = rerollPrep?.novelProjection;\n\t\tlet preparedNovelPlay: PreparedNovelPlayTurn | undefined;\n\t\tlet planFact: PlanFactComparison | undefined;'],
	['\t\t// 剧情卡—生态适配：卡池是长期卡级语法，运行态给出眼前人物/地点；本步骤把抽象模板', '\t\t// 小说开演独立于生态开关。它只读取原始卡扩展、不可变作品包和当前权威分支。\n\t\tif (!rerollPrep && !legacyBackstage) {\n\t\t\tconst novelSkill = materials.skillFiles.find(skill => skill.dir === "小说分支校准");\n\t\t\tif (novelSkill) {\n\t\t\t\tpreparedNovelPlay = await prepareNovelPlayTurn({\n\t\t\t\t\tcwd, rawCard: materials.rawCard, branch, expectedLeafId: prepLeafId, skillBody: novelSkill.body,\n\t\t\t\t\tgetLeafId: () => sm.getLeafId(),\n\t\t\t\t\tmodelCall: async (systemPrompt, modelInput) => {\n\t\t\t\t\t\tconst result = await this.#sideText("plotAdaptation", systemPrompt, modelInput, 4096, "off", prepController.signal);\n\t\t\t\t\t\treturn typeof result === "string" ? result : undefined;\n\t\t\t\t\t},\n\t\t\t\t});\n\t\t\t\tnovelProjection = preparedNovelPlay?.projection;\n\t\t\t\tif (novelProjection) plotAdaptation = plotAdaptationFromNovelProjection(novelProjection);\n\t\t\t\telse ev.onActivity?.("小说分支校准：本拍无可用候选，按当前事实继续");\n\t\t\t}\n\t\t}\n\n\t\t// 剧情卡—生态适配：卡池是长期卡级语法，运行态给出眼前人物/地点；本步骤把抽象模板'],
	['\t\t\t\tuserText: lastUserText, userName: config.userName,\n\t\t\t});', '\t\t\t\tuserText: lastUserText, userName: config.userName, novelProjection,\n\t\t\t});'],
	['\t\t\t\t\t...(sceneConductor ? { sceneConductor } : {}),', '\t\t\t\t\t...(sceneConductor ? { sceneConductor } : {}),\n\t\t\t\t\t...(novelProjection ? { novelProjection } : {}),'],
	['\t\t\tentryId = sm.appendMessage({\n\t\t\t\t...final,\n\t\t\t\tcontent: [...keep, { type: "text", text: finalText }],\n\t\t\t\tdetails,\n\t\t\t});\n\t\t\tsm.flush();', '\t\t\tentryId = sm.appendMessage({\n\t\t\t\t...final,\n\t\t\t\tcontent: [...keep, { type: "text", text: finalText }],\n\t\t\t\tdetails,\n\t\t\t});\n\t\t\tsm.flush();\n\t\t\t// A reroll reuses rpPrep and must not create new novel metadata.\n\t\t\tif (userText !== null) {\n\t\t\t\tcommitNovelPlayState({ prepared: preparedNovelPlay, expectedLeafId: entryId, getLeafId: () => sm.getLeafId(), appendCustomEntry: (type, data) => sm.appendCustomEntry(type, data) });\n\t\t\t\tsm.flush();\n\t\t\t}'],
];

function occurrenceCount(source, snippet) {
	let count = 0, from = 0;
	while ((from = source.indexOf(snippet, from)) >= 0) { count++; from += snippet.length; }
	return count;
}
function assertExactlyOnce(source, snippet, phase) {
	const count = occurrenceCount(source, snippet);
	if (count === 0) throw new Error(`engine patch snippet missing (${phase}): ${snippet.slice(0, 80)}`);
	if (count !== 1) throw new Error(`engine patch snippet ambiguous (${phase}): ${snippet.slice(0, 80)}`);
}
function replaceExactlyOnce(source, before, after) {
	assertExactlyOnce(source, before, "source");
	return source.replace(before, after);
}

export function apply(source) {
	if (typeof source !== "string") throw new TypeError("engine source must be a string");
	if (source.includes(MARKER)) {
		for (const [, applied] of replacements) assertExactlyOnce(source, applied, "applied");
		return source;
	}
	let next = source;
	for (const [before, after] of replacements) next = replaceExactlyOnce(next, before, after);
	if (!next.includes(MARKER)) throw new Error("engine patch marker was not installed");
	for (const [, applied] of replacements) assertExactlyOnce(next, applied, "result");
	return next;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	if (process.env.GITHUB_REF_NAME !== "feat/novel-play-foundation") throw new Error("refusing to patch outside feat/novel-play-foundation");
	const file = "src/stage/engine.ts", source = readFileSync(file, "utf8"), next = apply(source);
	if (next !== source) writeFileSync(file, next, "utf8");
}
