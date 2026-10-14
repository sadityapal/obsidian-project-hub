import { App, Events, TFile, debounce, normalizePath } from "obsidian";
import {
	Entity,
	Kind,
	P,
	Person,
	Project,
	Sprint,
	StatusCategory,
	StatusDef,
	TypeDef,
	WorkItem,
} from "./model";
import type { HubSettings } from "./settings";
import {
	asBool,
	asList,
	asNumber,
	asString,
	itemFileBase,
	normDate,
	parseWikilink,
	sanitizeFilename,
	splitItemBase,
	today,
} from "./util";

/** Body sections that sync with Azure DevOps rich-text fields. */
export const SECTION = {
	description: "Description",
	repro: "Repro steps",
	acceptance: "Acceptance criteria",
	checklist: "Checklist",
	notes: "Notes",
	children: "Child items",
} as const;

export interface NewItemOptions {
	title: string;
	type?: string;
	status?: string;
	priority?: number | null;
	/** Vault paths of linked notes. */
	assignee?: string | null;
	project?: string | null;
	parent?: string | null;
	sprint?: string | null;
	start?: string | null;
	due?: string | null;
	points?: number | null;
	labels?: string[];
	description?: string;
	adoSync?: boolean;
	/** Extra frontmatter written as-is (used by ADO import). */
	extra?: Record<string, unknown>;
	/** Explicit id (ADO imports use ADO-<n>). Allocated when omitted. */
	id?: string;
}

export interface Rollup {
	total: number;
	done: number;
	open: number;
	points: number;
	pointsDone: number;
	/** 0–100, by points when every child has points, otherwise by count. */
	progress: number;
	blocked: number;
	overdue: number;
}

type Patch = Record<string, unknown>;

/**
 * In-memory index of every Project Hub note, built from Obsidian's metadata cache.
 *
 * Events:
 * - "changed" (): debounced after any entity change; views re-render on this.
 * - "item-status" (item: WorkItem, from: string | null): a work item's status changed.
 */
export class HubStore extends Events {
	readonly items = new Map<string, WorkItem>();
	readonly projects = new Map<string, Project>();
	readonly sprints = new Map<string, Sprint>();
	readonly people = new Map<string, Person>();

	private byId = new Map<string, string>();
	private childIndex: Map<string, string[]> | null = null;
	private ready = false;
	/** Paths we are renaming ourselves, so the rename handler does not rewrite titles. */
	private ownRenames = new Set<string>();
	private pendingRenames = new Set<string>();
	private lastStatus = new Map<string, string>();

	constructor(
		private app: App,
		private getSettings: () => HubSettings,
		private saveSettings: () => Promise<void>,
	) {
		super();
	}

	get settings(): HubSettings {
		return this.getSettings();
	}

	isReady(): boolean {
		return this.ready;
	}

	// ---------------------------------------------------------------- indexing

	/** Full rebuild. Called once on layout ready and whenever links may have changed meaning. */
	reindexAll(): void {
		this.items.clear();
		this.projects.clear();
		this.sprints.clear();
		this.people.clear();
		this.byId.clear();
		// People and sprints first so item links resolve to known entities.
		const files = this.app.vault.getMarkdownFiles();
		const order: Kind[] = ["person", "sprint", "project", "work-item"];
		const kinds = new Map<TFile, Kind>();
		for (const f of files) {
			const k = this.app.metadataCache.getFileCache(f)?.frontmatter?.[P.kind];
			if (k === "work-item" || k === "project" || k === "sprint" || k === "person") kinds.set(f, k);
		}
		for (const kind of order) for (const [f, k] of kinds) if (k === kind) this.parse(f, false);
		this.childIndex = null;
		const firstBuild = !this.ready;
		this.ready = true;
		if (firstBuild) for (const it of this.items.values()) this.lastStatus.set(it.path, it.status);
		this.changedSoon();
	}

