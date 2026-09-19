/**
 * 小说长文消化管道（导演室研究库扩容，PLAN-NOVEL-DIGEST 阶段 1）。
 *
 * 责任边界：
 * - 解码 / 清洗 / 分章 / 分块为确定性纯函数（可导出声测）；
 * - CorpusEngine 串行单飞、断点续跑、预算闸门、暂停/恢复/删除/重试；
 * - 提示词正文零侵入：只读 workflow: novel-digest 的 Skill body。
 * - 产物唯一权威在 `.liyuan/outline/research/`（documents.json / texts / digests）。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";

import { firstZipEntry } from "../ziplite.ts";
import type { OutlineResearchExtraction } from "./research.ts";
import type { OutlineEngineDeps } from "./engine.ts";
import { fetchKakuyomuWork, kakuyomuDocumentId, normalizeKakuyomuWorkUrl, type KakuyomuRequest } from "./kakuyomu.ts";

// ---------- 常量与类型 ----------

// GLM 长上下文请求在网关上延迟明显；缩小单块让每次摘要更快返回并便于断点续跑。
export const CHUNK_CHARS = 10000;
export const CHUNK_CHARS_HARD_MAX = 50000;
export const MAX_CHUNKS = 600;
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
/** 文档数量不设上限；保留此导出名仅为兼容旧调用方。 */
export const MAX_DOCUMENTS = Number.POSITIVE_INFINITY;
export const ARC_CHUNK_BATCH = 50;
export const ESTIMATE_FORMULA_TAIL = 2;

export type CorpusDocStatus = "pending" | "cleaning" | "mapping" | "reducing" | "extracting" | "ready" | "failed" | "paused";

export interface CorpusDocument {
	id: string;
	title: string;
	sourceKind: "upload" | "url";
	originName: string;
	chars: number;
	encoding: string;
	chapterCount: number;
	chunkCount: number;
	status: CorpusDocStatus;
	cardKey: string;
	error?: string;
	/** 大纲上下文投影用：ready 时由引擎写入梗概预览（≤400 字）。 */
	synopsisPreview?: string;
	/** ready 后提炼出的可复用套路条数。 */
	tropeCount?: number;
	/** ready 后提炼出的日常剧情卡条数。 */
	dailyPatternCount?: number;
	/** ready 后提炼出的可调度素材条数。 */
	assetCount?: number;
	createdAt: string;
	updatedAt: string;
}

export interface CorpusProgress {
	step: CorpusDocStatus;
	done: number;
	total: number;
}

export interface CorpusChunkDigest {
	index: number;
	chars: number;
	chapters: string[];
	summary: string;
}

export interface CorpusArcDigest {
	title: string;
	chunkRange: [number, number];
	summary: string;
}

export interface CorpusDigestStructure {
	plotSpine: string;
	characterArcs: string;
	hooksAndPacing: string;
}

export interface CorpusDigest {
	version: 1;
	docId: string;
	chunks: CorpusChunkDigest[];
	arcs: CorpusArcDigest[];
	synopsis: string;
	structure: CorpusDigestStructure;
	extractedCount: number;
	dailyPatternCount?: number;
	dailyPatterns?: CorpusDailyPattern[];
	assets?: NarrativeAsset[];
	assetCount?: number;
	updatedAt: string;
	audit?: { approved: number; weak: number; rejected: number };
}

export interface CorpusTrope {
	mechanism: string;
	appliesWhen: string;
	failureWarning: string;
	locator: string;
	evidenceIds?: string[];
}
export interface CorpusDailyPattern { title: string; setting: string; surfaceActivity: string; initiative: string; sweetBeat: string; friction: string; misunderstanding: string; microChange: string; escalationLimit: string; naturalStop: string; failureWarning: string; locator: string; evidenceIds?: string[] }
export type NarrativeAssetKind = "scene-pattern" | "relationship-beat" | "dialogue-move";
export interface NarrativeAsset {
	kind: NarrativeAssetKind;
	title: string;
	mechanism: string;
	appliesWhen: string;
	failureWarning: string;
	opening: string;
	progression: string[];
	turn: string;
	stopPoint: string;
	relationshipStage: string;
	pressure: string;
	desiredExperience: string;
	locator: string;
	evidenceIds?: string[];
}

export interface CorpusEngineDeps {
	cwd: string;
	runSideModel: OutlineEngineDeps["runSideModel"];
	/** 取 workflow: novel-digest 的 Skill body；缺失返回 undefined（不再做第二次权威）。 */
	loadSkill: () => string | undefined;
	/** 建档时绑定当前卡；后续所有入库/重试/删除使用该快照，不动态读当前卡。 */
	cardKey: () => string;
	/** 提取完成入库钩子：由宿主把套路条目合并进研究库（documents + digests 由引擎自己落盘）。 */
	onReady?: (document: CorpusDocument, digest: CorpusDigest, extractions: OutlineResearchExtraction[]) => Promise<void>;
	/** 删除文档后清理研究库中只被该文档引用的机制条目；返回删除条数。 */
	onRemoved?: (docId: string) => Promise<number>;
	fetchText?: KakuyomuRequest;
}

interface CorpusJob {
	doc: CorpusDocument;
	status: CorpusProgress;
}

const cleanText = (value: unknown, max = 2000): string => typeof value === "string" ? value.trim().slice(0, max) : "";
const cleanList = (value: unknown, maxItems = 40, maxChars = 200): string[] => Array.isArray(value)
	? value.flatMap((item) => typeof item === "string" && item.trim() ? [item.trim().slice(0, maxChars)] : []).slice(0, maxItems)
	: [];

const parseObject = (text: string): Record<string, unknown> | null => {
	for (const candidate of [text.trim(), text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1], text.match(/\{[\s\S]*\}/)?.[0]]) {
		if (!candidate) continue;
		try { const value = JSON.parse(candidate); if (value && typeof value === "object" && !Array.isArray(value)) return value; } catch {}
	}
	return null;
};

