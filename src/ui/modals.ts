// Modal dialogs for Project Hub: quick-create for work items, projects, sprints and
// meetings, plus the shared popovers used by the note header and the modals.

import { Menu, Modal, Notice, Setting, setIcon, setTooltip } from "obsidian";
import type { App } from "obsidian";
import type { Hub } from "../core/hub";
import { P, PRIORITIES, type Person } from "../core/model";
import { frontmatter } from "../core/store";
import type { NewItemOptions } from "../core/store";
import { addDays, isoDate, parseDate, sanitizeFilename, today } from "../core/util";
import { chip, shortDate } from "./widgets";
import { pickItem, pickPerson, pickProject, pickSprint } from "./pickers";

// ---------------------------------------------------------------- confirm

class ConfirmModalImpl extends Modal {
	private settled = false;

	constructor(
		app: App,
		private title: string,
		private message: string,
		private cta: string,
		private destructive: boolean,
		private done: (ok: boolean) => void,
	) {
		super(app);
		this.modalEl.addClass("ph-confirm");
	}

	onOpen(): void {
		this.setTitle(this.title);
		this.contentEl.createDiv({ cls: "ph-confirm-msg", text: this.message });
		const row = this.contentEl.createDiv({ cls: "ph-confirm-actions" });
		row.createEl("button", { cls: "ph-btn", text: "Cancel" }).addEventListener("click", () => this.finish(false));
		const cta = row.createEl("button", { cls: this.destructive ? "ph-btn mod-warning" : "ph-btn mod-cta", text: this.cta });
		cta.addEventListener("click", () => this.finish(true));
		window.setTimeout(() => cta.focus(), 0);
	}

	onClose(): void {
		this.finish(false);
	}

	private finish(ok: boolean): void {
		if (this.settled) return;
		this.settled = true;
		this.done(ok);
		this.close();
	}
}

/** Promise-based confirm dialog. Resolves true when the call-to-action is clicked. */
export function ConfirmModal(app: App, title: string, message: string, cta = "Confirm", destructive = false): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		new ConfirmModalImpl(app, title, message, cta, destructive, (ok) => {
			if (settled) return;
			settled = true;
			resolve(ok);
		}).open();
	});
}

// ---------------------------------------------------------------- popovers

let openPop: { el: HTMLElement; anchor: HTMLElement } | null = null;

function closePop(): void {
	openPop?.el.remove();
	openPop = null;
}

function showPop(anchor: HTMLElement, build: (pop: HTMLElement) => void): void {
	if (openPop?.anchor === anchor) {
		closePop();
		return;
	}
	closePop();
	// Inside a modal the popover must live in the modal container to sit above it.
	const host: HTMLElement = anchor.closest(".modal-container") ?? document.body;
	const pop = host.createDiv({ cls: "ph-pop" });
	build(pop);
	const r = anchor.getBoundingClientRect();
	// Fixed positioning against the viewport, or absolute against a transformed host.
	const offsetTop = host === document.body ? 0 : host.getBoundingClientRect().top;
	const offsetLeft = host === document.body ? 0 : host.getBoundingClientRect().left;
	pop.style.position = host === document.body ? "fixed" : "absolute";
	const top = Math.min(Math.max(8, r.bottom + 6 - offsetTop), Math.max(8, window.innerHeight - offsetTop - pop.offsetHeight - 8));
	const left = Math.min(Math.max(8, r.left - offsetLeft), Math.max(8, window.innerWidth - offsetLeft - pop.offsetWidth - 8));
	pop.style.top = `${top}px`;
	pop.style.left = `${left}px`;
	openPop = { el: pop, anchor };
	const onDown = (e: MouseEvent) => {
		if (!openPop || openPop.el !== pop) {
			document.removeEventListener("mousedown", onDown, true);
			return;
		}
		if (pop.contains(e.target as Node) || e.target === anchor) return;
		closePop();
		document.removeEventListener("mousedown", onDown, true);
	};
	window.setTimeout(() => document.addEventListener("mousedown", onDown, true), 0);
	pop.addEventListener("keydown", (e) => {
		if (e.key === "Escape") {
			e.preventDefault();
			closePop();
		}
	});
}

/** Date editor popover; `onPick(null)` clears. */
export function datePopover(anchor: HTMLElement, value: string | null, onPick: (v: string | null) => void): void {
	showPop(anchor, (pop) => {
		pop.createDiv({ cls: "ph-pop-title", text: value ? "Change date" : "Set date" });
		const input = pop.createEl("input", { cls: "ph-pop-date", attr: { type: "date" } });
		if (value) input.value = value;
		const actions = pop.createDiv({ cls: "ph-pop-actions" });
		actions.createEl("button", { cls: "ph-btn", text: "Clear" }).addEventListener("click", () => {
			closePop();
			onPick(null);
		});
		const commit = () => {
			closePop();
			onPick(input.value || null);
		};
		input.addEventListener("change", commit);
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				commit();
			}
		});
		window.setTimeout(() => input.focus(), 0);
	});
}

