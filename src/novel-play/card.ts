import { normalizeCard } from "../card.ts";
import type { CharacterCard } from "../types.ts";
import type { NovelAnchor, NovelPackage } from "./canon.ts";

export type NovelPlayMode = "new-character";

export interface NovelPlayPublicProfile {
	name: string;
	profile: string;
}

/**
 * A separate opening builder must derive and verify this public snapshot.
 * This card builder only validates bounds and packages the supplied strings.
 */
export interface ConfirmedNovelOpeningSnapshot {
	confirmed: true;
	user: {
		name: string;
		identity: string;
	};
	time: string;
	place: string;
	sceneText: string;
	openingNarration: string;
	publicCharacterProfiles: NovelPlayPublicProfile[];
	publicWorldFacts: string[];
}

export interface NovelPlayCardExtensions {
	docId: string;
	revision: string;
	startNodeId: string;
	position: NovelAnchor["position"];
}

export interface NovelPlayRawCard {
	spec: "chara_card_v2";
	spec_version: "2.0";
	data: {
		name: string;
		description: string;
		personality: string;
		scenario: string;
		first_mes: string;
		mes_example: string;
		system_prompt: string;
		post_history_instructions: string;
		creator_notes: string;
		alternate_greetings: string[];
		tags: string[];
		extensions: { liyuanNovelPlay: NovelPlayCardExtensions };
	};
}

export interface BuildNovelPlayCardInput {
	mode: NovelPlayMode;
	pkg: NovelPackage;
	anchor: NovelAnchor;
	snapshot: ConfirmedNovelOpeningSnapshot;
	/** Body loaded from skills/小说开演边界/SKILL.md by the existing Skill scanner. */
	skillBody: string;
}

const LIMITS = {
	userName: 120,
	userIdentity: 1_500,
	time: 240,
	place: 240,
	sceneText: 5_000,
	openingNarration: 5_000,
	profileName: 120,
	profile: 1_500,
	profiles: 24,
	worldFact: 1_500,
	worldFacts: 40,
	skillBody: 10_000,
	totalPublicSnapshot: 24_000,
} as const;

const CARD_MACRO = /\{\{\s*(?:char|user)\s*\}\}/i;

function boundedText(label: string, value: unknown, max: number): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label}不能为空`);
	if (value.length > max) throw new Error(`${label}超过长度上限 ${max}`);
	if (CARD_MACRO.test(value)) {
		throw new Error(`${label}不能包含 {{char}} 或 {{user}}；角色卡运行时会替换这些宏，可能意外改变身份文本`);
	}
	return value.replace(/\r\n/g, "\n");
}

function validatePackageAnchor(pkg: NovelPackage, anchor: NovelAnchor): void {
	if (!pkg || pkg.version !== 1 || typeof pkg.docId !== "string" || !pkg.docId.trim()
		|| typeof pkg.revision !== "string" || !pkg.revision.trim() || !Array.isArray(pkg.nodes)) {
		throw new Error("作品包结构或版本无效");
	}
	if (!anchor || anchor.packageRevision !== pkg.revision) throw new Error("开演锚点与作品包版本不匹配");
	if (anchor.position !== "before" && anchor.position !== "after") throw new Error("无效开演位置");
	if (!pkg.nodes.some(node => node && node.id === anchor.nodeId)) throw new Error("开演节点不存在");
}

function formatProfiles(profiles: NovelPlayPublicProfile[]): string {
	return profiles.length
		? `公开人物资料：\n${profiles.map(item => `- ${item.name}：${item.profile}`).join("\n")}`
		: "";
}

function formatFacts(facts: string[]): string {
	return facts.length ? `公开世界事实：\n${facts.map(item => `- ${item}`).join("\n")}` : "";
}

/**
 * Builds an internal raw Character Card V2 without reading canon node text.
 * normalizeCard is called as a compatibility assertion only. It intentionally
 * drops data.extensions, so session code must retain and read this raw card.
 */
export function buildNovelPlayCard(input: BuildNovelPlayCardInput): NovelPlayRawCard {
	if (input.mode !== "new-character") throw new Error("当前只支持新角色开演模式");
	validatePackageAnchor(input.pkg, input.anchor);
	if (!input.snapshot || input.snapshot.confirmed !== true) throw new Error("开场快照尚未由用户确认");

	const userName = boundedText("用户角色名", input.snapshot.user?.name, LIMITS.userName);
	const userIdentity = boundedText("用户角色身份", input.snapshot.user?.identity, LIMITS.userIdentity);
	const time = boundedText("开场时间", input.snapshot.time, LIMITS.time);
	const place = boundedText("开场地点", input.snapshot.place, LIMITS.place);
	const sceneText = boundedText("开场场景", input.snapshot.sceneText, LIMITS.sceneText);
	const openingNarration = boundedText("开场叙述", input.snapshot.openingNarration, LIMITS.openingNarration);
	const skillBody = boundedText("小说开演边界 Skill 正文", input.skillBody, LIMITS.skillBody);

	if (!Array.isArray(input.snapshot.publicCharacterProfiles)
		|| input.snapshot.publicCharacterProfiles.length > LIMITS.profiles) {
		throw new Error(`公开人物资料最多 ${LIMITS.profiles} 条`);
	}
	const profiles = input.snapshot.publicCharacterProfiles.map((item, index) => ({
		name: boundedText(`公开人物资料 ${index + 1} 名称`, item?.name, LIMITS.profileName),
		profile: boundedText(`公开人物资料 ${index + 1} 内容`, item?.profile, LIMITS.profile),
	}));
	if (!Array.isArray(input.snapshot.publicWorldFacts) || input.snapshot.publicWorldFacts.length > LIMITS.worldFacts) {
		throw new Error(`公开世界事实最多 ${LIMITS.worldFacts} 条`);
	}
	const facts = input.snapshot.publicWorldFacts.map((item, index) =>
		boundedText(`公开世界事实 ${index + 1}`, item, LIMITS.worldFact));

	const boundedPublic = { userName, userIdentity, time, place, sceneText, openingNarration, profiles, facts };
	if (JSON.stringify(boundedPublic).length > LIMITS.totalPublicSnapshot) {
		throw new Error(`公开开场快照总长度超过上限 ${LIMITS.totalPublicSnapshot}`);
	}

	const description = [
		`用户角色：${userName}\n身份：${userIdentity}`,
		formatProfiles(profiles),
		formatFacts(facts),
	].filter(Boolean).join("\n\n");
	const scenario = `时间：${time}\n地点：${place}\n\n${sceneText}`;
	const raw: NovelPlayRawCard = {
		spec: "chara_card_v2",
		spec_version: "2.0",
		data: {
			name: userName,
			description,
			personality: userIdentity,
			scenario,
			first_mes: openingNarration,
			mes_example: "",
			system_prompt: skillBody,
			post_history_instructions: "",
			creator_notes: "梨园小说开演内部角色卡。会话运行时必须从原始卡读取 liyuanNovelPlay 扩展。",
			alternate_greetings: [],
			tags: ["liyuan", "novel-play", "internal"],
			extensions: {
				liyuanNovelPlay: {
					docId: input.pkg.docId,
					revision: input.pkg.revision,
					startNodeId: input.anchor.nodeId,
					position: input.anchor.position,
				},
			},
		},
	};

	// Reuse the existing parser and fail before returning a card it cannot consume.
	normalizeCard(raw);
	return raw;
}

export function normalizeNovelPlayCard(raw: NovelPlayRawCard): CharacterCard {
	return normalizeCard(raw);
}
