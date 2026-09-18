import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { __panelFsOps, loadPanels, savePanels, writePanel, type PanelMap } from "../src/panels.ts";

test("savePanels：原子写往返；成功后不残留 tmp", () => {
	const dir = mkdtempSync(join(tmpdir(), "rp-panels-atomic-"));
	try {
		const file = join(dir, "panels.json");
		let panels: PanelMap = {};
		for (const name of ["地图", "装备库", "线索板"]) {
			const r = writePanel(panels, { name, kind: "markdown", content: name });
			assert.ok(r.ok);
			panels = r.panels;
		}

		savePanels(file, panels);

		assert.deepEqual(
			Object.keys(loadPanels(file)),
			["地图", "装备库", "线索板"],
			"JSON 往返仍保序",
		);
		assert.deepEqual(readdirSync(dir), ["panels.json"], "成功后不残留临时文件");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("savePanels：rename 失败时保留旧文件；不残留 tmp；不破坏其他文件", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "rp-panels-atomic-"));
	try {
		const file = join(dir, "panels.json");
		const keep = join(dir, "keep.txt");
		const original: PanelMap = {
			旧地图: { name: "旧地图", kind: "markdown", content: "old", updatedAt: 1 },
		};
		savePanels(file, original);
		writeFileSync(keep, "KEEP", "utf8");

		t.mock.method(__panelFsOps, "renameSync", () => {
			throw new Error("rename failed");
		});

		const next = writePanel({}, { name: "新地图", kind: "markdown", content: "new" });
		assert.ok(next.ok);
		assert.throws(() => savePanels(file, next.panels), /rename failed/);

		assert.deepEqual(loadPanels(file), original, "失败后保留旧文件");
		assert.equal(readFileSync(keep, "utf8"), "KEEP", "不破坏其他文件");
		assert.deepEqual(readdirSync(dir).sort(), ["keep.txt", "panels.json"], "失败后不残留临时文件");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