/** Small numeric editor popover; `onPick(null)` clears. */
export function numberPopover(anchor: HTMLElement, value: number | null, onPick: (v: number | null) => void): void {
	showPop(anchor, (pop) => {
		pop.createDiv({ cls: "ph-pop-title", text: value === null ? "Set value" : "Change value" });
		const input = pop.createEl("input", { cls: "ph-pop-number", attr: { type: "number", min: "0", step: "any" } });
		if (value !== null) input.value = String(value);
		const actions = pop.createDiv({ cls: "ph-pop-actions" });
		actions.createEl("button", { cls: "ph-btn", text: "Clear" }).addEventListener("click", () => {
			closePop();
			onPick(null);
		});
		const commit = () => {
			const n = input.value.trim() === "" ? null : Number(input.value);
			closePop();
			onPick(n !== null && isFinite(n) ? n : null);
		};
		input.addEventListener("change", commit);
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				commit();
			}
		});
		window.setTimeout(() => {
			input.focus();
			input.select();
		}, 0);
	});
}

/** Comma-separated list editor popover. */
export function listPopover(anchor: HTMLElement, values: string[], onPick: (v: string[]) => void): void {
	showPop(anchor, (pop) => {
		pop.createDiv({ cls: "ph-pop-title", text: "Comma separated" });
		const input = pop.createEl("input", { cls: "ph-pop-text" });
		input.value = values.join(", ");
		const commit = () => {
			closePop();
			onPick(
				input.value
					.split(",")
					.map((v) => v.trim())
					.filter(Boolean),
			);
		};
		input.addEventListener("change", commit);
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				commit();
			}
		});
		window.setTimeout(() => {
			input.focus();
			input.select();
		}, 0);
	});
}

/** Free-text editor popover; `onPick(null)` clears. */
export function textPopover(anchor: HTMLElement, value: string, onPick: (v: string | null) => void, title = "Edit"): void {
	showPop(anchor, (pop) => {
		pop.createDiv({ cls: "ph-pop-title", text: title });
		const input = pop.createEl("input", { cls: "ph-pop-text" });
		input.value = value;
		const actions = pop.createDiv({ cls: "ph-pop-actions" });
		actions.createEl("button", { cls: "ph-btn", text: "Clear" }).addEventListener("click", () => {
			closePop();
			onPick(null);
		});
		const commit = () => {
			closePop();
			onPick(input.value.trim() || null);
		};
		input.addEventListener("change", commit);
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				commit();
			}
		});
		window.setTimeout(() => {
			input.focus();
			input.select();
		}, 0);
	});
}

/** Inline text edit: paints a clickable span into `host` and swaps in an input. */
export function inlineEditable(host: HTMLElement, value: string, onDone: (v: string | null) => void, placeholder = "Add"): void {
	const paint = () => {
		host.empty();
		const span = host.createSpan({ cls: "ph-ctl ph-editable", text: value || placeholder });
		if (!value) span.addClass("ph-faint");
		span.addEventListener("click", () => edit());
	};
	const edit = () => {
		host.empty();
		const input = host.createEl("input", { cls: "ph-inline-input", attr: { type: "text", placeholder } });
		input.value = value;
		let finished = false;
		const commit = (v: string | null) => {
			if (finished) return;
			finished = true;
			onDone(v);
		};
		input.addEventListener("keydown", (e) => {
			e.stopPropagation();
			if (e.key === "Enter") {
				e.preventDefault();
				commit(input.value.trim() || null);
			} else if (e.key === "Escape") {
				e.preventDefault();
				finished = true;
				paint();
			}
		});
		input.addEventListener("blur", () => commit(input.value.trim() || null));
		window.setTimeout(() => {
			input.focus();
			input.select();
		}, 0);
	};
	paint();
}

/** Coarse relative time, e.g. "5m ago". */
export function relTime(ts: number | null | undefined): string {
	if (!ts) return "never";
	const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
	if (s < 45) return "just now";
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.round(m / 60);
	if (h < 24) return `${h}h ago`;
	const d = Math.round(h / 24);
	if (d < 7) return `${d}d ago`;
	const w = Math.round(d / 7);
	if (w < 6) return `${w}w ago`;
	return new Date(ts).toLocaleDateString();
}

// ---------------------------------------------------------------- quick tokens

export interface QuickTokens {
	title: string;
	priority: number | null;
	assignee: string | null;
	assigneeName: string | null;
	labels: string[];
	due: string | null;
	points: number | null;
}

const WEEKDAYS = ["sunday", "sun", "monday", "mon", "tuesday", "tue", "tues", "wednesday", "wed", "thursday", "thu", "thurs", "friday", "fri", "saturday", "sat"];

