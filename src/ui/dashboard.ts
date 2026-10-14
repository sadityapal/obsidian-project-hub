// The "ph-dashboard" code block: configurable widget panels for Home notes and
// dashboards (my work, due soon, projects, sprint, activity…).

import { Notice, parseYaml, setIcon, setTooltip } from "obsidian";
import type { Hub } from "../core/hub";
import type { WorkItem } from "../core/model";
import { dueChip, noteLink, personLabel, priorityBadge, progressBar, shortDate, statusMenu, statusPill, typeBadge } from "./widgets";
import { registerLiveBlock } from "./live";
import { NewSprintModal, relTime } from "./modals";
import type { NewItemOptions } from "../core/store";
import { addDays, daysBetween, parseWikilink, today } from "../core/util";

// ---------------------------------------------------------------- activity feed

interface ActivityEntry {
	path: string;
	id: string;
	title: string;
	from: string | null;
	to: string;
	at: number;
}

class ActivityFeed {
	private entries: ActivityEntry[] = [];
	private saveQueued = false;

	constructor(private hub: Hub) {
		hub.plugin.registerEvent(
			hub.store.on("item-status", (...data: unknown[]) => {
				const item = data[0] as WorkItem;
				this.push(item, (data[1] as string | null) ?? null);
			}),
		);
		void this.load();
	}

	private push(item: WorkItem, from: string | null): void {
		this.entries.unshift({ path: item.path, id: item.id, title: item.title, from, to: item.status, at: Date.now() });
		if (this.entries.length > 200) this.entries.length = 200;
		this.saveSoon();
	}

	private async load(): Promise<void> {
		try {
			const file = `${this.hub.pluginDir}/activity.json`;
			if (await this.hub.app.vault.adapter.exists(file)) {
				const parsed: unknown = JSON.parse(await this.hub.app.vault.adapter.read(file));
				if (Array.isArray(parsed)) this.entries = parsed.filter(isActivityEntry).slice(0, 200);
			}
		} catch (e) {
			console.error("Project Hub: could not read the activity feed", e);
		}
	}

	private saveSoon(): void {
		if (this.saveQueued) return;
		this.saveQueued = true;
		window.setTimeout(() => {
			this.saveQueued = false;
			void this.hub.app.vault.adapter.write(`${this.hub.pluginDir}/activity.json`, JSON.stringify(this.entries)).catch((e) => {
				console.error("Project Hub: could not write the activity feed", e);
			});
		}, 2000);
	}

	recent(limit: number): ActivityEntry[] {
		return this.entries.slice(0, limit);
	}
}

function isActivityEntry(v: unknown): v is ActivityEntry {
	const e = v as ActivityEntry;
	return !!e && typeof e.path === "string" && typeof e.to === "string" && typeof e.at === "number";
}

const feeds = new WeakMap<Hub, ActivityFeed>();

// ---------------------------------------------------------------- config

interface DashCfg {
	widget: string;
	limit: number;
	limitSet: boolean;
	project?: unknown;
	sprint?: unknown;
	assignee?: unknown;
}

function parseConfig(source: string): DashCfg {
	const raw = (parseYaml(source) ?? {}) as Record<string, unknown>;
	const widget = typeof raw.widget === "string" ? raw.widget.trim() : "";
	const limitSet = typeof raw.limit === "number" && raw.limit > 0;
	const limit = limitSet ? Math.min(100, Math.floor(raw.limit as number)) : 10;
	return { widget, limit, limitSet, project: raw.project, sprint: raw.sprint, assignee: raw.assignee };
}

interface Scope {
	project: string | null;
	sprint: string | null;
	assignee: string | null;
}

/** Resolves project/sprint/assignee scope values ("this", "me", "[[Name]]", path). */
function scopeOf(hub: Hub, cfg: DashCfg, sourcePath: string): Scope {
	const entity = hub.store.getEntity(sourcePath);
	const resolve = (key: keyof Scope, value: unknown): string | null => {
		if (value === undefined || value === null || value === "") return null;
		const raw = String(value).trim();
		const rel = (): string | null => {
			if (!entity) return null;
			if (key === "project") return entity.kind === "project" ? entity.path : entity.kind === "work-item" ? hub.store.effectiveProject(entity) : null;
			if (key === "sprint") return entity.kind === "sprint" ? entity.path : entity.kind === "work-item" ? entity.sprint : null;
			return entity.kind === "person" ? entity.path : entity.kind === "work-item" ? entity.assignee : null;
		};
		if (raw === "this") return rel();
		if (raw === "me") return hub.store.mePath();
		const linkpath = (parseWikilink(raw)?.path ?? raw).trim();
		return hub.app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath)?.path ?? null;
	};
	return { project: resolve("project", cfg.project), sprint: resolve("sprint", cfg.sprint), assignee: resolve("assignee", cfg.assignee) };
}

