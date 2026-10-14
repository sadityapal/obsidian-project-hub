// Kanban board as a custom Bases view ("ph-board").
//
// The card interactions in this file (selection, context menu, quick create,
// keyboard) are shared with the backlog tree, which imports them from here.

import { App, BasesView, Menu, Modal, Notice, QueryController, debounce, setIcon, setTooltip } from "obsidian";
import type { BasesAllOptions } from "obsidian";
import type { Hub } from "../core/hub";
import { P, PRIORITIES, type PaletteColor, type WorkItem } from "../core/model";
import { type ViewRows, byRank, contextDefaults, renderExtraProps, rerank, viewRows } from "./base-helpers";
import type { NewItemOptions } from "../core/store";
import {
	avatar,
	chip,
	dueChip,
	pointsChip,
	priorityBadge,
	priorityMenu,
	progressBar,
	statusMenu,
	typeBadge,
} from "../ui/widgets";
import { pickItem, pickPerson, pickProject, pickSprint } from "../ui/pickers";
import { plural } from "../core/util";

// ---------------------------------------------------------------- view model

const COLUMN_FIELDS = ["status", "assignee", "priority", "type", "sprint", "project"] as const;
type ColumnField = (typeof COLUMN_FIELDS)[number];
type LaneField = ColumnField | "parent" | "none";

const DAY_MS = 86_400_000;

interface Spec {
	value: string | null;
	label: string;
	sub?: string;
	icon?: string;
	color?: PaletteColor;
	limit?: number;
}

interface ColumnSpec extends Spec {
	key: string;
	field: ColumnField;
	items: WorkItem[];
}

interface LaneSpec extends Spec {
	key: string;
	field: LaneField;
}

interface BoardModel {
	rows: ViewRows;
	visible: WorkItem[];
	columns: ColumnSpec[];
	lanes: LaneSpec[];
	cells: Map<string, WorkItem[]>;
	points: number;
}

export interface BoardOptions {
	columnsBy: ColumnField;
	swimlanesBy: LaneField;
	showDone: string;
	hideEmptyColumns: boolean;
	cardSize: string;
	showWip: boolean;
	showSubtaskProgress: boolean;
}

function columnKey(field: string, value: string | null): string {
	return `${field}:${value ?? "none"}`;
}

function fieldValue(item: WorkItem, field: LaneField): string | null {
	switch (field) {
		case "status":
			return item.status;
		case "assignee":
			return item.assignee ?? null;
		case "priority":
			return item.priority === null ? null : String(item.priority);
		case "type":
			return item.type;
		case "sprint":
			return item.sprint;
		case "project":
			return item.project;
		case "parent":
			return item.parent;
		case "none":
			return null;
	}
}

const WRITABLE: Record<LaneField, string | null> = {
	status: P.status,
	assignee: P.assignee,
	priority: P.priority,
	type: P.type,
	sprint: P.sprint,
	project: P.project,
	parent: P.parent,
	none: null,
};

function readString(view: BasesView, key: string, fallback: string, allowed?: readonly string[]): string {
	const v = view.config.get(key);
	if (typeof v === "string" && (!allowed || allowed.includes(v))) return v;
	return fallback;
}

function readBool(view: BasesView, key: string, fallback: boolean): boolean {
	const v = view.config.get(key);
	return typeof v === "boolean" ? v : fallback;
}

function readList(view: BasesView, key: string): string[] {
	const v = view.config.get(key);
	if (!Array.isArray(v)) return [];
	return v.filter((x): x is string => typeof x === "string");
}

function isRecentlyDone(hub: Hub, item: WorkItem): boolean {
	if (!hub.store.isDone(item)) return false;
	const stamp = item.closed ? Date.parse(`${item.closed}T00:00:00`) : item.mtime;
	return Date.now() - stamp <= 14 * DAY_MS;
}

function sortCell(items: WorkItem[]): WorkItem[] {
	return byRank(items).sort(
		(a, b) => (a.priority ?? 9) - (b.priority ?? 9) || a.id.localeCompare(b.id, undefined, { numeric: true }),
	);
}