/** Parses natural-language tokens from a quick-create title. */
export function parseQuickTokens(hub: Hub, raw: string): QuickTokens {
	const out: QuickTokens = { title: raw, priority: null, assignee: null, assigneeName: null, labels: [], due: null, points: null };

	let title = raw.replace(/(^|\s)!([1-4])(?=\s|$)/g, (_m, lead: string, p: string) => {
		out.priority = Number(p);
		return lead;
	});
	title = title.replace(/(^|\s)~(\d+(?:\.\d+)?)(?=\s|$)/g, (_m, lead: string, n: string) => {
		out.points = Number(n);
		return lead;
	});
	title = title.replace(/(^|\s)\^(\S+)(?=\s|$)/g, (m, lead: string, tok: string) => {
		const d = parseDueToken(tok);
		if (!d) return m;
		out.due = d;
		return lead;
	});
	title = title.replace(/(^|\s)#([A-Za-z0-9_\-/]+)/g, (_m, lead: string, tag: string) => {
		if (!out.labels.includes(tag)) out.labels.push(tag);
		return lead;
	});
	title = title.replace(/(^|\s)@([^\s@]+)/g, (m, lead: string, handle: string) => {
		const person = matchPerson(hub, handle);
		if (!person) return m;
		out.assignee = person.path;
		out.assigneeName = person.name;
		return lead;
	});

	out.title = title.replace(/\s{2,}/g, " ").trim();
	return out;
}

function parseDueToken(tok: string): string | null {
	const t = tok.toLowerCase();
	if (t === "today" || t === "eod") return today();
	if (t === "tomorrow" || t === "tmr" || t === "tmrw") return addDays(today(), 1);
	const wd = WEEKDAYS.indexOf(t);
	if (wd >= 0) {
		const target = wd % 7;
		const delta = (target - parseDate(today())!.getDay() + 7) % 7;
		return addDays(today(), delta);
	}
	const rel = /^\+(\d+)([dw]?)$/.exec(t);
	if (rel) {
		const n = Number(rel[1]);
		return addDays(today(), rel[2] === "w" ? n * 7 : n);
	}
	const d = parseDate(tok);
	return d ? isoDate(d) : null;
}

function matchPerson(hub: Hub, handle: string): Person | null {
	const h = handle.toLowerCase().replace(/[._]/g, "");
	if (!h) return null;
	let best: Person | null = null;
	let bestScore = 0;
	for (const p of hub.store.people.values()) {
		const words = p.name.toLowerCase().replace(/[()]/g, " ").split(/\s+/).filter(Boolean);
		const local = (p.email ?? "").split("@")[0]?.replace(/[._]/g, "") ?? "";
		let score = 0;
		if (words.some((w) => w.replace(/[._]/g, "") === h) || local === h) score = 4;
		else if (words.some((w) => w.replace(/[._]/g, "").startsWith(h)) || local.startsWith(h)) score = 3;
		else if (p.name.toLowerCase().replace(/[._]/g, " ").includes(h)) score = 2;
		if (score === 0) continue;
		if (score > bestScore || (score === bestScore && best !== null && p.name.length < best.name.length)) {
			best = p;
			bestScore = score;
		}
	}
	return bestScore >= 2 ? best : null;
}

function notifyCreated(hub: Hub, id: string, path: string): void {
	const frag = createFragment((el) => {
		const wrap = el.createDiv({ cls: "ph-notice-created" });
		wrap.createSpan({ text: `Created ${id}` });
		const link = wrap.createEl("a", { text: "Open", cls: "ph-link" });
		link.addEventListener("click", (e) => {
			e.preventDefault();
			void hub.openPath(path);
		});
	});
	new Notice(frag, 5000);
}

// ---------------------------------------------------------------- new work item

type PillKey = "type" | "status" | "priority" | "assignee" | "project" | "parent" | "sprint" | "due" | "points" | "labels";

/** Linear-style quick-create modal. */
export class NewItemModal extends Modal {
	private opt: {
		type?: string;
		status?: string;
		priority?: number | null;
		assignee?: string | null;
		project?: string | null;
		parent?: string | null;
		sprint?: string | null;
		due?: string | null;
		points?: number | null;
		labels?: string[];
	} = {};
	private adoSync = false;
	private adoTouched = false;
	private creating = false;

	private titleInput!: HTMLInputElement;
	private descEl!: HTMLTextAreaElement;
	private tokensEl!: HTMLElement;
	private pillsEl!: HTMLElement;
	private errorEl!: HTMLElement;
	private createBtn!: HTMLButtonElement;
	private createOpenBtn!: HTMLButtonElement;
	private adoRow!: HTMLElement;
	private adoBox!: HTMLInputElement;

	constructor(
		private hub: Hub,
		private defaults: Partial<NewItemOptions> = {},
	) {
		super(hub.app);
		this.modalEl.addClass("ph-nim-modal");
	}

