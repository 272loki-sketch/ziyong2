import https from "node:https";
import net from "node:net";
import tls from "node:tls";

import type { CharacterCard } from "../src/types.ts";
import type { WebResearchItem, WebResearchResult } from "../src/tools/web-research.ts";

const DEFAULT_TIMEOUT_MS = 15_000;
let duckChallengeUntil = 0;

export function resolveWebResearchProxy(env = process.env): URL | null {
	const raw = env.LIYUAN_WEB_RESEARCH_PROXY
		?? env.HTTPS_PROXY ?? env.https_proxy
		?? env.HTTP_PROXY ?? env.http_proxy
		?? "http://127.0.0.1:7890";
	if (!raw || raw.trim().toLowerCase() === "direct") return null;
	const proxy = new URL(raw.includes("://") ? raw : `http://${raw}`);
	if (proxy.protocol !== "http:") throw new Error(`不支持的联网代理协议：${proxy.protocol}`);
	return proxy;
}

export function hostUsesWebResearchProxy(hostname: string, proxy: URL | null, env = process.env): boolean {
	if (!proxy) return false;
	const host = hostname.toLowerCase();
	const noProxy = (env.NO_PROXY ?? env.no_proxy ?? "")
		.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
	return !noProxy.some((raw) => {
		const entry = raw.startsWith(".") ? raw.slice(1) : raw;
		return entry === "*" || host === entry || host.endsWith(`.${entry}`);
	});
}

function tunnel(url: URL, proxy: URL, signal: AbortSignal): Promise<tls.TLSSocket> {
	return new Promise((resolve, reject) => {
		const socket = net.connect({ host: proxy.hostname, port: Number(proxy.port || 80) });
		let buffer = "";
		const fail = (error: unknown) => {
			socket.destroy();
			reject(error instanceof Error ? error : new Error(String(error)));
		};
		const abort = () => fail(signal.reason ?? new Error("联网查证已取消"));
		if (signal.aborted) return abort();
		signal.addEventListener("abort", abort, { once: true });
		socket.once("error", fail);
		socket.once("connect", () => {
			const port = Number(url.port || 443);
			const headers = [`CONNECT ${url.hostname}:${port} HTTP/1.1`, `Host: ${url.hostname}:${port}`];
			if (proxy.username) {
				const auth = Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64");
				headers.push(`Proxy-Authorization: Basic ${auth}`);
			}
			socket.write(`${headers.join("\r\n")}\r\n\r\n`);
		});
		socket.on("data", (chunk) => {
			buffer += chunk.toString("latin1");
			const end = buffer.indexOf("\r\n\r\n");
			if (end < 0) return;
			const status = buffer.slice(0, buffer.indexOf("\r\n"));
			if (!/^HTTP\/1\.[01] 2\d\d /.test(status)) return fail(new Error(`代理 CONNECT 失败：${status}`));
			signal.removeEventListener("abort", abort);
			resolve(tls.connect({ socket, servername: url.hostname }));
		});
	});
}

async function requestText(url: URL, signal: AbortSignal): Promise<string> {
	const proxy = resolveWebResearchProxy();
	if (!hostUsesWebResearchProxy(url.hostname, proxy)) {
		const response = await fetch(url, { headers: { "user-agent": "Mozilla/5.0", accept: "text/html" }, signal });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		return response.text();
	}
	const socket = await tunnel(url, proxy!, signal);
	return new Promise((resolve, reject) => {
		const req = https.request({
			host: url.hostname,
			path: `${url.pathname}${url.search}`,
			headers: { "user-agent": "Mozilla/5.0", accept: "text/html" },
			createConnection: () => socket,
		}, (response) => {
			let body = "";
			response.setEncoding("utf8");
			response.on("data", (chunk) => { body += chunk; });
			response.on("end", () => {
				if ((response.statusCode ?? 500) >= 400) reject(new Error(`HTTP ${response.statusCode}`));
				else resolve(body);
			});
		});
		req.on("error", reject);
		signal.addEventListener("abort", () => req.destroy(signal.reason as Error), { once: true });
		req.end();
	});
}

const decode = (value: string): string => value
	.replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&#x27;", "'")
	.replaceAll("&lt;", "<").replaceAll("&gt;", ">");
const strip = (value: string): string => decode(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

export function parseDuckDuckGo(html: string): WebResearchResult[] {
	const results: WebResearchResult[] = [];
	const pattern = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
	for (const match of html.matchAll(pattern)) {
		let url = decode(match[1]);
		try { url = new URL(url, "https://duckduckgo.com").searchParams.get("uddg") ?? url; } catch {}
		results.push({ title: strip(match[2]), url, snippet: strip(match[3]).slice(0, 1200) });
		if (results.length >= 8) break;
	}
	return results.filter((result) => result.title && result.url);
}

export function isSearchChallenge(html: string): boolean {
	return /complete the following challenge|confirm this search was made by a human|captcha|unusual traffic/i.test(html);
}

/** Bing HTML 兜底。链接可能是 Bing 跳转页，但标题/摘要仍可作为旁路研究来源。 */
export function parseBing(html: string): WebResearchResult[] {
	const results: WebResearchResult[] = [];
	for (const match of html.matchAll(/<li[^>]+class="[^"]*b_algo[^"]*"[\s\S]*?<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>([\s\S]*?)(?=<li[^>]+class="[^"]*b_algo|<\/ol>)/gi)) {
		const snippet = match[3].match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "";
		results.push({ title: strip(match[2]), url: decode(match[1]), snippet: strip(snippet).slice(0, 1200) });
		if (results.length >= 8) break;
	}
	return results.filter((result) => result.title && result.url);
}

