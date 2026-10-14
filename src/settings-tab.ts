// Settings tab: General, Folders, Statuses and Types. There is no Azure DevOps
// section — Project Hub is a local-only workspace, so everything here configures
// the vault-side behaviour.

import { App, PluginSettingTab, Setting } from "obsidian";
import type ProjectHubPlugin from "./main";
import { PALETTE_ORDER, PROJECT_STATUSES, type PaletteColor, type StatusCategory } from "./core/model";

const CATEGORIES: { label: string; value: StatusCategory }[] = [
	{ label: "Proposed", value: "proposed" },
	{ label: "In progress", value: "inProgress" },
	{ label: "Resolved", value: "resolved" },
	{ label: "Completed", value: "completed" },
	{ label: "Removed", value: "removed" },
];

const COLORS: { label: string; value: PaletteColor }[] = [...PALETTE_ORDER, "gray" as PaletteColor].map((c) => ({
	label: c[0].toUpperCase() + c.slice(1),
	value: c,
}));

export class HubSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: ProjectHubPlugin,
	) {
		super(app, plugin);
	}

	get settings() {
		return this.plugin.settings;
	}

	private async save(): Promise<void> {
		await this.plugin.saveSettings();
	}

	display(): void {
		this.containerEl.empty();
		this.containerEl.addClass("ph-settings");

		this.general();
		this.folders();
		this.statuses();
		this.types();
	}

	// ---------------------------------------------------------------- general

	private general(): void {
		this.containerEl.createEl("h3", { text: "General" });
		const s = this.settings;

		new Setting(this.containerEl)
			.setName("Me")
			.setDesc("Person note that represents you. Drives “My work”, the assignee filters and default assignment.")
			.addDropdown((dd) => {
				dd.addOption("", "Not set");
				for (const person of this.plugin.store.people.values()) dd.addOption(person.basename, person.name);
				dd.setValue(s.me).onChange(async (v) => {
					s.me = v;
					await this.save();
				});
			});

		new Setting(this.containerEl)
			.setName("Home note")
			.setDesc("Note opened on startup and by Project Hub: Open home.")
			.addText((t) =>
				t.setPlaceholder("Home.md")
					.setValue(s.homeNote)
					.onChange(async (v) => {
						s.homeNote = v.trim() || "Home.md";
						await this.save();
					}),
			);

		new Setting(this.containerEl)
			.setName("Open home on startup")
			.setDesc("Open the home note when the vault loads and the workspace is empty.")
			.addToggle((t) =>
				t.setValue(s.openHomeOnStartup).onChange(async (v) => {
					s.openHomeOnStartup = v;
					await this.save();
				}),
			);

		new Setting(this.containerEl)
			.setName("Work item ID prefix")
			.setDesc("Prefix for locally created work items, e.g. PH in PH-12.")
			.addText((t) =>
				t.setValue(s.idPrefix).onChange(async (v) => {
					s.idPrefix = v.trim() || "PH";
					await this.save();
				}),
			);

		new Setting(this.containerEl)
			.setName("Next ID")
			.setDesc("Number used for the next created item. Raise it when merging vaults.")
			.addText((t) =>
				t.setValue(String(s.nextId)).onChange(async (v) => {
					const n = Number(v.replace(/[^0-9]/g, ""));
					s.nextId = isFinite(n) && n > 0 ? n : s.nextId;
					await this.save();
				}),
			);

		new Setting(this.containerEl)
			.setName("Rename files on title change")
			.setDesc("Keep “PH-12 <title>” basenames in sync with the title frontmatter.")
			.addToggle((t) =>
				t.setValue(s.renameOnTitleChange).onChange(async (v) => {
					s.renameOnTitleChange = v;
					await this.save();
				}),
			);

		new Setting(this.containerEl)
			.setName("Stamp started/closed dates")
			.setDesc("Fill started when an item moves to in-progress, and closed when it completes.")
			.addToggle((t) =>
				t.setValue(s.stampDates).onChange(async (v) => {
					s.stampDates = v;
					await this.save();
				}),
			);

		new Setting(this.containerEl)
			.setName("Write rollups")
			.setDesc("Write progress/counts into project and parent notes so Bases views can show them.")
			.addToggle((t) =>
				t.setValue(s.writeRollups).onChange(async (v) => {
					s.writeRollups = v;
					await this.save();
				}),
			);

		new Setting(this.containerEl)
			.setName("Default sprint length (days)")
			.addText((t) =>
				t.setValue(String(s.sprintLengthDays)).onChange(async (v) => {
					const n = Number(v.replace(/[^0-9]/g, ""));
					if (isFinite(n) && n >= 1) s.sprintLengthDays = n;
					await this.save();
				}),
			);

		new Setting(this.containerEl)
			.setName("Default work item type")
			.addDropdown((dd) => {
				for (const t of s.types) dd.addOption(t.name, t.name);
				dd.setValue(s.types.some((t) => t.name === s.defaultType) ? s.defaultType : s.types[0]?.name ?? "");
				dd.onChange(async (v) => {
					s.defaultType = v;
					await this.save();
				});
			});
	}

	// ---------------------------------------------------------------- folders

	private folders(): void {
		this.containerEl.createEl("h3", { text: "Folders" });
		const f = this.settings.folders;
		const rows: [string, keyof typeof f][] = [
			["Work items", "items"],
			["Projects", "projects"],
			["Sprints", "sprints"],
			["People", "people"],
			["Meetings", "meetings"],
			["Templates", "templates"],
		];
		for (const [label, key] of rows) {
			new Setting(this.containerEl)
				.setName(label)
				.addText((t) =>
					t.setValue(f[key]).onChange(async (v) => {
						f[key] = v.trim().replace(/^\/+|\/+$/g, "") || f[key];
						await this.save();
					}),
				);
		}
	}

	// ---------------------------------------------------------------- statuses

	private statuses(): void {
		this.containerEl.createEl("h3", { text: "Statuses" });
		this.containerEl.createEl("p", {
			text: "Board columns, the status pill colours and the burndown/cycle-time math all read this list. The category groups statuses together — keep them inside a category rather than inventing new ones.",
			cls: "ph-settings-hint",
		});
		const list = this.containerEl.createDiv({ cls: "ph-settings-statuses" });
		const statuses = this.settings.statuses;

		const render = () => {
			list.empty();
			statuses.forEach((def, i) => {
				const row = list.createDiv({ cls: "ph-settings-status" });

				new Setting(row).setName("Name").addText((t) =>
					t.setValue(def.name).onChange(async (v) => {
						const name = v.trim();
						if (!name || statuses.some((d, j) => j !== i && d.name === name)) return;
						def.name = name;
						await this.save();
					}),
				);

				new Setting(row).setName("Category").addDropdown((dd) => {
					for (const c of CATEGORIES) dd.addOption(c.value, c.label);
					dd.setValue(def.category).onChange(async (v) => {
						def.category = v as StatusCategory;
						await this.save();
					});
				});

				new Setting(row).setName("Colour").addDropdown((dd) => {
					for (const c of COLORS) dd.addOption(c.value, c.label);
					dd.setValue(def.color).onChange(async (v) => {
						def.color = v as PaletteColor;
						await this.save();
					});
				});

				new Setting(row).setName("Blocked").setDesc("Marks work that cannot proceed.").addToggle((t) =>
					t.setValue(def.blocked === true).onChange(async (v) => {
						def.blocked = v || undefined;
						await this.save();
					}),
				);

				new Setting(row)
					.setName("WIP limit")
					.setDesc("Board column warns above this many cards. 0 = no limit.")
					.addText((t) =>
						t.setValue(String(this.settings.wipLimits[def.name] ?? 0)).onChange(async (v) => {
							const n = Number(v.replace(/[^0-9]/g, ""));
							if (isFinite(n) && n >= 0) {
								if (n > 0) this.settings.wipLimits[def.name] = n;
								else delete this.settings.wipLimits[def.name];
								await this.save();
							}
						}),
					);

				const actions = row.createDiv({ cls: "ph-settings-actions" });
				const up = actions.createEl("button", { cls: "ph-settings-move", attr: { type: "button", "aria-label": "Move up" }, text: "↑" });
				up.disabled = i === 0;
				up.addEventListener("click", async () => {
					if (i === 0) return;
					[statuses[i - 1], statuses[i]] = [statuses[i], statuses[i - 1]];
					await this.save();
					render();
				});
				const down = actions.createEl("button", { cls: "ph-settings-move", attr: { type: "button", "aria-label": "Move down" }, text: "↓" });
				down.disabled = i === statuses.length - 1;
				down.addEventListener("click", async () => {
					if (i === statuses.length - 1) return;
					[statuses[i + 1], statuses[i]] = [statuses[i], statuses[i + 1]];
					await this.save();
					render();
				});
				const del = actions.createEl("button", { cls: "ph-settings-move ph-settings-delete", attr: { type: "button", "aria-label": "Remove" }, text: "✕" });
				del.disabled = statuses.length <= 2;
				del.addEventListener("click", async () => {
					if (statuses.length <= 2) return;
					statuses.splice(i, 1);
					delete this.settings.wipLimits[def.name];
					await this.save();
					render();
				});
			});
		};

		render();

		new Setting(this.containerEl).addButton((b) =>
			b.setButtonText("Add status").onClick(async () => {
				const used = new Set(statuses.map((s) => s.name));
				let n = statuses.length + 1;
				let name = `Status ${n}`;
				while (used.has(name)) name = `Status ${++n}`;
				statuses.push({ name, category: "proposed", color: COLORS[statuses.length % (COLORS.length - 1)].value });
				await this.save();
				render();
			}),
		);
	}

	// ---------------------------------------------------------------- types

	private types(): void {
		this.containerEl.createEl("h3", { text: "Work item types" });
		this.containerEl.createEl("p", {
			text: "The hierarchy uses the child type: “Add child item” on an Epic creates a Feature. The icon is any Lucide name.",
			cls: "ph-settings-hint",
		});
		const list = this.containerEl.createDiv({ cls: "ph-settings-types" });
		const types = this.settings.types;
		const names = () => types.map((t) => t.name);

		const render = () => {
			list.empty();
			types.forEach((def, i) => {
				const row = list.createDiv({ cls: "ph-settings-type" });

				new Setting(row).setName("Name").addText((t) =>
					t.setValue(def.name).onChange(async (v) => {
						const name = v.trim();
						if (!name || types.some((d, j) => j !== i && d.name === name)) return;
						def.name = name;
						await this.save();
					}),
				);

				new Setting(row).setName("Icon").setDesc("Lucide icon name.").addText((t) =>
					t.setValue(def.icon).onChange(async (v) => {
						def.icon = v.trim() || "square";
						await this.save();
					}),
				);

				new Setting(row)
					.setName("Child type")
					.setDesc("Used by “Add child item”.")
					.addDropdown((dd) => {
						dd.addOption("", "None");
						for (const name of names()) if (name !== def.name) dd.addOption(name, name);
						dd.setValue(def.child ?? "").onChange(async (v) => {
							def.child = v || undefined;
							await this.save();
						});
					});

				const actions = row.createDiv({ cls: "ph-settings-actions" });
				const del = actions.createEl("button", { cls: "ph-settings-move ph-settings-delete", attr: { type: "button", "aria-label": "Remove" }, text: "✕" });
				del.disabled = types.length <= 2;
				del.addEventListener("click", async () => {
					if (types.length <= 2) return;
					types.splice(i, 1);
					if (!types.some((t) => t.name === this.settings.defaultType)) this.settings.defaultType = types[0].name;
					await this.save();
					render();
				});
			});
		};

		render();

		new Setting(this.containerEl).addButton((b) =>
			b.setButtonText("Add type").onClick(async () => {
				const used = new Set(names());
				let n = types.length + 1;
				let name = `Type ${n}`;
				while (used.has(name)) name = `Type ${++n}`;
				types.push({ name, icon: "square", ado: [] });
				await this.save();
				render();
			}),
		);

		this.containerEl.createEl("h3", { text: "Project statuses" });
		this.containerEl.createEl("p", { text: `Used by project notes: ${PROJECT_STATUSES.join(", ")}.`, cls: "ph-settings-hint" });
	}
}
