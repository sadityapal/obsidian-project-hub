// The "ph-header" code block: a polished page header for work items, projects,
// sprints and people with inline property editing.

import { Menu, Notice, setIcon, setTooltip } from "obsidian";
import type { Hub } from "../core/hub";
import { P, PROJECT_HEALTH, PROJECT_STATUSES, type Person, type Project, type Sprint, type WorkItem } from "../core/model";
import { chip, noteLink, personLabel, priorityBadge, progressBar, shortDate, statusMenu, statusPill, typeBadge, typeMenu, priorityMenu } from "./widgets";
import { daysUntil } from "./widgets";
import { pickItem, pickPerson, pickProject, pickSprint } from "./pickers";
import { datePopover, inlineEditable, listPopover, numberPopover } from "./modals";
import { registerLiveBlock } from "./live";
import { daysBetween, today } from "../core/util";

export function registerHeader(hub: Hub): void {
	registerLiveBlock(hub, "ph-header", (_source, el, ctx) => renderHeader(hub, el, ctx.sourcePath));
}

function renderHeader(hub: Hub, el: HTMLElement, sourcePath: string): void {
	const entity = hub.store.getEntity(sourcePath);
	if (!entity) {
		el.createDiv({ cls: "ph-empty", text: "Project Hub: this note is not a work item, project, sprint or person." });
		return;
	}
	switch (entity.kind) {
		case "work-item":
			renderItemHeader(hub, el, entity);
			break;
		case "project":
			renderProjectHeader(hub, el, entity);
			break;
		case "sprint":
			renderSprintHeader(hub, el, entity);
			break;
		case "person":
			renderPersonHeader(hub, el, entity);
			break;
	}
}

// ---------------------------------------------------------------- shared bits

async function write(hub: Hub, path: string, patch: Record<string, unknown>): Promise<void> {
	try {
		await hub.store.update(path, patch);
	} catch (e) {
		new Notice(e instanceof Error ? e.message : String(e));
	}
}

function propRow(grid: HTMLElement, label: string, wide = false): { row: HTMLElement; value: HTMLElement } {
	const row = grid.createDiv({ cls: "ph-prop" + (wide ? " ph-prop-wide" : "") });
	row.createSpan({ cls: "ph-prop-label", text: label });
	return { row, value: row.createSpan({ cls: "ph-prop-value" }) };
}

function actionBtn(parent: HTMLElement, icon: string, text: string, onClick: () => void, primary = false): void {
	const b = parent.createEl("button", { cls: "ph-btn" + (primary ? " mod-cta" : "") });
	setIcon(b, icon);
	b.createSpan({ text });
	b.addEventListener("click", () => onClick());
}

function textCtl(host: HTMLElement, text: string | null, onClick: (el: HTMLElement) => void): void {
	const el = host.createSpan({ cls: "ph-ctl", text: text ?? "—" });
	if (!text) el.addClass("ph-faint");
	el.addEventListener("click", () => onClick(el));
}

function dateControl(hub: Hub, host: HTMLElement, path: string, key: string, value: string | null): void {
	const el = host.createSpan({ cls: "ph-ctl ph-date-ctl" });
	el.createSpan({ text: value ? shortDate(value) : "—", cls: value ? "" : "ph-faint" });
	if (value) {
		const d = daysUntil(value);
		const rel = el.createSpan({ cls: "ph-date-rel" + (d < 0 ? " is-critical" : d <= 2 ? " is-warning" : ""), text: d === 0 ? "today" : d > 0 ? `in ${d}d` : `${-d}d ago` });
		setTooltip(rel, value);
	}
	el.addEventListener("click", () => {
		datePopover(el, value, (v) => void write(hub, path, { [key]: v }));
	});
}

function numberControl(hub: Hub, host: HTMLElement, path: string, key: string, value: number | null, placeholder = "—"): void {
	const el = host.createSpan({ cls: "ph-ctl", text: value === null ? placeholder : String(value) });
	if (value === null) el.addClass("ph-faint");
	el.addEventListener("click", () => {
		numberPopover(el, value, (v) => void write(hub, path, { [key]: v }));
	});
}