function quotePath(path: string): string {
	return path.replace(/["\\]/g, "\\$&");
}

// ---------------------------------------------------------------- shared actions

/** Multi-select model shared by the board cards and the backlog rows. */
export class ItemSelection {
	private readonly selected = new Set<string>();
	private anchor: string | null = null;

	constructor(
		private readonly hub: Hub,
		private readonly onChange: () => void,
	) {}

	get size(): number {
		return this.selected.size;
	}

	has(path: string): boolean {
		return this.selected.has(path);
	}

	paths(): string[] {
		return [...this.selected];
	}

	items(): WorkItem[] {
		return this.paths()
			.map((p) => this.hub.store.getItem(p))
			.filter((i): i is WorkItem => !!i);
	}

	clear(): void {
		if (!this.selected.size) return;
		this.selected.clear();
		this.anchor = null;
		this.onChange();
	}

	replace(path: string): void {
		this.selected.clear();
		this.selected.add(path);
		this.anchor = path;
		this.onChange();
	}

	toggle(path: string): void {
		if (this.selected.has(path)) this.selected.delete(path);
		else this.selected.add(path);
		this.anchor = path;
		this.onChange();
	}

	/** Shift-click range selection over `order`, the visible paths in DOM order. */
	range(order: string[], path: string): void {
		const from = this.anchor && order.includes(this.anchor) ? order.indexOf(this.anchor) : order.indexOf(path);
		const to = order.indexOf(path);
		this.selected.clear();
		for (let i = Math.min(from, to); i <= Math.max(from, to); i++) this.selected.add(order[i]);
		this.anchor = path;
		this.onChange();
	}

	/** Updates the selection for a click and returns the paths to act on. */
	resolveClick(order: string[], path: string, evt: MouseEvent): string[] {
		if (evt.shiftKey) this.range(order, path);
		else if (evt.ctrlKey || evt.metaKey) this.toggle(path);
		else if (!this.selected.has(path)) this.replace(path);
		return this.paths();
	}

	/** Same, for keyboard activation without modifiers. */
	resolveKey(path: string): WorkItem[] {
		if (!this.selected.has(path)) this.replace(path);
		return this.items();
	}
}

function confirmAction(app: App, title: string, message: string, cta = "Delete"): Promise<boolean> {
	return new Promise((resolve) => {
		const modal = new Modal(app);
		let settled = false;
		const finish = (value: boolean) => {
			if (settled) return;
			settled = true;
			resolve(value);
			modal.close();
		};
		modal.setTitle(title);
		modal.contentEl.createDiv({ cls: "ph-confirm-message", text: message });
		const row = modal.contentEl.createDiv({ cls: "ph-confirm-buttons" });
		row.createEl("button", { cls: "ph-btn", text: "Cancel" }).addEventListener("click", () => finish(false));
		row.createEl("button", { cls: "ph-btn mod-cta ph-btn-destructive", text: cta }).addEventListener("click", () => finish(true));
		modal.onClose = () => finish(false);
		modal.open();
		(row.lastElementChild as HTMLElement | null)?.focus();
	});
}

export async function trashItems(hub: Hub, items: WorkItem[]): Promise<void> {
	if (!items.length) return;
	const label = items.length === 1 ? `“${items[0].title}”` : `${items.length} items`;
	const ok = await confirmAction(
		hub.app,
		items.length === 1 ? "Delete work item" : "Delete work items",
		`${label} will be moved to Obsidian's trash. Linked Azure DevOps items are not changed.`,
		"Delete",
	);
	if (!ok) return;
	for (const item of items) {
		const file = hub.app.vault.getFileByPath(item.path);
		if (!file) continue;
		try {
			await hub.app.fileManager.trashFile(file);
		} catch (e) {
			new Notice(`Project Hub: could not delete ${item.id} — ${e instanceof Error ? e.message : String(e)}`);
		}
	}
}

export function copyItemLink(hub: Hub, path: string): void {
	const link = hub.store.linkTo(path).replace(/^\[\[|\]\]$/g, "");
	void navigator.clipboard?.writeText(`[[${link}]]`).catch(() => undefined);
	new Notice(`Copied link to ${hub.store.displayName(path)}`);
}

/** Context menu shared by the board cards, the backlog rows and keyboard activation. */
export function showItemMenu(hub: Hub, evt: MouseEvent, items: WorkItem[]): void {
	if (!items.length) return;
	const single = items.length === 1 ? items[0] : null;
	const menu = new Menu();

	menu.addItem((mi) => mi.setTitle("Open").setIcon("arrow-up-right").onClick(() => void hub.openPath(items[0].path)));
	menu.addItem((mi) => mi.setTitle("Open in new tab").setIcon("external-link").onClick(() => void hub.openPath(items[0].path, true)));
	if (single) {
		menu.addItem((mi) =>
			mi
				.setTitle("Open in split pane")
				.setIcon("columns-2")
				.onClick(() => {
					const file = hub.app.vault.getFileByPath(single.path);
					if (file) void hub.app.workspace.getLeaf("split").openFile(file);
				}),
		);
	}
	menu.addSeparator();
	menu.addItem((mi) =>
		mi
			.setTitle(items.length > 1 ? `Set status (${items.length})…` : "Set status…")
			.setIcon("circle-dot")
			.onClick((e) => statusMenu(hub, e as MouseEvent, items)),
	);
	menu.addItem((mi) =>
		mi
			.setTitle(items.length > 1 ? `Set priority (${items.length})…` : "Set priority…")
			.setIcon("signal")
			.onClick((e) => priorityMenu(hub, e as MouseEvent, items)),
	);
	menu.addItem((mi) =>
		mi
			.setTitle(items.length > 1 ? `Assign (${items.length})…` : "Assign…")
			.setIcon("user")
			.onClick(async () => {
				const target = await pickPerson(hub);
				if (target === undefined) return;
				for (const it of items) await hub.store.setLink(it.path, P.assignee, target);
			}),
	);
	menu.addItem((mi) =>
		mi.setTitle("Move to sprint…").setIcon("milestone").onClick(async () => {
			const target = await pickSprint(hub, { includePast: false });
			if (target === undefined) return;
			for (const it of items) await hub.store.setLink(it.path, P.sprint, target);
		}),
	);
	menu.addItem((mi) =>
		mi.setTitle("Set project…").setIcon("folder").onClick(async () => {
			const target = await pickProject(hub);
			if (target === undefined) return;
			for (const it of items) await hub.store.setLink(it.path, P.project, target);
		}),
	);
	menu.addItem((mi) =>
		mi.setTitle("Set parent…").setIcon("git-branch").onClick(async () => {
			const first = items[0];
			const banned = new Set<string>([first.path, ...hub.store.descendants(first.path).map((d) => d.path)]);
			const target = await pickItem(hub, { exclude: banned, allowNone: true, placeholder: "Parent work item…" });
			if (target === undefined) return;
			for (const it of items) await hub.store.setLink(it.path, P.parent, target);
		}),
	);
	menu.addSeparator();
	if (single) {
		menu.addItem((mi) =>
			mi
				.setTitle("Add child item")
				.setIcon("plus")
				.onClick(() => {
					const child = hub.store.typeDef(single.type)?.child;
					hub.newItem({
						parent: single.path,
						project: hub.store.effectiveProject(single),
						type: child,
						status: hub.store.statusFor("proposed"),
					});
				}),
		);
	}
	menu.addItem((mi) => mi.setTitle("Copy link").setIcon("link").onClick(() => copyItemLink(hub, items[0].path)));
	menu.addSeparator();
	menu.addItem((mi) =>
		mi
			.setTitle(items.length > 1 ? `Delete ${items.length} items` : "Delete")
			.setIcon("trash-2")
			.setWarning(true)
			.onClick(() => void trashItems(hub, items)),
	);
	menu.showAtMouseEvent(evt);
}

/** Writes one grouping field for an item; returns true when something changed. */
export async function writeField(hub: Hub, item: WorkItem, field: LaneField, value: string | null): Promise<boolean> {
	const key = WRITABLE[field];
	if (!key) return false;
	if (fieldValue(item, field) === value) return false;
	if (field === "status") {
		await hub.store.setStatus(item.path, value ?? hub.store.statusFor("proposed"));
	} else if (field === "priority") {
		await hub.store.update(item.path, { [P.priority]: value === null ? null : Number(value) });
	} else {
		await hub.store.setLink(item.path, key, value);
	}
	return true;
}

/** Focuses a card (or backlog row) after a re-render so keyboard users keep their place. */
export function focusCell(root: HTMLElement | null, selector: string, path: string | null): void {
	if (!path || !root) return;
	root.querySelector<HTMLElement>(`${selector}[data-path="${quotePath(path)}"]`)?.focus();
}

/** Insertion index for a drop at client y, ignoring the cards being dragged. */
function indexAt(cards: HTMLElement[], y: number, dragging: string[]): number {
	const list = cards.filter((c) => !dragging.includes(c.dataset.path ?? ""));
	for (let i = 0; i < list.length; i++) {
		const rect = list[i].getBoundingClientRect();
		if (y < rect.top + rect.height / 2) return i;
	}
	return list.length;
}

// ---------------------------------------------------------------- board view

export class BoardView extends BasesView {
	readonly type = "ph-board";

	private root: HTMLElement | null = null;
	private columnsEl: HTMLElement | null = null;
	private searchEl: HTMLInputElement | null = null;
	private peopleEl: HTMLElement | null = null;
	private togglesEl: HTMLElement | null = null;
	private countEl: HTMLElement | null = null;
	private filterEl: HTMLElement | null = null;
	private onlyMineBtn: HTMLElement | null = null;
	private blockedBtn: HTMLElement | null = null;
	private dropLine: HTMLElement | null = null;

	private opts!: BoardOptions;
	private stateLoaded = false;
	private model: BoardModel = {
		rows: { items: [], others: [], entryOf: new Map() },
		visible: [],
		columns: [],
		lanes: [],
		cells: new Map(),
		points: 0,
	};
	private selection = new ItemSelection(this.hub, () => this.paintSelection());
	private drag: { paths: string[] } | null = null;

	private search = "";
	private onlyMine = false;
	private blockedOnly = false;
	private peopleFilter = new Set<string>();
	private collapsedLanes = new Set<string>();
	private focusPath: string | null = null;
	private paintSoon = debounce(() => this.paint(), 100, true);

	constructor(
		private hub: Hub,
		controller: QueryController,
		private hostEl: HTMLElement,
	) {
		super(controller);
		hostEl.addClass("ph-board-host");
	}

	private readViewState(): void {
		if (this.stateLoaded) return;
		this.stateLoaded = true;
		const ui = this.config.get("ph-ui");
		if (ui && typeof ui === "object") {
			const obj = ui as Record<string, unknown>;
			this.onlyMine = obj.onlyMine === true;
			this.blockedOnly = obj.blockedOnly === true;
			this.peopleFilter = new Set(
				Array.isArray(obj.people) ? obj.people.filter((x): x is string => typeof x === "string") : [],
			);
		}
		this.collapsedLanes = new Set(readList(this, "ph-lanes"));
	}

	onload(): void {
		this.registerEvent(this.hub.store.on("changed", () => this.paintSoon()));
		this.paint();
	}

	onunload(): void {
		this.selection.clear();
	}

	onDataUpdated(): void {
		this.paintSoon();
	}

	// ---------------------------------------------------------------- options

	private persistUi(): void {
		const ui = { onlyMine: this.onlyMine, blockedOnly: this.blockedOnly, people: [...this.peopleFilter] };
		if (JSON.stringify(this.config.get("ph-ui") ?? null) === JSON.stringify(ui)) return;
		this.config.set("ph-ui", ui);
	}

	private setCollapsedLanes(): void {
		const value = [...this.collapsedLanes];
		const current = readList(this, "ph-lanes");
		if (current.length === value.length && current.every((v, i) => v === value[i])) return;
		this.config.set("ph-lanes", value);
	}

	private resetFilters(): void {
		this.search = "";
		if (this.searchEl) this.searchEl.value = "";
		this.onlyMine = false;
		this.blockedOnly = false;
		this.peopleFilter.clear();
		this.persistUi();
		this.paint();
	}

	// ---------------------------------------------------------------- data

	private computeModel(): BoardModel {
		const rows = viewRows(this.hub, this);
		const me = this.hub.store.mePath();
		const query = this.search;
		const peopleActive = this.peopleFilter.size > 0;
		const visible = rows.items.filter((item) => {
			if (this.opts.showDone === "none" && this.hub.store.isDone(item)) return false;
			if (this.opts.showDone === "14d" && this.hub.store.isDone(item) && !isRecentlyDone(this.hub, item)) return false;
			if (this.onlyMine && item.assignee !== me) return false;
			if (this.blockedOnly && !this.hub.store.isBlocked(item)) return false;
			if (peopleActive) {
				const key = item.assignee && this.hub.store.people.has(item.assignee) ? item.assignee : "unassigned";
				if (!this.peopleFilter.has(key)) return false;
			}
			if (query && !`${item.title} ${item.id} ${item.labels.join(" ")} ${item.type}`.toLowerCase().includes(query)) return false;
			return true;
		});

		const columnField = this.opts.columnsBy;
		const columns: ColumnSpec[] = this.buildSpecs(visible, columnField).map((spec) => ({
			...spec,
			key: columnKey(columnField, spec.value),
			field: columnField,
			items: [] as WorkItem[],
		}));
		const byKey = new Map(columns.map((c) => [c.key, c]));
		for (const item of visible) {
			const value = fieldValue(item, columnField);
			const key = columnKey(columnField, value);
			let column = byKey.get(key);
			if (!column) {
				column = { ...this.fallbackSpec(columnField, value), key, field: columnField, items: [] };
				byKey.set(key, column);
				columns.push(column);
			}
			column.items.push(item);
		}
		const shown = this.opts.hideEmptyColumns ? columns.filter((c) => c.items.length) : columns;

		const laneField = this.opts.swimlanesBy;
		const lanes: LaneSpec[] =
			laneField === "none"
				? [{ key: "all", label: "", field: "none", value: null }]
				: this.buildSpecs(visible, laneField).map((spec) => ({
						...spec,
						key: columnKey(laneField, spec.value),
						field: laneField,
					}));

		const cells = new Map<string, WorkItem[]>();
		for (const lane of lanes) {
			for (const column of shown) {
				const items =
					lane.key === "all"
						? column.items
						: visible.filter((i) => fieldValue(i, lane.field) === lane.value && fieldValue(i, column.field) === column.value);
				cells.set(`${lane.key}|${column.key}`, sortCell(items));
			}
		}
		return { rows, visible, columns: shown, lanes, cells, points: visible.reduce((s, i) => s + (i.points ?? 0), 0) };
	}

	/** Canonical, ordered descriptors for a grouping field. */
	private buildSpecs(items: WorkItem[], field: LaneField): Spec[] {
		const store = this.hub.store;
		const out: Spec[] = [];
		const push = (value: string | null, label: string, extra: Partial<Spec> = {}) => out.push({ value, label, ...extra });
		switch (field) {
			case "status":
				for (const s of store.settings.statuses) {
					if (s.category === "removed") continue;
					if (this.opts.showDone === "none" && s.category === "completed") continue;
					push(s.name, s.name, { color: s.color, limit: store.settings.wipLimits[s.name] ?? 0 });
				}
				break;
			case "assignee": {
				const withWork = new Set(items.filter((i) => i.assignee && store.people.has(i.assignee)).map((i) => i.assignee!));
				for (const p of [...store.people.values()].sort((a, b) => a.name.localeCompare(b.name))) {
					if (withWork.has(p.path)) push(p.path, p.name, { sub: p.email ?? undefined });
				}
				push(null, "Unassigned", { icon: "user" });
				break;
			}
			case "priority":
				for (const p of PRIORITIES) push(String(p.value), p.label, { sub: p.name });
				push(null, "None", { sub: "No priority" });
				break;
			case "type":
				for (const t of store.settings.types) push(t.name, t.name, { icon: t.icon });
				break;
			case "sprint": {
				const seen = new Set<string>();
				const add = (path: string | null, label: string, sub = "") => {
					const key = columnKey("sprint", path);
					if (seen.has(key)) return;
					seen.add(key);
					push(path, label, { sub });
				};
				const current = store.currentSprint();
				if (current) add(current.path, current.name, sprintRange(current));
				for (const s of store.futureSprints()) add(s.path, s.name, sprintRange(s));
				for (const s of store.sortedSprints().filter((s) => s.state === "Past")) add(s.path, s.name, sprintRange(s));
				add(null, "Backlog", "No sprint");
				break;
			}
			case "project": {
				const withWork = new Set(items.filter((i) => i.project && store.projects.has(i.project)).map((i) => i.project!));
				for (const p of [...store.projects.values()].sort((a, b) => a.name.localeCompare(b.name))) {
					if (withWork.has(p.path)) push(p.path, p.name, { sub: p.status });
				}
				push(null, "No project");
				break;
			}
			case "parent": {
				const parents = new Set(items.filter((i) => i.parent).map((i) => i.parent!));
				for (const it of store
					.allItems()
					.filter((i) => parents.has(i.path))
					.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))) {
					push(it.path, `${it.id} ${it.title}`, { sub: it.type });
				}
				push(null, "No parent");
				break;
			}
			case "none":
				push(null, "");
				break;
		}
		return out;
	}

	private fallbackSpec(field: LaneField, value: string | null): Spec {
		const store = this.hub.store;
		if (value === null) {
			return { value, label: field === "assignee" ? "Unassigned" : field === "sprint" ? "Backlog" : field === "project" ? "No project" : "None" };
		}
		if (field === "assignee" || field === "project") return { value, label: store.displayName(value) };
		return { value, label: value };
	}

	// ---------------------------------------------------------------- rendering

	private paint(): void {
		// Options and view state are read from the (fresh) config on every paint.
		this.opts = readOptions(this);
		this.readViewState();
		// Only hand the focus back when it was inside the board: a paint is often
		// caused by the note the user just navigated to.
		const keepFocus = !!this.root?.contains(document.activeElement);
		this.model = this.computeModel();
		this.ensureChrome();
		this.renderColumns();
		this.updateToolbar();
		if (keepFocus) focusCell(this.root, ".ph-board-card", this.focusPath);
	}

	private ensureChrome(): void {
		const host = this.hostEl;
		if (this.root) {
			this.root.dataset.size = this.opts.cardSize;
			return;
		}
		const root = host.createDiv({ cls: "ph-board-view" });
		root.dataset.size = this.opts.cardSize;
		root.toggleClass("is-embedded", !!host.closest(".internal-embed, .markdown-embed, .bases-embed, .embed-block"));
		this.root = root;

		const toolbar = root.createDiv({ cls: "ph-board-toolbar" });
		const search = toolbar.createDiv({ cls: "ph-board-search" });
		setIcon(search.createSpan(), "search");
		const input = search.createEl("input", {
			cls: "ph-board-search-input",
			attr: { type: "text", placeholder: "Search items…", spellcheck: "false" },
		});
		this.searchEl = input;
		this.registerDomEvent(input, "input", () => {
			this.search = input.value.trim().toLowerCase();
			this.paint();
		});
		this.registerDomEvent(input, "keydown", (e) => {
			e.stopPropagation();
			if (e.key === "Escape") {
				input.value = "";
				this.search = "";
				this.paint();
			}
			if (e.key === "Enter") {
				e.preventDefault();
				const first = this.visibleOrder()[0];
				if (first) this.focusCard(first);
			}
		});

		this.peopleEl = toolbar.createDiv({ cls: "ph-board-people" });
		this.togglesEl = toolbar.createDiv({ cls: "ph-board-toggles" });
		this.filterEl = toolbar.createDiv({ cls: "ph-board-filters" });
		this.countEl = toolbar.createDiv({ cls: "ph-board-count" });

		const onlyMine = this.togglesEl.createEl("button", { cls: "ph-board-toggle" });
		this.onlyMineBtn = onlyMine;
		setIcon(onlyMine.createSpan(), "user");
		onlyMine.createSpan({ text: "Only mine" });
		this.registerDomEvent(onlyMine, "click", () => {
			if (!this.hub.store.mePath()) {
				new Notice("Pick your person note in the Project Hub settings (General → Me) to use this filter.");
				return;
			}
			this.onlyMine = !this.onlyMine;
			this.persistUi();
			this.paint();
		});

		const blocked = this.togglesEl.createEl("button", { cls: "ph-board-toggle" });
		this.blockedBtn = blocked;
		setIcon(blocked.createSpan(), "octagon-x");
		blocked.createSpan({ text: "Blocked" });
		this.registerDomEvent(blocked, "click", () => {
			this.blockedOnly = !this.blockedOnly;
			this.persistUi();
			this.paint();
		});

		const clear = this.togglesEl.createEl("button", { cls: "ph-board-toggle ph-board-clear" });
		clear.setAttr("aria-label", "Clear filters");
		setIcon(clear, "x");
		this.registerDomEvent(clear, "click", () => this.resetFilters());

		const columns = root.createDiv({ cls: "ph-board-columns" });
		this.columnsEl = columns;
		this.registerDomEvent(columns, "keydown", (e) => this.onKeydown(e));
		this.registerDomEvent(columns, "click", (e) => this.onClick(e));
		this.registerDomEvent(columns, "contextmenu", (e) => this.onContextMenu(e));
		this.registerDomEvent(columns, "dragstart", (e) => this.onDragStart(e as DragEvent));
		this.registerDomEvent(columns, "dragover", (e) => this.onDragOver(e as DragEvent));
		this.registerDomEvent(columns, "dragleave", (e) => this.onDragLeave(e as DragEvent));
		this.registerDomEvent(columns, "drop", (e) => this.onDrop(e as DragEvent));
		this.registerDomEvent(columns, "dragend", () => this.endDrag());
	}

	private updateToolbar(): void {
		const me = this.hub.store.mePath();
		this.onlyMineBtn?.toggleClass("is-active", this.onlyMine);
		this.blockedBtn?.toggleClass("is-active", this.blockedOnly);
		this.onlyMineBtn?.toggleClass("is-disabled", !me);
		if (this.countEl) {
			const parts = [plural(this.model.visible.length, "item"), `${Math.round(this.model.points)} pts`];
			if (this.model.visible.length !== this.model.rows.items.length) parts.push(`of ${this.model.rows.items.length}`);
			this.countEl.setText(parts.join(" · "));
		}
		if (this.filterEl) {
			const active = this.onlyMine || this.blockedOnly || this.peopleFilter.size > 0 || this.search !== "";
			this.filterEl.toggleClass("is-hidden", !active);
			if (active) {
				this.filterEl.empty();
				this.filterEl.createSpan({ cls: "ph-board-filter-label", text: "Filtered" });
				const reset = this.filterEl.createEl("button", { cls: "ph-board-toggle is-compact" });
				setIcon(reset, "rotate-ccw");
				reset.createSpan({ text: "Reset" });
				reset.addEventListener("click", () => this.resetFilters());
			}
		}
		this.renderPeopleRow();
	}

	private renderPeopleRow(): void {
		const el = this.peopleEl;
		if (!el) return;
		el.empty();
		const store = this.hub.store;
		const pool = new Map<string, string | null>();
		for (const item of this.model.rows.items) {
			if (item.assignee && store.people.has(item.assignee)) pool.set(item.assignee, store.displayName(item.assignee));
			else pool.set("unassigned", null);
		}
		if (pool.size <= 1 && this.peopleFilter.size === 0) {
			el.addClass("is-hidden");
			return;
		}
		el.removeClass("is-hidden");
		el.createSpan({ cls: "ph-board-people-label", text: "People" });
		const order = [...pool.keys()].sort((a, b) => (pool.get(a) ?? "zzz").localeCompare(pool.get(b) ?? "zzz"));
		for (const key of order) {
			const name = pool.get(key) ?? null;
			const btn = el.createEl("button", { cls: "ph-board-person" });
			btn.setAttr("aria-pressed", String(this.peopleFilter.size === 0 || this.peopleFilter.has(key)));
			btn.setAttr("aria-label", name ?? "Unassigned");
			avatar(btn, name, 20);
			if (name) btn.createSpan({ cls: "ph-board-person-name", text: name.split(/\s+/)[0] });
			btn.toggleClass("is-active", this.peopleFilter.has(key));
			btn.addEventListener("click", () => {
				if (this.peopleFilter.has(key)) this.peopleFilter.delete(key);
				else this.peopleFilter.add(key);
				if (this.peopleFilter.size === pool.size) this.peopleFilter.clear();
				this.persistUi();
				this.paint();
			});
		}
	}

	private renderColumns(): void {
		const host = this.columnsEl;
		if (!host) return;
		host.empty();
		this.dropLine = null;
		if (this.model.visible.length === 0) {
			host.appendChild(this.buildEmptyState());
			return;
		}
		const frag = document.createDocumentFragment();
		for (const lane of this.model.lanes) frag.appendChild(this.buildLane(lane));
		if (this.model.rows.others.length > 0) frag.appendChild(this.buildFootnote());
		host.appendChild(frag);
		this.paintSelection();
	}

	private buildFootnote(): HTMLElement {
		const el = createDiv({ cls: "ph-board-foot" });
		const others = this.model.rows.others.length;
		setIcon(el.createSpan(), "info");
		el.createSpan({
			text: `${plural(others, "entry", "entries")} in this view ${others === 1 ? "is" : "are"} not a work item and ${others === 1 ? "is" : "are"} hidden.`,
		});
		return el;
	}

	private buildLane(lane: LaneSpec): HTMLElement {
		const el = createDiv({ cls: "ph-board-lane" });
		el.dataset.lane = lane.key;
		const collapsed = this.collapsedLanes.has(lane.key);
		el.toggleClass("is-collapsed", collapsed);
		const shown = this.model.lanes.length > 1;

		if (lane.label) {
			const head = el.createDiv({ cls: "ph-board-lane-head" });
			setIcon(head.createSpan({ cls: "ph-board-lane-twist" }), collapsed ? "chevron-right" : "chevron-down");
			const name = head.createSpan({ cls: "ph-board-lane-name" });
			if (lane.icon) setIcon(name.createSpan(), lane.icon);
			name.createSpan({ text: lane.label });
			if (lane.sub) head.createSpan({ cls: "ph-board-lane-sub ph-muted", text: lane.sub });
			if (shown) {
				const count = this.model.columns.reduce((n, c) => n + (this.model.cells.get(`${lane.key}|${c.key}`)?.length ?? 0), 0);
				head.createSpan({ cls: "ph-board-lane-count", text: String(count) });
			}
			head.addEventListener("click", () => {
				if (this.collapsedLanes.has(lane.key)) this.collapsedLanes.delete(lane.key);
				else this.collapsedLanes.add(lane.key);
				this.setCollapsedLanes();
				this.paint();
			});
		}

		const body = el.createDiv({ cls: "ph-board-lane-cols" });
		body.toggleClass("is-hidden", collapsed);
		for (const column of this.model.columns) body.appendChild(this.buildColumn(column, lane));
		return el;
	}

	private buildColumn(column: ColumnSpec, lane: LaneSpec): HTMLElement {
		const el = createDiv({ cls: "ph-board-col" });
		// Indices (not keys) in the DOM: keys can contain quotes or spaces.
		el.dataset.ci = String(this.model.columns.indexOf(column));
		el.dataset.li = String(this.model.lanes.indexOf(lane));
		const items = this.model.cells.get(`${lane.key}|${column.key}`) ?? [];
		const points = items.reduce((s, i) => s + (i.points ?? 0), 0);
		if (column.color) el.dataset.phColor = column.color;

		const head = el.createDiv({ cls: "ph-board-col-head" });
		const mark = head.createSpan({ cls: "ph-board-col-mark" });
		if (column.field === "status") mark.addClass("has-dot");
		else if (column.icon) setIcon(mark, column.icon);
		const title = head.createSpan({ cls: "ph-board-col-title", text: column.label });
		title.setAttr("title", column.label);
		if (column.sub) {
			const sub = head.createSpan({ cls: "ph-board-col-sub", text: column.sub });
			sub.setAttr("title", column.sub);
		}
		head.createSpan({ cls: "ph-board-col-count", text: String(items.length) });

		if (this.opts.showWip && (column.limit ?? 0) > 0) {
			const over = items.length > column.limit!;
			const wip = head.createSpan({ cls: `ph-board-wip${over ? " is-over" : ""}` });
			setIcon(wip.createSpan(), over ? "alert-triangle" : "gauge");
			wip.createSpan({ text: `${items.length}/${column.limit}` });
			setTooltip(wip, over ? `WIP limit of ${column.limit} exceeded` : `WIP limit of ${column.limit}`);
		}
		if (points > 0) head.createSpan({ cls: "ph-board-col-points", text: `${Math.round(points)} pts` });

		const add = head.createEl("button", { cls: "ph-icon-btn ph-board-col-add" });
		add.setAttr("aria-label", `Add item to ${column.label}`);
		setIcon(add, "plus");
		add.addEventListener("click", () => this.openQuickAdd(add.closest(".ph-board-col")!));

		const body = el.createDiv({ cls: "ph-board-col-body" });
		const frag = document.createDocumentFragment();
		for (const item of items) frag.appendChild(this.buildCard(item));
		body.appendChild(frag);

		const footer = el.createDiv({ cls: "ph-board-col-foot" });
		const addBtn = footer.createEl("button", { cls: "ph-board-add" });
		setIcon(addBtn.createSpan(), "plus");
		addBtn.createSpan({ text: "Add item" });
		addBtn.addEventListener("click", () => this.openQuickAdd(addBtn.closest(".ph-board-col")!));
		return el;
	}

	private buildCard(item: WorkItem): HTMLElement {
		const store = this.hub.store;
		const entry = this.model.rows.entryOf.get(item.path);
		const card = createDiv({ cls: "ph-board-card" });
		if (store.isDone(item)) card.addClass("is-done");
		card.dataset.path = item.path;
		card.dataset.points = item.points === null ? "" : String(item.points);
		card.dataset.phColor = store.statusDef(item.status)?.color ?? "gray";
		card.setAttr("draggable", "true");
		card.setAttr("tabindex", "0");
		card.setAttr("role", "button");
		card.setAttr("aria-label", `${item.id} ${item.title}. ${item.status}${item.assigneeName ? `. ${item.assigneeName}` : ""}`);

		const top = card.createDiv({ cls: "ph-board-card-top" });
		typeBadge(this.hub, top, item.type, false);
		top.createSpan({ cls: "ph-id", text: item.id });

		card.createDiv({ cls: "ph-board-card-title", text: item.title });

		const chips = card.createDiv({ cls: "ph-board-card-chips" });
		priorityBadge(chips, item.priority);
		dueChip(this.hub, chips, item);
		pointsChip(chips, item.points);
		if (store.isBlocked(item)) chip(chips, "Blocked", { icon: "octagon-x", cls: "is-critical" });
		chips.createSpan({ cls: "ph-board-card-spacer" });
		avatar(chips, item.assigneeName, 20);

		if (item.labels.length) {
			const labels = card.createDiv({ cls: "ph-board-card-labels" });
			for (const label of item.labels.slice(0, 3)) chip(labels, label, { cls: "ph-card-label" });
			if (item.labels.length > 3) chip(labels, `+${item.labels.length - 3}`, { cls: "ph-card-label ph-faint" });
		}

		if (this.opts.showSubtaskProgress) {
			const roll = store.rollup(item.path);
			if (roll.total > 0) {
				const sub = card.createDiv({ cls: "ph-board-card-sub" });
				sub.createSpan({ cls: "ph-muted", text: `${roll.done}/${roll.total}` });
				progressBar(sub, roll.progress, { label: false, width: "100%" });
			}
		}

		if (entry) renderExtraProps(this.hub, this, entry, card.createDiv({ cls: "ph-board-card-extra" }));
		return card;
	}

	private buildEmptyState(): HTMLElement {
		const el = createDiv({ cls: "ph-board-empty" });
		const rows = this.model.rows;
		if (rows.items.length === 0) {
			el.createDiv({ cls: "ph-board-empty-title", text: rows.others.length ? "No work items in this view" : "Nothing here yet" });
			el.createDiv({
				cls: "ph-board-empty-body",
				text: rows.others.length
					? "This base only returned notes that are not work items. Adjust its filters, or create a work item to get started."
					: "Work items you create show up on the board. Start with a new work item.",
			});
		} else {
			el.createDiv({ cls: "ph-board-empty-title", text: "No items match the filters" });
			el.createDiv({ cls: "ph-board-empty-body", text: "Everything in this view is hidden by the search, people or blocked filter." });
			const clear = el.createEl("button", { cls: "ph-btn" });
			setIcon(clear.createSpan(), "x");
			clear.createSpan({ text: "Clear filters" });
			clear.addEventListener("click", () => this.resetFilters());
		}
		const create = el.createEl("button", { cls: "ph-btn mod-cta" });
		setIcon(create.createSpan(), "plus");
		create.createSpan({ text: "New work item" });
		create.addEventListener("click", () => this.hub.newItem(contextDefaults(this.hub)));
		return el;
	}

	// ---------------------------------------------------------------- quick add

	private openQuickAdd(colEl: HTMLElement): void {
		const column = this.model.columns[Number(colEl.dataset.ci)];
		const lane = this.model.lanes[Number(colEl.dataset.li)];
		if (!column || !lane) return;
		const body = colEl.querySelector<HTMLElement>(".ph-board-col-body");
		if (!body) return;
		const existing = body.querySelector<HTMLInputElement>(".ph-board-quick-input");
		if (existing) {
			existing.focus();
			return;
		}
		const wrap = body.createDiv({ cls: "ph-board-quick" });
		const input = wrap.createEl("input", {
			cls: "ph-board-quick-input",
			attr: { placeholder: `New item in ${column.label}…`, spellcheck: "false" },
		});
		input.focus();
		input.addEventListener("keydown", (e) => {
			e.stopPropagation();
			if (e.key === "Escape") {
				wrap.remove();
				colEl.querySelector<HTMLElement>(".ph-board-col-add")?.focus();
			}
			if (e.key === "Enter") {
				e.preventDefault();
				const title = input.value;
				void this.quickCreate(title, column).then((made) => {
					if (made && wrap.isConnected) {
						input.value = "";
						input.focus();
					}
				});
			}
		});
		wrap.addEventListener("focusout", (e) => {
			if (!wrap.contains(e.relatedTarget as Node | null)) window.setTimeout(() => wrap.remove(), 80);
		});
	}

	private async quickCreate(title: string, column: ColumnSpec): Promise<boolean> {
		const name = title.trim();
		if (!name) return false;
		const options: NewItemOptions = { title: name, ...contextDefaults(this.hub) };
		if (column.field === "status" && column.value) options.status = column.value;
		if (column.field === "assignee") options.assignee = column.value;
		if (column.field === "sprint") options.sprint = column.value;
		if (column.field === "project") options.project = column.value;
		if (column.field === "priority") options.priority = column.value === null ? null : Number(column.value);
		if (column.field === "type" && column.value) options.type = column.value;
		try {
			const file = await this.hub.store.createItem(options);
			this.focusPath = file.path;
			new Notice(`Created ${file.basename.split(" ")[0]}`);
			this.paintSoon();
			return true;
		} catch (e) {
			new Notice(`Project Hub: could not create the item — ${e instanceof Error ? e.message : String(e)}`);
			return false;
		}
	}

	// ---------------------------------------------------------------- interaction

	private cardFromEvent(e: Event): HTMLElement | null {
		return (e.target as HTMLElement | null)?.closest<HTMLElement>(".ph-board-card") ?? null;
	}

	private onClick(e: MouseEvent): void {
		const card = this.cardFromEvent(e);
		const path = card?.dataset.path;
		if (!card || !path) {
			this.selection.clear();
			return;
		}
		const item = this.hub.store.getItem(path);
		if (!item) return;
		this.selection.resolveClick(this.visibleOrder(), path, e);
		this.focusPath = path;
		void this.hub.openPath(path, e.ctrlKey || e.metaKey);
	}

	private onContextMenu(e: MouseEvent): void {
		const card = this.cardFromEvent(e);
		const path = card?.dataset.path;
		if (!card || !path) return;
		e.preventDefault();
		if (!this.selection.has(path)) this.selection.replace(path);
		showItemMenu(this.hub, e, this.selection.items());
	}

	private onDragStart(e: DragEvent): void {
		const card = this.cardFromEvent(e);
		const path = card?.dataset.path;
		if (!card || !path) return;
		let paths = this.selection.has(path) ? this.selection.paths() : [path];
		paths = paths.filter((p) => this.hub.store.getItem(p));
		if (!paths.length) paths = [path];
		this.drag = { paths };
		this.selection.replace(paths[0]);
		for (const p of paths) this.cardEl(p)?.addClass("is-dragging");
		e.dataTransfer?.setData("text/plain", paths.join("\n"));
		if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
	}

	private onDragOver(e: DragEvent): void {
		if (!this.drag) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
		const col = (e.target as HTMLElement | null)?.closest<HTMLElement>(".ph-board-col");
		const body = col?.querySelector<HTMLElement>(".ph-board-col-body");
		if (!body) return;
		const cards = [...body.querySelectorAll<HTMLElement>(".ph-board-card")];
		const index = indexAt(cards, e.clientY, this.drag.paths);
		if (!this.dropLine) this.dropLine = createDiv({ cls: "ph-board-drop-line" });
		const anchor = cards.filter((c) => !this.drag?.paths.includes(c.dataset.path ?? ""))[index] ?? null;
		if (anchor) body.insertBefore(this.dropLine, anchor);
		else body.appendChild(this.dropLine);
	}

	private onDragLeave(e: DragEvent): void {
		const related = e.relatedTarget as HTMLElement | null;
		if (related && this.columnsEl?.contains(related)) return;
		this.dropLine?.remove();
		this.dropLine = null;
	}

	private onDrop(e: DragEvent): void {
		const col = (e.target as HTMLElement | null)?.closest<HTMLElement>(".ph-board-col");
		if (!col || !this.drag) return;
		e.preventDefault();
		e.stopPropagation();
		const lane = this.model.lanes[Number(col.dataset.li)];
		const column = this.model.columns[Number(col.dataset.ci)];
		if (!lane || !column) return;
		const body = col.querySelector<HTMLElement>(".ph-board-col-body");
		const dragging = this.drag.paths;
		const index = body ? indexAt([...body.querySelectorAll<HTMLElement>(".ph-board-card")], e.clientY, dragging) : 0;
		this.endDrag();
		void this.applyDrop(column, lane, index, dragging);
	}

	private endDrag(): void {
		this.columnsEl?.querySelectorAll(".is-dragging").forEach((el) => el.removeClass("is-dragging"));
		this.dropLine?.remove();
		this.dropLine = null;
		this.drag = null;
	}

	private async applyDrop(column: ColumnSpec, lane: LaneSpec, index: number, dragging: string[]): Promise<void> {
		const items = dragging.map((p) => this.hub.store.getItem(p)).filter((i): i is WorkItem => !!i);
		if (!items.length) return;
		this.moveCardsOptimistically(items, column, lane, index);

		const ordered = this.model.cells.get(`${lane.key}|${column.key}`) ?? [];
		const list = ordered.filter((i) => !dragging.includes(i.path));
		const target = Math.max(0, Math.min(index, list.length));
		try {
			for (const item of items) {
				await writeField(this.hub, item, column.field, column.value);
				if (lane.field !== "none") await writeField(this.hub, item, lane.field, lane.value);
			}
			if (items.length === 1) {
				for (const [path, rank] of rerank(ordered, items[0], target)) await this.hub.store.update(path, { [P.rank]: rank });
			} else {
				const final = [...list.slice(0, target), ...items, ...list.slice(target)];
				for (let i = 0; i < final.length; i++) {
					const rank = (i + 1) * 1000;
					if (final[i].rank !== rank) await this.hub.store.update(final[i].path, { [P.rank]: rank });
				}
			}
		} catch (e) {
			console.error("Project Hub: could not move the card", e);
			new Notice("Project Hub: the move could not be saved — the board has been reset.");
			this.paintSoon();
		}
	}

	/** Moves the dragged cards in the DOM right away so the board feels instant. */
	private moveCardsOptimistically(items: WorkItem[], column: ColumnSpec, lane: LaneSpec, index: number): void {
		const moving = new Set(items.map((i) => i.path));
		const colEl = this.columnEl(this.model.columns.indexOf(column), this.model.lanes.indexOf(lane));
		const body = colEl?.querySelector<HTMLElement>(".ph-board-col-body");
		if (body) {
			// Same ordering the drop line used: cards left behind only.
			const cards = [...body.querySelectorAll<HTMLElement>(".ph-board-card")].filter((c) => !moving.has(c.dataset.path ?? ""));
			const anchor = cards[index] ?? null;
			for (const item of items) {
				const card = this.cardEl(item.path);
				if (!card) continue;
				card.removeClass("is-dragging");
				if (anchor?.parentElement === body) body.insertBefore(card, anchor);
				else body.appendChild(card);
			}
		}
		this.dropLine?.remove();
		this.dropLine = null;
		this.syncColumnMeta();
	}

	private columnEl(column: number, lane: number): HTMLElement | null {
		if (column < 0 || lane < 0) return null;
		return this.columnsEl?.querySelector<HTMLElement>(`.ph-board-col[data-ci="${column}"][data-li="${lane}"]`) ?? null;
	}

	/** Recounts the column headers from the DOM after an optimistic move. */
	private syncColumnMeta(): void {
		this.columnsEl?.querySelectorAll<HTMLElement>(".ph-board-col").forEach((col) => {
			const body = col.querySelector<HTMLElement>(".ph-board-col-body");
			if (!body) return;
			const count = col.querySelector<HTMLElement>(".ph-board-col-count");
			if (count) count.setText(String(body.querySelectorAll(".ph-board-card").length));
			const points = col.querySelector<HTMLElement>(".ph-board-col-points");
			if (points) {
				let sum = 0;
				body.querySelectorAll<HTMLElement>(".ph-board-card").forEach((card) => {
					const p = Number(card.dataset.points);
					if (Number.isFinite(p) && p > 0) sum += p;
				});
				points.setText(`${Math.round(sum)} pts`);
			}
		});
	}

	// ---------------------------------------------------------------- keyboard

	private visibleOrder(): string[] {
		return [...(this.columnsEl?.querySelectorAll<HTMLElement>(".ph-board-card") ?? [])]
			.map((el) => el.dataset.path)
			.filter((p): p is string => !!p);
	}

	private cardEl(path: string): HTMLElement | null {
		return this.columnsEl?.querySelector<HTMLElement>(`.ph-board-card[data-path="${quotePath(path)}"]`) ?? null;
	}

	private focusCard(path: string): void {
		this.focusPath = path;
		this.cardEl(path)?.focus();
	}

	private onKeydown(e: KeyboardEvent): void {
		const target = e.target as HTMLElement | null;
		if (!target || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
		const card = target.closest<HTMLElement>(".ph-board-card");
		const path = card?.dataset.path;
		if (!card || !path) return;
		const item = this.hub.store.getItem(path);
		if (!item) return;

		switch (e.key) {
			case "ArrowLeft":
			case "ArrowRight": {
				e.preventDefault();
				const order = this.visibleOrder();
				const next = order[order.indexOf(path) + (e.key === "ArrowRight" ? 1 : -1)];
				if (next) this.focusCard(next);
				break;
			}
			case "ArrowUp":
			case "ArrowDown": {
				e.preventDefault();
				const step = e.key === "ArrowDown" ? 1 : -1;
				const inColumn = card.parentElement ? [...card.parentElement.querySelectorAll<HTMLElement>(".ph-board-card")] : [];
				const nextInColumn = inColumn[inColumn.indexOf(card) + step];
				if (nextInColumn?.dataset.path) this.focusCard(nextInColumn.dataset.path);
				else {
					const order = this.visibleOrder();
					const across = order[order.indexOf(path) + step];
					if (across) this.focusCard(across);
				}
				break;
			}
			case "Home":
			case "End": {
				e.preventDefault();
				const order = this.visibleOrder();
				const next = order[e.key === "Home" ? 0 : order.length - 1];
				if (next) this.focusCard(next);
				break;
			}
			case "Enter":
				e.preventDefault();
				void this.hub.openPath(path, e.ctrlKey || e.metaKey);
				break;
			case " ":
				e.preventDefault();
				this.selection.resolveKey(path);
				this.paintSelection();
				break;
			case "m":
			case "M": {
				e.preventDefault();
				const rect = card.getBoundingClientRect();
				const evt = new MouseEvent("contextmenu", { clientX: rect.left + 16, clientY: rect.top + 16, bubbles: true });
				statusMenu(this.hub, evt, this.selection.resolveKey(path));
				break;
			}
			case "Delete":
				e.preventDefault();
				void trashItems(this.hub, this.selection.resolveKey(path));
				break;
		}
	}

	private paintSelection(): void {
		this.columnsEl?.querySelectorAll<HTMLElement>(".ph-board-card").forEach((card) => {
			const path = card.dataset.path;
			card.toggleClass("is-selected", !!path && this.selection.has(path));
		});
	}
}

function readOptions(view: BasesView): BoardOptions {
	return {
		columnsBy: readString(view, "columnsBy", "status", COLUMN_FIELDS) as ColumnField,
		swimlanesBy: readString(view, "swimlanesBy", "none", ["none", ...COLUMN_FIELDS, "parent"]) as LaneField,
		showDone: readString(view, "showDone", "all", ["all", "14d", "none"]),
		hideEmptyColumns: readBool(view, "hideEmptyColumns", false),
		cardSize: readString(view, "cardSize", "comfortable", ["compact", "comfortable"]),
		showWip: readBool(view, "showWip", true),
		showSubtaskProgress: readBool(view, "showSubtaskProgress", true),
	};
}

function sprintRange(sprint: { start: string | null; end: string | null }): string {
	if (!sprint.start || !sprint.end) return "";
	const fmt = (d: string) => d.slice(5).replace("-", "/");
	return `${fmt(sprint.start)} – ${fmt(sprint.end)}`;
}

// ---------------------------------------------------------------- registration

export function boardOptions(): BasesAllOptions[] {
	return [
		{
			key: "columnsBy",
			type: "dropdown",
			displayName: "Columns",
			default: "status",
			options: { Status: "status", Assignee: "assignee", Priority: "priority", Type: "type", Sprint: "sprint", Project: "project" },
		},
		{
			key: "swimlanesBy",
			type: "dropdown",
			displayName: "Swimlanes",
			default: "none",
			options: { None: "none", Assignee: "assignee", Priority: "priority", Type: "type", Project: "project", Parent: "parent", Sprint: "sprint" },
		},
		{
			key: "showDone",
			type: "dropdown",
			displayName: "Done items",
			default: "all",
			options: { "Show all": "all", "Done in the last 14 days": "14d", Hide: "none" },
		},
		{ key: "hideEmptyColumns", type: "toggle", displayName: "Hide empty columns", default: false },
		{
			key: "cardSize",
			type: "dropdown",
			displayName: "Card size",
			default: "comfortable",
			options: { Comfortable: "comfortable", Compact: "compact" },
		},
		{ key: "showWip", type: "toggle", displayName: "Show WIP limits", default: true },
		{ key: "showSubtaskProgress", type: "toggle", displayName: "Show subtask progress", default: true },
	];
}

export function registerBoardView(hub: Hub): void {
	hub.plugin.registerBasesView("ph-board", {
		name: "Board",
		icon: "square-kanban",
		factory: (controller, containerEl) => new BoardView(hub, controller, containerEl),
		options: () => boardOptions(),
	});
}