	/** Re-parses one file. Returns the entity kind or null. */
	parse(file: TFile, emit = true): Kind | null {
		this.remove(file.path, false);
		const cache = this.app.metadataCache.getFileCache(file);
		const fm = cache?.frontmatter;
		const kind = fm?.[P.kind];
		let entity: Entity | null = null;
		if (kind === "work-item") entity = this.parseItem(file, fm!);
		else if (kind === "project") entity = this.parseProject(file, fm!);
		else if (kind === "sprint") entity = this.parseSprint(file, fm!);
		else if (kind === "person") entity = this.parsePerson(file, fm!);
		if (!entity) {
			if (emit) this.changedSoon();
			return null;
		}
		switch (entity.kind) {
			case "work-item": {
				this.items.set(file.path, entity);
				if (entity.id) this.byId.set(entity.id.toLowerCase(), file.path);
				if (this.ready) {
					const prev = this.lastStatus.get(file.path);
					if (prev !== undefined && prev !== entity.status) this.trigger("item-status", entity, prev);
					this.lastStatus.set(file.path, entity.status);
					this.maybeRename(entity);
				}
				break;
			}
			case "project":
				this.projects.set(file.path, entity);
				break;
			case "sprint":
				this.sprints.set(file.path, entity);
				break;
			case "person":
				this.people.set(file.path, entity);
				break;
		}
		this.childIndex = null;
		if (emit) this.changedSoon();
		return entity.kind;
	}

	remove(path: string, emit = true): void {
		const it = this.items.get(path);
		if (it) {
			if (it.id && this.byId.get(it.id.toLowerCase()) === path) this.byId.delete(it.id.toLowerCase());
			this.items.delete(path);
		}
		this.projects.delete(path);
		this.sprints.delete(path);
		this.people.delete(path);
		this.childIndex = null;
		if (emit) this.changedSoon();
	}

	/** Called from the vault rename event. */
	onRename(file: TFile, oldPath: string): void {
		const old = this.items.get(oldPath);
		const status = this.lastStatus.get(oldPath);
		this.lastStatus.delete(oldPath);
		if (status !== undefined) this.lastStatus.set(file.path, status);
		this.remove(oldPath, false);
		const ours = this.ownRenames.delete(file.path);
		// A user rename of "PH-1 Old" to "PH-1 New" updates the title property.
		if (!ours && old && old.id) {
			const title = splitItemBase(file.basename, old.id);
			if (title && title !== old.title) void this.update(file.path, { [P.title]: title });
		}
		this.reindexSoon();
	}

	private changedSoon = debounce(() => this.trigger("changed"), 120, true);
	reindexSoon = debounce(() => this.reindexAll(), 400, true);

	private link(value: unknown, source: string): { path: string | null; name: string | null } {
		const raw = asString(value);
		if (!raw) return { path: null, name: null };
		const wl = parseWikilink(raw);
		const linkpath = wl ? wl.path : raw;
		const dest = this.app.metadataCache.getFirstLinkpathDest(linkpath, source);
		const name = wl?.alias ?? (dest ? dest.basename : linkpath.split("/").pop() ?? linkpath);
		return { path: dest ? dest.path : null, name };
	}

	private links(value: unknown, source: string): string[] {
		return asList(value)
			.map((v) => this.link(v, source).path)
			.filter((v): v is string => !!v);
	}

