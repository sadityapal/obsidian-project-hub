// The "My work" sidebar view: a personal work queue with drag-to-update sections.

import { ItemView, Notice, setIcon, setTooltip } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import type { Hub } from "../core/hub";
import { P, type WorkItem } from "../core/model";
import { dueChip, noteLink, priorityBadge, statusMenu, statusPill, typeBadge } from "./widgets";
import { relTime } from "./modals";
import { addDays, today } from "../core/util";

export const MY_WORK_VIEW = "ph-my-work";
const OPENED_KEY = "ph-my-work-opened";

export function registerMyWork(hub: Hub): void {
	hub.plugin.registerView(MY_WORK_VIEW, (leaf) => new MyWorkView(hub, leaf));
	hub.plugin.addCommand({ id: "open-my-work", name: "Open My work", callback: () => void openMyWork(hub) });
}

/** Reveals the My work view, opening it in the right sidebar when it is not open yet. */
export async function openMyWork(hub: Hub): Promise<void> {
	const existing = hub.app.workspace.getLeavesOfType(MY_WORK_VIEW);
	if (existing.length) {
		await hub.app.workspace.revealLeaf(existing[0]);
		return;
	}
	const leaf = hub.app.workspace.getRightLeaf(false);
	if (!leaf) return;
	await leaf.setViewState({ type: MY_WORK_VIEW });
	await hub.app.workspace.revealLeaf(leaf);
}

/** Opens the sidebar the first time the plugin runs; later runs only reveal it. */
export async function activateMyWork(hub: Hub): Promise<void> {
	if (hub.app.workspace.getLeavesOfType(MY_WORK_VIEW).length) {
		await openMyWork(hub);
		return;
	}
	if (openedBefore()) return;
	markOpened();
	await openMyWork(hub);
}

function openedBefore(): boolean {
	try {
		return window.localStorage.getItem(OPENED_KEY) === "1";
	} catch {
		// localStorage can throw in private modes; treat as already opened.
		return true;
	}
}

function markOpened(): void {
	try {
		window.localStorage.setItem(OPENED_KEY, "1");
	} catch {
		// ignore
	}
}

type SectionKey = "today" | "progress" | "next" | "done";

const SECTIONS: { key: SectionKey; title: string; icon: string; hint: string; empty: string }[] = [
	{ key: "today", title: "Today", icon: "calendar-check", hint: "Due today or overdue", empty: "Nothing due today." },
	{ key: "progress", title: "In progress", icon: "circle-dot", hint: "Items being worked on", empty: "Drag something here to start it." },
	{ key: "next", title: "Up next", icon: "list", hint: "To Do in the current sprint", empty: "Drag something here to schedule it." },
	{ key: "done", title: "Recently done", icon: "circle-check", hint: "Closed in the last 7 days", empty: "Drag something here to close it." },
];

function byDue(a: WorkItem, b: WorkItem): number {
	return (a.due ?? "9999").localeCompare(b.due ?? "9999") || a.id.localeCompare(b.id);
}

function byPriority(a: WorkItem, b: WorkItem): number {
	return (a.priority ?? 9) - (b.priority ?? 9) || (a.due ?? "9999").localeCompare(b.due ?? "9999") || a.id.localeCompare(b.id);
}

class MyWorkView extends ItemView {
	private rootEl: HTMLElement | null = null;
	private collapsed = new Set<SectionKey>();
	private dragPath: string | null = null;
	private renderTimer: number | null = null;

	constructor(private hub: Hub, leaf: WorkspaceLeaf) {
		super(leaf);
		this.icon = "list-checks";
		this.navigation = false;
	}

	getViewType(): string {
		return MY_WORK_VIEW;
	}

	getDisplayText(): string {
		return "My work";
	}

	protected async onOpen(): Promise<void> {
		this.rootEl = this.contentEl.createDiv({ cls: "ph-mywork" });
		this.registerEvent(this.hub.store.on("changed", () => this.renderSoon()));
		this.register(this.hub.sync.onState(() => this.renderSoon()));
		this.render();
	}

	protected async onClose(): Promise<void> {
		this.rootEl = null;
	}

	private renderSoon(): void {
		if (this.renderTimer !== null) return;
		this.renderTimer = window.setTimeout(() => {
			this.renderTimer = null;
			this.render();
		}, 120);
	}

	private itemsFor(key: SectionKey): WorkItem[] {
		const store = this.hub.store;
		const me = store.mePath();
		const mine = store.allItems().filter((i) => !me || i.assignee === me);
		switch (key) {
			case "today":
				return mine.filter((i) => !store.isDone(i) && (store.isOverdue(i) || i.due === today())).sort(byDue);
			case "progress":
				return mine.filter((i) => ["inProgress", "resolved"].includes(store.statusCategory(i.status))).sort(byPriority);
			case "next": {
				const cur = store.currentSprint();
				return mine
					.filter((i) => store.statusCategory(i.status) === "proposed" && (cur ? i.sprint === cur.path : !!i.sprint))
					.sort(byPriority);
			}
			case "done":
				return mine
					.filter((i) => store.isDone(i) && !!i.closed && i.closed >= addDays(today(), -7))
					.sort((a, b) => (b.closed ?? "").localeCompare(a.closed ?? ""));
		}
	}

