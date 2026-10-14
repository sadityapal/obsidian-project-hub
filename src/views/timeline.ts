// Gantt / roadmap timeline as a custom Bases view ("ph-timeline").
//
// Left pane: rows grouped by parent hierarchy, project, assignee, sprint or
// status. Right pane: a day-accurate time axis with bars, milestones, progress
// overlays, dependency arrows, sprint bands and a today line. Bars can be moved
// and resized by dragging; every write goes through hub.store.update.

import { BasesView, Menu, debounce, setIcon, setTooltip } from "obsidian";
import type { BasesAllOptions, QueryController } from "obsidian";
import type { Hub } from "../core/hub";
import { P, type WorkItem } from "../core/model";
import { addDays, clamp, daysBetween, isoDate, parseDate, today } from "../core/util";
import { avatar, showTooltip, statusMenu, tooltipRows } from "../ui/widgets";
import { pickItem, pickPerson } from "../ui/pickers";
import { byRank, viewRows } from "./base-helpers";

// ---------------------------------------------------------------- model

type Scale = "day" | "week" | "month" | "quarter";
type GroupBy = "none" | "project" | "parent" | "assignee" | "sprint" | "status";

export interface TimelineOptions {
	scale: Scale;
	phGroupBy: GroupBy;
	showDone: boolean;
}

const SCALES: Scale[] = ["day", "week", "month", "quarter"];
const BASE_PX_PER_DAY: Record<Scale, number> = { day: 26, week: 7, month: 2.6, quarter: 1 };

const ROW_H = 34;
const HEADER_H = 46;
const BAND_H = 16;
const LEFT_MIN = 150;
const LEFT_MAX = 480;
const DAY_MS = 86_400_000;

interface Bar {
	start: string;
	end: string;
	kind: "bar" | "milestone";
}

interface ItemRow {
	kind: "item";
	item: WorkItem;
	depth: number;
	bar: Bar | null;
	hasChildren: boolean;
}

interface GroupRow {
	kind: "group";
	key: string;
	label: string;
	icon?: string;
	sub?: string;
	items: WorkItem[];
	defaultClosed?: boolean;
}

type VRow = ItemRow | GroupRow;

interface Drag {
	item: WorkItem;
	mode: "move" | "start" | "end";
	originDate: string;
	barStart: string;
	barEnd: string;
	changed: boolean;
}

function toDate(date: string): Date {
	return parseDate(date) ?? new Date();
}

function startOfMonth(date: string): string {
	return isoDate(new Date(toDate(date).getFullYear(), toDate(date).getMonth(), 1));
}

function nextMonth(date: string): string {
	const d = toDate(date);
	return isoDate(new Date(d.getFullYear(), d.getMonth() + 1, 1));
}

function startOfQuarter(date: string): string {
	const d = toDate(date);
	return isoDate(new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1));
}

function nextQuarter(date: string): string {
	const d = toDate(date);
	return isoDate(new Date(d.getFullYear(), d.getMonth() + 3, 1));
}

function isWeekendDay(date: string): boolean {
	const day = toDate(date).getDay();
	return day === 0 || day === 6;
}

function workingDays(start: string, end: string): number {
	const a = toDate(start);
	const b = toDate(end);
	let n = 0;
	for (let d = new Date(a); d <= b; d.setDate(d.getDate() + 1)) {
		const day = d.getDay();
		if (day !== 0 && day !== 6) n++;
	}
	return n;
}

/** The bar for an item: null when it has no dates at all. */
function barOf(item: WorkItem): Bar | null {
	if (item.start && item.due) return { start: item.start, end: item.due, kind: "bar" };
	if (item.start) return { start: item.start, end: item.start, kind: "bar" };
	if (item.due) return { start: item.due, end: item.due, kind: "milestone" };
	return null;
}

interface Tick {
	start: string;
	days: number;
	label: string;
	weekend?: boolean;
}

function monthTicks(from: string, to: string): Tick[] {
	const out: Tick[] = [];
	let cursor = startOfMonth(from);
	while (cursor <= to) {
		const next = nextMonth(cursor);
		const end = next <= to ? addDays(next, -1) : to;
		out.push({ start: cursor, days: daysBetween(cursor, end) + 1, label: monthLabel(cursor) });
		cursor = next;
	}
	return out;
}

function monthLabel(date: string): string {
	const d = toDate(date);
	return d.toLocaleDateString(undefined, { month: "short" }) + (d.getMonth() === 0 ? ` ${d.getFullYear()}` : "");
}

function weekTicks(from: string, to: string): Tick[] {
	const out: Tick[] = [];
	let cursor = from;
	while (cursor <= to) {
		const end = addDays(cursor, 6) <= to ? addDays(cursor, 6) : to;
		out.push({ start: cursor, days: daysBetween(cursor, end) + 1, label: toDate(cursor).toLocaleDateString(undefined, { month: "short", day: "numeric" }) });
		cursor = addDays(end, 1);
	}
	return out;
}

function dayTicks(from: string, to: string): Tick[] {
	const out: Tick[] = [];
	for (let cursor = from; cursor <= to; cursor = addDays(cursor, 1)) {
		out.push({ start: cursor, days: 1, label: String(toDate(cursor).getDate()), weekend: isWeekendDay(cursor) });
	}
	return out;
}