	private parseItem(file: TFile, fm: Record<string, unknown>): WorkItem {
		const id = asString(fm[P.id]) ?? "";
		const assignee = this.link(fm[P.assignee], file.path);
		const title = asString(fm[P.title]) ?? (id ? splitItemBase(file.basename, id) : null) ?? file.basename;
		return {
			kind: "work-item",
			path: file.path,
			basename: file.basename,
			id,
			title,
			type: asString(fm[P.type]) ?? this.settings.defaultType,
			status: asString(fm[P.status]) ?? this.settings.statuses[0]?.name ?? "To Do",
			priority: asNumber(fm[P.priority]),
			assignee: assignee.path ?? assignee.name,
			assigneeName: assignee.name,
			project: this.link(fm[P.project], file.path).path,
			parent: this.link(fm[P.parent], file.path).path,
			sprint: this.link(fm[P.sprint], file.path).path,
			start: normDate(fm[P.start]),
			due: normDate(fm[P.due]),
			points: asNumber(fm[P.points]),
			estimate: asNumber(fm[P.estimate]),
			remaining: asNumber(fm[P.remaining]),
			completed: asNumber(fm[P.completed]),
			labels: asList(fm[P.labels]),
			blockedBy: this.links(fm[P.blockedBy], file.path),
			started: normDate(fm[P.started]),
			closed: normDate(fm[P.closed]),
			created: normDate(fm[P.created]) ?? normDate(new Date(file.stat.ctime)),
			progress: asNumber(fm[P.progress]),
			rank: asNumber(fm[P.rank]),
			area: asString(fm[P.area]),
			adoId: asNumber(fm[P.adoId]),
			adoUrl: asString(fm[P.adoUrl]),
			adoType: asString(fm[P.adoType]),
			adoState: asString(fm[P.adoState]),
			adoSync: fm[P.adoSync] === undefined ? asNumber(fm[P.adoId]) !== null : asBool(fm[P.adoSync]),
			mtime: file.stat.mtime,
			ctime: file.stat.ctime,
		};
	}

	private parseProject(file: TFile, fm: Record<string, unknown>): Project {
		return {
			kind: "project",
			path: file.path,
			basename: file.basename,
			name: file.basename,
			status: asString(fm[P.status]) ?? "Active",
			priority: asNumber(fm[P.priority]),
			owner: this.link(fm[P.owner], file.path).path,
			start: normDate(fm[P.start]),
			target: normDate(fm[P.target]),
			health: asString(fm[P.health]),
			summary: asString(fm[P.summary]),
			adoArea: asString(fm[P.adoArea]),
			adoEpics: asList(fm[P.adoEpics])
				.map((v) => asNumber(v))
				.filter((v): v is number => v !== null),
			progress: asNumber(fm[P.progress]),
			mtime: file.stat.mtime,
		};
	}

	private parseSprint(file: TFile, fm: Record<string, unknown>): Sprint {
		const start = normDate(fm[P.start]);
		const end = normDate(fm[P.end]);
		return {
			kind: "sprint",
			path: file.path,
			basename: file.basename,
			name: file.basename,
			start,
			end,
			goal: asString(fm[P.goal]),
			adoPath: asString(fm[P.adoPath]),
			capacity: asNumber(fm[P.capacity]),
			state: sprintState(start, end),
		};
	}

	private parsePerson(file: TFile, fm: Record<string, unknown>): Person {
		return {
			kind: "person",
			path: file.path,
			basename: file.basename,
			name: file.basename,
			email: asString(fm[P.email])?.toLowerCase() ?? null,
			role: asString(fm[P.role]),
		};
	}

	// ---------------------------------------------------------------- queries

	allItems(): WorkItem[] {
		return [...this.items.values()];
	}

	getItem(path: string | null | undefined): WorkItem | null {
		return path ? this.items.get(path) ?? null : null;
	}

	getItemById(id: string): WorkItem | null {
		const p = this.byId.get(id.toLowerCase());
		return p ? this.items.get(p) ?? null : null;
	}

	getEntity(path: string): Entity | null {
		return this.items.get(path) ?? this.projects.get(path) ?? this.sprints.get(path) ?? this.people.get(path) ?? null;
	}

	private ensureChildIndex(): Map<string, string[]> {
		if (this.childIndex) return this.childIndex;
		const idx = new Map<string, string[]>();
		for (const it of this.items.values()) {
			if (!it.parent) continue;
			const arr = idx.get(it.parent);
			if (arr) arr.push(it.path);
			else idx.set(it.parent, [it.path]);
		}
		this.childIndex = idx;
		return idx;
	}

	children(path: string): WorkItem[] {
		return (this.ensureChildIndex().get(path) ?? []).map((p) => this.items.get(p)!).filter(Boolean);
	}

	/** All descendants, depth-first, guarding against parent cycles. */
	descendants(path: string): WorkItem[] {
		const out: WorkItem[] = [];
		const seen = new Set<string>([path]);
		const walk = (p: string) => {
			for (const c of this.children(p)) {
				if (seen.has(c.path)) continue;
				seen.add(c.path);
				out.push(c);
				walk(c.path);
			}
		};
		walk(path);
		return out;
	}

