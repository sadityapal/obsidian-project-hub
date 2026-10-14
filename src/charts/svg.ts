import { setIcon } from "obsidian";
import type { Hub } from "../core/hub";
import { addDays, daysBetween, formatNumber, parseDate } from "../core/util";
import { noteLink, showTooltip } from "../ui/widgets";

// Small SVG toolkit for the charts: scales, ticks, axes, mark paths, hover layers and the
// figure frame (title, legend, responsive plot, table view).

export type Attrs = Record<string, string | number | null | undefined>;

export const FONT_PX = 11;
/** Hit targets are never smaller than this (interaction rule). */
export const HIT_PX = 24;
export const BAR_MAX = 24;
export const GAP = 2;
export const RADIUS = 4;

export function s<K extends keyof SVGElementTagNameMap>(parent: Element, tag: K, attrs: Attrs = {}, cls?: string): SVGElementTagNameMap[K] {
	const attr: Record<string, string | number> = {};
	for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined && !(typeof v === "number" && !isFinite(v))) attr[k] = v;
	return createSvg(tag, { attr, cls, parent });
}

export function text(parent: Element, x: number, y: number, value: string, cls = "", anchor: "start" | "middle" | "end" = "start"): SVGTextElement {
	const t = s(parent, "text", { x: r(x), y: r(y), "text-anchor": anchor }, cls || undefined);
	t.textContent = value;
	return t;
}

/** Rounds to half pixels so 1px hairlines land on the pixel grid. */
export function crisp(v: number): number {
	return Math.round(v) + 0.5;
}

function r(v: number): number {
	return Math.round(v * 10) / 10;
}

// ---------------------------------------------------------------- scales & ticks

export interface Linear {
	(v: number): number;
	invert(px: number): number;
}

export function linear(d0: number, d1: number, r0: number, r1: number): Linear {
	const span = d1 - d0 || 1;
	const f = ((v: number) => r0 + ((v - d0) / span) * (r1 - r0)) as Linear;
	f.invert = (px: number) => d0 + ((px - r0) / (r1 - r0 || 1)) * span;
	return f;
}

function niceStep(raw: number, integer: boolean): number {
	if (!(raw > 0)) return 1;
	const p = 10 ** Math.floor(Math.log10(raw));
	const f = raw / p;
	const m = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 && !integer ? 2.5 : f <= 5 ? 5 : 10;
	const step = m * p;
	return integer ? Math.max(1, Math.round(step)) : step;
}

/** Clean ticks from zero up to at least `max`. */
export function niceTicks(max: number, count = 4, integer = false): number[] {
	const top = max > 0 ? max : integer ? Math.max(1, count) : 1;
	const step = niceStep(top / Math.max(1, count), integer);
	const n = Math.max(1, Math.ceil(top / step - 1e-9));
	return Array.from({ length: n + 1 }, (_, i) => Math.round(i * step * 1e6) / 1e6);
}

export interface DateTick {
	date: string;
	label: string;
}

const MONTH = (d: Date) => d.toLocaleDateString(undefined, { month: "short" });

export function axisDate(date: string): string {
	const d = parseDate(date);
	return d ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : date;
}

