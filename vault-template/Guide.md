# Project Hub Guide

Project Hub turns this vault into a project management workspace: work items are markdown notes with structured frontmatter, and every list, board, chart and dashboard is a live view over those notes. Everything is local — there is no external service to connect, and the vault is the single source of truth.

## Concepts

### Work items

Every work item is a note in `Work Items/` with frontmatter like this:

```yaml
kind: work-item
id: PH-12
title: Fix login redirect
type: Bug
status: In Progress
priority: 2
assignee: "[[Shiladitya Pal]]"
project: "[[Getting started]]"
sprint: "[[Sprint 20 (09-27-2026 - 10-10-2026)]]"
due: 2026-10-16
points: 3
labels:
  - auth
```

The `ph-header` block at the top of the note renders those properties as clickable controls, so you rarely edit raw YAML. The plugin keeps derived properties (progress, rollups, started/closed stamps) up to date on its own.

### Types

`Epic` → `Feature` → `Story` → `Task`, plus `Bug`, `Issue` and `Risk` (each with `Task` children). The type drives the default child type when you add a child item and the icon everywhere items are listed.

### Statuses

| Status       | Category    | Meaning                                                        |
| ------------ | ----------- | -------------------------------------------------------------- |
| Backlog      | proposed    | Unscheduled idea — not committed to a sprint                    |
| To Do        | proposed    | Committed and ready to start (usually in the current sprint)    |
| In Progress  | inProgress  | Actively being worked on                                        |
| In Review    | resolved    | Implementation done, waiting for review or validation           |
| Blocked      | inProgress  | In progress but stuck — also set by the Blocked by list          |
| Done         | completed   | Finished and verified                                           |
| Removed      | removed     | Cancelled or won't do — hidden from boards and rollups          |

Statuses, their colours and WIP limits are editable in Settings → Project Hub → Statuses.

### Priorities

`P1` Critical, `P2` High, `P3` Medium, `P4` Low.

### Projects, sprints and people

- **Projects** (`kind: project`) group work items. They carry a status (Planning / Active / On Hold / Done / Cancelled), a health marker (On Track / At Risk / Off Track), an owner, start and target dates, and live rollups (progress, counts, points).
- **Sprints** (`kind: sprint`) are timeboxes with start, end, goal and capacity. Sprints live entirely in the vault — create them with "Project Hub: New sprint" or let a project plan define them.
- **People** (`kind: person`) are the assignee targets. Set the note that represents you in Settings → Project Hub → General ("Me") so the "My work" views and the assignee filter find your items.

## Creating work items

Press `Ctrl+Shift+N` or the ribbon button. The quick-create modal has a title field, an optional description, and pills for type, status, priority, assignee, project, parent, sprint, due date, points and labels.

The title understands shortcuts — they are parsed out into the pills as you type:

| Token            | Meaning                        | Example                          |
| ---------------- | ------------------------------ | -------------------------------- |
| `!1` … `!4`      | Priority                       | `!2 Fix flaky upload test`       |
| `@name`          | Assignee (fuzzy person match)  | `@shil Review API docs`          |
| `#label`         | Label                          | `#docs Write release notes`      |
| `^tomorrow`      | Due date                       | `^fri Ship the hotfix`           |
| `^fri` / `^2026-10-12` / `^+3d` | Due date (weekday / date / relative) | `^+3d Follow up with design` |
| `~5`             | Points                         | `~3 Refactor the store`          |

Enter creates and closes, `Ctrl/Cmd+Enter` creates and opens, `Shift+Enter` creates and keeps the modal open for the next one.

## Views

All views are Bases views over the notes. `Ctrl+Shift+B` opens the Board, and the quick links on Home reach the rest.

### Board (`ph-board`)

Kanban columns by status (or assignee, priority, type, sprint or project), optional swimlanes, and a "14d" filter that keeps recently finished items visible without the clutter. Column headers show the count, the WIP limit (`3/5`, warning chip when exceeded) and the points sum.

- Drag a card to another column to change status; drop between cards to reorder (a manual `rank`).
- Drag into a swimlane to set that lane's field as well.
- Click opens the note (`Ctrl/Cmd`-click in a new tab, hover for a preview).
- Right-click: Open, Status, Priority, Assign…, Move to sprint…, Set parent…, Add child item, Copy link, Delete.
- Multi-select with `Ctrl`/`Shift`-click, then right-click any selected card for bulk actions.
- Keyboard: arrows move focus, Enter opens, `m` status menu, Space selects.
- Toolbar: search, assignee filter row, "Only mine", "Blocked only", live counts.

### Backlog (`ph-backlog`)

A hierarchical tree (Epic → Feature → Story → Task) like ADO's backlog. Rows indent under their parent; expand/collapse per row or all at once; drag rows to reorder among siblings or drop onto the middle of a row to re-parent (cycles are prevented). Double-click a title to rename. Group by sprint, project or status — sprint groups show dates, counts, points and a capacity bar. Keyboard: arrows to move, left/right to collapse/expand, Enter to open, Tab/Shift+Tab to indent/outdent.

### Timeline (`ph-timeline`)

