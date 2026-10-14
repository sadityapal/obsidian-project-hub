import { Modal, parseYaml, setIcon, setTooltip } from "obsidian";
import type { Hub } from "../core/hub";
import type { WorkItem } from "../core/model";
import { formatNumber, today } from "../core/util";
import { LiveBlock, registerLiveBlock } from "../ui/live";
import { dueChip, noteLink, personLabel, statusPill } from "../ui/widgets";
import {
	categoryFn,
	ChartEnv,
	ConfigError,
	ItemRow,
	OpenItems,
	Scope,
	checkKeys,
	memberFn,
	parseChartConfig,
	parseScopeSpec,
	renderChart,
	resolveScope,
	scopedItems,
	scopeLabel,
	stateFn,
} from "./charts";
import { DEFAULT_TILES, STAT_TILES, StatTileId, TileResult, statTile } from "./data";
import type { FrameState, Track } from "./svg";

// Code blocks: ```ph-chart draws a chart, ```ph-stats draws the KPI tile row.

export function registerCharts(hub: Hub): void {
	registerLiveBlock(hub, "ph-chart", (source, el, ctx, block) => renderChartBlock(hub, source, el, ctx.sourcePath, block));
	registerLiveBlock(hub, "ph-stats", (source, el, ctx) => renderStatsBlock(hub, source, el, ctx.sourcePath));
}

// ---------------------------------------------------------------- ph-chart

/** Per code-block state: the chart/table frame and the running render's teardown callbacks. */
interface BlockState {
	frame: FrameState;
	cleanups: (() => void)[];
	unloadRegistered: boolean;
}

const blockStates = new WeakMap<LiveBlock, BlockState>();

function stateOf(block: LiveBlock): BlockState {
	let state = blockStates.get(block);
	if (!state) blockStates.set(block, (state = { frame: { table: false }, cleanups: [], unloadRegistered: false }));
	return state;
}

function renderChartBlock(hub: Hub, source: string, el: HTMLElement, sourcePath: string, block: LiveBlock): void {
	const state = stateOf(block);
	// A live re-render replaces the DOM, so tear down the previous render's observers first.
	for (const cleanup of state.cleanups) cleanup();
	state.cleanups = [];
	if (!state.unloadRegistered) {
		state.unloadRegistered = true;
		block.register(() => {
			for (const cleanup of state.cleanups) cleanup();
			state.cleanups = [];
		});
	}
	const track: Track = (cleanup) => state.cleanups.push(cleanup);
	try {
		const cfg = parseChartConfig(parseYaml(source), today());
		const scope = resolveScope(hub, cfg, sourcePath);
		const env: ChartEnv = { hub, cfg, scope, today: today(), state: state.frame, track, openItems: openItems(hub) };
		renderChart(env, el);
	} catch (e) {
		chartError(el, e);
	}
}

function chartError(el: HTMLElement, e: unknown): void {
	if (e instanceof ConfigError) {
		el.createDiv({ cls: "ph-error", text: `Project Hub chart: ${e.message}` });
		return;
	}
	console.error("Project Hub: ph-chart failed", e);
	el.createDiv({ cls: "ph-error", text: `Project Hub chart could not be drawn: ${e instanceof Error ? e.message : String(e)}` });
}

// ---------------------------------------------------------------- ph-stats

const STAT_KEYS = ["tiles", "project", "sprint", "assignee", "scope"];

const TILE_LABELS: Record<StatTileId, string> = {
	open: "Open",
	"in-progress": "In progress",
	"done-this-week": "Done this week",
	overdue: "Overdue",
	blocked: "Blocked",
	"due-this-week": "Due this week",
	"points-remaining": "Points remaining",
	progress: "Progress",
	"cycle-time": "Cycle time",
	velocity: "Velocity",
};

const TILE_ICONS: Record<StatTileId, string> = {
	open: "circle-dot",
	"in-progress": "play",
	"done-this-week": "circle-check",
	overdue: "alarm-clock",
	blocked: "octagon-x",
	"due-this-week": "calendar-clock",
	"points-remaining": "gauge",
	progress: "target",
	"cycle-time": "timer",
	velocity: "chart-column",
};

