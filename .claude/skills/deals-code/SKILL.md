---
name: deals-code
description: Implements and reviews a DealRadar code proposal written by the weekly review (data/agents/code-proposal-*.md) — dev-agent on an isolated branch, then code-reviewer, then a Notion journal entry. Run headless by scripts/agents/evening.ps1 when a proposal exists, or when asked to implement the latest proposal.
---

# Code proposal → branch → review

1. Take the newest `data/agents/code-proposal-*.md`.
2. Agent `dev-agent` with its path. No branch produced → go to 4 with
   its reason.
3. Agent `code-reviewer` with branch, worktree path and proposal.
4. Notion "Journal DealRadar" (`collection://f778ed4c-ae4c-4614-bd67-8a60b1f2563d`):
   Titre = branch (or "Proposition non codée"), Type "🛠️ Code", Date,
   Résumé = what changed, the verdict, and "à merger par Adam :
   git merge --no-ff <branch>" if APPROVE.
5. Rename the proposal to `…-done.md`. Reply with the verdict.