	onOpen(): void {
		this.setTitle("New work item");
		const root = this.contentEl.createDiv({ cls: "ph-nim" });

		this.titleInput = root.createEl("input", { cls: "ph-nim-title", attr: { type: "text", placeholder: "What needs to be done?" } });
		this.titleInput.addEventListener("input", () => this.refresh());
		this.titleInput.addEventListener("keydown", (e) => {
			if (e.key !== "Enter") return;
			e.preventDefault();
			void this.create(e.ctrlKey || e.metaKey, e.shiftKey);
		});

		this.tokensEl = root.createDiv({ cls: "ph-nim-tokens" });

		this.descEl = root.createEl("textarea", { cls: "ph-nim-desc", attr: { placeholder: "Description (optional, markdown)" } });

		this.pillsEl = root.createDiv({ cls: "ph-nim-pills" });

		this.adoRow = root.createDiv({ cls: "ph-nim-ado" });
		this.adoBox = this.adoRow.createEl("input", { attr: { type: "checkbox" } });
		this.adoBox.addEventListener("change", () => {
			this.adoSync = this.adoBox.checked;
			this.adoTouched = true;
		});
		this.adoRow.createSpan({ cls: "ph-nim-ado-label", text: "Create in Azure DevOps" });
		this.adoRow.createSpan({ cls: "ph-nim-ado-hint", text: "publishes the item on sync (needs an ADO area path on the project)" });

		this.errorEl = root.createDiv({ cls: "ph-nim-error" });

		const foot = root.createDiv({ cls: "ph-nim-foot" });
		const hints = foot.createDiv({ cls: "ph-nim-hints" });
		hints.createSpan({ text: "Enter create" });
		hints.createSpan({ text: "·" });
		hints.createEl("kbd", { text: "Ctrl" });
		hints.createSpan({ text: "+ Enter create & open" });
		hints.createSpan({ text: "·" });
		hints.createEl("kbd", { text: "Shift" });
		hints.createSpan({ text: "+ Enter keep creating" });
		const actions = foot.createDiv({ cls: "ph-nim-actions" });
		actions.createEl("button", { cls: "ph-btn", text: "Cancel" }).addEventListener("click", () => this.close());
		this.createBtn = actions.createEl("button", { cls: "ph-btn mod-cta", text: "Create" });
		this.createBtn.addEventListener("click", () => void this.create(false, false));
		this.createOpenBtn = actions.createEl("button", { cls: "ph-btn", text: "Create & open" });
		this.createOpenBtn.addEventListener("click", () => void this.create(true, false));

		this.refresh();
		window.setTimeout(() => this.titleInput.focus(), 0);
	}

	// ------------------------------------------------------------ effective values

	private get type(): string {
		return this.opt.type ?? this.defaults.type ?? this.hub.settings.defaultType;
	}

	private get status(): string {
		return this.opt.status ?? this.defaults.status ?? this.hub.store.statusFor("proposed");
	}

	private get priority(): number | null {
		if (this.opt.priority !== undefined) return this.opt.priority;
		return this.tokens().priority ?? this.defaults.priority ?? null;
	}

	private get assignee(): string | null {
		if (this.opt.assignee !== undefined) return this.opt.assignee;
		const t = this.tokens();
		if (t.assignee) return t.assignee;
		if (this.defaults.assignee !== undefined) return this.defaults.assignee;
		return this.hub.store.mePath();
	}

	private get project(): string | null {
		if (this.opt.project !== undefined) return this.opt.project;
		return this.defaults.project ?? null;
	}

	private get parent(): string | null {
		if (this.opt.parent !== undefined) return this.opt.parent;
		return this.defaults.parent ?? null;
	}

	private get sprint(): string | null {
		if (this.opt.sprint !== undefined) return this.opt.sprint;
		return this.defaults.sprint ?? null;
	}

	private get due(): string | null {
		if (this.opt.due !== undefined) return this.opt.due;
		return this.tokens().due ?? this.defaults.due ?? null;
	}

	private get points(): number | null {
		if (this.opt.points !== undefined) return this.opt.points;
		return this.tokens().points ?? this.defaults.points ?? null;
	}

	private get labels(): string[] {
		const out = [...this.tokens().labels];
		for (const l of this.opt.labels ?? this.defaults.labels ?? []) if (!out.includes(l)) out.push(l);
		return out;
	}

	private tokens() {
		return parseQuickTokens(this.hub, this.titleInput.value);
	}

	/** Project of the item, inherited from a chosen parent. */
	private projectPath(): string | null {
		const p = this.project;
		if (p) return p;
		const parent = this.parent ? this.hub.store.getItem(this.parent) : null;
		return parent ? this.hub.store.effectiveProject(parent) : null;
	}

	private defaultAdoSync(): boolean {
		if (!this.hub.settings.ado.enabled) return false;
		const path = this.projectPath();
		return !!path && !!this.hub.store.projects.get(path)?.adoArea;
	}

	// ------------------------------------------------------------ rendering

	private refresh(): void {
		this.renderTokens();
		this.renderPills();
		if (!this.adoTouched) {
			this.adoSync = this.defaultAdoSync();
			this.adoBox.checked = this.adoSync;
		}
		this.adoRow.toggle(this.hub.settings.ado.enabled);
	}

