# Sources changelog

Changes to `config/collection.json` (sources schedule, switched-off sources,
Amazon/Cdiscount pages and caps) and new-source probes, newest first.
Written by the daily `deals-sources` skill.

## v4 — 2026-10-24 — deals-sources

Premier passage après la v3 (plus d'attente de 24 runs). Le rapport de la
matinée concluait « aucun changement » en appliquant encore cette règle ;
corrigé ici. Preuves : rendement sur 7 jours (`runsLogged` = 0, donc pas de
durées).

- **Steam** toutes les 1 h → 6 h : 364 vus, 182 visibles, 1 publiable, 15
  posts, 0 chaud (méd. 32°). Trop de jeux pour trop peu de chaud.
- **Nike** 1 h → 6 h : 8 publiables mais 3 posts à 13° de médiane, chaud
  estimé 8 %.
- **GOG, Nintendo, Xbox** 1 h → 6 h : 1 post chacun, 0 chaud, 1 à 5
  publiables. **PlayStation** reste à 1 h (1 post chaud sur 4, 7 publiables).
- **Foot Locker** 1 h → 12 h : 101 visibles, 0 publiable, 1 post à 24°.
  **IKEA** 1 h → 12 h : 24 vus, 0 publiable.
- **Leclerc, Lidl, Carrefour** 1 h → 6 h : 0 publiable ; groupes Famille,
  Sports, Maison chauds sur Dealabs, on garde la source mais on la ralentit.
- **Grosbill** 1 h → 6 h : 1 publiable, 3 posts à 40°.
- **Relances** 1 h → 6 h : 3 vus, 0 visible (12 recherches Amazon par run).
- **AliExpress, ITJustGood** 1 h → 24 h : exclus de la publication, 3 et 1
  deals visibles, navigateur lourd. **Sosh** 12 h → 24 h : 0 visible.
- **Amazon `kitchen`** activée : Maison & Habitat chaud (23 fils, 239°, 12
  couverts), Amazon = 77 fils chauds ; URL du motif existant.
- Inchangés : Amazon, Amazon-watch, Cdiscount, Lenovo (verrouillés),
  PlayStation, Castorama (1 chaud), Joybuy (post à 296°), Epic, FreeGames,
  opérateurs.
- À attendre : moins de requêtes aux boutiques, durée de run plus courte ;
  à rejuger sur les durées une fois des runs enregistrés.

## v3 — 2026-10-24 — Adam

- **No more change limits**: no cap on changes a day, no step size, no
  wait for 24 logged runs — the agent changes what the evidence supports.
  Still kept: `lockedSources` never off, `everyHours` 1–24 and the
  Amazon/Cdiscount `bounds` (enforced by the app).
- May add Amazon/Cdiscount `extraPages` that follow the existing URL
  patterns.
- **Legitimate routes without asking**: for a shop that blocks robots,
  it writes source proposals using official affiliate feeds (Awin…) or
  public APIs, read through env variables (no-op until Adam signs up).
- Up to 10 probes and 10 source proposals a day, no weekly limit.

## v2 — 2026-10-24 — initial (Adam)

- **Per-source schedule** added (`sources`): each source can run at most
  every N hours (1–24) or be switched off by the `deals-sources` agent;
  `lockedSources` (Amazon, Amazon silent drops, Cdiscount, Lenovo, manual)
  are never switched off.
- Telecom operators (Orange, Free, Bouygues, RED, Sosh) and Epic every
  12 h: their offers change a few times a month or once a week.
- `rejectedSources`: the shops already tested and left out (bot-blocked,
  fake struck prices, promo codes…), so they aren't proposed again.
- Collection settings now belong to `deals-sources` (no longer the debrief).
- The app logs each run (time and yield per source) to
  `data/agents/collection-runs.jsonl`: changes to the schedule wait for
  ≥ 24 logged runs.
