import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "../api.ts";

type WorkflowStage = "continuity" | "character" | "persona" | "director" | "writer" | "curtain" | "world" | "world-profile" | "world-facts" | "world-audit" | "ecology-global" | "ecology-card" | "ecology-runtime" | "outline-bootstrap" | "outline-chat" | "outline-reconcile" | "outline-foreshadowing" | "outline-research" | "outline-audit";
type StageSkill = {
	dir: string;
	name: string;
	description: string;
	workflow?: WorkflowStage;
	chars: number;
	body: string;
	source: "builtin" | "user";
	worldModule?: string;
};

const STAGE_LABELS: Record<WorkflowStage, string> = {
	continuity: "连续性",
	character: "Sogon",
	persona: "Sigon",
	director: "导演",
	writer: "主演",
	curtain: "谢幕格式",
	world: "后台世界",
	"world-profile": "角色卡世界画像",
	"world-facts": "拍后事实信封",
	"world-audit": "世界转移审计",
	"ecology-global": "通用原型池",
	"ecology-card": "角色卡生态池",
	"ecology-runtime": "人物场所生态",
	"outline-bootstrap": "大纲首次规划",
	"outline-chat": "大纲编剧讨论",
	"outline-reconcile": "大纲剧情校准",
	"outline-foreshadowing": "大纲伏笔编织",
	"outline-research": "大纲研究灵感",
	"outline-audit": "大纲提案审计",
};

export function SkillLibrary({ toast }: { toast: (level: "info" | "warning" | "error", text: string) => void }) {
	const [skills, setSkills] = useState<StageSkill[] | null>(null);
	const [editing, setEditing] = useState<StageSkill | null>(null);
	const [busy, setBusy] = useState(false);
	const reload = useCallback(async () => {
		try {
			setSkills((await apiGet<{ skills: StageSkill[] }>("/api/stage-skills")).skills);
		} catch (error) {
			toast("error", error instanceof Error ? error.message : String(error));
		}
	}, [toast]);
	useEffect(() => { void reload(); }, [reload]);

	const save = async () => {
		if (!editing) return;
		setBusy(true);
		try {
			await apiPost("/api/stage-skills", {
				dir: editing.dir,
				name: editing.name,
				description: editing.description,
				workflow: editing.workflow,
				resident: false,
				everyBeat: false,
				body: editing.body,
				worldModule: editing.worldModule,
			});
			toast("info", "已保存为用户覆盖；以后拉取 GitHub 更新不会覆盖你的修改");
			setEditing(null);
			await reload();
		} catch (error) {
			toast("error", error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	};

	return <section className="sp-section">
		<div className="field-hint">内置工作流 skill 随版本更新，编辑后保存到 `.liyuan-stage-skills/` 作为用户覆盖，不会被 GitHub 更新覆盖。</div>
		{skills === null && <div className="sp-empty">读取中...</div>}
		{skills?.map((skill) => editing?.dir === skill.dir ? <div className="skill-edit-form" key={skill.dir}>
			<label className="field-label">名称</label>
			<input className="panel-search" value={editing.name} disabled={busy} onChange={(event) => setEditing({ ...editing, name: event.target.value })} />
			<label className="field-label">说明</label>
			<input className="panel-search" value={editing.description} disabled={busy} onChange={(event) => setEditing({ ...editing, description: event.target.value })} />
			<label className="field-label">工作流阶段</label>
			<select className="field-input" value={editing.workflow ?? ""} disabled={busy} onChange={(event) => setEditing({ ...editing, workflow: event.target.value as WorkflowStage || undefined })}>
				<option value="">写作参考</option>
				{Object.entries(STAGE_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
			</select>
			<label className="field-label">Skill 正文</label>
			{editing.worldModule && <div className="field-hint">世界模块包：{editing.worldModule}</div>}
			<textarea className="panel-search ta preset-block-ta" rows={18} value={editing.body} disabled={busy} spellCheck={false} onChange={(event) => setEditing({ ...editing, body: event.target.value })} />
			<div className="panel-row list-toolbar skill-edit-acts">
				<button className="drawer-btn save-btn" disabled={busy} onClick={() => void save()}>保存覆盖</button>
				<button className="drawer-btn" disabled={busy} onClick={() => setEditing(null)}>取消</button>
			</div>
		</div> : <div className="skill-lib-row" key={skill.dir}>
			<div className="skill-lib-main">
				<span className="lore-title">{skill.name}{skill.workflow && <span className="skill-badge resident">{STAGE_LABELS[skill.workflow]}</span>}{skill.worldModule && <span className="skill-badge resident">模块 {skill.worldModule}</span>}</span>
				<span className="lore-meta">{skill.description} · {skill.chars.toLocaleString()} 字 · {skill.source === "user" ? "用户覆盖" : "内置"}</span>
			</div>
			<button className="act" disabled={busy || !!editing} onClick={() => setEditing(skill)}>编辑</button>
		</div>)}
	</section>;
}