	private renderTokens(): void {
		this.tokensEl.empty();
		const t = this.tokens();
		const any = t.priority !== null || !!t.assignee || t.labels.length > 0 || !!t.due || t.points !== null;
		if (!any) {
			this.tokensEl.createSpan({ cls: "ph-faint", text: "Quick tokens: !1–!4 priority · @person · #label · ^due (fri, +3d, 2026-10-12) · ~points" });
			return;
		}
		if (t.priority !== null) {
			const def = PRIORITIES.find((p) => p.value === t.priority)!;
			chip(this.tokensEl, `${def.label} ${def.name}`, { icon: "flag" });
		}
		if (t.assigneeName) chip(this.tokensEl, t.assigneeName, { icon: "user" });
		for (const l of t.labels) chip(this.tokensEl, l, { icon: "tag" });
		if (t.due) chip(this.tokensEl, shortDate(t.due), { icon: "calendar", tooltip: t.due });
		if (t.points !== null) chip(this.tokensEl, `${t.points} pts`, { icon: "gauge" });
	}

	private renderPills(): void {
		this.pillsEl.empty();
		const pill = (key: PillKey, label: string, value: string, onClick: (e: MouseEvent) => void) => {
			const el = this.pillsEl.createDiv({ cls: "ph-nim-pill", attr: { "data-pill": key } });
			el.createSpan({ cls: "ph-nim-pill-label", text: label });
			el.createSpan({ cls: "ph-nim-pill-value", text: value });
			el.addEventListener("click", onClick);
			setTooltip(el, `Change ${label.toLowerCase()}`);
			return el;
		};

		// type
		const typeDef = this.hub.store.typeDef(this.type);
		const typePill = pill("type", "Type", this.type, (e) => this.typeMenu(e));
		setIcon(typePill.createSpan({ cls: "ph-nim-pill-icon" }), typeDef?.icon ?? "circle-dot");
		// status
		const statusPillEl = pill("status", "Status", this.status, (e) => this.statusMenu(e));
		const dot = statusPillEl.createSpan({ cls: "ph-nim-pill-dot" });
		dot.dataset.phColor = this.hub.store.statusDef(this.status)?.color ?? "gray";
		// priority
		const prio = this.priority;
		const prioDef = PRIORITIES.find((p) => p.value === prio);
		pill("priority", "Priority", prioDef ? `${prioDef.label} · ${prioDef.name}` : "P3 · Medium", (e) => this.priorityMenu(e));
		// assignee
		const assignee = this.assignee;
		const assigneePill = pill("assignee", "Assignee", assignee ? this.hub.store.displayName(assignee) : "Unassigned", () => void this.assigneePicker());
		setIcon(assigneePill.createSpan({ cls: "ph-nim-pill-icon" }), "user");
		// project
		const projectPath = this.projectPath();
		pill("project", "Project", projectPath ? this.hub.store.displayName(projectPath) : "None", () => void this.projectPicker());
		// parent
		const parentPath = this.parent;
		pill("parent", "Parent", parentPath ? this.hub.store.getItem(parentPath)?.title ?? "None" : "None", () => void this.parentPicker());
		// sprint
		const sprintPath = this.sprint;
		pill("sprint", "Sprint", sprintPath ? this.hub.store.displayName(sprintPath) : "Backlog", (e) => this.sprintMenu(e));
		// due
		pill("due", "Due", this.due ? shortDate(this.due) : "No date", (e) =>
			datePopover(e.currentTarget as HTMLElement, this.due, (v) => {
				this.opt.due = v;
				this.refresh();
			}),
		);
		// points
		pill("points", "Points", this.points === null ? "—" : String(this.points), (e) =>
			numberPopover(e.currentTarget as HTMLElement, this.points, (v) => {
				this.opt.points = v;
				this.refresh();
			}),
		);
		// labels
		const labels = this.labels;
		pill("labels", "Labels", labels.length ? labels.join(", ") : "—", (e) =>
			listPopover(e.currentTarget as HTMLElement, labels, (v) => {
				this.opt.labels = v;
				this.refresh();
			}),
		);
	}

	private typeMenu(evt: MouseEvent): void {
		const menu = new Menu();
		for (const t of this.hub.settings.types) {
			menu.addItem((mi) => mi.setTitle(t.name).setIcon(t.icon).setChecked(this.type === t.name).onClick(() => {
				this.opt.type = t.name;
				this.refresh();
			}));
		}
		menu.showAtMouseEvent(evt);
	}

	private statusMenu(evt: MouseEvent): void {
		const menu = new Menu();
		for (const s of this.hub.settings.statuses) {
			menu.addItem((mi) => mi.setTitle(s.name).setChecked(this.status === s.name).onClick(() => {
				this.opt.status = s.name;
				this.refresh();
			}));
		}
		menu.showAtMouseEvent(evt);
	}

