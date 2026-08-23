import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { projectOutline } from "../src/outline/projection.ts";
import { parseOutlineProposal } from "../src/outline/runtime.ts";
import type { OutlineForeshadowing, OutlineNode, OutlineProposal, OutlineSource, OutlineState } from "../src/outline/schema.ts";
import { defaultOutlineState, normalizeOutlineState, outlineHistoryFromBranch } from "../src/outline/state.ts";
import { commitOutlineProposal, validateOutlineProposal } from "../src/outline/validation.ts";

const node = (id: string, overrides: Partial<OutlineNode> = {}): OutlineNode => ({ id, title: id, summary: "", status: "active", rigidity: "soft", visibility: "spoiler", actuality: "plan", sourceRefs: [], dependsOn: [], ...overrides });
const proposal = (state: OutlineState, patch: OutlineProposal["patch"], mode: OutlineProposal["mode"] = "manual"): OutlineProposal => ({ version: 1, id: "p1", mode, baseRevision: state.revision, baseHash: state.hash, baseLeafId: "leaf", kind: "reconcile", patch, rationale: "test", researchInspirationIds: [], proposalHash: "a".repeat(64) });
const committedSource: OutlineSource = { id: "branch:n1", kind: "narrative", title: "n1", locator: "n1", note: "trusted" };
const confirmation = { proposalHash: "a".repeat(64), baseLeafId: "leaf" };

test("strict runtime parser rejects malformed and unknown model input without throwing", () => {
	assert.doesNotThrow(() => parseOutlineProposal({ version: 1, patch: { collections: [{ collection: "unknown" }] } }, { modelInput: true }));
	assert.equal(parseOutlineProposal({ version: 1, patch: { collections: [{ collection: "unknown" }] } }, { modelInput: true }), null);
	assert.equal(normalizeOutlineState({ version: 2 }), null);
	const base = defaultOutlineState();
	assert.doesNotThrow(() => validateOutlineProposal(base, proposal(base, { collections: [{ collection: "constraints", upsert: [node("bad-ref", { actuality: "established", sourceRefs: ["missing"] })] }] })));
});

test("outline commit strictly normalizes and verifies hash roundtrip", () => {
	const base = defaultOutlineState();
	const state = commitOutlineProposal(base, proposal(base, { premise: "一次远行" }), { confirmation }).state!;
	assert.equal(state.revision, 1);
	assert.deepEqual(normalizeOutlineState(state, { verifyHash: true }), state);
});

test("branch history requires revision one/default parent and stops after a bad snapshot", () => {
	const base = defaultOutlineState(), first = commitOutlineProposal(base, proposal(base, { premise: "第一版" }), { confirmation }).state!;
	const badFirst = { ...first, revision: 2 };
	const rejected = outlineHistoryFromBranch([{ type: "custom", customType: "rp-outline", data: badFirst }]);
	assert.equal(rejected.history.length, 0);
	const later = commitOutlineProposal(first, proposal(first, { currentFocus: [] })).state!;
	const recovered = outlineHistoryFromBranch([{ type: "custom", customType: "rp-outline", data: first }, { type: "custom", customType: "rp-outline", data: { ...later, hash: "b".repeat(64) } }, { type: "custom", customType: "rp-outline", data: later }]);
	assert.equal(recovered.current.revision, 1);
	assert.equal(recovered.invalidEntries, 2);
});

test("forged evidence and model-added narrative sources are rejected", () => {
	const base = defaultOutlineState();
	const established = node("fact", { actuality: "established", sourceRefs: [committedSource.id] });
	const forged = validateOutlineProposal(base, proposal(base, { addSources: [committedSource], collections: [{ collection: "constraints", upsert: [established] }] }));
	assert.match(forged.audit.issues.map((row) => row.code).join(), /source-forgery|plan-promoted-to-fact/);
	const trusted = validateOutlineProposal(base, proposal(base, { addSources: [committedSource], collections: [{ collection: "constraints", upsert: [established] }] }), { trustedSourceIds: new Set([committedSource.id]), confirmation });
	assert.equal(trusted.audit.verdict, "approve");
});

test("hard constraints cannot be downgraded then deleted", () => {
	const base = defaultOutlineState();
	const seeded = commitOutlineProposal(base, proposal(base, { collections: [{ collection: "constraints", upsert: [node("hard", { rigidity: "hard" })] }] }), { confirmation }).state!;
	const downgrade = commitOutlineProposal(seeded, proposal(seeded, { collections: [{ collection: "constraints", upsert: [node("hard", { rigidity: "soft" })] }] }), { confirmation });
	assert.match(downgrade.audit.issues.map((row) => row.code).join(), /hard-constraint-downgrade/);
	const deletion = commitOutlineProposal(seeded, proposal(seeded, { collections: [{ collection: "constraints", deleteIds: ["hard"] }] }), { confirmation });
	assert.match(deletion.audit.issues.map((row) => row.code).join(), /hard-constraint-deletion/);
});