function quarterTicks(from: string, to: string): Tick[] {
	const out: Tick[] = [];
	let cursor = startOfQuarter(from);
	while (cursor <= to) {
		const next = nextQuarter(cursor);
		const end = next <= to ? addDays(next, -1) : to;
		const d = toDate(cursor);
		out.push({ start: cursor, days: daysBetween(cursor, end) + 1, label: `Q${Math.floor(d.getMonth() / 3) + 1} ${d.getFullYear()}` });
		cursor = next;
	}
	return out;
}

function ticksFor(scale: Scale, from: string, to: string): Tick[] {
	switch (scale) {
		case "day":
			return dayTicks(from, to);
		case "week":
			return weekTicks(from, to);
		case "month":
			return monthTicks(from, to);
		case "quarter":
			return quarterTicks(from, to);
	}
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

// ---------------------------------------------------------------- view

export class TimelineView extends BasesView {
	readonly type = "ph-timeline";

	private root: HTMLElement | null = null;
	private toolbarEl: HTMLElement | null = null;
	private chartEl: HTMLElement | null = null;
	private contentEl: HTMLElement | null = null;
	private headerEl: HTMLElement | null = null;
	private bandEl: HTMLElement | null = null;
	private gridEl: HTMLElement | null = null;
	private depEl: SVGSVGElement | null = null;
	private leftEl: HTMLElement | null = null;
	private leftInner: HTMLElement | null = null;
	private dividerEl: HTMLElement | null = null;
	private searchEl: HTMLInputElement | null = null;
	private scaleEl: HTMLSelectElement | null = null;
	private countEl: HTMLElement | null = null;
	private doneBtn: HTMLButtonElement | null = null;

	private opts: TimelineOptions = { scale: "week", phGroupBy: "parent", showDone: true };
	private zoom = 1;
	private search = "";
	private leftWidth = 260;
	private collapsed = new Set<string>();
	private expanded = new Set<string>();
	private range: { from: string; to: string } = { from: today(), to: addDays(today(), 56) };
	private rows: VRow[] = [];
	private rowEls = new Map<string, HTMLElement>();
	private bars = new Map<string, { x: number; w: number; y: number }>();
	private scroll = { left: 0, top: 0 };
	private drag: Drag | null = null;
	private ghostEl: HTMLElement | null = null;
	private paintSoon = debounce(() => this.paint(), 120, true);
	private firstPaint = true;

	constructor(
		private hub: Hub,
		controller: QueryController,
		private hostEl: HTMLElement,
	) {
		super(controller);
		this.leftWidth = this.readLeftWidth();
		hostEl.addClass("ph-timeline-host");
		if (hostEl.closest(".internal-embed, .bases-embed, .markdown-preview-view .bases")) hostEl.addClass("ph-timeline-embedded");
	}

	onload(): void {
		this.opts = this.readOptions();
		this.loadCollapsed();
		this.build();
		this.registerEvent(this.hub.store.on("changed", () => this.paintSoon()));
		this.paint();
	}

	onunload(): void {
		this.drag = null;
	}

	onDataUpdated(): void {
		this.paintSoon();
	}

	// ---------------------------------------------------------------- shell

	private readLeftWidth(): number {
		const v = this.config.get("ph-left-width");
		return typeof v === "number" ? clamp(Math.round(v), LEFT_MIN, LEFT_MAX) : 260;
	}

	private build(): void {
		const root = (this.root = this.hostEl.createDiv({ cls: "ph-timeline" }));

		const toolbar = (this.toolbarEl = root.createDiv({ cls: "ph-tl-toolbar" }));
		const search = (this.searchEl = toolbar.createEl("input", { cls: "ph-tl-search", attr: { type: "search", placeholder: "Filter items…" } }));
		search.addEventListener("input", () => {
			this.search = search.value.trim().toLowerCase();
			this.paint();
		});

		const scale = (this.scaleEl = toolbar.createEl("select", { cls: "ph-tl-scale", attr: { "aria-label": "Time scale" } }));
		for (const s of SCALES) scale.createEl("option", { text: s[0].toUpperCase() + s.slice(1), value: s });
		scale.value = this.opts.scale;
		scale.addEventListener("change", () => {
			void this.config.set("scale", scale.value);
			this.paint();
		});

		this.iconBtn(toolbar, "minus", "Zoom out", () => this.stepZoom(-0.25));
		this.iconBtn(toolbar, "plus", "Zoom in", () => this.stepZoom(0.25));
		this.iconBtn(toolbar, "calendar-dot", "Scroll to today", () => this.scrollToToday(true));
		this.iconBtn(toolbar, "maximize", "Fit all items", () => this.fit());

		const done = (this.doneBtn = toolbar.createEl("button", { cls: "ph-tl-btn", attr: { type: "button", "aria-pressed": "false" } }));
		setIcon(done.createSpan({ cls: "ph-tl-btn-icon" }), "check");
		done.createSpan({ cls: "ph-tl-btn-label", text: "Done" });
		done.addEventListener("click", () => {
			void this.config.set("showDone", !this.opts.showDone);
			this.paint();
		});

		const count = (this.countEl = toolbar.createDiv({ cls: "ph-tl-count" }));

		const body = root.createDiv({ cls: "ph-tl-body" });

		const left = (this.leftEl = body.createDiv({ cls: "ph-tl-left" }));
		left.style.width = `${this.leftWidth}px`;
		this.leftInner = left.createDiv({ cls: "ph-tl-left-inner" });

		const divider = (this.dividerEl = body.createDiv({ cls: "ph-tl-divider" }));
		this.initDivider(divider);

		const chart = (this.chartEl = body.createDiv({ cls: "ph-tl-chart" }));
		chart.addEventListener("scroll", () => {
			this.scroll = { left: chart.scrollLeft, top: chart.scrollTop };
			if (this.leftInner) this.leftInner.style.transform = `translateY(${-chart.scrollTop}px)`;
		});

		const content = (this.contentEl = chart.createDiv({ cls: "ph-tl-content" }));
		const headerWrap = (this.headerEl = content.createDiv({ cls: "ph-tl-header" }));
		headerWrap.style.height = `${HEADER_H + BAND_H}px`;
		this.bandEl = headerWrap.createDiv({ cls: "ph-tl-bands" });
		this.bandEl.style.height = `${BAND_H}px`;
		const axis = headerWrap.createDiv({ cls: "ph-tl-axis" });
		axis.style.height = `${HEADER_H - BAND_H}px`;

		this.gridEl = content.createDiv({ cls: "ph-tl-grid" });
		this.depEl = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		this.depEl.classList.add("ph-tl-deps");
		this.gridEl.appendChild(this.depEl);
		this.gridEl.addEventListener("dragover", (e) => {
			if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
			e.preventDefault();
		});
		this.gridEl.addEventListener("drop", (e) => void this.onGridDrop(e));
		body.addEventListener("keydown", (e) => this.onKeydown(e));
		void count;
	}

	private readOptions(): TimelineOptions {
		const scale = readString(this, "scale", "week", SCALES);
		const groupBy = this.config.get("phGroupBy");
		const allowed: GroupBy[] = ["none", "project", "parent", "assignee", "sprint", "status"];
		return {
			scale: (SCALES.includes(scale as Scale) ? scale : "week") as Scale,
			phGroupBy: allowed.includes(groupBy as GroupBy) ? (groupBy as GroupBy) : "parent",
			showDone: readBool(this, "showDone", true),
		};
	}

	private iconBtn(parent: HTMLElement, icon: string, tooltip: string, run: () => void): HTMLButtonElement {
		const btn = parent.createEl("button", { cls: "ph-tl-btn ph-tl-icon-btn", attr: { type: "button", "aria-label": tooltip } });
		setIcon(btn, icon);
		setTooltip(btn, tooltip, { placement: "top" });
		btn.addEventListener("click", run);
		return btn;
	}

	private stepZoom(delta: number): void {
		this.zoom = clamp(Math.round((this.zoom + delta) * 100) / 100, 0.5, 3);
		this.paint();
	}

	private initDivider(divider: HTMLElement): void {
		divider.addEventListener("pointerdown", (e) => {
			e.preventDefault();
			divider.setPointerCapture(e.pointerId);
			const startX = e.clientX;
			const startW = this.leftWidth;
			const move = (ev: PointerEvent) => {
				this.leftWidth = clamp(startW + (ev.clientX - startX), LEFT_MIN, LEFT_MAX);
				if (this.leftEl) this.leftEl.style.width = `${this.leftWidth}px`;
			};
			const up = () => {
				divider.releasePointerCapture(e.pointerId);
				divider.removeEventListener("pointermove", move);
				divider.removeEventListener("pointerup", up);
				void this.config.set("ph-left-width", this.leftWidth);
			};
			divider.addEventListener("pointermove", move);
			divider.addEventListener("pointerup", up);
		});
	}

	// ---------------------------------------------------------------- data

	private pxPerDay(): number {
		return BASE_PX_PER_DAY[this.opts.scale] * this.zoom;
	}

	private visibleItems(): WorkItem[] {
		const { items } = viewRows(this.hub, this);
		const q = this.search;
		const showDone = this.opts.showDone;
		return items
			.filter((it) => (showDone ? true : !this.hub.store.isDone(it) && !this.hub.store.isRemoved(it)))
			.filter((it) => (q ? it.title.toLowerCase().includes(q) || it.id.toLowerCase().includes(q) || it.labels.some((l) => l.toLowerCase().includes(q)) : true));
	}

	private buildRows(items: WorkItem[]): VRow[] {
		switch (this.opts.phGroupBy) {
			case "parent":
				return this.rowsByParent(items);
			case "project":
				return this.rowsByFields(items, (it) => ({ key: it.project ?? "", label: it.project ? this.hub.store.displayName(it.project) : "No project" }));
			case "assignee":
				return this.rowsByFields(items, (it) => ({ key: it.assignee ?? "", label: it.assignee ? this.hub.store.displayName(it.assignee) : "Unassigned" }));
			case "sprint":
				return this.rowsBySprint(items);
			case "status":
				return this.rowsByStatus(items);
			default:
				return items.map((item) => ({ kind: "item", item, depth: 0, bar: barOf(item), hasChildren: this.hub.store.children(item.path).length > 0 }));
		}
	}

	private itemRow(item: WorkItem, depth: number): ItemRow {
		return { kind: "item", item, depth, bar: barOf(item), hasChildren: this.hub.store.children(item.path).length > 0 };
	}

	private rowsByParent(items: WorkItem[]): VRow[] {
		const byPath = new Map(items.map((it) => [it.path, it]));
		const childOf = new Map<string, string | null>();
		for (const it of items) childOf.set(it.path, it.parent && byPath.has(it.parent) ? it.parent : null);
		const kids = new Map<string, WorkItem[]>();
		for (const it of items) {
			const parent = childOf.get(it.path) ?? null;
			if (!parent) continue;
			const arr = kids.get(parent) ?? [];
			arr.push(it);
			kids.set(parent, arr);
		}
		const out: VRow[] = [];
		const emit = (item: WorkItem, depth: number) => {
			out.push(this.itemRow(item, depth));
			if (this.collapsed.has(item.path)) return;
			for (const kid of byRank(kids.get(item.path) ?? [])) emit(kid, depth + 1);
		};
		for (const it of byRank(items.filter((it) => !childOf.get(it.path)))) emit(it, 0);
		return out;
	}

	private rowsByFields(items: WorkItem[], keyOf: (it: WorkItem) => { key: string; label: string }): VRow[] {
		const groups = new Map<string, { label: string; items: WorkItem[] }>();
		for (const it of items) {
			const { key, label } = keyOf(it);
			const g = groups.get(key) ?? { label, items: [] };
			g.items.push(it);
			groups.set(key, g);
		}
		const out: VRow[] = [];
		for (const [key, g] of groups) {
			out.push({ kind: "group", key, label: g.label, items: byRank(g.items) });
			if (!this.groupOpen(key, false)) continue;
			for (const it of byRank(g.items)) out.push(this.itemRow(it, 1));
		}
		return out;
	}

	private rowsBySprint(items: WorkItem[]): VRow[] {
		const sprints = this.hub.store.sortedSprints();
		const past: WorkItem[] = [];
		const backlog = items.filter((it) => !it.sprint);
		const out: VRow[] = [];
		const emitGroup = (key: string, label: string, sub: string | undefined, groupItems: WorkItem[], defaultClosed = false) => {
			if (!groupItems.length) return;
			out.push({ kind: "group", key, label, sub, items: byRank(groupItems), defaultClosed });
			if (!this.groupOpen(key, defaultClosed)) return;
			for (const it of byRank(groupItems)) out.push(this.itemRow(it, 1));
		};
		const current = sprints.find((s) => s.state === "Current");
		if (current) emitGroup(current.path, `Current · ${current.name}`, sprintRange(current.start, current.end), items.filter((it) => it.sprint === current.path));
		for (const s of sprints.filter((s) => s.state === "Future")) {
			emitGroup(s.path, s.name, sprintRange(s.start, s.end), items.filter((it) => it.sprint === s.path));
		}
		emitGroup("ph-backlog", "Backlog", undefined, backlog);
		for (const s of sprints.filter((s) => s.state === "Past")) {
			past.push(...items.filter((it) => it.sprint === s.path));
		}
		emitGroup("ph-past", "Past sprints", undefined, past, true);
		return out;
	}

	private rowsByStatus(items: WorkItem[]): VRow[] {
		const out: VRow[] = [];
		for (const def of this.hub.settings.statuses) {
			if (def.name === "Removed") continue;
			const groupItems = items.filter((it) => it.status === def.name);
			if (!groupItems.length) continue;
			const key = `status:${def.name}`;
			out.push({ kind: "group", key, label: def.name, items: byRank(groupItems) });
			if (!this.groupOpen(key, false)) continue;
			for (const it of byRank(groupItems)) out.push(this.itemRow(it, 1));
		}
		const rest = items.filter((it) => !this.hub.settings.statuses.some((s) => s.name === it.status));
		for (const it of byRank(rest)) out.push(this.itemRow(it, 0));
		return out;
	}

	// ---------------------------------------------------------------- time range

	private computeRange(items: WorkItem[]): void {
		const scheduled = items.map(barOf).filter((b): b is Bar => b !== null);
		if (!scheduled.length) {
			const end = addDays(today(), 56);
			this.range = { from: addDays(today(), -14), to: end };
			return;
		}
		const from = scheduled.reduce((min, b) => (b.start < min ? b.start : min), scheduled[0].start);
		const to = scheduled.reduce((max, b) => (b.end > max ? b.end : max), scheduled[0].end);
		this.range = { from: addDays(from, -5), to: addDays(to, 5) };
	}

	private xOf(date: string): number {
		return daysBetween(this.range.from, date) * this.pxPerDay();
	}

	private dateAtX(x: number): string {
		const days = Math.round(x / this.pxPerDay());
		return addDays(this.range.from, days);
	}

	private chartWidth(): number {
		return Math.max(320, (daysBetween(this.range.from, this.range.to) + 1) * this.pxPerDay());
	}

	private fit(): void {
		const items = this.visibleItems();
		this.computeRange(items);
		this.paint();
	}

	private scrollToToday(focus: boolean): void {
		if (!this.chartEl) return;
		const x = this.xOf(today());
		this.chartEl.scrollTo({ left: Math.max(0, x - this.chartEl.clientWidth / 3), behavior: focus ? "smooth" : "auto" });
	}

	// ---------------------------------------------------------------- paint

	private paint(): void {
		if (!this.root || !this.gridEl || !this.headerEl || !this.leftInner) return;
		this.opts = this.readOptions();
		this.drag = null;
		if (this.scaleEl) this.scaleEl.value = this.opts.scale;
		if (this.doneBtn) this.doneBtn.setAttribute("aria-pressed", String(this.opts.showDone));

		const items = this.visibleItems();
		this.rows = this.buildRows(items);
		this.computeRange(items);

		const width = this.chartWidth();
		const totalH = Math.max(120, this.rows.length * ROW_H + 24);

		if (this.contentEl) this.contentEl.style.width = `${width + this.leftWidth}px`;
		if (this.gridEl) {
			this.gridEl.style.width = `${width}px`;
			this.gridEl.style.height = `${totalH}px`;
		}
		this.paintHeader(width);
		this.paintBands(items, width);
		this.paintGridlines(width, totalH);
		this.paintRows(width);
		this.paintDeps(width, totalH);

		if (this.countEl) {
			const pts = items.reduce((n, it) => n + (it.points ?? 0), 0);
			this.countEl.setText(`${items.length} item${items.length === 1 ? "" : "s"} · ${pts} pts`);
		}

		if (this.firstPaint) {
			this.firstPaint = false;
			this.scrollToToday(false);
		} else if (this.chartEl) {
			this.chartEl.scrollTo({ left: this.scroll.left, top: this.scroll.top });
		}
		if (this.leftInner) this.leftInner.style.transform = `translateY(${-this.scroll.top}px)`;
	}

	private paintHeader(width: number): void {
		const header = this.headerEl;
		if (!header) return;
		const axis = header.querySelector<HTMLElement>(".ph-tl-axis");
		if (!axis) return;
		axis.empty();
		axis.style.width = `${width}px`;
		const scale = this.opts.scale;
		const ticks = ticksFor(scale, this.range.from, this.range.to);
		for (const t of ticks) {
			const cell = axis.createDiv({ cls: `ph-tl-tick${t.weekend ? " ph-tl-weekend" : ""}${scale === "month" || scale === "quarter" ? " ph-tl-tick-major" : ""}` });
			cell.style.left = `${this.xOf(t.start)}px`;
			cell.style.width = `${t.days * this.pxPerDay()}px`;
			cell.createSpan({ cls: "ph-tl-tick-label", text: t.label });
			if (scale === "day") cell.setAttribute("data-weekend", t.weekend ? "true" : "false");
		}
		const todayX = this.xOf(today());
		if (todayX >= 0 && todayX <= width) {
			const marker = axis.createDiv({ cls: "ph-tl-today-head" });
			marker.style.left = `${todayX}px`;
			marker.setText("Today");
		}
	}

	private paintBands(items: WorkItem[], width: number): void {
		const bands = this.bandEl;
		if (!bands) return;
		bands.empty();
		bands.style.width = `${width}px`;
		const groupBy = this.opts.phGroupBy;
		if (groupBy === "project") {
			const projects = new Set(items.map((it) => it.project).filter((p): p is string => !!p));
			for (const path of projects) {
				const target = this.hub.store.getEntity(path);
				const date = target && target.kind === "project" ? target.target : null;
				if (!date) continue;
				const diamond = bands.createDiv({ cls: "ph-tl-band-target", attr: { title: `${this.hub.store.displayName(path)} target ${date}` } });
				diamond.style.left = `${this.xOf(date)}px`;
			}
		}
		for (const sprint of this.hub.store.sortedSprints()) {
			if (!sprint.start || !sprint.end) continue;
			const left = this.xOf(sprint.start);
			if (left > width || this.xOf(sprint.end) < 0) continue;
			const band = bands.createDiv({ cls: `ph-tl-band${sprint.state === "Current" ? " ph-tl-band-current" : ""}` });
			band.style.left = `${left}px`;
			band.style.width = `${Math.max(4, (daysBetween(sprint.start, sprint.end) + 1) * this.pxPerDay())}px`;
			band.createSpan({ cls: "ph-tl-band-label", text: sprint.name });
		}
	}

	private paintGridlines(width: number, height: number): void {
		const grid = this.gridEl;
		if (!grid) return;
		for (const el of Array.from(grid.querySelectorAll(".ph-tl-gridline, .ph-tl-todayline, .ph-tl-empty"))) el.remove();
		const scale = this.opts.scale;
		const ticks = ticksFor(scale, this.range.from, this.range.to).filter((t) => scale === "day" ? t.weekend !== true : true);
		for (const t of ticks) {
			const line = grid.createDiv({ cls: `ph-tl-gridline${scale === "day" ? " ph-tl-gridline-week" : ""}` });
			line.style.left = `${this.xOf(t.start)}px`;
			line.style.height = `${height}px`;
		}
		const todayX = this.xOf(today());
		if (todayX >= 0 && todayX <= width) {
			const todayLine = grid.createDiv({ cls: "ph-tl-todayline" });
			todayLine.style.left = `${todayX}px`;
			todayLine.style.height = `${height}px`;
		}
		if (!this.rows.length) {
			const empty = grid.createDiv({ cls: "ph-tl-empty", text: "No items match. Adjust the base filters or clear the search." });
		}
	}

	private paintRows(width: number): void {
		const grid = this.gridEl;
		const left = this.leftInner;
		if (!grid || !left) return;
		this.rowEls.clear();
		this.bars.clear();
		for (const el of Array.from(grid.querySelectorAll(".ph-tl-row"))) el.remove();
		for (const el of Array.from(left.querySelectorAll(".ph-tl-lrow"))) el.remove();
		this.rows.forEach((row, i) => this.paintRow(row, i, grid, left, width));
	}

	private paintRow(row: VRow, i: number, grid: HTMLElement, left: HTMLElement, width: number): void {
		const top = i * ROW_H;
		if (row.kind === "group") {
			const head = grid.createDiv({ cls: "ph-tl-row ph-tl-row-group" });
			head.style.top = `${top}px`;
			head.style.width = `${width}px`;
			head.createSpan({ cls: "ph-tl-group-dot" });
			head.createSpan({ cls: "ph-tl-group-label", text: row.label });
			if (row.sub) head.createSpan({ cls: "ph-tl-group-sub", text: row.sub });
			head.createSpan({ cls: "ph-tl-group-count", text: String(row.items.length) });
			head.addEventListener("click", () => {
				if (this.groupOpen(row.key, !!row.defaultClosed)) {
					this.collapsed.add(row.key);
					this.expanded.delete(row.key);
				} else {
					this.collapsed.delete(row.key);
					this.expanded.add(row.key);
				}
				void this.persistCollapsed();
				this.paint();
			});
			const lrow = left.createDiv({ cls: "ph-tl-lrow ph-tl-lrow-group" });
			lrow.style.transform = `translateY(${top}px)`;
			const caret = lrow.createSpan({ cls: "ph-tl-caret" });
			setIcon(caret, this.groupOpen(row.key, !!row.defaultClosed) ? "chevron-down" : "chevron-right");
			lrow.createSpan({ cls: "ph-tl-group-label", text: row.label });
			return;
		}

		const item = row.item;
		const rowEl = grid.createDiv({ cls: "ph-tl-row" });
		rowEl.style.top = `${top}px`;
		rowEl.style.width = `${width}px`;
		rowEl.dataset.path = item.path;
		const lrow = left.createDiv({ cls: "ph-tl-lrow" });
		lrow.style.transform = `translateY(${top}px)`;
		lrow.style.paddingLeft = `${8 + row.depth * 16}px`;
		lrow.dataset.path = item.path;

		const iconEl = lrow.createSpan({ cls: "ph-tl-type" });
		setIcon(iconEl, this.hub.store.typeIcon(item.type));
		lrow.createSpan({ cls: "ph-tl-id", text: item.id });
		const title = lrow.createSpan({ cls: "ph-tl-title", text: item.title });
		title.addEventListener("click", (e) => void this.hub.openPath(item.path, e.ctrlKey || e.metaKey));
		lrow.addEventListener("mouseenter", (e) => this.rowTooltip(e, item));
		this.rowEls.set(item.path, rowEl);

		if (!row.bar) {
			const hint = rowEl.createDiv({ cls: "ph-tl-unsched" });
			setIcon(hint.createSpan({ cls: "ph-tl-unsched-icon" }), "calendar-plus");
			hint.createSpan({ text: "Drag onto the timeline to schedule" });
			hint.draggable = true;
			hint.addEventListener("dragstart", (e) => {
				if (e.dataTransfer) e.dataTransfer.setData("text/plain", `ph-item:${item.path}`);
			});
			rowEl.addEventListener("contextmenu", (e) => this.itemMenu(e, item));
			return;
		}

		const bar = row.bar;
		const x = this.xOf(bar.start);
		const w = Math.max(10, (daysBetween(bar.start, bar.end) + 1) * this.pxPerDay());
		const barEl = rowEl.createDiv({
			cls: `ph-tl-bar${bar.kind === "milestone" ? " ph-tl-milestone" : ""}${this.hub.store.isDone(item) ? " ph-tl-done" : ""}${this.isOverdue(item) ? " ph-tl-overdue" : ""}`,
		});
		const def = this.hub.store.statusDef(item.status);
		if (def) barEl.setAttribute("data-ph-color", def.color);
		barEl.style.left = `${x}px`;
		barEl.style.width = `${w}px`;
		barEl.setAttribute("tabindex", "0");
		barEl.setAttribute("role", "button");
		barEl.setAttribute("aria-label", `${item.id} ${item.title}, ${bar.start} to ${bar.end}`);

		if (bar.kind === "bar") {
			barEl.createEl("span", { cls: "ph-tl-bar-label", text: item.title });
			if (row.hasChildren || this.hub.store.isDone(item)) {
				const pct = this.hub.store.isDone(item) ? 100 : this.hub.store.rollup(item.path).progress;
				if (pct > 0) barEl.createDiv({ cls: "ph-tl-progress" }).style.width = `${clamp(pct, 0, 100)}%`;
			}
		}
		if (this.isOverdue(item)) setIcon(barEl.createSpan({ cls: "ph-tl-warn" }), "alarm-clock");
		if (item.assignee) avatar(barEl, this.hub.store.displayName(item.assignee), 18);
		this.bars.set(item.path, { x, w, y: top });

		barEl.addEventListener("pointerdown", (e) => this.onBarPointerDown(e, item, bar, barEl, rowEl));
		barEl.addEventListener("contextmenu", (e) => this.itemMenu(e, item));
		barEl.addEventListener("click", (e) => {
			if (this.drag?.changed) return;
			void this.hub.openPath(item.path, e.ctrlKey || e.metaKey);
		});
		barEl.addEventListener("mouseenter", (e) => this.rowTooltip(e, item));
	}

	private isOverdue(item: WorkItem): boolean {
		return this.hub.store.isOverdue(item);
	}

	// ---------------------------------------------------------------- interactions

	private rowTooltip(evt: MouseEvent, item: WorkItem): void {
		showTooltip(evt, (el) => {
			const bar = barOf(item);
			const rows: [string, string][] = [];
			if (bar) {
				rows.push(["Dates", bar.kind === "milestone" ? `Due ${bar.end}` : `${bar.start} → ${bar.end} (${workingDays(bar.start, bar.end)} working days)`]);
			}
			if (item.assignee) rows.push(["Assignee", this.hub.store.displayName(item.assignee)]);
			if (item.points !== null) rows.push(["Points", String(item.points)]);
			const kids = this.hub.store.children(item.path);
			if (kids.length) rows.push(["Progress", `${this.hub.store.rollup(item.path).done}/${kids.length} done`]);
			if (item.blockedBy.length) rows.push(["Blocked by", item.blockedBy.map((p) => this.hub.store.displayName(p)).join(", ")]);
			tooltipRows(el, `${item.id} · ${item.title}`, [[ "Status", item.status ], ...rows]);
		});
	}

	private itemMenu(evt: MouseEvent, item: WorkItem): void {
		evt.preventDefault();
		evt.stopPropagation();
		const menu = new Menu();
		menu.addItem((m) => m.setTitle("Open").onClick(() => void this.hub.openPath(item.path)));
		menu.addItem((m) => m.setTitle("Open in new tab").onClick(() => void this.hub.openPath(item.path, true)));
		menu.addItem((m) => m.setTitle("Set status…").onClick(() => statusMenu(this.hub, evt, [item])));
		menu.addItem((m) =>
			m.setTitle("Assign…").onClick(async () => {
				const person = await pickPerson(this.hub, { allowNone: true });
				if (person !== undefined) await this.hub.store.setLink(item.path, P.assignee, person);
			}),
		);
		menu.addItem((m) =>
			m.setTitle("Blocked by…").onClick(async () => {
				const exclude = new Set([item.path, ...this.hub.store.descendants(item.path).map((d) => d.path)]);
				const blocker = await pickItem(this.hub, { exclude });
				if (!blocker) return;
				const list = item.blockedBy.includes(blocker) ? item.blockedBy : [...item.blockedBy, this.hub.store.linkTo(blocker, item.path)];
				await this.hub.store.update(item.path, { [P.blockedBy]: list });
			}),
		);
		if (item.blockedBy.length) {
			menu.addItem((m) =>
				m.setTitle("Remove dependency…").onClick(() => {
					const sub = new Menu();
					if (!item.blockedBy.length) sub.addItem((s) => s.setTitle("None").setDisabled(true));
					for (const path of item.blockedBy) {
						sub.addItem((s) => s.setTitle(`Remove ${this.hub.store.displayName(path)}`).onClick(() => void this.removeBlocker(item, path)));
					}
					sub.showAtMouseEvent(evt);
				}),
			);
		}
		menu.addItem((m) =>
			m.setTitle("Clear dates").onClick(() => void this.hub.store.update(item.path, { [P.start]: null, [P.due]: null })),
		);
		menu.showAtMouseEvent(evt);
	}

	private async removeBlocker(item: WorkItem, path: string): Promise<void> {
		const list = item.blockedBy.filter((p) => p !== path);
		await this.hub.store.update(item.path, { [P.blockedBy]: list });
	}

	private onBarPointerDown(evt: PointerEvent, item: WorkItem, bar: Bar, barEl: HTMLElement, rowEl: HTMLElement): void {
		if (evt.button !== 0) return;
		const rect = barEl.getBoundingClientRect();
		const offset = evt.clientX - rect.left;
		const edge = Math.max(5, Math.min(10, rect.width / 4));
		const mode: Drag["mode"] = Math.abs(rect.width - offset) <= edge ? "end" : offset <= edge ? "start" : "move";
		this.drag = { item, mode, originDate: this.dateAtX(evt.clientX - (this.gridEl?.getBoundingClientRect().left ?? 0) + (this.gridEl?.scrollLeft ?? 0)), barStart: bar.start, barEnd: bar.end, changed: false };
		barEl.setPointerCapture(evt.pointerId);
		rowEl.addClass("ph-tl-row-dragging");

		const move = (e: PointerEvent) => this.onBarPointerMove(e, barEl, rowEl);
		const up = (e: PointerEvent) => {
			// A re-render during the drag detaches barEl, which implicitly drops
			// pointer capture — releasing it again throws, so keep cleanup safe and
			// always commit whatever dates the drag produced.
			try {
				barEl.releasePointerCapture(e.pointerId);
			} catch {
				/* element already re-rendered; nothing to release */
			}
			barEl.removeEventListener("pointermove", move);
			barEl.removeEventListener("pointerup", up);
			barEl.removeEventListener("pointercancel", up);
			rowEl.removeClass("ph-tl-row-dragging");
			this.ghostEl?.remove();
			this.ghostEl = null;
			void this.commitDrag();
		};
		barEl.addEventListener("pointermove", move);
		barEl.addEventListener("pointerup", up);
		barEl.addEventListener("pointercancel", up);
	}

	private onBarPointerMove(evt: PointerEvent, barEl: HTMLElement, rowEl: HTMLElement): void {
		const drag = this.drag;
		const grid = this.gridEl;
		if (!drag || !grid) return;
		const gridRect = grid.getBoundingClientRect();
		const x = evt.clientX - gridRect.left + grid.scrollLeft;
		const date = this.dateAtX(x);
		if (date === drag.originDate && drag.mode === "move") return;
		const dayShift = daysBetween(drag.originDate, date);
		if (dayShift === 0 && drag.mode !== "move") {
			drag.changed = true;
			return;
		}
		let start = drag.barStart;
		let end = drag.barEnd;
		if (drag.mode === "move") {
			start = addDays(drag.barStart, dayShift);
			end = addDays(drag.barEnd, dayShift);
		} else if (drag.mode === "start") {
			start = date > drag.barEnd ? drag.barEnd : date;
		} else {
			end = date < drag.barStart ? drag.barStart : date;
		}
		if (start === drag.barStart && end === drag.barEnd) return;
		drag.changed = true;
		drag.barStart = start;
		drag.barEnd = end;
		const x1 = this.xOf(start);
		const w = Math.max(10, (daysBetween(start, end) + 1) * this.pxPerDay());
		barEl.style.left = `${x1}px`;
		barEl.style.width = `${w}px`;
		this.showDragTooltip(evt, start, end);
		void rowEl;
	}

	private showDragTooltip(evt: PointerEvent, start: string, end: string): void {
		showTooltip(evt, (el) => {
			tooltipRows(el, "New dates", [
				["Start", start],
				["Due", end],
				["Working days", String(workingDays(start, end))],
			]);
		});
	}

	private async commitDrag(): Promise<void> {
		const drag = this.drag;
		this.drag = null;
		if (!drag?.changed) return;
		const patch: Record<string, unknown> = {};
		if (drag.barStart !== barOf(drag.item)?.start) patch[P.start] = drag.barStart;
		if (drag.barEnd !== barOf(drag.item)?.end) patch[P.due] = drag.barEnd;
		if (!Object.keys(patch).length) return;
		await this.hub.store.update(drag.item.path, patch);
	}

	private async onGridDrop(evt: DragEvent): Promise<void> {
		const raw = evt.dataTransfer?.getData("text/plain") ?? "";
		const path = raw.startsWith("ph-item:") ? raw.slice("ph-item:".length) : "";
		if (!path) return;
		evt.preventDefault();
		const grid = this.gridEl;
		if (!grid) return;
		const rect = grid.getBoundingClientRect();
		const day = this.dateAtX(evt.clientX - rect.left + grid.scrollLeft);
		await this.hub.store.update(path, { [P.start]: day, [P.due]: addDays(day, 3) });
	}

	private onKeydown(evt: KeyboardEvent): void {
		if (evt.key === "Escape" && this.drag) {
			this.drag = null;
			this.paint();
		}
	}

	// ---------------------------------------------------------------- dependencies

	private paintDeps(width: number, height: number): void {
		const svg = this.depEl;
		if (!svg) return;
		svg.setAttribute("width", String(width));
		svg.setAttribute("height", String(height));
		svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
		for (const child of Array.from(svg.children)) child.remove();
		const rows = this.rows.filter((r): r is ItemRow => r.kind === "item");
		const visible = new Map(rows.map((r) => [r.item.path, r]));
		for (const row of rows) {
			for (const blockerPath of row.item.blockedBy) {
				const blocker = visible.get(blockerPath);
				if (!blocker?.bar || !row.bar) continue;
				const from = this.bars.get(blockerPath);
				const to = this.bars.get(row.item.path);
				if (!from || !to) continue;
				const y1 = from.y + ROW_H / 2;
				const y2 = to.y + ROW_H / 2;
				const x1 = from.x + from.w;
				const x2 = to.x;
				const conflict = row.bar.start < blocker.bar.end;
				const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
				const dx = Math.max(24, Math.abs(x2 - x1) / 2);
				path.setAttribute("d", `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`);
				path.classList.add("ph-tl-dep");
				if (conflict) path.classList.add("ph-tl-dep-conflict");
				svg.appendChild(path);
				if (conflict) {
					const marker = document.createElementNS("http://www.w3.org/2000/svg", "circle");
					marker.setAttribute("cx", String(x2));
					marker.setAttribute("cy", String(y2));
					marker.setAttribute("r", "4");
					marker.classList.add("ph-tl-dep-dot");
					svg.appendChild(marker);
				}
			}
		}
	}

	private groupOpen(key: string, defaultClosed: boolean): boolean {
		if (this.expanded.has(key)) return true;
		if (this.collapsed.has(key)) return false;
		return !defaultClosed;
	}

	private persistCollapsed(): void {
		this.config.set("ph-collapsed", { collapsed: [...this.collapsed], expanded: [...this.expanded] });
	}

	private loadCollapsed(): void {
		const raw = this.config.get("ph-collapsed");
		if (raw && typeof raw === "object") {
			const obj = raw as { collapsed?: unknown; expanded?: unknown };
			this.collapsed = new Set(Array.isArray(obj.collapsed) ? obj.collapsed.filter((x): x is string => typeof x === "string") : []);
			this.expanded = new Set(Array.isArray(obj.expanded) ? obj.expanded.filter((x): x is string => typeof x === "string") : []);
			return;
		}
		// legacy: a plain array of collapsed keys
		this.collapsed = new Set(readList(this, "ph-collapsed"));
	}
}

function sprintRange(start: string | null, end: string | null): string | undefined {
	if (!start || !end) return undefined;
	return `${start} → ${end}`;
}

// ---------------------------------------------------------------- registration

export function timelineOptions(): BasesAllOptions[] {
	return [
		{
			key: "scale",
			type: "dropdown",
			displayName: "Time scale",
			default: "week",
			options: { Day: "day", Week: "week", Month: "month", Quarter: "quarter" },
		},
		{
			key: "phGroupBy",
			type: "dropdown",
			displayName: "Group by",
			default: "parent",
			options: { Hierarchy: "parent", Project: "project", Assignee: "assignee", Sprint: "sprint", Status: "status", None: "none" },
		},
		{ key: "showDone", type: "toggle", displayName: "Show done items", default: true },
	];
}

export function registerTimelineView(hub: Hub): void {
	hub.plugin.registerBasesView("ph-timeline", {
		name: "Timeline",
		icon: "calendar-range",
		factory: (controller, containerEl) => new TimelineView(hub, controller, containerEl),
		options: () => timelineOptions(),
	});
}
