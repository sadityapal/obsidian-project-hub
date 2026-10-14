// Pure chart computations. No Obsidian imports, so everything here runs under node:test.

import type { StatusCategory } from "../core/model";
import { addDays, dateRange, daysBetween, formatNumber, isWeekend, median, percentile, plural, startOfWeek } from "../core/util";

export type Metric = "points" | "count";

/** State of an item at the end of a day; matches HistoryStore.stateAt. */
export interface ItemState {
	status: string;
	category: StatusCategory;
	points: number | null;
	sprint: string | null;
	project: string | null;
}

/** The work item fields the charts read. WorkItem satisfies it. */
export interface ChartItem {
	path: string;
	id: string;
	title: string;
	status: string;
	points: number | null;
	created: string | null;
	started: string | null;
	closed: string | null;
	due: string | null;
}

export type StateAt<T> = (item: T, date: string) => ItemState | null;
/** Whether an item counts toward the chart's scope, given its state on a day. */
export type Member<T> = (item: T, state: ItemState) => boolean;
export type CategoryOf = (status: string) => StatusCategory;

export interface StatusRef {
	name: string;
	category: StatusCategory;
	color?: string;
}

export interface SprintRef {
	/** Name recorded in history (the sprint note's basename). */
	key: string;
	name: string;
	path: string;
	start: string;
	end: string;
}

const OPEN_CATEGORIES = new Set<StatusCategory>(["proposed", "inProgress", "resolved"]);
const WIP_CATEGORIES = new Set<StatusCategory>(["inProgress", "resolved"]);

export function measure(state: { points: number | null }, metric: Metric): number {
	return metric === "points" ? state.points ?? 0 : 1;
}

/** Points when every scoped item is estimated, otherwise counts. */
export function chooseMetric(items: { points: number | null }[], explicit?: Metric | null): Metric {
	if (explicit) return explicit;
	return items.length > 0 && items.every((i) => i.points !== null) ? "points" : "count";
}

/** Weekdays in the inclusive range [from, to]. */
export function workingDays(from: string, to: string): number {
	let n = 0;
	const total = daysBetween(from, to);
	for (let i = 0; i <= total; i++) if (!isWeekend(addDays(from, i))) n++;
	return n;
}

/**
 * Ideal burndown: full scope on the first day, zero on the last, burning evenly on
 * working days only so weekends stay flat. Falls back to calendar days when the
 * range has no working days after the start.
 */
export function idealLine(start: string, end: string, startScope: number): number[] {
	const days = dateRange(start, end);
	if (days.length <= 1) return days.map(() => startScope);
	const total = days.slice(1).filter((d) => !isWeekend(d)).length;
	let burned = 0;
	return days.map((d, i) => {
		if (!total) return startScope * (1 - i / (days.length - 1));
		if (i > 0 && !isWeekend(d)) burned++;
		return startScope * (1 - burned / total);
	});
}

/** Daily dates for short ranges, weekly (or coarser) samples for long ones. Always includes `to`. */
export function sampleDates(from: string, to: string, maxDaily = 120): string[] {
	const n = daysBetween(from, to);
	if (!(n >= 0)) return [];
	if (n <= maxDaily) return dateRange(from, to);
	const step = n <= 730 ? 7 : Math.ceil(n / 104 / 7) * 7;
	const out: string[] = [];
	for (let i = 0; i < n; i += step) out.push(addDays(from, i));
	out.push(to);
	return out;
}

export interface Totals<T> {
	scope: number;
	done: number;
	members: Map<T, number>;
}

/** Scope and completed work of the members on one day. */
export function totalsAt<T>(items: T[], stateAt: StateAt<T>, member: Member<T>, date: string, metric: Metric): Totals<T> {
	const members = new Map<T, number>();
	let scope = 0;
	let done = 0;
	for (const it of items) {
		const s = stateAt(it, date);
		if (!s || s.category === "removed" || !member(it, s)) continue;
		const v = measure(s, metric);
		members.set(it, v);
		scope += v;
		if (s.category === "completed") done += v;
	}
	return { scope, done, members };
}

