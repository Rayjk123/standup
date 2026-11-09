---
title: Knowledge tab UI spec
source_kind: spec
generated_at: "2026-09-19T10:00:00Z"
tags: [console, ui, knowledge-tab]
---
# Knowledge tab UI spec

The Knowledge tab lets the owner browse, edit and review the corpus.

## Doc list

Columns: **Title**, **Project**, **Kind** (source_kind), **Scope**, **Usage**, **Updated**.

- "Usage" counts `knowledge_retrievals` rows for the doc over the last 30 days and shows a sparkline on hover.
- Default sort: Updated, newest first. Every column header sorts.
- Kind and Scope render as chips; `contradicted` and `disputed` docs show a warning chip after the title.

## Filters

Project, Kind, Scope, origin (owner/agent), verdict, and a free-text box that runs search_knowledge.

## Doc drawer

Clicking a row opens a drawer: rendered body, front matter, edit history, graph neighbors, and recent retrievals (who
retrieved it, surface, rank). Editing the body writes the markdown file and triggers a resync.

## Review queue

A badge on the tab shows the number of drafts awaiting review; the queue lists drafts with their verify verdict.
