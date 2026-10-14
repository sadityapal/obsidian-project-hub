---
kind: work-item
id: PH-5
title: Configure git backup remote (optional)
type: Task
status: Done
priority: 4
assignee: "[[Shiladitya Pal]]"
project: "[[Getting started]]"
start: 2026-10-01
due: 2026-10-10
points: 1
labels:
  - backup
created: 2026-10-01
started: 2026-10-01
closed: 2026-10-01
rank: 5000
---

```ph-header
```

## Description

The vault is already a git repository with automatic commits every 15 minutes. Optionally point it at a private remote so the vault is backed up off the machine. Pushing stays off by default on purpose — verify what would be committed before turning it on.

## Acceptance criteria

- [x] `git log` shows automatic "vault backup" commits
- [x] Workspace and trash files stay out of the repository
- [ ] A private remote is configured (optional)

## Checklist

- [x] Confirm the vault is a git repository
- [x] Check the auto-commit interval in the Git plugin settings
- [ ] Create a private repository and add it as a remote (optional)
- [ ] Enable pushing only once you are comfortable with it

## Notes

The Git plugin never pushes automatically here (`disablePush` is on), so adding a remote stays a deliberate, manual step. See .gitignore for what is excluded.