	/** Parent chain, nearest first. */
	ancestors(path: string): WorkItem[] {
		const out: WorkItem[] = [];
		const seen = new Set<string>([path]);
		let cur = this.items.get(path)?.parent ?? null;
		while (cur && !seen.has(cur)) {
			seen.add(cur);
			const it = this.items.get(cur);
			if (!it) break;
			out.push(it);
			cur = it.parent;
		}
		return out;
	}

	/** The project of an item, inherited from the nearest ancestor that has one. */
	effectiveProject(item: WorkItem): string | null {
		if (item.project) return item.project;
		for (const a of this.ancestors(item.path)) if (a.project) return a.project;
		return null;
	}

	projectItems(projectPath: string): WorkItem[] {
		return this.allItems().filter((it) => this.effectiveProject(it) === projectPath);
	}

	sprintItems(sprintPath: string): WorkItem[] {
		return this.allItems().filter((it) => it.sprint === sprintPath);
	}

	personItems(personPath: string): WorkItem[] {
		return this.allItems().filter((it) => it.assignee === personPath);
	}

	sortedSprints(): Sprint[] {
		return [...this.sprints.values()].sort((a, b) => (a.start ?? "").localeCompare(b.start ?? "") || a.name.localeCompare(b.name));
	}

	currentSprint(): Sprint | null {
		const cur = this.sortedSprints().filter((s) => s.state === "Current");
		// With overlapping team calendars prefer the one that has the most of my work.
		if (cur.length <= 1) return cur[0] ?? null;
		const me = this.mePath();
		const score = (s: Sprint) => this.sprintItems(s.path).filter((i) => !me || i.assignee === me).length;
		return cur.sort((a, b) => score(b) - score(a))[0];
	}

	futureSprints(): Sprint[] {
		return this.sortedSprints().filter((s) => s.state === "Future");
	}

	nextSprint(): Sprint | null {
		return this.futureSprints()[0] ?? null;
	}

	personByEmail(email: string | null | undefined): Person | null {
		if (!email) return null;
		const e = email.toLowerCase();
		for (const p of this.people.values()) if (p.email === e) return p;
		return null;
	}

	personByName(name: string): Person | null {
		const n = name.toLowerCase();
		for (const p of this.people.values()) if (p.name.toLowerCase() === n) return p;
		return null;
	}

	mePath(): string | null {
		const me = this.settings.me;
		if (!me) return null;
		return this.personByName(me)?.path ?? null;
	}

	statusDef(name: string | null | undefined): StatusDef | null {
		if (!name) return null;
		const n = name.toLowerCase();
		return this.settings.statuses.find((s) => s.name.toLowerCase() === n) ?? null;
	}

	statusCategory(name: string | null | undefined): StatusCategory {
		return this.statusDef(name)?.category ?? "proposed";
	}

	/** First status of a category, e.g. the status to use for "completed". */
	statusFor(category: StatusCategory, blocked = false): string {
		const s = this.settings.statuses;
		return (
			s.find((d) => d.category === category && !!d.blocked === blocked)?.name ??
			s.find((d) => d.category === category)?.name ??
			s[0].name
		);
	}

	isDone(item: WorkItem): boolean {
		const c = this.statusCategory(item.status);
		return c === "completed" || c === "removed";
	}

	isRemoved(item: WorkItem): boolean {
		return this.statusCategory(item.status) === "removed";
	}

	isBlocked(item: WorkItem): boolean {
		if (this.statusDef(item.status)?.blocked) return true;
		return item.blockedBy.some((p) => {
			const b = this.items.get(p);
			return !!b && !this.isDone(b);
		});
	}

	isOverdue(item: WorkItem, on = today()): boolean {
		return !!item.due && item.due < on && !this.isDone(item);
	}

	typeDef(name: string | null | undefined): TypeDef | null {
		if (!name) return null;
		const n = name.toLowerCase();
		return this.settings.types.find((t) => t.name.toLowerCase() === n) ?? null;
	}

