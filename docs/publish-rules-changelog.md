# Publish rules — changelog

Every change to `config/publish-rules.json`, newest first. Written by the
`results-reviewer` agent (or by hand), with the numbers that justified it.

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
