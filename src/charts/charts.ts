import { setIcon, setTooltip } from "obsidian";
import { CMD, Hub } from "../core/hub";
import type { Entity, Project, Sprint, WorkItem } from "../core/model";
import { addDays, daysBetween, normDate, parseWikilink, plural, startOfWeek } from "../core/util";
import {
	CategoryOf,
	Member,
	Metric,
	SprintRef,
	StateAt,
	StatusRef,
	agingItems,
	burndown,
	burnup,
	cfd,
	chooseMetric,
	cycleTimes,
	sampleDates,
	statusBreakdown,
	throughput,
	velocity,
	workingDays,
	workload,
} from "./data";
import {
	BAR_MAX,
	Cell,
	ChartSpec,
	FrameState,
	GAP,
	Key,
	LegendItem,
	Linear,
	Plot,
	TipRow,
	Track,
	axisDate,
	bandPath,
	columnPath,
	crisp,
	crosshair,
	dateTicks,
	emptyState,
	fit,
	hbarPath,
	jitter,
	linePath,
	linear,
	longDate,
	markHover,
	nearestHover,
	niceTicks,
	num,
	plotOf,
	renderFrame,
	s,
	text,
	textWidth,
	tip,
	vMarker,
	xDateAxis,
	yAxis,
	yLabelWidth,
} from "./svg";

// ---------------------------------------------------------------- config

export const CHART_TYPES = ["burndown", "burnup", "cfd", "velocity", "throughput", "status", "workload", "cycletime", "aging"] as const;
export type ChartType = (typeof CHART_TYPES)[number];

const TYPE_ALIASES: Record<string, ChartType> = {
	"burn-down": "burndown",
	"burn-up": "burnup",
	"cumulative-flow": "cfd",
	"cumulative flow": "cfd",
	flow: "cfd",
	"cycle-time": "cycletime",
	"cycle time": "cycletime",
	wip: "aging",
	"wip-aging": "aging",
};

export class ConfigError extends Error {}

/** Scope keys shared by ph-chart and ph-stats. */
export interface ScopeSpec {
	project: string | null;
	sprint: string | null;
	assignee: string | null;
	/** "all" turns off the automatic scoping to the note the block sits in. */
	scope: "auto" | "all";
}

export interface ChartConfig extends ScopeSpec {
	type: ChartType;
	from: string | null;
	to: string | null;
	metric: Metric | null;
	weeks: number;
	sprints: number | null;
	height: number;
	title: string | null;
}

export const SCOPE_KEYS = ["project", "sprint", "assignee", "scope"];
export const CHART_KEYS = ["type", ...SCOPE_KEYS, "from", "to", "metric", "weeks", "sprints", "height", "title"];

/** `[[Note]]` written unquoted in YAML parses as a nested list; turn it back into link text. */
export function yamlLink(value: unknown): string | null {
	if (value === null || value === undefined || value === "") return null;
	if (Array.isArray(value)) {
		if (value.length === 1 && Array.isArray(value[0]) && value[0].length === 1) return `[[${String(value[0][0])}]]`;
		if (value.length === 1) return yamlLink(value[0]);
		throw new ConfigError(`Expected a single note link, got a list: ${JSON.stringify(value)}`);
	}
	if (typeof value === "string" || typeof value === "number") return String(value).trim() || null;
	throw new ConfigError(`Expected a note link such as "[[Name]]", got ${JSON.stringify(value)}`);
}

/** Absolute date, "today", or an offset from today such as -30d, -8w, -3m. */
export function yamlDate(value: unknown, key: string, today: string): string | null {
	if (value === null || value === undefined || value === "") return null;
	const raw = typeof value === "string" ? value.trim().toLowerCase() : value;
	if (raw === "today") return today;
	if (typeof raw === "string") {
		const m = /^([+-]?\d+)\s*([dwm])$/.exec(raw);
		if (m) {
			const n = Number(m[1]);
			if (m[2] === "m") {
				const d = new Date(`${today}T00:00:00`);
				d.setMonth(d.getMonth() + n);
				return normDate(d);
			}
			return addDays(today, m[2] === "w" ? n * 7 : n);
		}
	}
	const d = normDate(raw);
	if (!d) throw new ConfigError(`"${key}" must be a date (YYYY-MM-DD), "today", or an offset such as -30d or -8w.`);
	return d;
}

function yamlInt(value: unknown, key: string, min: number, max: number): number | null {
	if (value === null || value === undefined || value === "") return null;
	const n = typeof value === "number" ? value : Number(String(value).trim());
	if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`"${key}" must be a whole number from ${min} to ${max}.`);
	return n;
}

export function parseScopeSpec(o: Record<string, unknown>): ScopeSpec {
	const scope = o.scope === undefined || o.scope === null ? "auto" : String(o.scope).trim().toLowerCase();
	if (scope !== "auto" && scope !== "all") throw new ConfigError(`"scope" must be "all" (ignore the note this block is in) or "auto".`);
	return { project: yamlLink(o.project), sprint: yamlLink(o.sprint), assignee: yamlLink(o.assignee), scope };
}

export function checkKeys(o: Record<string, unknown>, valid: string[]): void {
	const bad = Object.keys(o).filter((k) => !valid.includes(k));
	if (bad.length) throw new ConfigError(`Unknown option${bad.length > 1 ? "s" : ""} ${bad.map((k) => `"${k}"`).join(", ")}. Valid options: ${valid.join(", ")}.`);
}

export function parseMetric(value: unknown): Metric | null {
	if (value === null || value === undefined || value === "") return null;
	const m = String(value).trim().toLowerCase();
	if (m === "points" || m === "pts" || m === "story points") return "points";
	if (m === "count" || m === "items") return "count";
	throw new ConfigError(`"metric" must be "points" or "count".`);
}

export function parseChartConfig(raw: unknown, today: string): ChartConfig {
	const types = CHART_TYPES.join(", ");
	if (raw === null || raw === undefined || raw === "") throw new ConfigError(`Add a chart type, for example "type: burndown". Types: ${types}.`);
	if (typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError(`Write the chart options as "key: value" lines, for example "type: burndown". Types: ${types}.`);
	const o = raw as Record<string, unknown>;
	checkKeys(o, CHART_KEYS);
	const t = String(o.type ?? "").trim().toLowerCase();
	if (!t) throw new ConfigError(`Missing "type". Use one of: ${types}.`);
	const type = (CHART_TYPES as readonly string[]).includes(t) ? (t as ChartType) : TYPE_ALIASES[t];
	if (!type) throw new ConfigError(`Unknown chart type "${String(o.type)}". Use one of: ${types}.`);
	const from = yamlDate(o.from, "from", today);
	const to = yamlDate(o.to, "to", today);
	if (from && to && from > to) throw new ConfigError(`"from" (${from}) is after "to" (${to}).`);
	const title = o.title === undefined || o.title === null ? null : String(o.title).trim() || null;
	return {
		type,
		...parseScopeSpec(o),
		from,
		to,
		metric: parseMetric(o.metric),
		weeks: yamlInt(o.weeks, "weeks", 1, 260) ?? 8,
		sprints: yamlInt(o.sprints, "sprints", 1, 52),
		height: yamlInt(o.height, "height", 120, 1200) ?? 260,
		title,
	};
}

// ---------------------------------------------------------------- scope

export interface Scope {
	project: Project | null;
	sprint: Sprint | null;
	/** Person path, or the raw assignee text for unlinked names. */
	assignee: string | null;
	assigneeName: string | null;
	source: Entity | null;
	/** Set when a requested sprint does not exist yet ("current", "next"); rendered as an empty state. */
	missingSprint: string | null;
}

export function resolveScope(hub: Hub, spec: ScopeSpec, sourcePath: string): Scope {
	const store = hub.store;
	const source = store.getEntity(sourcePath);
	const scope: Scope = { project: null, sprint: null, assignee: null, assigneeName: null, source, missingSprint: null };
	const explicit = spec.project !== null || spec.sprint !== null || spec.assignee !== null;

	const dest = (value: string): string | null => {
		const wl = parseWikilink(value);
		const linkpath = wl ? wl.path : value;
		return hub.app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath)?.path ?? null;
	};
	const label = (value: string) => parseWikilink(value)?.path ?? value;

	if (spec.project) {
		const v = spec.project.toLowerCase();
		if (v === "this") {
			if (source?.kind === "project") scope.project = source;
			else if (source?.kind === "work-item") {
				const p = store.effectiveProject(source);
				scope.project = p ? store.projects.get(p) ?? null : null;
				if (!scope.project) throw new ConfigError(`"project: this" — this work item has no project.`);
			} else throw new ConfigError(`"project: this" only works inside a project note or a work item.`);
		} else {
			const p = dest(spec.project);
			scope.project = p ? store.projects.get(p) ?? null : null;
			if (!scope.project) throw new ConfigError(`Project "${label(spec.project)}" was not found. Link a note with "kind: project".`);
		}
	}

	if (spec.sprint) {
		const v = spec.sprint.toLowerCase();
		const sorted = store.sortedSprints();
		if (v === "this") {
			if (source?.kind === "sprint") scope.sprint = source;
			else if (source?.kind === "work-item" && source.sprint) scope.sprint = store.sprints.get(source.sprint) ?? null;
			if (!scope.sprint) throw new ConfigError(`"sprint: this" only works inside a sprint note or a work item that is in a sprint.`);
		} else if (v === "current") {
			scope.sprint = store.currentSprint();
			if (!scope.sprint) scope.missingSprint = "There is no current sprint.";
		} else if (v === "next") {
			scope.sprint = store.nextSprint();
			if (!scope.sprint) scope.missingSprint = "There is no upcoming sprint.";
		} else if (v === "previous" || v === "last") {
			scope.sprint = sorted.filter((sp) => sp.state === "Past").pop() ?? null;
			if (!scope.sprint) scope.missingSprint = "There is no finished sprint yet.";
		} else {
			const p = dest(spec.sprint);
			scope.sprint = p ? store.sprints.get(p) ?? null : null;
			if (!scope.sprint) throw new ConfigError(`Sprint "${label(spec.sprint)}" was not found. Use "this", "current", "previous", "next" or a link to a sprint note.`);
		}
	}

	if (spec.assignee) {
		const v = spec.assignee.toLowerCase();
		if (v === "this") {
			if (source?.kind === "person") scope.assignee = source.path;
			else if (source?.kind === "work-item" && source.assignee) scope.assignee = source.assignee;
			else throw new ConfigError(`"assignee: this" only works inside a person note or an assigned work item.`);
		} else if (v === "me") {
			scope.assignee = store.mePath();
			if (!scope.assignee) throw new ConfigError(`"assignee: me" needs your person note set as "Me" in Project Hub settings.`);
		} else {
			const p = dest(spec.assignee);
			if (p && store.people.has(p)) scope.assignee = p;
			else {
				const raw = label(spec.assignee);
				const lower = raw.toLowerCase();
				const hit = store.allItems().find((i) => i.assignee && !store.people.has(i.assignee) && i.assignee.toLowerCase() === lower);
				if (!hit) throw new ConfigError(`Person "${raw}" was not found. Link a note with "kind: person".`);
				scope.assignee = hit.assignee;
			}
		}
	}

	if (!explicit && spec.scope === "auto" && source) {
		if (source.kind === "project") scope.project = source;
		else if (source.kind === "sprint") scope.sprint = source;
		else if (source.kind === "person") scope.assignee = source.path;
	}
	if (scope.assignee) scope.assigneeName = store.people.has(scope.assignee) ? store.displayName(scope.assignee) : scope.assignee;
	return scope;
}