// ---------------------------------------------------------------- burndown

export interface BurndownDay {
	date: string;
	/** Open work at the end of the day; null for days that have not happened yet. */
	remaining: number | null;
	scope: number | null;
	completed: number | null;
	ideal: number;
	weekend: boolean;
}

export interface ScopeChange<T> {
	date: string;
	/** Change in total scope from the previous day (membership and re-estimates). */
	delta: number;
	added: T[];
	removed: T[];
}

export type BurndownStatus = "empty" | "upcoming" | "done" | "on-track" | "at-risk" | "behind" | "ended";

export interface Burndown<T> {
	days: BurndownDay[];
	startScope: number;
	changes: ScopeChange<T>[];
	/** Last measured day: today, or the end date of a finished sprint. Null before the start. */
	current: BurndownDay | null;
	/** Planned scope today, for sprints that have not started. */
	planned: number;
	workingDaysLeft: number;
	status: BurndownStatus;
}

export function burndown<T>(
	items: T[],
	stateAt: StateAt<T>,
	member: Member<T>,
	opts: { start: string; end: string; today: string; metric: Metric },
): Burndown<T> {
	const dates = dateRange(opts.start, opts.end);
	const days: BurndownDay[] = [];
	const changes: ScopeChange<T>[] = [];
	let prev: Totals<T> | null = null;
	for (const date of dates) {
		const weekend = isWeekend(date);
		if (date > opts.today) {
			days.push({ date, remaining: null, scope: null, completed: null, ideal: 0, weekend });
			continue;
		}
		const t = totalsAt(items, stateAt, member, date, opts.metric);
		if (prev) {
			const before = prev.members;
			const added = [...t.members.keys()].filter((k) => !before.has(k));
			const removed = [...before.keys()].filter((k) => !t.members.has(k));
			const delta = t.scope - prev.scope;
			if (added.length || removed.length || Math.abs(delta) > 1e-9) changes.push({ date, delta, added, removed });
		}
		days.push({ date, remaining: t.scope - t.done, scope: t.scope, completed: t.done, ideal: 0, weekend });
		prev = t;
	}
	const startScope = days[0]?.scope ?? 0;
	const ideal = idealLine(opts.start, opts.end, startScope);
	days.forEach((d, i) => (d.ideal = ideal[i] ?? 0));

	const measured = days.filter((d) => d.remaining !== null);
	const current = measured[measured.length - 1] ?? null;
	// Before the start there is nothing to measure, so plan against the first sprint day.
	const planned = current ? current.scope ?? 0 : totalsAt(items, stateAt, member, opts.start, opts.metric).scope;
	const workingDaysLeft = opts.today > opts.end ? 0 : workingDays(opts.today < opts.start ? opts.start : opts.today, opts.end);

	let status: BurndownStatus;
	if (!current) status = planned > 0 ? "upcoming" : "empty";
	else if (measured.every((d) => !d.scope)) status = "empty";
	else if (current.remaining === 0) status = "done";
	else if (opts.today > opts.end) status = "ended";
	else {
		const ref = Math.max(startScope, current.scope ?? 0);
		const gap = (current.remaining ?? 0) - current.ideal;
		status = gap <= 1e-9 ? "on-track" : gap <= ref * 0.1 ? "at-risk" : "behind";
	}
	return { days, startScope, changes, current, planned, workingDaysLeft, status };
}

// ---------------------------------------------------------------- burnup

export interface BurnupDay {
	date: string;
	scope: number;
	done: number;
}

export interface Forecast {
	/** Completed work per day over the trailing window. */
	rate: number;
	remaining: number;
	/** Projected completion date, today when already done, null without throughput. */
	finish: string | null;
	window: number;
}

