import assert from "node:assert/strict";
import test from "node:test";
import { buildNovelPackage } from "../src/novel-play/canon.ts";
import { novelNodeId, type NovelSource } from "../src/novel-play/source.ts";
import { commitNovelPlayState, novelPlayStateFromBranch, prepareNovelPlayTurn } from "../src/novel-play/runtime.ts";

const source: NovelSource = { version: 1, docId: "book", title: "Book", fingerprint: "fp", chunkChars: 100, chunks: [{ index: 0, chars: 16, chapters: ["c"], text: "Alpha Beta Gamma" }] };
const ref = (start: number, end: number) => ({ chunkIndex: 0, start, end, quote: source.chunks[0]!.text.slice(start, end) });
const a = novelNodeId(source, ref(0, 5), "a"), b = novelNodeId(source, ref(6, 10), "b"), c = novelNodeId(source, ref(11, 16), "c");
const pkg = buildNovelPackage(source, [{ id: "s", order: 0, title: "Stage" }], [
	{ id: a, key: "a", stageId: "s", order: 0, title: "A", summary: "A happens", visibility: "public", dependsOn: [], sourceRefs: [ref(0, 5)] },
	{ id: b, key: "b", stageId: "s", order: 1, title: "B", summary: "B happens", visibility: "public", dependsOn: [a], sourceRefs: [ref(6, 10)] },
	{ id: c, key: "c", stageId: "s", order: 2, title: "C", summary: "secret", visibility: "secret", dependsOn: [], sourceRefs: [ref(11, 16)] },
]);
const rawCard = { data: { extensions: { liyuanNovelPlay: { docId: "book", revision: pkg.revision, startNodeId: a, position: "before" } } } };
const loadPackage = () => ({ version: 1 as const, source, package: pkg });
const branch = [{ id: "root", type: "custom_message", customType: "rp-greeting", content: "start" }, { id: "u1", type: "user", message: { role: "user", content: [{ type: "text", text: "change it" }] } }];

const prepare = (result: unknown, overrides: Partial<Parameters<typeof prepareNovelPlayTurn>[0]> = {}) => prepareNovelPlayTurn({
	cwd: "/unused", rawCard, branch, expectedLeafId: "u1", skillBody: "strict", getLeafId: () => "u1", loadPackage,
	modelCall: async (_system, user) => { assert.doesNotMatch(user, /Alpha Beta Gamma/); return JSON.stringify(result); }, ...overrides,
});

test("current branch facts take precedence and causally block canon candidates", async () => {
	const prepared = await prepare({ version: 1, progress: { packageRevision: pkg.revision, nodeId: a, position: "before" }, conflicts: [{ packageRevision: pkg.revision, nodeId: a, sourceEntryIds: ["u1"] }] });
	assert.deepEqual(prepared?.projection.candidates, []);
	assert.deepEqual(new Set(prepared?.projection.blockedNodeIds), new Set([a, b]));
});

test("public same-stage candidates are bounded from the explicit current anchor", async () => {
	const prepared = await prepare({ version: 1, progress: { packageRevision: pkg.revision, nodeId: a, position: "after" }, conflicts: [] });
	assert.deepEqual(prepared?.projection.candidates.map(item => item.nodeId), [b]);
	assert.equal(prepared?.projection.candidates[0]?.actuality, "candidate");
});

test("cross-save state is accepted only when card, revision and branch evidence match", async () => {
	const prepared = await prepare({ version: 1, progress: { packageRevision: pkg.revision, nodeId: a, position: "before" }, conflicts: [] });
	const stateEntry = { id: "state", type: "custom", customType: "rp-novel-play", data: prepared!.state };
	assert.ok(novelPlayStateFromBranch([...branch, stateEntry], prepared!.state.card, pkg));
	assert.equal(novelPlayStateFromBranch([{ ...branch[0]!, id: "other" }, stateEntry], prepared!.state.card, pkg), undefined);
});

test("model failure and invalid cross-branch evidence suppress candidates", async () => {
	assert.equal(await prepare({}, { modelCall: async () => undefined }), undefined);
	assert.equal(await prepare({ version: 1, progress: { packageRevision: pkg.revision, nodeId: a, position: "before" }, conflicts: [{ packageRevision: pkg.revision, nodeId: a, sourceEntryIds: ["other-save"] }] }), undefined);
});

test("leaf race guard suppresses preparation and persistence", async () => {
	let leaf = "u1";
	const prepared = await prepare({ version: 1, progress: { packageRevision: pkg.revision, nodeId: a, position: "before" }, conflicts: [] }, { modelCall: async () => { leaf = "other"; return "{}"; }, getLeafId: () => leaf });
	assert.equal(prepared, undefined);
	let writes = 0;
	assert.equal(commitNovelPlayState({ prepared: undefined, expectedLeafId: "u1", getLeafId: () => "other", appendCustomEntry: () => { writes++; return "x"; } }), undefined);
	assert.equal(writes, 0);
});

test("reroll reuses prepared projection without a second model call or state write", async () => {
	let calls = 0;
	const prepared = await prepareNovelPlayTurn({ cwd: "/unused", rawCard, branch, expectedLeafId: "u1", skillBody: "strict", getLeafId: () => "u1", loadPackage, modelCall: async () => { calls++; return JSON.stringify({ version: 1, progress: { packageRevision: pkg.revision, nodeId: a, position: "before" }, conflicts: [] }); } });
	const rerollPrep = prepared?.projection;
	assert.ok(rerollPrep);
	assert.equal(calls, 1);
	let writes = 0;
	commitNovelPlayState({ prepared: undefined, expectedLeafId: "assistant-reroll", getLeafId: () => "assistant-reroll", appendCustomEntry: () => { writes++; return "x"; } });
	assert.equal(writes, 0);
});