export function scopeLabel(scope: Scope): string {
	return [scope.project?.name, scope.sprint?.name, scope.assigneeName].filter(Boolean).join(" · ");
}

/** Items whose current values match the scope; removed items excluded. */
export function scopedItems(hub: Hub, scope: Scope): WorkItem[] {
	const store = hub.store;
	return store.allItems().filter(
		(it) =>
			!store.isRemoved(it) &&
			(!scope.sprint || it.sprint === scope.sprint.path) &&
			(!scope.assignee || it.assignee === scope.assignee) &&
			(!scope.project || store.effectiveProject(it) === scope.project.path),
	);
}

/** Every item that may have been in scope at some point (history decides per day). */
function historyCandidates(hub: Hub, scope: Scope): WorkItem[] {
	const items = hub.store.allItems();
	return scope.assignee ? items.filter((i) => i.assignee === scope.assignee) : items;
}

/** History records sprint and project by note name; the assignee filter uses current values. */
export function memberFn(scope: Scope): Member<WorkItem> {
	const project = scope.project?.basename ?? null;
	const sprint = scope.sprint?.basename ?? null;
	const assignee = scope.assignee;
	return (it, st) => (!project || st.project === project) && (!sprint || st.sprint === sprint) && (!assignee || it.assignee === assignee);
}

export function stateFn(hub: Hub): StateAt<WorkItem> {
	const history = hub.history;
	if (!history) throw new Error("Item history is not loaded yet.");
	return (it, date) => history.stateAt(it, date);
}

export function statusRefs(hub: Hub): StatusRef[] {
	return hub.settings.statuses.map((st) => ({ name: st.name, category: st.category, color: st.color }));
}

export function categoryFn(hub: Hub): CategoryOf {
	return (status) => hub.store.statusCategory(status);
}

// ---------------------------------------------------------------- environment

export interface ItemRow {
	item: WorkItem;
	detail?: string;
}

export type OpenItems = (title: string, rows: ItemRow[]) => void;

export interface ChartEnv {
	hub: Hub;
	cfg: ChartConfig;
	scope: Scope;
	today: string;
	state: FrameState;
	track: Track;
	openItems: OpenItems;
}

export function renderChart(env: ChartEnv, el: HTMLElement): void {
	switch (env.cfg.type) {
		case "burndown":
			return renderBurndown(env, el);
		case "burnup":
			return renderBurnup(env, el);
		case "cfd":
			return renderCfd(env, el);
		case "velocity":
			return renderVelocity(env, el);
		case "throughput":
			return renderThroughput(env, el);
		case "status":
			return renderStatus(env, el);
		case "workload":
			return renderWorkload(env, el);
		case "cycletime":
			return renderCycleTime(env, el);
		case "aging":
			return renderAging(env, el);
	}
}

// ---------------------------------------------------------------- shared pieces

const TOP = 14;
const AXIS_BAND = 30;

type Tone = "good" | "warning" | "serious" | "critical" | "neutral";

function unitWord(metric: Metric, v: number): string {
	if (metric === "points") return v === 1 ? "pt" : "pts";
	return v === 1 ? "item" : "items";
}

function amount(v: number, metric: Metric): string {
	return `${num(v)} ${unitWord(metric, v)}`;
}

function badge(parent: HTMLElement, label: string, tone: Tone, icon: string, tooltip?: string): HTMLElement {
	const el = parent.createSpan({ cls: `ph-chart-badge is-${tone}` });
	setIcon(el.createSpan({ cls: "ph-chart-badge-icon" }), icon);
	el.createSpan({ text: label });
	if (tooltip) setTooltip(el, tooltip);
	return el;
}

function stat(parent: HTMLElement, value: string, label: string, tooltip?: string): HTMLElement {
	const el = parent.createSpan({ cls: "ph-chart-stat" });
	el.createSpan({ cls: "ph-chart-stat-value", text: value });
	el.createSpan({ cls: "ph-chart-stat-label", text: label });
	if (tooltip) setTooltip(el, tooltip);
	return el;
}

function actionButton(parent: HTMLElement, label: string, icon: string, run: () => void): HTMLElement {
	const b = parent.createEl("button", { cls: "ph-btn ph-chart-action" });
	setIcon(b.createSpan(), icon);
	b.createSpan({ text: label });
	b.addEventListener("click", (e) => {
		e.preventDefault();
		run();
	});
	return b;
}

function noSprint(env: ChartEnv, el: HTMLElement, title: string): void {
	const msg = env.scope.missingSprint ?? "No sprint found.";
	const box = emptyState(el, title, `${msg} Create one with "Project Hub: New sprint".`, "calendar-x");
	actionButton(box, "New sprint", "plus", () => env.hub.runCommand(CMD.newSprint));
}

function subtitleOf(env: ChartEnv, parts: (string | null | undefined)[]): string {
	return [scopeLabel(env.scope), ...parts].filter(Boolean).join(" · ");
}

function colorOf(hub: Hub, status: string): string {
	return hub.store.statusDef(status)?.color ?? "gray";
}

function doneColor(hub: Hub): string {
	return colorOf(hub, hub.store.statusFor("completed"));
}

function painted<T extends SVGElement>(el: T, color: string | undefined): T {
	if (color) el.dataset.phColor = color;
	return el;
}

function ringDot(parent: Element, x: number, y: number, color: string, cls = ""): SVGCircleElement {
	return painted(s(parent, "circle", { cx: x, cy: y, r: 5 }, `ph-chart-dot ${cls}`.trim()), color);
}

/** Direct value label at a line's end; flips left near the right edge. */
function endLabel(svg: Element, x: number, y: number, value: string, width: number, plot: Plot): void {
	const w = textWidth(value, 11, 600);
	const right = x + 8 + w <= width - 2;
	const ly = Math.max(plot.y0 + 10, y - 9);
	text(svg, right ? x + 8 : x - 8, ly, value, "ph-chart-label is-strong", right ? "start" : "end");
}

interface TimeFrame {
	plot: Plot;
	y: Linear;
	xOf: (date: string) => number;
	top: number;
}

/** Plot area, y grid and date axis for a chart that spans [from, to]. */
function timeFrame(svg: SVGSVGElement, width: number, height: number, from: string, to: string, yMax: number, metric: Metric, right = 16): TimeFrame {
	const plotH = height - TOP - AXIS_BAND;
	const ticks = niceTicks(yMax, Math.max(2, Math.min(6, Math.floor(plotH / 48))), metric === "count");
	const plot = plotOf(width, height, { left: yLabelWidth(ticks), right, top: TOP, bottom: AXIS_BAND });
	const x = linear(0, Math.max(1, daysBetween(from, to)), plot.x0, plot.x1);
	const top = ticks[ticks.length - 1];
	const y = linear(0, top, plot.y1, plot.y0);
	const xOf = (d: string) => x(daysBetween(from, d));
	yAxis(svg, plot, y, ticks);
	xDateAxis(svg, plot, dateTicks(from, to, plot.x1 - plot.x0), xOf, width);
	return { plot, y, xOf, top };
}

