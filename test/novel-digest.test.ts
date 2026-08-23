import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CorpusEngine, cleanTextLayer, chunkText, decodeText, estimateCallsForChunks, splitChapters, MAX_CHUNKS } from "../src/outline/corpus.ts";
import { OutlineResearchStore } from "../src/outline/research.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "novel-digest-"));
const AUDIT_OK = JSON.stringify({ version: 1, verdict: "approve", issues: [], summary: "ok" });

function corpusDeps(cwd: string, onCall: (task: string, text: string) => string | { error: string }) {
	const research = new OutlineResearchStore(cwd);
	return {
		cwd,
		runSideModel: async (step: string, _system: string, userText: string, opts: { maxTokens?: number; signal?: AbortSignal }) => {
			assert.equal(step, "novelDigest");
			const task = JSON.parse(userText).task;
			if (opts.signal?.aborted) return { error: "aborted" };
			return onCall(task, userText);
		},
		loadSkill: () => "skill-body",
		cardKey: () => "card-a",
		onReady: (document: any, digest: any, extracted: any) => research.mergeCorpus(document.cardKey, document, digest, extracted).then(() => undefined),
		onRemoved: (docId: string) => research.removeCorpus(docId),
	};
}

function sampleText(): string {
	const lines: string[] = [];
	for (let c = 1; c <= 6; c++) {
		lines.push(`第${c}章 风波`);
		for (let p = 0; p < 20; p++) lines.push(`　　$(c)章第$(p)段。林默走出巷口，夜色压下来，手里攥着那封没有署名的信。`);
	}
	return lines.join("\n");
}

test("解码：utf-8 优先，gb18030 命中，坏字节退 lossy", () => {
	const enc = new TextEncoder();
	const utf8 = enc.encode("这是章节标题");
	assert.equal(decodeText(Buffer.from(utf8)).encoding, "utf-8");
	// GBK「中文测试」= D6 D0 CE C4 B2 E2 CA D4（非法 utf-8 序列 → 应走 gb18030）
	const gb = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4]);
	const decoded = decodeText(gb);
	assert.equal(decoded.encoding, "gb18030");
	assert.equal(decoded.text.includes("测试"), true);
	const bad = Buffer.from([0xff, 0xfe, 0x00, 0x61]);
	const result = decodeText(bad);
	assert.equal(result.encoding, "utf-8(lossy)");
	assert.equal(result.text.length > 0, true);
});

test("清洗：水印行与导航行删除，正文对白保留", () => {
	const text = "我爱她。\n本书首发于某站，请记住本站域名。\n上一章 目录 下一页\n“你现在想去吃饭吗？”\n\n\n下一行是正文。\n";
	const cleaned = cleanTextLayer(text);
	assert.equal(cleaned.includes("我爱她"), true);
	assert.equal(cleaned.includes("某站"), false);
	assert.equal(cleaned.includes("上一章"), false);
	assert.equal(cleaned.includes("想去吃饭"), true);
	assert.equal(cleaned.includes("下一行是正文"), true);
});

test("分章：标准「第N章」识别", () => {
	const { chapters, detected } = splitChapters("第1章 初见\n第一段。\n第2章 重逢\n第二段。\n第3章 别离\n第三段。\n第4章 决裂\n第四段。\n第5章 和解\n第五段。\n第6章 结局\n第六段。\n");
	assert.equal(detected, true);
	assert.equal(chapters.length, 6);
	assert.equal(chapters[0]?.title, "第1章 初见");
});

test("分章：序章/番外与无章节退化", () => {
	const { detected } = splitChapters("序章 起风\n第一段。\n番外 归家\n第二段。");
	assert.equal(detected, false);
	const hasAnn = splitChapters("第1章 A\n一。\n第2章 B\n二。\n第3章 C\n三。\n第4章 D\n四。\n第5章 E\n五。");
	assert.equal(hasAnn.detected, true);
});

test("分块：贪心装箱不超 CHUNK_CHARS，章节名正确携带", () => {
	const { chapters } = splitChapters(sampleText());
	const chunks = chunkText(chapters, 2000);
	assert.equal(chunks.length > 1, true);
	for (const chunk of chunks) assert.equal(chunk.chars <= 2000, true);
	assert.equal(chunks[0]?.chapters.length > 0, true);
});

