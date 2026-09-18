const MARKER = "// novel-play-api: deterministic integration marker";

function replaceExactlyOnce(source, anchor, replacement, label) {
	const first = source.indexOf(anchor);
	const last = source.lastIndexOf(anchor);
	if (first < 0) throw new Error(`server patch anchor absent: ${label}`);
	if (first !== last) throw new Error(`server patch anchor occurs multiple times: ${label}`);
	return `${source.slice(0, first)}${replacement}${source.slice(first + anchor.length)}`;
}

/** Deterministically adds the small REST import and authenticated delegate. */
export function apply(source) {
	if (typeof source !== "string") throw new TypeError("server source must be a string");
	if (source.includes(MARKER)) return source;
	let next = replaceExactlyOnce(
		source,
		'import { basename, dirname, isAbsolute, join } from "node:path";\n',
		'import { basename, dirname, isAbsolute, join } from "node:path";\n\nimport { handleNovelPlayApiRequest } from "./novel-play-api.ts";\n',
		"node:path import",
	);
	next = replaceExactlyOnce(
		next,
		"try {\n\t\tconst proposalRoute = /^POST \\/api\\/outline\\/proposals\\/([^/]+)\\/(confirm|reject)$/.exec(route);",
		`try {\n\t\t${MARKER}\n\t\tif (await handleNovelPlayApiRequest(req, res, host)) return true;\n\t\tconst proposalRoute = /^POST \\/api\\/outline\\/proposals\\/([^/]+)\\/(confirm|reject)$/.exec(route);`,
		"authenticated API delegate",
	);
	return next;
}
