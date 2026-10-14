import assert from "node:assert/strict";
import test from "node:test";
import type { StatusCategory } from "../src/core/model";
import type { ChartItem, ItemState, SprintRef, StateAt, StatusRef } from "../src/charts/data";
import {
	agingItems,
	bucketStatus,
	burndown,
	chooseMetric,
	cfd,
	cycleTimes,
	forecast,
	idealLine,
	sampleDates,
	statTile,
	statusBreakdown,
	throughput,
	velocity,
	workingDays,
	workload,
} from "../src/charts/data";
import { addDays } from "../src/core/util";

// ---------------------------------------------------------------- fixtures

const CATEGORY: Record<string, StatusCategory> = {
	Backlog: "proposed",
	"To Do": "proposed",
	"In Progress": "inProgress",
	Blocked: "inProgress",
	"In Review": "resolved",
	Done: "completed",
	Removed: "removed",
};

const categoryOf = (status: string): StatusCategory => CATEGORY[status] ?? "proposed";

type Ev = [date: string, status: string, points?: number | null, sprint?: string | null, project?: string | null];

interface Spec {
	id: string;
	status: string;
	points: number | null;
	created: string;
	started?: string | null;
	closed?: string | null;
	due?: string | null;
	sprint?: string | null;
	events?: Ev[];
}

function makeItem(s: Spec): ChartItem {
	return {
		path: `Work Items/${s.id}.md`,
		id: s.id,
		title: s.id,
		status: s.status,
		points: s.points,
		created: s.created,
		started: s.started ?? null,
		closed: s.closed ?? null,
		due: s.due ?? null,
	};
}

/** Stand-in for HistoryStore.stateAt: the last event on or before the queried day. */
function makeStateAt(specs: Spec[]): StateAt<ChartItem> {
	const byId = new Map(specs.map((s) => [s.id, s]));
	return (it, date) => {
		const s = byId.get(it.id);
		if (!s) return null;
		const state = (ev: Ev): ItemState => ({
			status: ev[1],
			category: categoryOf(ev[1]),
			points: ev[2] ?? s.points,
			sprint: ev[3] ?? s.sprint ?? null,
			project: ev[4] ?? null,
		});
		const events = s.events ?? [[s.created, s.status] as Ev];
		if (date < events[0][0]) return null;
		let hit = events[0];
		for (const ev of events) if (ev[0] <= date) hit = ev;
		return state(hit);
	};
}

const STATUSES: StatusRef[] = [
	{ name: "Backlog", category: "proposed", color: "magenta" },
	{ name: "To Do", category: "proposed", color: "blue" },
	{ name: "In Progress", category: "inProgress", color: "orange" },
	{ name: "In Review", category: "resolved", color: "violet" },
	{ name: "Done", category: "completed", color: "aqua" },
	{ name: "Removed", category: "removed", color: "gray" },
];

// Monday 2026-10-05 to Friday 2026-10-09.
const SPRINT: { start: string; end: string } = { start: "2026-10-05", end: "2026-10-09" };

const SPRINTS: SprintRef[] = [
	{ key: "Sprint 1", name: "Sprint 1", path: "Sprints/Sprint 1.md", ...SPRINT },
	{ key: "Sprint 2", name: "Sprint 2", path: "Sprints/Sprint 2.md", start: "2026-10-12", end: "2026-10-16" },
];

const inSprints = (it: ChartItem, st: ItemState): boolean => st.sprint === "Sprint 1" || st.sprint === "Sprint 2";

// ---------------------------------------------------------------- burndown & ideal line

test("ideal line burns down on working days only and stays flat over weekends", () => {
	assert.deepEqual(idealLine("2026-10-05", "2026-10-11", 10), [10, 7.5, 5, 2.5, 0, 0, 0]);
	assert.deepEqual(idealLine("2026-10-05", "2026-10-09", 10), [10, 7.5, 5, 2.5, 0]);
	assert.deepEqual(idealLine("2026-10-05", "2026-10-05", 8), [8]);
});

