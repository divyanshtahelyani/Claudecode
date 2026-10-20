# Reel Tracker

A shared checklist for the 21 Oct – 19 Nov 2026 reel plan across VIBE, 999 Store, Lucknowi Mahal and Aarti Boutique.
It holds 363 scripts: 123 for the owner and 240 for the team.

- `index.html`: the whole app (no build step).
- `data/month.json`: every script (shots, lines, captions, camera, edit notes).
- Status is stored in Supabase (project **the-register**, table `public.reel_status`).
  Changes go through `public.reel_set_status(pin, …)`, which refuses a wrong team PIN.

## Put it on Netlify (one time)

1. Go to app.netlify.com → **Add new site** → **Import an existing project** → GitHub.
2. Pick the `Claudecode` repo and the `claude/adoring-keller-t4htoj` branch (or `main` after merging).
3. Set **Base directory** to `reel-tracker` and leave the build command empty. `netlify.toml` sets the publish folder.
4. Deploy. Every new push to that branch redeploys the site.

## Change the team PIN

Run this in the Supabase SQL editor for **the-register**, replacing `123456`:

```sql
update public.reel_tracker_config
set pin_hash = extensions.crypt('123456', extensions.gen_salt('bf'))
where id = 1;
```

Everyone using the old PIN will be asked for the new one the next time they save a change.

## Statuses

To do → Shot → Edited → Posted. Reels from past days that are not posted show as **Overdue**.