export function rankWebResearchResults(query: string, rows: WebResearchResult[], limit = 3): WebResearchResult[] {
	const terms = query.toLowerCase().replace(/["'“”‘’()[\]{}<>，。！？、：；/\\|]/g, " ")
		.split(/\s+/).map((term) => term.trim()).filter((term) => term.length >= 2);
	const seen = new Set<string>();
	const ranked = rows.flatMap((row, index) => {
		let normalizedUrl = row.url;
		try { const url = new URL(row.url); url.hash = ""; normalizedUrl = url.toString(); } catch {}
		if (!normalizedUrl || seen.has(normalizedUrl)) return [];
		seen.add(normalizedUrl);
		const title = row.title.toLowerCase();
		const snippet = row.snippet.toLowerCase();
		const score = terms.reduce((sum, term) => sum + (title.includes(term) ? 3 : 0) + (snippet.includes(term) ? 1 : 0), 0);
		return [{ ...row, url: normalizedUrl, score, index }];
	});
	ranked.sort((a, b) => b.score - a.score || a.index - b.index);
	const useful = ranked.some((row) => row.score > 0) ? ranked.filter((row) => row.score > 0) : ranked;
	return useful.slice(0, limit).map(({ score: _score, index: _index, ...row }) => row);
}

function protectedNames(card: CharacterCard): string[] {
	const sourceValues = [
		...(card.creatorNotes ?? "").matchAll(/(?:作品|原作|系列|出处)\s*[:：]\s*([^\n]{2,80})/gi),
	].map((match) => match[1].trim());
	for (const tag of card.tags) {
		const match = tag.match(/^(?:source|franchise|原作|作品)\s*[:：]\s*(.+)$/i);
		if (match) sourceValues.push(match[1].trim());
	}
	const publicSource = sourceValues.some((value) => !/^(?:原创|自设|私设|oc|original|none|无|不适用)$/i.test(value));
	return publicSource ? [] : [card.name].filter((name) => name.trim().length >= 2);
}

function redactLiteral(value: string, secret: string): string {
	const needle = secret.trim();
	if (!needle) return value;
	return value.replace(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu"), " ");
}

/** 最终发网闸门：即使规划模型重新写入用户名，也会在 HTTP 请求前剔除。 */
export function sanitizeWebResearchQuery(query: string, userName?: string): string {
	return redactLiteral(query, userName ?? "").replace(/\s+/g, " ").trim();
}

function rejectReason(query: string, card: CharacterCard): string | undefined {
	if (query.length > 160 || /(?:以下是用户|本轮输入|系统提示|<\/?(?:character|persona|world|user)>)/i.test(query)) {
		return "查询包含提示词包装或过长的私人上下文";
	}
	if (protectedNames(card).some((name) => query.toLowerCase().includes(name.toLowerCase()))) {
		return "查询包含没有公开作品出处的私人角色名；请改查年代、地点、职业、技术或社会规则";
	}
	return undefined;
}

export async function webResearchBatch(
	queries: string[],
	maxResults: number,
	options: { card: CharacterCard; userName?: string; signal?: AbortSignal },
): Promise<WebResearchItem[]> {
	return Promise.all(queries.slice(0, 3).map(async (rawQuery) => {
		const query = sanitizeWebResearchQuery(rawQuery, options.userName);
		if (query.length < 2) return { query, rejected: "查询脱敏后没有足够的公开主题" };
		const rejected = rejectReason(query, options.card);
		if (rejected) return { query, rejected };
		try {
			const timeout = Number.parseInt(process.env.LIYUAN_WEB_RESEARCH_TIMEOUT_MS ?? "", 10) || DEFAULT_TIMEOUT_MS;
			const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
			const searchUrl = process.env.LIYUAN_WEB_RESEARCH_URL;
			if (searchUrl) {
				const response = await fetch(searchUrl, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ query, max_results: 8 }),
					signal,
				});
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const payload = await response.json() as { results?: Array<{ title?: unknown; url?: unknown; snippet?: unknown; content?: unknown }> };
				const rows = (payload.results ?? []).map((row) => ({
					title: String(row.title ?? ""), url: String(row.url ?? ""), snippet: String(row.snippet ?? row.content ?? "").slice(0, 1200),
				})).filter((row) => row.title && row.url);
				return { query, results: rankWebResearchResults(query, rows, maxResults) };
			}
			let duckHtml = "";
			let duckRows: WebResearchResult[] = [];
			if (Date.now() >= duckChallengeUntil) {
				const duck = new URL("https://html.duckduckgo.com/html/");
				duck.searchParams.set("q", query);
				duckHtml = await requestText(duck, signal);
				if (isSearchChallenge(duckHtml)) duckChallengeUntil = Date.now() + 30 * 60_000;
				else duckRows = parseDuckDuckGo(duckHtml);
			}
			if (duckRows.length) return { query, results: rankWebResearchResults(query, duckRows, maxResults) };

			// DuckDuckGo 经常对服务器 IP 返回人机验证页。自动改用 Bing，而不是把 0 结果
			// 伪装成搜索成功，让生态全局池永久为空。
			const bing = new URL("https://www.bing.com/search");
			bing.searchParams.set("q", query);
			bing.searchParams.set("setlang", "zh-Hans");
			const bingRows = parseBing(await requestText(bing, signal));
			if (!bingRows.length) throw new Error((duckHtml && isSearchChallenge(duckHtml)) || Date.now() < duckChallengeUntil ? "搜索源返回人机验证，Bing 兜底也无结果" : "搜索源均无可解析结果");
			return { query, results: rankWebResearchResults(query, bingRows, maxResults) };
		} catch (error) {
			return { query, error: error instanceof Error ? error.message : String(error) };
		}
	}));
}