const TILE_ALIASES: Record<string, StatTileId> = {
	wip: "in-progress",
	inprogress: "in-progress",
	"in_progress": "in-progress",
	done: "done-this-week",
	"done-week": "done-this-week",
	due: "due-this-week",
	"due-week": "due-this-week",
	points: "points-remaining",
	"points-left": "points-remaining",
	cycle_time: "cycle-time",
	cycletime: "cycle-time",
};

function parseTiles(value: unknown): StatTileId[] {
	if (value === null || value === undefined || value === "") return [...DEFAULT_TILES];
	// "tiles: open, overdue" parses as one YAML scalar; a block list or [a, b] parses as an array.
	const list = Array.isArray(value) ? value : String(value).split(",");
	const out: StatTileId[] = [];
	for (const v of list) {
		const key = String(v).trim().toLowerCase().replace(/\s+/g, "-");
		if (!key) continue;
		const tile = (STAT_TILES as readonly string[]).includes(key) ? (key as StatTileId) : TILE_ALIASES[key];
		if (!tile) throw new ConfigError(`Unknown tile "${String(v).trim()}". Tiles: ${STAT_TILES.join(", ")}.`);
		if (!out.includes(tile)) out.push(tile);
	}
	return out.length ? out : [...DEFAULT_TILES];
}

function renderStatsBlock(hub: Hub, source: string, el: HTMLElement, sourcePath: string): void {
	let raw: unknown;
	try {
		raw = parseYaml(source);
	} catch (e) {
		el.createDiv({ cls: "ph-error", text: `Project Hub stats: this block is not valid YAML (${e instanceof Error ? e.message : String(e)}).` });
		return;
	}
	try {
		const o = (raw ?? {}) as Record<string, unknown>;
		if (typeof o !== "object" || Array.isArray(o)) {
			throw new ConfigError(`Write the tiles as "key: value" lines, for example "tiles: open, overdue" or "tiles:\n  - open".`);
		}
		checkKeys(o, STAT_KEYS);
		const scope = resolveScope(hub, parseScopeSpec(o), sourcePath);
		renderStats(hub, el, scope, parseTiles(o.tiles));
	} catch (e) {
		if (e instanceof ConfigError) {
			el.createDiv({ cls: "ph-error", text: `Project Hub stats: ${e.message}` });
			return;
		}
		console.error("Project Hub: ph-stats failed", e);
		el.createDiv({ cls: "ph-error", text: `Project Hub stats could not be drawn: ${e instanceof Error ? e.message : String(e)}` });
	}
}

function renderStats(hub: Hub, el: HTMLElement, scope: Scope, tiles: StatTileId[]): void {
	const t = today();
	const items = scopedItems(hub, scope);
	const wrap = el.createDiv({ cls: "ph-stats" });
	const label = scopeLabel(scope);
	if (label) wrap.createDiv({ cls: "ph-stats-scope", text: label });
	if (!items.length) {
		const msg = scope.missingSprint
			? `${scope.missingSprint} Create one with "Project Hub: New sprint".`
			: `No work items in scope${label ? ` (${label})` : ""}. Tiles appear once work items exist.`;
		wrap.createDiv({ cls: "ph-empty", text: msg });
		return;
	}
	const catOf = categoryFn(hub);
	const ctx = { today: t, categoryOf: catOf, blockedOf: (it: WorkItem) => hub.store.isBlocked(it) };
	const grid = wrap.createDiv({ cls: "ph-stats-grid" });
	for (const tile of tiles) {
		const result = tileResult(hub, tile, items, scope, ctx, t);
		renderTile(hub, grid, tile, result, label);
	}
}

function tileResult(
	hub: Hub,
	tile: StatTileId,
	items: WorkItem[],
	scope: Scope,
	ctx: { today: string; categoryOf: ReturnType<typeof categoryFn>; blockedOf: (item: WorkItem) => boolean },
	t: string,
): TileResult<WorkItem> {
	if (tile !== "velocity") return statTile(tile, items, ctx);
	const sprints = hub.store
		.sortedSprints()
		.filter((sp) => sp.start && sp.end)
		.map((sp) => ({ key: sp.basename, name: sp.name, path: sp.path, start: sp.start!, end: sp.end! }));
	if (!sprints.length) return statTile("velocity", items, ctx);
	return statTile("velocity", items, { ...ctx, sprints, stateAt: stateFn(hub), member: memberFn(scope) });
}

