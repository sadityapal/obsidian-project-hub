// Commands, editor-menu and file-menu entries for Project Hub (non-ADO).

import { Notice, TFile } from "obsidian";
import type { Editor, Menu } from "obsidian";
import { CMD, type Hub } from "../core/hub";
import { P, PRIORITIES, type WorkItem } from "../core/model";
import { contextDefaults } from "../views/base-helpers";
import { pickFrom, pickItem, pickPerson, pickProject, pickSprint } from "./pickers";
import { ConfirmModal, NewMeetingModal, NewProjectModal, NewSprintModal } from "./modals";
import { addDays, today } from "../core/util";

const TASK_RE = /^(\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s+)(.*)$/;

export function registerCommands(hub: Hub): void {
	const { plugin } = hub;

	plugin.addCommand({ id: CMD.newItem, name: "New work item", callback: () => hub.newItem() });

	plugin.addCommand({
		id: CMD.newChild,
		name: "New child item",
		checkCallback: (checking) => {
			const item = activeItem(hub);
			if (!item) return false;
			if (!checking) {
				const childType = hub.store.typeDef(item.type)?.child;
				hub.newItem({ parent: item.path, project: hub.store.effectiveProject(item), type: childType });
			}
			return true;
		},
	});

	plugin.addCommand({ id: CMD.newProject, name: "New project", callback: () => new NewProjectModal(hub).open() });
	plugin.addCommand({ id: CMD.newSprint, name: "New sprint", callback: () => new NewSprintModal(hub).open() });
	plugin.addCommand({ id: CMD.newMeeting, name: "New meeting", callback: () => new NewMeetingModal(hub).open() });

	plugin.addCommand({ id: CMD.openHome, name: "Open home", callback: () => void hub.openPath(hub.settings.homeNote) });
	plugin.addCommand({ id: CMD.openBoard, name: "Open board", callback: () => void hub.openPath("Bases/Work Items.base#Board") });
	plugin.addCommand({ id: CMD.openBacklog, name: "Open backlog", callback: () => void hub.openPath("Bases/Work Items.base#Backlog") });
	plugin.addCommand({ id: CMD.openTimeline, name: "Open timeline", callback: () => void hub.openPath("Bases/Work Items.base#Timeline") });
	plugin.addCommand({ id: CMD.openCalendar, name: "Open calendar", callback: () => void hub.openPath("Bases/Work Items.base#Calendar") });

	const itemCmd = (id: string, name: string, run: (item: WorkItem) => Promise<void>): void => {
		plugin.addCommand({
			id,
			name,
			checkCallback: (checking) => {
				const item = activeItem(hub);
				if (!item) return false;
				if (!checking) void run(item);
				return true;
			},
		});
	};

	itemCmd(CMD.setStatus, "Set status…", async (item) => {
		const s = await pickFrom(
			hub.app,
			hub.settings.statuses.map((x) => x.name),
			"Set status…",
		);
		if (s) await hub.store.setStatus(item.path, s);
	});
	itemCmd(CMD.setPriority, "Set priority…", async (item) => {
		const choice = await pickFrom(
			hub.app,
			PRIORITIES.map((p) => `${p.label} · ${p.name}`),
			"Set priority…",
		);
		const p = PRIORITIES.find((x) => `${x.label} · ${x.name}` === choice);
		if (p) await hub.store.update(item.path, { [P.priority]: p.value });
	});
	itemCmd(CMD.assign, "Assign…", async (item) => {
		const p = await pickPerson(hub);
		if (p === undefined) return;
		await hub.store.setLink(item.path, P.assignee, p);
	});
	itemCmd(CMD.moveToSprint, "Move to sprint…", async (item) => {
		const s = await pickSprint(hub, { includePast: true });
		if (s === undefined) return;
		await hub.store.setLink(item.path, P.sprint, s);
	});
	itemCmd(CMD.setParent, "Set parent…", async (item) => {
		const exclude = new Set<string>([item.path, ...hub.store.descendants(item.path).map((d) => d.path)]);
		const p = await pickItem(hub, { exclude, placeholder: "Parent…" });
		if (p === undefined) return;
		await hub.store.setLink(item.path, P.parent, p);
	});
	itemCmd(CMD.setProject, "Set project…", async (item) => {
		const p = await pickProject(hub);
		if (p === undefined) return;
		await hub.store.setLink(item.path, P.project, p);
	});

	plugin.addCommand({ id: CMD.startNextSprint, name: "Start next sprint", callback: () => void startNextSprint(hub) });
	plugin.addCommand({
		id: CMD.recalculate,
		name: "Recalculate rollups and derived fields",
		callback: () => {
			void hub.store.maintain().then(
				() => new Notice("Recalculated rollups, inherited projects and sprint states"),
				(e: unknown) => new Notice(e instanceof Error ? e.message : String(e)),
			);
		},
	});

	plugin.addCommand({
		id: "task-to-item",
		name: "Convert task under cursor to work item",
		editorCheckCallback: (checking, editor: Editor) => {
			if (!TASK_RE.test(editor.getLine(editor.getCursor().line))) return false;
			if (!checking) convertTask(hub, editor);
			return true;
		},
	});

	// Context menus on work-item notes.
	plugin.registerEvent(
		hub.app.workspace.on("editor-menu", (menu, _editor, info) => {
			const item = info.file ? hub.store.getItem(info.file.path) : null;
			if (item) addItemMenu(hub, menu, item);
		}),
	);
	plugin.registerEvent(
		hub.app.workspace.on("file-menu", (menu, file) => {
			if (!(file instanceof TFile) || file.extension !== "md") return;
			const item = hub.store.getItem(file.path);
			if (item) addItemMenu(hub, menu, item);
		}),
	);
}

