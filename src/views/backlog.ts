// Hierarchical backlog as a custom Bases view ("ph-backlog").
//
// Card level interactions (selection, context menu, keyboard activation) come
// from ./board so both views behave the same.

import { BasesView, Notice, QueryController, debounce, setIcon, setTooltip } from "obsidian";
import type { BasesAllOptions } from "obsidian";
import type { Hub } from "../core/hub";
import { P, type Sprint, type WorkItem } from "../core/model";
import { type ViewRows, contextDefaults, renderExtraProps, rerank, viewRows } from "./base-helpers";
import type { NewItemOptions } from "../core/store";
import { ItemSelection, copyItemLink, focusCell, showItemMenu, trashItems, writeField } from "./board";
import {
	chip,
	dueChip,
	personLabel,
	priorityBadge,
	priorityMenu,
	progressBar,
	statusMenu,
	statusPill,
	typeBadge,
} from "../ui/widgets";
import { pickPerson, pickSprint } from "../ui/pickers";
import { plural } from "../core/util";

// ---------------------------------------------------------------- view model

const GROUP_FIELDS = ["none", "sprint", "project", "status"] as const;
type GroupField = (typeof GROUP_FIELDS)[number];

interface BacklogNode {
	item: WorkItem;
	children: BacklogNode[];
	parentNode: BacklogNode | null;
	/** Parent path when the parent is part of the same group. */
	parentPath: string | null;
	depth: number;
}

interface BacklogGroup {
	key: string;
	label: string;
	sub: string;
	sprint: Sprint | null;
	items: WorkItem[];
	roots: BacklogNode[];
	collapsed: boolean;
	kind: "current" | "future" | "past" | "backlog" | "plain";
}

interface BacklogModel {
	rows: ViewRows;
	visible: WorkItem[];
	groups: BacklogGroup[];
	nodes: Map<string, BacklogNode>;
	points: number;
}

interface BacklogOptions {
	groupBy: GroupField;
	hideDone: boolean;
}

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

