// Shared data model for Project Hub. Every module reads notes through these types.

export type Kind = "work-item" | "project" | "sprint" | "person";

/** Azure DevOps state categories, lower-camel-cased. */
export type StatusCategory = "proposed" | "inProgress" | "resolved" | "completed" | "removed";

export const ADO_CATEGORY: Record<string, StatusCategory> = {
	Proposed: "proposed",
	InProgress: "inProgress",
	Resolved: "resolved",
	Completed: "completed",
	Removed: "removed",
};

/** Named colors; resolved to CSS variables `--ph-<name>` (light/dark aware) in styles. */
export type PaletteColor = "blue" | "orange" | "aqua" | "yellow" | "magenta" | "green" | "violet" | "red" | "gray";

export const PALETTE_ORDER: PaletteColor[] = ["blue", "orange", "aqua", "yellow", "magenta", "green", "violet", "red"];

export interface StatusDef {
	name: string;
	category: StatusCategory;
	color: PaletteColor;
	/** Blocked statuses push as an in-progress state plus the ADO blocked flag/tag. */
	blocked?: boolean;
}

export const DEFAULT_STATUSES: StatusDef[] = [
	{ name: "Backlog", category: "proposed", color: "magenta" },
	{ name: "To Do", category: "proposed", color: "blue" },
	{ name: "In Progress", category: "inProgress", color: "orange" },
	{ name: "In Review", category: "resolved", color: "violet" },
	{ name: "Blocked", category: "inProgress", color: "red", blocked: true },
	{ name: "Done", category: "completed", color: "aqua" },
	{ name: "Removed", category: "removed", color: "gray" },
];

export const PROJECT_STATUSES = ["Planning", "Active", "On Hold", "Done", "Cancelled"] as const;
export const PROJECT_HEALTH = ["On Track", "At Risk", "Off Track"] as const;

export interface TypeDef {
	name: string;
	icon: string;
	/** Default type for "Add child". */
	child?: string;
	/** Candidate ADO work item type names, first one that exists in the project wins. */
	ado: string[];
}

export const DEFAULT_TYPES: TypeDef[] = [
	{ name: "Epic", icon: "crown", child: "Feature", ado: ["Epic"] },
	{ name: "Feature", icon: "trophy", child: "Story", ado: ["Feature"] },
	{ name: "Story", icon: "book-open", child: "Task", ado: ["User Story", "Product Backlog Item", "Requirement"] },
	{ name: "Task", icon: "square-check", ado: ["Task"] },
	{ name: "Bug", icon: "bug", child: "Task", ado: ["Bug"] },
	{ name: "Issue", icon: "circle-alert", child: "Task", ado: ["Issue", "Impediment"] },
	{ name: "Risk", icon: "shield-alert", ado: ["Risk"] },
];

export const PRIORITIES: { value: number; label: string; name: string }[] = [
	{ value: 1, label: "P1", name: "Critical" },
	{ value: 2, label: "P2", name: "High" },
	{ value: 3, label: "P3", name: "Medium" },
	{ value: 4, label: "P4", name: "Low" },
];

/** Frontmatter keys. Changing these breaks existing vaults, so they are fixed. */
export const P = {
	kind: "kind",
	id: "id",
	title: "title",
	type: "type",
	status: "status",
	priority: "priority",
	assignee: "assignee",
	project: "project",
	parent: "parent",
	sprint: "sprint",
	start: "start",
	due: "due",
	points: "points",
	estimate: "estimate",
	remaining: "remaining",
	completed: "completed",
	labels: "labels",
	blockedBy: "blocked_by",
	started: "started",
	closed: "closed",
	created: "created",
	progress: "progress",
	rank: "rank",
	area: "area",
	adoId: "ado_id",
	adoUrl: "ado_url",
	adoType: "ado_type",
	adoState: "ado_state",
	adoIteration: "ado_iteration",
	adoSync: "ado_sync",
	// project
	owner: "owner",
	target: "target",
	health: "health",
	summary: "summary",
	adoArea: "ado_area",
	adoEpics: "ado_epics",
	itemsTotal: "items_total",
	itemsDone: "items_done",
	pointsTotal: "points_total",
	pointsDone: "points_done",
	// sprint
	end: "end",
	goal: "goal",
	state: "state",
	adoPath: "ado_path",
	capacity: "capacity",
	// person
	email: "email",
	openItems: "open_items",
	openPoints: "open_points",
	role: "role",
} as const;

export interface WorkItem {
	kind: "work-item";
	path: string;
	basename: string;
	id: string;
	title: string;
	type: string;
	status: string;
	priority: number | null;
	assignee: string | null; // resolved file path of the person note, or raw text
	assigneeName: string | null;
	project: string | null; // resolved path
	parent: string | null; // resolved path
	sprint: string | null; // resolved path
	start: string | null; // YYYY-MM-DD
	due: string | null;
	points: number | null;
	estimate: number | null;
	remaining: number | null;
	completed: number | null;
	labels: string[];
	blockedBy: string[]; // resolved paths
	started: string | null;
	closed: string | null;
	created: string | null;
	progress: number | null;
	/** Manual ordering on boards and backlogs; lower comes first. */
	rank: number | null;
	area: string | null;
	adoId: number | null;
	adoUrl: string | null;
	adoType: string | null;
	adoState: string | null;
	adoSync: boolean;
	mtime: number;
	ctime: number;
}

export interface Project {
	kind: "project";
	path: string;
	basename: string;
	name: string;
	status: string;
	priority: number | null;
	owner: string | null;
	start: string | null;
	target: string | null;
	health: string | null;
	summary: string | null;
	adoArea: string | null;
	adoEpics: number[];
	progress: number | null;
	mtime: number;
}

export interface Sprint {
	kind: "sprint";
	path: string;
	basename: string;
	name: string;
	start: string | null;
	end: string | null;
	goal: string | null;
	adoPath: string | null;
	capacity: number | null;
	state: "Past" | "Current" | "Future" | null;
}

export interface Person {
	kind: "person";
	path: string;
	basename: string;
	name: string;
	email: string | null;
	role: string | null;
}

export type Entity = WorkItem | Project | Sprint | Person;