export function burnup<T>(
	items: T[],
	stateAt: StateAt<T>,
	member: Member<T>,
	opts: { dates: string[]; today: string; metric: Metric; window?: number },
): { days: BurnupDay[]; forecast: Forecast } {
	const days = opts.dates
		.filter((d) => d <= opts.today)
		.map((date) => {
			const t = totalsAt(items, stateAt, member, date, opts.metric);
			return { date, scope: t.scope, done: t.done };
		});
	const window = opts.window ?? 28;
	const now = totalsAt(items, stateAt, member, opts.today, opts.metric);
	const then = totalsAt(items, stateAt, member, addDays(opts.today, -window), opts.metric);
	return { days, forecast: forecast(now.scope, now.done, then.done, window, opts.today) };
}

export function forecast(scope: number, doneNow: number, doneThen: number, window: number, today: string): Forecast {
	const rate = Math.max(0, (doneNow - doneThen) / window);
	const remaining = Math.max(0, scope - doneNow);
	let finish: string | null = null;
	if (remaining <= 0) finish = today;
	else if (rate > 0) {
		const days = Math.ceil(remaining / rate - 1e-9);
		finish = days <= 3650 ? addDays(today, days) : null;
	}
	return { rate, remaining, finish, window };
}

// ---------------------------------------------------------------- cumulative flow

export interface CfdBand {
	status: StatusRef;
	values: number[];
	y0: number[];
	y1: number[];
}

export interface Cfd {
	dates: string[];
	/** Bottom to top: completed statuses first, the first board column last. */
	bands: CfdBand[];
	totals: number[];
}

/** Maps a (possibly renamed) status to a known one: exact name, else the first status of its category. */
export function bucketStatus(status: string, category: StatusCategory, statuses: StatusRef[]): StatusRef | null {
	const n = status.toLowerCase();
	return statuses.find((s) => s.name.toLowerCase() === n) ?? statuses.find((s) => s.category === category) ?? null;
}

export function cfd<T>(items: T[], stateAt: StateAt<T>, member: Member<T>, opts: { dates: string[]; statuses: StatusRef[]; metric: Metric }): Cfd {
	// Reversed board order keeps the palette's validated neighbours adjacent in the stack.
	const order = opts.statuses.filter((s) => s.category !== "removed").reverse();
	const bands: CfdBand[] = order.map((status) => ({
		status,
		values: opts.dates.map(() => 0),
		y0: [],
		y1: [],
	}));
	const index = new Map(order.map((s, i) => [s.name, i]));
	opts.dates.forEach((date, di) => {
		for (const it of items) {
			const s = stateAt(it, date);
			if (!s || s.category === "removed" || !member(it, s)) continue;
			const b = bucketStatus(s.status, s.category, order);
			if (!b) continue;
			bands[index.get(b.name)!].values[di] += measure(s, opts.metric);
		}
	});
	const totals = opts.dates.map(() => 0);
	for (const band of bands) {
		band.values.forEach((v, di) => {
			band.y0[di] = totals[di];
			totals[di] += v;
			band.y1[di] = totals[di];
		});
	}
	return { dates: opts.dates, bands, totals };
}

// ---------------------------------------------------------------- velocity

export interface VelocityRow<T> {
	sprint: SprintRef;
	/** Open scope in the sprint at the end of its first day. */
	committed: number;
	completed: number;
	items: T[];
	/** The sprint is still running; excluded from the average. */
	current: boolean;
}

export interface Velocity<T> {
	rows: VelocityRow<T>[];
	average: number | null;
}

/**
 * Work completed inside each sprint: items that were in the sprint and done at its end
 * (or today for a running sprint) but not already done before it started.
 */