function labelsControl(hub: Hub, host: HTMLElement, item: WorkItem): void {
	for (const l of item.labels) {
		const c = host.createSpan({ cls: "ph-chip" });
		setIcon(c.createSpan(), "tag");
		c.createSpan({ text: l });
		const x = c.createSpan({ cls: "ph-chip-x" });
		setIcon(x, "x");
		x.addEventListener("click", (e) => {
			e.stopPropagation();
			void write(hub, item.path, { [P.labels]: item.labels.filter((v) => v !== l) });
		});
	}
	const add = host.createSpan({ cls: "ph-chip ph-chip-add" });
	setIcon(add, "plus");
	setTooltip(add, "Add labels");
	add.addEventListener("click", () => {
		listPopover(add, item.labels, (v) => void write(hub, item.path, { [P.labels]: v }));
	});
}

function blockedByControl(hub: Hub, host: HTMLElement, item: WorkItem): void {
	for (const p of item.blockedBy) {
		const blocker = hub.store.getItem(p);
		const c = host.createSpan({ cls: "ph-chip" });
		setIcon(c.createSpan(), "link");
		c.createSpan({ text: blocker ? `${blocker.id} ${blocker.title}` : p.split("/").pop()! });
		c.addEventListener("click", () => void hub.openPath(p));
		const x = c.createSpan({ cls: "ph-chip-x" });
		setIcon(x, "x");
		x.addEventListener("click", (e) => {
			e.stopPropagation();
			const rest = item.blockedBy
				.filter((v) => v !== p)
				.map((bp) => hub.store.linkTo(bp, item.path));
			void write(hub, item.path, { [P.blockedBy]: rest });
		});
	}
	const add = host.createSpan({ cls: "ph-chip ph-chip-add" });
	setIcon(add, "plus");
	setTooltip(add, "Add blocker");
	add.addEventListener("click", () => {
		const exclude = new Set<string>([item.path, ...hub.store.descendants(item.path).map((d) => d.path)]);
		void pickItem(hub, { exclude, placeholder: "Blocked by…" }).then((p) => {
			if (!p) return;
			const list = [...item.blockedBy, p].map((bp) => hub.store.linkTo(bp, item.path));
			void write(hub, item.path, { [P.blockedBy]: list });
		});
	});
}

// ---------------------------------------------------------------- work item header