type Tone = "good" | "warning" | "serious" | "critical";

function tileTone(tile: StatTileId, r: TileResult<WorkItem>): Tone | null {
	const v = r.value ?? 0;
	if (tile === "overdue") return v > 0 ? "critical" : "good";
	if (tile === "blocked") return v > 0 ? "warning" : "good";
	if (tile === "progress") return r.value === null ? null : v >= 80 ? "good" : v >= 50 ? "warning" : "serious";
	return null;
}

function tileValue(r: TileResult<WorkItem>): string {
	if (r.value === null) return "–";
	if (r.unit === "percent") return `${formatNumber(Math.round(r.value))}%`;
	if (r.unit === "count") return formatNumber(r.value);
	return formatNumber(r.value, 1);
}

function renderTile(hub: Hub, grid: HTMLElement, tile: StatTileId, r: TileResult<WorkItem>, scopeCaption: string): void {
	const tone = tileTone(tile, r);
	const clickable = r.items.length > 0;
	const el = grid.createDiv({ cls: `ph-tile${tone ? ` is-${tone}` : ""}${clickable ? " is-clickable" : ""}` });
	if (clickable) {
		el.setAttr("role", "button");
		el.tabIndex = 0;
		const rows: ItemRow[] = r.items.map((item) => ({ item }));
		const title = TILE_LABELS[tile] + (scopeCaption ? ` · ${scopeCaption}` : "");
		const open = () => new ItemListModal(hub, title, rows).open();
		el.addEventListener("click", open);
		el.addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				open();
			}
		});
	}
	const head = el.createDiv({ cls: "ph-tile-head" });
	setIcon(head.createSpan({ cls: "ph-tile-icon" }), TILE_ICONS[tile]);
	head.createSpan({ cls: "ph-tile-label", text: TILE_LABELS[tile] });
	el.createDiv({ cls: "ph-tile-value", text: tileValue(r) });
	el.createDiv({ cls: "ph-tile-context", text: r.context });
	setTooltip(el, clickable ? `${r.context} · click to list the items` : r.context);
}

// ---------------------------------------------------------------- item list modal

/** Lists the items behind a chart mark or KPI tile; used by ph-chart and ph-stats alike. */
export class ItemListModal extends Modal {
	private rows: ItemRow[];

	constructor(
		private hub: Hub,
		title: string,
		rows: ItemRow[],
	) {
		super(hub.app);
		this.rows = rows;
		this.setTitle(title);
	}

	onOpen(): void {
		this.modalEl.addClass("ph-chart-modal");
		this.contentEl.addClass("ph-chart-modal-content");
		if (!this.rows.length) {
			this.contentEl.createDiv({ cls: "ph-empty", text: "No items match this." });
			return;
		}
		this.contentEl.createDiv({ cls: "ph-chart-modal-count", text: `${this.rows.length} ${this.rows.length === 1 ? "item" : "items"}` });
		const list = this.contentEl.createDiv({ cls: "ph-chart-modal-list" });
		for (const row of this.rows) {
			const r = list.createDiv({ cls: "ph-chart-modal-row" });
			const main = r.createDiv({ cls: "ph-chart-modal-main" });
			noteLink(this.hub, main, row.item.path, row.item.id ? `${row.item.id} ${row.item.title}` : row.item.title);
			if (row.detail) main.createDiv({ cls: "ph-chart-modal-detail", text: row.detail });
			const meta = r.createDiv({ cls: "ph-chart-modal-meta" });
			statusPill(this.hub, meta, row.item.status);
			personLabel(this.hub, meta, row.item.assignee);
			dueChip(this.hub, meta, row.item);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

function openItems(hub: Hub): OpenItems {
	return (title, rows) => new ItemListModal(hub, title, rows).open();
}