function inScope(hub: Hub, item: WorkItem, scope: Scope): boolean {
	if (scope.project && hub.store.effectiveProject(item) !== scope.project) return false;
	if (scope.sprint && item.sprint !== scope.sprint) return false;
	if (scope.assignee && item.assignee !== scope.assignee) return false;
	return true;
}

function openItems(hub: Hub): WorkItem[] {
	return hub.store.allItems().filter((i) => !hub.store.isDone(i));
}

// ---------------------------------------------------------------- widgets

interface WidgetDef {
	title: string;
	icon: string;
	render: (hub: Hub, body: HTMLElement, cfg: DashCfg, sourcePath: string) => number | null;
}

interface RowOpts {
	right?: (row: HTMLElement, item: WorkItem) => void;
	showProject?: boolean;
}

function widgetRow(hub: Hub, host: HTMLElement, item: WorkItem, opts: RowOpts = {}): void {
	const row = host.createDiv({ cls: "ph-widget-row" });
	const done = row.createSpan({ cls: "ph-widget-done" });
	setIcon(done, "circle-check");
	setTooltip(done, "Mark done");
	done.addEventListener("click", (e) => {
		e.stopPropagation();
		void hub.store.setStatus(item.path, hub.store.statusFor("completed")).catch((err: unknown) => {
			new Notice(err instanceof Error ? err.message : String(err));
		});
	});
	typeBadge(hub, row, item.type, false);
	row.createSpan({ cls: "ph-id", text: item.id });
	noteLink(hub, row, item.path, item.title);
	statusPill(hub, row, item.status, { onClick: (e) => statusMenu(hub, e, [item]) });
	priorityBadge(row, item.priority);
	dueChip(hub, row, item);
	if (opts.showProject) {
		const projectPath = hub.store.effectiveProject(item);
		if (projectPath) row.createSpan({ cls: "ph-faint ph-widget-crumb", text: hub.store.displayName(projectPath) });
	}
	opts.right?.(row, item);
	row.addEventListener("click", (e) => {
		if ((e.target as HTMLElement).closest("a, .ph-status, .ph-priority, .ph-widget-done, .ph-chip")) return;
		void hub.openPath(item.path, e.ctrlKey || e.metaKey);
	});
}

function sortByUrgency(a: WorkItem, b: WorkItem): number {
	return (a.priority ?? 9) - (b.priority ?? 9) || (a.due ?? "9999").localeCompare(b.due ?? "9999") || a.id.localeCompare(b.id);
}

function renderMyWork(hub: Hub, body: HTMLElement, cfg: DashCfg, sourcePath: string): number | null {
	const scope = scopeOf(hub, cfg, sourcePath);
	const me = scope.assignee ?? hub.store.mePath();
	if (!me) {
		body.createDiv({ cls: "ph-empty", text: 'Set "me" in the plugin settings (or assign: me) to see your work.' });
		return null;
	}
	const items = openItems(hub).filter((i) => i.assignee === me && inScope(hub, i, scope));
	if (!items.length) {
		body.createDiv({ cls: "ph-empty", text: "Nothing on your plate. Take an item from the board or create one." });
		const btn = body.createEl("button", { cls: "ph-btn mod-cta", text: "New work item" });
		setIcon(btn, "plus");
		btn.addEventListener("click", () => hub.newItem({ assignee: me }));
		return 0;
	}
	const groups: { title: string; items: WorkItem[]; collapsed: boolean }[] = [
		{ title: "In progress", items: items.filter((i) => ["inProgress", "resolved"].includes(hub.store.statusCategory(i.status))), collapsed: false },
		{ title: "To Do", items: items.filter((i) => hub.store.statusCategory(i.status) === "proposed" && !!i.sprint), collapsed: false },
		{ title: "Backlog", items: items.filter((i) => hub.store.statusCategory(i.status) === "proposed" && !i.sprint), collapsed: true },
	];
	for (const g of groups) {
		if (!g.items.length) continue;
		const det = body.createEl("details", { cls: "ph-widget-group" });
		if (!g.collapsed) det.setAttr("open", "");
		det.createEl("summary", { text: `${g.title} · ${g.items.length}` });
		for (const item of [...g.items].sort(sortByUrgency)) widgetRow(hub, det, item, { showProject: true });
	}
	return items.length;
}

