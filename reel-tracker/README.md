# Team Reel Tracker

The team's reels for VIBE, 999 Store, Lucknowi Mahal and Aarti Boutique: 2 per store per day.

- `index.html`: the whole app (no build step, no login).
- `data/month.json`: 240 scripts for 21 Oct – 19 Nov 2026 (shots, lines, captions, camera, edit notes).
- Status is saved in Supabase (project **the-register**, table `public.reel_status`) through `public.reel_update(…)`.
  Anyone with the link can tick reels, so share it only with the team.

## Put it online

Drag `reel-tracker.zip` onto **app.netlify.com/drop**. To update an existing site, drop the new zip on that site's **Deploys** page.
Or connect Netlify to this repo with **Base directory** set to `reel-tracker`.

## Statuses

To do → Shot → Edited → Posted. Reels from past days that are not posted show as **Overdue**.