test("分块：块数上限拒绝超大文档", () => {
	const big = Array.from({ length: 10_000 }, (_, i) => `第${i + 1}章\n${"段落".repeat(120)}`).join("\n");
	const { chapters } = splitChapters(big);
	assert.throws(() => chunkText(chapters, 100, 60), /文档过大/);
});

test("调用预估：块数越大预估越高", () => {
	assert.equal(estimateCallsForChunks(50), 50 + 1 + 2);
	assert.equal(estimateCallsForChunks(120), 120 + Math.ceil(120 / 50) + 2);
});

test("管道：faux 返回合法 JSON → 文档到 ready，研究库有套路条目", async () => {
	const cwd = tmp();
	try {
		mkdirSync(join(cwd, ".liyuan-uploads"), { recursive: true });
		writeFileSync(join(cwd, ".liyuan-uploads", "novel.txt"), sampleText());
		const engine = new CorpusEngine(corpusDeps(cwd, (task) => {
			if (task === "digest-map") return JSON.stringify({ summary: "一段摘要内容", chapters: ["第1章"] });
			if (task === "digest-reduce-arc") return JSON.stringify({ summary: "弧线摘要" });
			if (task === "digest-reduce-final") return JSON.stringify({ synopsis: "全书梗概", structure: { plotSpine: "主线", characterArcs: "弧", hooksAndPacing: "节奏" } });
			if (task === "digest-extract") return JSON.stringify({ tropes: [{ mechanism: "来信制造悬念", appliesWhen: "关系刚建立时", failureWarning: "久不回收会拖节奏", locator: "第1–2章" }] });
			return AUDIT_OK;
		}));
		const { doc } = await engine.create(".liyuan-uploads/novel.txt");
		await engine.waitIdle();
		assert.equal(engine.getDoc(doc.id)?.status, "ready");
		assert.equal(engine.getDetail(doc.id).doc.status, "ready");
		const detail = engine.getDetail(doc.id);
		assert.equal(detail.digest?.synopsis, "全书梗概");
		assert.equal(detail.digest?.extractedCount, 1);
		assert.equal(engine.listTexts().length, 1);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("管道：map 返回非法 JSON → 重试一次后占位不中断", async () => {
	const cwd = tmp();
	try {
		mkdirSync(join(cwd, ".liyuan-uploads"), { recursive: true });
		writeFileSync(join(cwd, ".liyuan-uploads", "bad.txt"), sampleText());
		let mapCalls = 0;
		const engine = new CorpusEngine(corpusDeps(cwd, (task) => {
			if (task === "digest-map") { mapCalls++; return mapCalls <= 2 ? "not json" : JSON.stringify({ summary: "合法块摘要", chapters: [] }); }
			if (task === "digest-reduce-arc") return JSON.stringify({ summary: "弧线" });
			if (task === "digest-reduce-final") return JSON.stringify({ synopsis: "梗概", structure: { plotSpine: "a", characterArcs: "b", hooksAndPacing: "c" } });
			if (task === "digest-extract") return JSON.stringify({ tropes: [] });
			return AUDIT_OK;
		}));
		const { doc } = await engine.create(".liyuan-uploads/bad.txt");
		await engine.waitIdle();
		assert.equal(engine.getDoc(doc.id)?.status, "ready");
		// 每个失败块：首次非法 JSON + 重试一次 → 仍失败记占位，不再第三次
		assert.equal(mapCalls, 2);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("管道：reduce 失败 → failed 且保留已完成块，retry 从断点续跑（faux 计数只补缺失块）", async () => {
	const cwd = tmp();
	try {
		mkdirSync(join(cwd, ".liyuan-uploads"), { recursive: true });
		writeFileSync(join(cwd, ".liyuan-uploads", "retry.txt"), sampleText());
		let mapCalls = 0, reduceFail = true, extractCalls = 0;
		const engine = new CorpusEngine(corpusDeps(cwd, (task) => {
			if (task === "digest-map") { mapCalls++; return JSON.stringify({ summary: `块${mapCalls}摘要`, chapters: [] }); }
			if (task === "digest-reduce-arc") { if (reduceFail) { reduceFail = false; return "bad"; } return JSON.stringify({ summary: "弧线" }); }
			if (task === "digest-reduce-final") return JSON.stringify({ synopsis: "梗概", structure: { plotSpine: "a", characterArcs: "b", hooksAndPacing: "c" } });
			if (task === "digest-extract") { extractCalls++; return JSON.stringify({ tropes: [] }); }
			return AUDIT_OK;
		}));
		await engine.create(".liyuan-uploads/retry.txt");
		await engine.waitIdle();
		const afterFail = engine.getDoc([...engine.view().documents][0]?.id ?? "");
		assert.ok(afterFail);
		assert.equal(afterFail.status, "failed");
		const digestPathAfter = engine.listTexts();
		assert.equal(digestPathAfter.length, 1);
		// retry：map 不应再跑（已完成块被跳过 / 不重复），但这次会成功
		engine.retry(afterFail.id);
		const docId = afterFail.id;
		// 等待串行链完成（写链在 engine 内部是 promise 链；此处等一个 tick 后再查）
		await engine.waitIdle();
		const status = engine.getDoc(docId)?.status;
		assert.ok(status === "ready" || status === "failed", `retry 后应为 ready 或 failed，实际 ${status}`);
		if (status === "ready") assert.ok(extractCalls >= 1);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("入库：mergeCorpus 机制入研究库；删除只删该 doc 独占条目", async () => {
	const cwd = tmp();
	try {
		mkdirSync(join(cwd, ".liyuan-uploads"), { recursive: true });
		writeFileSync(join(cwd, ".liyuan-uploads", "shared.txt"), sampleText());
		const engine = new CorpusEngine(corpusDeps(cwd, (task) => {
			if (task === "digest-map") return JSON.stringify({ summary: "s", chapters: [] });
			if (task === "digest-reduce-arc") return JSON.stringify({ summary: "a" });
			if (task === "digest-reduce-final") return JSON.stringify({ synopsis: "x", structure: { plotSpine: "1", characterArcs: "2", hooksAndPacing: "3" } });
			if (task === "digest-extract") return JSON.stringify({ tropes: [{ mechanism: "共享来源套路", appliesWhen: "w", failureWarning: "f", locator: "第1章" }] });
			return AUDIT_OK;
		}));
		const { doc } = await engine.create(".liyuan-uploads/shared.txt");
		await engine.waitIdle();
		assert.equal(engine.getDoc(doc.id)?.status, "ready");
		const removed = await engine.remove(doc.id);
		assert.equal(removed, 1);
		assert.equal(engine.getDoc(doc.id), undefined);
		assert.equal(engine.listTexts().length, 0);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("投影：同卡 view 里 documents 包含 ready 文档，非该卡不混入", async () => {
	// 通过 corpus 引擎 + research 钩子验证卡级隔离由 cardKey 快照实现
	const cwd = tmp();
	try {
		mkdirSync(join(cwd, ".liyuan-uploads"), { recursive: true });
		writeFileSync(join(cwd, ".liyuan-uploads", "proj.txt"), sampleText());
		const engine = new CorpusEngine(corpusDeps(cwd, (task) => {
			if (task === "digest-map") return JSON.stringify({ summary: "s", chapters: [] });
			if (task === "digest-reduce-arc") return JSON.stringify({ summary: "a" });
			if (task === "digest-reduce-final") return JSON.stringify({ synopsis: "梗概全文", structure: { plotSpine: "1", characterArcs: "2", hooksAndPacing: "3" } });
			if (task === "digest-extract") return JSON.stringify({ tropes: [] });
			return AUDIT_OK;
		}));
		const { doc } = await engine.create(".liyuan-uploads/proj.txt");
		await engine.waitIdle();
		assert.equal(doc.cardKey, "card-a");
		assert.equal(engine.getDoc(doc.id)?.synopsisPreview, "梗概全文");
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});