function renderDueSoon(hub: Hub, body: HTMLElement, cfg: DashCfg, sourcePath: string): number {
	const scope = scopeOf(hub, cfg, sourcePath);
	const until = addDays(today(), 7);
	const items = openItems(hub)
		.filter((i) => inScope(hub, i, scope) && i.due && i.due <= until)
		.sort((a, b) => (a.due ?? "").localeCompare(b.due ?? ""));
	if (!items.length) {
		body.createDiv({ cls: "ph-empty", text: "Nothing due in the next 7 days." });
		return 0;
	}
	for (const item of items) {
		widgetRow(hub, body, item, {
			right: (row) => {
				if (!item.due) return;
				const d = daysBetween(today(), item.due);
				row.createSpan({ cls: "ph-faint", text: d === 0 ? "due today" : d > 0 ? `in ${d}d` : `${-d}d late` });
			},
		});
	}
	return items.length;
}

function renderOverdue(hub: Hub, body: HTMLElement, cfg: DashCfg, sourcePath: string): number {
	const scope = scopeOf(hub, cfg, sourcePath);
	const items = openItems(hub)
		.filter((i) => inScope(hub, i, scope) && hub.store.isOverdue(i))
		.sort((a, b) => (a.due ?? "").localeCompare(b.due ?? ""));
	if (!items.length) {
		body.createDiv({ cls: "ph-empty", text: "Nothing overdue. Nice." });
		return 0;
	}
	for (const item of items) widgetRow(hub, body, item);
	return items.length;
}

function renderRecent(hub: Hub, body: HTMLElement, cfg: DashCfg, sourcePath: string): number {
	const scope = scopeOf(hub, cfg, sourcePath);
	const items = hub.store
		.allItems()
		.filter((i) => inScope(hub, i, scope))
		.sort((a, b) => b.mtime - a.mtime)
		.slice(0, cfg.limit);
	if (!items.length) {
		body.createDiv({ cls: "ph-empty", text: "No work items yet." });
		return 0;
	}
	for (const item of items) {
		widgetRow(hub, body, item, {
			right: (row) => row.createSpan({ cls: "ph-faint", text: relTime(item.mtime) }),
		});
	}
	return items.length;
}

function renderBlocked(hub: Hub, body: HTMLElement, cfg: DashCfg, sourcePath: string): number {
	const scope = scopeOf(hub, cfg, sourcePath);
	const items = openItems(hub)
		.filter((i) => inScope(hub, i, scope) && hub.store.isBlocked(i))
		.sort(sortByUrgency);
	if (!items.length) {
		body.createDiv({ cls: "ph-empty", text: "Nothing blocked." });
		return 0;
	}
	for (const item of items) widgetRow(hub, body, item);
	return items.length;
}

function renderUnassigned(hub: Hub, body: HTMLElement, cfg: DashCfg, sourcePath: string): number {
	const scope = scopeOf(hub, cfg, sourcePath);
	const items = openItems(hub)
		.filter((i) => inScope(hub, i, scope) && !i.assignee)
		.sort(sortByUrgency);
	if (!items.length) {
		body.createDiv({ cls: "ph-empty", text: "Every open item has an assignee." });
		return 0;
	}
	for (const item of items) widgetRow(hub, body, item);
	return items.length;
}

