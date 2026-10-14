---
kind: work-item
id: PH-1
title: Set up Project Hub
type: Feature
status: Done
priority: 1
assignee: "[[Shiladitya Pal]]"
project: "[[Getting started]]"
start: 2026-10-01
due: 2026-10-02
points: 3
labels:
  - onboarding
  - setup
created: 2026-10-01
started: 2026-10-01
closed: 2026-10-01
rank: 1000
---

```ph-header
```

## Description

Get the vault working as a day-to-day project hub: Minimal theme installed, the Project Hub plugin deployed, Home showing live data, and the first work items created. This is the container for the onboarding tasks — the individual steps live under it.

## Acceptance criteria

- [x] Home.md loads with the My work, sprint, projects and activity widgets
- [x] The Board, Backlog, Timeline and Calendar views all open from Bases/Work Items.base
- [x] New items can be created with `Ctrl+Shift+N` and land under Work Items/
- [x] The daily note and meeting templates are available

## Checklist

- [x] Install Obsidian and open this vault
- [x] Install the Project Hub plugin (Settings → Community plugins → Restricted mode off)
- [x] Check Settings → Project Hub → General: "Me" points at Shiladitya Pal
- [x] Create a test item and drag it across the Board
- [x] Bookmark Home, Board, Backlog and Timeline (already in Bookmarks)

## Notes

Everything runs locally in this vault — there is no account to connect. The git plugin (obsidian-git) commits changes every 15 minutes, so the vault has built-in backups; add a private remote when you want off-machine copies.

## Child items

![[Context.base#Children]]
