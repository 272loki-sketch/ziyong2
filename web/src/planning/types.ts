export type OutlineMode = "manual" | "suggest" | "auto";
export type OutlineResearchMode = "off" | "manual" | "auto";
export type OutlineDiscussionFocus = "open" | "next-beat" | "dialogue" | "character" | "diagnose";
export type OutlineVisibility = "public" | "spoiler" | "secret";
export type OutlineRigidity = "hard" | "soft" | "open";
export type ForeshadowingStatus = "conceived" | "prepared" | "planted" | "reinforced" | "activated" | "partially-revealed" | "resolved" | "abandoned" | "invalidated";

export interface OutlineNode {
	id: string;
	title: string;
	summary?: string;
	status?: string;
	rigidity?: OutlineRigidity;
	visibility?: OutlineVisibility;
	actuality?: "plan" | "guidance" | "established";
	beats?: string[];
	question?: string;
	nextPressure?: string;
	criteria?: string[];
	character?: string;
	from?: string;
	toward?: string;
	foreshadowingStatus?: ForeshadowingStatus;
	setup?: string;
	payoff?: string;
	evidenceRefs?: string[];
}

export interface OutlineState {
	version?: 1;
	revision: number;
	parentHash?: string;
	hash: string;
	premise?: string;
	constraints?: OutlineNode[];
	arcs?: OutlineNode[];
	characterArcs?: OutlineNode[];
	threads?: OutlineNode[];
	milestones?: OutlineNode[];
	foreshadowing?: OutlineNode[];
	currentFocus?: string[];
	alignment?: { summary?: string; confidence?: number; conflicts?: string[] };
	// Optional metadata accepted from older history serializers.
	createdAt?: string;
	timestamp?: string;
	summary?: string;
	rationale?: string;
}

export interface OutlineAuditIssue { severity?: "warning" | "error"; code?: string; message?: string; path?: string }
export interface OutlineAudit { version?: 1; verdict?: "approve" | "reject"; summary?: string; issues?: OutlineAuditIssue[] }
export interface OutlineProposal {
	version?: 1;
	id: string;
	mode?: "manual" | "automatic";
	baseRevision: number;
	baseHash: string;
	baseLeafId?: string;
	kind?: "chat" | "bootstrap" | "reconcile" | "foreshadowing";
	rationale?: string;
	patch?: Record<string, unknown>;
	researchInspirationIds?: string[];
	proposalHash?: string;
	createdAt?: string;
}

export interface OutlineProposalEntry {
	version?: 1;
	proposal: OutlineProposal;
	proposalHash?: string;
	audit?: OutlineAudit;
	status: "pending" | "approved" | "committed" | "rejected";
	reason?: string;
	committedRevision?: number;
	committedHash?: string;
	createdAt?: string;
}
export interface OutlinePendingProposal { entryId: string; entry: OutlineProposalEntry }
export interface OutlineProposalView extends OutlineProposal {
	proposalHash: string;
	audit?: OutlineAudit;
	status: OutlineProposalEntry["status"];
	risk?: string;
}

export interface OutlineResearchSource { id: string; title: string; url: string; accessedAt: string }
export interface OutlineResearchMechanism { id: string; sourceIds: string[]; mechanism: string; appliesWhen: string; failureWarning: string }
export interface OutlineResearchCard { version: 1; cardKey: string; mechanismIds: string[]; updatedAt: string }
export interface OutlineResearchView {
	sources: OutlineResearchSource[];
	mechanisms: OutlineResearchMechanism[];
	cards: OutlineResearchCard[];
}

export interface OutlineSettings { mode: OutlineMode; researchMode: OutlineResearchMode }
export interface OutlineViewResponse {
	state: OutlineState;
	projection: unknown;
	pending: OutlinePendingProposal[];
	settings: OutlineSettings;
	invalidEntries: number;
	proposalRisks?: Record<string, { highRisk: string[]; issues: OutlineAuditIssue[]; requiresConfirmation: boolean }>;
	// Accepted for a rolling deployment where an older web-facing adapter may still be present.
	publicView?: OutlineState | null;
	proposals?: OutlineProposalView[];
	chats?: OutlineChatHistory[];
}
export interface OutlineHistoryResponse { current: OutlineState; history: OutlineState[]; invalidEntries: number }

export interface OutlineChatOption {
	id?: string;
	title?: string;
	experience?: string;
	mechanism?: string;
	tradeoffs?: string | string[];
	label?: string;
	text?: string;
	value?: string;
}
export interface OutlineChatResponse {
	requestId: string;
	reply: string;
	options?: Array<string | OutlineChatOption>;
	proposal?: OutlineProposal;
	proposalHash?: string;
	audit?: OutlineAudit;
	warnings: string[];
	focus?: OutlineDiscussionFocus;
	sceneAdvice?: OutlineSceneAdvice;
}
export interface OutlineSceneAdvice { recommendedBeat: string; openingMove: string; characterMoves: string[]; conversationTargets: Array<{ character: string; reason: string; openingTopic: string; risk: string }>; dialogueCues: string[]; pressure: string; playerSpace: string; stopPoint: string; alternatives: string[]; mixedRoute: string }
export interface OutlineChatHistory { version: 1; requestId: string; baseLeafId: string; focus: OutlineDiscussionFocus; user: string; answer: string; options: Array<string | OutlineChatOption>; warnings: string[]; sceneAdvice?: OutlineSceneAdvice; createdAt: string }
export interface OutlineReconcileResponse { proposal?: OutlineProposal; committed?: boolean; stable?: boolean }
export interface OutlineSettingsResponse { settings: OutlineSettings }

export type DiagnosticStatus = "success" | "degraded" | "skipped" | "reused" | "failed" | "committed" | "rejected" | "pending" | "stable" | "unavailable" | "approved";
export interface TurnDiagnosticStage { id: string; label: string; status: DiagnosticStatus; summary: string; details?: Record<string, unknown> }
export interface TurnDiagnosticView {
	version: 1;
	entryId: string;
	narrativeChars: number;
	curtainChars: number;
	timeline: { thinking: number; tools: number; text: number };
	stages: TurnDiagnosticStage[];
	artifacts: { prep?: Record<string, unknown>; workflow?: Record<string, unknown>; curtain?: string; curtainTruncated?: boolean; patchAudit?: unknown[]; commits: Array<{ type: string; status?: DiagnosticStatus; summary: string; data?: Record<string, unknown> }> };
}
export interface TurnDiagnosticsResponse { version: 1; turns: TurnDiagnosticView[] }