/** Band scale for bar charts: `n` slots across the plot. */
function bands(plot: Plot, n: number): { width: number; center: (i: number) => number } {
	const width = (plot.x1 - plot.x0) / Math.max(1, n);
	return { width, center: (i) => plot.x0 + width * (i + 0.5) };
}

/** Category labels under bars, thinned so they never overlap. */
function bandLabels(svg: Element, plot: Plot, labels: string[], band: { width: number; center: (i: number) => number }, width: number, keep?: (i: number) => boolean): void {
	const g = s(svg, "g", {}, "ph-chart-axis");
	const widest = Math.max(...labels.map((l) => textWidth(l)), 1);
	const fitsAll = widest + 8 <= band.width;
	const step = fitsAll ? 1 : Math.max(1, Math.ceil(Math.min(widest, 90) / band.width));
	labels.forEach((label, i) => {
		const last = i === labels.length - 1;
		if (!fitsAll && i % step !== (labels.length - 1) % step && !(keep && keep(i))) return;
		const room = fitsAll ? band.width - 6 : Math.min(90, band.width * step - 8);
		const t = fit(label, room);
		if (!t) return;
		const cx = band.center(i);
		const w = textWidth(t);
		const anchor = cx - w / 2 < 2 ? "start" : cx + w / 2 > width - 2 ? "end" : "middle";
		text(g, anchor === "start" ? 2 : anchor === "end" ? width - 2 : cx, plot.y1 + 17, t, "ph-chart-tick" + (last ? " is-strong" : ""), anchor);
	});
}

/** Dashed guide across the plot with a label in the right margin. */
function guideLine(svg: Element, plot: Plot, y: number, label: string): void {
	const g = s(svg, "g", {}, "ph-chart-guide-group");
	s(g, "line", { x1: plot.x0, x2: plot.x1, y1: crisp(y), y2: crisp(y) }, "ph-chart-guide");
	text(g, plot.x1 + 6, y + 3.5, label, "ph-chart-label");
}

const GUIDE_KEY: Key = { shape: "dash", role: "guide" };
const SCOPE_KEY: Key = { shape: "line", role: "scope" };

// ---------------------------------------------------------------- burndown

function renderBurndown(env: ChartEnv, el: HTMLElement): void {
	const { hub, cfg, today } = env;
	let scope = env.scope;
	if (!scope.sprint && cfg.sprint === null && !scope.missingSprint) {
		const cur = hub.store.currentSprint();
		if (cur) scope = { ...scope, sprint: cur };
		else scope = { ...scope, missingSprint: "There is no current sprint." };
	}
	const sprint = scope.sprint;
	const title = cfg.title ?? (sprint ? `Burndown · ${sprint.name}` : "Sprint burndown");
	if (!sprint) return noSprint({ ...env, scope }, el, title);
	const start = cfg.from ?? sprint.start;
	const end = cfg.to ?? sprint.end;
	if (!start || !end) {
		emptyState(el, title, `${sprint.name} has no dates. Add "start" and "end" to its properties to see a burndown.`, "calendar-x");
		return;
	}
	if (end < start) throw new ConfigError(`${sprint.name} ends (${end}) before it starts (${start}).`);
	const metric = chooseMetric(scopedItems(hub, scope), cfg.metric);
	const member = memberFn(scope);
	const bd = burndown(historyCandidates(hub, scope), stateFn(hub), member, { start, end, today, metric });
	if (bd.status === "empty") {
		const box = emptyState(el, title, `No work items in ${sprint.name} yet. Add items to the sprint to see its burndown.`, "chart-line");
		actionButton(box, "New work item", "plus", () => hub.newItem({ sprint: sprint.path, project: scope.project?.path ?? null, assignee: scope.assignee && hub.store.people.has(scope.assignee) ? scope.assignee : null }));
		return;
	}
	const days = bd.days;
	const measured = days.filter((d) => d.remaining !== null);
	const showScope = bd.changes.length > 0;
	const changeOn = new Map(bd.changes.map((c) => [c.date, c]));
	const unit = (v: number) => amount(v, metric);
	const name = (it: WorkItem) => (it.id ? `${it.id} ${it.title}` : it.title);
	const describe = (date: string): string[] => {
		const c = changeOn.get(date);
		if (!c) return [];
		const out = [`Scope ${c.delta >= 0 ? "+" : "−"}${unit(Math.abs(c.delta))}`];
		if (c.added.length) out.push(`Added: ${c.added.slice(0, 3).map(name).join(", ")}${c.added.length > 3 ? ` +${c.added.length - 3} more` : ""}`);
		if (c.removed.length) out.push(`Removed: ${c.removed.slice(0, 3).map(name).join(", ")}${c.removed.length > 3 ? ` +${c.removed.length - 3} more` : ""}`);
		return out;
	};

	const legend: LegendItem[] = [
		{ label: "Remaining", key: { shape: "line", color: "blue" } },
		{ label: "Ideal", key: GUIDE_KEY },
	];
	if (showScope) legend.push({ label: "Scope", key: SCOPE_KEY }, { label: "Scope change", key: { shape: "diamond", role: "scope" } });

	const spec: ChartSpec = {
		title,
		subtitle: subtitleOf(env, [`${axisDate(start)} – ${axisDate(end)}`, metric === "points" ? "story points" : "item count"]),
		height: cfg.height,
		legend,
		headline: (h) => {
			if (bd.status === "upcoming") {
				stat(h, num(bd.planned), `${unitWord(metric, bd.planned)} planned`);
				stat(h, String(workingDays(start, end)), "working days");
				badge(h, `Starts ${axisDate(start)}`, "neutral", "calendar-clock");
				return;
			}
			const cur = bd.current!;
			const rem = cur.remaining ?? 0;
			stat(h, num(rem), `${unitWord(metric, rem)} remaining`, `${unit(cur.completed ?? 0)} of ${unit(cur.scope ?? 0)} done`);
			if (today <= end) stat(h, String(bd.workingDaysLeft), bd.workingDaysLeft === 1 ? "day left" : "days left", "Working days, weekends excluded");
			else stat(h, axisDate(end), "ended");
			const gap = rem - cur.ideal;
			const vsIdeal = gap > 0 ? `${unit(gap)} above the ideal line` : gap < 0 ? `${unit(-gap)} below the ideal line` : "On the ideal line";
			if (bd.status === "done") badge(h, "Done", "good", "circle-check", "All sprint work is complete");
			else if (bd.status === "on-track") badge(h, "On track", "good", "circle-check", vsIdeal);
			else if (bd.status === "at-risk") badge(h, "At risk", "warning", "triangle-alert", vsIdeal);
			else if (bd.status === "behind") badge(h, "Behind", "critical", "octagon-alert", vsIdeal);
			else badge(h, `Ended with ${unit(rem)} open`, "serious", "calendar-x");
		},
		summary: `Burndown for ${sprint.name}: ${bd.current ? `${unit(bd.current.remaining ?? 0)} remaining of ${unit(bd.current.scope ?? 0)}` : `${unit(bd.planned)} planned`}.`,
		draw: (svg, width, height) => {
			const bg = s(svg, "g", {}, "ph-chart-bg");
			const yMax = Math.max(bd.startScope, bd.planned, ...measured.map((d) => Math.max(d.scope ?? 0, d.remaining ?? 0)));
			const f = timeFrame(svg, width, height, start, end, yMax, metric);
			days.forEach((d, i) => {
				if (!d.weekend || i === 0) return;
				const xa = f.xOf(days[i - 1].date);
				s(bg, "rect", { x: xa, y: f.plot.y0, width: f.xOf(d.date) - xa, height: f.plot.y1 - f.plot.y0 }, "ph-chart-weekend");
			});
			s(svg, "path", { d: linePath(days.map((d) => [f.xOf(d.date), f.y(d.ideal)])) }, "ph-chart-guide is-line");
			if (showScope) s(svg, "path", { d: linePath(days.map((d) => (d.scope === null ? null : [f.xOf(d.date), f.y(d.scope)]))) }, "ph-chart-line is-scope");
			const pts = measured.map((d) => [f.xOf(d.date), f.y(d.remaining!)] as [number, number]);
			if (pts.length) {
				painted(s(svg, "path", { d: bandPath(pts.map((p) => p[0]), pts.map((p) => p[1]), pts.map(() => f.plot.y1)) }, "ph-chart-area"), "blue");
				painted(s(svg, "path", { d: linePath(pts) }, "ph-chart-line"), "blue");
			}
			for (const c of bd.changes) {
				const d = days.find((x) => x.date === c.date);
				if (!d || d.scope === null) continue;
				const x = f.xOf(d.date);
				const y = f.y(d.scope);
				s(svg, "path", { d: `M${x},${y - 5}L${x + 5},${y}L${x},${y + 5}L${x - 5},${y}Z` }, "ph-chart-diamond");
			}
			if (today > start && today < end) vMarker(svg, f.plot, f.xOf(today), "Today", "is-today", width);
			if (pts.length) {
				const [lx, ly] = pts[pts.length - 1];
				ringDot(svg, lx, ly, "blue");
				endLabel(svg, lx, ly, unit(measured[measured.length - 1].remaining ?? 0), width, f.plot);
			}
			crosshair(svg, f.plot, days.map((d) => f.xOf(d.date)), {
				start: Math.max(0, measured.length - 1),
				dots: (i) => {
					const d = days[i];
					const out: { y: number; key: Key }[] = [{ y: f.y(d.ideal), key: GUIDE_KEY }];
					if (showScope && d.scope !== null) out.push({ y: f.y(d.scope), key: SCOPE_KEY });
					if (d.remaining !== null) out.push({ y: f.y(d.remaining), key: { shape: "line", color: "blue" } });
					return out;
				},
				tip: (i, t) => {
					const d = days[i];
					const rows: TipRow[] = [];
					if (d.remaining !== null) rows.push({ value: unit(d.remaining), label: "Remaining", key: { shape: "line", color: "blue" } });
					rows.push({ value: unit(Math.round(d.ideal * 10) / 10), label: "Ideal", key: GUIDE_KEY });
					if (d.completed !== null) rows.push({ value: unit(d.completed), label: "Completed" });
					if (d.scope !== null) rows.push({ value: unit(d.scope), label: "Scope", key: showScope ? SCOPE_KEY : undefined });
					const foot = describe(d.date);
					if (d.remaining === null) foot.unshift("Not reached yet");
					if (d.weekend) foot.unshift("Weekend");
					tip(t, longDate(d.date), rows, foot);
				},
			});
		},
		table: {
			caption: `Burndown for ${sprint.name} in ${metric === "points" ? "story points" : "items"}`,
			columns: [{ label: "Date" }, { label: "Remaining", num: true }, { label: "Ideal", num: true }, { label: "Completed", num: true }, { label: "Scope", num: true }, { label: "Scope change" }],
			rows: days.map((d) => [longDate(d.date), d.remaining, Math.round(d.ideal * 10) / 10, d.completed, d.scope, describe(d.date).join(" · ") || null]),
		},
		note: scope.assignee ? "Assignee filter uses each item's current assignee." : undefined,
	};
	renderFrame(hub, el, spec, env.state, env.track);
}