export function longDate(date: string): string {
	const d = parseDate(date);
	if (!d) return date;
	const sameYear = d.getFullYear() === new Date().getFullYear();
	return d.toLocaleDateString(undefined, sameYear ? { weekday: "short", month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" });
}

/** Calendar-aligned date ticks that fit `px` pixels: days, Mondays, month starts or years. */
export function dateTicks(from: string, to: string, px: number): DateTick[] {
	const span = Math.max(1, daysBetween(from, to));
	const maxTicks = Math.max(2, Math.floor(px / 68));
	type Unit = "day" | "week" | "month" | "year";
	const options: [Unit, number, number][] = [
		["day", 1, 1],
		["day", 2, 2],
		["week", 1, 7],
		["week", 2, 14],
		["month", 1, 30.4],
		["month", 3, 91],
		["month", 6, 182],
		["year", 1, 365],
		["year", 5, 1826],
	];
	const [unit, step] = options.find(([, , days]) => span / days <= maxTicks) ?? ["year", 10];
	const out: DateTick[] = [];
	const push = (date: string, label: string) => {
		if (date >= from && date <= to) out.push({ date, label });
	};
	if (unit === "day") {
		for (let i = 0; i <= span; i += step) push(addDays(from, i), axisDate(addDays(from, i)));
	} else if (unit === "week") {
		const d = parseDate(from)!;
		let cur = addDays(from, (8 - d.getDay()) % 7);
		while (cur <= to) {
			push(cur, axisDate(cur));
			cur = addDays(cur, 7 * step);
		}
	} else if (unit === "month") {
		const d = parseDate(from)!;
		let y = d.getFullYear();
		let m = d.getMonth() + (d.getDate() > 1 ? 1 : 0);
		// Align quarter / half-year ticks to calendar boundaries.
		m = Math.ceil(m / step) * step;
		for (;;) {
			y += Math.floor(m / 12);
			m = m % 12;
			const date = new Date(y, m, 1);
			const iso = `${y}-${String(m + 1).padStart(2, "0")}-01`;
			if (iso > to) break;
			push(iso, m === 0 ? String(y) : MONTH(date));
			m += step;
		}
	} else {
		const y0 = parseDate(from)!.getFullYear();
		for (let y = Math.ceil(y0 / step) * step; `${y}-01-01` <= to; y += step) push(`${y}-01-01`, String(y));
	}
	return out;
}

// ---------------------------------------------------------------- text

let measureCtx: CanvasRenderingContext2D | null = null;
let measureFont = "";

export function textWidth(value: string, size = FONT_PX, weight = 400): number {
	if (!measureCtx) {
		measureCtx = document.createElement("canvas").getContext("2d");
		const family = getComputedStyle(document.body).getPropertyValue("--font-interface").trim() || getComputedStyle(document.body).fontFamily;
		measureFont = family || "sans-serif";
	}
	if (!measureCtx) return value.length * size * 0.6;
	measureCtx.font = `${weight} ${size}px ${measureFont}`;
	return measureCtx.measureText(value).width;
}

/** Shortens text with an ellipsis so it fits `max` pixels. */
export function fit(value: string, max: number, size = FONT_PX): string {
	if (textWidth(value, size) <= max) return value;
	if (max < textWidth("…", size) * 2) return "";
	let lo = 0;
	let hi = value.length;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (textWidth(value.slice(0, mid) + "…", size) <= max) lo = mid;
		else hi = mid - 1;
	}
	return value.slice(0, lo).trimEnd() + "…";
}

export function num(v: number | null | undefined, digits = 1): string {
	return formatNumber(v, digits);
}

// ---------------------------------------------------------------- geometry

export interface Plot {
	/** Left, right, top and bottom edges of the data area. */
	x0: number;
	x1: number;
	y0: number;
	y1: number;
}

export function plotOf(width: number, height: number, m: { left: number; right: number; top: number; bottom: number }): Plot {
	return { x0: m.left, x1: Math.max(m.left + 10, width - m.right), y0: m.top, y1: Math.max(m.top + 10, height - m.bottom) };
}

export function linePath(points: ([number, number] | null)[]): string {
	let d = "";
	let pen = false;
	for (const p of points) {
		if (!p) {
			pen = false;
			continue;
		}
		d += `${pen ? "L" : "M"}${r(p[0])},${r(p[1])}`;
		pen = true;
	}
	return d;
}

/** Closed band between an upper and a lower edge sampled at the same x positions. */
export function bandPath(xs: number[], top: number[], bottom: number[]): string {
	if (!xs.length) return "";
	let d = `M${r(xs[0])},${r(top[0])}`;
	for (let i = 1; i < xs.length; i++) d += `L${r(xs[i])},${r(top[i])}`;
	for (let i = xs.length - 1; i >= 0; i--) d += `L${r(xs[i])},${r(bottom[i])}`;
	return d + "Z";
}

/** Vertical column with a rounded data end and a square baseline. */
export function columnPath(x: number, w: number, base: number, top: number, radius = RADIUS): string {
	const h = base - top;
	if (h <= 0 || w <= 0) return "";
	const k = Math.min(radius, w / 2, h);
	return `M${r(x)},${r(base)}V${r(top + k)}Q${r(x)},${r(top)} ${r(x + k)},${r(top)}H${r(x + w - k)}Q${r(x + w)},${r(top)} ${r(x + w)},${r(top + k)}V${r(base)}Z`;
}

/** Horizontal bar from x0 to x1; only the far end is rounded when `round` is set. */
export function hbarPath(x0: number, x1: number, y: number, h: number, round: boolean, radius = RADIUS): string {
	const w = x1 - x0;
	if (w <= 0 || h <= 0) return "";
	const k = round ? Math.min(radius, h / 2, w) : 0;
	if (!k) return `M${r(x0)},${r(y)}H${r(x1)}V${r(y + h)}H${r(x0)}Z`;
	return `M${r(x0)},${r(y)}H${r(x1 - k)}Q${r(x1)},${r(y)} ${r(x1)},${r(y + k)}V${r(y + h - k)}Q${r(x1)},${r(y + h)} ${r(x1 - k)},${r(y + h)}H${r(x0)}Z`;
}

/** Deterministic 0..1 value for jittering dots without them moving between renders. */
export function jitter(key: string): number {
	let h = 2166136261;
	for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
	return ((h >>> 0) % 10000) / 10000;
}

// ---------------------------------------------------------------- axes

/** Horizontal gridlines + left tick labels for a value axis starting at zero. */
export function yAxis(svg: Element, plot: Plot, y: Linear, ticks: number[], fmt: (v: number) => string = (v) => num(v)): void {
	const g = s(svg, "g", {}, "ph-chart-axis");
	for (const t of ticks) {
		const py = crisp(y(t));
		if (t !== 0) s(g, "line", { x1: plot.x0, x2: plot.x1, y1: py, y2: py }, "ph-chart-grid");
		text(g, plot.x0 - 8, py + 3.5, fmt(t), "ph-chart-tick", "end");
	}
	baseline(svg, plot);
}

export function baseline(svg: Element, plot: Plot): void {
	const py = crisp(plot.y1);
	s(svg, "line", { x1: plot.x0, x2: plot.x1, y1: py, y2: py }, "ph-chart-baseline");
}

/** Width the y tick labels need, plus the gap to the plot. */
export function yLabelWidth(ticks: number[], fmt: (v: number) => string = (v) => num(v)): number {
	return Math.ceil(Math.max(12, ...ticks.map((t) => textWidth(fmt(t))))) + 12;
}

/** Date labels under the plot; labels at the edges anchor inward so they never clip. */
export function xDateAxis(svg: Element, plot: Plot, ticks: DateTick[], xOf: (date: string) => number, width: number): void {
	const g = s(svg, "g", {}, "ph-chart-axis");
	for (const t of ticks) {
		const x = xOf(t.date);
		const w = textWidth(t.label);
		const anchor = x - w / 2 < 2 ? "start" : x + w / 2 > width - 2 ? "end" : "middle";
		s(g, "line", { x1: crisp(x), x2: crisp(x), y1: plot.y1, y2: plot.y1 + 4 }, "ph-chart-tickmark");
		text(g, anchor === "start" ? Math.max(2, x - 4) : anchor === "end" ? Math.min(width - 2, x + 4) : x, plot.y1 + 17, t.label, "ph-chart-tick", anchor);
	}
}

/** Vertical marker (today, target) with a small label at the top of the plot. */
export function vMarker(svg: Element, plot: Plot, x: number, label: string, cls: string, width: number): void {
	if (x < plot.x0 - 0.5 || x > plot.x1 + 0.5) return;
	const g = s(svg, "g", {}, "ph-chart-marker " + cls);
	s(g, "line", { x1: crisp(x), x2: crisp(x), y1: plot.y0 - 2, y2: plot.y1 }, "ph-chart-marker-line");
	const w = textWidth(label);
	const anchor = x + 4 + w > width ? "end" : "start";
	text(g, anchor === "end" ? x - 4 : x + 4, plot.y0 + 8, label, "ph-chart-marker-label", anchor);
}

// ---------------------------------------------------------------- keys, legend & tooltip

/** Identity of a series: a palette colour name, or one of the neutral roles. */
export interface Key {
	shape: "line" | "dash" | "rect" | "ghost" | "dot" | "diamond";
	color?: string;
	role?: "guide" | "scope" | "muted";
}

export interface LegendItem {
	label: string;
	key: Key;
	value?: string;
	onClick?: () => void;
}

function keyEl(parent: HTMLElement, key: Key, cls: string): HTMLElement {
	const el = parent.createSpan({ cls: `${cls} is-${key.shape}` });
	if (key.color) el.dataset.phColor = key.color;
	if (key.role) el.addClass(`is-${key.role}`);
	return el;
}

export function legend(parent: HTMLElement, items: LegendItem[]): HTMLElement {
	const el = parent.createDiv({ cls: "ph-chart-legend" });
	el.setAttr("role", "list");
	for (const it of items) {
		const row = el.createDiv({ cls: "ph-chart-legend-item" });
		row.setAttr("role", "listitem");
		keyEl(row, it.key, "ph-chart-key");
		row.createSpan({ cls: "ph-chart-legend-label", text: it.label });
		if (it.value) row.createSpan({ cls: "ph-chart-legend-value", text: it.value });
		if (it.onClick) {
			const fn = it.onClick;
			row.addClass("is-clickable");
			row.tabIndex = 0;
			row.setAttr("role", "button");
			row.addEventListener("click", fn);
			row.addEventListener("keydown", (e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					fn();
				}
			});
		}
	}
	return el;
}

