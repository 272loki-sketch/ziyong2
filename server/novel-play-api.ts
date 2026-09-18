import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { RestHost } from "./rest.ts";
import { buildPackage, createOpeningProposal, startFromConfirmedProposal, startOptions, type NovelPlayModelHost, type PreviewPublicDto } from "../src/novel-play/application.ts";
import type { NovelAnchor } from "../src/novel-play/canon.ts";
import type { NovelOpeningProposal } from "../src/novel-play/opening.ts";
import type { StoredNovelPackage } from "../src/novel-play/store.ts";

const MAX_BODY = 64 * 1024;
const MAX_JOBS = 2;
const JOB_TTL_MS = 30 * 60_000;
const TOKEN_TTL_MS = 10 * 60_000;

type JobState = "queued" | "running" | "succeeded" | "failed" | "cancelled";
interface Job { id: string; docId: string; state: JobState; createdAt: number; updatedAt: number; controller: AbortController; result?: unknown; error?: string }
interface Preview { token: string; expiresAt: number; used: boolean; stored: StoredNovelPackage; anchor: NovelAnchor; proposal: NovelOpeningProposal }
interface InstanceState { jobs: Map<string, Job>; previews: Map<string, Preview>; starting: boolean }

const instances = new WeakMap<object, InstanceState>();
const stateFor = (host: object): InstanceState => {
	let state = instances.get(host);
	if (!state) { state = { jobs: new Map(), previews: new Map(), starting: false }; instances.set(host, state); }
	return state;
};

const send = (res: ServerResponse, code: number, body: unknown): void => {
	res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(JSON.stringify(body));
};

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
	let size = 0;
	const chunks: Buffer[] = [];
	for await (const value of req) {
		const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
		size += chunk.length;
		if (size > MAX_BODY) throw Object.assign(new Error("请求体过大"), { statusCode: 413 });
		chunks.push(chunk);
	}
	if (!chunks.length) return {};
	const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("请求体必须是 JSON 对象");
	return parsed as Record<string, unknown>;
}