// ---------------------------------------------------------------- burnup

function renderBurnup(env: ChartEnv, el: HTMLElement): void {
	const { hub, cfg, scope, today } = env;
	const { project, sprint } = scope;
	const title = cfg.title ?? `Burnup${project ? ` · ${project.name}` : sprint ? ` · ${sprint.name}` : ""}`;
	if (scope.missingSprint) return noSprint(env, el, title);
	const current = scopedItems(hub, scope);
	const metric = chooseMetric(current, cfg.metric);
	let from = cfg.from;
	if (!from) {
		if (sprint?.start) from = sprint.start;
		else if (project) {
			const earliest = current.map((i) => i.created).filter((d): d is string => !!d).sort()[0] ?? today;
			from = project.start && project.start < earliest ? project.start : earliest;
			const floor = addDays(today, -730);
			if (from < floor) from = floor;
		} else from = addDays(today, -90);
	}
	if (from > today) {
		emptyState(el, title, `Nothing to show yet. Tracking starts ${axisDate(from)}.`, "calendar-clock");
		return;
	}
	const until = cfg.to && cfg.to < today ? cfg.to : today;
	const dates = sampleDates(from, until);
	const member = memberFn(scope);
	const bu = burnup(historyCandidates(hub, scope), stateFn(hub), member, { dates, today: until, metric, window: 28 });
	const last = bu.days[bu.days.length - 1];
	if (!last || bu.days.every((d) => d.scope === 0)) {
		const box = emptyState(el, title, `No work items in ${scopeLabel(scope) || "this vault"} for this period yet.`, "chart-area");
		actionButton(box, "New work item", "plus", () => hub.newItem({ project: project?.path ?? null, sprint: sprint?.path ?? null }));
		return;
	}
	const fc = bu.forecast;
	const target = sprint?.end ?? project?.target ?? null;
	const span = Math.max(14, daysBetween(from, until));
	const cap = addDays(until, Math.max(28, span));
	let end = cfg.to ?? (sprint?.end && sprint.end > until ? sprint.end : until);
	if (!cfg.to) {
		if (fc.finish && fc.finish > end) end = fc.finish < cap ? fc.finish : cap;
		if (target && target > end && target <= addDays(cap, 30)) end = target;
		if (end > until) end = addDays(end, Math.max(2, Math.round(daysBetween(from, end) * 0.03)));
	}
	const done = doneColor(hub);
	const unit = (v: number) => amount(v, metric);
	const pct = last.scope > 0 ? Math.round((last.done / last.scope) * 100) : 0;
	const lateBy = fc.finish && target ? daysBetween(target, fc.finish) : null;

	const legend: LegendItem[] = [
		{ label: "Completed", key: { shape: "rect", color: done } },
		{ label: "Scope", key: SCOPE_KEY },
	];
	if (fc.remaining > 0 && fc.finish) legend.push({ label: "Forecast (last 4 weeks)", key: { shape: "dash", color: done } });

	const spec: ChartSpec = {
		title,
		subtitle: subtitleOf(env, [metric === "points" ? "story points" : "item count"]),
		height: cfg.height,
		legend,
		headline: (h) => {
			stat(h, `${num(last.done)} / ${num(last.scope)}`, `${unitWord(metric, last.scope)} done (${pct}%)`);
			if (fc.remaining <= 0) badge(h, "Complete", "good", "circle-check");
			else if (!fc.finish) badge(h, "No forecast", "warning", "triangle-alert", "Nothing was completed in the last 4 weeks, so there is no rate to project.");
			else {
				stat(h, axisDate(fc.finish), "projected finish", `At ${unit(Math.round(fc.rate * 7 * 10) / 10)} per week (last 4 weeks)`);
				if (target && lateBy !== null) {
					if (lateBy <= 0) badge(h, `On track for ${axisDate(target)}`, "good", "circle-check", `Projected ${plural(-lateBy, "day")} before the target`);
					else badge(h, `${plural(lateBy, "day")} late`, lateBy > 14 ? "critical" : "warning", lateBy > 14 ? "octagon-alert" : "triangle-alert", `Target ${longDate(target)}`);
				}
			}
		},
		summary: `Burnup: ${unit(last.done)} completed of ${unit(last.scope)} scope${fc.finish && fc.remaining > 0 ? `, projected to finish ${longDate(fc.finish)}` : ""}.`,
		draw: (svg, width, height) => {
			const yMax = Math.max(...bu.days.map((d) => d.scope), 1);
			const right = 16;
			const f = timeFrame(svg, width, height, from!, end, yMax, metric, right);
			const xs = bu.days.map((d) => f.xOf(d.date));
			const scopeYs = bu.days.map((d) => f.y(d.scope));
			const doneYs = bu.days.map((d) => f.y(d.done));
			painted(s(svg, "path", { d: bandPath(xs, doneYs, xs.map(() => f.plot.y1)) }, "ph-chart-area"), done);
			s(svg, "path", { d: linePath(xs.map((x, i) => [x, scopeYs[i]])) }, "ph-chart-line is-scope");
			painted(s(svg, "path", { d: linePath(xs.map((x, i) => [x, doneYs[i]])) }, "ph-chart-line"), done);
			const tx = f.xOf(until);
			if (end > until) {
				s(svg, "path", { d: linePath([[tx, f.y(last.scope)], [f.xOf(end), f.y(last.scope)]]) }, "ph-chart-line is-scope is-projected");
				if (fc.remaining > 0 && fc.rate > 0) {
					const endDays = daysBetween(until, end);
					const reach = Math.min(fc.remaining, fc.rate * endDays);
					const fx = f.xOf(addDays(until, Math.min(endDays, Math.ceil(reach / fc.rate))));
					painted(s(svg, "path", { d: linePath([[tx, f.y(last.done)], [fx, f.y(last.done + reach)]]) }, "ph-chart-line is-projected"), done);
					if (fc.finish && fc.finish <= end) {
						const px = f.xOf(fc.finish);
						const py = f.y(last.scope);
						painted(s(svg, "circle", { cx: px, cy: py, r: 5 }, "ph-chart-dot is-hollow"), done);
						const label = `Finish ~${axisDate(fc.finish)}`;
						const w = textWidth(label, 11, 600);
						const anchor = px + w / 2 > width - 2 ? "end" : px - w / 2 < f.plot.x0 ? "start" : "middle";
						text(svg, anchor === "end" ? width - 2 : anchor === "start" ? f.plot.x0 : px, Math.min(f.plot.y1 - 4, py + 18), label, "ph-chart-label is-strong", anchor);
					}
				}
				vMarker(svg, f.plot, tx, "Today", "is-today", width);
			}
			if (target && target >= from! && target <= end) vMarker(svg, f.plot, f.xOf(target), `${sprint ? "Sprint end" : "Target"} ${axisDate(target)}`, "is-target", width);
			ringDot(svg, tx, f.y(last.done), done);
			if (end <= until) endLabel(svg, tx, f.y(last.done), unit(last.done), width, f.plot);
			crosshair(svg, f.plot, xs, {
				dots: (i) => [
					{ y: scopeYs[i], key: SCOPE_KEY },
					{ y: doneYs[i], key: { shape: "line", color: done } },
				],
				tip: (i, t) => {
					const d = bu.days[i];
					tip(t, longDate(d.date), [
						{ value: unit(d.done), label: "Completed", key: { shape: "line", color: done } },
						{ value: unit(d.scope), label: "Scope", key: SCOPE_KEY },
						{ value: unit(Math.max(0, d.scope - d.done)), label: "Remaining" },
					]);
				},
			});
		},
		table: {
			caption: fc.finish && fc.remaining > 0 ? `Projected finish ${longDate(fc.finish)} at ${unit(Math.round(fc.rate * 7 * 10) / 10)} per week` : undefined,
			columns: [{ label: "Date" }, { label: "Completed", num: true }, { label: "Scope", num: true }, { label: "Remaining", num: true }],
			rows: bu.days.map((d) => [longDate(d.date), d.done, d.scope, Math.max(0, d.scope - d.done)]),
		},
		note: dates.length > 1 && daysBetween(dates[0], dates[1]) > 1 ? "Long ranges are sampled weekly." : undefined,
	};
	renderFrame(hub, el, spec, env.state, env.track);
}