A Gantt-style roadmap. Bars run from `start` to `due`; items with only a due date show a milestone diamond. Drag a bar to move it, drag an edge to resize; overdue bars get a critical outline. Dependencies from Blocked by are drawn as arrows between bars and turn red when the schedule is impossible. Zoom by day/week/month/quarter, jump to today, or fit everything.

### Calendar (`calendar`)

The [Calendar Bases](https://github.com/edrickleong/obsidian-calendar-bases) layout: work items sit on their due date. Drag an entry to another day to reschedule it (writes the `due` property).

## Charts and dashboards in notes

### `ph-chart`

A YAML block that renders one chart:

```yaml
type: burndown # burndown | burnup | cfd | velocity | throughput | status | workload | cycletime | aging
sprint: current # this | [[Sprint note]] | current
project: this # this | [[Project]]
assignee: me # this | me | [[Person]]
from: 2026-08-01 # YYYY-MM-DD; defaults: sprint dates or last 8 weeks
to: 2026-10-13
metric: points # points | count (default: points when all scoped items have points)
weeks: 8 # window for velocity / throughput
height: 260 # px
title: Sprint burndown
```

Chart types: burndown (remaining vs ideal per day, with scope-change markers), burnup (scope and completed lines with a throughput forecast), CFD (cumulative flow per status), velocity (points completed per past sprint vs average, with committed scope), throughput (items closed per week), status (100% stacked bar with counts), workload (open points per assignee stacked by status), cycletime (scatter of closed items with 50th/85th percentile lines) and aging (open items by age since started).

### `ph-stats`

A row of KPI tiles. Same scope keys as `ph-chart` plus a `tiles` list: `open`, `in-progress`, `done-this-week`, `overdue`, `blocked`, `due-this-week`, `points-remaining`, `progress`, `cycle-time`, `velocity`. Clicking a tile opens the matching items. Default tiles: open, in-progress, overdue, blocked, done-this-week, cycle-time.

```yaml
assignee: me
tiles:
  - open
  - in-progress
  - overdue
  - blocked
```

### `ph-dashboard`

One focused list or card:

```yaml
widget: my-work # my-work | due-soon | overdue | recent | projects | sprint | blocked | unassigned | activity
limit: 10
```

### `ph-header`

Rendered at the top of every work item, project, sprint and person note. No configuration — it reads the note it sits in. Click any property to edit it: status and priority open menus, assignee/project/sprint/parent open pickers, dates open a date input, labels and Blocked by are chips you can add and remove.

## Local by design

Project Hub keeps every work item, sprint, project and person as a plain markdown note in this vault. There is nothing to connect and no sync to maintain:

- **No external service.** The vault is the system of record. Boards, backlogs, timelines, charts and dashboards are live views over the notes, so they stay correct without any import or export step.
- **The notes stay yours.** Everything is standard frontmatter plus wikilinks, so Obsidian search, graph, git and any other plugin keep working. You can move folders or rename notes freely — the plugin re-indexes automatically.
- **Backups are yours too.** The vault is a git repository (see Git backup below), which is the intended way to keep history and move between machines.
- **Working with an outside tracker?** Keep the vault as your own workspace and use the "area" and "labels" frontmatter (or notes in the note body) to map to whatever the rest of the organisation uses. Nothing in Project Hub depends on it.

## Reading the vault

The file explorer is ordered by use, not alphabetically (the **Custom File Explorer sorting** plugin reads `sortspec.md` at the root): Projects → Sprints → Work Items → People → Meetings → Templates → Bases → Daily → Inbox → Attachments, with Guide and Home last. Folders carry emoji icons from the `project-hub-tweaks` snippet.

**Home.md is the dashboard.** Top to bottom it is a bird's-eye view of the portfolio:

1. **Portfolio tiles** — open items, in progress, overdue, blocked, points remaining, progress.
2. **Epics** and **Features** — every epic/feature in the vault with live progress, done/total item counts and points (parent rollups are maintained by the plugin).
3. **Roadmap** — the `ph-timeline` view embedded, showing all work as bars on a week scale, grouped by project. Drag bars to reschedule, right-click for the item menu.
4. **Projects** — cards with health, progress and due dates.
5. **Current sprint**, **My work**, **Due soon**, **Overdue**, **Activity**.

The quick links row jumps to the Board, Backlog, Timeline, Calendar, Projects and Sprints bases.

## Git backup

The vault is a git repository and the Git plugin commits changes every 15 minutes (`vault backup: <date>`). Workspace files and the trash folder are ignored. Pushing is disabled — add a private remote yourself when you are ready, and enable pushes in the Git settings if you want off-machine backups.

## Tips

- Press `Ctrl+P` and type "Project Hub" for every command; `Ctrl+Shift+H` opens Home.
- Drag cards or rows instead of editing frontmatter — the notes update themselves.
- The burndown on Home follows the current sprint; open a sprint note for its own burndown and board.
- Run "Project Hub: Recalculate" after editing frontmatter in bulk — it refreshes all rollups.
- Convert a meeting action item to real work: put the cursor on a `- [ ]` task line and run "Project Hub: Convert task under cursor to work item".
