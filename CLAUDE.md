# CLAUDE.md

Context and rules for Claude Code (or any AI agent) working in this repository.
Read this file fully before making any change. Update it at the end of every session — see "After every session" at the bottom.

---

## What this project is

**Polycool Repost Bot** — an automation that watches Polymarket's Instagram for new videos, rebrands them, and reposts them to **Polycool's** TikTok and YouTube accounts via the Post Bridge API.

Client context: the developer (Glory) has been hired by both Polymarket and Polycool to run this repost pipeline. Polycool already has a Post Bridge account with TikTok + YouTube connected.

Rebranding means two separate things — don't solve only one:
1. **Caption text** — replace "Polymarket" with "Polycool" (case-insensitive) in the post caption.
2. **On-video branding** — the source videos have a "Polymarket" / "Polymarket Sports" logo burned into the top-left corner of the video itself for its full duration. This needs to be covered and replaced with Polycool's logo in the actual video file, not just the caption.

## Stack

- **Node.js** (>=18) + **Express** — server + tiny JSON API
- **ffmpeg-static** — bundles its own ffmpeg binary, no system/apt install needed (important for Railway)
- **node-cron** — runs the check-for-new-videos pipeline on a schedule
- **Apify** (Instagram Scraper actor) — source of new Polymarket IG posts (no official Instagram API access available — we don't own that account)
- **Post Bridge API** — publishes the rebranded video to Polycool's TikTok + YouTube

## File structure

```
server.js           - entire backend: fetch → rebrand video → rebrand caption → upload → post, plus Express routes
index.html           - single-page status dashboard (vanilla JS, polls /api/status every 15s)
package.json
.env.example         - template listing every required env var — REAL VALUES GO IN RAILWAY, NEVER IN A COMMITTED FILE
.gitignore            - excludes node_modules/, .env, data/, *.mp4, *.log
assets/polycool-logo.png  - REQUIRED, not yet added — see Next Steps
data/state.json      - runtime state (last processed post ID, activity log) — gitignored, resets on Railway restart unless a Volume is attached
```

## Environment variables (see `.env.example` for the full template)

| Variable | Purpose |
|---|---|
| `APIFY_API_TOKEN` | Apify account token |
| `APIFY_ACTOR` | Apify actor id, default `apify~instagram-scraper` |
| `INSTAGRAM_SOURCE_URL` | Polymarket's IG profile URL to watch |
| `POST_BRIDGE_API_KEY` | Post Bridge API key (`pb_live_...`) |
| `POST_BRIDGE_TIKTOK_ACCOUNT_ID` | Polycool's TikTok account ID inside Post Bridge |
| `POST_BRIDGE_YOUTUBE_ACCOUNT_ID` | Polycool's YouTube account ID inside Post Bridge |
| `CHECK_INTERVAL_MINUTES` | How often the cron job checks for new videos |
| `LOGO_COVER_X/Y/W/H` | Pixel box that covers the old Polymarket logo |
| `LOGO_OVERLAY_X/Y` | Where the new Polycool logo PNG gets placed |
| `PORT` | Railway sets this automatically |

---

## ⚠️ SECURITY — read this before touching git

A `.env` file containing real credentials was committed to this repo (commit `897d370`) and pushed to GitHub. **As of 2026-08-02: `.env` has been removed from git tracking** (`git rm --cached`, committed on `claude/claude-md-review-1rh83m`), but it still exists in that old commit's history, and **the exposed Apify token and Post Bridge API key have NOT been confirmed rotated yet** — treat them as compromised until the developer regenerates both and confirms.

Before any other work in this repo:
1. Confirm `.env` is **not tracked** (`git ls-files | grep .env` should return nothing but `.env.example`) — currently true as of the last check.
2. Confirm the developer has rotated/regenerated the Post Bridge API key and Apify token that were exposed. **Still unconfirmed** — ask the developer directly before assuming it's safe.
3. Never re-add `.env`, or any file containing real keys, to a commit — check `.gitignore` covers it before every commit that touches env-related files. Real key values go only into Railway's environment variable settings at deploy time, never into a committed file.
4. Never print, log, or echo full key values back in chat, commit messages, or code comments.

## Editing rules — follow these on every task

- **Always edit via targeted find-and-replace / diffs on existing files.** Never regenerate a whole file from scratch for a small change — this wastes tokens and makes changes hard to review.
- **One logical change per patch.** State what you're about to change and why, make that one change, then stop and wait for confirmation before starting the next one.
- **Never deploy, push to `main`/remote, or trigger a Railway deploy without asking first — and waiting for an explicit yes.** This includes `git push`, Railway CLI deploys, or anything that ships code to production.
- No conceptual explanations unless asked — just the change and a one-line reason.
- Don't ask clarifying questions about style/preference mid-task — pick a reasonable default, note the assumption in one line, and deliver working code the first time.

---

## Current status

Initial version of `server.js` + `index.html` built and pushed to `github.com/giftVisuals/polycool-repost-bot`. Not yet deployed or tested end-to-end. Known gaps below.

## Next steps (in order)

1. **Resolve the `.env` security issue above** — this blocks everything else.
2. **Add the real logo file** at `assets/polycool-logo.png` (transparent PNG, sized to blanket the old Polymarket bug). The pipeline will fail without this file present.
3. **Get the real Post Bridge account IDs** for Polycool's TikTok and YouTube: call `GET https://api.post-bridge.com/v1/social-accounts` with the API key, find the two Polycool entries, set `POST_BRIDGE_TIKTOK_ACCOUNT_ID` / `POST_BRIDGE_YOUTUBE_ACCOUNT_ID` in Railway.
4. **Verify Apify field names against a real run.** `fetchLatestInstagramPosts()` in `server.js` assumes fields `id`, `videoUrl`, `caption`, `timestamp` from the `apify~instagram-scraper` actor. Run it once against the real `INSTAGRAM_SOURCE_URL`, inspect the actual dataset output in the Apify console, and fix field names if they differ.
5. **Calibrate `LOGO_COVER_X/Y/W/H` and `LOGO_OVERLAY_X/Y`** against a real downloaded video — current values in `.env.example` are placeholders/estimates, not measured.
6. **Set all env vars in Railway** (never in a committed file) and deploy — ask for permission first per the rule above.
7. **Test one full cycle manually** via the dashboard's "Check now" button before relying on the cron schedule.
8. **Consider a Railway Volume** mounted at `/app/data` if `state.json` needs to survive container restarts (currently resets on redeploy).

---

## After every session

Before ending a session where you changed code or fixed something:
1. Update **Current status** above to reflect what's actually true now.
2. Move any completed items out of **Next steps** (or mark them done), and add any new ones you discovered.
3. If you touched the security section's concerns, update that section too — don't leave stale warnings once resolved.
4. Keep this update itself as a small targeted edit to this file, not a full rewrite.

