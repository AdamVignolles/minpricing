---
name: deals-log
description: Copies DealRadar's evening plan or results into Notion (Deals publiés rows, Journal DealRadar row and its report page) from the ready-made JSON of `dealradar.mjs notion-log`. Arg "plan" right after the random draw, "final" after publishing (also refreshes temperatures). Run headless by scripts/agents/evening.ps1.
---

# Log to Notion — copy, don't think

Argument: `plan` or `final`. Run
`node scripts/agents/dealradar.mjs notion-log <arg>` once and copy its
values exactly — never rewrite the texts. Data sources:

- Deals publiés: `collection://8e6d9c9a-8d95-4345-983f-4b7b67087219`
- Journal DealRadar: `collection://f778ed4c-ae4c-4614-bd67-8a60b1f2563d`
  Fetch each data source once for its schema. Dates: `date:Date:start` =
  value, `date:Date:is_datetime` = 0. Checkboxes: `__YES__` / `__NO__`.

**Finding existing rows**: never use SQL mode (not available on this
Notion plan). Use `notion-query-data-sources` in **rows** mode with a
structured filter, one call per database, e.g. today's Deals rows:
`{"mode":"rows","data_source_url":"collection://8e6d9c9a-8d95-4345-983f-4b7b67087219","filter":{"type":"group","operator":"and","filters":[{"type":"property","property":"Date","propertyType":"date","operator":"date_is","value":{"type":"exact","value":"<today>"}}]},"limit":50}`
— each result has `dealId` and `url` (the page to update). For older rows
(temperatures), filter `dealId` with `propertyType":"text","operator":"string_is"`.
Journal row: filter `Titre` (`propertyType":"title","operator":"string_is"`).

## plan

- `rows` → Deals publiés: skip a row whose `dealId` already exists with
  Date = today; create the others in **one** create-pages call (each field
  goes to the property of the same name, `dealId` → property `dealId`).
- `journal` + `journalBody` → the Journal row titled `journal.Titre`:
  if it exists, update its properties and **replace** its page content
  with `journalBody`; otherwise create it with those properties and
  `journalBody` as content.

## final

- `outcomes` → for each, find the Deals publiés row with this `dealId` and
  Date = today: update Statut, Créneau, Lien Dealabs, Erreur. Not found
  (a replacement deal) → create it with all given fields.
- `temperatures` → update the row with this `dealId` (any date):
  Température, Hot (100°+), Expiré, Lien Dealabs. Skip missing rows.
- `journalUpdate` → on today's Journal row with that Titre: set Publiés,
  append `résuméAAjouter` to Résumé (skip if absent), and **append**
  `journalBodyAppend` at the end of its page content (insert_content,
  position end; skip if absent).

Reply with one line: rows created / updated.