	typeIcon(name: string | null | undefined): string {
		return this.typeDef(name)?.icon ?? "circle-dot";
	}

	rollupOf(items: WorkItem[]): Rollup {
		const live = items.filter((i) => !this.isRemoved(i));
		const done = live.filter((i) => this.isDone(i));
		const allPointed = live.length > 0 && live.every((i) => i.points !== null);
		const points = live.reduce((s, i) => s + (i.points ?? 0), 0);
		const pointsDone = done.reduce((s, i) => s + (i.points ?? 0), 0);
		const progress = live.length === 0 ? 0 : allPointed && points > 0 ? (pointsDone / points) * 100 : (done.length / live.length) * 100;
		const t = today();
		return {
			total: live.length,
			done: done.length,
			open: live.length - done.length,
			points,
			pointsDone,
			progress: Math.round(progress),
			blocked: live.filter((i) => !this.isDone(i) && this.isBlocked(i)).length,
			overdue: live.filter((i) => this.isOverdue(i, t)).length,
		};
	}

	/** Rollup over descendants (items) or all project items (projects). */
	rollup(path: string): Rollup {
		if (this.projects.has(path)) return this.rollupOf(this.projectItems(path));
		if (this.sprints.has(path)) return this.rollupOf(this.sprintItems(path));
		return this.rollupOf(this.descendants(path));
	}

	// ---------------------------------------------------------------- links & names

	/** `[[linktext]]` for a vault path, relative to an optional source note. */
	linkTo(path: string, sourcePath = ""): string {
		const f = this.app.vault.getFileByPath(path);
		if (!f) return `[[${path.replace(/\.md$/, "")}]]`;
		return `[[${this.app.metadataCache.fileToLinktext(f, sourcePath, true)}]]`;
	}

	displayName(path: string | null | undefined): string {
		if (!path) return "";
		const e = this.getEntity(path);
		if (e?.kind === "work-item") return e.title;
		return e ? e.basename : path.split("/").pop()!.replace(/\.md$/, "");
	}

	// ---------------------------------------------------------------- mutations

	/**
	 * Writes frontmatter. `null`, `undefined`, `""` and empty arrays delete the key.
	 * Values that look like vault paths are not converted; pass links via linkTo().
	 */
	async update(path: string, patch: Patch): Promise<void> {
		const file = this.app.vault.getFileByPath(path);
		if (!file) throw new Error(`Note not found: ${path}`);
		await this.app.fileManager.processFrontMatter(file, (fm) => applyPatch(fm, patch));
	}

	/** Builds the patch for a status change, including started/closed stamps. */
	statusPatch(item: WorkItem, status: string): Patch {
		const patch: Patch = { [P.status]: status };
		if (!this.settings.stampDates) return patch;
		const to = this.statusCategory(status);
		const t = today();
		if ((to === "inProgress" || to === "resolved") && !item.started) patch[P.started] = t;
		if (to === "completed") {
			if (!item.closed) patch[P.closed] = t;
			if (!item.started) patch[P.started] = item.created && item.created < t ? item.created : t;
		} else if (to !== "removed" && item.closed) {
			patch[P.closed] = null;
		}
		return patch;
	}

	async setStatus(path: string, status: string): Promise<void> {
		const item = this.items.get(path);
		if (!item) throw new Error(`Not a work item: ${path}`);
		if (item.status === status) return;
		await this.update(path, this.statusPatch(item, status));
	}

	/** Sets a link-valued property (assignee, project, parent, sprint) from a target path or null. */
	async setLink(path: string, key: string, target: string | null): Promise<void> {
		await this.update(path, { [key]: target ? this.linkTo(target, path) : null });
	}

	async allocateId(): Promise<string> {
		const s = this.settings;
		let n = Math.max(1, s.nextId);
		while (this.byId.has(`${s.idPrefix}-${n}`.toLowerCase())) n++;
		s.nextId = n + 1;
		await this.saveSettings();
		return `${s.idPrefix}-${n}`;
	}