export function velocity<T>(
	items: T[],
	stateAt: StateAt<T>,
	member: Member<T>,
	sprints: SprintRef[],
	opts: { today: string; metric: Metric },
): Velocity<T> {
	const rows: VelocityRow<T>[] = [];
	for (const sp of sprints) {
		if (sp.start > opts.today) continue;
		const current = sp.end >= opts.today;
		const endDay = current ? opts.today : sp.end;
		const dayBefore = addDays(sp.start, -1);
		let committed = 0;
		let completed = 0;
		const done: T[] = [];
		for (const it of items) {
			const s0 = stateAt(it, sp.start);
			if (s0 && s0.sprint === sp.key && member(it, s0) && OPEN_CATEGORIES.has(s0.category)) committed += measure(s0, opts.metric);
			const se = stateAt(it, endDay);
			if (!se || se.sprint !== sp.key || se.category !== "completed" || !member(it, se)) continue;
			const before = stateAt(it, dayBefore);
			if (before && before.category === "completed") continue;
			completed += measure(se, opts.metric);
			done.push(it);
		}
		rows.push({ sprint: sp, committed, completed, items: done, current });
	}
	const past = rows.filter((r) => !r.current);
	const average = past.length ? past.reduce((s, r) => s + r.completed, 0) / past.length : null;
	return { rows, average };
}

// ---------------------------------------------------------------- throughput

export interface WeekBucket<T> {
	start: string;
	end: string;
	value: number;
	items: T[];
	/** The current, unfinished week. */
	partial: boolean;
}

/** Items closed per Monday-based week, oldest first. */
export function throughput<T extends ChartItem>(
	items: T[],
	categoryOf: CategoryOf,
	opts: { from: string; to: string; today: string; metric: Metric },
): { weeks: WeekBucket<T>[]; average: number | null } {
	const first = startOfWeek(opts.from);
	const last = startOfWeek(opts.to);
	const weeks: WeekBucket<T>[] = [];
	for (let w = first; w <= last; w = addDays(w, 7)) {
		const end = addDays(w, 6);
		weeks.push({ start: w, end, value: 0, items: [], partial: end >= opts.today && w <= opts.today });
	}
	for (const it of items) {
		if (!it.closed || categoryOf(it.status) !== "completed") continue;
		if (it.closed < first || it.closed > addDays(last, 6) || it.closed > opts.today) continue;
		const idx = Math.floor(daysBetween(first, it.closed) / 7);
		const wk = weeks[idx];
		if (!wk) continue;
		wk.value += measure(it, opts.metric);
		wk.items.push(it);
	}
	const full = weeks.filter((w) => !w.partial && w.start <= opts.today);
	const average = full.length ? full.reduce((s, w) => s + w.value, 0) / full.length : null;
	return { weeks, average };
}

// ---------------------------------------------------------------- cycle time & aging

export interface CyclePoint<T> {
	item: T;
	started: string;
	closed: string;
	/** Calendar days from started to closed; 0 for same-day items. */
	days: number;
}

export function cycleTimes<T extends ChartItem>(
	items: T[],
	categoryOf: CategoryOf,
	opts: { from: string; to: string },
): { points: CyclePoint<T>[]; p50: number | null; p85: number | null; median: number | null } {
	const points: CyclePoint<T>[] = [];
	for (const it of items) {
		if (!it.closed || categoryOf(it.status) !== "completed") continue;
		if (it.closed < opts.from || it.closed > opts.to) continue;
		const started = it.started ?? it.created ?? it.closed;
		const start = started > it.closed ? it.closed : started;
		points.push({ item: it, started: start, closed: it.closed, days: Math.max(0, daysBetween(start, it.closed)) });
	}
	points.sort((a, b) => a.closed.localeCompare(b.closed) || a.days - b.days);
	const days = points.map((p) => p.days);
	return { points, p50: percentile(days, 50), p85: percentile(days, 85), median: median(days) };
}

export interface AgingPoint<T> {
	item: T;
	status: string;
	started: string;
	/** Days since work started. */
	age: number;
}

/** Open items that have started (in progress or in review), oldest first. */
export function agingItems<T extends ChartItem>(items: T[], categoryOf: CategoryOf, today: string): AgingPoint<T>[] {
	const out: AgingPoint<T>[] = [];
	for (const it of items) {
		if (!WIP_CATEGORIES.has(categoryOf(it.status))) continue;
		const started = it.started ?? it.created ?? today;
		out.push({ item: it, status: it.status, started, age: Math.max(0, daysBetween(started, today)) });
	}
	return out.sort((a, b) => b.age - a.age);
}

