import { App, FuzzyMatch, FuzzySuggestModal, renderResults } from "obsidian";
import type { Hub } from "../core/hub";
import type { Person, Project, Sprint, WorkItem } from "../core/model";

// Fuzzy pickers for linking notes. Each resolves with the chosen vault path, or null for "none".

interface Choice {
	path: string | null;
	label: string;
	detail?: string;
	create?: boolean;
}

class ChoiceModal extends FuzzySuggestModal<Choice> {
	private done = false;

	constructor(
		app: App,
		private choices: Choice[],
		placeholder: string,
		private resolve: (c: Choice | null) => void,
		private onCreate?: (query: string) => Promise<string | null>,
	) {
		super(app);
		this.setPlaceholder(placeholder);
		this.setInstructions([
			{ command: "↑↓", purpose: "navigate" },
			{ command: "↵", purpose: "choose" },
			...(onCreate ? [{ command: "shift ↵", purpose: "create new" }] : []),
			{ command: "esc", purpose: "dismiss" },
		]);
		if (onCreate) {
			this.scope.register(["Shift"], "Enter", (e) => {
				e.preventDefault();
				const q = this.inputEl.value.trim();
				if (!q) return false;
				this.done = true;
				this.close();
				void onCreate(q).then((p) => this.resolve(p ? { path: p, label: q } : null));
				return false;
			});
		}
	}

	getItems(): Choice[] {
		const q = this.inputEl.value.trim();
		if (this.onCreate && q && !this.choices.some((c) => c.label.toLowerCase() === q.toLowerCase())) {
			return [...this.choices, { path: null, label: q, create: true }];
		}
		return this.choices;
	}

	getItemText(c: Choice): string {
		return c.detail ? `${c.label} ${c.detail}` : c.label;
	}

	renderSuggestion(match: FuzzyMatch<Choice>, el: HTMLElement): void {
		const c = match.item;
		el.addClass("ph-suggestion");
		if (c.create) {
			el.createSpan({ text: `Create “${c.label}”`, cls: "ph-suggestion-create" });
			return;
		}
		const title = el.createDiv({ cls: "ph-suggestion-title" });
		renderResults(title, c.label, match.match);
		if (c.detail) el.createDiv({ cls: "ph-suggestion-detail", text: c.detail });
	}

	onChooseItem(c: Choice): void {
		this.done = true;
		if (c.create && this.onCreate) {
			void this.onCreate(c.label).then((p) => this.resolve(p ? { path: p, label: c.label } : null));
			return;
		}
		this.resolve(c);
	}

	onClose(): void {
		super.onClose();
		// onChooseItem runs after onClose; defer so a choice wins over dismissal.
		window.setTimeout(() => {
			if (!this.done) this.resolve(null);
		}, 0);
	}
}

function pick(app: App, choices: Choice[], placeholder: string, onCreate?: (q: string) => Promise<string | null>): Promise<Choice | null> {
	return new Promise((resolve) => {
		let settled = false;
		const once = (c: Choice | null) => {
			if (settled) return;
			settled = true;
			resolve(c);
		};
		new ChoiceModal(app, choices, placeholder, once, onCreate).open();
	});
}

const NONE: Choice = { path: null, label: "— None —" };

/** Returns undefined when dismissed, null when "None" chosen, otherwise the path. */
export async function pickPerson(hub: Hub, opts: { allowNone?: boolean; allowCreate?: boolean } = {}): Promise<string | null | undefined> {
	const me = hub.store.mePath();
	const people = [...hub.store.people.values()].sort((a, b) => (a.path === me ? -1 : b.path === me ? 1 : a.name.localeCompare(b.name)));
	const choices: Choice[] = people.map((p: Person) => ({ path: p.path, label: p.name, detail: [p.path === me ? "me" : "", p.email ?? "", p.role ?? ""].filter(Boolean).join(" · ") }));
	if (opts.allowNone !== false) choices.unshift(NONE);
	const c = await pick(hub.app, choices, "Assign to…", opts.allowCreate === false ? undefined : async (q) => (await hub.store.createPerson(q)).path);
	return c === null ? undefined : c.path;
}

export async function pickProject(hub: Hub, opts: { allowNone?: boolean; allowCreate?: boolean } = {}): Promise<string | null | undefined> {
	const projects = [...hub.store.projects.values()].sort((a, b) => statusRank(a) - statusRank(b) || a.name.localeCompare(b.name));
	const choices: Choice[] = projects.map((p: Project) => ({ path: p.path, label: p.name, detail: [p.status, p.health ?? ""].filter(Boolean).join(" · ") }));
	if (opts.allowNone !== false) choices.unshift(NONE);
	const c = await pick(hub.app, choices, "Project…", opts.allowCreate === false ? undefined : async (q) => (await hub.store.createProject(q)).path);
	return c === null ? undefined : c.path;
}

function statusRank(p: Project): number {
	return ["Active", "Planning", "On Hold", "Done", "Cancelled"].indexOf(p.status) + 1 || 9;
}

export async function pickSprint(hub: Hub, opts: { allowNone?: boolean; includePast?: boolean } = {}): Promise<string | null | undefined> {
	const order = { Current: 0, Future: 1, Past: 2 } as const;
	let sprints = hub.store.sortedSprints();
	if (!opts.includePast) sprints = sprints.filter((s) => s.state !== "Past");
	sprints.sort((a, b) => (order[a.state ?? "Future"] - order[b.state ?? "Future"]) || (a.start ?? "").localeCompare(b.start ?? ""));
	const choices: Choice[] = sprints.map((s: Sprint) => ({ path: s.path, label: s.name, detail: [s.state ?? "", s.start && s.end ? `${s.start} → ${s.end}` : ""].filter(Boolean).join(" · ") }));
	if (opts.allowNone !== false) choices.unshift({ path: null, label: "— Backlog (no sprint) —" });
	const c = await pick(hub.app, choices, "Sprint…");
	return c === null ? undefined : c.path;
}

export async function pickItem(hub: Hub, opts: { exclude?: Set<string>; allowNone?: boolean; placeholder?: string; filter?: (i: WorkItem) => boolean } = {}): Promise<string | null | undefined> {
	const items = hub.store
		.allItems()
		.filter((i) => !opts.exclude?.has(i.path) && (!opts.filter || opts.filter(i)))
		.sort((a, b) => Number(hub.store.isDone(a)) - Number(hub.store.isDone(b)) || b.mtime - a.mtime);
	const choices: Choice[] = items.map((i) => ({
		path: i.path,
		label: i.title,
		detail: [i.id, i.type, i.status, i.adoId ? `ADO ${i.adoId}` : ""].filter(Boolean).join(" · "),
	}));
	if (opts.allowNone) choices.unshift(NONE);
	const c = await pick(hub.app, choices, opts.placeholder ?? "Work item…");
	return c === null ? undefined : c.path;
}

export async function pickFrom<T extends string>(app: App, values: readonly T[], placeholder: string): Promise<T | undefined> {
	const c = await pick(
		app,
		values.map((v) => ({ path: v, label: v })),
		placeholder,
	);
	return (c?.path as T) ?? undefined;
}