test("burndown measures remaining work per day and reports status", () => {
	const specs: Spec[] = [
		{ id: "PH-1", status: "To Do", points: 5, created: "2026-10-05", sprint: "Sprint 1", events: [["2026-10-05", "To Do", 5], ["2026-10-07", "To Do", 7]] },
		{ id: "PH-2", status: "Done", points: 3, created: "2026-10-05", sprint: "Sprint 1", events: [["2026-10-05", "To Do"], ["2026-10-07", "Done"]] },
		{ id: "PH-3", status: "In Progress", points: 2, created: "2026-10-05", sprint: "Sprint 1", events: [["2026-10-05", "To Do"], ["2026-10-08", "In Progress"]] },
		{ id: "PH-4", status: "To Do", points: 1, created: "2026-10-06", sprint: "Sprint 1", events: [["2026-10-06", "To Do", 1]] },
	];
	const items = specs.map(makeItem);
	const bd = burndown(items, makeStateAt(specs), (it, st) => st.sprint === "Sprint 1", {
		start: SPRINT.start,
		end: SPRINT.end,
		today: "2026-10-08",
		metric: "points",
	});
	assert.equal(bd.days.length, 5);
	assert.deepEqual(bd.days.map((d) => d.remaining), [10, 11, 10, 10, null]);
	assert.deepEqual(bd.days.map((d) => d.completed), [0, 0, 3, 3, null]);
	assert.deepEqual(bd.days.map((d) => d.ideal), [10, 7.5, 5, 2.5, 0]);
	assert.equal(bd.startScope, 10);
	assert.equal(bd.current?.remaining, 10);
	assert.equal(bd.workingDaysLeft, 2);
	assert.equal(bd.status, "behind");
	assert.deepEqual(bd.changes.map((c) => [c.date, c.delta]), [
		["2026-10-06", 1],
		["2026-10-07", 2],
	]);
	assert.deepEqual(bd.changes[0].added.map((i) => i.id), ["PH-4"]);
});

test("burndown reports done once every sprint item is complete", () => {
	const specs: Spec[] = [
		{ id: "PH-1", status: "Done", points: 5, created: "2026-10-05", sprint: "Sprint 1", events: [["2026-10-05", "To Do"], ["2026-10-07", "Done"]] },
		{ id: "PH-2", status: "Done", points: 5, created: "2026-10-05", sprint: "Sprint 1", events: [["2026-10-05", "To Do"], ["2026-10-07", "Done"]] },
		{ id: "PH-3", status: "Done", points: 5, created: "2026-10-05", sprint: "Sprint 1", events: [["2026-10-05", "To Do"], ["2026-10-07", "Done"]] },
		{ id: "PH-4", status: "To Do", points: 5, created: "2026-10-05", sprint: "Sprint 1", events: [["2026-10-05", "To Do"], ["2026-10-08", "Done"]] },
	];
	const bd = burndown(specs.map(makeItem), makeStateAt(specs), (it, st) => st.sprint === "Sprint 1", {
		start: SPRINT.start,
		end: SPRINT.end,
		today: "2026-10-08",
		metric: "points",
	});
	assert.equal(bd.current?.remaining, 0);
	assert.equal(bd.status, "done");
});

test("burndown leaves future days blank and plans work that has not started", () => {
	const specs: Spec[] = [{ id: "PH-1", status: "To Do", points: 8, created: "2026-10-05", sprint: "Sprint 1" }];
	const bd = burndown(specs.map(makeItem), makeStateAt(specs), (it, st) => st.sprint === "Sprint 1", {
		start: SPRINT.start,
		end: SPRINT.end,
		today: "2026-10-01",
		metric: "points",
	});
	assert.ok(bd.days.every((d) => d.remaining === null));
	assert.equal(bd.planned, 8);
	assert.equal(bd.status, "upcoming");
	assert.equal(bd.workingDaysLeft, 5);
});

