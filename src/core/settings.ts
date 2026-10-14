import { DEFAULT_STATUSES, DEFAULT_TYPES, StatusDef, TypeDef } from "./model";

export interface AdoSettings {
	enabled: boolean;
	/** Organization name ("contoso") or URL ("https://dev.azure.com/contoso"). */
	organization: string;
	project: string;
	/** Team used for sprint (iteration) import. Empty = project default team. */
	team: string;
	auth: "azure-cli" | "pat";
	/** Id of the PAT inside Obsidian's secret storage. */
	patSecretId: string;
	/** Path to the az executable. */
	azPath: string;
	/** WIQL WHERE clause choosing which work items to pull. */
	pullQuery: string;
	/** Also pull the parent chain (Feature/Epic) of every pulled item. */
	includeAncestors: boolean;
	/** Minutes between background syncs. 0 disables the timer. */
	syncIntervalMinutes: number;
	syncOnStartup: boolean;
	/** Push local edits of linked items shortly after they happen. */
	pushOnChange: boolean;
	pushDelaySeconds: number;
	/** Two-way sync of the description / repro steps section. */
	syncDescriptions: boolean;
	/** Who wins when the same field changed on both sides since the last sync. */
	conflictPolicy: "remote" | "local";
	/** New local items are published to ADO when their project is linked to an area path. */
	publishNewItemsInLinkedProjects: boolean;
	defaultAreaPath: string;
	syncSprints: boolean;
	/** Iteration path whose dated children are imported as sprints. Empty = derived from pulled items. */
	sprintRoot: string;
	/** Master switch for writing to ADO. Off = pull only. */
	pushEnabled: boolean;
	/** Safety cap: a sync that would push more items than this asks for confirmation first. */
	maxPushPerSync: number;
	/** Download ADO inline images into the vault so they render offline. */
	downloadAttachments: boolean;
	attachmentsFolder: string;
	/** Pull the ADO discussion into a read-only section of each note. */
	syncComments: boolean;
	/** ADO ids the user deleted locally; never re-imported. */
	ignoredIds: number[];
	lastSync: number;
	lastSyncError: string;
}

export interface FolderSettings {
	items: string;
	projects: string;
	sprints: string;
	people: string;
	meetings: string;
	templates: string;
}

export interface HubSettings {
	folders: FolderSettings;
	idPrefix: string;
	nextId: number;
	statuses: StatusDef[];
	types: TypeDef[];
	defaultType: string;
	/** Open Home.md when the vault opens. */
	openHomeOnStartup: boolean;
	homeNote: string;
	/** Basename of the person note that represents the vault owner. */
	me: string;
	renameOnTitleChange: boolean;
	/** status name -> max cards; 0 or missing = unlimited. */
	wipLimits: Record<string, number>;
	sprintLengthDays: number;
	/** Write progress / counts into project and parent notes so Bases can show them. */
	writeRollups: boolean;
	/** Stamp started / closed dates when the status changes category. */
	stampDates: boolean;
	ado: AdoSettings;
}

export const DEFAULT_SETTINGS: HubSettings = {
	folders: {
		items: "Work Items",
		projects: "Projects",
		sprints: "Sprints",
		people: "People",
		meetings: "Meetings",
		templates: "Templates",
	},
	idPrefix: "PH",
	nextId: 1,
	statuses: DEFAULT_STATUSES,
	types: DEFAULT_TYPES,
	defaultType: "Task",
	openHomeOnStartup: true,
	homeNote: "Home.md",
	me: "",
	renameOnTitleChange: true,
	wipLimits: { "In Progress": 5, "In Review": 4 },
	sprintLengthDays: 14,
	writeRollups: true,
	stampDates: true,
	ado: {
		enabled: false,
		organization: "",
		project: "",
		team: "",
		auth: "azure-cli",
		patSecretId: "project-hub-ado-pat",
		azPath: "az",
		pullQuery:
			"[System.AssignedTo] = @Me AND [System.State] <> 'Removed' AND ([System.State] <> 'Closed' OR [System.ChangedDate] >= @Today - 30)",
		includeAncestors: true,
		syncIntervalMinutes: 10,
		syncOnStartup: true,
		pushOnChange: true,
		pushDelaySeconds: 8,
		syncDescriptions: true,
		conflictPolicy: "remote",
		publishNewItemsInLinkedProjects: true,
		defaultAreaPath: "",
		syncSprints: true,
		sprintRoot: "",
		pushEnabled: true,
		maxPushPerSync: 25,
		downloadAttachments: true,
		attachmentsFolder: "Attachments/ADO",
		syncComments: true,
		ignoredIds: [],
		lastSync: 0,
		lastSyncError: "",
	},
};

/** Deep-merges saved data over defaults so new settings appear after upgrades. */
export function mergeSettings(saved: unknown): HubSettings {
	const s = (saved && typeof saved === "object" ? saved : {}) as Partial<HubSettings>;
	const d = structuredClone(DEFAULT_SETTINGS);
	return {
		...d,
		...s,
		folders: { ...d.folders, ...(s.folders ?? {}) },
		statuses: Array.isArray(s.statuses) && s.statuses.length ? s.statuses : d.statuses,
		types: Array.isArray(s.types) && s.types.length ? s.types : d.types,
		wipLimits: { ...(s.wipLimits ?? d.wipLimits) },
		ado: { ...d.ado, ...(s.ado ?? {}) },
	};
}