function renderProjects(hub: Hub, body: HTMLElement): number {
	const projects = [...hub.store.projects.values()]
		.filter((p) => p.status === "Active" || p.status === "Planning")
		.sort((a, b) => (a.status === "Active" ? -1 : b.status === "Active" ? 1 : a.name.localeCompare(b.name)));
	if (!projects.length) {
		body.createDiv({ cls: "ph-empty", text: "No active projects. Create one to get started." });
		return 0;
	}
	const cards = body.createDiv({ cls: "ph-widget-cards" });
	for (const p of projects) {
		const card = cards.createDiv({ cls: "ph-widget-card" });
		card.addEventListener("click", (e) => {
			if ((e.target as HTMLElement).closest("a, button")) return;
			void hub.openPath(p.path);
		});
		const title = card.createDiv({ cls: "ph-widget-card-title" });
		noteLink(hub, title, p.path, p.name);
		const meta = card.createDiv({ cls: "ph-widget-card-meta" });
		const health = p.health ?? "On Track";
		const healthIcon = health === "On Track" ? "circle-check" : health === "At Risk" ? "triangle-alert" : "octagon-alert";
		const healthCls = health === "On Track" ? "is-good" : health === "At Risk" ? "is-warning" : "is-critical";
		const h = meta.createSpan({ cls: "ph-chip " + healthCls });
		setIcon(h.createSpan(), healthIcon);
		h.createSpan({ text: health });
		meta.createSpan({ cls: "ph-chip", text: p.status });
		personLabel(hub, meta, p.owner, { showName: false });
		const open = hub.store.projectItems(p.path).filter((i) => !hub.store.isDone(i));
		const blocked = open.filter((i) => hub.store.isBlocked(i));
		const overdue = open.filter((i) => hub.store.isOverdue(i));
		const r = hub.store.rollup(p.path);
		progressBar(card, r.progress, { label: false });
		const stats = card.createDiv({ cls: "ph-widget-card-stats" });
		stats.createSpan({ text: `${r.done}/${r.total} done` });
		if (blocked.length) stats.createSpan({ cls: "is-critical", text: `${blocked.length} blocked` });
		if (overdue.length) stats.createSpan({ cls: "is-critical", text: `${overdue.length} overdue` });
		if (p.target) {
			const d = daysBetween(today(), p.target);
			stats.createSpan({ cls: "ph-faint", text: `${shortDate(p.target)} · ${d < 0 ? `${-d}d overdue` : `${d}d left`}` });
		}
	}
	return projects.length;
}

function renderSprint(hub: Hub, body: HTMLElement): number | null {
	const sprint = hub.store.currentSprint();
	if (!sprint) {
		body.createDiv({ cls: "ph-empty", text: "No current sprint. Create one to plan work in iterations." });
		const btn = body.createEl("button", { cls: "ph-btn mod-cta", text: "Create sprint" });
		setIcon(btn, "plus");
		btn.addEventListener("click", () => new NewSprintModal(hub).open());
		return null;
	}
	const card = body.createDiv({ cls: "ph-widget-card" });
	const title = card.createDiv({ cls: "ph-widget-card-title" });
	noteLink(hub, title, sprint.path, sprint.name);
	const meta = card.createDiv({ cls: "ph-widget-card-meta" });
	meta.createSpan({ cls: "ph-chip", text: sprint.start && sprint.end ? `${shortDate(sprint.start)} → ${shortDate(sprint.end)}` : "No dates" });
	if (sprint.state === "Current" && sprint.start && sprint.end) {
		const day = daysBetween(sprint.start, today()) + 1;
		meta.createSpan({ cls: "ph-chip", text: `Day ${day} of ${daysBetween(sprint.start, sprint.end) + 1}` });
	}
	const items = hub.store.sprintItems(sprint.path);
	const r = hub.store.rollup(sprint.path);
	progressBar(card, r.progress, { label: false });
	card.createDiv({ cls: "ph-muted", text: `${r.done}/${r.total} done · ${r.pointsDone}/${r.points} pts` });
	if (items.length) distributionBar(hub, card, items);
	const open = body.createDiv({ cls: "ph-widget-actions" });
	const btn = open.createEl("button", { cls: "ph-btn", text: "Open sprint" });
	btn.addEventListener("click", () => void hub.openPath(sprint.path));
	return items.length;
}

