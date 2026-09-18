import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { readCardRawJson } from "../card.ts";
import { loadCorpusDocuments, corpusTextsDir, type CorpusDocument } from "../outline/corpus.ts";
import { scanSkillFiles } from "../stage/skill-store.ts";
import { resolveConfigPath } from "../paths.ts";
import type { RpConfig } from "../types.ts";
import { buildNovelPlayCard, type NovelPlayRawCard } from "./card.ts";
import { type NovelAnchor, type NovelPackage } from "./canon.ts";
import { extractNovelOpening, type NovelOpeningProposal } from "./opening.ts";
import { buildNovelEvents } from "./service.ts";
import { loadNovelPackage, type StoredNovelPackage } from "./store.ts";

export interface NovelPlayModelHost {
	cwd: string;
	runSideText(step: "outlineResearch", systemPrompt: string, userText: string, options?: { maxTokens?: number; signal?: AbortSignal; forceNonStreaming?: boolean }): Promise<string | { error: string }>;
	switchToCard(): Promise<"switched" | "created">;
	memoryScope(): { sessionId: string; card?: string };
}

export interface NovelPlayBinding { sessionId: string; card: string }
export interface PackagePublicDto { docId: string; title: string; revision: string; stageCount: number; nodeCount: number; builtAt: string }
export interface StartOptionDto { docId: string; revision: string; title: string; nodes: Array<{ nodeId: string; title: string }> }
export interface PreviewPublicDto {
	token: string;
	expiresAt: string;
	package: { docId: string; revision: string };
	anchor: NovelAnchor;
	draft: NovelOpeningProposal["draft"];
}
export type StartResult =
	| { card: string; session: "created" }
	| { card: string; session: "recovery-required"; recovery: string };

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

function loadRawConfig(cwd: string): { path: string; existed: boolean; bytes: string; config: RpConfig } {
	const path = resolveConfigPath(cwd);
	const existed = existsSync(path);
	const bytes = existed ? readFileSync(path, "utf8") : "";
	const config = existed ? JSON.parse(bytes) as RpConfig : { card: "assets/cards/default_Qingwu.json", userName: "用户", userPersona: "", language: "zh-CN", scanDepth: 6, maxLoreInjections: 5 } as RpConfig;
	return { path, existed, bytes, config };
}

export function novelPlayBinding(host: NovelPlayModelHost): NovelPlayBinding {
	const sessionId = host.memoryScope().sessionId;
	if (!sessionId) throw new Error("当前会话不可用");
	return { sessionId, card: String(loadRawConfig(host.cwd).config.card ?? "") };
}

export function sameNovelPlayBinding(a: NovelPlayBinding, b: NovelPlayBinding): boolean {
	return a.sessionId === b.sessionId && a.card === b.card;
}

const skill = (cwd: string, dir: string): string => {
	const found = scanSkillFiles(cwd).find(item => item.dir === dir);
	if (!found?.body.trim()) throw new Error(`缺少 ${dir} Skill`);
	return found.body;
};

const modelText = async (host: NovelPlayModelHost, systemPrompt: string, userText: string, signal?: AbortSignal, maxTokens = 8192): Promise<string> => {
	const result = await host.runSideText("outlineResearch", systemPrompt, userText, { maxTokens, signal, forceNonStreaming: true });
	if (typeof result !== "string") throw new Error(result.error || "模型调用失败");
	return result;
};

export function readyCorpusSource(cwd: string, docId: string): { document: Pick<CorpusDocument, "id" | "title" | "status" | "chars" | "chunkCount">; text: string } {
	if (typeof docId !== "string" || !docId.trim()) throw new Error("缺少 docId");
	const document = loadCorpusDocuments(cwd).find(item => item.id === docId);
	if (!document) throw new Error("文档不存在");
	if (document.status !== "ready") throw new Error("小说尚未消化完成");
	const root = corpusTextsDir(cwd);
	const textFile = join(root, `${document.id}.txt`);
	if (!resolve(textFile).startsWith(`${resolve(root)}${sep}`)) throw new Error("非法文档标识");
	const text = readFileSync(textFile, "utf8");
	if (!text.trim() || text.length !== document.chars) throw new Error("小说原文与文档长度不一致");
	return { document, text };
}

export async function buildPackage(host: NovelPlayModelHost, docId: string, signal?: AbortSignal): Promise<PackagePublicDto> {
	const { document, text } = readyCorpusSource(host.cwd, docId);
	const pkg = await buildNovelEvents({
		cwd: host.cwd, document, storedText: text, signal,
		modelCall: async input => modelText(host, input.skillBody, JSON.stringify({ source: input.source, chunk: input.chunk, attempt: input.attempt }, null, 2), input.signal),
	});
	return packageDto(document.title, pkg);
}

export function packageDto(title: string, pkg: NovelPackage): PackagePublicDto {
	return { docId: pkg.docId, title, revision: pkg.revision, stageCount: pkg.stages.length, nodeCount: pkg.nodes.length, builtAt: new Date().toISOString() };
}

function stored(host: NovelPlayModelHost, docId: string, revision: string): StoredNovelPackage {
	const source = readyCorpusSource(host.cwd, docId);
	const value = loadNovelPackage(host.cwd, docId, revision);
	if (value.source.fingerprint !== value.package.sourceFingerprint || !value.source.fingerprint) throw new Error("作品包原文身份无效");
	if (value.source.fingerprint !== sha256(source.text)) throw new Error("作品包已过期，请重新构建");
	return value;
}