	async ensureFolder(folder: string): Promise<void> {
		const path = normalizePath(folder);
		if (!path || path === "/") return;
		if (this.app.vault.getFolderByPath(path)) return;
		await this.app.vault.createFolder(path).catch(() => undefined);
	}

	private async uniquePath(folder: string, base: string): Promise<string> {
		await this.ensureFolder(folder);
		let candidate = normalizePath(`${folder}/${base}.md`);
		let i = 2;
		while (this.app.vault.getAbstractFileByPath(candidate)) candidate = normalizePath(`${folder}/${base} ${i++}.md`);
		return candidate;
	}

	async createItem(opts: NewItemOptions): Promise<TFile> {
		const s = this.settings;
		const id = opts.id ?? (await this.allocateId());
		const title = opts.title.trim() || "Untitled";
		const type = opts.type ?? s.defaultType;
		if (!opts.project && opts.parent) {
			const parent = this.items.get(opts.parent);
			if (parent) opts = { ...opts, project: this.effectiveProject(parent) };
		}
		const path = await this.uniquePath(s.folders.items, itemFileBase(id, title));
		const fm: Patch = {
			[P.kind]: "work-item",
			[P.id]: id,
			[P.title]: title,
			[P.type]: type,
			[P.status]: opts.status ?? this.statusFor("proposed"),
			[P.priority]: opts.priority ?? 3,
			[P.assignee]: opts.assignee ? this.linkTo(opts.assignee, path) : null,
			[P.project]: opts.project ? this.linkTo(opts.project, path) : null,
			[P.parent]: opts.parent ? this.linkTo(opts.parent, path) : null,
			[P.sprint]: opts.sprint ? this.linkTo(opts.sprint, path) : null,
			[P.start]: opts.start ?? null,
			[P.due]: opts.due ?? null,
			[P.points]: opts.points ?? null,
			[P.labels]: opts.labels?.length ? opts.labels : null,
			[P.created]: today(),
			[P.adoSync]: opts.adoSync ? true : null,
			...(opts.extra ?? {}),
		};
		const cat = this.statusCategory(fm[P.status] as string);
		if (s.stampDates && (cat === "inProgress" || cat === "resolved") && !fm[P.started]) fm[P.started] = today();
		if (s.stampDates && cat === "completed" && !fm[P.closed]) fm[P.closed] = today();
		const body = itemBody(type, this.typeDef(type), opts.description ?? "");
		return this.app.vault.create(path, frontmatter(fm) + body);
	}

	async createProject(name: string, extra: Patch = {}): Promise<TFile> {
		const s = this.settings;
		const path = await this.uniquePath(s.folders.projects, sanitizeFilename(name));
		const fm: Patch = {
			[P.kind]: "project",
			[P.status]: "Planning",
			[P.health]: "On Track",
			[P.priority]: 2,
			[P.owner]: this.mePath() ? this.linkTo(this.mePath()!, path) : null,
			[P.start]: today(),
			[P.target]: null,
			[P.summary]: null,
			[P.progress]: 0,
			...extra,
		};
		return this.app.vault.create(path, frontmatter(fm) + projectBody());
	}

	async createSprint(name: string, start: string, end: string, extra: Patch = {}): Promise<TFile> {
		const s = this.settings;
		const path = await this.uniquePath(s.folders.sprints, sanitizeFilename(name));
		const fm: Patch = { [P.kind]: "sprint", [P.start]: start, [P.end]: end, [P.goal]: null, [P.capacity]: null, ...extra };
		return this.app.vault.create(path, frontmatter(fm) + sprintBody());
	}

	async createPerson(name: string, extra: Patch = {}): Promise<TFile> {
		const s = this.settings;
		const path = await this.uniquePath(s.folders.people, sanitizeFilename(name));
		const fm: Patch = { [P.kind]: "person", [P.email]: null, [P.role]: null, ...extra };
		return this.app.vault.create(path, frontmatter(fm) + personBody());
	}

