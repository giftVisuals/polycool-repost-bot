# CLAUDE.md

Context and rules for Claude Code (or any AI agent) working in this repository.
Read this file fully before making any change. Update it at the end of every session — see "After every session" at the bottom.

---

## What this project is

**Polycool Repost Bot** — an automation that watches Polymarket's Instagram for new videos, rebrands them, and reposts them to **Polycool's** TikTok and YouTube accounts via the Post Bridge API.

Client context: the developer (Glory) has been hired by both Polymarket and Polycool to run this repost pipeline. Polycool already has a Post Bridge account with TikTok + YouTube connected.

Rebranding means two separate things — don't solve only one:
1. **Caption text** — replace "Polymarket" with "Polycool" (case-insensitive) in the post caption.
2. **On-video branding** — Polymarket burns branding into the video itself, but the layout is not fixed: seen so far are a top-left corner bug, a tweet-style card (icon + handle + checkmark), and a lower-third "trending headline" card, in both light and dark themes. Because the layout keeps changing, this is handled per-video by a human via the dashboard's box editor (see "Current status"), not by fixed coordinates.

## Stack

- **Node.js** (>=18) + **Express** — server + tiny JSON API
- **ffmpeg-static** — bundles its own ffmpeg binary, no system/apt install needed (important for Railway)
- **node-cron** — runs the check-for-new-videos pipeline on a schedule
- **Apify** (Instagram Scraper actor) — source of new Polymarket IG posts (no official Instagram API access available — we don't own that account)
- **Post Bridge API** — publishes the rebranded video to Polycool's TikTok + YouTube

## File structure

```
server.js                        - backend: fetch → download → (human box-edits) → upload → post, plus Express routes
index.html                       - dashboard: Needs Setup (box editor) → Pending Review (approve/reject) → Activity log
package.json
.env.example                     - template listing every required env var — REAL VALUES GO IN RAILWAY, NEVER IN A COMMITTED FILE
.gitignore                       - excludes node_modules/, .env, data/, *.mp4, *.log
assets/polycool-logo.png         - dark-theme Polycool logo (transparent PNG)
assets/polycool-logo-light.png   - light-theme variant (recolored from the dark one — swap for a pro design later)
assets/fonts/DejaVuSans-Bold.ttf - bundled font for "Custom text" mode (ffmpeg-static has no drawtext filter; text uses the "ass"/libass filter instead)
data/raw/          - downloaded videos awaiting a human to draw the cover box (+ first-frame .jpg previews)
data/pending/      - rebranded videos awaiting approve/reject
data/state.json    - runtime state (raw queue, pending queue, activity log) — gitignored, resets on Railway restart unless a Volume is attached (see Next Steps)
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
| `PROCESS_SINCE_DATE` | Never process/post anything from before this date, no matter what Apify returns (default `2026-08-03`) |
| `APPROVAL_PASSWORD` | Required to Approve/Reject in the dashboard — fails closed if unset |
| `LOGO_COVER_X/Y/W/H` | Just a starting box prefill for the dashboard's box editor, not enforced — the real box is drawn per video |
| `PORT` | Railway sets this automatically |

---

## ⚠️ SECURITY — read this before touching git

**Resolved.** A `.env` file was committed to this repo (commit `897d370`) and pushed to GitHub — but on inspection its values were unfilled placeholder text (`your_apify_token_here`, etc.), not real credentials, so nothing was actually exposed. `.env` has been fully removed from git tracking on both the feature branch and `main`; `.env.example` is the template now.

Rules going forward:
1. Never re-add `.env`, or any file containing real keys, to a commit — check `.gitignore` covers it before every commit that touches env-related files. Real key values go only into Railway's environment variable settings, never into a committed file.
2. Never print, log, or echo full key values back in chat, commit messages, or code comments.

## Editing rules — follow these on every task

- **Always edit via targeted find-and-replace / diffs on existing files.** Never regenerate a whole file from scratch for a small change — this wastes tokens and makes changes hard to review.
- **One logical change per patch.** State what you're about to change and why, make that one change, then stop and wait for confirmation before starting the next one.
- **Never deploy, push to `main`/remote, or trigger a Railway deploy without asking first — and waiting for an explicit yes.** This includes `git push`, Railway CLI deploys, or anything that ships code to production.
- No conceptual explanations unless asked — just the change and a one-line reason.
- Don't ask clarifying questions about style/preference mid-task — pick a reasonable default, note the assumption in one line, and deliver working code the first time.

---

## Current status

Deployed and live on Railway (`polycool-repost-bot-production.up.railway.app`), connected to `main`, auto-redeploys on push. All env vars are set including real Apify + Post Bridge credentials. Confirmed working end-to-end at least once: Apify fetch → download → dashboard box editor → rebrand (both logo and custom-text modes tested) → password-gated approve/reject queue. `PROCESS_SINCE_DATE` stops it from ever touching Polymarket's back-catalog.

Not yet confirmed: an actual Approve click going all the way through to a real post landing on Polycool's TikTok/YouTube — everything up to that button has been tested, but the live Post Bridge upload+publish call itself hasn't been watched succeed yet.

## Next steps (in order)

1. **Do one real end-to-end approve** — pick a video in Pending Review, hit Approve, and confirm it actually shows up on Polycool's TikTok and YouTube.
2. **Try the box editor on more of Polymarket's video styles** as they show up (corner bug, tweet card, trending card, others not seen yet) — logo mode and custom-text mode should both hold up, but only real-world use will surface layout cases that don't.
3. **Replace the placeholder logo assets** (`assets/polycool-logo.png` / `-light.png`) with professionally designed ones when available — current ones were generated from a phone screenshot.
4. **Consider a Railway Volume** mounted at `/app/data`. Right now `data/raw` and `data/pending` (and `state.json`) are wiped on every redeploy — anything sitting in Needs Setup or Pending Review at deploy time is lost. Worth doing before this runs unattended for real.
5. **Post Bridge webhook** (get notified when a post finishes) — intentionally skipped for now, not essential. Revisit if you want pass/fail confirmation on published posts.

---

## After every session

Before ending a session where you changed code or fixed something:
1. Update **Current status** above to reflect what's actually true now.
2. Move any completed items out of **Next steps** (or mark them done), and add any new ones you discovered.
3. If you touched the security section's concerns, update that section too — don't leave stale warnings once resolved.
4. Keep this update itself as a small targeted edit to this file, not a full rewrite.

