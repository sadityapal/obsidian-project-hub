import type { App } from "obsidian";
import type { HubStore } from "./store";
import type { StatusCategory, WorkItem } from "./model";
import { today } from "./util";

/**
 * Change log of every work item, used by burndown, burnup, CFD and velocity charts.
 *
 * Each item (keyed by its stable `id`) holds entries `[date, status, points, sprint, project]`,
 * appended whenever one of those values changes. `sprint` and `project` are note basenames so
 * renaming folders does not break history. Items with no entries fall back to their
 * created / started / closed dates.
 */
export type HistoryEntry = [date: string, status: string, points: number | null, sprint: string | null, project: string | null];

interface HistoryFile {
	version: 1;
	items: Record<string, HistoryEntry[]>;
}

export interface ItemState {
	status: string;
	category: StatusCategory;
	points: number | null;
	sprint: string | null;
	project: string | null;
}

export class HistoryStore {
	private data: HistoryFile = { version: 1, items: {} };
	private dirty = false;
	private saveTimer: number | null = null;

	constructor(
		private app: App,
		private store: HubStore,
		private file: string,
	) {}

	async load(): Promise<void> {
		try {
			if (await this.app.vault.adapter.exists(this.file)) {
				const parsed = JSON.parse(await this.app.vault.adapter.read(this.file));
				if (parsed && parsed.version === 1 && parsed.items) this.data = parsed;
			}
		} catch (e) {
			console.error("Project Hub: could not read history", e);
		}
	}

	/** Appends today's state for every item whose tracked values changed. */
	record(): void {
		const t = today();
		for (const it of this.store.items.values()) {
			if (!it.id) continue;
			const entry = this.entryFor(it, t);
			const list = this.data.items[it.id] ?? (this.data.items[it.id] = []);
			const last = list[list.length - 1];
			if (last && sameState(last, entry)) continue;
			if (last && last[0] === t) list[list.length - 1] = entry;
			else list.push(entry);
			this.dirty = true;
		}
		if (this.dirty) this.saveSoon();
	}

	private entryFor(it: WorkItem, date: string): HistoryEntry {
		const project = this.store.effectiveProject(it);
		return [
			date,
			it.status,
			it.points,
			it.sprint ? this.store.displayName(it.sprint) : null,
			project ? this.store.displayName(project) : null,
		];
	}

	/** State of an item at the end of `date`, or null if it did not exist yet. */
	stateAt(it: WorkItem, date: string): ItemState | null {
		const list = it.id ? this.data.items[it.id] : undefined;
		const created = it.created ?? today();
		if (date < created) return null;
		let hit: HistoryEntry | null = null;
		if (list) for (const e of list) if (e[0] <= date) hit = e;
		if (hit) {
			return { status: hit[1], category: this.store.statusCategory(hit[1]), points: hit[2], sprint: hit[3], project: hit[4] };
		}
		// No recorded history at that date: derive from lifecycle stamps and current values.
		const cur = this.entryFor(it, date);
		let category: StatusCategory = "proposed";
		if (it.closed && date >= it.closed) category = this.store.statusCategory(it.status) === "removed" ? "removed" : "completed";
		else if (it.started && date >= it.started) category = "inProgress";
		const status = category === this.store.statusCategory(it.status) ? it.status : this.store.statusFor(category);
		// Before the first entry the sprint/project are unknown; assume the earliest recorded or current.
		const first = list?.[0];
		return {
			status,
			category,
			points: first ? first[2] : cur[2],
			sprint: first ? first[3] : cur[3],
			project: first ? first[4] : cur[4],
		};
	}

	/** Drops history of items that no longer exist (call rarely). */
	prune(): void {
		const live = new Set([...this.store.items.values()].map((i) => i.id));
		for (const id of Object.keys(this.data.items)) {
			if (!live.has(id)) {
				delete this.data.items[id];
				this.dirty = true;
			}
		}
		if (this.dirty) this.saveSoon();
	}

	private saveSoon(): void {
		if (this.saveTimer !== null) return;
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.save();
		}, 2000);
	}

	async save(): Promise<void> {
		if (!this.dirty) return;
		this.dirty = false;
		try {
			await this.app.vault.adapter.write(this.file, JSON.stringify(this.data));
		} catch (e) {
			this.dirty = true;
			console.error("Project Hub: could not write history", e);
		}
	}
}

function sameState(a: HistoryEntry, b: HistoryEntry): boolean {
	return a[1] === b[1] && a[2] === b[2] && a[3] === b[3] && a[4] === b[4];
}
