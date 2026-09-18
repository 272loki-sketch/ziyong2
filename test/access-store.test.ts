import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearPassword, issueToken, loadAccess, revokeToken, setPassword, verifyPassword, verifyToken } from "../src/access.ts";

function fixture(t: { after: (fn: () => void) => void }): string {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-access-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	return cwd;
}

function accessFile(cwd: string): string { return join(cwd, ".liyuan", "access.json"); }

test("only a missing access file represents open access", (t) => {
	const cwd = fixture(t);
	assert.equal(loadAccess(cwd), null);
	mkdirSync(join(cwd, ".liyuan"));
	for (const value of ["", "{", "null", "[]", "{}", '{"salt":"x","hash":"y"}']) {
		writeFileSync(accessFile(cwd), value);
		assert.throws(() => loadAccess(cwd), /拒绝启动/);
	}
	rmSync(accessFile(cwd));
	mkdirSync(accessFile(cwd));
	assert.throws(() => loadAccess(cwd), /拒绝启动/);
});

test("password and token round-trip, rotation, revocation and atomic file permissions", (t) => {
	const cwd = fixture(t);
	const first = setPassword(cwd, "test password only");
	assert.ok(verifyPassword(loadAccess(cwd)!, "test password only"));
	assert.equal(verifyPassword(first.data, "wrong"), false);
	assert.ok(verifyToken(loadAccess(cwd)!, first.token));
	const secondToken = issueToken(cwd, first.data);
	assert.ok(verifyToken(loadAccess(cwd)!, secondToken));
	revokeToken(cwd, first.data, first.token);
	assert.equal(verifyToken(first.data, first.token), false);
	assert.equal(verifyToken(loadAccess(cwd)!, first.token), false);
	assert.ok(verifyToken(loadAccess(cwd)!, secondToken));
	const rotated = setPassword(cwd, "replacement test password");
	assert.equal(verifyToken(rotated.data, secondToken), false);
	assert.ok(verifyToken(loadAccess(cwd)!, rotated.token));
	assert.deepEqual(readdirSync(join(cwd, ".liyuan")), ["access.json"]);
	if (process.platform !== "win32") assert.equal(statSync(accessFile(cwd)).mode & 0o777, 0o600);
	clearPassword(cwd);
	assert.equal(loadAccess(cwd), null);
	assert.doesNotThrow(() => clearPassword(cwd));
});

test("token writes keep the 20-token FIFO limit", (t) => {
	const cwd = fixture(t);
	const { data, token } = setPassword(cwd, "test password only");
	for (let i = 0; i < 21; i++) issueToken(cwd, data);
	assert.equal(data.tokens.length, 20);
	assert.deepEqual(loadAccess(cwd), data);
	assert.equal(verifyToken(data, token), false);
});

test("invalid token entries do not disable the password gate", (t) => {
	const cwd = fixture(t);
	const { data, token } = setPassword(cwd, "test password only");
	writeFileSync(accessFile(cwd), JSON.stringify({ ...data, tokens: [...data.tokens, null, { id: "bad" }] }));
	const loaded = loadAccess(cwd)!;
	assert.ok(verifyPassword(loaded, "test password only"));
	assert.ok(verifyToken(loaded, token));
	assert.equal(loaded.tokens.length, 1);
});

test("failed token publication leaves the in-memory authorization unchanged", (t) => {
	const cwd = fixture(t);
	const { data, token } = setPassword(cwd, "test password only");
	const before = structuredClone(data);
	const saved = readFileSync(accessFile(cwd), "utf8");
	// A directory at the destination forces rename failure even as root.
	rmSync(accessFile(cwd));
	mkdirSync(accessFile(cwd));
	assert.throws(() => issueToken(cwd, data));
	assert.deepEqual(data, before);
	assert.throws(() => revokeToken(cwd, data, token));
	assert.deepEqual(data, before);
	assert.throws(() => clearPassword(cwd));
	assert.deepEqual(readdirSync(join(cwd, ".liyuan")), ["access.json"]);
	rmSync(accessFile(cwd), { recursive: true });
	writeFileSync(accessFile(cwd), saved);
	assert.deepEqual(loadAccess(cwd), before);
});