// ---------------------------------------------------------------- velocity

test("velocity counts work completed inside each sprint", () => {
	const specs: Spec[] = [
		{ id: "PH-1", status: "Done", points: 5, created: "2026-10-05", sprint: "Sprint 1", events: [["2026-10-05", "To Do"], ["2026-10-08", "Done"]] },
		{ id: "PH-2", status: "Done", points: 3, created: "2026-10-05", sprint: "Sprint 1", events: [["2026-10-05", "To Do"], ["2026-10-06", "Done"]] },
		{ id: "PH-3", status: "Done", points: 2, created: "2026-10-05", sprint: "Sprint 2", events: [["2026-10-05", "To Do"], ["2026-10-14", "Done"]] },
		{ id: "PH-4", status: "To Do", points: 4, created: "2026-10-05", sprint: "Sprint 2", events: [["2026-10-05", "To Do"]] },
	];
	const items = specs.map(makeItem);
	const v = velocity(items, makeStateAt(specs), inSprints, SPRINTS, { today: "2026-10-20", metric: "points" });
	assert.equal(v.rows.length, 2);
	const [s1, s2] = v.rows;
	assert.equal(s1.committed, 8);
	assert.equal(s1.completed, 8);
	assert.equal(s1.current, false);
	assert.equal(s2.committed, 6);
	assert.equal(s2.completed, 2);
	assert.equal(s2.items.length, 1);
	assert.equal(v.average, 5);
});

test("velocity excludes the running sprint from the average", () => {
	const specs: Spec[] = [
		{ id: "PH-1", status: "Done", points: 5, created: "2026-10-05", sprint: "Sprint 1", events: [["2026-10-05", "To Do"], ["2026-10-08", "Done"]] },
		{ id: "PH-2", status: "In Progress", points: 3, created: "2026-10-12", sprint: "Sprint 2", events: [["2026-10-12", "To Do"], ["2026-10-13", "In Progress"]] },
	];
	const v = velocity(specs.map(makeItem), makeStateAt(specs), inSprints, SPRINTS, { today: "2026-10-13", metric: "points" });
	assert.equal(v.rows.length, 2);
	assert.equal(v.rows[1].current, true);
	assert.equal(v.rows[1].completed, 0);
	assert.equal(v.average, 5);
});

// ---------------------------------------------------------------- cumulative flow

test("cfd stacks statuses from Done at the bottom to the first column at the top", () => {
	const specs: Spec[] = [
		{ id: "PH-1", status: "Backlog", points: null, created: "2026-10-08", events: [["2026-10-08", "Backlog"]] },
		{ id: "PH-2", status: "To Do", points: null, created: "2026-10-08", events: [["2026-10-08", "To Do"]] },
		{ id: "PH-3", status: "In Progress", points: null, created: "2026-10-08", events: [["2026-10-08", "In Progress"]] },
		{ id: "PH-4", status: "In Review", points: null, created: "2026-10-08", events: [["2026-10-08", "In Review"]] },
		{ id: "PH-5", status: "Done", points: null, created: "2026-10-08", events: [["2026-10-08", "Done"]] },
		{ id: "PH-6", status: "Removed", points: null, created: "2026-10-08", events: [["2026-10-08", "Removed"]] },
	];
	const flow = cfd(specs.map(makeItem), makeStateAt(specs), () => true, {
		dates: ["2026-10-07", "2026-10-08"],
		statuses: STATUSES,
		metric: "count",
	});
	assert.deepEqual(flow.bands.map((b) => b.status.name), ["Done", "In Review", "In Progress", "To Do", "Backlog"]);
	const done = flow.bands[0];
	assert.deepEqual(done.values, [0, 1]);
	assert.deepEqual(done.y0, [0, 0]);
	assert.deepEqual(done.y1, [0, 1]);
	const backlog = flow.bands[flow.bands.length - 1];
	assert.deepEqual(backlog.values, [0, 1]);
	assert.deepEqual(backlog.y0, [0, 4]);
	assert.deepEqual(backlog.y1, [0, 5]);
	assert.deepEqual(flow.totals, [0, 5]);
});

