---
name: start
description: Start the DealRadar (minpricing) dev server with `npm run dev`. Use when the user asks to start, launch or run the app locally.
---

# Start the app

1. Run `npm run dev` from the project root with the Bash tool and
   `run_in_background: true` (it's a long-running server).
   - On first run, `alepha dev` creates `.env` from `.env.example`.
2. Check the output until the server reports its local URL. Then give the user
   the URL and remind them that they log in with `ADMIN_USERNAME` /
   `ADMIN_PASSWORD` from `.env`.
3. If it fails (port already in use, missing dependency), show the error. For
   a missing dependency, suggest `npm install`.