function renderItemHeader(hub: Hub, el: HTMLElement, item: WorkItem): void {
	const store = hub.store;
	const root = el.createDiv({ cls: "ph-header" });

	const crumbs = root.createDiv({ cls: "ph-crumbs" });
	const project = store.effectiveProject(item);
	if (project) {
		noteLink(hub, crumbs, project);
		crumbs.createSpan({ cls: "ph-crumb-sep", text: "›" });
	}
	for (const a of [...store.ancestors(item.path)].reverse()) {
		noteLink(hub, crumbs, a.path);
		crumbs.createSpan({ cls: "ph-crumb-sep", text: "›" });
	}
	crumbs.createSpan({ cls: "ph-crumb-current", text: `${item.id} · ${item.title}` });

	const head = root.createDiv({ cls: "ph-head" });
	const typeCtl = head.createSpan({ cls: "ph-ctl" });
	typeBadge(hub, typeCtl, item.type);
	typeCtl.addEventListener("click", (e) => typeMenu(hub, e, [item]));
	statusPill(hub, head, item.status, { onClick: (e) => statusMenu(hub, e, [item]) });
	priorityBadge(head, item.priority, { onClick: (e) => priorityMenu(hub, e, [item]) });
	head.createSpan({ cls: "ph-id", text: item.id });
	if (!store.isDone(item) && store.isBlocked(item)) chip(head, "Blocked", { icon: "octagon-x", cls: "is-critical", tooltip: "Status is blocked or a dependency is not done" });
	if (store.isOverdue(item)) chip(head, "Overdue", { icon: "alarm-clock-off", cls: "is-critical" });

	const grid = root.createDiv({ cls: "ph-grid" });

	const assignee = propRow(grid, "Assignee");
	personLabel(hub, assignee.value, item.assignee, {
		onClick: () => {
			void pickPerson(hub).then((p) => {
				if (p === undefined) return;
				void write(hub, item.path, { [P.assignee]: p ? store.linkTo(p, item.path) : null });
			});
		},
	});

	const sprint = propRow(grid, "Sprint");
	textCtl(sprint.value, item.sprint ? store.displayName(item.sprint) : null, () => {
		void pickSprint(hub, { includePast: true }).then((p) => {
			if (p === undefined) return;
			void write(hub, item.path, { [P.sprint]: p ? store.linkTo(p, item.path) : null });
		});
	});

	const proj = propRow(grid, "Project");
	textCtl(proj.value, project ? store.displayName(project) : null, () => {
		void pickProject(hub).then((p) => {
			if (p === undefined) return;
			void write(hub, item.path, { [P.project]: p ? store.linkTo(p, item.path) : null });
		});
	});

	const parent = propRow(grid, "Parent");
	textCtl(parent.value, item.parent ? store.getItem(item.parent)?.title ?? null : null, () => {
		const exclude = new Set<string>([item.path, ...store.descendants(item.path).map((d) => d.path)]);
		void pickItem(hub, { exclude, placeholder: "Parent…" }).then((p) => {
			if (p === undefined) return;
			void write(hub, item.path, { [P.parent]: p ? store.linkTo(p, item.path) : null });
		});
	});

	const start = propRow(grid, "Start");
	dateControl(hub, start.value, item.path, P.start, item.start);

	const due = propRow(grid, "Due");
	dateControl(hub, due.value, item.path, P.due, item.due);

	const points = propRow(grid, "Points");
	numberControl(hub, points.value, item.path, P.points, item.points);

	const labels = propRow(grid, "Labels", true);
	labelsControl(hub, labels.value, item);

	const blocked = propRow(grid, "Blocked by", true);
	blockedByControl(hub, blocked.value, item);

	const kids = store.children(item.path);
	if (kids.length) {
		const r = store.rollup(item.path);
		const progress = propRow(grid, "Progress", true);
		progress.value.addClass("ph-progress-ctl");
		progressBar(progress.value, r.progress, { label: false, width: "180px" });
		progress.value.createSpan({ cls: "ph-muted", text: ` ${r.done}/${r.total} done` });
	}

	const actions = root.createDiv({ cls: "ph-actions" });
	const childType = store.typeDef(item.type)?.child;
	actionBtn(actions, "plus", "Child item", () => hub.newItem({ parent: item.path, project, type: childType }));
	const category = store.statusCategory(item.status);
	if (category === "proposed") actionBtn(actions, "play", "Start", () => void store.setStatus(item.path, store.statusFor("inProgress")));
	if (category !== "completed" && category !== "removed") actionBtn(actions, "check", "Done", () => void store.setStatus(item.path, store.statusFor("completed")), true);
}

// ---------------------------------------------------------------- project header

const HEALTH_ICONS: Record<string, string> = { "On Track": "circle-check", "At Risk": "triangle-alert", "Off Track": "octagon-alert" };
const HEALTH_LOOK: Record<string, string> = { "On Track": "is-good", "At Risk": "is-warning", "Off Track": "is-critical" };