// ---------------------------------------------------------------- current-state breakdowns

export interface StatusSlice<T> {
	status: StatusRef;
	count: number;
	points: number;
	items: T[];
}

/** Current items per status in board order; removed items are left out. */
export function statusBreakdown<T extends ChartItem>(items: T[], statuses: StatusRef[], categoryOf: CategoryOf): StatusSlice<T>[] {
	const live = statuses.filter((s) => s.category !== "removed");
	const slices = live.map((status) => ({ status, count: 0, points: 0, items: [] as T[] }));
	for (const it of items) {
		const cat = categoryOf(it.status);
		if (cat === "removed") continue;
		const b = bucketStatus(it.status, cat, live);
		if (!b) continue;
		const sl = slices[live.indexOf(b)];
		sl.count++;
		sl.points += it.points ?? 0;
		sl.items.push(it);
	}
	return slices;
}

export interface WorkloadRow<T> {
	/** Assignee key (person path or raw name); null for unassigned. */
	key: string | null;
	name: string;
	total: number;
	count: number;
	points: number;
	segments: { status: StatusRef; value: number; items: T[] }[];
}

/** Open work per assignee, split by status, heaviest first and unassigned last. */
export function workload<T extends ChartItem>(
	items: T[],
	statuses: StatusRef[],
	categoryOf: CategoryOf,
	assigneeOf: (item: T) => { key: string | null; name: string },
	metric: Metric,
): WorkloadRow<T>[] {
	const open = statuses.filter((s) => OPEN_CATEGORIES.has(s.category));
	const rows = new Map<string, WorkloadRow<T>>();
	for (const it of items) {
		const cat = categoryOf(it.status);
		if (!OPEN_CATEGORIES.has(cat)) continue;
		const b = bucketStatus(it.status, cat, open);
		if (!b) continue;
		const who = assigneeOf(it);
		const rk = who.key ?? "";
		let row = rows.get(rk);
		if (!row) {
			row = { key: who.key, name: who.name, total: 0, count: 0, points: 0, segments: open.map((status) => ({ status, value: 0, items: [] as T[] })) };
			rows.set(rk, row);
		}
		const seg = row.segments[open.indexOf(b)];
		const v = measure(it, metric);
		seg.value += v;
		seg.items.push(it);
		row.total += v;
		row.count++;
		row.points += it.points ?? 0;
	}
	return [...rows.values()].sort((a, b) => {
		if ((a.key === null) !== (b.key === null)) return a.key === null ? 1 : -1;
		return b.total - a.total || b.count - a.count || a.name.localeCompare(b.name);
	});
}

// ---------------------------------------------------------------- KPI tiles (ph-stats)

export type StatTileId = "open" | "in-progress" | "done-this-week" | "overdue" | "blocked" | "due-this-week" | "points-remaining" | "progress" | "cycle-time" | "velocity";

export const STAT_TILES: StatTileId[] = ["open", "in-progress", "done-this-week", "overdue", "blocked", "due-this-week", "points-remaining", "progress", "cycle-time", "velocity"];

export const DEFAULT_TILES: StatTileId[] = ["open", "in-progress", "overdue", "blocked", "done-this-week", "cycle-time"];

export interface TileOptions<T> {
	today: string;
	categoryOf: CategoryOf;
	/** True when an item is blocked (blocked status or an open blocker). */
	blockedOf?: (item: T) => boolean;
	/** Cycle-time window in days (default 30). */
	window?: number;
	/** Sprints for the velocity tile, oldest first. */
	sprints?: SprintRef[];
	stateAt?: StateAt<T>;
	member?: Member<T>;
}