test("cfd maps a renamed status to the first status of its category", () => {
	const bucket = bucketStatus("Doing", "inProgress", STATUSES);
	assert.equal(bucket?.name, "In Progress");
	const exact = bucketStatus("In Review", "resolved", STATUSES);
	assert.equal(exact?.name, "In Review");
	assert.equal(bucketStatus("Gone", "removed", STATUSES)?.name, "Removed");
});

// ---------------------------------------------------------------- flow metrics

test("cycle time percentiles come from the finished items in range", () => {
	const specs: Spec[] = [
		{ id: "PH-1", status: "Done", points: null, created: "2026-10-01", started: "2026-10-01", closed: "2026-10-02" },
		{ id: "PH-2", status: "Done", points: null, created: "2026-10-01", started: "2026-10-02", closed: "2026-10-04" },
		{ id: "PH-3", status: "Done", points: null, created: "2026-10-01", started: "2026-10-05", closed: "2026-10-08" },
		{ id: "PH-4", status: "Done", points: null, created: "2026-10-01", started: "2026-10-06", closed: "2026-10-10" },
		{ id: "PH-5", status: "Done", points: null, created: "2026-10-01", started: "2026-10-01", closed: "2026-10-11" },
		{ id: "PH-6", status: "Done", points: null, created: "2026-08-01", started: "2026-08-01", closed: "2026-08-20" },
	];
	const ct = cycleTimes(specs.map(makeItem), categoryOf, { from: "2026-09-01", to: "2026-10-20" });
	assert.equal(ct.points.length, 5);
	assert.deepEqual(ct.points.map((p) => p.days), [1, 2, 3, 4, 10]);
	assert.equal(ct.median, 3);
	assert.equal(ct.p50, 3);
	assert.equal(ct.p85, 10);
});

test("throughput buckets closed items by Monday-based week", () => {
	const specs: Spec[] = [
		{ id: "PH-1", status: "Done", points: null, created: "2026-10-01", closed: "2026-10-06" },
		{ id: "PH-2", status: "Done", points: null, created: "2026-10-01", closed: "2026-10-07" },
		{ id: "PH-3", status: "Done", points: null, created: "2026-10-01", closed: "2026-10-14" },
		{ id: "PH-4", status: "Done", points: null, created: "2026-10-01", closed: "2026-09-29" },
	];
	const tp = throughput(specs.map(makeItem), categoryOf, { from: "2026-10-05", to: "2026-10-18", today: "2026-10-20", metric: "count" });
	assert.equal(tp.weeks.length, 2);
	assert.deepEqual(tp.weeks.map((w) => w.start), ["2026-10-05", "2026-10-12"]);
	assert.deepEqual(tp.weeks.map((w) => w.value), [2, 1]);
	assert.equal(tp.average, 1.5);
	assert.ok(tp.weeks.every((w) => !w.partial));
});

test("aging lists started work oldest first and skips finished items", () => {
	const specs: Spec[] = [
		{ id: "PH-1", status: "In Progress", points: null, created: "2026-10-01", started: "2026-10-01" },
		{ id: "PH-2", status: "In Review", points: null, created: "2026-10-05", started: "2026-10-09" },
		{ id: "PH-3", status: "Done", points: null, created: "2026-10-01", started: "2026-10-01", closed: "2026-10-02" },
	];
	const aging = agingItems(specs.map(makeItem), categoryOf, "2026-10-13");
	assert.deepEqual(aging.map((a) => a.item.id), ["PH-1", "PH-2"]);
	assert.equal(aging[0].age, 12);
	assert.equal(aging[1].age, 4);
});

