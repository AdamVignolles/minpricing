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
   Deals added by hand by the owner (pasted links) are not in the
   shortlist: they live in « Mes ajouts » and are published from their
   own page, never by this selection.
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
   - `dlLow` known and `price` > `dlLow` (already posted cheaper);
   - **« Prêt pour Dealabs »** (epic 29): what the app's checklist would
     block never reaches the shortlist (`rejected.pasPretPourDealabs`).
     Veto too what it can't judge without the page but a moderator would
     hide: a « compatible / remplacement pour <marque> » part, a no-name
     marketplace seller, a store-only offer (stock per store), a title or
     listing not in French (imported), « plus que N » in stock. A row with
     `readiness: "fix"` is fine: the app adds the price condition
     (« (Via Coupon) », « [Prime] ») to the title and the description
     itself — don't remove it from your `dealabsTitle` if you write one.
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
   **Optional: a better description.** The app writes each deal's
   description from its facts (`node scripts/agents/dealradar.mjs draft
<dealId>` shows it). When you judge you can do clearly better for a
   deal you keep, add `"description": "…"` to its queue item; it replaces
   the generated one (the owner decided so, 2026-11-04). Rules, checked
   by the app — a refused text is skipped and the generated one stays:
   - **facts only**, from the shortlist, the draft and the deal's page
     data: no opinion, no superlative, nothing you did not read;
   - **no price, no euro amount** (the app puts its own checked
     « Repères de prix » on top), no score, no heat chance, never
     « DealRadar »;
   - 80 to 2 200 characters, plain text: a short line ending with « : »
     followed by « - » items makes a bold label and a list; no HTML;
   - keep every warning of the draft (vendeur tiers, batterie non
     incluse, clavier QWERTY, retrait en magasin…).
     A draft the owner edited is never replaced. The plan's answer lists
     each description as accepted or refused, with the reason.
     **Required for a cut title: `dealabsTitle`.** A shortlist row with
     `needsTitle: true` has a Dealabs title the app had to cut to fit 140
     characters (its current text is `dealabsTitle`). Such a deal is never
     posted as cut: if you keep it, add `"dealabsTitle": "…"` to its queue
     item — that approves it on your behalf (owner's decision, 2026-11-04);
     without one, the slot skips the deal (« titre à réécrire »). Leave the
     item's `title` as the deal's name: only `dealabsTitle` is the Dealabs
     title. Write it Dealabs-style, like the draft's: product type first,
     brand, model, the specs that matter (« Écran PC gamer incurvé Z-Edge
     24" FHD 200 Hz »), platform for games, « (Vendeur tiers) » or
     « Reconditionné : » kept when the draft has them. Rules, checked by
     the app: 10 to 140 characters, one line, no price or euro amount, no
     score, never « DealRadar », no HTML. A title that already fits needs
     nothing; the owner's own title is never replaced. The plan's answer
     lists each title (`titles`) as accepted or refused.
6. Update the Notion row of step 1: "Dernière exécution" = now,
   "Dernier statut" = "✅ OK". Reply in one line: kept / vetoed counts.