export interface TipRow {
	value: string;
	label: string;
	key?: Key;
}

/** Tooltip body: the value is strong and leads, the series name follows; rows keyed with line strokes. */
export function tip(el: HTMLElement, title: string, rows: TipRow[], footer?: string[]): void {
	el.addClass("ph-chart-tip");
	el.createDiv({ cls: "ph-tooltip-title", text: title });
	for (const row of rows) {
		const line = el.createDiv({ cls: "ph-chart-tip-row" });
		if (row.key) keyEl(line, { ...row.key, shape: row.key.shape === "dash" ? "dash" : row.key.shape === "diamond" ? "diamond" : "line" }, "ph-chart-tip-key");
		else line.createSpan({ cls: "ph-chart-tip-key is-none" });
		line.createSpan({ cls: "ph-chart-tip-value", text: row.value });
		line.createSpan({ cls: "ph-chart-tip-label", text: row.label });
	}
	for (const f of footer ?? []) el.createDiv({ cls: "ph-chart-tip-foot", text: f });
}

let tipOwner: Element | null = null;

function showTipAt(owner: Element, evt: MouseEvent, build: (el: HTMLElement) => void): void {
	tipOwner = owner;
	showTooltip(evt, build);
}

export function hideTip(owner?: Element): void {
	if (owner && tipOwner !== owner) return;
	tipOwner = null;
	showTooltip(null);
}

