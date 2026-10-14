import { App, Menu, TFile, setIcon, setTooltip } from "obsidian";
import type { Hub } from "../core/hub";
import { P, PRIORITIES, WorkItem } from "../core/model";
import { formatNumber, parseDate, today } from "../core/util";

// Shared rendering primitives. Every view uses these so items look the same everywhere.

export function statusPill(hub: Hub, parent: HTMLElement, status: string, opts: { onClick?: (evt: MouseEvent) => void } = {}): HTMLElement {
	const def = hub.store.statusDef(status);
	const el = parent.createSpan({ cls: "ph-status", text: status });
	el.dataset.phColor = def?.color ?? "gray";
	if (opts.onClick) {
		el.addClass("is-clickable");
		el.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			opts.onClick!(e);
		});
	}
	return el;
}

export function priorityBadge(parent: HTMLElement, priority: number | null, opts: { onClick?: (evt: MouseEvent) => void } = {}): HTMLElement {
	const def = PRIORITIES.find((p) => p.value === priority);
	const el = parent.createSpan({ cls: "ph-priority" });
	el.dataset.priority = String(priority ?? "");
	const icon = el.createSpan();
	setIcon(icon, priority === 1 ? "chevrons-up" : priority === 2 ? "chevron-up" : priority === 4 ? "chevron-down" : "equal");
	el.createSpan({ text: def ? def.label : "–" });
	setTooltip(el, def ? `Priority ${def.label} · ${def.name}` : "No priority");
	if (opts.onClick) {
		el.addClass("is-clickable");
		el.style.cursor = "pointer";
		el.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			opts.onClick!(e);
		});
	}
	return el;
}

export function typeBadge(hub: Hub, parent: HTMLElement, type: string, showLabel = true): HTMLElement {
	const el = parent.createSpan({ cls: "ph-type" });
	el.dataset.type = type.toLowerCase();
	setIcon(el.createSpan(), hub.store.typeIcon(type));
	if (showLabel) el.createSpan({ text: type });
	else setTooltip(el, type);
	return el;
}

const AVATAR_COLORS = ["blue", "orange", "aqua", "violet", "magenta", "green", "red", "yellow"];

export function initials(name: string): string {
	const clean = name.replace(/\(.*?\)/g, " ").trim();
	const parts = clean.split(/\s+/).filter(Boolean);
	if (!parts.length) return "?";
	if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
	return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function colorFor(name: string): string {
	let h = 0;
	for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
	return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export function avatar(parent: HTMLElement, name: string | null, size = 22): HTMLElement {
	const el = parent.createSpan({ cls: "ph-avatar" });
	if (size !== 22) {
		el.style.width = el.style.height = `${size}px`;
		el.style.fontSize = `${Math.round(size * 0.45)}px`;
	}
	if (!name) {
		el.addClass("is-empty");
		setIcon(el, "user");
		setTooltip(el, "Unassigned");
		return el;
	}
	el.dataset.phColor = colorFor(name);
	el.setText(initials(name));
	setTooltip(el, name);
	return el;
}

export function personLabel(hub: Hub, parent: HTMLElement, path: string | null, opts: { onClick?: (evt: MouseEvent) => void; showName?: boolean } = {}): HTMLElement {
	const name = path ? hub.store.displayName(path) : null;
	const el = parent.createSpan({ cls: "ph-person" });
	avatar(el, name);
	if (opts.showName !== false) el.createSpan({ text: name ?? "Unassigned", cls: name ? "" : "ph-faint" });
	if (opts.onClick) {
		el.style.cursor = "pointer";
		el.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			opts.onClick!(e);
		});
	}
	return el;
}

export function progressBar(parent: HTMLElement, pct: number, opts: { label?: boolean; width?: string; color?: string } = {}): HTMLElement {
	const wrap = parent.createDiv({ cls: "ph-progress-wrap" });
	wrap.style.display = "flex";
	wrap.style.alignItems = "center";
	wrap.style.gap = "8px";
	const bar = wrap.createDiv({ cls: "ph-progress" });
	if (opts.width) bar.style.width = opts.width;
	else bar.style.flex = "1";
	if (opts.color) bar.dataset.phColor = opts.color;
	const v = Math.max(0, Math.min(100, Math.round(pct)));
	bar.createDiv({ cls: "ph-progress-fill" }).style.width = `${v}%`;
	bar.setAttr("role", "progressbar");
	bar.setAttr("aria-valuenow", String(v));
	bar.setAttr("aria-valuemin", "0");
	bar.setAttr("aria-valuemax", "100");
	if (opts.label !== false) wrap.createSpan({ cls: "ph-progress-label", text: `${v}%` });
	return wrap;
}

export function chip(parent: HTMLElement, text: string, opts: { icon?: string; cls?: string; tooltip?: string; onClick?: (evt: MouseEvent) => void } = {}): HTMLElement {
	const el = parent.createSpan({ cls: "ph-chip" + (opts.cls ? " " + opts.cls : "") });
	if (opts.icon) setIcon(el.createSpan(), opts.icon);
	el.createSpan({ text });
	if (opts.tooltip) setTooltip(el, opts.tooltip);
	if (opts.onClick) {
		el.addClass("is-clickable");
		el.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			opts.onClick!(e);
		});
	}
	return el;
}