function quotePath(path: string): string {
	return path.replace(/["\\]/g, "\\$&");
}

function shortRange(start: string | null, end: string | null): string {
	if (!start || !end) return "";
	const fmt = (d: string) => d.slice(5).replace("-", "/");
	return `${fmt(start)} – ${fmt(end)}`;
}

// ---------------------------------------------------------------- backlog view

export class BacklogView extends BasesView {
	readonly type = "ph-backlog";

	private root: HTMLElement | null = null;
	private bodyEl: HTMLElement | null = null;
	private quickEl: HTMLInputElement | null = null;
	private countEl: HTMLElement | null = null;
	private groupLabelEl: HTMLElement | null = null;
	private flat: { node: BacklogNode; group: BacklogGroup }[] = [];

	private opts!: BacklogOptions;
	private model: BacklogModel = { rows: { items: [], others: [], entryOf: new Map() }, visible: [], groups: [], nodes: new Map(), points: 0 };
	private selection = new ItemSelection(this.hub, () => this.paintSelection());
	private drag: { paths: string[] } | null = null;

	private search = "";
	private collapsed = new Set<string>();
	private collapsedGroups = new Set<string>();
	private expandedGroups = new Set<string>();
	private activeGroupKey: string | null = null;
	private focusPath: string | null = null;
	private paintSoon = debounce(() => this.paint(), 100, true);

	constructor(
		private hub: Hub,
		controller: QueryController,
		private hostEl: HTMLElement,
	) {
		super(controller);
		hostEl.addClass("ph-backlog-host");
	}

	private stateLoaded = false;

	private readViewState(): void {
		if (this.stateLoaded) return;
		this.stateLoaded = true;
		this.collapsed = new Set(readList(this, "collapsed"));
		this.collapsedGroups = new Set(readList(this, "ph-groups"));
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

	private setCollapsed(): void {
		const value = [...this.collapsed];
		const current = readList(this, "collapsed");
		if (current.length === value.length && current.every((v, i) => v === value[i])) return;
		this.config.set("collapsed", value);
	}

	private setCollapsedGroups(): void {
		const value = [...this.collapsedGroups];
		const current = readList(this, "ph-groups");
		if (current.length === value.length && current.every((v, i) => v === value[i])) return;
		this.config.set("ph-groups", value);
	}

	// ---------------------------------------------------------------- data

	private computeModel(): BacklogModel {
		const rows = viewRows(this.hub, this);
		const query = this.search;
		const visible = rows.items.filter((item) => {
			if (this.opts.hideDone && this.hub.store.isDone(item)) return false;
			if (query && !`${item.title} ${item.id} ${item.labels.join(" ")} ${item.type} ${item.status}`.toLowerCase().includes(query)) return false;
			return true;
		});

		const groups = this.buildGroups(visible);
		const nodes = new Map<string, BacklogNode>();
		for (const group of groups) {
			for (const node of group.roots) {
				const walk = (n: BacklogNode) => {
					nodes.set(n.item.path, n);
					for (const child of n.children) walk(child);
				};
				walk(node);
			}
		}
		return {
			rows,
			visible,
			groups,
			nodes,
			points: visible.reduce((s, i) => s + (i.points ?? 0), 0),
		};
	}

	private buildGroups(items: WorkItem[]): BacklogGroup[] {
		const store = this.hub.store;
		const field = this.opts.groupBy;
		if (field === "none") {
			return [this.makeGroup("all", "", "", null, items, "plain")];
		}
		if (field === "status") {
			const out: BacklogGroup[] = [];
			const byStatus = new Map<string, WorkItem[]>();
			for (const item of items) {
				const list = byStatus.get(item.status);
				if (list) list.push(item);
				else byStatus.set(item.status, [item]);
			}
			const ordered: string[] = [];
			for (const s of store.settings.statuses) if (byStatus.has(s.name)) ordered.push(s.name);
			for (const name of byStatus.keys()) if (!ordered.includes(name)) ordered.push(name);
			for (const name of ordered) {
				const def = store.statusDef(name);
				out.push(this.makeGroup(`status:${name}`, name, def ? `${def.category}` : "", null, byStatus.get(name) ?? [], "plain"));
			}
			return out;
		}
		if (field === "project") {
			const byProject = new Map<string, WorkItem[]>();
			for (const item of items) {
				const key = item.project ?? "none";
				const list = byProject.get(key);
				if (list) list.push(item);
				else byProject.set(key, [item]);
			}
			const projects = [...store.projects.values()].sort((a, b) => a.name.localeCompare(b.name));
			const out: BacklogGroup[] = [];
			for (const project of projects) {
				const list = byProject.get(project.path);
				if (list?.length) out.push(this.makeGroup(`project:${project.path}`, project.name, project.status, null, list, "plain"));
			}
			const loose = byProject.get("none");
			if (loose?.length) out.push(this.makeGroup("project:none", "No project", "", null, loose, "plain"));
			for (const [key, list] of byProject) {
				if (key === "none" || store.projects.has(key)) continue;
				out.push(this.makeGroup(`project:${key}`, store.displayName(key), "", null, list, "plain"));
			}
			return out;
		}

		// sprint: Current, Future, Backlog, Past (collapsed)
		const bySprint = new Map<string, WorkItem[]>();
		for (const item of items) {
			const key = item.sprint ?? "none";
			const list = bySprint.get(key);
			if (list) list.push(item);
			else bySprint.set(key, [item]);
		}
		const out: BacklogGroup[] = [];
		const add = (path: string, kind: BacklogGroup["kind"]) => {
			const sprint = store.sprints.get(path) ?? null;
			const label = sprint ? sprint.name : store.displayName(path);
			const sub = sprint ? `${shortRange(sprint.start, sprint.end)}` : "";
			out.push(this.makeGroup(`sprint:${path}`, label, sub, sprint, bySprint.get(path) ?? [], kind));
		};
		const current = store.currentSprint();
		if (current && bySprint.has(current.path)) add(current.path, "current");
		for (const sprint of store.futureSprints()) if (bySprint.has(sprint.path)) add(sprint.path, "future");
		if (bySprint.has("none")) {
			const list = bySprint.get("none") ?? [];
			out.push(this.makeGroup("sprint:none", "Backlog", "No sprint", null, list, "backlog"));
		}
		for (const sprint of store.sortedSprints()) {
			if (sprint.state === "Past" && bySprint.has(sprint.path)) add(sprint.path, "past");
		}
		for (const [key, list] of bySprint) {
			if (key === "none" || store.sprints.has(key)) continue;
			out.push(this.makeGroup(`sprint:${key}`, store.displayName(key), "", null, list, "plain"));
		}
		return out;
	}

	private makeGroup(key: string, label: string, sub: string, sprint: Sprint | null, items: WorkItem[], kind: BacklogGroup["kind"]): BacklogGroup {
		const roots = this.buildTree(items);
		return {
			key,
			label,
			sub,
			sprint,
			items,
			roots,
			collapsed: this.collapsedGroups.has(key) || (kind === "past" && !this.expandedGroups.has(key)),
			kind,
		};
	}

	private buildTree(items: WorkItem[]): BacklogNode[] {
		const set = new Set(items.map((i) => i.path));
		const nodes = new Map<string, BacklogNode>();
		for (const item of items) {
			nodes.set(item.path, {
				item,
				children: [],
				parentNode: null,
				parentPath: item.parent && set.has(item.parent) ? item.parent : null,
				depth: 0,
			});
		}
		const roots: BacklogNode[] = [];
		for (const node of nodes.values()) {
			const parent = node.parentPath ? nodes.get(node.parentPath) : undefined;
			if (parent && parent !== node) {
				parent.children.push(node);
				node.parentNode = parent;
			} else {
				roots.push(node);
			}
		}
		const walk = (list: BacklogNode[], depth: number, seen: Set<string>) => {
			const sorted = [...list].sort((a, b) => {
				const ra = a.item.rank;
				const rb = b.item.rank;
				if (ra !== null && rb !== null) return ra - rb;
				if (ra !== null) return -1;
				if (rb !== null) return 1;
				return (a.item.priority ?? 9) - (b.item.priority ?? 9) || a.item.id.localeCompare(b.item.id, undefined, { numeric: true });
			});
			list.length = 0;
			list.push(...sorted);
			for (const node of list) {
				if (seen.has(node.item.path)) continue;
				seen.add(node.item.path);
				node.depth = depth;
				walk(node.children, depth + 1, seen);
			}
		};
		walk(roots, 0, new Set());
		return roots;
	}

	// ---------------------------------------------------------------- rendering

	private paint(): void {
		this.opts = this.readOptions();
		this.readViewState();
		// Only hand the focus back when it was inside the backlog: a paint is often
		// caused by the note the user just navigated to.
		const keepFocus = !!this.root?.contains(document.activeElement);
		this.model = this.computeModel();
		this.ensureChrome();
		this.renderBody();
		this.updateChrome();
		if (keepFocus) focusCell(this.root, ".ph-bl-row", this.focusPath);
	}

	private readOptions(): BacklogOptions {
		// "phGroupBy" is the registered key. A plain string under the reserved
		// "groupBy" key (which Bases itself uses for its object form) is honoured
		// as an alias so older .base files keep working.
		const legacy = readString(this, "groupBy", "", GROUP_FIELDS);
		const groupBy = readString(this, "phGroupBy", legacy || "sprint", GROUP_FIELDS) as GroupField;
		return { groupBy, hideDone: readBool(this, "hideDone", false) };
	}

	private ensureChrome(): void {
		const host = this.hostEl;
		if (this.root) {
			// Sidebar hosts are much narrower: hide the secondary columns.
			this.root.toggleClass("is-narrow", host.clientWidth > 0 && host.clientWidth < 760);
			return;
		}
		const root = host.createDiv({ cls: "ph-backlog-view" });
		root.toggleClass("is-narrow", host.clientWidth > 0 && host.clientWidth < 760);
		root.toggleClass("is-embedded", !!host.closest(".internal-embed, .markdown-embed, .bases-embed, .embed-block"));
		this.root = root;

		const toolbar = root.createDiv({ cls: "ph-backlog-toolbar" });
		const search = toolbar.createDiv({ cls: "ph-backlog-search" });
		setIcon(search.createSpan(), "search");
		const input = search.createEl("input", {
			cls: "ph-backlog-search-input",
			attr: { type: "text", placeholder: "Search backlog…", spellcheck: "false" },
		});
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
		});

		const expand = toolbar.createEl("button", { cls: "ph-board-toggle" });
		setIcon(expand.createSpan(), "unfold-vertical");
		expand.createSpan({ text: "Expand all" });
		this.registerDomEvent(expand, "click", () => {
			this.collapsed.clear();
			this.expandedGroups.clear();
			this.collapsedGroups.clear();
			this.setCollapsed();
			this.setCollapsedGroups();
			this.paint();
		});

		const collapse = toolbar.createEl("button", { cls: "ph-board-toggle" });
		setIcon(collapse.createSpan(), "fold-vertical");
		collapse.createSpan({ text: "Collapse all" });
		this.registerDomEvent(collapse, "click", () => {
			for (const node of this.model.nodes.values()) {
				if (node.children.length) this.collapsed.add(node.item.path);
			}
			for (const group of this.model.groups) this.collapsedGroups.add(group.key);
			this.setCollapsed();
			this.setCollapsedGroups();
			this.paint();
		});

		const spacer = toolbar.createDiv({ cls: "ph-backlog-spacer" });
		spacer.setAttr("aria-hidden", "true");
		this.countEl = toolbar.createDiv({ cls: "ph-backlog-count" });

		const quick = root.createDiv({ cls: "ph-backlog-quick" });
		setIcon(quick.createSpan(), "plus");
		const quickInput = quick.createEl("input", {
			cls: "ph-backlog-quick-input",
			attr: { placeholder: "Add item…", spellcheck: "false" },
		});
		this.quickEl = quickInput;
		const typeSelect = quick.createEl("select", { cls: "ph-backlog-quick-type dropdown" });
		for (const t of this.hub.settings.types) {
			const option = typeSelect.createEl("option", { text: t.name, value: t.name });
			if (t.name === this.hub.settings.defaultType) option.selected = true;
		}
		const addBtn = quick.createEl("button", { cls: "ph-board-toggle is-compact" });
		setIcon(addBtn.createSpan(), "corner-down-left");
		addBtn.createSpan({ text: "Add" });
		this.groupLabelEl = quick.createSpan({ cls: "ph-backlog-quick-group ph-muted" });

		this.registerDomEvent(quickInput, "keydown", (e) => {
			e.stopPropagation();
			if (e.key === "Escape") {
				quickInput.value = "";
				quickInput.blur();
			}
			if (e.key === "Enter") {
				e.preventDefault();
				void this.quickCreate(quickInput.value, typeSelect.value);
			}
		});
		this.registerDomEvent(addBtn, "click", () => void this.quickCreate(quickInput.value, typeSelect.value));

		this.bodyEl = root.createDiv({ cls: "ph-backlog-body" });
		this.registerDomEvent(this.bodyEl, "keydown", (e) => this.onKeydown(e));
		this.registerDomEvent(this.bodyEl, "click", (e) => this.onClick(e));
		this.registerDomEvent(this.bodyEl, "contextmenu", (e) => this.onContextMenu(e));
		this.registerDomEvent(this.bodyEl, "dragstart", (e) => this.onDragStart(e as DragEvent));
		this.registerDomEvent(this.bodyEl, "dragover", (e) => this.onDragOver(e as DragEvent));
		this.registerDomEvent(this.bodyEl, "dragleave", (e) => this.onDragLeave(e as DragEvent));
		this.registerDomEvent(this.bodyEl, "drop", (e) => this.onDrop(e as DragEvent));
		this.registerDomEvent(this.bodyEl, "dragend", () => this.endDrag());
	}

	private updateChrome(): void {
		if (this.countEl) {
			const parts = [plural(this.model.visible.length, "item"), `${Math.round(this.model.points)} pts`];
			if (this.model.visible.length !== this.model.rows.items.length) parts.push(`of ${this.model.rows.items.length}`);
			this.countEl.setText(parts.join(" · "));
		}
		const active = this.model.groups.find((g) => g.key === this.activeGroupKey) ?? this.model.groups[0];
		if (this.groupLabelEl && active?.label) {
			this.groupLabelEl.setText(`in ${active.label}`);
			this.groupLabelEl.setAttr("title", `New items are created in ${active.label}`);
		}
		if (this.quickEl) this.quickEl.setAttr("placeholder", active?.label ? `Add item in ${active.label}…` : "Add item…");
	}

	private renderBody(): void {
		const body = this.bodyEl;
		if (!body) return;
		body.empty();
		this.flat = [];
		if (this.model.visible.length === 0) {
			body.appendChild(this.buildEmptyState());
			return;
		}
		const frag = document.createDocumentFragment();
		frag.appendChild(this.buildHeader());
		for (const group of this.model.groups) frag.appendChild(this.buildGroup(group));
		if (this.model.rows.others.length > 0) {
			const note = createDiv({ cls: "ph-backlog-foot" });
			setIcon(note.createSpan(), "info");
			note.createSpan({ text: `${plural(this.model.rows.others.length, "entry", "entries")} in this view ${this.model.rows.others.length === 1 ? "is" : "are"} not a work item and ${this.model.rows.others.length === 1 ? "is" : "are"} hidden.` });
			frag.appendChild(note);
		}
		body.appendChild(frag);
		this.paintSelection();
	}

	private buildHeader(): HTMLElement {
		const head = createDiv({ cls: "ph-bl-head" });
		head.createDiv({ cls: "ph-bl-cell ph-bl-handle" });
		head.createDiv({ cls: "ph-bl-cell ph-bl-twist" });
		head.createDiv({ cls: "ph-bl-cell ph-bl-main", text: "Item" });
		head.createDiv({ cls: "ph-bl-cell ph-bl-status", text: "Status" });
		head.createDiv({ cls: "ph-bl-cell ph-bl-priority", text: "Prio" });
		head.createDiv({ cls: "ph-bl-cell ph-bl-assignee", text: "Assignee" });
		head.createDiv({ cls: "ph-bl-cell ph-bl-sprint", text: "Sprint" });
		head.createDiv({ cls: "ph-bl-cell ph-bl-points", text: "Pts" });
		head.createDiv({ cls: "ph-bl-cell ph-bl-due", text: "Due" });
		head.createDiv({ cls: "ph-bl-cell ph-bl-progress", text: "Progress" });
		head.createDiv({ cls: "ph-bl-cell ph-bl-extra", text: "Properties" });
		return head;
	}

	private buildGroup(group: BacklogGroup): HTMLElement {
		const el = createDiv({ cls: "ph-bl-group" });
		el.dataset.group = group.key;
		if (group.collapsed) el.addClass("is-collapsed");
		const head = el.createDiv({ cls: "ph-bl-group-head" });
		setIcon(head.createSpan({ cls: "ph-bl-group-twist" }), group.collapsed ? "chevron-right" : "chevron-down");
		head.createSpan({ cls: "ph-bl-group-name", text: group.label });
		if (group.kind === "current") head.createSpan({ cls: "ph-chip ph-bl-group-flag", text: "current" });
		if (group.kind === "future") head.createSpan({ cls: "ph-chip ph-bl-group-flag", text: "future" });
		if (group.kind === "past") head.createSpan({ cls: "ph-chip ph-bl-group-flag", text: "past" });
		head.createSpan({ cls: "ph-bl-group-count", text: plural(group.items.length, "item") });
		const points = group.items.reduce((s, i) => s + (i.points ?? 0), 0);
		if (points > 0) head.createSpan({ cls: "ph-bl-group-points", text: `${Math.round(points)} pts` });
		if (group.sub) head.createSpan({ cls: "ph-bl-group-sub ph-muted", text: group.sub });
		if (group.sprint?.capacity) {
			const cap = group.sprint.capacity;
			const bar = head.createDiv({ cls: "ph-bl-group-capacity" });
			bar.createSpan({ text: `${Math.round(points)}/${Math.round(cap)}` });
			progressBar(bar, cap > 0 ? (points / cap) * 100 : 0, { label: false, width: "90px" });
			setTooltip(bar, `Committed ${Math.round(points)} of ${Math.round(cap)} points`);
		}
		head.addEventListener("click", () => {
			if (this.collapsedGroups.has(group.key)) this.collapsedGroups.delete(group.key);
			else this.collapsedGroups.add(group.key);
			this.expandedGroups.add(group.key);
			this.setCollapsedGroups();
			this.paint();
		});

		const rows = el.createDiv({ cls: "ph-bl-rows" });
		rows.toggleClass("is-hidden", group.collapsed);
		const frag = document.createDocumentFragment();
		this.appendNodes(frag, group.roots, group);
		rows.appendChild(frag);
		return el;
	}

	/** Depth-first append; children of a collapsed row are skipped. */
	private appendNodes(frag: DocumentFragment, nodes: BacklogNode[], group: BacklogGroup): void {
		for (const node of nodes) {
			frag.appendChild(this.buildNode(node, group));
			if (!this.collapsed.has(node.item.path)) this.appendNodes(frag, node.children, group);
		}
	}

	private buildNode(node: BacklogNode, group: BacklogGroup): HTMLElement {
		const item = node.item;
		const store = this.hub.store;
		const entry = this.model.rows.entryOf.get(item.path);
		const done = store.isDone(item);
		const row = createDiv({ cls: "ph-bl-row" });
		if (done) row.addClass("is-done");
		if (this.selection.has(item.path)) row.addClass("is-selected");
		row.dataset.path = item.path;
		row.dataset.depth = String(node.depth);
		row.dataset.group = group.key;
		row.style.setProperty("--ph-bl-depth", String(node.depth));
		row.setAttr("tabindex", "0");
		row.setAttr("role", "button");
		row.setAttr("aria-label", `${item.id} ${item.title}. ${item.status}`);
		if (node.children.length) row.addClass("has-children");
		this.flat.push({ node, group });

		const handle = row.createDiv({ cls: "ph-bl-cell ph-bl-handle" });
		setIcon(handle, "grip-vertical");
		handle.setAttr("aria-hidden", "true");
		handle.addEventListener("pointerdown", () => {
			row.setAttr("draggable", "true");
		});

		const twist = row.createDiv({ cls: "ph-bl-cell ph-bl-twist" });
		if (node.children.length) {
			const collapsed = this.collapsed.has(item.path);
			setIcon(twist, collapsed ? "chevron-right" : "chevron-down");
			twist.setAttr("aria-label", collapsed ? "Expand" : "Collapse");
			twist.addClass("is-clickable");
			twist.addEventListener("click", (e) => {
				e.stopPropagation();
				if (this.collapsed.has(item.path)) this.collapsed.delete(item.path);
				else this.collapsed.add(item.path);
				this.setCollapsed();
				this.paint();
			});
		}

		const main = row.createDiv({ cls: "ph-bl-cell ph-bl-main" });
		if (item.parent && !node.parentPath) {
			main.createSpan({ cls: "ph-bl-crumb", text: `↳ ${store.displayName(item.parent)}` });
		}
		typeBadge(this.hub, main, item.type, false);
		main.createSpan({ cls: "ph-id", text: item.id });
		const title = main.createSpan({ cls: "ph-bl-title", text: item.title });
		title.addEventListener("dblclick", (e) => {
			e.stopPropagation();
			this.editTitle(item, title);
		});

		const status = row.createDiv({ cls: "ph-bl-cell ph-bl-status" });
		statusPill(this.hub, status, item.status, {
			onClick: (evt) => {
				evt.stopPropagation();
				statusMenu(this.hub, evt, [item]);
			},
		});

		const priority = row.createDiv({ cls: "ph-bl-cell ph-bl-priority" });
		priorityBadge(priority, item.priority, {
			onClick: (evt) => {
				evt.stopPropagation();
				priorityMenu(this.hub, evt, [item]);
			},
		});

		const assignee = row.createDiv({ cls: "ph-bl-cell ph-bl-assignee" });
		personLabel(this.hub, assignee, item.assignee, {
			showName: false,
			onClick: (evt) => {
				evt.stopPropagation();
				void this.assignTo(item);
			},
		});

		const sprint = row.createDiv({ cls: "ph-bl-cell ph-bl-sprint" });
		const sprintName = item.sprint ? store.displayName(item.sprint) : null;
		const sprintChip = chip(sprint, sprintName ?? "Backlog", { cls: sprintName ? "" : "ph-faint", icon: sprintName ? "milestone" : "inbox" });
		sprintChip.addClass("is-clickable");
		sprintChip.addEventListener("click", (e) => {
			e.stopPropagation();
			void this.moveSprint(item);
		});

		row.createDiv({ cls: "ph-bl-cell ph-bl-points", text: item.points === null ? "" : String(item.points) });

		const due = row.createDiv({ cls: "ph-bl-cell ph-bl-due" });
		dueChip(this.hub, due, item);

		const progress = row.createDiv({ cls: "ph-bl-cell ph-bl-progress" });
		if (node.children.length) {
			const roll = store.rollup(item.path);
			progress.createSpan({ cls: "ph-bl-progress-text ph-muted", text: `${roll.done}/${roll.total}` });
			progressBar(progress, roll.progress, { label: false, width: "70px" });
		} else if (done) {
			setIcon(progress.createSpan({ cls: "ph-bl-progress-done" }), "check");
		}

		const extra = row.createDiv({ cls: "ph-bl-cell ph-bl-extra" });
		if (entry) renderExtraProps(this.hub, this, entry, extra);

		const addChild = row.createDiv({ cls: "ph-bl-row-add" });
		setIcon(addChild, "plus");
		addChild.setAttr("aria-label", `Add child item to ${item.title}`);
		setTooltip(addChild, "Add child item");
		addChild.addEventListener("click", (e) => {
			e.stopPropagation();
			const child = store.typeDef(item.type)?.child;
			this.hub.newItem({
				parent: item.path,
				project: store.effectiveProject(item),
				type: child,
				status: store.statusFor("proposed"),
			});
		});

		return row;
	}

	private buildEmptyState(): HTMLElement {
		const el = createDiv({ cls: "ph-backlog-empty" });
		el.createDiv({
			cls: "ph-backlog-empty-title",
			text: this.model.rows.items.length ? "No items match the search" : "Nothing in the backlog yet",
		});
		el.createDiv({
			cls: "ph-backlog-empty-body",
			text: this.model.rows.items.length
				? "No work item in this view matches the search."
				: "Create the first work item and it shows up here, nested under its parent.",
		});
		const create = el.createEl("button", { cls: "ph-btn mod-cta" });
		setIcon(create.createSpan(), "plus");
		create.createSpan({ text: "New work item" });
		create.addEventListener("click", () => this.hub.newItem(contextDefaults(this.hub)));
		return el;
	}



	// ---------------------------------------------------------------- inline edits

	private editTitle(item: WorkItem, span: HTMLElement): void {
		const input = createEl("input", { cls: "ph-bl-title-input", type: "text" });
		input.value = item.title;
		span.empty();
		span.appendChild(input);
		input.focus();
		input.select();
		const commit = () => {
			const next = input.value.trim();
			if (next && next !== item.title) void this.hub.store.update(item.path, { [P.title]: next });
			this.paint();
		};
		input.addEventListener("keydown", (e) => {
			e.stopPropagation();
			if (e.key === "Enter") commit();
			if (e.key === "Escape") this.paint();
		});
		input.addEventListener("blur", commit);
		input.addEventListener("click", (e) => e.stopPropagation());
	}

	private async assignTo(item: WorkItem): Promise<void> {
		const target = await pickPerson(this.hub);
		if (target === undefined) return;
		await this.hub.store.setLink(item.path, P.assignee, target);
	}

	private async moveSprint(item: WorkItem): Promise<void> {
		const target = await pickSprint(this.hub, { includePast: false });
		if (target === undefined) return;
		await this.hub.store.setLink(item.path, P.sprint, target);
	}

	private async quickCreate(title: string, type: string): Promise<void> {
		const name = title.trim();
		if (!name) return;
		const group = this.model.groups.find((g) => g.key === this.activeGroupKey) ?? this.model.groups[0];
		const options: NewItemOptions = { ...contextDefaults(this.hub), title: name, type, status: this.hub.store.statusFor("proposed") };
		if (group?.kind === "backlog") options.sprint = null;
		if (group?.sprint) options.sprint = group.sprint.path;
		if (group?.key.startsWith("project:")) options.project = group.key.slice("project:".length) === "none" ? null : group.key.slice("project:".length);
		try {
			const file = await this.hub.store.createItem(options);
			if (this.quickEl) {
				this.quickEl.value = "";
				this.quickEl.focus();
			}
			new Notice(`Created ${file.basename.split(" ")[0]}`);
		} catch (e) {
			new Notice(`Project Hub: could not create the item — ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	// ---------------------------------------------------------------- interaction

	private rowFromEvent(e: Event): HTMLElement | null {
		return (e.target as HTMLElement | null)?.closest<HTMLElement>(".ph-bl-row") ?? null;
	}

	private visibleOrder(): string[] {
		return this.flat.map((f) => f.node.item.path);
	}

	private onClick(e: MouseEvent): void {
		const row = this.rowFromEvent(e);
		const path = row?.dataset.path;
		if (!row || !path) {
			this.selection.clear();
			return;
		}
		row.setAttr("draggable", "false");
		const item = this.hub.store.getItem(path);
		if (!item) return;
		this.selection.resolveClick(this.visibleOrder(), path, e);
		this.activeGroupKey = row.dataset.group ?? null;
		this.focusPath = path;
		this.updateChrome();
		void this.hub.openPath(path, e.ctrlKey || e.metaKey);
	}

	private onContextMenu(e: MouseEvent): void {
		const row = this.rowFromEvent(e);
		const path = row?.dataset.path;
		if (!row || !path) return;
		e.preventDefault();
		if (!this.selection.has(path)) this.selection.replace(path);
		showItemMenu(this.hub, e, this.selection.items());
	}

	private onDragStart(e: DragEvent): void {
		const row = this.rowFromEvent(e);
		const path = row?.dataset.path;
		if (!row || !path) return;
		let paths = this.selection.has(path) ? this.selection.paths() : [path];
		paths = paths.filter((p) => this.hub.store.getItem(p));
		if (!paths.length) paths = [path];
		this.drag = { paths };
		this.selection.replace(paths[0]);
		for (const p of paths) this.rowEl(p)?.addClass("is-dragging");
		row.setAttr("draggable", "false");
		e.dataTransfer?.setData("text/plain", paths.join("\n"));
		if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
	}

	private onDragOver(e: DragEvent): void {
		if (!this.drag) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
		const row = this.rowFromEvent(e);
		if (!row) return;
		const rect = row.getBoundingClientRect();
		const third = rect.height / 3;
		const zone = e.clientY < rect.top + third ? "before" : e.clientY > rect.bottom - third ? "after" : "onto";
		this.bodyEl?.querySelectorAll(".is-drop-before, .is-drop-after, .is-drop-onto").forEach((el) => {
			el.removeClasses(["is-drop-before", "is-drop-after", "is-drop-onto"]);
		});
		row.addClass(`is-drop-${zone}`);
	}

	private onDragLeave(e: DragEvent): void {
		const related = e.relatedTarget as HTMLElement | null;
		if (related && this.bodyEl?.contains(related)) return;
		this.clearDropMarks();
	}

	private onDrop(e: DragEvent): void {
		const row = this.rowFromEvent(e);
		const path = row?.dataset.path;
		if (!row || !path || !this.drag) return;
		e.preventDefault();
		e.stopPropagation();
		const rect = row.getBoundingClientRect();
		const third = rect.height / 3;
		const zone = e.clientY < rect.top + third ? "before" : e.clientY > rect.bottom - third ? "after" : "onto";
		const dragging = this.drag.paths;
		this.clearDropMarks();
		this.endDrag();
		void this.applyDrop(zone, path, dragging);
	}

	private clearDropMarks(): void {
		this.bodyEl?.querySelectorAll(".is-drop-before, .is-drop-after, .is-drop-onto").forEach((el) => {
			el.removeClasses(["is-drop-before", "is-drop-after", "is-drop-onto"]);
		});
	}

	private endDrag(): void {
		this.bodyEl?.querySelectorAll(".is-dragging").forEach((el) => {
			el.removeClass("is-dragging");
			el.setAttr("draggable", "false");
		});
		this.drag = null;
	}

	private async applyDrop(zone: "before" | "after" | "onto", targetPath: string, dragging: string[]): Promise<void> {
		const targetNode = this.model.nodes.get(targetPath);
		if (!targetNode) return;
		const items = dragging.map((p) => this.hub.store.getItem(p)).filter((i): i is WorkItem => !!i);
		if (!items.length) return;
		if (items.some((i) => i.path === targetPath)) return;
		this.moveRowsOptimistically(dragging, targetPath, zone);

		const store = this.hub.store;
		const group = this.groupOf(targetPath);

		// Re-parenting onto our own descendant would create a cycle.
		if (zone === "onto") {
			for (const item of items) {
				const banned = new Set<string>([item.path, ...store.descendants(item.path).map((d) => d.path)]);
				if (banned.has(targetPath)) {
					new Notice("Project Hub: an item cannot become a child of its own subtask.");
					return;
				}
			}
		}

		// Move to the target group first, so the following rank writes land in the right place.
		if (group) {
			for (const item of items) {
				if (this.opts.groupBy === "sprint") await writeField(this.hub, item, "sprint", group.sprint?.path ?? null);
				if (this.opts.groupBy === "project") {
					const project = group.key.startsWith("project:") ? group.key.slice("project:".length) : null;
					await writeField(this.hub, item, "project", project === "none" ? null : project);
				}
				if (this.opts.groupBy === "status") await writeField(this.hub, item, "status", group.label);
			}
		}

		if (zone === "onto") {
			for (const item of items) await store.setLink(item.path, P.parent, targetPath);
			return;
		}

		const siblings = targetNode.parentNode ? targetNode.parentNode.children : (group?.roots ?? []);
		const index = siblings.indexOf(targetNode) + (zone === "after" ? 1 : 0);
		try {
			if (items.length === 1) {
				for (const [path, rank] of rerank(siblings.map((n) => n.item), items[0], index)) await store.update(path, { [P.rank]: rank });
			} else {
				const rest = siblings.map((n) => n.item).filter((i) => !dragging.includes(i.path));
				const final = [...rest.slice(0, Math.min(index, rest.length)), ...items, ...rest.slice(Math.min(index, rest.length))];
				for (let i = 0; i < final.length; i++) {
					const rank = (i + 1) * 1000;
					if (final[i].rank !== rank) await store.update(final[i].path, { [P.rank]: rank });
				}
			}
		} catch (e) {
			console.error("Project Hub: could not reorder the backlog", e);
		}
	}

	private groupOf(path: string): BacklogGroup | undefined {
		for (const entry of this.flat) if (entry.node.item.path === path) return entry.group;
		return undefined;
	}

	/** Moves the dragged rows in the DOM so the drop feels instant. */
	private moveRowsOptimistically(dragging: string[], targetPath: string, zone: "before" | "after" | "onto"): void {
		const targetRow = this.rowEl(targetPath);
		if (!targetRow) return;
		const rows = dragging.map((p) => this.rowEl(p)).filter((r): r is HTMLElement => !!r);
		if (zone === "onto") {
			for (const row of rows) row.removeClass("is-dragging");
			return;
		}
		for (const row of rows) {
			row.removeClass("is-dragging");
			const ref = zone === "before" ? targetRow : targetRow.nextElementSibling;
			if (row.parentElement) row.parentElement.insertBefore(row, ref);
		}
		this.paintSelection();
	}

	private rowEl(path: string): HTMLElement | null {
		return this.bodyEl?.querySelector<HTMLElement>(`.ph-bl-row[data-path="${quotePath(path)}"]`) ?? null;
	}

	private paintSelection(): void {
		this.bodyEl?.querySelectorAll<HTMLElement>(".ph-bl-row").forEach((row) => {
			const path = row.dataset.path;
			row.toggleClass("is-selected", !!path && this.selection.has(path));
		});
	}

	// ---------------------------------------------------------------- keyboard

	private onKeydown(e: KeyboardEvent): void {
		const target = e.target as HTMLElement | null;
		if (!target || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
		const row = target.closest<HTMLElement>(".ph-bl-row");
		const path = row?.dataset.path;
		if (!row || !path) return;
		const item = this.hub.store.getItem(path);
		if (!item) return;
		const entry = this.flat.find((f) => f.node.item.path === path);
		if (!entry) return;
		const store = this.hub.store;

		switch (e.key) {
			case "ArrowDown":
			case "ArrowUp": {
				e.preventDefault();
				const step = e.key === "ArrowDown" ? 1 : -1;
				const next = this.flat[this.flat.indexOf(entry) + step];
				if (next) this.focusRow(next.node.item.path);
				break;
			}
			case "ArrowRight":
			case "ArrowLeft": {
				e.preventDefault();
				const hasChildren = entry.node.children.length > 0;
				if (e.key === "ArrowRight") {
					if (hasChildren && this.collapsed.has(path)) {
						this.collapsed.delete(path);
						this.setCollapsed();
						this.paint();
					} else if (hasChildren) {
						this.focusRow(entry.node.children[0].item.path);
					}
				} else if (hasChildren && !this.collapsed.has(path)) {
					this.collapsed.add(path);
					this.setCollapsed();
					this.paint();
				} else if (entry.node.parentNode) {
					this.focusRow(entry.node.parentNode.item.path);
				}
				break;
			}
			case "Home":
			case "End": {
				e.preventDefault();
				const next = this.flat[e.key === "Home" ? 0 : this.flat.length - 1];
				if (next) this.focusRow(next.node.item.path);
				break;
			}
			case "Enter":
				e.preventDefault();
				void this.hub.openPath(path, e.ctrlKey || e.metaKey);
				break;
			case "Tab": {
				e.preventDefault();
				const index = this.flat.indexOf(entry);
				if (e.shiftKey) {
					if (!entry.node.parentNode) break;
					this.write(store.setLink(path, P.parent, entry.node.parentNode.parentPath));
				} else {
					const previous = this.flat[index - 1];
					if (!previous || previous.node.depth !== entry.node.depth) break;
					this.write(store.setLink(path, P.parent, previous.node.item.path));
				}
				break;
			}
			case "Delete":
				e.preventDefault();
				void trashItems(this.hub, this.selection.resolveKey(path));
				break;
			case " ":
				e.preventDefault();
				this.selection.resolveKey(path);
				this.paintSelection();
				break;
			case "m":
			case "M": {
				e.preventDefault();
				const rect = row.getBoundingClientRect();
				const evt = new MouseEvent("contextmenu", { clientX: rect.left + 16, clientY: rect.top + 16, bubbles: true });
				statusMenu(this.hub, evt, this.selection.resolveKey(path));
				break;
			}
			case "c":
				if (e.ctrlKey || e.metaKey) {
					e.preventDefault();
					copyItemLink(this.hub, path);
				}
				break;
		}
	}

	private focusRow(path: string): void {
		this.focusPath = path;
		this.rowEl(path)?.focus();
	}

	private write(promise: Promise<void>): void {
		void promise.catch((e) => console.error("Project Hub: could not write the backlog change", e));
	}
}


// ---------------------------------------------------------------- registration

export function backlogOptions(): BasesAllOptions[] {
	return [
		{
			key: "phGroupBy",
			type: "dropdown",
			displayName: "Group by",
			default: "sprint",
			options: { Sprint: "sprint", Project: "project", Status: "status", None: "none" },
		},
		{ key: "hideDone", type: "toggle", displayName: "Hide done items", default: false },
	];
}

export function registerBacklogView(hub: Hub): void {
	hub.plugin.registerBasesView("ph-backlog", {
		name: "Backlog",
		icon: "list-tree",
		factory: (controller, containerEl) => new BacklogView(hub, controller, containerEl),
		options: () => backlogOptions(),
	});
}
