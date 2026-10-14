# Project Hub

Project management for Obsidian: work items as markdown notes with structured frontmatter, plus a Kanban board, hierarchical backlog, Gantt timeline, burndown/burnup/CFD/velocity charts, KPI dashboards and rollups. It replaces the Azure DevOps Boards / Notion workflow for people who want their project data in plain files.

Everything is local: notes in the vault, no server, no account, no external tracker to connect.

## Features

- **Work items are notes.** `Work Items/PH-12 Fix login redirect.md` with YAML frontmatter for type, status, priority, assignee, project, sprint, parent, dates, points, labels and blocked-by. The `ph-header` block renders them as clickable controls at the top of the note.
- **Types and statuses.** Epic → Feature → Story → Task, plus Bug, Issue and Risk. Statuses Backlog / To Do / In Progress / In Review / Blocked / Done / Removed, each belonging to a state category that drives the charts, with editable colours and WIP limits.
- **Board (`ph-board`).** Columns by status/assignee/priority/type/sprint/project, swimlanes, drag & drop, WIP warnings, subtask progress, multi-select bulk actions, search and filters, keyboard support.
- **Backlog (`ph-backlog`).** ADO-style tree with drag-to-re-parent, expand/collapse, sprint groups with capacity bars, quick add.
- **Timeline (`ph-timeline`).** Gantt view with drag-to-move/resize bars, milestones, dependency arrows, schedule-conflict markers, day/week/month/quarter zoom.
- **Calendar.** Work items on their due dates via Calendar Bases; drag to reschedule.
- **Charts in notes.** `ph-chart` (burndown, burnup, CFD, velocity, throughput, status, workload, cycle time, aging), `ph-stats` KPI tiles, `ph-dashboard` lists and `ph-header` property bars.
- **Rollups.** Projects, sprints, parents and people carry live progress, counts and points — maintained automatically and readable from Bases filters.
- **Quick create.** Natural-language parsing for dates, points, labels and links; the "Create in ADO" era is over — every note is a plain local file.
- **Git backup.** The vault is a git repo; the Git plugin auto-commits every 15 minutes.
- **Home dashboard.** Portfolio KPI tiles, Epics and Features tables with live progress, a roadmap timeline, project cards, sprint summary, my work and activity — all live views over the notes.
- **Logical explorer order.** Folders are ordered Projects → Sprints → Work Items → People → Meetings → Templates → Bases → Daily → Inbox → Attachments via the Custom File Explorer sorting plugin and `sortspec.md`.
- **My work sidebar.** Today / in progress / up next / recently done.

## Install

Requirements: Windows/macOS/Linux and [Obsidian](https://obsidian.md) 1.13.1+ (desktop).

```powershell
# 1. Install Obsidian (if needed)
winget install Obsidian.Obsidian

# 2. Build the plugin
cd C:\Users\<you>\source\obsidian-project-hub
npm install
npm run build

# 3. Create the vault (folders, notes, config, Minimal theme, community plugins, git init)
node scripts/setup-vault.mjs "C:\Users\<you>\Documents\Project Hub"

# 4. Deploy the built plugin into the vault
node scripts/deploy.mjs
```

Then open Obsidian → "Open folder as vault" → the vault folder. Core config already enables Bases and the community plugins; if Obsidian asks, turn restricted mode **off** to load the community plugins.

`scripts/setup-vault.mjs` is idempotent — re-run it any time (it only creates what is missing; `--update` re-downloads the theme and plugins). `vault-template/` holds the vault skeleton the installer copies, so the repo stays the source of truth for the vault content.

## Development

```powershell
npm run dev          # watch build into the repo root (main.js, styles.css)
npm run build        # type-check + production build
npm test             # unit tests (charts-data)
node scripts/deploy.mjs   # copy the build into the vault (keeps data.json)
```

The plugin registers everything through `Plugin`, so disabling or removing it leaves no residue. Vault notes and `.obsidian` config are version-controlled; `.obsidian/workspace*.json` and `.trash/` are git-ignored.

## Architecture

| Folder        | Contents |
| ------------- | -------- |
| `src/core/`   | `model` (types, statuses, priorities), `store` (note index, queries, rollups, mutations), `settings`, `history` (change log for charts), `hub` (facade + command ids) |
| `src/ado/`    | Local-only sync facade: the `SyncApi` implementation the UI reads (always "no remote") |
| `src/views/`  | Custom Bases views: board, backlog tree, timeline + shared helpers |
| `src/charts/` | Pure data functions, small SVG charting library, code-block registration |
| `src/ui/`     | Modals, `ph-header`/`ph-dashboard` blocks, commands, My work sidebar, shared widgets |
| `styles/`     | `NN-name.css` files bundled into `styles.css`, `ph-` class prefix, light/dark CVD-validated palette |
| `scripts/`    | `setup-vault.mjs` (idempotent vault installer), `deploy.mjs` (build → vault) |
| `vault-template/` | The vault skeleton: notes, Bases files and `.obsidian` config |

## Testing

- `npm test` runs the unit suite (`tests/charts-data.test.ts`) with `node --test` via tsx: burndown series, ideal-line skipping weekends, velocity per sprint, cycle-time percentiles, CFD stacking, KPI tiles.
- `npx tsc --noEmit` type-checks against the Obsidian API typings (1.13.1).
- The repo `.tmp/` folder holds throwaway probe scripts from development (git-ignored).

## License

MIT
