import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildRpSummaryInitialPrompt, buildRpSummaryPrompt, buildRpSummaryUpdatePrompt, RP_SUMMARY_SECTIONS } from "../src/scribe.ts";
import {
	memoryArchiveCompacted,
	memoryEvidenceForEvent,
	memoryHasEvent,
	memoryListEventDigests,
	memoryRecallForTurn,
	memoryUpsertEventDigest,
	updateMemoryConfig,
} from "../src/memory/service.ts";
import { evictByPriority, evictionRank } from "../src/memory/store.ts";
import { parseRpSummaryEnvelope } from "../src/stage/compact.ts";
import { shouldRecallHistory, sideTextRetryLimit, sideTextTimeoutMs } from "../src/stage/engine.ts";
import type { MemoryChunk, MemoryChunkMeta, MemoryImportance, RpEventDigest } from "../src/memory/types.ts";

const scope = { sessionId: "sess-rp", card: "assets/cards/rpcard.png" };

const sampleEvent: RpEventDigest = {
	kind: "rp-event-digest",
	id: "event_first_meeting_001",
	status: "active",
	importance: "core",
	title: "男女主初次相遇",
	tags: ["初遇", "雨天", "递伞", "误会"],
	recallAnchors: ["第一次见面", "那把伞", "那场雨", "当初"],
	summary: "男主在雨中递伞，女主误认为催债人而离开。",
	evidenceLevel: "source-backed",
	sourceRefs: [{ entryId: "entry-0001", entryType: "message", turn: 1 }],
	branchLeafId: "leaf-1",
};

function enableMemory(cwd: string) {
	updateMemoryConfig(cwd, { enabled: true, injectOnTurn: true, searchTopK: 5, embedMode: "local" });
}

