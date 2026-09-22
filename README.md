# TymbleTime 🎀

A gymnastics video coach. Upload a clip, and you get a review with scores on 8 dimensions, the #1 fix, drills, key frames and estimated points off.

## The coach app (`app/`)

- **Privacy:** the video never leaves the phone. The browser trims it, crops black bars and extracts about 24 still frames. Only those frames go to the server, which sends them to Claude (`claude-opus-5`) and never stores them.
- **Access:** the password gate is enforced on the server with an HMAC-signed, httpOnly cookie. Failed logins are throttled.
- **Cost guard:** `DAILY_LIMIT` caps reviews per day (default 40), at roughly $0.10–0.25 per review.
- **History:** past reviews are saved in the browser on that device only.

### Deploy on Render

1. Render dashboard → **New → Blueprint** → pick this repo. It reads `render.yaml`.
2. Set `SITE_PASSWORD` and `ANTHROPIC_API_KEY` when prompted.

### Run locally

```bash
cd app && npm ci
SITE_PASSWORD='…' TT_MOCK=1 npm start          # mock coach, no API key needed
SITE_PASSWORD='…' ANTHROPIC_API_KEY='…' npm start
```

## The first review (`index.html`)

This is a static, encrypted page on GitHub Pages. `index.html` holds the review encrypted with AES-256-GCM (key from PBKDF2-SHA256, 600k iterations). Rebuild it after editing `private/report.html`:

```bash
TT_PASSWORD='…' node build.mjs
```