const text = (value: unknown, name: string, max = 500): string => {
	if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${name} 无效`);
	return value.trim();
};
const dto = (job: Job) => ({ id: job.id, docId: job.docId, status: job.state, createdAt: new Date(job.createdAt).toISOString(), updatedAt: new Date(job.updatedAt).toISOString(), ...(job.result ? { result: job.result } : {}), ...(job.error ? { error: job.error } : {}) });

function prune(state: InstanceState): void {
	const now = Date.now();
	for (const [id, job] of state.jobs) if (["succeeded", "failed", "cancelled"].includes(job.state) && now - job.updatedAt > JOB_TTL_MS) state.jobs.delete(id);
	for (const [token, preview] of state.previews) if (preview.used || preview.expiresAt <= now) state.previews.delete(token);
}

function tokenEqual(a: string, b: string): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
}

export async function handleNovelPlayApiRequest(req: IncomingMessage, res: ServerResponse, host: RestHost): Promise<boolean> {
	const pathname = (req.url ?? "/").split("?")[0];
	if (!pathname.startsWith("/api/novel-play/")) return false;
	const route = `${req.method} ${pathname}`;
	const query = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
	const instance = stateFor(host);
	prune(instance);
	try {
		if (route === "POST /api/novel-play/build") {
			const input = await body(req);
			const docId = text(input.docId, "docId", 200);
			const active = [...instance.jobs.values()].filter((job) => job.state === "queued" || job.state === "running");
			if (active.some((job) => job.docId === docId)) throw Object.assign(new Error("该小说已在构建中"), { statusCode: 409 });
			if (active.length >= MAX_JOBS) throw Object.assign(new Error("小说构建队列已满"), { statusCode: 429 });
			const now = Date.now();
			const job: Job = { id: randomBytes(16).toString("hex"), docId, state: "queued", createdAt: now, updatedAt: now, controller: new AbortController() };
			instance.jobs.set(job.id, job);
			void Promise.resolve().then(async () => {
				job.state = "running"; job.updatedAt = Date.now();
				try { job.result = await buildPackage(host as NovelPlayModelHost, docId, job.controller.signal); job.state = "succeeded"; }
				catch (error) { job.state = job.controller.signal.aborted ? "cancelled" : "failed"; job.error = error instanceof Error ? error.message : String(error); }
				job.updatedAt = Date.now();
			});
			send(res, 202, { job: dto(job) }); return true;
		}
		if (route === "GET /api/novel-play/status") {
			send(res, 200, { jobs: [...instance.jobs.values()].sort((a, b) => b.createdAt - a.createdAt).map(dto) }); return true;
		}
		const statusRoute = /^GET \/api\/novel-play\/status\/([a-f0-9]{32})$/.exec(route);
		if (statusRoute) { const job = instance.jobs.get(statusRoute[1]); if (!job) throw Object.assign(new Error("构建任务不存在"), { statusCode: 404 }); send(res, 200, { job: dto(job) }); return true; }
		const cancelRoute = /^DELETE \/api\/novel-play\/status\/([a-f0-9]{32})$/.exec(route);
		if (cancelRoute) {
			const job = instance.jobs.get(cancelRoute[1]);
			if (!job) throw Object.assign(new Error("构建任务不存在"), { statusCode: 404 });
			if (job.state === "queued" || job.state === "running") { job.controller.abort(); job.state = "cancelled"; job.updatedAt = Date.now(); }
			send(res, 200, { job: dto(job) }); return true;
		}
		if (route === "GET /api/novel-play/start") {
			const docId = text(query.get("docId"), "docId", 200);
			const revision = text(query.get("revision"), "revision", 128);
			send(res, 200, { package: startOptions(host as NovelPlayModelHost, docId, revision) }); return true;
		}
		if (route === "POST /api/novel-play/preview") {
			const input = await body(req);
			const player = input.player as Record<string, unknown> | undefined;
			const position = input.position;
			if (position !== "before" && position !== "after") throw new Error("position 无效");
			const generated = await createOpeningProposal(host as NovelPlayModelHost, {
				docId: text(input.docId, "docId", 200), revision: text(input.revision, "revision", 128), nodeId: text(input.nodeId, "nodeId", 200), position,
				player: { name: text(player?.name, "player.name", 120), identity: text(player?.identity, "player.identity", 1500) },
			}, (req as { signal?: AbortSignal }).signal);
			const token = randomBytes(32).toString("base64url");
			const preview: Preview = { token, expiresAt: Date.now() + TOKEN_TTL_MS, used: false, ...generated };
			instance.previews.set(token, preview);
			const output: PreviewPublicDto = { token, expiresAt: new Date(preview.expiresAt).toISOString(), package: { docId: generated.stored.package.docId, revision: generated.stored.package.revision }, anchor: generated.anchor, draft: generated.proposal.draft };
			send(res, 200, { preview: output }); return true;
		}
		if (route === "POST /api/novel-play/start") {
			if (host.isStreaming()) throw Object.assign(new Error("正在生成回复，请稍候再开演"), { statusCode: 409 });
			if (instance.starting) throw Object.assign(new Error("小说开演正在启动"), { statusCode: 409 });
			const input = await body(req);
			const requested = text(input.previewToken, "previewToken", 200);
			const preview = [...instance.previews.values()].find((item) => tokenEqual(item.token, requested));
			if (!preview || preview.used || preview.expiresAt <= Date.now()) throw Object.assign(new Error("预览令牌无效或已过期"), { statusCode: 409 });
			instance.starting = true;
			try {
				const result = await startFromConfirmedProposal(host as NovelPlayModelHost, preview);
				preview.used = true;
				send(res, 201, { started: result }); return true;
			} finally { instance.starting = false; }
		}
		send(res, 404, { error: `未知接口：${route}` }); return true;
	} catch (error) {
		const status = typeof (error as { statusCode?: unknown }).statusCode === "number" ? (error as { statusCode: number }).statusCode : 400;
		send(res, status, { error: error instanceof Error ? error.message : String(error) }); return true;
	}
}
