from pathlib import Path

p = Path("test/novel-play-api.test.ts")
s = p.read_text()
old = '''function host(root: string, model: (system: string, user: string) => string): RestHost {
\treturn { cwd: root, isStreaming: () => false, runSideText: async (_step, system, user) => model(system, user), memoryScope: () => ({ sessionId: "test", card: "assets/cards/default_Qingwu.json" }), switchToCard: async () => "created" } as unknown as RestHost;
}'''
new = '''function host(root: string, model: (system: string, user: string) => string): RestHost {
\tlet runtimeCard = "assets/cards/default_Qingwu.json";
\treturn { cwd: root, isStreaming: () => false, runSideText: async (_step, system, user) => model(system, user), memoryScope: () => ({ sessionId: "test", card: runtimeCard }), switchToCard: async () => { runtimeCard = JSON.parse(readFileSync(join(root, "liyuan.config.json"), "utf8")).card; return "created"; } } as unknown as RestHost;
}'''
assert old in s
p.write_text(s.replace(old, new))

p = Path("test/novel-play-api-audit.test.ts")
s = p.read_text()
s = s.replace('const start = api.indexOf("await startFromConfirmedProposal", consume);', 'const start = api.indexOf("startFromConfirmedProposal", consume);')
s = s.replace('assert.match(application, /memoryScope\\(\\)\\.sessionId/);\n\tassert.match(application, /loadRawConfig\\(host\\.cwd\\)\\.config\\.card/);', 'assert.match(application, /const scope = host\\.memoryScope\\(\\)/);\n\tassert.match(application, /const sessionId = scope\\.sessionId/);\n\tassert.match(application, /runtimeCard !== configCard/);')
s = s.replace('assert.equal(NOVEL_PLAY_LIMITS.buildDeadlineMs, 120_000);', 'assert.equal(NOVEL_PLAY_LIMITS.buildDeadlineMs, 30 * 60_000);\n\tassert.equal(NOVEL_PLAY_LIMITS.modelCallDeadlineMs, 120_000);\n\tassert.equal(NOVEL_PLAY_LIMITS.startSwitchDeadlineMs, 30_000);')
p.write_text(s)