function activeItem(hub: Hub): WorkItem | null {
	const f = hub.app.workspace.getActiveFile();
	return f ? hub.store.getItem(f.path) : null;
}

function addItemMenu(hub: Hub, menu: Menu, item: WorkItem): void {
	menu.addItem((mi) =>
		mi.setTitle("Set status…").setIcon("circle-dot").onClick(() => {
			void pickFrom(
				hub.app,
				hub.settings.statuses.map((x) => x.name),
				"Set status…",
			).then((s) => {
				if (s) void hub.store.setStatus(item.path, s);
			});
		}),
	);
	menu.addItem((mi) =>
		mi.setTitle("Assign…").setIcon("user").onClick(() => {
			void pickPerson(hub).then((p) => {
				if (p !== undefined) void hub.store.setLink(item.path, P.assignee, p);
			});
		}),
	);
	menu.addItem((mi) =>
		mi.setTitle("Move to sprint…").setIcon("calendar").onClick(() => {
			void pickSprint(hub, { includePast: true }).then((s) => {
				if (s !== undefined) void hub.store.setLink(item.path, P.sprint, s);
			});
		}),
	);
	menu.addItem((mi) =>
		mi.setTitle("Set parent…").setIcon("git-branch").onClick(() => {
			const exclude = new Set<string>([item.path, ...hub.store.descendants(item.path).map((d) => d.path)]);
			void pickItem(hub, { exclude, placeholder: "Parent…" }).then((p) => {
				if (p !== undefined) void hub.store.setLink(item.path, P.parent, p);
			});
		}),
	);
	menu.addItem((mi) =>
		mi.setTitle("Set project…").setIcon("folder").onClick(() => {
			void pickProject(hub).then((p) => {
				if (p !== undefined) void hub.store.setLink(item.path, P.project, p);
			});
		}),
	);
}

async function startNextSprint(hub: Hub): Promise<void> {
	const store = hub.store;
	const current = store.currentSprint();
	if (!current) {
		new Notice("No current sprint");
		return;
	}
	const existing = store.nextSprint();
	const nextPath = existing?.path ?? null;
	const nextName = existing ? existing.name : `Sprint ${store.sortedSprints().length + 1}`;
	const moving = store.sprintItems(current.path).filter((i) => !store.isDone(i) && !store.isRemoved(i));
	const ok = await ConfirmModal(
		hub.app,
		"Start the next sprint?",
		`${moving.length} open item${moving.length === 1 ? "" : "s"} from ${current.name} move to ${nextName}. Items you keep in the current sprint stay there.`,
		"Start sprint",
	);
	if (!ok) return;
	let target = nextPath;
	if (!target) {
		const start = current.end ? addDays(current.end, 1) : today();
		const end = addDays(start, hub.settings.sprintLengthDays - 1);
		target = (await store.createSprint(nextName, start, end)).path;
	}
	for (const item of moving) await store.setLink(item.path, P.sprint, target);
	new Notice(`Moved ${moving.length} item${moving.length === 1 ? "" : "s"} to ${nextName}`);
}

function convertTask(hub: Hub, editor: Editor): void {
	const cursor = editor.getCursor();
	const line = editor.getLine(cursor.line);
	const m = TASK_RE.exec(line);
	if (!m) {
		new Notice("Put the cursor on a task line (- [ ] …)");
		return;
	}
	const title = m[3].trim();
	if (!title) {
		new Notice("The task has no text");
		return;
	}
	void (async () => {
		try {
			const id = await hub.store.allocateId();
			await hub.store.createItem({ id, title, ...contextDefaults(hub) });
			editor.replaceRange(`${m[1]}[[${id} ${title}]]`, { line: cursor.line, ch: 0 }, { line: cursor.line, ch: line.length });
			new Notice(`Created ${id} from task`);
		} catch (e) {
			new Notice(e instanceof Error ? e.message : String(e));
		}
	})();
}