	/** Keeps "<id> <title>" file names in sync with the title property. */
	private maybeRename(item: WorkItem): void {
		if (!this.settings.renameOnTitleChange || !item.id) return;
		const want = itemFileBase(item.id, item.title);
		if (item.basename === want || item.basename.startsWith(want + " ")) return;
		if (this.pendingRenames.has(item.path)) return;
		this.pendingRenames.add(item.path);
		window.setTimeout(async () => {
			this.pendingRenames.delete(item.path);
			const file = this.app.vault.getFileByPath(item.path);
			const cur = this.items.get(item.path);
			if (!file || !cur || itemFileBase(cur.id, cur.title) !== want) return;
			const folder = file.parent?.path ?? "";
			let target = normalizePath(`${folder}/${want}.md`);
			let i = 2;
			while (this.app.vault.getAbstractFileByPath(target)) target = normalizePath(`${folder}/${want} ${i++}.md`);
			this.ownRenames.add(target);
			try {
				await this.app.fileManager.renameFile(file, target);
			} catch (e) {
				this.ownRenames.delete(target);
				console.error("Project Hub: rename failed", e);
			}
		}, 600);
	}

	// ---------------------------------------------------------------- rollups

	/**
	 * Keeps derived frontmatter current so Bases filters and columns can use it:
	 * rollups (progress, counts) on projects/parents/people, inherited project on
	 * descendants, and Past/Current/Future state on sprints. Only writes values that changed.
	 */
	async maintain(): Promise<void> {
		const jobs: [string, Patch][] = [];
		for (const sp of this.sprints.values()) {
			const patch: Patch = { [P.state]: sp.state };
			if (differs(this.app, sp.path, patch)) jobs.push([sp.path, patch]);
		}
		for (const it of this.items.values()) {
			if (it.project) continue;
			const inherited = this.effectiveProject(it);
			if (inherited) jobs.push([it.path, { [P.project]: this.linkTo(inherited, it.path) }]);
		}
		if (!this.settings.writeRollups) return this.runJobs(jobs);
		for (const proj of this.projects.values()) {
			const r = this.rollup(proj.path);
			const patch: Patch = {
				[P.progress]: r.progress,
				[P.itemsTotal]: r.total,
				[P.itemsDone]: r.done,
				[P.pointsTotal]: r.points,
				[P.pointsDone]: r.pointsDone,
			};
			if (differs(this.app, proj.path, patch)) jobs.push([proj.path, patch]);
		}
		const parents = new Set(this.ensureChildIndex().keys());
		for (const it of this.items.values()) {
			const hasKids = parents.has(it.path);
			if (!hasKids && it.progress === null) continue;
			// Parents (epics, features) carry the same rollup shape as projects so
			// portfolio views can show counts and points next to the progress bar.
			const patch: Patch = hasKids
				? {
						[P.progress]: this.rollup(it.path).progress,
						[P.itemsTotal]: this.rollup(it.path).total,
						[P.itemsDone]: this.rollup(it.path).done,
						[P.pointsTotal]: this.rollup(it.path).points,
						[P.pointsDone]: this.rollup(it.path).pointsDone,
					}
				: { [P.progress]: null };
			if (differs(this.app, it.path, patch)) jobs.push([it.path, patch]);
		}
		for (const sp of this.sprints.values()) {
			const r = this.rollup(sp.path);
			const patch: Patch = {
				[P.progress]: r.progress,
				[P.itemsTotal]: r.total,
				[P.itemsDone]: r.done,
				[P.pointsTotal]: r.points,
				[P.pointsDone]: r.pointsDone,
			};
			if (differs(this.app, sp.path, patch)) jobs.push([sp.path, patch]);
		}
		for (const person of this.people.values()) {
			const open = this.personItems(person.path).filter((i) => !this.isDone(i));
			const patch: Patch = {
				[P.openItems]: open.length,
				[P.openPoints]: open.reduce((s, i) => s + (i.points ?? 0), 0),
			};
			if (differs(this.app, person.path, patch)) jobs.push([person.path, patch]);
		}
		return this.runJobs(jobs);
	}

	private async runJobs(jobs: [string, Patch][]): Promise<void> {
		for (const [path, patch] of jobs) {
			try {
				await this.update(path, patch);
			} catch (e) {
				console.error("Project Hub: maintenance write failed", path, e);
			}
		}
	}
}