// ---------------------------------------------------------------- cumulative flow

function renderCfd(env: ChartEnv, el: HTMLElement): void {
	const { hub, cfg, scope, today } = env;
	const title = cfg.title ?? "Cumulative flow";
	if (scope.missingSprint) return noSprint(env, el, title);
	const from = cfg.from ?? (scope.sprint?.start && !cfg.to ? scope.sprint.start : addDays(cfg.to ?? today, -7 * cfg.weeks));
	let to = cfg.to ?? (scope.sprint?.end ?? today);
	if (to > today) to = today;
	if (from > to) {
		emptyState(el, title, `Nothing to show yet. Tracking starts ${axisDate(from)}.`, "calendar-clock");
		return;
	}
	const metric = chooseMetric(scopedItems(hub, scope), cfg.metric);
	const dates = sampleDates(from, to);
	const flow = cfd(historyCandidates(hub, scope), stateFn(hub), memberFn(scope), { dates, statuses: statusRefs(hub), metric });
	const bandsUsed = flow.bands.filter((b) => b.values.some((v) => v > 0));
	if (!bandsUsed.length) {
		emptyState(el, title, `No work items in ${scopeLabel(scope) || "this vault"} between ${axisDate(from)} and ${axisDate(to)}.`, "chart-area");
		return;
	}
	const unit = (v: number) => amount(v, metric);
	const legendBands = [...bandsUsed].reverse();
	const lastIdx = dates.length - 1;
	const spec: ChartSpec = {
		title,
		subtitle: subtitleOf(env, [`${axisDate(from)} – ${axisDate(to)}`, metric === "points" ? "story points" : "item count"]),
		height: cfg.height,
		legend: legendBands.map((b) => ({ label: b.status.name, key: { shape: "rect", color: b.status.color }, value: num(b.values[lastIdx]) })),
		summary: `Cumulative flow from ${longDate(from)} to ${longDate(to)}; today ${legendBands.map((b) => `${b.status.name} ${num(b.values[lastIdx])}`).join(", ")}.`,
		draw: (svg, width, height) => {
			const f = timeFrame(svg, width, height, from, to, Math.max(...flow.totals, 1), metric);
			const xs = dates.map((d) => f.xOf(d));
			for (const b of bandsUsed) {
				const top = b.y1.map((v) => f.y(v));
				const bottom = b.y0.map((v) => f.y(v));
				painted(s(svg, "path", { d: bandPath(xs, top, bottom) }, "ph-chart-band"), b.status.color);
			}
			// Edges drawn after every fill so a lower band's wash never covers the line above it.
			for (const b of bandsUsed) painted(s(svg, "path", { d: linePath(xs.map((x, i) => [x, f.y(b.y1[i])])) }, "ph-chart-line is-edge"), b.status.color);
			// Direct labels for bands thick enough at the right edge; the legend carries the rest.
			const lx = xs[lastIdx] - 6;
			for (const b of bandsUsed) {
				const y0 = f.y(b.y0[lastIdx]);
				const y1 = f.y(b.y1[lastIdx]);
				if (y0 - y1 < 16) continue;
				const label = fit(b.status.name, Math.min(140, (f.plot.x1 - f.plot.x0) / 3));
				if (label) text(svg, lx, (y0 + y1) / 2 + 4, label, "ph-chart-label is-inband", "end");
			}
			crosshair(svg, f.plot, xs, {
				dots: (i) => bandsUsed.map((b) => ({ y: f.y(b.y1[i]), key: { shape: "line", color: b.status.color } })),
				tip: (i, t) =>
					tip(
						t,
						longDate(dates[i]),
						legendBands.map((b) => ({ value: unit(b.values[i]), label: b.status.name, key: { shape: "line", color: b.status.color } })),
						[`Total ${unit(flow.totals[i])}`],
					),
			});
		},
		table: {
			columns: [{ label: "Date" }, ...legendBands.map((b) => ({ label: b.status.name, num: true })), { label: "Total", num: true }],
			rows: dates.map((d, i) => [longDate(d), ...legendBands.map((b) => b.values[i]), flow.totals[i]]),
		},
		note: dates.length > 1 && daysBetween(dates[0], dates[1]) > 1 ? "Long ranges are sampled weekly." : undefined,
	};
	renderFrame(hub, el, spec, env.state, env.track);
}

// ---------------------------------------------------------------- velocity

function renderVelocity(env: ChartEnv, el: HTMLElement): void {
	const { hub, cfg, scope, today } = env;
	const title = cfg.title ?? "Velocity";
	if (scope.missingSprint) return noSprint(env, el, title);
	const dated = hub.store.sortedSprints().filter((sp) => sp.start && sp.end && sp.start <= today);
	let chosen: Sprint[];
	if (scope.sprint) chosen = dated.filter((sp) => sp.path === scope.sprint!.path);
	else if (cfg.sprints) chosen = dated.slice(-cfg.sprints);
	else {
		const from = cfg.from ?? addDays(today, -7 * cfg.weeks);
		const to = cfg.to ?? today;
		chosen = dated.filter((sp) => sp.end! >= from && sp.start! <= to);
	}
	if (!chosen.length) {
		if (!dated.length) return noSprint({ ...env, scope: { ...scope, missingSprint: "No sprints have started yet." } }, el, title);
		emptyState(el, title, `No sprints in this period. Widen it with "weeks: 26" or "sprints: 6".`, "chart-column");
		return;
	}
	const refs: SprintRef[] = chosen.map((sp) => ({ key: sp.basename, name: sp.name, path: sp.path, start: sp.start!, end: sp.end! }));
	const keys = new Set(chosen.map((sp) => sp.path));
	const inSprints = scopedItems(hub, { ...scope, sprint: null }).filter((i) => i.sprint && keys.has(i.sprint));
	const metric = chooseMetric(inSprints, cfg.metric);
	const v = velocity(historyCandidates(hub, scope), stateFn(hub), memberFn(scope), refs, { today, metric });
	const rows = v.rows.filter((r) => r.committed > 0 || r.completed > 0);
	if (!rows.length) {
		emptyState(el, title, `No committed or completed work in ${plural(chosen.length, "sprint")}${scopeLabel(scope) ? ` for ${scopeLabel(scope)}` : ""}.`, "chart-column");
		return;
	}
	const past = rows.filter((r) => !r.current);
	const avg = past.length ? past.reduce((acc, r) => acc + r.completed, 0) / past.length : null;
	const unit = (x: number) => amount(x, metric);
	const color = "blue";
	const avgLabel = avg === null ? "" : `avg ${num(avg)}`;
	const spec: ChartSpec = {
		title,
		subtitle: subtitleOf(env, [plural(rows.length, "sprint"), metric === "points" ? "story points" : "item count"]),
		height: cfg.height,
		legend: [
			{ label: "Completed", key: { shape: "rect", color } },
			{ label: "Committed at start", key: { shape: "ghost", color } },
			...(avg !== null ? [{ label: `Average of ${plural(past.length, "finished sprint")}`, key: GUIDE_KEY }] : []),
		],
		headline: avg === null ? undefined : (h) => {
			stat(h, num(avg), `${unitWord(metric, avg)} per sprint`, `Average completed over ${plural(past.length, "finished sprint")}`);
			const committed = past.reduce((acc, r) => acc + r.committed, 0);
			const completed = past.reduce((acc, r) => acc + r.completed, 0);
			if (committed > 0) stat(h, `${Math.round((completed / committed) * 100)}%`, "of commitment delivered");
		},
		summary: `Velocity over ${plural(rows.length, "sprint")}${avg !== null ? `, averaging ${unit(Math.round(avg * 10) / 10)}` : ""}.`,
		draw: (svg, width, height) => {
			const yMax = Math.max(...rows.map((r) => Math.max(r.committed, r.completed)), avg ?? 0, 1);
			const plotH = height - TOP - AXIS_BAND;
			const ticks = niceTicks(yMax, Math.max(2, Math.min(6, Math.floor(plotH / 48))), metric === "count");
			const right = avg !== null ? Math.ceil(textWidth(avgLabel)) + 12 : 12;
			const plot = plotOf(width, height, { left: yLabelWidth(ticks), right, top: TOP, bottom: AXIS_BAND });
			const y = linear(0, ticks[ticks.length - 1], plot.y1, plot.y0);
			yAxis(svg, plot, y, ticks);
			const band = bands(plot, rows.length);
			const barW = Math.max(3, Math.min(BAR_MAX, (band.width * 0.8 - GAP) / 2));
			rows.forEach((r, i) => {
				const cx = band.center(i);
				const ghost = s(svg, "path", { d: columnPath(cx - GAP / 2 - barW, barW, plot.y1, y(r.committed)) }, "ph-chart-bar is-ghost");
				painted(ghost, color);
				const bar = painted(s(svg, "path", { d: columnPath(cx + GAP / 2, barW, plot.y1, y(r.completed)) }, "ph-chart-bar" + (r.current ? " is-partial" : "")), color);
				if (i === rows.length - 1 && r.completed > 0) text(svg, cx + GAP / 2 + barW / 2, y(r.completed) - 6, num(r.completed), "ph-chart-label is-strong", "middle");
				const hit = s(svg, "rect", { x: cx - band.width / 2, y: plot.y0, width: band.width, height: plot.y1 - plot.y0 });
				const pctDone = r.committed > 0 ? ` (${Math.round((r.completed / r.committed) * 100)}% of commitment)` : "";
				markHover(
					svg,
					hit,
					bar,
					`${r.sprint.name}: ${unit(r.completed)} completed, ${unit(r.committed)} committed`,
					(t) =>
						tip(
							t,
							r.sprint.name,
							[
								{ value: unit(r.completed), label: "Completed" + pctDone, key: { shape: "line", color } },
								{ value: unit(r.committed), label: "Committed at start" },
							],
							[`${axisDate(r.sprint.start)} – ${axisDate(r.sprint.end)}${r.current ? " · in progress" : ""}`, r.items.length ? "Click to list completed items" : "Nothing completed"],
						),
					r.items.length ? () => env.openItems(`${r.sprint.name} · completed`, r.items.map((item) => ({ item }))) : undefined,
				);
				void ghost;
			});
			if (avg !== null) guideLine(svg, plot, y(avg), avgLabel);
			bandLabels(svg, plot, rows.map((r) => r.sprint.name + (r.current ? " (now)" : "")), band, width);
		},
		table: {
			columns: [{ label: "Sprint" }, { label: "Dates" }, { label: "Committed", num: true }, { label: "Completed", num: true }, { label: "Items done", num: true }],
			rows: rows.map((r) => [{ text: r.sprint.name + (r.current ? " (in progress)" : ""), path: r.sprint.path }, `${axisDate(r.sprint.start)} – ${axisDate(r.sprint.end)}`, r.committed, r.completed, r.items.length]),
			caption: avg !== null ? `Average ${unit(Math.round(avg * 10) / 10)} per finished sprint` : undefined,
		},
	};
	renderFrame(hub, el, spec, env.state, env.track);
}

