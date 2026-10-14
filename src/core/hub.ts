import type { App, Plugin } from "obsidian";
import type { HubStore, NewItemOptions } from "./store";
import type { HubSettings } from "./settings";
import type { HistoryStore } from "./history";

/** What the UI needs from the Azure DevOps sync engine. */
export interface SyncApi {
	readonly running: boolean;
	readonly enabled: boolean;
	/** Epoch ms of the last successful sync, 0 if never. */
	readonly lastSync: number;
	/** Empty when the last sync succeeded. */
	readonly lastError: string;
	/** Runs a full pull + push. Resolves when finished; never throws (errors land in lastError). */
	syncNow(): Promise<void>;
	/** Registers a listener for state changes; returns an unsubscribe function. */
	onState(cb: () => void): () => void;
	/** Pulls one linked item and pushes its pending local changes. */
	syncItem(path: string): Promise<void>;
	/** Returns the signed-in user's display name, or throws with a readable message. */
	testConnection(): Promise<string>;
	/** Last error for one item (e.g. a rejected push), or null. */
	itemError(path: string): string | null;
	/** True when the item has local changes not yet pushed. */
	hasPendingPush(path: string): boolean;
}

/** Command ids registered by the plugin (prefix with "project-hub:" for executeCommandById). */
export const CMD = {
	newItem: "new-work-item",
	newChild: "new-child-item",
	newProject: "new-project",
	newSprint: "new-sprint",
	newMeeting: "new-meeting",
	openHome: "open-home",
	openBoard: "open-board",
	openBacklog: "open-backlog",
	openTimeline: "open-timeline",
	openCalendar: "open-calendar",
	setStatus: "set-status",
	setPriority: "set-priority",
	assign: "assign",
	moveToSprint: "move-to-sprint",
	setParent: "set-parent",
	setProject: "set-project",
	startNextSprint: "start-next-sprint",
	recalculate: "recalculate",
} as const;

/**
 * The plugin facade every module receives. Modules register their own commands,
 * views and processors through `plugin` so everything unloads with the plugin.
 */
export interface Hub {
	app: App;
	plugin: Plugin;
	store: HubStore;
	readonly settings: HubSettings;
	saveSettings(): Promise<void>;
	history: HistoryStore;
	sync: SyncApi;
	/** Opens a note; `newLeaf` opens it in a new tab. Accepts "File.base#View" for base views. */
	openPath(path: string, newLeaf?: boolean): Promise<void>;
	/** Opens the New work item modal with optional defaults. */
	newItem(defaults?: Partial<NewItemOptions>): void;
	/** Runs one of the CMD commands. */
	runCommand(id: (typeof CMD)[keyof typeof CMD]): void;
	/** Vault-relative path of the plugin folder, e.g. ".obsidian/plugins/project-hub". */
	pluginDir: string;
}
