import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type WorkflowSkillStage = "continuity" | "character" | "persona" | "director" | "writer" | "curtain" | "world" | "world-profile" | "world-facts" | "world-audit" | "ecology-global" | "ecology-card" | "ecology-runtime";

export interface SkillFile {
	dir: string;
	name: string;
	description: string;
	workflow?: WorkflowSkillStage;
	resident: boolean;
	everyBeat: boolean;
	body: string;
	source: "builtin" | "user";
	worldModule?: string;
}

export interface StageSkillInput {
	dir?: string;
	name: string;
	description: string;
	workflow?: WorkflowSkillStage;
	resident: boolean;
	everyBeat: boolean;
	body: string;
	worldModule?: string;
}

const USER_SKILLS_DIR = ".liyuan-stage-skills";
const WORKFLOW_STAGES = new Set<WorkflowSkillStage>(["continuity", "character", "persona", "director", "writer", "curtain", "world", "world-profile", "world-facts", "world-audit", "ecology-global", "ecology-card", "ecology-runtime"]);
const oneLine = (value: string): string => value.replace(/\s+/g, " ").trim();

export function sanitizeSkillDir(name: string): string | null {
	const dir = oneLine(name);
	if (!dir || dir.includes("/") || dir.includes("\\") || dir.includes("..") || dir.startsWith(".")) return null;
	if (/[<>:"|?*]/.test(dir)) return null;
	return dir;
}

function scanRoot(root: string, source: SkillFile["source"]): SkillFile[] {
	if (!existsSync(root)) return [];
	const out: SkillFile[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const file = join(root, entry.name, "SKILL.md");
		if (!existsSync(file)) continue;
		try {
			const lines = readFileSync(file, "utf8").split(/\r?\n/);
			if (lines[0]?.trim() !== "---") continue;
			const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
			if (end < 0) continue;
			const meta = new Map<string, string>();
			for (const line of lines.slice(1, end)) {
				const colon = line.indexOf(":");
				if (colon > 0) meta.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
			}
			const name = meta.get("name") ?? "";
			const description = meta.get("description") ?? "";
			if (!name || !description) continue;
			const rawWorkflow = meta.get("workflow") as WorkflowSkillStage | undefined;
			out.push({
				dir: entry.name,
				name,
				description,
				...(rawWorkflow && WORKFLOW_STAGES.has(rawWorkflow) ? { workflow: rawWorkflow } : {}),
				resident: meta.get("resident") === "true",
				everyBeat: meta.get("每轮") === "true",
				body: lines.slice(end + 1).join("\n").trim(),
				source,
				...(meta.get("world-module") ? { worldModule: meta.get("world-module") } : {}),
			});
		} catch {
			// A damaged skill must not hide the remaining library.
		}
	}
	return out;
}

/** Built-ins are versioned in skills/. User edits shadow them from an ignored data directory. */
export function scanSkillFiles(cwd: string): SkillFile[] {
	const merged = new Map<string, SkillFile>();
	for (const skill of scanRoot(join(cwd, "skills"), "builtin")) merged.set(skill.dir, skill);
	for (const skill of scanRoot(join(cwd, USER_SKILLS_DIR), "user")) merged.set(skill.dir, skill);
	return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function saveStageSkill(cwd: string, input: StageSkillInput): { dir: string } {
	const name = oneLine(input.name);
	const description = oneLine(input.description);
	if (!name) throw new Error("skill 名称为空");
	if (!description) throw new Error("简要说明为空");
	if (!input.body.trim()) throw new Error("正文为空");
	const dir = sanitizeSkillDir(input.dir ?? name);
	if (!dir) throw new Error("名称/目录含路径字符，无法作为存储目录");
	const folder = join(cwd, USER_SKILLS_DIR, dir);
	mkdirSync(folder, { recursive: true });
	const workflow = input.workflow && WORKFLOW_STAGES.has(input.workflow) ? `workflow: ${input.workflow}\n` : "";
	const worldModule = input.worldModule ? `world-module: ${oneLine(input.worldModule)}\n` : "";
	const text = [
		"---",
		`name: ${name}`,
		`description: ${description}`,
		workflow.trimEnd(),
		worldModule.trimEnd(),
		`resident: ${input.resident ? "true" : "false"}`,
		`每轮: ${input.everyBeat ? "true" : "false"}`,
		"---",
		"",
		input.body.trim(),
		"",
	].filter((line, index) => line || index > 0).join("\n");
	writeFileSync(join(folder, "SKILL.md"), text, "utf8");
	return { dir };
}

/** Removing a user override reveals the versioned built-in again. */
export function deleteStageSkill(cwd: string, dirName: string): void {
	const dir = sanitizeSkillDir(dirName);
	if (!dir) throw new Error("非法目录名");
	const folder = join(cwd, USER_SKILLS_DIR, dir);
	if (!existsSync(join(folder, "SKILL.md"))) throw new Error("内置 skill 不能删除；可编辑生成用户覆盖，或删除已有覆盖");
	rmSync(folder, { recursive: true, force: true });
}

export function workflowSkill(skills: SkillFile[], stage: WorkflowSkillStage): SkillFile | undefined {
	return skills.find((skill) => skill.workflow === stage);
}

export function worldModuleSkillPacks(skills: SkillFile[], modules: Array<{ skillPack: string }>): SkillFile[] {
	const wanted = new Set(modules.map((module) => module.skillPack));
	return skills.filter((skill) => skill.worldModule && wanted.has(skill.worldModule));
}
