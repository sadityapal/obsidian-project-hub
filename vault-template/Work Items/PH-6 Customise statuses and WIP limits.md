---
kind: work-item
id: PH-6
title: Customise statuses and WIP limits
type: Task
status: To Do
priority: 3
assignee: "[[Shiladitya Pal]]"
project: "[[Getting started]]"
due: 2026-10-31
points: 2
labels:
  - configuration
created: 2026-10-01
rank: 6000
---

```ph-header
```

## Description

Match the workflow to the team: adjust the status list, their colours and the WIP limits per column. Every status belongs to a state category (proposed, in progress, resolved, completed, removed) that drives the burndown, cycle-time and rollup math — so add or remove statuses inside a category rather than inventing new ones.

## Acceptance criteria

- [ ] The board columns match the workflow the team uses
- [ ] WIP limits are set for the statuses that need them
- [ ] Existing items keep working after the change

## Checklist

- [ ] Open Settings → Project Hub → Statuses
- [ ] Rename or recolour a status and watch the board update
- [ ] Set a WIP limit for In Progress and trigger the warning chip on the Board
- [ ] Check the categories in Settings → Project Hub → Statuses before removing a status

## Notes

Renaming a status updates the status pills everywhere, but items that use the old name keep it until they move — run Project Hub: Recalculate after a big reshuffle.
