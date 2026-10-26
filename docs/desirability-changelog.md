# Desirability & collection — changelog

Every change to `config/desirability.json` (brand / product-type weights
added to the heat model) and `config/collection.json` (Amazon/Cdiscount
pages and caps), newest first. Written by the `deals-debrief` skill (every evening)
or by hand.

## v3 — 2026-10-26 — deals-debrief

- Xiaomi 0 → 0.2. Marché : 56 fils, 45 % hot, médiane 74° ; aucun post à nous.
- Mot-clé « ecran pc|moniteur|ecran gaming » 0.2 → 0.4 (pas de 0.2, mesuré
  0.5). Marché : 43 fils, 53 % hot, médiane 193° ; aucun post à nous.
- Nike reste à 0.4 (mesuré 0.6) : nos 5 posts récents sont tous sous 50°
  (−37°, −29°, 29°, 13°, −30°), donc 0.2 sous la valeur mesurée.
- Leçon ajoutée : périphériques gaming de niche au prix catalogue / clavier
  importé (Model O 2 9°, Katar Pro 17°, GMMK 2 31°, GMMK 3 QWERTZ −14°).
  Leçon Nike : preuve mise à jour.
- Collection : non touchée (agent sources). Règles : aucun changement.

## 2026-10-24 — deals-debrief (leçons uniquement)

- Leçon ajoutée : pas de PC portable 8 Go de RAM à partir de ~450 € (IdeaPad
  Slim 3 449 € −15°, VivoBook 17 550 € −54°, IdeaPad 3 17 600 € 28°).
- Leçon « PC d'entrée de gamme » : preuve mise à jour (IdeaPad Slim 3 des
  agents 4° → −15°).
- Desirability : aucun changement (aucune clé avec n ≥ 20 et écart ≥ 0.2 qui
  ne soit pas Nike, déjà réduit hier ; DJI n = 17 seulement). Collection :
  aucun changement (rendement hot moyen ≤ 9 partout). Règles : aucun.

## v2 — 2026-10-23 — deals-debrief

- `noBrandPenalty` −0.4 → −0.6 (pas de 0.2). Marché : 589 fils, 30 % hot ;
  nos posts sans marque connue : 0 hot sur 8, médiane 33°, et les PC
  portables sans nom (Ruzava, Bvate, XWU) à −43° / −25° / −17°.
- Nike 0.6 → 0.4. Marché : 603 fils, 54 % hot (inchangé) ; nos 3 posts
  Nike restent sous 50° (13°, −30°, 38°). Poids de nos posts : 0.2 sous la
  valeur mesurée.
- Leçons : 5 ajoutées dans `config/selection-lessons.md` (PC d'entrée de
  gamme, PC chers, PC 370–750 €, petits jeux < 5 €, Nike).
- Collection : aucun changement (rendement hot moyen ≤ 10 partout, rien
  de significatif entre les pages listées). Règles de publication :
  aucun changement (Adam vient de les modifier, v3 du jour).

## v1 — 2026-10-23 — initial

- Desirability added to the heat model: Dealabs votes on "I want it", not
  on the discount. Weights measured on 2 815 Dealabs threads stored in our
  deals' history (games excluded; mean 39 % hot) wherever a brand or type
  has ≥ 20 threads, starting guesses elsewhere.
- Most desirable: Nike +0.6 (603 threads, 54 % hot), LEGO +0.5 (53 %),
  Amazon devices +0.5 (56 %), Logitech +0.4 (51 %), graphics cards +0.4.
- Least: robot vacuums −0.8 (20 %), Honor −0.7 (18 %), Roborock −0.6
  (21 %), tablets −0.5 (26 %), Blink −0.5, Philips / Adidas / Bosch −0.4.
- Unknown brand (tech, home, DIY…): −0.4 (585 threads, 30 % hot). Our own
  posts: unbranded 0 hot out of 8, games 1 out of 14.
- Collection: Amazon and Cdiscount caps 200 → 250 product pages per run;
  extra pages Amazon electronics + DIY, Cdiscount monitors + tablets +
  high-tech hub (all checked to list products; Amazon kitchen listed but
  off).
