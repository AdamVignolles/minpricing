---
name: deals-code
description: Implements and reviews a DealRadar code proposal written by the agents (a Lore folio in project 79, folder « Propositions des agents ») — dev-agent on an isolated branch, then code-reviewer, then a Notion journal entry. Run when Adam asks to implement a proposal; never from a cloud routine.
---

# Code proposal → branch → review

1. Take the proposal Adam named, or the newest one not yet done: Lore
   project 79, folder « Propositions des agents » (`directory_list` with
   `directory_shortId` 1), titles not starting with « [fait] »; read it
   with `folio_get` and save its content to
   `data/agents/code-proposal-<folio shortId>.md` for the agents below.
   (Old proposals sent before 2026-11-03 sit on the server as
   `data/agents/code-proposal-*.md`, which nothing can read back.)
2. Agent `dev-agent` with that file's path. No branch produced → go to 4 with
   its reason.
3. Agent `code-reviewer` with branch, worktree path and proposal.
4. Notion "Journal DealRadar" (`collection://f778ed4c-ae4c-4614-bd67-8a60b1f2563d`):
   Titre = branch (or "Proposition non codée"), Type "🛠️ Code", Date,
   Résumé = what changed, the verdict, and "à merger par Adam :
   git merge --no-ff <branch>" if APPROVE.
5. Mark the folio done: `folio_update` with the title prefixed by
   « [fait] » and, appended to its content, the branch and the verdict.
   Reply with the verdict.