/** Mirrors the tooltip into the frame's live region so keyboard users hear it. */
function announce(owner: Element, build: (el: HTMLElement) => void): void {
	const live = owner.closest(".ph-chart")?.querySelector<HTMLElement>(".ph-chart-live");
	if (!live) return;
	const tmp = createDiv();
	build(tmp);
	live.setText(Array.from(tmp.querySelectorAll(".ph-tooltip-title, .ph-chart-tip-row, .ph-chart-tip-foot"), (n) => n.textContent?.replace(/\s+/g, " ").trim() ?? "").join(". "));
}

function pseudoEvent(svg: SVGSVGElement, x: number, y: number): MouseEvent {
	const box = svg.getBoundingClientRect();
	return new MouseEvent("mousemove", { clientX: box.left + x, clientY: box.top + y });
}

/**
 * Crosshair for x-indexed line/area charts: a hairline snaps to the nearest sample and one
 * tooltip lists every series there. Arrow keys move it when the plot has focus.
 */
export function crosshair(
	svg: SVGSVGElement,
	plot: Plot,
	xs: number[],
	opts: {
		dots: (i: number) => { y: number; key: Key }[];
		tip: (i: number, el: HTMLElement) => void;
		/** Index the keyboard starts at (defaults to the last sample). */
		start?: number;
	},
): void {
	if (!xs.length) return;
	const layer = s(svg, "g", {}, "ph-chart-hover");
	layer.setAttr("visibility", "hidden");
	const line = s(layer, "line", { y1: plot.y0, y2: plot.y1 }, "ph-chart-crosshair");
	const dots = s(layer, "g");
	const hit = s(svg, "rect", { x: plot.x0 - 6, y: plot.y0, width: plot.x1 - plot.x0 + 12, height: plot.y1 - plot.y0 }, "ph-chart-hit");
	let cur = -1;
	const place = (i: number) => {
		cur = i;
		const x = crisp(xs[i]);
		line.setAttr("x1", x);
		line.setAttr("x2", x);
		dots.empty();
		for (const d of opts.dots(i)) {
			if (!isFinite(d.y)) continue;
			const c = s(dots, "circle", { cx: xs[i], cy: d.y, r: 4 }, "ph-chart-dot");
			if (d.key.color) c.dataset.phColor = d.key.color;
			if (d.key.role) c.addClass(`is-${d.key.role}`);
		}
		layer.setAttr("visibility", "visible");
	};
	const nearest = (px: number) => {
		let lo = 0;
		let hi = xs.length - 1;
		while (hi - lo > 1) {
			const mid = (lo + hi) >> 1;
			if (xs[mid] < px) lo = mid;
			else hi = mid;
		}
		return Math.abs(xs[lo] - px) <= Math.abs(xs[hi] - px) ? lo : hi;
	};
	const hide = () => {
		layer.setAttr("visibility", "hidden");
		hideTip(svg);
	};
	hit.addEventListener("pointermove", (e) => {
		const box = svg.getBoundingClientRect();
		const i = nearest(e.clientX - box.left);
		place(i);
		showTipAt(svg, e, (el) => opts.tip(i, el));
	});
	hit.addEventListener("pointerleave", hide);
	keyboard(svg, xs.length, () => (cur < 0 ? opts.start ?? xs.length - 1 : cur), (i) => {
		place(i);
		const build = (el: HTMLElement) => opts.tip(i, el);
		showTipAt(svg, pseudoEvent(svg, xs[i], plot.y0 + 12), build);
		announce(svg, build);
	}, hide);
}

