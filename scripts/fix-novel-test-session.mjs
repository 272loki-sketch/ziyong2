import { readFileSync, writeFileSync } from "node:fs";
const path = "test/novel-play-api.test.ts";
let value = readFileSync(path, "utf8");
const old = `function host(root: string, model: (system: string, user: string) => string): RestHost {
\tlet runtimeCard = "assets/cards/default_Qingwu.json";
\treturn { cwd: root, isStreaming: () => false, runSideText: async (_step, system, user) => model(system, user), memoryScope: () => ({ sessionId: "test", card: runtimeCard }), switchToCard: async () => { runtimeCard = JSON.parse(readFileSync(join(root, "liyuan.config.json"), "utf8")).card; return "created"; } } as unknown as RestHost;
}`;
const next = `function host(root: string, model: (system: string, user: string) => string): RestHost {
\tlet runtimeCard = "assets/cards/default_Qingwu.json";
\tlet runtimeSession = "test";
\treturn { cwd: root, isStreaming: () => false, runSideText: async (_step, system, user) => model(system, user), memoryScope: () => ({ sessionId: runtimeSession, card: runtimeCard }), switchToCard: async () => { runtimeCard = JSON.parse(readFileSync(join(root, "liyuan.config.json"), "utf8")).card; runtimeSession = "created-session"; return "created"; } } as unknown as RestHost;
}`;
if (!value.includes(old)) throw new Error("host fixture changed");
writeFileSync(path, value.replace(old, next));