	private render(): void {
		const root = this.rootEl;
		if (!root) return;
		root.empty();

		const head = root.createDiv({ cls: "ph-mywork-head" });
		head.createSpan({ cls: "ph-mywork-title", text: "My work" });
		const actions = head.createDiv({ cls: "ph-mywork-actions" });

		const sync = this.hub.sync;
		if (sync.enabled) {
			const state = head.createSpan({ cls: "ph-mywork-sync" });
			if (sync.running) {
				state.addClass("is-busy");
				setIcon(state.createSpan(), "refresh-cw");
				state.createSpan({ text: "Syncing…" });
			} else if (sync.lastError) {
				state.addClass("is-critical");
				setIcon(state.createSpan(), "triangle-alert");
				state.createSpan({ text: "Sync error" });
				setTooltip(state, sync.lastError);
			} else if (sync.lastSync) {
				setIcon(state.createSpan(), "cloud");
				state.createSpan({ text: `Synced ${relTime(sync.lastSync)}` });
			} else {
				setIcon(state.createSpan(), "cloud-off");
				state.createSpan({ text: "Not synced" });
			}
			const syncBtn = actions.createSpan({ cls: "ph-icon-btn" });
			setIcon(syncBtn, "refresh-cw");
			setTooltip(syncBtn, "Sync with Azure DevOps now");
			syncBtn.addEventListener("click", () => {
				void this.hub.sync.syncNow();
			});
		}

		const me = this.hub.store.mePath();
		const newBtn = actions.createSpan({ cls: "ph-icon-btn" });
		setIcon(newBtn, "plus");
		setTooltip(newBtn, "New work item for you");
		newBtn.addEventListener("click", () => this.hub.newItem(me ? { assignee: me } : {}));

		const body = root.createDiv({ cls: "ph-mywork-body" });
		for (const section of SECTIONS) {
			const items = this.itemsFor(section.key);
			const isCollapsed = this.collapsed.has(section.key);
			const sec = body.createDiv({ cls: "ph-mywork-section" + (isCollapsed ? " is-collapsed" : "") });

			const titleEl = sec.createDiv({ cls: "ph-mywork-section-title" });
			setIcon(titleEl.createSpan({ cls: "ph-mywork-chevron" }), isCollapsed ? "chevron-right" : "chevron-down");
			setIcon(titleEl.createSpan(), section.icon);
			titleEl.createSpan({ text: section.title });
			titleEl.createSpan({ cls: "ph-mywork-count", text: String(items.length) });
			setTooltip(titleEl, section.hint);
			titleEl.addEventListener("click", () => {
				if (this.collapsed.has(section.key)) this.collapsed.delete(section.key);
				else this.collapsed.add(section.key);
				this.render();
			});

			if (isCollapsed) continue;

			const list = sec.createDiv({ cls: "ph-mywork-list" });
			sec.addEventListener("dragover", (e) => {
				e.preventDefault();
				sec.addClass("is-drop");
			});
			sec.addEventListener("dragleave", () => sec.removeClass("is-drop"));
			sec.addEventListener("drop", (e) => {
				e.preventDefault();
				sec.removeClass("is-drop");
				this.drop(section.key);
			});

			if (!items.length) {
				list.createDiv({ cls: "ph-empty", text: section.empty });
				continue;
			}
			for (const item of items) this.row(list, item);
		}
	}

	private row(host: HTMLElement, item: WorkItem): void {
		const hub = this.hub;
		const row = host.createDiv({ cls: "ph-mywork-row" });
		row.setAttr("draggable", "true");
		row.addEventListener("dragstart", (e) => {
			this.dragPath = item.path;
			e.dataTransfer?.setData("text/plain", item.path);
			if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
		});
		row.addEventListener("dragend", () => {
			this.dragPath = null;
		});
		row.addEventListener("click", (e) => {
			if ((e.target as HTMLElement).closest("a, .ph-status, .ph-priority, .ph-mywork-done")) return;
			void hub.openPath(item.path, e.ctrlKey || e.metaKey);
		});
		typeBadge(hub, row, item.type, false);
		row.createSpan({ cls: "ph-id", text: item.id });
		noteLink(hub, row, item.path, item.title);
		statusPill(hub, row, item.status, { onClick: (e) => statusMenu(hub, e, [item]) });
		priorityBadge(row, item.priority);
		dueChip(hub, row, item);
		const done = row.createSpan({ cls: "ph-mywork-done" });
		setIcon(done, "circle-check");
		setTooltip(done, "Mark done");
		done.addEventListener("click", (e) => {
			e.stopPropagation();
			void hub.store.setStatus(item.path, hub.store.statusFor("completed"));
		});
	}

	private drop(key: SectionKey): void {
		const path = this.dragPath;
		this.dragPath = null;
		const store = this.hub.store;
		const item = path ? store.getItem(path) : null;
		if (!item) return;
		void (async () => {
			try {
				switch (key) {
					case "today":
						if (item.due !== today()) await store.update(path!, { [P.due]: today() });
						break;
					case "progress": {
						const s = store.statusFor("inProgress");
						if (item.status !== s) await store.setStatus(path!, s);
						break;
					}
					case "next": {
						const cur = store.currentSprint();
						if (cur && item.sprint !== cur.path) await store.setLink(path!, P.sprint, cur.path);
						const s = store.statusFor("proposed");
						if (item.status !== s) await store.setStatus(path!, s);
						break;
					}
					case "done": {
						const s = store.statusFor("completed");
						if (item.status !== s) await store.setStatus(path!, s);
						break;
					}
				}
			} catch (e) {
				new Notice(e instanceof Error ? e.message : String(e));
			}
		})();
	}
}
