// UI module entry point: header/dashboard code blocks, commands, the My work
// sidebar and the quick-create modals.

import type { Hub } from "../core/hub";
import type { NewItemOptions } from "../core/store";
import { contextDefaults } from "../views/base-helpers";
import { NewItemModal } from "./modals";
import { registerDashboard } from "./dashboard";
import { registerHeader } from "./header";
import { registerCommands } from "./commands";
import { activateMyWork, registerMyWork } from "./sidebar";

export interface UiApi {
	/** Opens the quick-create modal, defaulting to the context of the active note. */
	newItem(defaults?: Partial<NewItemOptions>): void;
}

export function registerUi(hub: Hub): UiApi {
	registerCommands(hub);
	registerHeader(hub);
	registerDashboard(hub);
	registerMyWork(hub);

	hub.plugin.addRibbonIcon("square-kanban", "Project Hub: open home", () => {
		void hub.openPath(hub.settings.homeNote);
	});

	// Open the My work sidebar the first time the plugin runs (never forced later).
	hub.app.workspace.onLayoutReady(() => {
		void activateMyWork(hub);
	});

	return {
		newItem(defaults?: Partial<NewItemOptions>): void {
			const merged: Partial<NewItemOptions> = { ...contextDefaults(hub) };
			for (const [key, value] of Object.entries(defaults ?? {})) {
				if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
			}
			new NewItemModal(hub, merged).open();
		},
	};
}

export { ConfirmModal, NewItemModal } from "./modals";
export { activateMyWork, MY_WORK_VIEW, openMyWork } from "./sidebar";