export interface TileResult<T> {
	/** Value to display; null when there is nothing to measure yet. */
	value: number | null;
	unit: "count" | "days" | "percent" | "points";
	/** Context line rendered under the value. */
	context: string;
	/** Items the tile counts; opening the tile lists them. */
	items: T[];
}

/** One KPI tile of a ph-stats block. Pure, so tiles are unit-testable like the charts. */
export function statTile<T extends ChartItem>(tile: StatTileId, items: T[], opts: TileOptions<T>): TileResult<T> {
	const t = opts.today;
	const cat = opts.categoryOf;
	const live = items.filter((i) => cat(i.status) !== "removed");
	const open = live.filter((i) => OPEN_CATEGORIES.has(cat(i.status)));
	switch (tile) {
		case "open":
			return { value: open.length, unit: "count", context: `of ${plural(live.length, "item")} in scope`, items: open };
		case "in-progress":
			return openSummary(open.filter((i) => cat(i.status) === "inProgress"), open.length);
		case "done-this-week": {
			const from = addDays(t, -6);
			const done = live.filter((i) => cat(i.status) === "completed" && !!i.closed && i.closed >= from && i.closed <= t);
			return { value: done.length, unit: "count", context: "closed in the last 7 days", items: done };
		}
		case "overdue":
			return openSummary(open.filter((i) => !!i.due && i.due < t), open.length);
		case "blocked":
			return openSummary(open.filter((i) => opts.blockedOf?.(i) ?? false), open.length);
		case "due-this-week": {
			const until = addDays(t, 6);
			const soon = open.filter((i) => !!i.due && i.due >= t && i.due <= until);
			return { value: soon.length, unit: "count", context: "due in the next 7 days", items: soon };
		}
		case "points-remaining": {
			const pts = open.reduce((s, i) => s + (i.points ?? 0), 0);
			const all = live.reduce((s, i) => s + (i.points ?? 0), 0);
			return { value: pts, unit: "points", context: `of ${formatNumber(all, 1)} pts of work in scope`, items: open };
		}
		case "progress": {
			if (!live.length) return { value: null, unit: "percent", context: "no work in scope yet", items: [] };
			const done = live.filter((i) => cat(i.status) === "completed");
			const base = live.reduce((s, i) => s + (i.points ?? 0), 0);
			const value = base > 0 ? Math.round((done.reduce((s, i) => s + (i.points ?? 0), 0) / base) * 100) : Math.round((done.length / live.length) * 100);
			return { value, unit: "percent", context: `${done.length} of ${plural(live.length, "item")} done`, items: done };
		}
		case "cycle-time": {
			const window = Math.max(1, opts.window ?? 30);
			const ct = cycleTimes(items, cat, { from: addDays(t, -window), to: t });
			return {
				value: ct.median,
				unit: "days",
				context: ct.points.length ? `median of ${plural(ct.points.length, "item")} closed in ${window} days` : `nothing closed in ${window} days`,
				items: ct.points.map((p) => p.item),
			};
		}
		case "velocity": {
			const metric = chooseMetric(items, null);
			const unit = metric === "points" ? "points" : "count";
			if (!opts.sprints?.length || !opts.stateAt) return { value: null, unit, context: "no sprints started yet", items: [] };
			const v = velocity(items, opts.stateAt, opts.member ?? (() => true), opts.sprints, { today: t, metric });
			const rows = v.rows.slice(-3);
			const done = rows.flatMap((r) => r.items);
			const finished = rows.filter((r) => !r.current);
			if (!finished.length) return { value: null, unit, context: "no finished sprint yet", items: done };
			const avg = finished.reduce((s, r) => s + r.completed, 0) / finished.length;
			return { value: Math.round(avg * 10) / 10, unit, context: `average of ${plural(finished.length, "finished sprint")}`, items: done };
		}
	}
}

function openSummary<T>(found: T[], openCount: number): TileResult<T> {
	return { value: found.length, unit: "count", context: `of ${plural(openCount, "open item")}`, items: found };
}
