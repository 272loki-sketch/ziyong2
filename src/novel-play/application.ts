import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadCorpusDocuments, corpusTextsDir, type CorpusDocument } from "../outline/corpus.ts";
import { scanSkillFiles } from "../stage/skill-store.ts";
import { resolveConfigPath } from "../paths.ts";
import type { RpConfig } from "../types.ts";
import { buildNovelPlayCard, type NovelPlayRawCard } from "./card.ts";
import { projectNovelCandidates, type NovelAnchor, type NovelPackage } from "./canon.ts";
import { extractNovelOpening, type NovelOpeningProposal } from "./opening.ts";
import { buildNovelEvents } from "./service.ts";
import { loadNovelPackage, type StoredNovelPackage } from "./store.ts";

export interface NovelPlayModelHost {
	cwd: string;
	runSideText(step: "outlineResearch", systemPrompt: string, userText: string, options?: { maxTokens?: number; signal?: AbortSignal; forceNonStreaming?: boolean }): Promise<string | { error: string }>;
	switchToCard(): Promise<"switched" | "created">;
	memoryScope(): { sessionId: string; card?: string };
}

export interface PackagePublicDto {
	docId: string;
	title: string;
	revision: string;
	stageCount: number;
	nodeCount: number;
	builtAt: string;
}

export interface StartOptionDto {
	docId: string;
	revision: string;
	title: string;
	nodes: Array<{ nodeId: string; title: string }>;
}

export interface PreviewPublicDto {
	token: string;
	expiresAt: string;
	package: { docId: string; revision: string };
	anchor: NovelAnchor;
	draft: NovelOpeningProposal["draft"];
}

const skill = (cwd: string, dir: string): string => {
	const found = scanSkillFiles(cwd).find((item) => item.dir === dir);
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
	const document = loadCorpusDocuments(cwd).find((item) => item.id === docId);
	if (!document) throw new Error("文档不存在");
	if (document.status !== "ready") throw new Error("小说尚未消化完成");
	const textFile = join(corpusTextsDir(cwd), `${document.id}.txt`);
	const expectedRoot = `${corpusTextsDir(cwd)}${process.platform === "win32" ? "\\" : "/"}`;
	if (!textFile.startsWith(expectedRoot)) throw new Error("非法文档标识");
	const text = readFileSync(textFile, "utf8");
	if (!text.trim() || text.length !== document.chars) throw new Error("小说原文与文档长度不一致");
	return { document, text };
}

export async function buildPackage(host: NovelPlayModelHost, docId: string, signal?: AbortSignal): Promise<PackagePublicDto> {
	const { document, text } = readyCorpusSource(host.cwd, docId);
	const pkg = await buildNovelEvents({
		cwd: host.cwd,
		document,
		storedText: text,
		signal,
		modelCall: async (input) => modelText(host, input.skillBody, JSON.stringify({ source: input.source, chunk: input.chunk, attempt: input.attempt }, null, 2), input.signal, 8192),
	});
	return packageDto(document.title, pkg);
}

export function packageDto(title: string, pkg: NovelPackage): PackagePublicDto {
	return { docId: pkg.docId, title, revision: pkg.revision, stageCount: pkg.stages.length, nodeCount: pkg.nodes.length, builtAt: new Date().toISOString() };
}

function stored(host: NovelPlayModelHost, docId: string, revision: string): StoredNovelPackage {
	const source = readyCorpusSource(host.cwd, docId);
	const value = loadNovelPackage(host.cwd, docId, revision);
	if (value.source.fingerprint !== value.package.sourceFingerprint || value.source.fingerprint.length === 0) throw new Error("作品包原文身份无效");
	if (value.source.fingerprint !== (awaitFingerprint(source.text))) throw new Error("作品包已过期，请重新构建");
	return value;
}

function awaitFingerprint(text: string): string {
	return new BunlessHash("sha256").update(text).digest();
}