function renderProjectHeader(hub: Hub, el: HTMLElement, proj: Project): void {
	const store = hub.store;
	const root = el.createDiv({ cls: "ph-header" });

	const head = root.createDiv({ cls: "ph-head" });
	head.createSpan({ cls: "ph-head-title", text: proj.name });
	if (proj.summary) head.createSpan({ cls: "ph-head-sub", text: proj.summary });

	const statusCtl = head.createSpan({ cls: "ph-ctl ph-chip" });
	statusCtl.createSpan({ text: proj.status });
	setTooltip(statusCtl, "Project status");
	statusCtl.addEventListener("click", (e) => {
		const menu = new Menu();
		for (const s of PROJECT_STATUSES) {
			menu.addItem((mi) => mi.setTitle(s).setChecked(proj.status === s).onClick(() => void write(hub, proj.path, { [P.status]: s })));
		}
		menu.showAtMouseEvent(e);
	});

	const health = proj.health ?? "On Track";
	const healthCtl = head.createSpan({ cls: "ph-ctl ph-chip " + (HEALTH_LOOK[health] ?? "") });
	setIcon(healthCtl.createSpan(), HEALTH_ICONS[health] ?? "circle");
	healthCtl.createSpan({ text: health });
	setTooltip(healthCtl, "Project health");
	healthCtl.addEventListener("click", (e) => {
		const menu = new Menu();
		for (const h of PROJECT_HEALTH) {
			menu.addItem((mi) =>
				mi
					.setTitle(h)
					.setIcon(HEALTH_ICONS[h] ?? "circle")
					.setChecked(health === h)
					.onClick(() => void write(hub, proj.path, { [P.health]: h })),
			);
		}
		menu.showAtMouseEvent(e);
	});

	const ownerCtl = head.createSpan({ cls: "ph-ctl" });
	personLabel(hub, ownerCtl, proj.owner, {
		onClick: () => {
			void pickPerson(hub).then((p) => {
				if (p === undefined) return;
				void write(hub, proj.path, { [P.owner]: p ? store.linkTo(p, proj.path) : null });
			});
		},
	});

	const grid = root.createDiv({ cls: "ph-grid" });

	const start = propRow(grid, "Start");
	dateControl(hub, start.value, proj.path, P.start, proj.start);

	const target = propRow(grid, "Target");
	{
		const el2 = target.value.createSpan({ cls: "ph-ctl ph-date-ctl" });
		el2.createSpan({ text: proj.target ? shortDate(proj.target) : "—", cls: proj.target ? "" : "ph-faint" });
		if (proj.target) {
			const d = daysBetween(today(), proj.target);
			const late = proj.status !== "Done" && proj.status !== "Cancelled";
			el2.createSpan({
				cls: "ph-date-rel" + (late && d < 0 ? " is-critical" : late && d <= 14 ? " is-warning" : ""),
				text: d === 0 ? "today" : d > 0 ? `${d} days left` : `${-d} days overdue`,
			});
		}
		el2.addEventListener("click", () => {
			datePopover(el2, proj.target, (v) => void write(hub, proj.path, { [P.target]: v }));
		});
	}

	const summary = propRow(grid, "Summary", true);
	inlineEditable(summary.value, proj.summary ?? "", (v) => void write(hub, proj.path, { [P.summary]: v }), "Add a summary…");

	const area = propRow(grid, "ADO area path", true);
	inlineEditable(area.value, proj.adoArea ?? "", (v) => void write(hub, proj.path, { [P.adoArea]: v }), "Not linked");

	const items = store.projectItems(proj.path).filter((i) => !store.isRemoved(i));
	const r = store.rollup(proj.path);
	const open = items.filter((i) => !store.isDone(i));
	const inProgress = open.filter((i) => {
		const c = store.statusCategory(i.status);
		return c === "inProgress" || c === "resolved";
	});
	const blocked = open.filter((i) => store.isBlocked(i));
	const overdue = open.filter((i) => store.isOverdue(i));

	const progress = propRow(grid, "Progress", true);
	progress.value.addClass("ph-progress-ctl");
	progressBar(progress.value, r.progress, { label: false, width: "180px" });
	progress.value.createSpan({ cls: "ph-muted", text: ` ${r.done}/${r.total} done · ${r.pointsDone}/${r.points} pts` });

	const stats = root.createDiv({ cls: "ph-stats" });
	const stat = (label: string, value: number, icon: string, cls = "") => {
		const s = stats.createDiv({ cls: "ph-stat " + cls });
		setIcon(s.createSpan({ cls: "ph-stat-icon" }), icon);
		s.createSpan({ cls: "ph-stat-value", text: String(value) });
		s.createSpan({ cls: "ph-stat-label", text: label });
	};
	stat("Open", open.length, "circle");
	stat("In progress", inProgress.length, "circle-dot");
	stat("Blocked", blocked.length, "octagon-x", blocked.length ? "is-critical" : "");
	stat("Overdue", overdue.length, "alarm-clock-off", overdue.length ? "is-critical" : "");

	const actions = root.createDiv({ cls: "ph-actions" });
	actionBtn(actions, "plus", "Work item", () => hub.newItem({ project: proj.path }));
	actionBtn(actions, "square-kanban", "Open board", () => void hub.openPath("Bases/Work Items.base#Board"));
}

// ---------------------------------------------------------------- sprint header

