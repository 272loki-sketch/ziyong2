import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { OutlineConflictError, OutlineEngine } from "../src/outline/engine.ts";
import { loadStageMaterials } from "../src/stage/materials.ts";
import type { BranchEntryLike } from "../src/stage/assemble.ts";

class FauxSession {
	entries: BranchEntryLike[] = [{ id: "leaf", type: "custom", customType: "seed", data: {} }];
	getBranch() { return this.entries; }
	getLeafId() { return this.entries.at(-1)?.id ?? null; }
	getSessionId() { return "session"; }
	appendCustomEntry(customType: string, data?: unknown) { const id = `e${this.entries.length}`; this.entries.push({ id, type: "custom", customType, data }); return id; }
	flush() {}
}

test("OutlineEngine chat stores pending and confirm commits proposal then rp-outline", async () => {
	const sm = new FauxSession();
	const engine = new OutlineEngine({
		cwd: new URL("..", import.meta.url).pathname,
		getSessionManager: () => sm,
		loadMaterials: () => loadStageMaterials(new URL("..", import.meta.url).pathname),
		runSideModel: async (step) => step === "outlineAudit"
			? JSON.stringify({ version: 1, verdict: "approve", issues: [], summary: "ok" })
			: JSON.stringify({ answer: "两个方向", options: [{ id: "a" }, { id: "b" }], proposal: { version: 1, id: "p1", mode: "manual", baseRevision: 0, baseHash: engine.getView().state.hash, baseLeafId: "leaf", kind: "chat", rationale: "慢热", researchInspirationIds: [], patch: { premise: "慢热同行" } } }),
	});
	const chat = await engine.chat("想慢一点");
	assert.equal(engine.getView().pending.length, 1);
	assert.equal(engine.getView().chats[0]?.user, "想慢一点");
	await engine.confirm("p1", chat.proposalHash!);
	assert.equal(engine.getView().state.premise, "慢热同行");
	assert.deepEqual(sm.entries.slice(-2).map((row) => row.customType), ["rp-outline-proposal", "rp-outline"]);
});

test("OutlineEngine next-beat discussion persists structured scene advice without forcing proposal", async () => {
	const sm = new FauxSession();
	let requestFocus = "";
	const engine = new OutlineEngine({
		cwd: new URL("..", import.meta.url).pathname,
		getSessionManager: () => sm,
		loadMaterials: () => loadStageMaterials(new URL("..", import.meta.url).pathname),
		runSideModel: async (_step, _system, userText) => {
			requestFocus = JSON.parse(userText).request.focus;
			return JSON.stringify({ answer: "先让对方主动打破沉默。", options: ["安静试探", "外部打断"], sceneAdvice: { recommendedBeat: "以一件眼前小事恢复互动", openingMove: "对方先移动桌上的物件", characterMoves: ["NPC 主动开口"], conversationTargets: [{ character: "图书委员", reason: "此刻正在整理现场，职责提供自然接触理由", openingTopic: "询问借阅登记或归架顺序", risk: "对方可能只想完成工作" }], dialogueCues: ["话题表面日常，实际确认态度"], pressure: "沉默继续会错过窗口", playerSpace: "用户可回应或继续观察", stopPoint: "问题落到用户是否接话", alternatives: ["第三人经过造成短暂打断"], mixedRoute: "先帮忙整理两分钟，再找图书委员确认一本书的去向" }, proposal: null });
		},
	});
	const result = await engine.chat("下一段怎么走", { focus: "next-beat" });
	assert.equal(requestFocus, "next-beat");
	assert.equal(result.sceneAdvice?.recommendedBeat, "以一件眼前小事恢复互动");
	assert.equal(result.sceneAdvice?.conversationTargets[0]?.character, "图书委员");
	assert.equal(engine.getView().pending.length, 0);
	assert.equal(engine.getView().chats[0]?.focus, "next-beat");
	assert.equal(sm.entries.at(-1)?.customType, "rp-outline-chat");
});

test("OutlineEngine rejects stale leaf before model result is stored", async () => {
	const sm = new FauxSession();
	let release!: () => void;
	const wait = new Promise<void>((resolve) => { release = resolve; });
	const engine = new OutlineEngine({ cwd: new URL("..", import.meta.url).pathname, getSessionManager: () => sm, loadMaterials: () => loadStageMaterials(new URL("..", import.meta.url).pathname), runSideModel: async () => { await wait; return JSON.stringify({ answer: "x" }); } });
	const running = engine.chat("愿望");
	sm.appendCustomEntry("other", {}); release();
	await assert.rejects(running, OutlineConflictError);
});

test("OutlineEngine records audit rejection without writing rp-outline", async () => {
	const sm = new FauxSession();
	const engine = new OutlineEngine({
		cwd: new URL("..", import.meta.url).pathname,
		getSessionManager: () => sm,
		loadMaterials: () => loadStageMaterials(new URL("..", import.meta.url).pathname),
		runSideModel: async (step) => step === "outlineAudit"
			? JSON.stringify({ version: 1, verdict: "reject", issues: [], summary: "越过边界" })
			: JSON.stringify({ answer: "方向", proposal: { version: 1, id: "p-reject", mode: "manual", baseRevision: 0, baseHash: engine.getView().state.hash, baseLeafId: "leaf", kind: "chat", rationale: "候选", researchInspirationIds: [], patch: { premise: "候选" } } }),
	});
	const chat = await engine.chat("愿望");
	await assert.rejects(engine.confirm("p-reject", chat.proposalHash!), /越过边界/);
	assert.equal(engine.getView().state.revision, 0);
	assert.equal(sm.entries.at(-1)?.customType, "rp-outline-proposal");
	assert.equal((sm.entries.at(-1)?.data as { status?: string }).status, "rejected");
});

test("outline research store writes only compact source and mechanism JSON", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "outline-engine-"));
	try {
		const sm = new FauxSession();
		const engine = new OutlineEngine({ cwd, getSessionManager: () => sm, loadMaterials: () => ({ config: { card: "private-card", userName: "Private User" }, card: { name: "Private Role" } } as never), runSideModel: async () => "{}", webResearch: async (queries) => {
			assert.ok(queries.every((query) => !query.includes("Private Role") && !query.includes("用户原话")));
			return [{ query: queries[0], results: [{ title: "Narrative pacing", url: "https://example.com/a", snippet: "long copyrighted excerpt that must not be stored" }] }];
		}, getContext: () => ({ cardKey: "private-card" }) });
		const view = await engine.research("用户原话 Private Role");
		assert.equal(view.sources[0]?.url, "https://example.com/a");
		assert.equal(JSON.stringify(view).includes("copyrighted excerpt"), false);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});
