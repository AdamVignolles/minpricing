---
name: deals-weekly
description: DealRadar's Sunday review — reads pre-computed statistics of the published deals, decides on its own (within bounds) how to tune config/publish-rules.json, logs the decision, and writes a code proposal when rules can't fix it. Run headless on Sundays by scripts/agents/evening.ps1, or when asked for the weekly DealRadar review.
---

# Weekly review

Numbers decide, not impressions. Everything you write is French.

1. `node scripts/agents/dealradar.mjs stats 28` → `overall`, `byCategory`,
   `bySource`, `byPriceBand`, `calibration` (predicted bucket → observed
   hot rate), each `{n, hot, hotRate, medianTemp, meanPredicted}` on
   matured posts (≥ 3 days), plus `failures`, `agentAttempts`,
   `enoughData`. Read `config/publish-rules.json` and the top entry of
   `docs/publish-rules-changelog.md`.
2. **Rollback**: if the latest changelog entry is yours and the hot rate
   since then is ≥ 10 points below the overall rate → copy
   `config/publish-rules.previous.json` over the rules (keep the current
   one as previous), log it, skip step 3.
3. **Decide** only if `enoughData`:
   - a group with hotRate ≥ 15 points below overall → its adjust −5;
     ≥ 15 above → +5 (keys: categoryAdjust / sourceAdjust /
     priceBandAdjust);
   - calibration: high predicted buckets not hotter than low ones → raise
     `minHotChance` (≤ 10 % step); much hotter → lower it; same for
     `minScore`;
   - `perDay.max` may move by 1 within `bounds.perDayMax` (more if the
     hot rate rises, fewer if it falls); never touch `publishDays`,
     `window`, nor shrink `excludedSources` (Adam's choices);
   - at most 3 keys a week, all values clamped to `bounds`. "No change" is
     a valid decision.
   If changing: copy current rules to `config/publish-rules.previous.json`,
   write the new file (version + 1, `updatedAt`, `updatedBy:
   "deals-weekly"`), prepend a changelog entry (what, from → to, the
   numbers, what you expect).
4. **Code proposal** only if rules can't fix it (e.g. a category's
   calibration wrong over ≥ 20 posts): write
   `data/agents/code-proposal-<today>.md` — problem with numbers, exact
   change (files, functions, constants), tests to add.
5. Notion "Journal DealRadar" (`collection://f778ed4c-ae4c-4614-bd67-8a60b1f2563d`),
   one row: Titre "Bilan semaine du <today>", Type "📊 Bilan hebdo", Date,
   Publiés (agents' successes this week), Taux hot (7 j) = overall
   hotRate, Changements de règles (one line per change or "Aucun"),
   Résumé (3 sentences). Page body: a table per group (n, hot, taux,
   médiane °) and the decision with its reason.
Reply in two lines: hot rate, decisions.