function keyboard(svg: SVGSVGElement, n: number, current: () => number, show: (i: number) => void, hide: () => void, activate?: (i: number) => void): void {
	svg.setAttr("tabindex", 0);
	svg.addClass("is-focusable");
	let idx = -1;
	svg.addEventListener("focus", () => {
		idx = Math.max(0, Math.min(n - 1, current()));
		show(idx);
	});
	svg.addEventListener("blur", hide);
	svg.addEventListener("keydown", (e) => {
		let next = idx;
		if (e.key === "ArrowRight" || e.key === "ArrowDown") next = Math.min(n - 1, idx + 1);
		else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = Math.max(0, idx - 1);
		else if (e.key === "Home") next = 0;
		else if (e.key === "End") next = n - 1;
		else if ((e.key === "Enter" || e.key === " ") && activate && idx >= 0) {
			e.preventDefault();
			activate(idx);
			return;
		} else if (e.key === "Escape") {
			hide();
			return;
		} else return;
		e.preventDefault();
		idx = next;
		show(idx);
	});
}

export interface DotPoint {
	x: number;
	y: number;
}

/**
 * Nearest-point hover for scatter plots: the pointer only has to be closest (within
 * HIT_PX), never dead-centre on an 8px dot. Arrow keys walk the points in x order.
 */
export function nearestHover<T extends DotPoint>(
	svg: SVGSVGElement,
	plot: Plot,
	points: T[],
	opts: { tip: (p: T, same: T[], el: HTMLElement) => void; onClick?: (p: T) => void; key: (p: T) => Key },
): void {
	if (!points.length) return;
	const order = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
	const layer = s(svg, "g", {}, "ph-chart-hover");
	const hit = s(svg, "rect", { x: plot.x0 - HIT_PX / 2, y: plot.y0 - HIT_PX / 2, width: plot.x1 - plot.x0 + HIT_PX, height: plot.y1 - plot.y0 + HIT_PX }, "ph-chart-hit");
	let active: T | null = null;
	const ring = (p: T) => {
		layer.empty();
		const k = opts.key(p);
		const c = s(layer, "circle", { cx: p.x, cy: p.y, r: 6 }, "ph-chart-dot is-active");
		if (k.color) c.dataset.phColor = k.color;
	};
	const near = (x: number, y: number): T | null => {
		let best: T | null = null;
		let bd = (HIT_PX / 2 + 4) ** 2;
		for (const p of points) {
			const d = (p.x - x) ** 2 + (p.y - y) ** 2;
			if (d < bd) {
				bd = d;
				best = p;
			}
		}
		return best;
	};
	const same = (p: T) => points.filter((q) => Math.abs(q.x - p.x) < 3 && Math.abs(q.y - p.y) < 3);
	const hide = () => {
		active = null;
		layer.empty();
		hit.removeClass("is-pointer");
		hideTip(svg);
	};
	hit.addEventListener("pointermove", (e) => {
		const box = svg.getBoundingClientRect();
		const p = near(e.clientX - box.left, e.clientY - box.top);
		if (!p) return hide();
		active = p;
		ring(p);
		hit.toggleClass("is-pointer", !!opts.onClick);
		showTipAt(svg, e, (el) => opts.tip(p, same(p), el));
	});
	hit.addEventListener("pointerleave", hide);
	if (opts.onClick) {
		const click = opts.onClick;
		hit.addEventListener("click", () => {
			if (active) click(active);
		});
	}
	let kIdx = -1;
	keyboard(
		svg,
		order.length,
		() => (kIdx < 0 ? 0 : kIdx),
		(i) => {
			kIdx = i;
			const p = order[i];
			active = p;
			ring(p);
			const build = (el: HTMLElement) => opts.tip(p, same(p), el);
			showTipAt(svg, pseudoEvent(svg, p.x, p.y), build);
			announce(svg, build);
		},
		hide,
		opts.onClick ? (i) => opts.onClick!(order[i]) : undefined,
	);
}

