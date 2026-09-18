import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { __internalStateFsOps, defaultState, loadState, saveState } from "../src/state.ts";

function restoreStateFsOps(original: typeof __internalStateFsOps): void {
	Object.assign(__internalStateFsOps, original);
}

test("saveState 原子发布：roundtrip、同目录随机 tmp、wx/0600、flush、成功后无 tmp", () => {
	const dir = mkdtempSync(join(tmpdir(), "rp-state-atomic-"));
	const original = { ...__internalStateFsOps };
	try {
		const file = join(dir, "deep", "s.json");
		const state = { ...defaultState(), time: "午夜", plot_threads: ["寻找失踪的商队"] };
		let openedPath = "";
		let openedFlags: string | number | undefined;
		let openedMode: number | undefined;
		let flushes = 0;
		__internalStateFsOps.randomBytes = () => Buffer.from("0102030405060708", "hex");
		__internalStateFsOps.openSync = (path, flags, mode) => {
			openedPath = String(path);
			openedFlags = flags;
			openedMode = mode;
			return original.openSync(path, flags, mode);
		};
		__internalStateFsOps.fsyncSync = (fd) => {
			flushes += 1;
			return original.fsyncSync(fd);
		};

		saveState(file, state);

		assert.deepEqual(loadState(file), state);
		assert.equal(dirname(openedPath), dirname(file));
		assert.notEqual(openedPath, file);
		assert.equal(openedFlags, "wx");
		assert.equal(openedMode, 0o600);
		assert.equal(flushes, 1);
		assert.deepEqual(readdirSync(dirname(file)), ["s.json"]);
	} finally {
		restoreStateFsOps(original);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("saveState 失败时保留旧文件并清理 tmp", () => {
	const dir = mkdtempSync(join(tmpdir(), "rp-state-atomic-fail-"));
	const original = { ...__internalStateFsOps };
	try {
		const file = join(dir, "deep", "s.json");
		const oldState = { ...defaultState(), time: "黄昏", location: "林间小屋" };
		const nextState = { ...oldState, time: "午夜" };
		saveState(file, oldState);
		__internalStateFsOps.randomBytes = () => Buffer.from("0a0b0c0d0e0f1011", "hex");
		__internalStateFsOps.renameSync = () => {
			throw new Error("rename failed");
		};

		assert.throws(() => saveState(file, nextState), /rename failed/);
		assert.deepEqual(loadState(file), oldState);
		assert.deepEqual(readdirSync(dirname(file)), ["s.json"]);
	} finally {
		restoreStateFsOps(original);
		rmSync(dir, { recursive: true, force: true });
	}
});