function renderActivity(hub: Hub, body: HTMLElement, cfg: DashCfg): number | null {
	const feed = feeds.get(hub);
	const entries = feed?.recent(cfg.limitSet ? cfg.limit : 20) ?? [];
	if (!entries.length) {
		body.createDiv({ cls: "ph-empty", text: "Status changes show up here as you work." });
		return null;
	}
	for (const e of entries) {
		const row = body.createDiv({ cls: "ph-widget-row ph-activity-row" });
		const id = row.createSpan({ cls: "ph-id", text: e.id });
		id.addEventListener("click", (ev) => {
			ev.stopPropagation();
			void hub.openPath(e.path);
		});
		row.createSpan({ text: e.from ? `${e.from} → ${e.to}` : e.to });
		row.createSpan({ cls: "ph-faint", text: relTime(e.at) });
	}
	return null;
}

function distributionBar(hub: Hub, host: HTMLElement, items: WorkItem[]): void {
	const counts = new Map<string, number>();
	for (const i of items) counts.set(i.status, (counts.get(i.status) ?? 0) + 1);
	const total = items.length || 1;
	const bar = host.createDiv({ cls: "ph-dist" });
	const legend = host.createDiv({ cls: "ph-legend" });
	for (const s of hub.settings.statuses) {
		const n = counts.get(s.name) ?? 0;
		if (!n) continue;
		const seg = bar.createDiv({ cls: "ph-dist-seg" });
		seg.style.width = `${(n / total) * 100}%`;
		seg.dataset.phColor = s.color;
		setTooltip(seg, `${s.name}: ${n}`);
		const item = legend.createSpan({ cls: "ph-legend-item" });
		item.dataset.phColor = s.color;
		item.createSpan({ cls: "ph-legend-dot" });
		item.createSpan({ text: `${s.name} ${n}` });
	}
}

const WIDGETS: Record<string, WidgetDef> = {
	"my-work": { title: "My work", icon: "list-checks", render: renderMyWork },
	"due-soon": { title: "Due soon", icon: "calendar-days", render: renderDueSoon },
	overdue: { title: "Overdue", icon: "alarm-clock-off", render: renderOverdue },
	recent: { title: "Recently modified", icon: "history", render: renderRecent },
	projects: { title: "Projects", icon: "folder", render: renderProjects },
	sprint: { title: "Current sprint", icon: "target", render: renderSprint },
	blocked: { title: "Blocked", icon: "octagon-x", render: renderBlocked },
	unassigned: { title: "Unassigned", icon: "user-plus", render: renderUnassigned },
	activity: { title: "Activity", icon: "activity", render: renderActivity },
};

// ---------------------------------------------------------------- block

function newItemDefaults(hub: Hub, sourcePath: string): Partial<NewItemOptions> {
	const e = hub.store.getEntity(sourcePath);
	if (!e) return {};
	switch (e.kind) {
		case "project":
			return { project: e.path };
		case "sprint":
			return { sprint: e.path };
		case "person":
			return { assignee: e.path };
		default:
			return {};
	}
}

function renderDashboard(hub: Hub, source: string, el: HTMLElement, sourcePath: string): void {
	const cfg = parseConfig(source);
	const def = WIDGETS[cfg.widget];
	if (!def) {
		el.createDiv({
			cls: "ph-error",
			text: `Unknown ph-dashboard widget "${cfg.widget || "(none)"}". Available: ${Object.keys(WIDGETS).join(", ")}.`,
		});
		return;
	}
	const root = el.createDiv({ cls: "ph-widget" });
	const head = root.createDiv({ cls: "ph-widget-head" });
	setIcon(head.createSpan({ cls: "ph-widget-icon" }), def.icon);
	head.createSpan({ cls: "ph-widget-title", text: def.title });
	const plus = head.createSpan({ cls: "ph-icon-btn ph-widget-action" });
	setIcon(plus, "plus");
	setTooltip(plus, "New work item");
	plus.addEventListener("click", () => hub.newItem(newItemDefaults(hub, sourcePath)));
	const body = root.createDiv({ cls: "ph-widget-body" });
	const count = def.render(hub, body, cfg, sourcePath);
	if (count !== null && count > 0) head.createSpan({ cls: "ph-widget-count", text: String(count) });
}

export function registerDashboard(hub: Hub): void {
	if (!feeds.has(hub)) feeds.set(hub, new ActivityFeed(hub));
	registerLiveBlock(hub, "ph-dashboard", (source, el, ctx) => renderDashboard(hub, source, el, ctx.sourcePath));
}