	private priorityMenu(evt: MouseEvent): void {
		const menu = new Menu();
		for (const p of PRIORITIES) {
			menu.addItem((mi) => mi.setTitle(`${p.label} · ${p.name}`).setChecked(this.priority === p.value).onClick(() => {
				this.opt.priority = p.value;
				this.refresh();
			}));
		}
		menu.addSeparator();
		menu.addItem((mi) =>
			mi.setTitle("No priority").setIcon("x").onClick(() => {
				this.opt.priority = null;
				this.refresh();
			}),
		);
		menu.showAtMouseEvent(evt);
	}

	private async assigneePicker(): Promise<void> {
		const p = await pickPerson(this.hub);
		if (p === undefined) return;
		this.opt.assignee = p;
		this.refresh();
	}

	private async projectPicker(): Promise<void> {
		const p = await pickProject(this.hub);
		if (p === undefined) return;
		this.opt.project = p;
		this.refresh();
	}

	private async parentPicker(): Promise<void> {
		const p = await pickItem(this.hub, { placeholder: "Parent…" });
		if (p === undefined) return;
		this.opt.parent = p;
		this.refresh();
	}

	private sprintMenu(evt: MouseEvent): void {
		const menu = new Menu();
		const set = (path: string | null) => {
			this.opt.sprint = path;
			this.refresh();
		};
		const current = this.hub.store.currentSprint();
		const next = this.hub.store.nextSprint();
		if (current) menu.addItem((mi) => mi.setTitle("Current sprint").setIcon("target").onClick(() => set(current.path)));
		if (next) menu.addItem((mi) => mi.setTitle("Next sprint").setIcon("chevrons-right").onClick(() => set(next.path)));
		if (current || next) menu.addSeparator();
		menu.addItem((mi) =>
			mi.setTitle("Choose sprint…").setIcon("list").onClick(() => {
				void pickSprint(this.hub).then((s) => {
					if (s !== undefined) set(s);
				});
			}),
		);
		menu.addItem((mi) => mi.setTitle("Backlog (no sprint)").setIcon("inbox").onClick(() => set(null)));
		menu.showAtMouseEvent(evt);
	}

	// ------------------------------------------------------------ create

	private async create(openAfter: boolean, keepOpen: boolean): Promise<void> {
		if (this.creating) return;
		const tokens = parseQuickTokens(this.hub, this.titleInput.value);
		const title = tokens.title.trim();
		if (!title) {
			this.errorEl.setText("Give it a title first");
			this.titleInput.focus();
			return;
		}
		this.errorEl.setText("");
		this.creating = true;
		this.createBtn.disabled = true;
		this.createOpenBtn.disabled = true;
		try {
			const id = await this.hub.store.allocateId();
			const labels = this.labels;
			const file = await this.hub.store.createItem({
				id,
				title,
				type: this.type,
				status: this.status,
				priority: this.priority,
				assignee: this.assignee,
				project: this.project,
				parent: this.parent,
				sprint: this.sprint,
				due: this.due,
				points: this.points,
				labels: labels.length ? labels : undefined,
				description: this.descEl.value.trim() || undefined,
				adoSync: this.adoSync,
				// The ADO module auto-publishes new items whose frontmatter has
				// ado_sync: true and no ado_id yet; spell it out in both places.
				extra: this.adoSync ? { ado_sync: true } : undefined,
			});
			notifyCreated(this.hub, id, file.path);
			if (keepOpen) {
				this.titleInput.value = "";
				this.descEl.value = "";
				this.opt = {};
				this.creating = false;
				this.createBtn.disabled = false;
				this.createOpenBtn.disabled = false;
				this.refresh();
				this.titleInput.focus();
				return;
			}
			this.close();
		} catch (e) {
			this.creating = false;
			this.createBtn.disabled = false;
			this.createOpenBtn.disabled = false;
			this.errorEl.setText(e instanceof Error ? e.message : String(e));
		}
	}
}

// ---------------------------------------------------------------- new project

export class NewProjectModal extends Modal {
	private name = "";
	private owner: string | null = null;
	private start = today();
	private target: string | null = null;
	private area = "";
	private summary = "";
	private ownerBtn!: HTMLButtonElement;

	constructor(private hub: Hub) {
		super(hub.app);
		this.modalEl.addClass("ph-form-modal");
		this.owner = hub.store.mePath();
	}

