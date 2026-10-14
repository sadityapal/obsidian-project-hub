import { BasesEntry, BasesPropertyId, BasesView, TFile } from "obsidian";
import type { Hub } from "../core/hub";
import type { NewItemOptions } from "../core/store";
import type { WorkItem } from "../core/model";

// Helpers shared by the custom Bases views (board, timeline, backlog tree).

/** Frontmatter properties that the item cards already render, so "extra properties" skips them. */
export const STANDARD_PROPS = new Set<string>([
	"note.kind",
	"note.id",
	"note.title",
	"note.type",
	"note.status",
	"note.priority",
	"note.assignee",
	"note.project",
	"note.parent",
	"note.sprint",
	"note.start",
	"note.due",
	"note.points",
	"note.labels",
	"note.blocked_by",
	"note.progress",
	"note.rank",
	"note.ado_id",
	"note.ado_url",
	"note.ado_sync",
	"file.name",
	"file.basename",
]);

export interface ViewRows {
	/** Work items in the order Bases returned them (filters + sort applied). */
	items: WorkItem[];
	/** Entries that are not work items (shown as plain cards / rows where it makes sense). */
	others: BasesEntry[];
	/** Lookup of the Bases entry for a work item path, for rendering extra properties. */
	entryOf: Map<string, BasesEntry>;
}

export function viewRows(hub: Hub, view: BasesView): ViewRows {
	const items: WorkItem[] = [];
	const others: BasesEntry[] = [];
	const entryOf = new Map<string, BasesEntry>();
	for (const entry of view.data?.data ?? []) {
		const it = hub.store.getItem(entry.file.path);
		if (it) {
			items.push(it);
			entryOf.set(it.path, entry);
		} else others.push(entry);
	}
	return { items, others, entryOf };
}

/** Properties chosen in the Bases "Properties" menu that are not already part of the card. */
export function extraProps(view: BasesView): BasesPropertyId[] {
	return (view.config.getOrder() ?? []).filter((p) => !STANDARD_PROPS.has(p));
}

/** Renders `label: value` rows for extra properties of an entry. Empty values are skipped. */
export function renderExtraProps(hub: Hub, view: BasesView, entry: BasesEntry | undefined, el: HTMLElement): void {
	if (!entry) return;
	for (const prop of extraProps(view)) {
		const value = entry.getValue(prop);
		if (!value || !value.isTruthy() || value.toString().trim() === "") continue;
		const row = el.createDiv({ cls: "ph-extra-prop" });
		row.createSpan({ cls: "ph-extra-prop-name", text: view.config.getDisplayName(prop) });
		value.renderTo(row.createSpan({ cls: "ph-extra-prop-value" }), hub.app.renderContext);
	}
}

/**
 * Defaults for items created from inside a view, taken from the note the view is
 * embedded in (project, sprint, person or parent item). Standalone .base files give none.
 */
export function contextDefaults(hub: Hub): Partial<NewItemOptions> {
	const file: TFile | null = hub.app.workspace.getActiveFile();
	if (!file || file.extension !== "md") return {};
	const e = hub.store.getEntity(file.path);
	if (!e) return {};
	switch (e.kind) {
		case "project":
			return { project: e.path };
		case "sprint":
			return { sprint: e.path };
		case "person":
			return { assignee: e.path };
		case "work-item": {
			const child = hub.store.typeDef(e.type)?.child;
			return { parent: e.path, project: hub.store.effectiveProject(e), ...(child ? { type: child } : {}) };
		}
	}
}

/** Fractional rank between two neighbours, used for manual ordering after a drop. */
export function rankBetween(before: number | null, after: number | null): number {
	if (before === null && after === null) return 1000;
	if (before === null) return after! - 1000;
	if (after === null) return before + 1000;
	return (before + after) / 2;
}

/**
 * Ranks for a column after moving `moved` to index `to`. Returns only the paths whose rank must
 * change. Existing ranks are kept when possible; a full renumber happens when ranks are missing
 * or too close together.
 */
export function rerank(ordered: WorkItem[], moved: WorkItem, to: number): Map<string, number> {
	const rest = ordered.filter((i) => i.path !== moved.path);
	const idx = Math.max(0, Math.min(to, rest.length));
	const final = [...rest.slice(0, idx), moved, ...rest.slice(idx)];
	const out = new Map<string, number>();
	const before = idx > 0 ? final[idx - 1].rank : null;
	const after = idx < final.length - 1 ? final[idx + 1].rank : null;
	const neighboursOk = (idx === 0 || before !== null) && (idx === final.length - 1 || after !== null);
	if (neighboursOk) {
		const r = rankBetween(before, after);
		const gapOk = (before === null || r - before > 1e-6) && (after === null || after - r > 1e-6);
		if (gapOk) {
			if (moved.rank !== r) out.set(moved.path, r);
			return out;
		}
	}
	final.forEach((it, i) => {
		const r = (i + 1) * 1000;
		if (it.rank !== r) out.set(it.path, r);
	});
	return out;
}

/** Sort by manual rank (unranked last, keeping their incoming order). */
export function byRank(items: WorkItem[]): WorkItem[] {
	return items
		.map((it, i) => ({ it, i }))
		.sort((a, b) => {
			const ra = a.it.rank;
			const rb = b.it.rank;
			if (ra !== null && rb !== null) return ra - rb || a.i - b.i;
			if (ra !== null) return -1;
			if (rb !== null) return 1;
			return a.i - b.i;
		})
		.map((x) => x.it);
}