// ---------------------------------------------------------------- throughput

function renderThroughput(env: ChartEnv, el: HTMLElement): void {
	const { hub, cfg, scope, today } = env;
	const title = cfg.title ?? "Throughput";
	if (scope.missingSprint) return noSprint(env, el, title);
	const to = cfg.to ?? today;
	const from = cfg.from ?? addDays(startOfWeek(to), -7 * (cfg.weeks - 1));
	const metric = cfg.metric ?? "count";
	const items = scopedItems(hub, scope);
	const tp = throughput(items, categoryFn(hub), { from, to, today, metric });
	const total = tp.weeks.reduce((acc, w) => acc + w.value, 0);
	if (!tp.weeks.length || total === 0) {
		emptyState(el, title, `Nothing was closed between ${axisDate(from)} and ${axisDate(to)}${scopeLabel(scope) ? ` in ${scopeLabel(scope)}` : ""}. Items count when they move to a done status.`, "chart-column");
		return;
	}
	const unit = (x: number) => amount(x, metric);
	const avgLabel = tp.average === null ? "" : `avg ${num(tp.average)}`;
	const color = doneColor(hub);
	const spec: ChartSpec = {
		title,
		subtitle: subtitleOf(env, [`${plural(tp.weeks.length, "week")}`, metric === "points" ? "story points closed" : "items closed"]),
		height: cfg.height,
		legend: tp.average !== null ? [{ label: "Closed per week", key: { shape: "rect", color } }, { label: "Weekly average", key: GUIDE_KEY }] : undefined,
		headline: (h) => {
			stat(h, num(total), `${unitWord(metric, total)} closed`);
			if (tp.average !== null) stat(h, num(tp.average), `per week on average`);
		},
		summary: `Throughput: ${unit(total)} closed over ${plural(tp.weeks.length, "week")}.`,
		draw: (svg, width, height) => {
			const yMax = Math.max(...tp.weeks.map((w) => w.value), tp.average ?? 0, 1);
			const plotH = height - TOP - AXIS_BAND;
			const ticks = niceTicks(yMax, Math.max(2, Math.min(6, Math.floor(plotH / 48))), metric === "count");
			const right = tp.average !== null ? Math.ceil(textWidth(avgLabel)) + 12 : 12;
			const plot = plotOf(width, height, { left: yLabelWidth(ticks), right, top: TOP, bottom: AXIS_BAND });
			const y = linear(0, ticks[ticks.length - 1], plot.y1, plot.y0);
			yAxis(svg, plot, y, ticks);
			const band = bands(plot, tp.weeks.length);
			const barW = Math.max(2, Math.min(BAR_MAX, band.width - GAP - Math.min(12, band.width * 0.3)));
			tp.weeks.forEach((w, i) => {
				const cx = band.center(i);
				const bar = painted(s(svg, "path", { d: columnPath(cx - barW / 2, barW, plot.y1, y(w.value)) }, "ph-chart-bar" + (w.partial ? " is-partial" : "")), color);
				const hit = s(svg, "rect", { x: cx - band.width / 2, y: plot.y0, width: band.width, height: plot.y1 - plot.y0 });
				const label = `Week of ${axisDate(w.start)}`;
				markHover(
					svg,
					hit,
					bar,
					`${label}: ${unit(w.value)} closed`,
					(t) => tip(t, label, [{ value: unit(w.value), label: w.partial ? "Closed so far" : "Closed", key: { shape: "line", color } }], [`${axisDate(w.start)} – ${axisDate(w.end)}`, ...(w.items.length ? ["Click to list items"] : [])]),
					w.items.length ? () => env.openItems(`${label} · closed`, w.items.map((item) => ({ item, detail: item.closed ? axisDate(item.closed) : undefined }))) : undefined,
				);
			});
			const lastFull = [...tp.weeks.keys()].reverse().find((i) => !tp.weeks[i].partial);
			if (lastFull !== undefined && tp.weeks[lastFull].value > 0) text(svg, band.center(lastFull), y(tp.weeks[lastFull].value) - 6, num(tp.weeks[lastFull].value), "ph-chart-label is-strong", "middle");
			if (tp.average !== null) guideLine(svg, plot, y(tp.average), avgLabel);
			bandLabels(svg, plot, tp.weeks.map((w) => axisDate(w.start)), band, width);
		},
		table: {
			columns: [{ label: "Week of" }, { label: "Closed", num: true }, { label: "Items", num: true }],
			rows: tp.weeks.map((w) => [axisDate(w.start) + (w.partial ? " (so far)" : ""), w.value, w.items.length]),
			caption: tp.average !== null ? `Average ${unit(Math.round(tp.average * 10) / 10)} per full week` : undefined,
		},
	};
	renderFrame(hub, el, spec, env.state, env.track);
}

// ---------------------------------------------------------------- status breakdown