/** Due date chip; turns warning when due within 2 days and critical when overdue. */
export function dueChip(hub: Hub, parent: HTMLElement, item: WorkItem, onClick?: (evt: MouseEvent) => void): HTMLElement | null {
	if (!item.due) {
		if (!onClick) return null;
		return chip(parent, "No due date", { icon: "calendar", cls: "ph-faint", onClick });
	}
	const t = today();
	const done = hub.store.isDone(item);
	let cls = "";
	let tip = `Due ${item.due}`;
	if (!done && item.due < t) {
		cls = "is-critical";
		tip += " · overdue";
	} else if (!done && daysUntil(item.due) <= 2) {
		cls = "is-warning";
		tip += " · due soon";
	}
	return chip(parent, shortDate(item.due), { icon: cls === "is-critical" ? "alarm-clock-off" : "calendar", cls, tooltip: tip, onClick });
}

export function daysUntil(date: string): number {
	const d = parseDate(date);
	const n = parseDate(today());
	if (!d || !n) return Infinity;
	return Math.round((d.getTime() - n.getTime()) / 86_400_000);
}

export function shortDate(date: string | null): string {
	if (!date) return "";
	const d = parseDate(date);
	if (!d) return date;
	const sameYear = d.getFullYear() === new Date().getFullYear();
	return d.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" });
}

export function pointsChip(parent: HTMLElement, points: number | null): HTMLElement | null {
	if (points === null) return null;
	return chip(parent, formatNumber(points, 1), { icon: "gauge", tooltip: `${points} points` });
}

/** Link-like span that opens the note; Ctrl/Cmd-click opens in a new tab. Hover shows page preview. */
export function noteLink(hub: Hub, parent: HTMLElement, path: string, text?: string, cls = ""): HTMLElement {
	const el = parent.createEl("a", { cls: "internal-link ph-link " + cls, text: text ?? hub.store.displayName(path) });
	el.dataset.href = path;
	el.setAttr("href", path);
	el.addEventListener("click", (e) => {
		e.preventDefault();
		e.stopPropagation();
		void hub.openPath(path, e.ctrlKey || e.metaKey);
	});
	el.addEventListener("mouseover", (e) => {
		hub.app.workspace.trigger("hover-link", { event: e, source: "project-hub", hoverParent: parent, targetEl: el, linktext: path, sourcePath: "" });
	});
	return el;
}

// ---------------------------------------------------------------- menus

export function statusMenu(hub: Hub, evt: MouseEvent, items: WorkItem[]): void {
	const menu = new Menu();
	for (const s of hub.settings.statuses) {
		menu.addItem((mi) => {
			mi.setTitle(s.name)
				.setChecked(items.length === 1 && items[0].status === s.name)
				.onClick(async () => {
					for (const it of items) await hub.store.setStatus(it.path, s.name);
				});
			const dom = (mi as unknown as { dom?: HTMLElement }).dom;
			dom?.addClass("ph-status-menu-item");
			if (dom) dom.dataset.phColor = s.color;
		});
	}
	menu.showAtMouseEvent(evt);
}

export function priorityMenu(hub: Hub, evt: MouseEvent, items: WorkItem[]): void {
	const menu = new Menu();
	for (const p of PRIORITIES) {
		menu.addItem((mi) =>
			mi
				.setTitle(`${p.label} · ${p.name}`)
				.setIcon(p.value === 1 ? "chevrons-up" : p.value === 2 ? "chevron-up" : p.value === 4 ? "chevron-down" : "equal")
				.setChecked(items.length === 1 && items[0].priority === p.value)
				.onClick(async () => {
					for (const it of items) await hub.store.update(it.path, { [P.priority]: p.value });
				}),
		);
	}
	menu.addSeparator();
	menu.addItem((mi) =>
		mi
			.setTitle("Clear")
			.setIcon("x")
			.onClick(async () => {
				for (const it of items) await hub.store.update(it.path, { [P.priority]: null });
			}),
	);
	menu.showAtMouseEvent(evt);
}

export function typeMenu(hub: Hub, evt: MouseEvent, items: WorkItem[]): void {
	const menu = new Menu();
	for (const t of hub.settings.types) {
		menu.addItem((mi) =>
			mi
				.setTitle(t.name)
				.setIcon(t.icon)
				.setChecked(items.length === 1 && items[0].type === t.name)
				.onClick(async () => {
					for (const it of items) await hub.store.update(it.path, { [P.type]: t.name });
				}),
		);
	}
	menu.showAtMouseEvent(evt);
}

/** Opens a file for a path; small wrapper used by pickers. */
export function fileOf(app: App, path: string): TFile | null {
	return app.vault.getFileByPath(path);
}

// ---------------------------------------------------------------- tooltip

let tipEl: HTMLElement | null = null;

/** Floating tooltip for charts/timeline. Pass null to hide. */
export function showTooltip(evt: MouseEvent | null, build?: (el: HTMLElement) => void): void {
	if (!evt || !build) {
		tipEl?.remove();
		tipEl = null;
		return;
	}
	if (!tipEl) tipEl = document.body.createDiv({ cls: "ph-tooltip" });
	tipEl.empty();
	build(tipEl);
	const pad = 14;
	const rect = tipEl.getBoundingClientRect();
	let x = evt.clientX + pad;
	let y = evt.clientY + pad;
	if (x + rect.width > window.innerWidth - 8) x = evt.clientX - rect.width - pad;
	if (y + rect.height > window.innerHeight - 8) y = evt.clientY - rect.height - pad;
	tipEl.style.left = `${Math.max(8, x)}px`;
	tipEl.style.top = `${Math.max(8, y)}px`;
}

export function tooltipRows(el: HTMLElement, title: string, rows: [string, string][]): void {
	el.createDiv({ cls: "ph-tooltip-title", text: title });
	for (const [k, v] of rows) {
		const r = el.createDiv({ cls: "ph-tooltip-row" });
		r.createSpan({ text: k, cls: "ph-muted" });
		r.createSpan({ text: v });
	}
}