/** 严格 JSON 失败时，保留模型返回的有效字符串字段。 */
const textField = (raw: string, key: string, max: number): string => {
	const parsed = parseObject(raw);
	const strict = parsed && cleanText(parsed[key], max);
	if (strict) return strict;
	const match = raw.match(new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)`, "s"))?.[1];
	if (!match) return "";
	try { return JSON.parse(`"${match}"`).trim().slice(0, max); } catch { return match.trim().slice(0, max); }
};

export const corpusRoot = (cwd: string): string => join(cwd, ".liyuan", "outline", "research", "corpus");
export const corpusTextsDir = (cwd: string): string => join(corpusRoot(cwd), "texts");
export const corpusDigestsDir = (cwd: string): string => join(corpusRoot(cwd), "digests");
export const corpusDocumentsFile = (cwd: string): string => join(corpusRoot(cwd), "documents.json");

export function loadCorpusDocuments(cwd: string): CorpusDocument[] {
	try {
		const value = JSON.parse(readFileSync(corpusDocumentsFile(cwd), "utf8"));
		return Array.isArray(value) ? value as CorpusDocument[] : [];
	} catch { return []; }
}

// ---------- 确定性纯函数（导出声测） ----------

/** utf-8 严格优先；失败退 gb18030，再 big5；全会失败按 utf-8(lossy) 兜底。 */
export function decodeText(bytes: Buffer): { text: string; encoding: string } {
	for (const enc of ["utf-8", "gb18030", "big5"] as const) {
		try { return { text: new TextDecoder(enc, { fatal: true }).decode(bytes), encoding: enc }; } catch { /* 下一种 */ }
	}
	return { text: new TextDecoder("utf-8").decode(bytes), encoding: "utf-8(lossy)" };
}

const WATERMARK_BLOCK_RE = /(?:本书首发|首发域名|笔趣|leshu|feiku|最新章节|请记住|无弹窗|广告|域名一|域名二)/i;
const NAV_BLOCK_RE = /(?:上一章|下一章|返回目录|目录\s*页|加入书签|书页|章节错误|点此举报|报错)/i;

/** 逐行过滤站点水印/站内导航/空洞行；不去重、不改写正文。 */
export function cleanTextLayer(text: string): string {
	const lines = text.split(/\r?\n/);
	const kept: string[] = [];
	for (let raw of lines) {
		const line = raw.trim();
		if (!line.length) { kept.push(""); continue; }
		const hit = WATERMARK_BLOCK_RE.test(line) || NAV_BLOCK_RE.test(line);
		if (hit) continue;
		kept.push(raw);
	}
	// 连续空行压成单个换行
	let result = "";
	let blank = 0;
	for (const line of kept) {
		if (!line.trim()) { blank++; if (blank > 1) continue; }
		else blank = 0;
		result += line + "\n";
	}
	return result.replace(/\n{2,}/g, "\n\n").trimEnd() + "\n";
}

const CHAPTER_RE = /^\s*(?:第\s*[0-9〇零一二三四五六七八九十百千两]+\s*[章节卷回部集话話幕]|(?:序章|序言|楔子|尾声|后记|番外))\s*[:：\s\S]{0,40}$/;

export interface ChapterBlock { title: string; lines: string[] }

/** 逐行扫描切章；命中 <5 视为无章节结构。 */
export function splitChapters(text: string): { chapters: ChapterBlock[]; detected: boolean } {
	const lines = text.split(/\r?\n/);
	const blocks: ChapterBlock[] = [];
	let current: ChapterBlock | null = null;
	for (const line of lines) {
		if (CHAPTER_RE.test(line)) {
			current = { title: line.trim(), lines: [] };
			blocks.push(current);
			continue;
		}
		if (!current) current = { title: "", lines: [] };
		current.lines.push(line);
	}
	if (!blocks.length && current) blocks.push(current);
	const titles = blocks.map((b) => b.title).filter((t) => !!t);
	if (titles.length < 5) {
		// 无结构：全文当成单节（后续定长切块）
		return { chapters: [{ title: "", lines: lines }], detected: false };
	}
	return { chapters: blocks, detected: true };
}

export interface TextChunk { index: number; chars: number; chapters: string[]; text: string }

/** 贪心装箱分块：整章累加，超限封块；单章超限在段落边界二分。 */
export function chunkText(chapters: ChapterBlock[], chunkChars = CHUNK_CHARS, maxChunks = MAX_CHUNKS): TextChunk[] {
	const chunks: TextChunk[] = [];
	let buffer: string[] = [];
	let bufferChars = 0;
	let currentTitles: string[] = [];
	const flush = () => {
		if (!buffer.length) return;
		const text = buffer.join("\n\n");
		chunks.push({ index: chunks.length, chars: text.length, chapters: [...currentTitles], text });
		buffer = []; bufferChars = 0; currentTitles = [];
	};
	const pushLines = (title: string, lines: string[]) => {
		let text = lines.join("\n").trim();
		if (!text.length) return;
		const pair = title ? `${title}\n${text}` : text;
		if (bufferChars + pair.length <= chunkChars) {
			buffer.push(pair); bufferChars += pair.length;
			if (title && !currentTitles.includes(title)) currentTitles.push(title);
			return;
		}
		// 当前块已满，先封
		flush();
		if (pair.length <= chunkChars) {
			buffer.push(pair); bufferChars += pair.length;
			if (title) currentTitles.push(title);
			return;
		}
		// 单章超限：段落边界二分硬切
		const paragraphs = text.split(/\n\n+/);
		let seg: string[] = [];
		let segChars = 0;
		for (const para of paragraphs) {
			const candidate = seg.length ? `${seg.join("\n\n")}\n\n${para}` : para;
			if (segChars + para.length + 2 > chunkChars && seg.length) {
				flushSeg(title);
				seg = [para]; segChars = para.length;
				continue;
			}
			seg.push(para); segChars += para.length;
		}
		if (seg.length) flushSeg(title);
		function flushSeg(t: string) {
			const part = seg.join("\n\n");
			chunks.push({ index: chunks.length, chars: part.length, chapters: t ? [t] : [], text: part });
			seg = []; segChars = 0;
		}
	};
	for (const chapter of chapters) pushLines(chapter.title, chapter.lines);
	flush();
	if (chunks.length > maxChunks) {
		throw new Error(`文档过大：超过 ${maxChunks} 块上限`);
	}
	return chunks.map((c, index) => ({ ...c, index }));
}

/** epub → 同 txt 结构的纯文本（复用 ziplite，零新依赖）。 */
export function epubToText(data: Buffer): string {
	const container = firstZipEntry(data, (entry) => /^META-INF\/container\.xml$/i.test(entry.name));
	if (!container) throw new Error("epub 缺少 META-INF/container.xml");
	const containerXml = container.data.toString("utf8");
	const opfMatch = /full-path="([^"]+)"/i.exec(containerXml);
	if (!opfMatch) throw new Error("epub container.xml 缺少 opf 路径");
	const opfEntry = firstZipEntry(data, (entry) => entry.name.replace(/\\/g, "/") === opfMatch[1]);
	if (!opfEntry) throw new Error(`epub 缺少 opf：${opfMatch[1]}`);
	const opfXml = opfEntry.data.toString("utf8");
	const manifest = new Map<string, string>();
	for (const m of opfXml.matchAll(/item\s+[^>]*id="([^"]+)"[^>]*href="([^"]+)"/g)) manifest.set(m[1], m[2]);
	for (const m of opfXml.matchAll(/item\s+[^>]*href="([^"]+)"[^>]*id="([^"]+)"/g)) manifest.set(m[2], m[1]);
	const spineIds: string[] = [];
	for (const s of opfXml.matchAll(/itemref\s+[^>]*idref="([^"]+)"/g)) spineIds.push(s[1]);
	const base = opfMatch[1].split("/").slice(0, -1).join("/");
	const parts: string[] = [];
	for (const id of spineIds) {
		const href = manifest.get(id);
		if (!href) continue;
		const rel = href.replace(/\\/g, "/");
		const name = base ? `${base}/${rel}` : rel;
		const entry = firstZipEntry(data, (e) => e.name.replace(/\\/g, "/") === name.replace(/^\.\//, ""));
		if (!entry) continue;
		parts.push(spineXhtmlToText(entry.data.toString("utf8")));
	}
	const text = parts.filter((p) => p.trim()).join("\n\n");
	if (text.trim().length < 100) throw new Error("epub 正文过短，无法解析");
	return text;
}

function spineXhtmlToText(xhtml: string): string {
	// 章节标题：h1-h6
	let chapterTitle = "";
	for (const tag of ["h1", "h2", "h3", "h4", "h5", "h6"]) {
		const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(xhtml);
		if (m) { chapterTitle = m[1].replace(/<[^>]+>/g, "").trim(); break; }
	}
	const body = decodeHtmlEntities(xhtml
		.replace(/<(?:script|style)[\s\S]*?<\/\1>/gi, "")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>/gi, "\n\n")
		.replace(/<\/div>/gi, "\n")
		.replace(/<li>/gi, "\n- ")
		.replace(/<[^>]+>/g, "")
		.trim());
	const lines = body.split(/\n+/).map((l) => l.trim()).filter(Boolean).join("\n\n");
	return chapterTitle ? `${chapterTitle}\n\n${lines}` : lines;
}

function decodeHtmlEntities(text: string): string {
	return text
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

export function estimateCallsForChunks(chunkCount: number): number {
	return chunkCount + Math.ceil(chunkCount / ARC_CHUNK_BATCH) + ESTIMATE_FORMULA_TAIL;
}

// ---------- 文档级有界并行 + 研究库串行提交 ----------

function safeKey(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 24); }

export class CorpusEngine {
	// 大块摘要请求耗时较长；单飞避免同一网关并发时互相挤掉，三部仍会依次处理。
	static readonly MAX_ACTIVE_DOCUMENTS = 1;
	#deps: CorpusEngineDeps;
	#queue = new Set<string>();
	#jobs = new Map<string, CorpusJob & { promise: Promise<void> }>();
	#abort = new Map<string, AbortController>();
	#docs: Map<string, CorpusDocument>;
	#maxCallsPerDoc: number;

	constructor(deps: CorpusEngineDeps, maxCallsPerDoc = 800) {
		this.#deps = deps;
		this.#maxCallsPerDoc = maxCallsPerDoc;
		this.#docs = new Map(loadCorpusDocuments(deps.cwd).map((doc) => [doc.id, doc]));
	}

	/** 队列快照：documents + 当前运行进度（最多三部并行）。 */
	view(): { documents: CorpusDocument[]; running?: Array<{ docId: string; step: string; done: number; total: number }> } {
		const documents = [...this.#docs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
		const running = [...this.#jobs.values()].map((job) => ({ docId: job.doc.id, step: job.status.step, done: job.status.done, total: job.status.total }));
		return { documents, ...(running.length ? { running } : {}) };
	}

	/** 等待已经入队的文档全部完成（含自动重试产生的新任务）。 */
	async waitIdle(): Promise<void> {
		while (this.#queue.size || this.#jobs.size) {
			const jobs = [...this.#jobs.values()].map((job) => job.promise);
			if (jobs.length) await Promise.all(jobs);
			else await new Promise((resolve) => setTimeout(resolve, 0));
		}
	}

	getDoc(id: string): CorpusDocument | undefined { return this.#docs.get(id); }

	/** 服务重启恢复：把未完成的活跃任务重新入队（断点续跑，跳过已完成块）。 */
	restore(): void {
		for (const doc of this.#docs.values()) {
			if (["pending", "cleaning", "mapping", "reducing", "extracting"].includes(doc.status)) {
				doc.status = "pending";
				this.#enqueue(doc.id);
			}
		}
	}

	/** GET /corpus/:id 详情：ready 才返回 digest 全文，其余只返回文档与进度。 */
	getDetail(id: string): { doc: CorpusDocument; digest: CorpusDigest | null } {
		const doc = this.#docs.get(id);
		if (!doc) throw new Error("文档不存在");
		return { doc, digest: doc.status === "ready" ? this.#readDigest(doc.id) : null };
	}

	/** 建档：校验存在/类型/大小 → 复制 → 落 documents.json → 唤醒并行池。幂等按 originName+size。 */
	async create(uploadName: string): Promise<{ doc: CorpusDocument; estimatedCalls: number }> {
		const dir = join(this.#deps.cwd, ".liyuan-uploads");
		const stripped = uploadName.replace(/\\/g, "/").replace(/^\.(?:liyuan|rp)-uploads\//, "");
		const base = basename(stripped);
		if (!base || base.includes("/") || base.includes("..") || base.startsWith(".")) throw new Error("非法文件名");
		const src = join(dir, base);
		if (!existsSync(src)) throw new Error("文件不存在（请先经上传区上传）");
		const ext = extname(base).toLowerCase();
		if (![".txt", ".epub"].includes(ext)) throw new Error("仅支持 .txt / .epub");
		const bytes = readFileSync(src);
		if (bytes.length > MAX_UPLOAD_BYTES) throw new Error(`文件超过 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB 上限`);
		const stableId = `doc-${createHash("sha256").update(`${base}\n${bytes.length}`).digest("hex").slice(0, 16)}`;
		const existing = this.#docs.get(stableId);
		if (existing) return { doc: existing, estimatedCalls: existing.chunkCount ? estimateCallsForChunks(existing.chunkCount) : 0 };
		const workDir = join(corpusRoot(this.#deps.cwd), "work");
		mkdirSync(workDir, { recursive: true });
		rmSync(join(workDir, `${stableId}.raw`), { force: true });
		writeFileSync(join(workDir, `${stableId}.raw`), bytes);

		const { text, encoding } = decodeText(bytes);
		const cleaned = ext === ".epub" ? cleanTextLayer(epubToText(bytes)) : cleanTextLayer(text);
		const { chapters, detected } = splitChapters(cleaned);
		const chunks = chunkText(chapters, CHUNK_CHARS, MAX_CHUNKS);
		const estimatedCalls = estimateCallsForChunks(chunks.length);
		if (estimatedCalls > this.#maxCallsPerDoc) throw new Error(`预计需要约 ${estimatedCalls} 次模型调用，超过上限 ${this.#maxCallsPerDoc}；请换更短文本`);

		const cardKey = this.#deps.cardKey();
		const now = new Date().toISOString();
		const doc: CorpusDocument = {
			id: stableId,
			title: base.replace(/\.[^.]+$/, "").slice(0, 120),
			sourceKind: "upload",
			originName: base,
			chars: cleaned.length,
			encoding,
			chapterCount: detected ? chapters.length : 0,
			chunkCount: chunks.length,
			status: "pending",
			cardKey,
			createdAt: now,
			updatedAt: now,
		};
		this.#docs.set(doc.id, doc);
		this.#persistDocuments();
		this.#enqueue(doc.id);
		return { doc, estimatedCalls };
	}

	/** 建立 Kakuyomu URL 文档：抓取完成后进入与上传文件相同的消化链。 */
	async createUrl(value: string): Promise<{ doc: CorpusDocument; estimatedCalls: number }> {
		if (!this.#deps.fetchText) throw new Error("当前环境未配置网页抓取能力");
		const normalizedUrl = normalizeKakuyomuWorkUrl(value).toString(), id = kakuyomuDocumentId(normalizedUrl), existing = this.#docs.get(id);
		if (existing) return { doc: existing, estimatedCalls: existing.chunkCount ? estimateCallsForChunks(existing.chunkCount) : 0 };
		const now = new Date().toISOString(), doc: CorpusDocument = { id, title: normalizedUrl.slice(0, 120), sourceKind: "url", originName: normalizedUrl, chars: 0, encoding: "utf-8", chapterCount: 0, chunkCount: 0, status: "pending", cardKey: this.#deps.cardKey(), createdAt: now, updatedAt: now };
		this.#docs.set(id, doc); this.#persistDocuments(); this.#enqueue(id);
		return { doc, estimatedCalls: 0 };
	}

	status(): { running?: Array<{ docId: string; step: string; done: number; total: number }> } { return this.view(); }

	/** 当前块完成后停。 */
	pause(docId: string): void {
		const doc = this.#docs.get(docId);
		if (!doc) throw new Error("文档不存在");
		if (!["pending", "cleaning", "mapping"].includes(doc.status) && !this.#jobs.has(docId)) throw new Error("非运行态不可暂停");
		doc.status = "paused"; this.#persistDocuments();
	}

	resume(docId: string): void {
		const doc = this.#docs.get(docId);
		if (!doc) throw new Error("文档不存在");
		if (!["paused", "failed"].includes(doc.status)) throw new Error("文档当前状态不可恢复");
		delete (doc as Record<string, unknown>)._retries;
		doc.status = "pending"; this.#persistDocuments();
		this.#enqueue(docId);
	}

	retry(docId: string): void {
		const doc = this.#docs.get(docId);
		if (!doc) throw new Error("文档不存在");
		if (doc.status !== "failed") throw new Error("仅失败文档可重试");
		doc.status = "pending"; this.#persistDocuments();
		this.#enqueue(docId);
	}

	async remove(docId: string): Promise<number> {
		const doc = this.#docs.get(docId);
		if (!doc) throw new Error("文档不存在");
		// 中断正在运行的任务
		this.#abort.get(docId)?.abort();
		// 内存中先移除，落盘文档清单
		this.#docs.delete(docId);
		this.#queue.delete(docId);
		this.#persistDocuments();
		// 删除全文/摘要/原始工作文件
		for (const dir of [corpusTextsDir(this.#deps.cwd), corpusDigestsDir(this.#deps.cwd), join(corpusRoot(this.#deps.cwd), "work")]) {
			rmSync(join(dir, `${docId}.txt`), { force: true });
			rmSync(join(dir, `${docId}.json`), { force: true });
			rmSync(join(dir, `${docId}.raw`), { force: true });
		}
		// 研究库存量机制清理：只删被该文档独占引用的条目
		if (this.#deps.onRemoved) {
			try { return await this.#deps.onRemoved(docId); } catch { return 0; }
		}
		return 0;
	}

	listTexts(): string[] { return existsSync(corpusTextsDir(this.#deps.cwd)) ? readdirSync(corpusTextsDir(this.#deps.cwd)).filter((f) => f.endsWith(".txt")) : []; }

	// ---------- 内部 ----------

	#persistDocuments(): void {
		const path = corpusDocumentsFile(this.#deps.cwd);
		mkdirSync(corpusRoot(this.#deps.cwd), { recursive: true });
		this.#atomic(path, [...this.#docs.values()]);
	}

	#atomic(path: string, value: unknown): void {
		const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		renameSync(tmp, path);
	}

	#enqueue(docId: string): void {
		if (!this.#docs.has(docId) || this.#queue.has(docId) || this.#jobs.has(docId)) return;
		this.#queue.add(docId);
		this.#pump();
	}

	#pump(): void {
		while (this.#jobs.size < CorpusEngine.MAX_ACTIVE_DOCUMENTS && this.#queue.size) {
			const docId = this.#queue.values().next().value as string;
			this.#queue.delete(docId);
			const doc = this.#docs.get(docId);
			if (!doc) continue;
			const job: CorpusJob & { promise: Promise<void> } = { doc, status: { step: doc.status, done: 0, total: 0 }, promise: Promise.resolve() };
			this.#jobs.set(docId, job);
			this.#abort.set(docId, new AbortController());
			job.promise = this.#process(docId).catch(() => undefined).finally(() => {
				this.#jobs.delete(docId);
				this.#abort.delete(docId);
				this.#pump();
			});
		}
	}

	async #process(docId: string): Promise<void> {
		const doc = this.#docs.get(docId);
		if (!doc) return;
		const skill = this.#deps.loadSkill();
		if (!skill) { this.#fail(doc, "缺少 workflow: novel-digest 的 Skill"); return; }
		const digestPath = join(corpusDigestsDir(this.#deps.cwd), `${docId}.json`);
		let digest: CorpusDigest = this.#readDigest(docId) ?? { version: 1, docId, chunks: [], arcs: [], synopsis: "", structure: { plotSpine: "", characterArcs: "", hooksAndPacing: "" }, extractedCount: 0, updatedAt: new Date().toISOString() };
		const textsPath = join(corpusTextsDir(this.#deps.cwd), `${docId}.txt`);
		const rawPath = join(corpusRoot(this.#deps.cwd), "work", `${docId}.raw`);
		let rawBytes = existsSync(rawPath) ? readFileSync(rawPath) : null;
		if (doc.sourceKind === "url" && !rawBytes) {
			if (!this.#deps.fetchText) { this.#fail(doc, "当前环境未配置网页抓取能力"); return; }
			doc.status = "cleaning"; this.#persistDocuments();
			try {
				const fetched = await fetchKakuyomuWork(doc.originName, this.#deps.fetchText, this.#signal(docId));
				rawBytes = Buffer.from(fetched.text, "utf8");
				doc.title = fetched.work.title.slice(0, 120);
				doc.encoding = "utf-8";
				mkdirSync(join(corpusRoot(this.#deps.cwd), "work"), { recursive: true });
				writeFileSync(rawPath, rawBytes);
				this.#persistDocuments();
				if (doc.status === "paused") return;
			} catch (error) {
				this.#fail(doc, error instanceof Error ? error.message : String(error));
				return;
			}
		}
		let text = existsSync(textsPath) ? readFileSync(textsPath, "utf8") : "";
		if (!text && rawBytes) {
			const { text: decoded } = decodeText(rawBytes);
			if (extname(doc.originName).toLowerCase() === ".epub") text = cleanTextLayer(epubToText(rawBytes));
			else text = cleanTextLayer(decoded);
			mkdirSync(corpusTextsDir(this.#deps.cwd), { recursive: true });
			writeFileSync(textsPath, text, "utf8");
		}
		if (!text) { this.#fail(doc, "清洗后文本为空"); return; }
		const { chapters, detected } = splitChapters(text);
		const chunks = chunkText(chapters, CHUNK_CHARS, MAX_CHUNKS);
		// 元数据唯一权威是落盘正文：URL 抓取原文与旧版恢复留下的计数都可能偏大，
		// 在进入 mapping 前对齐并落盘，让恢复中的旧元数据自愈。
		const chapterCount = detected ? chapters.length : 0;
		if (doc.chars !== text.length || doc.chunkCount !== chunks.length || doc.chapterCount !== chapterCount) {
			doc.chars = text.length;
			doc.chunkCount = chunks.length;
			doc.chapterCount = chapterCount;
			this.#persistDocuments();
		}

		const job = this.#jobs.get(docId);
		if (!job) return;
		job.status = { step: "mapping", done: digest.chunks.length, total: chunks.length };
		doc.status = "mapping"; this.#persistDocuments();

		let called = digest.chunks.length;
		const budget = this.#maxCallsPerDoc;

		// map：逐块摘要，完成的块已落 digest（断点续跑）
		for (const chunk of chunks) {
			if (this.#signal(docId).aborted) return;
			if (doc.status === "paused") { doc.status = "paused"; this.#persistDocuments(); return; }
			if (digest.chunks.some((c) => c.index === chunk.index && !isFailedChunkSummary(c.summary))) continue;
			if (called >= budget) { this.#fail(doc, `调用预算超限（${budget}）`); return; }
			called++;
			const found = this.#docs.get(docId);
			if (!found) return;
			job.status = { step: "mapping", done: digest.chunks.length, total: chunks.length };
			let summary = "";
			const summaryOf = (raw: string): string => {
				const parsed = parseObject(raw);
				const s = parsed && cleanText(parsed.summary, 1500);
				if (s) return s;
				// GLM occasionally emits a fenced/truncated JSON object. Preserve a
				// valid summary field instead of discarding the whole successful call.
				const match = raw.match(/"summary"\s*:\s*"((?:\\.|[^"\\])*)/s)?.[1];
				if (match) {
					try { return JSON.parse(`"${match}"`).trim().slice(0, 1500); } catch {}
				}
				return Array.isArray(parsed?.chapters) ? "（本块无摘要）" : "";
			};
			const attempt = await this.#call(docId, skill, JSON.stringify({ task: "digest-map", doc_title: doc.title, chunk: { index: chunk.index, chapters: chunk.chapters, text: chunk.text.slice(0, CHUNK_CHARS) } }), 4096);
			summary = typeof attempt === "string" ? summaryOf(attempt) : "";
			if (!summary) {
				const retry = await this.#call(docId, skill, JSON.stringify({ task: "digest-map", doc_title: doc.title, chunk: { index: chunk.index, chapters: chunk.chapters, text: chunk.text.slice(0, CHUNK_CHARS) } }), 4096);
				summary = typeof retry === "string" ? summaryOf(retry) : "";
			}
			const found2 = this.#docs.get(docId);
			if (!found2) return;
			if (!summary) {
				console.error(`[corpus] 块 ${chunk.index} 摘要输出不可解析：${(typeof attempt === "string" ? attempt : (attempt as { error?: string }).error ?? "error")?.slice(0, 300)}`);
				const failedSummary = `(本块摘要生成失败，仅保留章节列表)`;
				const previous = digest.chunks.findIndex((c) => c.index === chunk.index);
				const failedChunk = { index: chunk.index, chars: chunk.chars, chapters: chapterTitles(chunk.chapters, chunk.text), summary: failedSummary };
				if (previous >= 0) digest.chunks[previous] = failedChunk; else digest.chunks.push(failedChunk);
				digest.updatedAt = new Date().toISOString(); this.#writeDigest(docId, digest);
				this.#fail(doc, `第 ${chunk.index + 1} 块摘要生成失败，可重试`);
				return;
			}
			digest.chunks.push({ index: chunk.index, chars: chunk.chars, chapters: chapterTitles(chunk.chapters, chunk.text), summary });
			digest.updatedAt = new Date().toISOString();
			this.#writeDigest(docId, digest);
		}
		if (doc.status === "paused") return;

		// reduce-arc：每 ~50 块一组归并弧线摘要
		doc.status = "reducing"; this.#persistDocuments();
		const arcs: CorpusArcDigest[] = [];
		for (let start = 0; start < chunks.length; start += ARC_CHUNK_BATCH) {
			if (this.#signal(docId).aborted || !this.#docs.has(docId)) return;
			const batch = chunks.slice(start, start + ARC_CHUNK_BATCH).map((chunk) => digest.chunks.find((c) => c.index === chunk.index)?.summary ?? "");
			const end = Math.min(start + ARC_CHUNK_BATCH, chunks.length) - 1;
			const title = batch.length < ARC_CHUNK_BATCH ? `收尾段（块 ${start}–${Math.min(chunks.length - 1, start + ARC_CHUNK_BATCH - 1)}）` : `第 ${start / ARC_CHUNK_BATCH + 1} 段（块 ${start}–${end}）`;
			const raw = await this.#call(docId, skill, JSON.stringify({ task: "digest-reduce-arc", doc_title: doc.title, arc_title: title, chunk_summaries: batch }), 4096);
			const summary = typeof raw === "string" ? textField(raw, "summary", 2000) : "";
			if (summary) arcs.push({ title, chunkRange: [start, end], summary });
			else { console.error(`[corpus] 弧线摘要不可解析：${(typeof raw === "string" ? raw : (raw as { error?: string }).error ?? "error")?.slice(0, 300)}`); this.#fail(doc, "弧线摘要生成失败"); return; }
		}
		digest.arcs = arcs; digest.updatedAt = new Date().toISOString(); this.#writeDigest(docId, digest);

		// reduce-final：全书梗概 + 结构
		doc.status = "extracting"; this.#persistDocuments();
		const finalUser = JSON.stringify({ task: "digest-reduce-final", doc_title: doc.title, arc_summaries: arcs.map((a) => a.summary) });
		let finalRaw = await this.#call(docId, skill, finalUser, 8192);
		if (this.#signal(docId).aborted || !this.#docs.has(docId)) return;
		let finalParsed = typeof finalRaw === "string" ? parseObject(finalRaw) : null;
		if (!finalParsed) { finalRaw = await this.#call(docId, skill, finalUser, 8192); finalParsed = typeof finalRaw === "string" ? parseObject(finalRaw) : null; }
		const synopsis = typeof finalRaw === "string" ? textField(finalRaw, "synopsis", 3000) : "";
		if (!finalParsed && !synopsis) { console.error(`[corpus] 全书梗概输出不可解析：${(typeof finalRaw === "string" ? finalRaw : (finalRaw as { error?: string }).error ?? "error")?.slice(0, 300)}`); this.#fail(doc, "全书梗概生成失败"); return; }
		digest.synopsis = synopsis;
		const s = finalParsed?.structure && typeof finalParsed.structure === "object" && !Array.isArray(finalParsed.structure) ? finalParsed.structure as Record<string, unknown> : {};
		digest.structure = {
			plotSpine: cleanText(s.plotSpine, 2000),
			characterArcs: cleanText(s.characterArcs, 2000),
			hooksAndPacing: cleanText(s.hooksAndPacing, 2000),
		};
		digest.updatedAt = new Date().toISOString(); this.#writeDigest(docId, digest);

		// extract：块级证据支撑具体桥段，弧线证据仅支撑全局结构。
		const evidenceIndex = [
			...digest.chunks.map((chunk) => ({ id: `chunk-${chunk.index + 1}`, kind: "chunk", locator: corpusChunkLocator(chunk), summary: chunk.summary })),
			...arcs.map((arc, index) => ({ id: `arc-${index + 1}`, kind: "arc", locator: corpusArcLocator(arc, digest.chunks), summary: arc.summary })),
		];
		const evidenceById = new Map(evidenceIndex.map((item) => [item.id, item]));
		const extractInput = { doc_title: doc.title, synopsis: digest.synopsis, structure: digest.structure, evidence_index: evidenceIndex };
		const extractParts = await Promise.all(["digest-extract-mechanisms", "digest-extract-daily", "digest-extract-assets"].map(async (task) => {
			let raw = await this.#call(docId, skill, JSON.stringify({ task, ...extractInput }), 8192);
			let parsed = typeof raw === "string" ? parseObject(raw) : null;
			if (!parsed) { raw = await this.#call(docId, skill, JSON.stringify({ task, ...extractInput }), 8192); parsed = typeof raw === "string" ? parseObject(raw) : null; }
			return parsed;
		}));
		if (this.#signal(docId).aborted || !this.#docs.has(docId)) return;
		const failedExtracts = ["digest-extract-mechanisms", "digest-extract-daily", "digest-extract-assets"].filter((_, index) => !extractParts[index]);
		if (failedExtracts.length) console.error(`[corpus] 结构化素材部分降级 doc=${docId}: ${failedExtracts.join(",")}`);
		// 提炼属于研究增强层；某一子任务格式异常时保留其余结果，不能让整部文档反复重跑。
		const extractParsed = Object.assign({}, ...extractParts.filter((part): part is Record<string, unknown> => !!part));
		const tropes: CorpusTrope[] = Array.isArray(extractParsed?.tropes)
			? extractParsed.tropes.flatMap((item): CorpusTrope[] => {
				if (!item || typeof item !== "object" || Array.isArray(item)) return [];
				const row = item as Record<string, unknown>;
				const evidenceIds = cleanList(row.evidenceIds, 4, 40).filter((id) => evidenceById.has(id));
				return typeof row.mechanism === "string" && row.mechanism.trim() && evidenceIds.length
					? [{ mechanism: cleanText(row.mechanism, 600), appliesWhen: cleanText(row.appliesWhen, 500), failureWarning: cleanText(row.failureWarning, 500), locator: evidenceLocator(evidenceIds, evidenceById), evidenceIds }]
					: [];
			}).slice(0, 40)
			: [];
		const dailyPatterns: CorpusDailyPattern[] = Array.isArray(extractParsed.dailyPatterns) ? extractParsed.dailyPatterns.flatMap((item): CorpusDailyPattern[] => {
			if (!item || typeof item !== "object" || Array.isArray(item)) return [];
			const row = item as Record<string, unknown>, value: CorpusDailyPattern = {
				title: cleanText(row.title, 180), setting: cleanText(row.setting, 180), surfaceActivity: cleanText(row.surfaceActivity), initiative: cleanText(row.initiative), sweetBeat: cleanText(row.sweetBeat), friction: cleanText(row.friction), misunderstanding: cleanText(row.misunderstanding), microChange: cleanText(row.microChange), escalationLimit: cleanText(row.escalationLimit), naturalStop: cleanText(row.naturalStop), failureWarning: cleanText(row.failureWarning), locator: "", evidenceIds: cleanList(row.evidenceIds, 4, 40).filter((id) => evidenceById.has(id)),
			};
			value.locator = evidenceLocator(value.evidenceIds ?? [], evidenceById);
			return value.title && value.surfaceActivity && value.microChange && value.evidenceIds?.length ? [value] : [];
		}).slice(0, 20) : [];
		const assets: NarrativeAsset[] = Array.isArray(extractParsed.assets) ? extractParsed.assets.flatMap((item): NarrativeAsset[] => {
			if (!item || typeof item !== "object" || Array.isArray(item)) return [];
			const row = item as Record<string, unknown>;
			const kind = row.kind === "scene-pattern" || row.kind === "relationship-beat" || row.kind === "dialogue-move" ? row.kind : null;
			if (!kind) return [];
			const value: NarrativeAsset = {
				kind,
				title: cleanText(row.title, 180), mechanism: cleanText(row.mechanism, 700),
				appliesWhen: cleanText(row.appliesWhen, 500), failureWarning: cleanText(row.failureWarning, 500),
				opening: cleanText(row.opening, 500), progression: cleanList(row.progression, 6, 300),
				turn: cleanText(row.turn, 500), stopPoint: cleanText(row.stopPoint, 500),
				relationshipStage: cleanText(row.relationshipStage, 180), pressure: cleanText(row.pressure, 180),
				desiredExperience: cleanText(row.desiredExperience, 180), locator: "", evidenceIds: cleanList(row.evidenceIds, 4, 40).filter((id) => evidenceById.has(id)),
			};
			value.locator = evidenceLocator(value.evidenceIds ?? [], evidenceById);
			return value.title && value.mechanism && value.evidenceIds?.length ? [value] : [];
		}).slice(0, 30) : [];
		const auditRows = [...tropes.map((item) => ({ kind: "mechanism", text: item.mechanism, evidenceIds: item.evidenceIds })), ...dailyPatterns.map((item) => ({ kind: "daily", text: `${item.title} ${item.surfaceActivity} ${item.microChange}`, evidenceIds: item.evidenceIds })), ...assets.map((item) => ({ kind: "asset", text: `${item.title} ${item.mechanism}`, evidenceIds: item.evidenceIds }))];
		let auditResult = new Map<number, "supported" | "weak" | "unsupported">();
		if (auditRows.length) {
			const auditRaw = await this.#call(docId, skill, JSON.stringify({ task: "digest-audit", evidence_index: evidenceIndex, items: auditRows.map((item, index) => ({ index, ...item })) }), 8192);
			const auditParsed = typeof auditRaw === "string" ? parseObject(auditRaw) : null;
			if (Array.isArray(auditParsed?.results)) for (const raw of auditParsed.results) {
				if (!raw || typeof raw !== "object") continue;
				const row = raw as Record<string, unknown>;
				if (Number.isInteger(row.index) && ["supported", "weak", "unsupported"].includes(String(row.verdict))) auditResult.set(Number(row.index), row.verdict as "supported" | "weak" | "unsupported");
			}
		}
		const verdict = (index: number) => auditResult.get(index) ?? "weak";
		const approvedTropes = tropes.filter((_, index) => verdict(index) !== "unsupported");
		const dailyOffset = tropes.length, assetOffset = dailyOffset + dailyPatterns.length;
		const approvedDaily = dailyPatterns.filter((_, index) => verdict(dailyOffset + index) !== "unsupported");
		const approvedAssets = assets.filter((_, index) => verdict(assetOffset + index) !== "unsupported");
		digest.audit = { approved: [...auditResult.values()].filter((item) => item === "supported").length, weak: auditRows.filter((_, index) => verdict(index) === "weak").length, rejected: [...auditResult.values()].filter((item) => item === "unsupported").length };
		digest.extractedCount = approvedTropes.length;
		digest.dailyPatternCount = approvedDaily.length;
		digest.dailyPatterns = approvedDaily;
		digest.assets = approvedAssets;
		digest.assetCount = approvedAssets.length;
		digest.updatedAt = new Date().toISOString(); this.#writeDigest(docId, digest);

		// 入库：机制条目 + 文档 ready
		const extractions: OutlineResearchExtraction[] = approvedTropes.map((t) => ({
			mechanism: t.mechanism,
			appliesWhen: t.appliesWhen,
			failureWarning: t.failureWarning,
			sourceIds: [docId],
			locator: t.locator,
			evidenceSummary: (t.evidenceIds ?? []).flatMap((id) => evidenceById.get(id)?.summary ?? []).join("\n").slice(0, 800),
			confidence: verdict(tropes.indexOf(t)) === "supported" ? "audited" : "system-grounded",
		}));
		doc.status = "ready"; doc.chunkCount = chunks.length; doc.chapterCount = detected ? chapters.length : 0; doc.synopsisPreview = digest.synopsis.slice(0, 400); doc.tropeCount = approvedTropes.length; doc.dailyPatternCount = approvedDaily.length; doc.assetCount = approvedAssets.length; delete doc.error; delete (doc as Record<string, unknown>)._retries; this.#persistDocuments();

		// 入库（宿主挂 onReady → research store.mergeCorpus）
		if (this.#deps.onReady) {
			try { await this.#deps.onReady(doc, digest, extractions); }
			catch { /* 入库失败保留 failed？ 设计：ready 已置；机制入库失败不阻塞文档展示，遗留由 remove 清理 */ }
		}
	}

	private static readonly MODEL_MAX_RETRIES = 3;
	// GLM 长文本摘要在代理链路上可能超过两分钟；不要在上游仍处理中途掐断。
	private static readonly MODEL_CALL_TIMEOUT_MS = 180_000;

	#signal(docId: string): AbortSignal { return this.#abort.get(docId)?.signal ?? AbortSignal.abort(); }

	async #call(docId: string, skill: string, user: string, maxTokens: number): Promise<string | { error: string }> {
		const call = async (attempt: number): Promise<string | { error: string }> => {
			const signal = AbortSignal.any([this.#signal(docId), AbortSignal.timeout(CorpusEngine.MODEL_CALL_TIMEOUT_MS)]);
			console.log(`[corpus] 模型调用开始 doc=${docId} attempt=${attempt + 1}/${CorpusEngine.MODEL_MAX_RETRIES + 1}`);
			try {
				let focusedSkill = skill;
				try {
					const task = JSON.parse(user).task;
					if (typeof task === "string") {
						const marker = `## task: ${task}`;
						const start = skill.indexOf(marker);
						if (start >= 0) {
							const next = skill.indexOf("\n## task:", start + marker.length);
							focusedSkill = skill.slice(start, next >= 0 ? next : skill.length).trim();
						}
					}
				} catch {}
				const result = await this.#deps.runSideModel("novelDigest", focusedSkill, user, {
					maxTokens, signal, forceNonStreaming: true,
				});
				console.log(`[corpus] 模型调用结束 doc=${docId} attempt=${attempt + 1} result=${typeof result === "string" ? "text" : "error"}`);
				if (typeof result === "object" && result && "error" in result) console.error(`[corpus] 模型调用错误 doc=${docId} attempt=${attempt + 1}: ${String((result as { error?: unknown }).error ?? "error").slice(0, 500)}`);
				if (typeof result === "object" && result && "error" in result && attempt < CorpusEngine.MODEL_MAX_RETRIES) {
					await new Promise((resolve) => setTimeout(resolve, 600 * Math.min(2 ** attempt, 8)));
					return call(attempt + 1);
				}
				return result;
			} catch (error) {
				console.error(`[corpus] 模型调用异常 doc=${docId} attempt=${attempt + 1}: ${error instanceof Error ? error.message : String(error)}`);
				if (attempt < CorpusEngine.MODEL_MAX_RETRIES) {
					await new Promise((resolve) => setTimeout(resolve, 500));
					return call(attempt + 1);
				}
				return { error: "调用异常已耗尽重试" };
			}
		};
		return call(0);
	}

	#readDigest(docId: string): CorpusDigest | null {
		const path = join(corpusDigestsDir(this.#deps.cwd), `${docId}.json`);
		try { const value = JSON.parse(readFileSync(path, "utf8")); if (value && typeof value === "object" && value.version === 1 && Array.isArray((value as CorpusDigest).chunks)) return value as CorpusDigest; } catch {}
		return null;
	}

	#writeDigest(docId: string, digest: CorpusDigest): void {
		const dir = corpusDigestsDir(this.#deps.cwd);
		mkdirSync(dir, { recursive: true });
		this.#atomic(join(dir, `${docId}.json`), digest);
	}

	private static readonly DOC_MAX_RETRIES = 3;

	#fail(doc: CorpusDocument, message: string): void {
		const retries = ((doc as Record<string, unknown>)._retries as number | undefined) ?? 0;
		if (retries < CorpusEngine.DOC_MAX_RETRIES) {
			(doc as Record<string, unknown>)._retries = retries + 1;
			doc.status = "pending"; this.#persistDocuments(); this.#queue.add(doc.id);
			return;
		}
		doc.status = "failed"; doc.error = message; delete (doc as Record<string, unknown>)._retries;
		this.#persistDocuments();
	}
}

function chapterTitles(chapters: string[], text: string): string[] {
	const t = chapters.filter(Boolean).slice(0, 8).map((c) => c.slice(0, 30));
	return t.length ? t : [];
}

function corpusArcLocator(arc: CorpusArcDigest, chunks: CorpusChunkDigest[]): string {
	const covered = chunks.filter((chunk) => chunk.index >= arc.chunkRange[0] && chunk.index <= arc.chunkRange[1]);
	const chapters = covered.flatMap((chunk) => chunk.chapters).filter(Boolean);
	const chapterPart = chapters.length ? `${chapters[0]}${chapters.length > 1 ? ` 至 ${chapters.at(-1)}` : ""}；` : "";
	return `${chapterPart}块 ${arc.chunkRange[0] + 1}-${arc.chunkRange[1] + 1}`.slice(0, 240);
}

function corpusChunkLocator(chunk: CorpusChunkDigest): string {
	const chapters = chunk.chapters.filter(Boolean);
	const chapterPart = chapters.length ? `${chapters[0]}${chapters.length > 1 ? ` 至 ${chapters.at(-1)}` : ""}；` : "";
	return `${chapterPart}块 ${chunk.index + 1}`.slice(0, 240);
}

function evidenceLocator(ids: string[], index: Map<string, { locator: string }>): string {
	return [...new Set(ids.flatMap((id) => index.get(id)?.locator ?? []))].join("；").slice(0, 240);
}

function isFailedChunkSummary(summary: string): boolean {
	return summary.startsWith("(本块摘要生成失败") || summary.startsWith("（本块摘要生成失败");
}