	onOpen(): void {
		this.setTitle("New project");
		new Setting(this.contentEl)
			.setName("Name")
			.addText((t) => {
				t.setPlaceholder("Project name");
				t.onChange((v) => (this.name = v));
				window.setTimeout(() => t.inputEl.focus(), 0);
			});
		const ownerSetting = new Setting(this.contentEl).setName("Owner").setDesc("Leave empty to keep it unassigned");
		this.ownerBtn = ownerSetting.controlEl.createEl("button", { cls: "ph-btn" });
		this.renderOwnerBtn();
		this.ownerBtn.addEventListener("click", () => {
			void pickPerson(this.hub).then((p) => {
				if (p === undefined) return;
				this.owner = p;
				this.renderOwnerBtn();
			});
		});
		new Setting(this.contentEl)
			.setName("Start")
			.addComponent((el) => {
				const input = el.createEl("input", { attr: { type: "date" } });
				input.value = this.start;
				input.addEventListener("change", () => (this.start = input.value || today()));
				return input as unknown as never;
			});
		new Setting(this.contentEl)
			.setName("Target")
			.addComponent((el) => {
				const input = el.createEl("input", { attr: { type: "date" } });
				input.addEventListener("change", () => (this.target = input.value || null));
				return input as unknown as never;
			});
		new Setting(this.contentEl)
			.setName("Azure DevOps area path")
			.setDesc("Optional. Projects with an area path publish new items to Azure DevOps.")
			.addText((t) => {
				t.setPlaceholder("Devices\\Area\\Path");
				t.onChange((v) => (this.area = v));
			});
		new Setting(this.contentEl)
			.setName("Summary")
			.addComponent((el) => {
				const input = el.createEl("textarea", { cls: "ph-form-textarea", attr: { rows: "3", placeholder: "What is this project about?" } });
				input.addEventListener("input", () => (this.summary = input.value));
				return input as unknown as never;
			});
		new Setting(this.contentEl).addButton((b) =>
			b
				.setCta()
				.setButtonText("Create project")
				.onClick(() => void this.create()),
		);
	}

	private renderOwnerBtn(): void {
		this.ownerBtn.empty();
		if (this.owner) {
			const name = this.hub.store.displayName(this.owner);
			setIcon(this.ownerBtn.createSpan(), "user");
			this.ownerBtn.createSpan({ text: name });
		} else {
			this.ownerBtn.createSpan({ text: "Nobody" });
		}
	}

	private async create(): Promise<void> {
		const name = this.name.trim();
		if (!name) {
			new Notice("Give the project a name");
			return;
		}
		try {
			const extra: Record<string, unknown> = { [P.start]: this.start };
			if (this.owner) extra[P.owner] = this.hub.store.linkTo(this.owner, "");
			if (this.target) extra[P.target] = this.target;
			if (this.area.trim()) extra[P.adoArea] = this.area.trim();
			if (this.summary.trim()) extra[P.summary] = this.summary.trim();
			const file = await this.hub.store.createProject(name, extra);
			new Notice(`Created project ${name}`);
			void this.hub.openPath(file.path);
			this.close();
		} catch (e) {
			new Notice(e instanceof Error ? e.message : String(e));
		}
	}
}

// ---------------------------------------------------------------- new sprint

function defaultSprintStart(hub: Hub): string {
	const sprints = hub.store.sortedSprints();
	const last = sprints[sprints.length - 1];
	if (last?.end) return addDays(last.end, 1);
	// next Monday (a week ahead when today is Monday)
	const delta = (1 - parseDate(today())!.getDay() + 7) % 7 || 7;
	return addDays(today(), delta);
}

export class NewSprintModal extends Modal {
	private name: string;
	private start: string;
	private length: number;
	private goal = "";
	private capacity: number | null = null;

	constructor(private hub: Hub) {
		super(hub.app);
		this.modalEl.addClass("ph-form-modal");
		this.name = `Sprint ${hub.store.sortedSprints().length + 1}`;
		this.start = defaultSprintStart(hub);
		this.length = hub.settings.sprintLengthDays;
	}

	onOpen(): void {
		this.setTitle("New sprint");
		new Setting(this.contentEl).setName("Name").addText((t) => {
			t.setValue(this.name);
			t.onChange((v) => (this.name = v));
			window.setTimeout(() => {
				t.inputEl.focus();
				t.inputEl.select();
			}, 0);
		});
		new Setting(this.contentEl)
			.setName("Start")
			.addComponent((el) => {
				const input = el.createEl("input", { attr: { type: "date" } });
				input.value = this.start;
				input.addEventListener("change", () => (this.start = input.value || this.start));
				return input as unknown as never;
			});
		new Setting(this.contentEl)
			.setName("Length (days)")
			.addComponent((el) => {
				const input = el.createEl("input", { attr: { type: "number", min: "1", max: "60" } });
				input.value = String(this.length);
				input.addEventListener("change", () => (this.length = Math.max(1, Number(input.value) || this.length)));
				return input as unknown as never;
			});
		new Setting(this.contentEl)
			.setName("Goal")
			.addComponent((el) => {
				const input = el.createEl("textarea", { cls: "ph-form-textarea", attr: { rows: "2", placeholder: "What should this sprint achieve?" } });
				input.addEventListener("input", () => (this.goal = input.value));
				return input as unknown as never;
			});
		new Setting(this.contentEl)
			.setName("Capacity (points)")
			.setDesc("Used by the capacity bar on the sprint header")
			.addComponent((el) => {
				const input = el.createEl("input", { attr: { type: "number", min: "0" } });
				input.addEventListener("change", () => {
					const n = Number(input.value);
					this.capacity = input.value.trim() === "" || !isFinite(n) ? null : n;
				});
				return input as unknown as never;
			});
		new Setting(this.contentEl).addButton((b) =>
			b
				.setCta()
				.setButtonText("Create sprint")
				.onClick(() => void this.create()),
		);
	}