test("rp-memory: 事件卡 upsert + list + has", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-rpmem-event-"));
	try {
		enableMemory(cwd);
		await memoryUpsertEventDigest(cwd, scope, sampleEvent);
		assert.equal(memoryHasEvent(cwd, scope, "event_first_meeting_001"), false, "外部给定 id 不再作为 canonical id");
		const list = memoryListEventDigests(cwd, scope);
		assert.equal(list.length, 1);
		assert.match(list[0]!.id, /^event_[0-9a-f]{16}$/);
		assert.equal(list[0]!.importance, "core");
		assert.deepEqual(list[0]!.recallAnchors, ["第一次见面", "那把伞", "那场雨", "当初"]);

		// 幂等更新：同 id 覆盖不新增
		await memoryUpsertEventDigest(cwd, scope, { ...sampleEvent, summary: "更新后的概括" });
		const again = memoryListEventDigests(cwd, scope);
		assert.equal(again.length, 1);
		assert.equal(again[0]!.summary, "更新后的概括");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("rp-memory: 事件卡 → 证据两阶段召回（沿 sourceRefs 找到归档原文）", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-rpmem-evidence-"));
	try {
		enableMemory(cwd);
		await memoryUpsertEventDigest(cwd, scope, sampleEvent);

		const narrative = "细雨里，他撑着伞快步走来。\n「姑娘，雨大。」他把伞递了过去。\n她一愣，盯着他看了两秒，忽然皱眉：「你是……账房派来讨债的？」\n「不是——」\n她没听完，转身就走，伞留在地上。";
		await memoryArchiveCompacted(cwd, scope, narrative, { sourceRefs: [{ entryId: "entry-0001", entryType: "message", turn: 1 }] });

		// 两阶段：先撞事件卡（定位），再取证据（原文）
		const hits = await memoryRecallForTurn(cwd, scope, "第一次见面 递伞 讨债");
		assert.ok(hits.length >= 1, "应命中至少一条记忆");
		const eventHit = hits.find((h) => h.meta?.kind === "event");
		assert.ok(eventHit, "应命中事件卡");
		assert.match(eventHit!.meta!.eventId!, /^event_[0-9a-f]{16}$/);

		const evd = await memoryEvidenceForEvent(cwd, scope, eventHit!.meta!.eventId!);
		assert.ok(evd.length >= 1, "应沿事件取回归档证据");
		assert.match(evd[0]!.text, /讨债|递|伞/, "证据块应含原文细节");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("rp-memory: 事件→证据 无事件卡时不产出证据", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-rpmem-noevent-"));
	try {
		enableMemory(cwd);
		const narrative = "某条没有事件卡的早期剧情，这里只有一段普通日常。";
		await memoryArchiveCompacted(cwd, scope, narrative, { sourceRefs: [{ entryId: "entry-9999" }] });
		const evd = await memoryEvidenceForEvent(cwd, scope, "event_nonexistent");
		assert.equal(evd.length, 0);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("rp-memory: 分级保活 core/major 不被自动淘汰", () => {
	const mk = (id: string, importance: MemoryImportance, createdAt: string): MemoryChunk => ({
		id,
		text: `chunk-${id}`,
		embedding: [1, 2, 3],
		meta: { kind: "evidence", importance } as MemoryChunkMeta,
		createdAt,
	});
	const chunks: MemoryChunk[] = [
		mk("old-minor", "minor", "1999-01-01"),
		mk("core-first", "core", "1999-01-01"),
		mk("new-major", "major", "2020-05-05"),
		mk("mid-normal", "normal", "2010-01-01"),
		mk("old-major", "major", "2000-01-01"),
		mk("new-minor", "minor", "2025-01-01"),
	];
	const kept = evictByPriority(chunks, 4);
	const ids = new Set(kept.map((c) => c.id));
	// core + 两个 major 一定存活
	assert.ok(ids.has("core-first"), "core 不淘汰");
	assert.ok(ids.has("old-major"), "major 不淘汰");
	assert.ok(ids.has("new-major"), "major 不淘汰");
	// 被淘汰的一定是 normal / minor 里最新的两条
	assert.ok(!ids.has("new-minor"), "最该淘汰的 minor 被弹掉");
	assert.equal(kept.length, 4);
	// 顺序保持原序
	assert.deepEqual(kept.map((c) => c.id), ["core-first", "new-major", "mid-normal", "old-major"]);
	assert.equal(evictionRank(chunks[0]), 1);
	assert.equal(evictionRank(chunks[1]), 3, "证据副本允许淘汰，核心事件卡本身负责保活");
});

test("rp-memory: 摘要提示词初建/增量结构正确 + 回读纪律", () => {
	const initial = buildRpSummaryInitialPrompt({
		conversationText: "第一天，两人在雨中相遇。",
		stateSnapshot: "{\"time\":\"第一天\"}",
		language: "中文",
		userName: "沈舟",
		charName: "云澜",
	});
	assert.match(initial.systemPrompt, /## Story Phase/);
	assert.match(initial.systemPrompt, /## Current Continuity/);
	assert.match(initial.systemPrompt, /## Recall Index/);
	assert.match(initial.systemPrompt, /不续写剧情/);
	assert.ok(initial.userText.includes("<conversation>"));

	const update = buildRpSummaryUpdatePrompt({
		conversationText: "第二天，误会澄清。",
		stateSnapshot: "{\"time\":\"第二天\"}",
		previousSummary: "## Story Phase\n相识\n## Current Continuity\n第一天，雨中。",
		language: "中文",
		userName: "沈舟",
		charName: "云澜",
		newEvents: "event_first_meeting_001：初遇",
	});
	assert.match(update.systemPrompt, /PRESERVE/);
	assert.match(update.systemPrompt, /MOVE/);
	assert.match(update.systemPrompt, /UPDATE/);
	assert.match(update.systemPrompt, /Current Continuity/);
	assert.ok(update.userText.includes("<previous-summary>"));
	assert.ok(update.userText.includes("<new-events>"));

	// 兼容门面：无 previousSummary → 初建；有 → 增量
	const viaInitial = buildRpSummaryPrompt({ conversationText: "x", stateSnapshot: "{}", language: "中文", userName: "u" });
	const viaUpdate = buildRpSummaryPrompt({ conversationText: "x", stateSnapshot: "{}", previousSummary: "old", language: "中文", userName: "u" });
	assert.match(viaInitial.systemPrompt, /## Story Phase/);
	assert.ok(!viaUpdate.userText.includes("<new-events>") || viaUpdate.userText.includes("<previous-summary>"));
	assert.match(viaUpdate.systemPrompt, /PRESERVE/);
});

test("rp-memory: 长期纪要固定结构节齐备", () => {
	for (const section of ["## Story Phase", "## Characters", "## Core Events", "## Promises & Threads", "## Canon Facts", "## Knowledge Boundaries", "## Current Continuity", "## Recall Index"]) {
		assert.ok(RP_SUMMARY_SECTIONS.includes(section), `缺 ${section}`);
	}
});

test("rp-memory: 归档带 sourceRefs 后 meta 携带", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-rpmem-srcref-"));
	try {
		enableMemory(cwd);
		const narrative = "某段足够长的早期剧情原文，至少超过切块下限。";
		await memoryArchiveCompacted(cwd, scope, narrative, { sourceRefs: [{ entryId: "entry-7777", entryType: "message", turn: 7 }] });
		const { loadChunks } = await import("../src/memory/store.ts");
		const chunks = loadChunks(cwd, scope, "narrative");
		assert.ok(chunks.length >= 1);
		assert.equal(chunks[0]!.meta?.kind, "evidence");
		assert.deepEqual(chunks[0]!.meta?.sourceRefs, [{ entryId: "entry-7777", entryType: "message", turn: 7 }]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("rp-memory: 分支可见性过滤只返回当前祖先链上的事件与证据", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-rpmem-branch-"));
	try {
		enableMemory(cwd);
		await memoryUpsertEventDigest(cwd, scope, sampleEvent);
		await memoryArchiveCompacted(cwd, scope, "雨中递伞与身份误会的原文证据。", { sourceRefs: [{ entryId: "entry-0001", entryType: "message", turn: 1 }] });
		const hidden = await memoryRecallForTurn(cwd, scope, "第一次见面 递伞", new Set(["branch-b-entry"]));
		assert.equal(hidden.length, 0, "兄弟分支不得看到父分支有锚点的事件");
		const visible = await memoryRecallForTurn(cwd, scope, "第一次见面 递伞", new Set(["entry-0001"]));
		assert.ok(visible.some((hit) => hit.meta?.kind === "event"));
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("rp-memory: 摘要 envelope 可解析；旧 Markdown 仍兼容；历史触发预判不召回普通拍", () => {
	const parsed = parseRpSummaryEnvelope(JSON.stringify({ version: 2, summaryMarkdown: "## Story Phase\n相识", events: [{ id: "source_meeting", title: "初遇", summary: "递伞", tags: [], recallAnchors: [] }] }));
	assert.equal(parsed.summary, "## Story Phase\n相识");
	assert.equal(parsed.events.length, 1);
	assert.equal(parsed.events[0]!.kind, "rp-event-digest");
	assert.equal(parseRpSummaryEnvelope("## Story Phase\n旧格式").summary, "## Story Phase\n旧格式");
	assert.equal(shouldRecallHistory("今天放学后去体育馆。"), false);
	assert.equal(shouldRecallHistory("你还记得我们第一次见面吗？"), true);
	assert.equal(sideTextTimeoutMs("memoryEvents"), 60_000);
	assert.equal(sideTextTimeoutMs("compaction"), 120_000);
	assert.equal(sideTextRetryLimit("memoryEvents"), 1);
});
