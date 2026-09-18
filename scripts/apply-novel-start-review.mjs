import { readFileSync, writeFileSync } from "node:fs";

const appPath = "src/novel-play/application.ts";
let app = readFileSync(appPath, "utf8");
const oldRestore = `function restoreOwnedPreSwitch(before: ReturnType<typeof loadRawConfig>, ownedBytes: string, cardFile: string, host: NovelPlayModelHost, binding: NovelPlayBinding): void {
\tlet current = "";
\ttry { current = readFileSync(before.path, "utf8"); } catch { return; }
\tif (current !== ownedBytes || !sameNovelPlayBinding(novelPlayBinding(host), { ...binding, card: JSON.parse(ownedBytes).card })) return;
\tif (before.existed) atomicWrite(before.path, before.bytes); else rmSync(before.path, { force: true });
\trmSync(cardFile, { force: true });
}`;
const newRestore = `function configCard(bytes: string): string | undefined {
\ttry {
\t\tconst value = JSON.parse(bytes) as { card?: unknown };
\t\treturn typeof value.card === "string" ? value.card : undefined;
\t} catch { return undefined; }
}

function restoreOwnedPreSwitch(before: ReturnType<typeof loadRawConfig>, ownedBytes: string, relativeCard: string, cardFile: string, host: NovelPlayModelHost, binding: NovelPlayBinding): void {
\tlet current: string;
\ttry { current = readFileSync(before.path, "utf8"); } catch { return; }
\tlet scope: ReturnType<NovelPlayModelHost["memoryScope"]>;
\ttry { scope = host.memoryScope(); } catch { return; }
\tif (scope.sessionId !== binding.sessionId || String(scope.card ?? "") !== binding.card) return;
\tif (ownedBytes && current === ownedBytes) {
\t\ttry {
\t\t\tif (before.existed) atomicWrite(before.path, before.bytes); else rmSync(before.path, { force: true });
\t\t} catch { return; }
\t\ttry { rmSync(cardFile, { force: true }); } catch { /* Preserve the original start error. */ }
\t\treturn;
\t}
\tconst currentCard = configCard(current);
\tif (currentCard === undefined || currentCard === relativeCard) return;
\ttry { rmSync(cardFile, { force: true }); } catch { /* Preserve the original start error. */ }
}`;
if (!app.includes(oldRestore)) throw new Error("restore block changed");
app = app.replace(oldRestore, newRestore);
app = app.replace(`const next = { ...before.config, userName: confirmed.user.name, card: relativeCard };`, `const next = { ...before.config, userName: confirmed.user.name, userPersona: confirmed.user.identity, card: relativeCard };`);
app = app.replace(`restoreOwnedPreSwitch(before, ownedBytes, absoluteCard, host, expected);`, `restoreOwnedPreSwitch(before, ownedBytes, relativeCard, absoluteCard, host, expected);`);
const oldSuccess = `\t\tif (switched !== "created") return { card: relativeCard, session: "recovery-required", recovery: "角色切换结果不确定。已保留新角色卡和配置，请检查当前会话。" };
\t\treturn { card: relativeCard, session: "created" };`;
const newSuccess = `\t\tif (switched !== "created") return { card: relativeCard, session: "recovery-required", recovery: "角色切换结果不确定。已保留新角色卡和配置，请检查当前会话。" };
\t\tconst actual = novelPlayBinding(host);
\t\tif (actual.card !== relativeCard || actual.sessionId === expected.sessionId) return { card: relativeCard, session: "recovery-required", recovery: "角色切换结果不确定。已保留新角色卡和配置，请检查当前会话。" };
\t\treturn { card: relativeCard, session: "created" };`;
if (!app.includes(oldSuccess)) throw new Error("success block changed");
app = app.replace(oldSuccess, newSuccess);
writeFileSync(appPath, app);

