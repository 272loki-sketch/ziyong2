import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { memoryArchiveCompacted, memoryRecallForTurn, memoryUpsertEventDigest, updateMemoryConfig, updateStoreConfig } from "../src/memory/service.ts";
import type { RpEventDigest } from "../src/memory/types.ts";

test("rp-memory 1000-floor simulation: core event remains recallable after normal evidence churn", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-rpmem-1000-"));
	const scope = { sessionId: "long-session", card: "cards/hero.png" };
	try {
		updateMemoryConfig(cwd, { enabled: true, injectOnTurn: true, embedMode: "local", searchTopK: 5 });
		updateStoreConfig(cwd, "narrative", { maxChunks: 200 });
		const firstMeeting: RpEventDigest = {
			kind: "rp-event-digest",
			id: "source_first_meeting",
			sourceKey: "source_first_meeting",
			status: "active",
			importance: "core",
			title: "男女主初次相遇",
			tags: ["初遇", "递伞", "误会"],
			recallAnchors: ["第一次见面", "那把伞", "当年雨天"],
			summary: "男主在雨中递伞，女主误认其为催债人。",
			evidenceLevel: "source-backed",
			sourceRefs: [{ entryId: "entry-turn-1", entryType: "message", turn: 1 }],
		};
		await memoryUpsertEventDigest(cwd, scope, firstMeeting);
		await memoryArchiveCompacted(cwd, scope, "雨里他把伞递给她。她却误以为他是催债人，转身离开。", {
			sourceRefs: [{ entryId: "entry-turn-1", entryType: "message", turn: 1 }],
		});
		const earlyHits = await memoryRecallForTurn(cwd, scope, "第一次见面 那把伞 催债人", new Set(["entry-turn-1"]));
		assert.ok(earlyHits.some((hit) => hit.meta?.kind === "evidence"), "证据缓存初始可召回");

		for (let turn = 2; turn <= 1000; turn++) {
			await memoryArchiveCompacted(cwd, scope, `第${turn}楼的普通日常：两人讨论课程、天气与晚餐安排。`, {
				sourceRefs: [{ entryId: `entry-turn-${turn}`, entryType: "message", turn }],
			});
		}

		const hits = await memoryRecallForTurn(cwd, scope, "第一次见面 那把伞 催债人", new Set(["entry-turn-1"]));
		assert.ok(hits.some((hit) => hit.meta?.kind === "event"), "1000楼后仍能命中初遇事件卡");
		// evidence 是可淘汰的缓存；真实台上命中事件后由 sourceRefs 回 Session Tree 取回原文。

		const hidden = await memoryRecallForTurn(cwd, scope, "第一次见面 那把伞", new Set(["entry-turn-1000"]));
		assert.equal(hidden.length, 0, "兄弟分支/不可见来源不得召回初遇证据");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