	private async create(): Promise<void> {
		const name = this.name.trim() || `Sprint ${this.hub.store.sortedSprints().length + 1}`;
		try {
			const end = addDays(this.start, this.length - 1);
			const extra: Record<string, unknown> = {};
			if (this.goal.trim()) extra[P.goal] = this.goal.trim();
			if (this.capacity !== null) extra[P.capacity] = this.capacity;
			const file = await this.hub.store.createSprint(name, this.start, end, extra);
			new Notice(`Created sprint ${name}`);
			void this.hub.openPath(file.path);
			this.close();
		} catch (e) {
			new Notice(e instanceof Error ? e.message : String(e));
		}
	}
}

// ---------------------------------------------------------------- new meeting

export class NewMeetingModal extends Modal {
	private title = "";
	private date = today();
	private project: string | null = null;
	private attendees = new Set<string>();
	private projectBtn!: HTMLButtonElement;

	constructor(private hub: Hub) {
		super(hub.app);
		this.modalEl.addClass("ph-form-modal");
		const me = hub.store.mePath();
		if (me) this.attendees.add(me);
	}

	onOpen(): void {
		this.setTitle("New meeting");
		new Setting(this.contentEl).setName("Title").addText((t) => {
			t.setPlaceholder("Weekly sync");
			t.onChange((v) => (this.title = v));
			window.setTimeout(() => t.inputEl.focus(), 0);
		});
		new Setting(this.contentEl)
			.setName("Date")
			.addComponent((el) => {
				const input = el.createEl("input", { attr: { type: "date" } });
				input.value = this.date;
				input.addEventListener("change", () => (this.date = input.value || today()));
				return input as unknown as never;
			});
		const projectSetting = new Setting(this.contentEl).setName("Project");
		this.projectBtn = projectSetting.controlEl.createEl("button", { cls: "ph-btn" });
		this.renderProjectBtn();
		this.projectBtn.addEventListener("click", () => {
			void pickProject(this.hub).then((p) => {
				if (p === undefined) return;
				this.project = p;
				this.renderProjectBtn();
			});
		});
		new Setting(this.contentEl)
			.setName("Attendees")
			.addComponent((el) => {
				const wrap = el.createDiv({ cls: "ph-form-people" });
				for (const person of [...this.hub.store.people.values()].sort((a, b) => a.name.localeCompare(b.name))) {
					const row = wrap.createDiv({ cls: "ph-form-person" });
					const box = row.createEl("input", { attr: { type: "checkbox" } });
					box.checked = this.attendees.has(person.path);
					box.addEventListener("change", () => {
						if (box.checked) this.attendees.add(person.path);
						else this.attendees.delete(person.path);
					});
					row.createSpan({ text: person.name + (person.role ? ` · ${person.role}` : "") });
				}
				if (!this.hub.store.people.size) wrap.createSpan({ cls: "ph-faint", text: "No people yet — create person notes first." });
				return wrap as unknown as never;
			});
		new Setting(this.contentEl).addButton((b) =>
			b
				.setCta()
				.setButtonText("Create meeting")
				.onClick(() => void this.create()),
		);
	}

	private renderProjectBtn(): void {
		this.projectBtn.empty();
		setIcon(this.projectBtn.createSpan(), "folder");
		this.projectBtn.createSpan({ text: this.project ? this.hub.store.displayName(this.project) : "None" });
	}

	private async create(): Promise<void> {
		const title = this.title.trim();
		if (!title) {
			new Notice("Give the meeting a title");
			return;
		}
		try {
			const folder = this.hub.settings.folders.meetings;
			await this.hub.store.ensureFolder(folder);
			const path = `${folder}/${this.date} ${sanitizeFilename(title)}.md`.replace(/\/+/g, "/");
			const fm: Record<string, unknown> = {
				kind: "meeting",
				title,
				date: this.date,
				[P.project]: this.project ? this.hub.store.linkTo(this.project, "") : null,
				attendees: [...this.attendees].map((p) => this.hub.store.linkTo(p, "")),
			};
			const body = [
				"## Agenda",
				"",
				"- ",
				"",
				"## Notes",
				"",
				"",
				"## Decisions",
				"",
				"- ",
				"",
				"## Action items",
				"",
				"- [ ] ",
				"",
			].join("\n");
			const file = await this.hub.app.vault.create(path, frontmatter(fm) + body);
			new Notice(`Created meeting ${title}`);
			void this.hub.openPath(file.path);
			this.close();
		} catch (e) {
			new Notice(e instanceof Error ? e.message : String(e));
		}
	}
}