export function sprintState(start: string | null, end: string | null, on = today()): Sprint["state"] {
	if (!start || !end) return null;
	if (on < start) return "Future";
	if (on > end) return "Past";
	return "Current";
}

function isEmpty(v: unknown): boolean {
	return v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
}

export function applyPatch(fm: Record<string, unknown>, patch: Patch): void {
	for (const [k, v] of Object.entries(patch)) {
		if (isEmpty(v)) delete fm[k];
		else fm[k] = v;
	}
}

function differs(app: App, path: string, patch: Patch): boolean {
	const f = app.vault.getFileByPath(path);
	const fm = f ? app.metadataCache.getFileCache(f)?.frontmatter ?? {} : {};
	for (const [k, v] of Object.entries(patch)) {
		const cur = fm[k];
		if (isEmpty(v) && isEmpty(cur)) continue;
		if (cur !== v) return true;
	}
	return false;
}

/** Serialises frontmatter with stable key order; skips empty values. */
export function frontmatter(fm: Patch): string {
	const lines = ["---"];
	for (const [k, v] of Object.entries(fm)) {
		if (isEmpty(v)) continue;
		lines.push(`${k}: ${yamlValue(v)}`);
	}
	lines.push("---", "");
	return lines.join("\n");
}

function yamlValue(v: unknown): string {
	if (Array.isArray(v)) return "\n" + v.map((x) => `  - ${yamlScalar(x)}`).join("\n");
	return yamlScalar(v);
}

function yamlScalar(v: unknown): string {
	if (typeof v === "number" || typeof v === "boolean") return String(v);
	const s = String(v);
	if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
	if (s === "" || /^[\s]|[\s]$|[:#\[\]{},&*!|>'"%@`]|^(true|false|null|yes|no|~|-?\d+(\.\d+)?)$/i.test(s)) return JSON.stringify(s);
	return s;
}

const HAS_CHILDREN = new Set(["epic", "feature", "story", "bug", "issue"]);

export function itemBody(type: string, def: TypeDef | null, description: string): string {
	const t = type.toLowerCase();
	const parts = ["```ph-header", "```", ""];
	if (t === "bug") parts.push(`## ${SECTION.repro}`, "", description, "", `## ${SECTION.acceptance}`, "", "");
	else parts.push(`## ${SECTION.description}`, "", description, "", `## ${SECTION.acceptance}`, "", "");
	parts.push(`## ${SECTION.checklist}`, "", "- [ ] ", "", `## ${SECTION.notes}`, "", "");
	if (HAS_CHILDREN.has(t) || def?.child) parts.push(`## ${SECTION.children}`, "", "![[Context.base#Children]]", "");
	return parts.join("\n");
}

function projectBody(): string {
	return [
		"```ph-header",
		"```",
		"",
		"## Overview",
		"",
		"",
		"## Board",
		"",
		"![[Context.base#Project board]]",
		"",
		"## Timeline",
		"",
		"![[Context.base#Project timeline]]",
		"",
		"## Burnup",
		"",
		"```ph-chart",
		"type: burnup",
		"project: this",
		"```",
		"",
		"## All items",
		"",
		"![[Context.base#Project items]]",
		"",
		"## Notes",
		"",
		"",
	].join("\n");
}

function sprintBody(): string {
	return [
		"```ph-header",
		"```",
		"",
		"## Burndown",
		"",
		"```ph-chart",
		"type: burndown",
		"sprint: this",
		"```",
		"",
		"## Board",
		"",
		"![[Context.base#Sprint board]]",
		"",
		"## Retrospective",
		"",
		"### What went well",
		"",
		"- ",
		"",
		"### What to improve",
		"",
		"- ",
		"",
		"### Actions",
		"",
		"- [ ] ",
		"",
	].join("\n");
}

function personBody(): string {
	return ["```ph-header", "```", "", "## Open work", "", "![[Context.base#Person items]]", "", "## Notes", "", ""].join("\n");
}
