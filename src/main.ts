// Project Hub — plugin entry. Wires the core contracts together, then lets each
// module register its own views, commands and code blocks through
// hub.plugin.register* so everything unloads with the plugin.

import { Plugin, TFile, debounce } from "obsidian";
import { HubStore, type NewItemOptions } from "./core/store";
import { mergeSettings, type HubSettings } from "./core/settings";
import { HistoryStore } from "./core/history";
import { Hub, CMD, type SyncApi } from "./core/hub";
import { registerAdo } from "./ado";
import { registerCharts } from "./charts/index";
import { registerBaseViews } from "./views/index";
import { registerUi } from "./ui/index";
import { HubSettingTab } from "./settings-tab";

export default class ProjectHubPlugin extends Plugin implements Hub {
	settings!: HubSettings;
	store!: HubStore;
	history!: HistoryStore;
	sync!: SyncApi;
	newItem = (_defaults?: Partial<NewItemOptions>): void => {};

	async onload(): Promise<void> {
		this.settings = mergeSettings(await this.loadData());
		this.store = new HubStore(this.app, () => this.settings, () => this.saveData(this.settings));
		this.history = new HistoryStore(this.app, this.store, `${this.pluginDir}/history.json`);
		await this.history.load();

		this.sync = registerAdo(this);
		registerCharts(this);
		registerBaseViews(this);
		this.newItem = registerUi(this).newItem;

		this.addSettingTab(new HubSettingTab(this.app, this));

		this.registerEvent(this.app.metadataCache.on("changed", (file) => {
			if (file instanceof TFile && file.extension === "md") this.store.parse(file);
		}));
		this.registerEvent(this.app.vault.on("delete", (file) => {
			if (file instanceof TFile) this.store.remove(file.path);
		}));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
			if (file instanceof TFile && file.extension === "md") this.store.onRename(file, oldPath);
		}));

		// Rollups + history: on every change (debounced) and on a slow timer.
		const refresh = debounce(() => {
			this.history.record();
			void this.store.maintain();
		}, 5000, true);
		this.registerEvent(this.store.on("changed", () => refresh()));
		this.registerInterval(window.setInterval(() => {
			this.history.record();
			void this.store.maintain();
		}, 15 * 60 * 1000));

		this.app.workspace.onLayoutReady(() => {
			this.store.reindexAll();
			this.history.record();
			void this.store.maintain().then(() => {
				if (this.settings.openHomeOnStartup) void this.openPath(this.settings.homeNote, false);
			});
		});
	}

	async onunload(): Promise<void> {
		await this.history.save();
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	get plugin(): Plugin {
		return this;
	}

	get pluginDir(): string {
		return this.manifest.dir ?? ".obsidian/plugins/project-hub";
	}

	/** Opens a note, or a base view when the path contains "#". */
	async openPath(path: string, newLeaf = false): Promise<void> {
		const hash = path.indexOf("#");
		if (hash >= 0) {
			const link = path.slice(0, hash) + "#" + path.slice(hash + 1);
			await this.app.workspace.openLinkText(link, "", newLeaf ? "tab" : false);
			return;
		}
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			await this.app.workspace.getLeaf(newLeaf ? "tab" : false).openFile(file);
			return;
		}
		// Missing target: fall back to link resolution so wikilink-style paths work.
		await this.app.workspace.openLinkText(path, "", newLeaf ? "tab" : false);
	}

	runCommand(id: CommandId): void {
		const commands = (this.app as unknown as { commands: { executeCommandById(id: string): void } }).commands;
		commands.executeCommandById(`project-hub:${id}`);
	}
}

type CommandId = (typeof CMD)[keyof typeof CMD];
