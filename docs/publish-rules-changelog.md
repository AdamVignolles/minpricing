# Publish rules — changelog

Every change to `config/publish-rules.json`, newest first. Written by the
`results-reviewer` agent (or by hand), with the numbers that justified it.

## v3 — 2026-10-23 — Adam

- **Fewer games, more PC / tech / Amazon.** The heat model gives video
  games a Dealabs-wide bonus (hot chance 10–36 %) and Amazon/PC deals
  almost nothing (3–9 %), so with a 20 % bar only games passed — 22 of the
  25 candidates on 2026-10-22. Our own history says the opposite: games 1
  hot out of 12 posts; what burned was a 3D printer, a Ryobi tool and a
  famous game franchise.
- Adjustments (points of hot chance): video games −12; computing +15;
  phones, audio, TV/photo, DIY +10; appliances +5. Sources: Amazon and
  Amazon silent drops +10, Cdiscount and Lenovo +5.
- At most **1 video game published a day** (`categoryCaps`).
- The candidates are now the best of _each_ category (not an overall top
  25), and the shortlist keeps at most 3 per category.
- These are Adam's preferences (`adamPreferences`): the weekly review may
  strengthen them, never weaken them. Adjust bounds widened to ±25.

## v2 — 2026-10-21 — Adam

- Monday to Friday only (`publishDays`), nothing on weekends.
- A random number of posts each day, 2 to 5 (`perDay`), at random times
  between 17:30 and 21:30, at least 35 min apart — less bot-like than
  fixed slots.
- The evening run starts at 17:00 (was 18:30).
- Before each post the app opens the merchant page (site up, product in
  stock, price unchanged); a refused deal is skipped for the next one.

## v1 — 2026-10-21 — initial (agreed with Adam)

- Fully automatic, at most 3 posts a day, at 18:45 / 19:45 / 20:45.
- Score ≥ 65 and hot chance ≥ 20 %, at most 2 per category a day.
  (35 % was agreed first, then lowered before the first run: the model
  rarely exceeds 30 %. History at that date: 32 posts matched on the
  profile, 3 hot (9 %), median 32°; predicted < 10 % → 0/16 hot,
  10–19 % → 2/10, ≥ 20 % → 1/6.)
- Never auto-published: AliExpress, refurbished (ITJustGood).
- No adjustments yet: the reviewer needs 15 posts at least 3 days old
  before changing anything.
