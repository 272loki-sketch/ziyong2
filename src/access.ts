/**
 * 访问密码（Web 登录）：scrypt 加盐哈希 + 持久化会话 token（零 pi 依赖）。
 *
 * 只有访问文件不存在才表示未设置密码。损坏或不可读的文件必须阻止启动，
 * 不能降级成开放访问。写入先原子发布到磁盘，再更新调用方的内存令牌。
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const ACCESS_COOKIE = "liyuan_access";
const MAX_TOKENS = 20;

export interface AccessToken {
	id: string;
	createdAt: number;
}

export interface AccessData {
	salt: string;
	hash: string;
	tokens: AccessToken[];
}

function accessPath(cwd: string): string {
	return join(cwd, ".liyuan", "access.json");
}

export function loadAccess(cwd: string): AccessData | null {
	let text: string;
	try {
		text = readFileSync(accessPath(cwd), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw new Error("无法读取访问密码配置；为避免开放访问，已拒绝启动。请检查 .liyuan/access.json。", { cause: error });
	}
	try {
		const raw: unknown = JSON.parse(text);
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid access data");
		const value = raw as Record<string, unknown>;
		if (typeof value.salt !== "string" || !/^[a-f0-9]{32}$/i.test(value.salt)
			|| typeof value.hash !== "string" || !/^[a-f0-9]{128}$/i.test(value.hash)) {
			throw new Error("invalid password hash or salt");
		}
		// A damaged token is not an authenticated session. Keep valid password data
		// so the maintainer can sign in again rather than opening the instance.
		const tokens = Array.isArray(value.tokens)
			? value.tokens.filter((item): item is AccessToken => {
				if (!item || typeof item !== "object") return false;
				const token = item as Record<string, unknown>;
				return typeof token.id === "string" && /^[a-f0-9]{64}$/i.test(token.id)
					&& typeof token.createdAt === "number" && Number.isFinite(token.createdAt);
			}).slice(-MAX_TOKENS)
			: [];
		return { salt: value.salt, hash: value.hash, tokens };
	} catch (error) {
		throw new Error("访问密码配置损坏；为避免开放访问，已拒绝启动。请从可信备份恢复 .liyuan/access.json。", { cause: error });
	}
}

function save(cwd: string, data: AccessData): void {
	mkdirSync(join(cwd, ".liyuan"), { recursive: true });
	const target = accessPath(cwd);
	const temporary = `${target}.${randomBytes(16).toString("hex")}.tmp`;
	try {
		writeFileSync(temporary, JSON.stringify(data, null, "\t"), {
			encoding: "utf8", flag: "wx", mode: 0o600, flush: true,
		});
		renameSync(temporary, target);
	} finally {
		// Cleanup must not hide the original write/rename failure.
		try { rmSync(temporary, { force: true }); } catch { /* best effort */ }
	}
}

function hashPassword(password: string, salt: string): string {
	return scryptSync(password, salt, 64).toString("hex");
}

/** 设置/修改密码：清空旧 token，持久化成功后返回新 token。 */
export function setPassword(cwd: string, password: string): { data: AccessData; token: string } {
	const salt = randomBytes(16).toString("hex");
	const token = randomBytes(32).toString("hex");
	const data: AccessData = { salt, hash: hashPassword(password, salt), tokens: [{ id: token, createdAt: Date.now() }] };
	save(cwd, data);
	return { data, token };
}

/** 关闭密码：仅不存在的文件可忽略；删除失败必须向调用方报告。 */
export function clearPassword(cwd: string): void {
	rmSync(accessPath(cwd), { force: true });
}

export function verifyPassword(data: AccessData, password: string): boolean {
	const a = Buffer.from(hashPassword(password, data.salt), "hex");
	const b = Buffer.from(data.hash, "hex");
	return a.length === b.length && timingSafeEqual(a, b);
}

/** 登录成功后签发新 token，FIFO 上限 20；写盘失败时不改变内存。 */
export function issueToken(cwd: string, data: AccessData): string {
	const token = randomBytes(32).toString("hex");
	const tokens = [...data.tokens, { id: token, createdAt: Date.now() }].slice(-MAX_TOKENS);
	save(cwd, { ...data, tokens });
	data.tokens = tokens;
	return token;
}

export function verifyToken(data: AccessData, token: string | undefined): boolean {
	if (!token) return false;
	const t = Buffer.from(token);
	let ok = false;
	for (const item of data.tokens) {
		const id = Buffer.from(item.id);
		if (id.length === t.length && timingSafeEqual(id, t)) ok = true;
	}
	return ok;
}

/** 注销：持久化成功后吊销内存中的单个 token。 */
export function revokeToken(cwd: string, data: AccessData, token: string | undefined): void {
	if (!token) return;
	const tokens = data.tokens.filter((t) => t.id !== token);
	if (tokens.length === data.tokens.length) return;
	save(cwd, { ...data, tokens });
	data.tokens = tokens;
}

/** 解析 Cookie 请求头。 */
export function parseCookies(header: string | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	if (!header) return out;
	for (const part of header.split(";")) {
		const i = part.indexOf("=");
		if (i > 0) {
			try {
				out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
			} catch {
				/* 非法编码的杂项 cookie 忽略 */
			}
		}
	}
	return out;
}
