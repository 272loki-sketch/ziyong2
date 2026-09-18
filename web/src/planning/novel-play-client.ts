import { api, apiDelete, apiGet, apiPost } from "../api.ts";

export type NovelPlayJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export interface NovelPlayPackage { docId: string; title: string; revision: string; stageCount: number; nodeCount: number; builtAt: string }
export interface NovelPlayJob { id: string; docId: string; status: NovelPlayJobStatus; createdAt: string; updatedAt: string; result?: NovelPlayPackage; error?: string }
export interface NovelPlayStartOptions { docId: string; revision: string; title: string; nodes: Array<{ nodeId: string; title: string }> }
export interface NovelPlayDraft {
	user: { name: string; identity: string };
	time: string;
	place: string;
	sceneText: string;
	openingNarration: string;
	publicCharacterProfiles: Array<{ name: string; profile: string }>;
	publicWorldFacts: string[];
}
export interface NovelPlayPreview {
	token: string;
	expiresAt: string;
	package: { docId: string; revision: string };
	anchor: { packageRevision: string; nodeId: string; position: "before" | "after" };
	draft: NovelPlayDraft;
}
export type NovelPlayStartResult =
	| { card: string; session: "created" }
	| { card?: string; session: "recovery-required"; recovery: string };

export const buildNovelPlay = (docId: string) => apiPost<{ job: NovelPlayJob }>("/api/novel-play/build", { docId });
export const listNovelPlayJobs = () => apiGet<{ jobs: NovelPlayJob[] }>("/api/novel-play/status", { bypassCache: true });
export const getNovelPlayJob = (jobId: string, signal?: AbortSignal) => api<{ job: NovelPlayJob }>(`/api/novel-play/status/${encodeURIComponent(jobId)}`, { signal });
export const cancelNovelPlayJob = (jobId: string) => apiDelete<{ job: NovelPlayJob }>(`/api/novel-play/status/${encodeURIComponent(jobId)}`);
export const getNovelPlayStartOptions = (docId: string, revision: string, signal?: AbortSignal) => api<{ package: NovelPlayStartOptions }>(`/api/novel-play/start?docId=${encodeURIComponent(docId)}&revision=${encodeURIComponent(revision)}`, { signal });
export const previewNovelPlay = (input: { docId: string; revision: string; nodeId: string; position: "before" | "after"; player: { name: string; identity: string } }, signal?: AbortSignal) => api<{ preview: NovelPlayPreview }>("/api/novel-play/preview", { method: "POST", body: JSON.stringify(input), signal });
export const startNovelPlay = (previewToken: string, signal?: AbortSignal) => api<{ started: NovelPlayStartResult }>("/api/novel-play/start", { method: "POST", body: JSON.stringify({ previewToken }), signal });