test("terminal nodes and foreshadowing status cannot regress or skip", () => {
	const base = defaultOutlineState();
	const fulfilled = node("done", { status: "fulfilled", actuality: "established", sourceRefs: [committedSource.id] });
	const conceived: OutlineForeshadowing = { ...node("f1"), foreshadowingStatus: "conceived", setup: "钟声", payoff: "秘密", evidenceRefs: [] };
	const seeded = commitOutlineProposal(base, proposal(base, { addSources: [committedSource], collections: [{ collection: "threads", upsert: [{ ...fulfilled, question: "?", nextPressure: "" }] }, { collection: "foreshadowing", upsert: [conceived] }] }), { trustedSourceIds: new Set([committedSource.id]), confirmation }).state!;
	const reopened = commitOutlineProposal(seeded, proposal(seeded, { collections: [{ collection: "threads", upsert: [{ ...node("done"), question: "?", nextPressure: "" }] }] }), { trustedSourceIds: new Set([committedSource.id]), confirmation });
	assert.match(reopened.audit.issues.map((row) => row.code).join(), /invalid-status-transition/);
	const skipped = commitOutlineProposal(seeded, proposal(seeded, { collections: [{ collection: "foreshadowing", upsert: [{ ...conceived, foreshadowingStatus: "resolved", evidenceRefs: [committedSource.id] }] }] }), { trustedSourceIds: new Set([committedSource.id]), confirmation });
	assert.match(skipped.audit.issues.map((row) => row.code).join(), /invalid-status-transition/);
});

test("automatic high risk is rejected and manual confirmation must be bound", () => {
	const base = defaultOutlineState();
	assert.match(commitOutlineProposal(base, proposal(base, { premise: "new" })).audit.issues.map((row) => row.code).join(), /confirmation-required/);
	assert.match(commitOutlineProposal(base, proposal(base, { premise: "new" }, "automatic")).audit.issues.map((row) => row.code).join(), /automatic-high-risk/);
	assert.ok(commitOutlineProposal(base, proposal(base, { premise: "new" }), { confirmation }).state);
});

test("safe projections isolate premise, secrets, payoff, and world guidance", () => {
	const base = defaultOutlineState();
	const secret: OutlineForeshadowing = { ...node("secret", { visibility: "secret" }), foreshadowingStatus: "conceived", setup: "表层", payoff: "绝密回收", evidenceRefs: [] };
	const visible: OutlineForeshadowing = { ...node("visible", { visibility: "public" }), foreshadowingStatus: "conceived", setup: "表层", payoff: "公开回收", evidenceRefs: [] };
	const seeded = commitOutlineProposal(base, proposal(base, { premise: "秘密前提", collections: [{ collection: "foreshadowing", upsert: [secret, visible] }] }), { confirmation }).state!;
	for (const consumer of ["public", "writer", "director", "continuity"] as const) assert.equal(JSON.stringify(projectOutline(seeded, consumer)).includes("回收"), false);
	assert.equal(projectOutline(seeded, "continuity").collections.foreshadowing?.[0]?.foreshadowingStatus, undefined);
	assert.equal(projectOutline(seeded, "public").premise, "");
	assert.equal(JSON.stringify(projectOutline(seeded, "public")).includes("secret"), false);
	assert.deepEqual(projectOutline(seeded, "world").collections, {});
	assert.equal(projectOutline(seeded, "ecology").nonFactGuidance, true);
});

test("all five outline Skill examples use the parseable collection patch contract", () => {
	for (const name of ["故事编剧室", "动态大纲规划", "剧情自动校准", "伏笔编织", "大纲转移审计"]) {
		const body = readFileSync(new URL(`../skills/${name}/SKILL.md`, import.meta.url), "utf8");
		assert.equal(body.includes('"operations"'), false, name);
		assert.match(body, /"patch"\s*:/, name);
		assert.match(body, /"collections"\s*:/, name);
		const examples = [...body.matchAll(/```json\s*([\s\S]*?)```/g)].map((match) => JSON.parse(match[1]!).proposal ?? JSON.parse(match[1]!));
		const example = examples.find((value) => value?.patch);
		assert.ok(example && parseOutlineProposal(example, { modelInput: true }), `${name} proposal example must parse`);
	}
});
