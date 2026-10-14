---
kind: work-item
id: PH-3
title: Try the board (drag & drop)
type: Task
status: To Do
priority: 3
assignee: "[[Shiladitya Pal]]"
project: "[[Getting started]]"
due: 2026-10-20
points: 1
labels:
  - onboarding
blocked_by:
  - "[[PH-2 Review the imported sprint]]"
created: 2026-10-01
rank: 3000
---

```ph-header
```

## Description

Get a feel for the Kanban board: drag a card to another column to change its status, drop it between cards to reorder, and right-click a card for the full menu. Keyboard works too — arrow keys move focus, `m` opens the status menu, Space toggles selection.

## Acceptance criteria

- [ ] Dragging a card between columns updates its status
- [ ] The WIP warning chip appears when a column is over its limit
- [ ] Toolbar search, the assignee filter row and "Only mine" all work

## Checklist

- [ ] Open the Board and drag PH-4 from To Do to In Progress
- [ ] Drag it back and watch the change land in the note's frontmatter
- [ ] Right-click a card and try Assign and Move to sprint
- [ ] Try a multi-select with Ctrl+click and change two cards at once

## Notes

Blocked by [[PH-2 Review the imported sprint]] — the board makes more sense once you have seen the imported sprint data.