/**
 * Per-mark hover for bars and segments. `hit` should cover the mark plus its gap; it is
 * focusable, shows the same tooltip on focus and runs `onClick` on click / Enter.
 */
export function markHover(svg: SVGSVGElement, hit: SVGElement, mark: SVGElement | null, label: string, build: (el: HTMLElement) => void, onClick?: () => void): void {
	hit.addClass("ph-chart-hit");
	hit.setAttr("tabindex", 0);
	hit.setAttr("role", onClick ? "button" : "img");
	hit.setAttr("aria-label", label);
	if (onClick) hit.addClass("is-pointer");
	const on = () => mark?.addClass("is-active");
	const off = () => {
		mark?.removeClass("is-active");
		hideTip(svg);
	};
	hit.addEventListener("pointermove", (e) => {
		on();
		showTipAt(svg, e, build);
	});
	hit.addEventListener("pointerleave", off);
	hit.addEventListener("focus", () => {
		on();
		const box = hit.getBoundingClientRect();
		showTipAt(svg, new MouseEvent("mousemove", { clientX: box.left + box.width / 2, clientY: box.top + Math.min(box.height / 2, 12) }), build);
		announce(svg, build);
	});
	hit.addEventListener("blur", off);
	if (onClick) {
		hit.addEventListener("click", (e) => {
			e.stopPropagation();
			onClick();
		});
		hit.addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				onClick();
			}
		});
	}
}

// ---------------------------------------------------------------- frame

export type Cell = string | number | null | { text: string; path?: string; num?: boolean };

export interface TableSpec {
	columns: { label: string; num?: boolean }[];
	rows: Cell[][];
	caption?: string;
}

export interface ChartSpec {
	title: string;
	subtitle?: string;
	/** Headline stats rendered above the plot (status chips, totals). */
	headline?: (el: HTMLElement) => void;
	legend?: LegendItem[];
	/** Full SVG height including the x-axis band. */
	height: number;
	/** One-sentence summary for screen readers. */
	summary: string;
	draw(svg: SVGSVGElement, width: number, height: number): void;
	table: TableSpec;
	note?: string;
}

/** View state that survives live re-renders of the same block. */
export interface FrameState {
	table: boolean;
}

/** Registers teardown for the current render (observers, tooltips). */
export type Track = (cleanup: () => void) => void;

