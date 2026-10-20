# Reel Tracker

A shared checklist for the 21 Oct – 19 Nov 2026 reel plan across VIBE, 999 Store, Lucknowi Mahal and Aarti Boutique.
It holds 363 scripts: 123 for the owner and 240 for the team.

- `index.html`: the whole app (no build step).
- `data/month.json`: every script (shots, lines, captions, camera, edit notes).
- Status is stored in Supabase (project **the-register**, table `public.reel_status`).
  Changes go through `public.reel_update(…)`. There is no PIN, so anyone with the link can tick reels.

## Put it on Netlify (one time)

1. Go to app.netlify.com → **Add new site** → **Import an existing project** → GitHub.
2. Pick the `Claudecode` repo and the `claude/adoring-keller-t4htoj` branch (or `main` after merging).
3. Set **Base directory** to `reel-tracker` and leave the build command empty. `netlify.toml` sets the publish folder.
4. Deploy. Every new push to that branch redeploys the site.

## Statuses

To do → Shot → Edited → Posted. Reels from past days that are not posted show as **Overdue**.