const testPath = "test/novel-play-api.test.ts";
let tests = readFileSync(testPath, "utf8");
tests = tests.replace(`import { mkdirSync, readFileSync, writeFileSync } from "node:fs";`, `import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";`);
tests = tests.replace(`import { handleNovelPlayApiRequest } from "../server/novel-play-api.ts";`, `import { createOpeningProposal, startFromConfirmedProposal } from "../src/novel-play/application.ts";\nimport { handleNovelPlayApiRequest } from "../server/novel-play-api.ts";`);
tests = tests.replace(`assert.equal(JSON.parse(readFileSync(join(root, "liyuan.config.json"), "utf8")).userName, "阿岚");`, `const updatedConfig = JSON.parse(readFileSync(join(root, "liyuan.config.json"), "utf8"));\n\tassert.equal(updatedConfig.userName, "阿岚");\n\tassert.equal(updatedConfig.userPersona, "异乡旅人");`);
const addition = `

async function directStartFixture() {
\tconst root = cwd(); const input = corpus(root); const revision = stored(root, input.docId, input.text);
\tskill(root, "小说开场提取", "opening extraction"); skill(root, "小说开演边界", "boundary");
\tmkdirSync(join(root, "assets", "cards"), { recursive: true });
\twriteFileSync(join(root, "assets", "cards", "default_Qingwu.json"), "{}");
\tconst original = JSON.stringify({ card: "assets/cards/default_Qingwu.json", userName: "old", userPersona: "old persona", language: "zh-CN", scanDepth: 6, maxLoreInjections: 5 });
\twriteFileSync(join(root, "liyuan.config.json"), original);
\tconst h = host(root, () => JSON.stringify({ time: { text: "晨钟响起", quote: "晨钟响起" }, place: { text: "城门", quote: "城门" }, sceneText: { text: "晨钟响起", quote: "晨钟响起" }, openingNarration: { text: "旅人推开城门", quote: "旅人推开城门" }, publicCharacterProfiles: [], publicWorldFacts: [] }));
\tconst options = await request(h, "GET", \`/api/novel-play/start?docId=\${input.docId}&revision=\${revision}\`);
\tconst generated = await createOpeningProposal(h as never, { docId: input.docId, revision, nodeId: options.body.package.nodes[0].nodeId, position: "before", player: { name: "阿岚", identity: "异乡旅人" } });
\treturn { root, h, generated, original, expected: { sessionId: "test", card: "assets/cards/default_Qingwu.json" } };
}

test("pre-switch callback failure restores owned config and removes generated card without masking the error", async () => {
\tconst fixture = await directStartFixture(); let generatedCard = "";
\tawait assert.rejects(startFromConfirmedProposal(fixture.h as never, fixture.generated, fixture.expected, card => { generatedCard = card; throw new Error("prepared callback failed"); }), /prepared callback failed/);
\tassert.equal(readFileSync(join(fixture.root, "liyuan.config.json"), "utf8"), fixture.original);
\tassert.equal(existsSync(join(fixture.root, generatedCard)), false);
});

test("pre-switch callback failure preserves external config edits and safely removes an unreferenced generated card", async () => {
\tconst fixture = await directStartFixture(); let generatedCard = "";
\tconst external = JSON.stringify({ card: "assets/cards/external.json", userName: "external", userPersona: "external persona" });
\tawait assert.rejects(startFromConfirmedProposal(fixture.h as never, fixture.generated, fixture.expected, card => { generatedCard = card; writeFileSync(join(fixture.root, "liyuan.config.json"), external); throw new Error("external edit"); }), /external edit/);
\tassert.equal(readFileSync(join(fixture.root, "liyuan.config.json"), "utf8"), external);
\tassert.equal(existsSync(join(fixture.root, generatedCard)), false);
});

test("created switch with stale runtime binding requires recovery", async () => {
\tconst fixture = await directStartFixture();
\t(fixture.h as unknown as { switchToCard(): Promise<string> }).switchToCard = async () => "created";
\tconst result = await startFromConfirmedProposal(fixture.h as never, fixture.generated, fixture.expected);
\tassert.equal(result.session, "recovery-required");
});
`;
if (tests.includes(`directStartFixture`)) throw new Error("tests already added");
tests += addition;
writeFileSync(testPath, tests);
