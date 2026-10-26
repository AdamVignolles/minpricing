---
name: deals-select
description: DealRadar evening selection — reads the rule-filtered shortlist, removes the deals that shouldn't be posted, and writes tonight's ranked queue. Run headless at 17:00 (Mon–Fri) by scripts/agents/evening.ps1, or when asked "choisis les deals de ce soir".
---

# Evening selection

Be brief: few tool calls, no commentary. `<today>` = `YYYY-MM-DD`.

1. **Switch**: fetch https://app.notion.com/p/400e672efaf0815ea445c4c776da8e12.
   "Actif" unchecked → update it: "Dernière exécution" = now, "Dernier
   statut" = "⏸️ Ignoré (inactif)"; reply "désactivé"; stop.
2. Read `config/selection-lessons.md`: rules learned from real Dealabs
   results and comments. Apply them in the veto (step 3) and the order
   (step 4), and cite the lesson in the reason when it decides.
   Then run `node scripts/agents/dealradar.mjs shortlist`. It already applied
   every rule (exclusions, score, adjusted hot chance, ranking, deals tried
   today). `publishToday` false → reply "pas de publication aujourd'hui";
   stop. Fields: `id, title, src, cat, price, ref` (reference price),
   `disc` (%), `score, hot, adj` (adjusted hot chance), `rating, reviews,
seller, sold` (sold by the merchant), `dlBest` (best Dealabs
   temperature of this product), `dlLow` (lowest price already posted).
3. **Veto** — remove a deal only for one of these, and note why:
   - suspicious data: price ≤ 0 on a non-free item, `disc` > 90 % on
     hardware, `ref` missing and `disc` absent;
   - an accessory, bundle or spare part posing as the product;
   - **no known brand**: generic Amazon/marketplace titles that start
     with the product type and name no recognisable brand ("Tablette
     Android 10 pouces…", "Vidéoprojecteur Portable 4K…", "Robot
     aspirateur 5000Pa…") — Dealabs votes these down (Lefant: −32°);
   - same product as another kept deal (keep the better one);
   - marketplace seller (`sold` false) with no rating or rating < 4;
   - `dlLow` known and `price` > `dlLow` (already posted cheaper).
     Never add a deal that isn't in the shortlist.
4. **Order by desirability** (Dealabs votes on "I want it", not on the
   percentage): put first what a large audience wants at a price they can
   say yes to — a loved brand (Lenovo, Logitech, Samsung, Ryobi, Dyson,
   LEGO, Apple, Nintendo hardware…), PC / tech / DIY tools, Amazon
   bestsellers, products already hot on Dealabs (`dlBest` high). Games go
   after them unless they are a major franchise at a record low; old or
   obscure games last. Keep the shortlist order among deals of similar
   interest.
5. Write `data/agents/queue-<today>.json`, max 10 deals, best first:
   `{"date":"<today>","rulesVersion":N,"ranked":[{"dealId":id,"title":title,"sourceId":src,"categoryId":cat,"price":price,"score":score,"hotChance":hot,"adjustedHotChance":adj,"reason":"≤ 20 mots en français : l'argument prix + l'historique Dealabs"}],"vetoed":[{"title":…,"why":…}]}`.
   The script draws how many (2–5) and when (17:30–21:30); the first ones
   in the list go first, the others replace failures. It also publishes
   at most 1 video game a day, whatever the order.
6. Update the Notion row of step 1: "Dernière exécution" = now,
   "Dernier statut" = "✅ OK". Reply in one line: kept / vetoed counts.