test("forecast projects completion from the trailing window", () => {
	const f = forecast(100, 40, 20, 28, "2026-10-13");
	assert.equal(Math.round(f.rate * 1e6) / 1e6, 0.714286);
	assert.equal(f.remaining, 60);
	assert.equal(f.finish, "2027-01-05");
	const stalled = forecast(100, 40, 40, 28, "2026-10-13");
	assert.equal(stalled.finish, null);
	assert.equal(forecast(50, 50, 40, 28, "2026-10-13").finish, "2026-10-13");
});

// ---------------------------------------------------------------- current-state breakdowns

test("status breakdown counts live items in board order and skips removed", () => {
	const specs: Spec[] = [
		{ id: "PH-1", status: "Backlog", points: 1, created: "2026-10-01" },
		{ id: "PH-2", status: "To Do", points: 2, created: "2026-10-01" },
		{ id: "PH-3", status: "In Progress", points: 3, created: "2026-10-01" },
		{ id: "PH-4", status: "In Review", points: 4, created: "2026-10-01" },
		{ id: "PH-5", status: "Done", points: 5, created: "2026-10-01" },
		{ id: "PH-6", status: "Removed", points: 6, created: "2026-10-01" },
	];
	const slices = statusBreakdown(specs.map(makeItem), STATUSES, categoryOf);
	assert.deepEqual(slices.map((s) => [s.status.name, s.count, s.points]), [
		["Backlog", 1, 1],
		["To Do", 1, 2],
		["In Progress", 1, 3],
		["In Review", 1, 4],
		["Done", 1, 5],
	]);
});

test("workload splits open work per assignee, unassigned last", () => {
	const specs: Spec[] = [
		{ id: "PH-1", status: "To Do", points: 3, created: "2026-10-01" },
		{ id: "PH-2", status: "In Progress", points: 2, created: "2026-10-01" },
		{ id: "PH-3", status: "Done", points: 5, created: "2026-10-01" },
		{ id: "PH-4", status: "Backlog", points: 1, created: "2026-10-01" },
	];
	const rows = workload(specs.map(makeItem), STATUSES, categoryOf, (it) => {
		if (it.id === "PH-3") return { key: "People/B.md", name: "Bee" };
		if (it.id === "PH-4") return { key: null, name: "Unassigned" };
		return { key: "People/A.md", name: "Ay" };
	}, "points");
	assert.deepEqual(rows.map((r) => [r.name, r.total, r.count]), [
		["Ay", 5, 2],
		["Unassigned", 1, 1],
	]);
	const ay = rows[0];
	assert.deepEqual(ay.segments.filter((s) => s.value > 0).map((s) => [s.status.name, s.value]), [
		["To Do", 3],
		["In Progress", 2],
	]);
});

// ---------------------------------------------------------------- KPI tiles

const TILE_SPECS: Spec[] = [
	{ id: "PH-1", status: "To Do", points: 3, created: "2026-10-01", sprint: "Sprint 1", due: "2026-10-05" },
	{ id: "PH-2", status: "Done", points: 2, created: "2026-10-01", sprint: "Sprint 1", closed: "2026-10-12" },
	{ id: "PH-3", status: "Removed", points: 1, created: "2026-10-01", sprint: "Sprint 1" },
];

const tileOpts = { today: "2026-10-13", categoryOf, blockedOf: (it: ChartItem) => it.id === "PH-1" };