function renderStatus(env: ChartEnv, el: HTMLElement): void {
	const { hub, cfg, scope } = env;
	const title = cfg.title ?? "Status";
	if (scope.missingSprint) return noSprint(env, el, title);
	const items = scopedItems(hub, scope);
	const metric = cfg.metric ?? "count";
	const slices = statusBreakdown(items, statusRefs(hub), categoryFn(hub));
	const value = (sl: { count: number; points: number }) => (metric === "points" ? sl.points : sl.count);
	const total = slices.reduce((acc, sl) => acc + value(sl), 0);
	if (total === 0) {
		const box = emptyState(el, title, `No ${metric === "points" ? "estimated " : ""}work items in ${scopeLabel(scope) || "this vault"} yet.`, "chart-bar");
		actionButton(box, "New work item", "plus", () => hub.newItem({ project: scope.project?.path ?? null, sprint: scope.sprint?.path ?? null }));
		return;
	}
	const used = slices.filter((sl) => value(sl) > 0);
	const unit = (x: number) => amount(x, metric);
	const pct = (x: number) => `${Math.round((x / total) * 100)}%`;
	const open = (sl: (typeof slices)[number]) => env.openItems(`${sl.status.name} · ${plural(sl.count, "item")}`, sl.items.map((item) => ({ item })));
	const spec: ChartSpec = {
		title,
		subtitle: subtitleOf(env, [`${unit(total)}`]),
		height: 40,
		legend: slices
			.filter((sl) => sl.count > 0)
			.map((sl) => ({ label: sl.status.name, key: { shape: "rect", color: sl.status.color }, value: `${num(value(sl))} · ${pct(value(sl))}`, onClick: () => open(sl) })),
		summary: `Status breakdown of ${unit(total)}: ${used.map((sl) => `${sl.status.name} ${num(value(sl))}`).join(", ")}.`,
		draw: (svg, width) => {
			const plot = plotOf(width, 40, { left: 0, right: 0, top: 8, bottom: 8 });
			const x = linear(0, total, plot.x0, plot.x1);
			const h = Math.min(BAR_MAX, plot.y1 - plot.y0);
			let acc = 0;
			used.forEach((sl, i) => {
				const v = value(sl);
				const a = x(acc) + (i > 0 ? GAP / 2 : 0);
				const b = x(acc + v) - (i < used.length - 1 ? GAP / 2 : 0);
				acc += v;
				if (b - a <= 0.5) return;
				const k = Math.min(4, (b - a) / 2, h / 2);
				const left = i === 0 ? k : 0;
				const right = i === used.length - 1 ? k : 0;
				const y0 = plot.y0;
				const d = `M${a + left},${y0}H${b - right}${right ? `Q${b},${y0} ${b},${y0 + right}` : ""}V${y0 + h - right}${right ? `Q${b},${y0 + h} ${b - right},${y0 + h}` : ""}H${a + left}${left ? `Q${a},${y0 + h} ${a},${y0 + h - left}` : ""}V${y0 + left}${left ? `Q${a},${y0} ${a + left},${y0}` : ""}Z`;
				const seg = painted(s(svg, "path", { d }, "ph-chart-bar"), sl.status.color);
				const label = `${pct(v)}`;
				if (textWidth(label, 11, 600) + 12 <= b - a) text(svg, (a + b) / 2, y0 + h / 2 + 4, label, "ph-chart-label is-onfill", "middle").dataset.phColor = sl.status.color;
				const hit = s(svg, "rect", { x: a - GAP / 2, y: 0, width: b - a + GAP, height: 40 });
				markHover(
					svg,
					hit,
					seg,
					`${sl.status.name}: ${unit(v)}, ${pct(v)}`,
					(t) => tip(t, sl.status.name, [{ value: unit(v), label: pct(v) + " of total", key: { shape: "line", color: sl.status.color } }], metric === "points" ? [plural(sl.count, "item")] : sl.points ? [`${num(sl.points)} pts`] : []),
					() => open(sl),
				);
			});
		},
		table: {
			columns: [{ label: "Status" }, { label: "Items", num: true }, { label: "Points", num: true }, { label: "Share", num: true }],
			rows: slices.map((sl) => [sl.status.name, sl.count, sl.points, pct(value(sl))]),
		},
	};
	renderFrame(hub, el, spec, env.state, env.track);
}

// ---------------------------------------------------------------- workload

const WORKLOAD_ROWS = 14;

function renderWorkload(env: ChartEnv, el: HTMLElement): void {
	const { hub, cfg, scope } = env;
	const title = cfg.title ?? "Workload";
	if (scope.missingSprint) return noSprint(env, el, title);
	const store = hub.store;
	const items = scopedItems(hub, scope);
	const openItems = items.filter((i) => !store.isDone(i));
	const metric = chooseMetric(openItems, cfg.metric);
	let rows = workload(items, statusRefs(hub), categoryFn(hub), (it) => ({ key: it.assignee, name: it.assignee ? (store.people.has(it.assignee) ? store.displayName(it.assignee) : it.assigneeName ?? it.assignee) : "Unassigned" }), metric);
	if (!rows.length) {
		emptyState(el, title, `No open work in ${scopeLabel(scope) || "this vault"}.`, "users");
		return;
	}
	const statuses = rows[0].segments.map((sg) => sg.status);
	const usedStatus = statuses.filter((_, i) => rows.some((r) => r.segments[i].value > 0));
	if (rows.length > WORKLOAD_ROWS) {
		const head = rows.slice(0, WORKLOAD_ROWS - 1);
		const tail = rows.slice(WORKLOAD_ROWS - 1);
		const other = {
			key: "\u0000other",
			name: `${tail.length} others`,
			total: tail.reduce((a, r) => a + r.total, 0),
			count: tail.reduce((a, r) => a + r.count, 0),
			points: tail.reduce((a, r) => a + r.points, 0),
			segments: statuses.map((status, i) => ({ status, value: tail.reduce((a, r) => a + r.segments[i].value, 0), items: tail.flatMap((r) => r.segments[i].items) })),
		};
		rows = [...head, other];
	}
	const unit = (x: number) => amount(x, metric);
	const rowH = 32;
	const height = rows.length * rowH + TOP + AXIS_BAND - 6;
	const total = rows.reduce((a, r) => a + r.total, 0);
	const spec: ChartSpec = {
		title,
		subtitle: subtitleOf(env, [`${unit(total)} open`, metric === "points" ? "story points" : "item count"]),
		height,
		legend: usedStatus.map((st) => ({ label: st.name, key: { shape: "rect", color: st.color } })),
		summary: `Open work per assignee: ${rows.map((r) => `${r.name} ${num(r.total)}`).join(", ")}.`,
		draw: (svg, width, h) => {
			const labelW = Math.min(Math.max(...rows.map((r) => textWidth(r.name))) + 14, Math.max(80, width * 0.3));
			const maxV = Math.max(...rows.map((r) => r.total), 1);
			const ticks = niceTicks(maxV, Math.max(2, Math.min(6, Math.floor((width - labelW) / 90))), metric === "count");
			const tipW = textWidth(num(maxV), 11, 600) + 12;
			const plot = plotOf(width, h, { left: labelW, right: tipW, top: TOP - 6, bottom: AXIS_BAND - 6 });
			const x = linear(0, ticks[ticks.length - 1], plot.x0, plot.x1);
			const g = s(svg, "g", {}, "ph-chart-axis");
			for (const t of ticks) {
				const px = crisp(x(t));
				if (t !== 0) s(g, "line", { x1: px, x2: px, y1: plot.y0, y2: plot.y1 }, "ph-chart-grid");
				text(g, x(t), plot.y1 + 16, num(t), "ph-chart-tick", t === 0 ? "start" : "middle");
			}
			s(svg, "line", { x1: crisp(plot.x0), x2: crisp(plot.x0), y1: plot.y0, y2: plot.y1 }, "ph-chart-baseline");
			const barH = Math.min(BAR_MAX, rowH - 10);
			rows.forEach((r, ri) => {
				const yTop = plot.y0 + ri * rowH + (rowH - barH) / 2;
				const nameEl = text(svg, plot.x0 - 8, yTop + barH / 2 + 4, fit(r.name, labelW - 12), "ph-chart-tick is-name" + (r.key === null || r.key === "\u0000other" ? " is-muted" : ""), "end");
				if (r.key && store.people.has(r.key)) {
					const path = r.key;
					nameEl.addClass("is-link");
					nameEl.addEventListener("click", (e) => void hub.openPath(path, e.ctrlKey || e.metaKey));
				}
				const segs = r.segments.filter((sg) => sg.value > 0);
				let acc = 0;
				segs.forEach((sg, si) => {
					const a = x(acc) + (si > 0 ? GAP / 2 : 0);
					const b = x(acc + sg.value) - (si < segs.length - 1 ? GAP / 2 : 0);
					acc += sg.value;
					if (b - a <= 0.5) return;
					const bar = painted(s(svg, "path", { d: hbarPath(a, b, yTop, barH, si === segs.length - 1) }, "ph-chart-bar"), sg.status.color);
					const hit = s(svg, "rect", { x: a - GAP / 2, y: yTop - 4, width: b - a + GAP, height: barH + 8 });
					markHover(
						svg,
						hit,
						bar,
						`${r.name}, ${sg.status.name}: ${unit(sg.value)}`,
						(t) => tip(t, r.name, [{ value: unit(sg.value), label: sg.status.name, key: { shape: "line", color: sg.status.color } }], [`${unit(r.total)} open in total`, "Click to list items"]),
						() => env.openItems(`${r.name} · ${sg.status.name}`, sg.items.map((item) => ({ item }))),
					);
				});
				text(svg, x(r.total) + 6, yTop + barH / 2 + 4, num(r.total), "ph-chart-label is-strong");
			});
		},
		table: {
			columns: [{ label: "Assignee" }, ...usedStatus.map((st) => ({ label: st.name, num: true })), { label: "Total", num: true }],
			rows: rows.map((r): Cell[] => [
				r.key && store.people.has(r.key) ? { text: r.name, path: r.key } : r.name,
				...usedStatus.map((st) => r.segments.find((sg) => sg.status.name === st.name)?.value ?? 0),
				r.total,
			]),
		},
	};
	renderFrame(hub, el, spec, env.state, env.track);
}

// ---------------------------------------------------------------- cycle time

