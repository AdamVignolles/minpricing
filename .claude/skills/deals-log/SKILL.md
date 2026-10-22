---
name: deals-log
description: Copies DealRadar's evening plan or results into Notion (Deals publiés, Journal DealRadar) from the ready-made JSON of `dealradar.mjs notion-log`. Arg "plan" right after the random draw, "final" after publishing (also refreshes temperatures). Run headless by scripts/agents/evening.ps1.
---

# Log to Notion — copy, don't think

Argument: `plan` or `final`. Run
`node scripts/agents/dealradar.mjs notion-log <arg>` once and copy its
values exactly. Data sources:
- Deals publiés: `collection://8e6d9c9a-8d95-4345-983f-4b7b67087219`
- Journal DealRadar: `collection://f778ed4c-ae4c-4614-bd67-8a60b1f2563d`
Fetch each data source once for its schema. Write rows in **one**
create-pages call per database. Dates: `date:Date:start` = value,
`date:Date:is_datetime` = 0. Checkboxes: `__YES__` / `__NO__`.

## plan
- `rows` → create them in Deals publiés (all fields except `dealId`
  go to the property of the same name; `dealId` → property `dealId`).
- `journal` → create one Journal row with those properties. If a row
  titled the same already exists today, update it instead.

## final
- `outcomes` → for each, find the Deals publiés row with this `dealId` and
  Date = today: update Statut, Créneau, Lien Dealabs, Erreur. Not found
  (a replacement deal) → create it with all given fields.
- `temperatures` → update the row with this `dealId` (any date):
  Température, Hot (100°+), Expiré, Lien Dealabs. Skip missing rows.
- `journalUpdate` → on today's Journal row with that Titre: set Publiés,
  and append `résuméAAjouter` to Résumé (skip if absent).

Reply with one line: rows created / updated.