test("stat tiles count scoped work with a context line", () => {
	const items = TILE_SPECS.map(makeItem);
	const open = statTile("open", items, tileOpts);
	assert.equal(open.value, 1);
	assert.equal(open.context, "of 2 items in scope");
	assert.deepEqual(open.items.map((i) => i.id), ["PH-1"]);

	const inProgress = statTile("in-progress", items, tileOpts);
	assert.equal(inProgress.value, 0);
	assert.equal(inProgress.context, "of 1 open item");

	const blocked = statTile("blocked", items, tileOpts);
	assert.equal(blocked.value, 1);
	assert.deepEqual(blocked.items.map((i) => i.id), ["PH-1"]);

	const overdue = statTile("overdue", items, tileOpts);
	assert.equal(overdue.value, 1);

	const doneWeek = statTile("done-this-week", items, tileOpts);
	assert.equal(doneWeek.value, 1);
	assert.deepEqual(doneWeek.items.map((i) => i.id), ["PH-2"]);

	const points = statTile("points-remaining", items, tileOpts);
	assert.equal(points.value, 3);
	assert.equal(points.context, "of 5 pts of work in scope");

	const progress = statTile("progress", items, tileOpts);
	assert.equal(progress.value, 40);
	assert.equal(progress.context, "1 of 2 items done");

	const cycle = statTile("cycle-time", items, tileOpts);
	assert.equal(cycle.value, 11);
	assert.equal(cycle.unit, "days");
	assert.equal(cycle.context, "median of 1 item closed in 30 days");
});

test("cycle-time tile reports nothing when the window is empty", () => {
	const specs: Spec[] = [{ id: "PH-9", status: "To Do", points: null, created: "2026-10-01" }];
	const cycle = statTile("cycle-time", specs.map(makeItem), tileOpts);
	assert.equal(cycle.value, null);
	assert.equal(cycle.context, "nothing closed in 30 days");
});

test("velocity tile averages the finished sprints behind the work", () => {
	const specs: Spec[] = [
		{ id: "PH-1", status: "Done", points: 5, created: "2026-10-05", sprint: "Sprint 1", events: [["2026-10-05", "To Do"], ["2026-10-08", "Done"]] },
		{ id: "PH-2", status: "Done", points: 3, created: "2026-10-05", sprint: "Sprint 1", events: [["2026-10-05", "To Do"], ["2026-10-06", "Done"]] },
		{ id: "PH-3", status: "Done", points: 2, created: "2026-10-05", sprint: "Sprint 2", events: [["2026-10-05", "To Do"], ["2026-10-14", "Done"]] },
	];
	const vel = statTile("velocity", specs.map(makeItem), {
		...tileOpts,
		today: "2026-10-20",
		sprints: SPRINTS,
		stateAt: makeStateAt(specs),
		member: inSprints,
	});
	assert.equal(vel.value, 5);
	assert.equal(vel.unit, "points");
	assert.equal(vel.context, "average of 2 finished sprints");
	assert.deepEqual(vel.items.map((i) => i.id), ["PH-1", "PH-2", "PH-3"]);

	const none = statTile("velocity", specs.map(makeItem), tileOpts);
	assert.equal(none.value, null);
	assert.equal(none.context, "no sprints started yet");
});

// ---------------------------------------------------------------- helpers

test("helpers", () => {
	assert.equal(chooseMetric([{ points: 3 }, { points: 2 }]), "points");
	assert.equal(chooseMetric([{ points: 3 }, { points: null }]), "count");
	assert.equal(chooseMetric([]), "count");
	assert.equal(chooseMetric([{ points: 3 }], "count"), "count");
	assert.equal(workingDays("2026-10-05", "2026-10-09"), 5);
	assert.equal(workingDays("2026-10-03", "2026-10-04"), 0);
	assert.deepEqual(sampleDates("2026-10-01", "2026-10-03"), ["2026-10-01", "2026-10-02", "2026-10-03"]);
	const long = sampleDates("2020-01-01", "2026-10-13");
	assert.equal(long[long.length - 1], "2026-10-13");
	assert.equal(long[0], "2020-01-01");
	assert.ok(long.length <= 105);
	const reversed = sampleDates("2026-10-05", "2026-10-01");
	assert.deepEqual(reversed, []);
	assert.equal(addDays("2026-10-13", -13), "2026-09-30");
});