class BunlessHash {
	#chunks = "";
	constructor(private readonly algorithm: string) {}
	update(value: string): this { this.#chunks += value; return this; }
	digest(): string {
		if (this.algorithm !== "sha256") throw new Error("unsupported hash");
		return requireHash(this.#chunks);
	}
}

function requireHash(value: string): string {
	// Kept behind a function so tests can exercise source validation without exposing source text.
	return createSha256(value);
}

import { createHash } from "node:crypto";
const createSha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

export function startOptions(host: NovelPlayModelHost, docId: string, revision: string): StartOptionDto {
	const value = stored(host, docId, revision);
	const title = value.source.title;
	return {
		docId,
		revision,
		title,
		nodes: value.package.nodes.filter((node) => node.visibility === "public").map((node) => ({ nodeId: node.id, title: node.title })),
	};
}

export async function createOpeningProposal(host: NovelPlayModelHost, input: { docId: string; revision: string; nodeId: string; position: "before" | "after"; player: { name: string; identity: string } }, signal?: AbortSignal): Promise<{ proposal: NovelOpeningProposal; stored: StoredNovelPackage; anchor: NovelAnchor }> {
	const value = stored(host, input.docId, input.revision);
	const anchor: NovelAnchor = { packageRevision: input.revision, nodeId: input.nodeId, position: input.position };
	const proposal = await extractNovelOpening({
		stored: value,
		anchor,
		player: input.player,
		skillBody: skill(host.cwd, "小说开演提取"),
		signal,
		modelCall: async (request, options) => modelText(host, request.systemPrompt, request.userText, options.signal, 8192),
	});
	return { proposal, stored: value, anchor };
}

export function publicCandidates(host: NovelPlayModelHost, docId: string, revision: string, anchor: NovelAnchor): ReturnType<typeof projectNovelCandidates> {
	const value = stored(host, docId, revision);
	return projectNovelCandidates(value.package, anchor, { ancestorEntryIds: new Set(), conflicts: [], conflictsReady: false, maxChars: 12_000 });
}

function loadRawConfig(cwd: string): { path: string; existed: boolean; bytes: string; config: RpConfig } {
	const path = resolveConfigPath(cwd);
	const existed = existsSync(path);
	const bytes = existed ? readFileSync(path, "utf8") : "";
	const config = existed ? JSON.parse(bytes) as RpConfig : { card: "assets/cards/default_Qingwu.json", userName: "用户", userPersona: "", language: "zh-CN", scanDepth: 6, maxLoreInjections: 5 } as RpConfig;
	return { path, existed, bytes, config };
}

export async function startFromConfirmedProposal(host: NovelPlayModelHost, input: { stored: StoredNovelPackage; anchor: NovelAnchor; proposal: NovelOpeningProposal }): Promise<{ card: string; session: "created" }> {
	if (input.proposal.confirmed !== false) throw new Error("预览状态无效");
	const before = loadRawConfig(host.cwd);
	const activeCard = before.config.card;
	if (activeCard) {
		try {
			const raw = JSON.parse(readFileSync(join(host.cwd, activeCard), "utf8")) as { data?: { extensions?: { liyuanNovelPlay?: unknown } } };
			if (raw.data?.extensions?.liyuanNovelPlay) throw new Error("当前已有小说开演会话，请先切换到普通角色卡");
		} catch (error) {
			if (error instanceof Error && error.message.includes("当前已有小说开演会话")) throw error;
		}
	}
	const confirmed = { ...input.proposal.draft, confirmed: true as const };
	const raw: NovelPlayRawCard = buildNovelPlayCard({
		mode: "new-character",
		workTitle: input.stored.source.title,
		pkg: input.stored.package,
		anchor: input.anchor,
		snapshot: confirmed,
		skillBody: skill(host.cwd, "小说开演边界"),
	});
	const cardsDir = join(host.cwd, "assets", "cards");
	mkdirSync(cardsDir, { recursive: true });
	const relative = `assets/cards/novel-play-${randomUUID()}.json`;
	const absolute = join(host.cwd, relative);
	writeFileSync(absolute, `${JSON.stringify(raw, null, "\t")}\n`, { encoding: "utf8", flag: "wx" });
	try {
		const next = { ...before.config, userName: confirmed.user.name, card: relative };
		writeFileSync(before.path, `${JSON.stringify(next, null, "\t")}\n`, "utf8");
		const switched = await host.switchToCard();
		if (switched !== "created") throw new Error("唯一角色卡意外命中已有会话");
		return { card: relative, session: "created" };
	} catch (error) {
		if (before.existed) writeFileSync(before.path, before.bytes, "utf8");
		else rmSync(before.path, { force: true });
		rmSync(absolute, { force: true });
		throw error;
	}
}