export function startOptions(host: NovelPlayModelHost, docId: string, revision: string): StartOptionDto {
	const value = stored(host, docId, revision);
	const stages = new Map(value.package.stages.map((stage, index) => [stage.id, index + 1]));
	return {
		docId, revision, title: value.source.title,
		nodes: value.package.nodes.filter(node => node.visibility === "public").map(node => ({
			nodeId: node.id,
			title: `阶段 ${stages.get(node.stageId) ?? 0} · 节点 ${node.order + 1}`,
		})),
	};
}

export async function createOpeningProposal(host: NovelPlayModelHost, input: { docId: string; revision: string; nodeId: string; position: "before" | "after"; player: { name: string; identity: string } }, signal?: AbortSignal): Promise<{ proposal: NovelOpeningProposal; stored: StoredNovelPackage; anchor: NovelAnchor }> {
	const value = stored(host, input.docId, input.revision);
	const anchor: NovelAnchor = { packageRevision: input.revision, nodeId: input.nodeId, position: input.position };
	const proposal = await extractNovelOpening({
		stored: value, anchor, player: input.player, skillBody: skill(host.cwd, "小说开场提取"), signal,
		modelCall: async (request, options) => modelText(host, request.systemPrompt, request.userText, options.signal),
	});
	return { proposal, stored: value, anchor };
}

function activeNovelCard(host: NovelPlayModelHost, card: string): boolean {
	if (!card) return false;
	try {
		const cardsRoot = realpathSync(join(host.cwd, "assets", "cards"));
		const candidate = realpathSync(resolve(host.cwd, card));
		const rel = relative(cardsRoot, candidate);
		if (!rel || rel.startsWith("..") || rel.startsWith(sep)) return false;
		const { raw } = readCardRawJson(candidate);
		const data = raw.data && typeof raw.data === "object" ? raw.data as Record<string, unknown> : raw;
		const extensions = data.extensions && typeof data.extensions === "object" ? data.extensions as Record<string, unknown> : {};
		return Boolean(extensions.liyuanNovelPlay);
	} catch { return false; }
}

function restoreOwnedPreSwitch(before: ReturnType<typeof loadRawConfig>, ownedBytes: string, cardFile: string, host: NovelPlayModelHost, binding: NovelPlayBinding): void {
	let current = "";
	try { current = readFileSync(before.path, "utf8"); } catch { return; }
	if (current !== ownedBytes || !sameNovelPlayBinding(novelPlayBinding(host), { ...binding, card: JSON.parse(ownedBytes).card })) return;
	if (before.existed) writeFileSync(before.path, before.bytes, "utf8"); else rmSync(before.path, { force: true });
	rmSync(cardFile, { force: true });
}

export async function startFromConfirmedProposal(host: NovelPlayModelHost, input: { stored: StoredNovelPackage; anchor: NovelAnchor; proposal: NovelOpeningProposal }, expected: NovelPlayBinding): Promise<StartResult> {
	if (input.proposal.confirmed !== false) throw new Error("预览状态无效");
	if (!sameNovelPlayBinding(novelPlayBinding(host), expected)) throw new Error("会话或角色卡已变化，请重新预览");
	const before = loadRawConfig(host.cwd);
	if (activeNovelCard(host, before.config.card)) throw new Error("当前已有小说开演会话，请先切到普通角色卡");
	const confirmed = { ...input.proposal.draft, confirmed: true as const };
	const raw: NovelPlayRawCard = buildNovelPlayCard({ mode: "new-character", workTitle: input.stored.source.title, pkg: input.stored.package, anchor: input.anchor, snapshot: confirmed, skillBody: skill(host.cwd, "小说开演边界") });
	const cardsDir = join(host.cwd, "assets", "cards");
	mkdirSync(cardsDir, { recursive: true });
	const relativeCard = `assets/cards/novel-play-${randomUUID()}.json`;
	const absoluteCard = join(host.cwd, relativeCard);
	let ownedBytes = "";
	try {
		writeFileSync(absoluteCard, `${JSON.stringify(raw, null, "\t")}\n`, { encoding: "utf8", flag: "wx" });
		const next = { ...before.config, userName: confirmed.user.name, card: relativeCard };
		ownedBytes = `${JSON.stringify(next, null, "\t")}\n`;
		writeFileSync(before.path, ownedBytes, "utf8");
		const afterWrite = novelPlayBinding(host);
		if (afterWrite.sessionId !== expected.sessionId || afterWrite.card !== relativeCard) throw new Error("配置写入期间会话发生变化");
	} catch (error) {
		restoreOwnedPreSwitch(before, ownedBytes, absoluteCard, host, expected);
		throw error;
	}
	try {
		const switched = await host.switchToCard();
		if (switched !== "created") return { card: relativeCard, session: "recovery-required", recovery: "角色切换结果不确定。已保留新角色卡和配置，请检查当前会话。" };
		return { card: relativeCard, session: "created" };
	} catch {
		return { card: relativeCard, session: "recovery-required", recovery: "角色切换可能已部分成功。已保留新角色卡和配置，请检查当前会话后手动恢复。" };
	}
}