function renderSprintHeader(hub: Hub, el: HTMLElement, sprint: Sprint): void {
	const store = hub.store;
	const root = el.createDiv({ cls: "ph-header" });

	const head = root.createDiv({ cls: "ph-head" });
	head.createSpan({ cls: "ph-head-title", text: sprint.name });
	const state = sprint.state ?? "Future";
	const stateChip = head.createSpan({ cls: "ph-chip" + (state === "Current" ? " is-good" : state === "Past" ? " ph-faint" : "") });
	setIcon(stateChip.createSpan(), state === "Current" ? "target" : state === "Past" ? "history" : "clock");
	stateChip.createSpan({ text: state });
	head.createSpan({
		cls: "ph-head-sub",
		text: sprint.start && sprint.end ? `${shortDate(sprint.start)} → ${shortDate(sprint.end)}` : "No dates set",
	});
	if (state === "Current" && sprint.start && sprint.end) {
		const day = daysBetween(sprint.start, today()) + 1;
		const total = daysBetween(sprint.start, sprint.end) + 1;
		head.createSpan({ cls: "ph-chip", text: `Day ${day} of ${total}` });
	}

	const grid = root.createDiv({ cls: "ph-grid" });

	const goal = propRow(grid, "Goal", true);
	inlineEditable(goal.value, sprint.goal ?? "", (v) => void write(hub, sprint.path, { [P.goal]: v }), "Add a goal…");

	const items = store.sprintItems(sprint.path);
	const committed = items.reduce((s, i) => s + (i.points ?? 0), 0);
	const r = store.rollup(sprint.path);

	const capacity = propRow(grid, "Capacity", true);
	{
		const v = capacity.value;
		v.addClass("ph-progress-ctl");
		if (sprint.capacity && sprint.capacity > 0) {
			progressBar(v, Math.min(100, (committed / sprint.capacity) * 100), { label: false, width: "180px" });
			v.createSpan({ cls: "ph-muted", text: ` ${committed} committed of ${sprint.capacity} pts` });
		} else {
			const el2 = v.createSpan({ cls: "ph-ctl ph-faint", text: `${committed} pts committed — set capacity` });
			el2.addEventListener("click", () => {
				numberPopover(el2, sprint.capacity, (n) => void write(hub, sprint.path, { [P.capacity]: n }));
			});
		}
	}

	const progress = propRow(grid, "Progress", true);
	progress.value.addClass("ph-progress-ctl");
	progressBar(progress.value, r.progress, { label: false, width: "180px" });
	progress.value.createSpan({ cls: "ph-muted", text: ` ${r.done}/${r.total} done · ${r.pointsDone}/${r.points} pts` });

	const dates = propRow(grid, "Dates", true);
	{
		const v = dates.value;
		const startEl = v.createSpan({ cls: "ph-ctl ph-date-ctl" });
		startEl.createSpan({ text: sprint.start ? shortDate(sprint.start) : "No start" });
		startEl.addEventListener("click", () => datePopover(startEl, sprint.start, (s) => void write(hub, sprint.path, { [P.start]: s })));
		v.createSpan({ cls: "ph-muted", text: " → " });
		const endEl = v.createSpan({ cls: "ph-ctl ph-date-ctl" });
		endEl.createSpan({ text: sprint.end ? shortDate(sprint.end) : "No end" });
		endEl.addEventListener("click", () => datePopover(endEl, sprint.end, (s) => void write(hub, sprint.path, { [P.end]: s })));
	}

	const actions = root.createDiv({ cls: "ph-actions" });
	actionBtn(actions, "plus", "Item in sprint", () => hub.newItem({ sprint: sprint.path }));
	if (state === "Current") actionBtn(actions, "chevrons-right", "Start next sprint", () => hub.runCommand("start-next-sprint"), true);
}

// ---------------------------------------------------------------- person header

function renderPersonHeader(hub: Hub, el: HTMLElement, person: Person): void {
	const store = hub.store;
	const root = el.createDiv({ cls: "ph-header" });

	const head = root.createDiv({ cls: "ph-head" });
	head.createSpan({ cls: "ph-head-title", text: person.name });

	const grid = root.createDiv({ cls: "ph-grid" });

	const email = propRow(grid, "Email");
	inlineEditable(email.value, person.email ?? "", (v) => void write(hub, person.path, { [P.email]: v }), "Add email…");

	const role = propRow(grid, "Role");
	inlineEditable(role.value, person.role ?? "", (v) => void write(hub, person.path, { [P.role]: v }), "Add role…");

	const open = store.personItems(person.path).filter((i) => !store.isDone(i));
	const load = propRow(grid, "Load");
	load.value.createSpan({ cls: "ph-ctl", text: `${open.length} open · ${open.reduce((s, i) => s + (i.points ?? 0), 0)} pts` });

	const actions = root.createDiv({ cls: "ph-actions" });
	actionBtn(actions, "user-plus", "Assign new item", () => hub.newItem({ assignee: person.path }));
}