export function renderFrame(hub: Hub, parent: HTMLElement, spec: ChartSpec, state: FrameState, track: Track): HTMLElement {
	const fig = parent.createDiv({ cls: "ph-chart" });
	fig.setAttr("role", "figure");
	fig.setAttr("aria-label", spec.title);
	const head = fig.createDiv({ cls: "ph-chart-head" });
	const titles = head.createDiv({ cls: "ph-chart-titles" });
	titles.createDiv({ cls: "ph-chart-title", text: spec.title });
	if (spec.subtitle) titles.createDiv({ cls: "ph-chart-subtitle", text: spec.subtitle });
	const toggle = head.createEl("button", { cls: "ph-chart-toggle" });
	const icon = toggle.createSpan();
	const label = toggle.createSpan();
	if (spec.headline) spec.headline(fig.createDiv({ cls: "ph-chart-headline" }));
	const body = fig.createDiv({ cls: "ph-chart-body" });
	const live = fig.createDiv({ cls: "ph-chart-live" });
	live.setAttr("aria-live", "polite");

	const chartView = body.createDiv({ cls: "ph-chart-view" });
	if (spec.legend && spec.legend.length) legend(chartView, spec.legend);
	const plotEl = chartView.createDiv({ cls: "ph-chart-plot" });
	plotEl.style.height = `${spec.height}px`;
	const tableView = body.createDiv({ cls: "ph-chart-table-wrap" });
	let tableBuilt = false;

	const sync = () => {
		toggle.setAttr("aria-pressed", String(state.table));
		toggle.setAttr("aria-label", state.table ? "Show chart" : "Show the numbers as a table");
		setIcon(icon, state.table ? "chart-line" : "table-2");
		label.setText(state.table ? "Chart" : "Table");
		chartView.toggle(!state.table);
		tableView.toggle(state.table);
		if (state.table && !tableBuilt) {
			tableBuilt = true;
			renderTable(hub, tableView, spec.table);
		}
	};
	toggle.addEventListener("click", () => {
		state.table = !state.table;
		hideTip();
		sync();
		if (!state.table) draw(true);
	});

	let lastWidth = -1;
	const draw = (force = false) => {
		const width = Math.floor(plotEl.clientWidth);
		if (width <= 0 || (!force && width === lastWidth)) return;
		lastWidth = width;
		hideTip();
		plotEl.empty();
		const svg = plotEl.createSvg("svg", {
			cls: "ph-chart-svg",
			attr: { width, height: spec.height, viewBox: `0 0 ${width} ${spec.height}`, role: "img", "aria-label": `${spec.summary} Use arrow keys to inspect values, or open the table view.` },
		});
		try {
			spec.draw(svg, width, spec.height);
		} catch (e) {
			console.error("Project Hub: chart draw failed", e);
			plotEl.empty();
			plotEl.createDiv({ cls: "ph-error", text: `Could not draw chart: ${e instanceof Error ? e.message : String(e)}` });
		}
	};
	// The block renders detached first, so the plot learns its width once it is attached.
	const ro = new ResizeObserver(() => {
		if (!state.table) draw();
	});
	ro.observe(plotEl);
	track(() => {
		ro.disconnect();
		const svg = plotEl.querySelector("svg");
		if (svg) hideTip(svg);
	});
	sync();
	if (spec.note) fig.createDiv({ cls: "ph-chart-note", text: spec.note });
	return fig;
}

function renderTable(hub: Hub, parent: HTMLElement, spec: TableSpec): void {
	const scroll = parent.createDiv({ cls: "ph-chart-table-scroll" });
	const table = scroll.createEl("table", { cls: "ph-chart-table" });
	if (spec.caption) table.createEl("caption", { text: spec.caption });
	const tr = table.createEl("thead").createEl("tr");
	for (const c of spec.columns) tr.createEl("th", { text: c.label, cls: c.num ? "is-num" : "", attr: { scope: "col" } });
	const tbody = table.createEl("tbody");
	if (!spec.rows.length) {
		tbody.createEl("tr").createEl("td", { text: "No data", cls: "ph-muted", attr: { colspan: spec.columns.length } });
		return;
	}
	for (const row of spec.rows) {
		const r = tbody.createEl("tr");
		row.forEach((cell, i) => {
			const col = spec.columns[i];
			const td = r.createEl(i === 0 ? "th" : "td", { cls: col?.num ? "is-num" : "" });
			if (i === 0) td.setAttr("scope", "row");
			if (cell === null || cell === undefined) td.setText("–");
			else if (typeof cell === "number") td.setText(num(cell));
			else if (typeof cell === "string") td.setText(cell);
			else if (cell.path) noteLink(hub, td, cell.path, cell.text);
			else td.setText(cell.text);
		});
	}
}

/** Empty state in the chart's place; returns the message box so callers can add an action. */
export function emptyState(parent: HTMLElement, title: string, message: string, icon = "chart-line"): HTMLElement {
	const el = parent.createDiv({ cls: "ph-chart ph-chart-empty" });
	const head = el.createDiv({ cls: "ph-chart-head" });
	head.createDiv({ cls: "ph-chart-titles" }).createDiv({ cls: "ph-chart-title", text: title });
	const body = el.createDiv({ cls: "ph-empty" });
	setIcon(body.createDiv({ cls: "ph-chart-empty-icon" }), icon);
	body.createDiv({ cls: "ph-chart-empty-text", text: message });
	return body;
}