function renderCycleTime(env: ChartEnv, el: HTMLElement): void {
	const { hub, cfg, scope, today } = env;
	const title = cfg.title ?? "Cycle time";
	if (scope.missingSprint) return noSprint(env, el, title);
	const to = cfg.to ?? today;
	const from = cfg.from ?? (scope.sprint?.start && !cfg.to ? scope.sprint.start : addDays(to, -90));
	const ct = cycleTimes(scopedItems(hub, scope), categoryFn(hub), { from, to });
	if (!ct.points.length) {
		emptyState(el, title, `No items were finished between ${axisDate(from)} and ${axisDate(to)}. Cycle time is measured from "started" to "closed".`, "chart-scatter");
		return;
	}
	const color = "blue";
	const days = (n: number) => plural(n, "day");
	const spec: ChartSpec = {
		title,
		subtitle: subtitleOf(env, [`${axisDate(from)} – ${axisDate(to)}`, plural(ct.points.length, "finished item")]),
		height: cfg.height,
		headline: (h) => {
			stat(h, num(ct.median), "days median", "Half of the items finished at least this fast");
			stat(h, num(ct.p85), "days for 85%", "85% of items finished within this many days");
		},
		summary: `Cycle time of ${plural(ct.points.length, "finished item")}: median ${days(ct.median ?? 0)}, 85th percentile ${days(ct.p85 ?? 0)}.`,
		draw: (svg, width, height) => {
			const maxD = Math.max(...ct.points.map((p) => p.days), ct.p85 ?? 0, 1);
			const p85Label = `85% ≤ ${num(ct.p85)}d`;
			const right = Math.ceil(Math.max(textWidth(p85Label), textWidth(`50% ≤ ${num(ct.p50)}d`))) + 12;
			const f = timeFrame(svg, width, height, from, to, maxD, "count", right);
			if (ct.p50 !== null) guideLine(svg, f.plot, f.y(ct.p50), `50% ≤ ${num(ct.p50)}d`);
			if (ct.p85 !== null && ct.p85 !== ct.p50) guideLine(svg, f.plot, f.y(ct.p85), p85Label);
			const pts = ct.points.map((p) => ({ ...p, x: f.xOf(p.closed), y: f.y(p.days) }));
			const g = s(svg, "g", {}, "ph-chart-dots");
			for (const p of pts) ringDot(g, p.x, p.y, color);
			nearestHover(svg, f.plot, pts, {
				key: () => ({ shape: "dot", color }),
				tip: (p, same, t) => {
					const shown = same.slice(0, 6);
					tip(
						t,
						shown.length > 1 ? `${plural(same.length, "item")} · ${days(p.days)}` : p.item.title,
						shown.map((q) => ({ value: days(q.days), label: shown.length > 1 ? q.item.title : `${axisDate(q.started)} → ${axisDate(q.closed)}`, key: { shape: "dot", color } })),
						[...(same.length > shown.length ? [`+${same.length - shown.length} more`] : []), same.length > 1 ? "Click to list items" : "Click to open"],
					);
				},
				onClick: (p) => {
					const same = pts.filter((q) => Math.abs(q.x - p.x) < 3 && Math.abs(q.y - p.y) < 3);
					if (same.length > 1) env.openItems(`Finished ${axisDate(p.closed)} · ${days(p.days)}`, same.map((q) => ({ item: q.item, detail: days(q.days) })));
					else void hub.openPath(p.item.path);
				},
			});
		},
		table: {
			columns: [{ label: "Item" }, { label: "Started" }, { label: "Closed" }, { label: "Cycle time (days)", num: true }],
			rows: ct.points.map((p) => [{ text: p.item.id ? `${p.item.id} ${p.item.title}` : p.item.title, path: p.item.path }, axisDate(p.started), axisDate(p.closed), p.days]),
			caption: `Median ${days(ct.median ?? 0)} · 85th percentile ${days(ct.p85 ?? 0)}`,
		},
	};
	renderFrame(hub, el, spec, env.state, env.track);
}

// ---------------------------------------------------------------- aging work in progress

function renderAging(env: ChartEnv, el: HTMLElement): void {
	const { hub, cfg, scope, today } = env;
	const title = cfg.title ?? "Aging work in progress";
	if (scope.missingSprint) return noSprint(env, el, title);
	const catOf = categoryFn(hub);
	const items = scopedItems(hub, scope);
	const aging = agingItems(items, catOf, today);
	const columns = statusRefs(hub).filter((st) => st.category === "inProgress" || st.category === "resolved");
	const ct = cycleTimes(items, catOf, { from: cfg.from ?? addDays(today, -90), to: today });
	if (!aging.length) {
		emptyState(el, title, `Nothing is in progress${scopeLabel(scope) ? ` in ${scopeLabel(scope)}` : ""}. Items appear here once they move to an in-progress status.`, "hourglass");
		return;
	}
	const days = (n: number) => plural(n, "day");
	const colIndex = (status: string) => {
		const lower = status.toLowerCase();
		const i = columns.findIndex((c) => c.name.toLowerCase() === lower);
		return i >= 0 ? i : columns.findIndex((c) => c.category === catOf(status));
	};
	const old = ct.p85 !== null ? aging.filter((a) => a.age > ct.p85!).length : 0;
	const spec: ChartSpec = {
		title,
		subtitle: subtitleOf(env, [plural(aging.length, "item") + " in progress", ct.p85 !== null ? `percentiles from ${plural(ct.points.length, "item")} finished in 90 days` : null]),
		height: cfg.height,
		headline: (h) => {
			stat(h, String(aging.length), "in progress");
			stat(h, days(aging[0].age), "oldest");
			if (ct.p85 !== null) {
				if (old > 0) badge(h, `${plural(old, "item")} past 85th percentile`, "warning", "triangle-alert", `Older than ${days(ct.p85)}; 85% of recent items finished faster`);
				else badge(h, "All within usual cycle time", "good", "circle-check");
			}
		},
		summary: `${plural(aging.length, "item")} in progress; oldest ${days(aging[0].age)}.`,
		draw: (svg, width, height) => {
			const maxAge = Math.max(...aging.map((a) => a.age), ct.p85 ?? 0, 1);
			const plotH = height - TOP - AXIS_BAND;
			const ticks = niceTicks(maxAge, Math.max(2, Math.min(6, Math.floor(plotH / 48))), true);
			const right = ct.p85 !== null ? Math.ceil(Math.max(textWidth(`85% ≤ ${num(ct.p85)}d`), textWidth(`50% ≤ ${num(ct.p50)}d`))) + 12 : 12;
			const plot = plotOf(width, height, { left: yLabelWidth(ticks), right, top: TOP, bottom: AXIS_BAND });
			const y = linear(0, ticks[ticks.length - 1], plot.y1, plot.y0);
			yAxis(svg, plot, y, ticks);
			const band = bands(plot, columns.length);
			if (ct.p50 !== null) guideLine(svg, plot, y(ct.p50), `50% ≤ ${num(ct.p50)}d`);
			if (ct.p85 !== null && ct.p85 !== ct.p50) guideLine(svg, plot, y(ct.p85), `85% ≤ ${num(ct.p85)}d`);
			for (let i = 1; i < columns.length; i++) {
				const x = crisp(plot.x0 + band.width * i);
				s(svg, "line", { x1: x, x2: x, y1: plot.y0, y2: plot.y1 }, "ph-chart-grid");
			}
			const spread = Math.min(band.width * 0.6, 120);
			const pts = aging.map((a) => {
				const ci = Math.max(0, colIndex(a.status));
				return { ...a, col: columns[ci], x: band.center(ci) + (jitter(a.item.path) - 0.5) * spread, y: y(a.age) };
			});
			const g = s(svg, "g", {}, "ph-chart-dots");
			for (const p of pts) ringDot(g, p.x, p.y, p.col?.color ?? "gray");
			const ax = s(svg, "g", {}, "ph-chart-axis");
			columns.forEach((c, i) => {
				const label = fit(c.name, band.width - 18);
				const w = textWidth(label);
				const cx = band.center(i);
				painted(s(ax, "circle", { cx: cx - w / 2 - 7, cy: plot.y1 + 13, r: 4 }, "ph-chart-key-dot"), c.color);
				text(ax, cx + 3, plot.y1 + 17, label, "ph-chart-tick", "middle");
			});
			nearestHover(svg, plot, pts, {
				key: (p) => ({ shape: "dot", color: p.col?.color ?? "gray" }),
				tip: (p, _same, t) => {
					const foot = [`Started ${axisDate(p.started)}`];
					if (ct.p85 !== null && p.age > ct.p85) foot.push("Older than 85% of recently finished items");
					else if (ct.p50 !== null && p.age > ct.p50) foot.push("Older than the median cycle time");
					foot.push("Click to open");
					tip(t, p.item.title, [{ value: days(p.age), label: p.status, key: { shape: "dot", color: p.col?.color ?? "gray" } }], foot);
				},
				onClick: (p) => void hub.openPath(p.item.path),
			});
		},
		table: {
			columns: [{ label: "Item" }, { label: "Status" }, { label: "Started" }, { label: "Age (days)", num: true }],
			rows: aging.map((a) => [{ text: a.item.id ? `${a.item.id} ${a.item.title}` : a.item.title, path: a.item.path }, a.status, axisDate(a.started), a.age]),
			caption: ct.p85 !== null ? `Cycle time over the last 90 days: median ${days(ct.median ?? 0)}, 85th percentile ${days(ct.p85)}` : undefined,
		},
	};
	renderFrame(hub, el, spec, env.state, env.track);
}
