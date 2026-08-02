// Polycool Repost Bot
// Pulls new videos from Polymarket's Instagram, swaps "Polymarket" -> "Polycool"
// in the caption AND the on-video logo, then posts to Polycool's TikTok + YouTube
// via Post Bridge.

const express = require("express");
const cron = require("node-cron");
const ffmpegPath = require("ffmpeg-static");
const { execFile } = require("child_process");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const app = express();
app.use(express.static(__dirname)); // serves index.html

const DATA_DIR = path.join(__dirname, "data");
const TMP_DIR = path.join(DATA_DIR, "tmp");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const LOGO_PATH = path.join(__dirname, "assets", "polycool-logo.png");

const ENV = {
  apifyToken: process.env.APIFY_API_TOKEN,
  apifyActor: process.env.APIFY_ACTOR || "apify~instagram-scraper",
  igUrl: process.env.INSTAGRAM_SOURCE_URL,
  postBridgeKey: process.env.POST_BRIDGE_API_KEY,
  tiktokAccountId: process.env.POST_BRIDGE_TIKTOK_ACCOUNT_ID,
  youtubeAccountId: process.env.POST_BRIDGE_YOUTUBE_ACCOUNT_ID,
  intervalMinutes: parseInt(process.env.CHECK_INTERVAL_MINUTES || "20", 10),
  logoCover: {
    x: process.env.LOGO_COVER_X || "16",
    y: process.env.LOGO_COVER_Y || "16",
    w: process.env.LOGO_COVER_W || "280",
    h: process.env.LOGO_COVER_H || "72",
  },
  logoOverlay: {
    x: process.env.LOGO_OVERLAY_X || "20",
    y: process.env.LOGO_OVERLAY_Y || "20",
  },
  port: process.env.PORT || 3000,
};

// ---------- state + logging ----------

let state = { lastProcessedId: null, lastCheck: null, history: [] };

async function loadState() {
  await fsp.mkdir(TMP_DIR, { recursive: true });
  try {
    state = JSON.parse(await fsp.readFile(STATE_FILE, "utf8"));
  } catch {
    await saveState();
  }
}

async function saveState() {
  await fsp.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

function log(message) {
  console.log(message);
  state.history.unshift({ time: new Date().toISOString(), message });
  state.history = state.history.slice(0, 50);
}

// ---------- step 1: find new videos on Instagram (via Apify) ----------

async function fetchLatestInstagramPosts() {
  const url = `https://api.apify.com/v2/acts/${ENV.apifyActor}/run-sync-get-dataset-items?token=${ENV.apifyToken}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      directUrls: [ENV.igUrl],
      resultsType: "posts",
      resultsLimit: 5,
    }),
  });
  if (!res.ok) throw new Error(`Apify request failed: ${res.status}`);
  const posts = await res.json();
  // NOTE: verify these field names against your actual Apify dataset output
  // (Apify actors occasionally rename fields) — check one run in the Apify console.
  return posts
    .filter((p) => p.videoUrl)
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

// ---------- step 2: download the source video ----------

async function downloadFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  await fsp.writeFile(destPath, buffer);
  return destPath;
}

// ---------- step 3: cover old logo + overlay Polycool logo ----------

function rebrandVideo(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const { x, y, w, h } = ENV.logoCover;
    const filter =
      `[0:v]drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=black:t=fill[bg];` +
      `[bg][1:v]overlay=x=${ENV.logoOverlay.x}:y=${ENV.logoOverlay.y}`;
    const args = [
      "-i", inputPath,
      "-i", LOGO_PATH,
      "-filter_complex", filter,
      "-c:v", "libx264", "-crf", "18", "-preset", "veryfast",
      "-pix_fmt", "yuv420p", "-c:a", "copy", "-movflags", "+faststart",
      "-y", outputPath,
    ];
    execFile(ffmpegPath, args, (err) => (err ? reject(err) : resolve(outputPath)));
  });
}

// ---------- step 4: rewrite caption ----------

function rebrandCaption(caption) {
  return (caption || "").replace(/Polymarket/gi, "Polycool");
}

// ---------- step 5: push to Post Bridge ----------

async function postBridgeUpload(filePath) {
  const stat = await fsp.stat(filePath);
  const createRes = await fetch("https://api.post-bridge.com/v1/media/create-upload-url", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ENV.postBridgeKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      mime_type: "video/mp4",
      size_bytes: stat.size,
      name: path.basename(filePath),
    }),
  });
  if (!createRes.ok) throw new Error(`Post Bridge upload-url failed: ${createRes.status}`);
  const { media_id, upload_url } = await createRes.json();

  const fileBuffer = await fsp.readFile(filePath);
  const putRes = await fetch(upload_url, {
    method: "PUT",
    headers: { "Content-Type": "video/mp4" },
    body: fileBuffer,
  });
  if (!putRes.ok) throw new Error(`Post Bridge file upload failed: ${putRes.status}`);

  return media_id;
}

async function postBridgeCreatePost(mediaId, caption) {
  const accounts = [ENV.tiktokAccountId, ENV.youtubeAccountId].filter(Boolean);
  const res = await fetch("https://api.post-bridge.com/v1/posts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ENV.postBridgeKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      caption,
      media: [mediaId],
      social_accounts: accounts,
    }),
  });
  if (!res.ok) throw new Error(`Post Bridge post creation failed: ${res.status}`);
  return res.json();
}

// ---------- the full pipeline ----------

async function checkForNewContent() {
  state.lastCheck = new Date().toISOString();
  try {
    const posts = await fetchLatestInstagramPosts();
    const newPosts = posts.filter((p) => p.id !== state.lastProcessedId);

    if (newPosts.length === 0) {
      log("No new videos found.");
      await saveState();
      return { processed: 0 };
    }

    let processedCount = 0;
    for (const post of newPosts) {
      const inputPath = path.join(TMP_DIR, `in-${post.id}.mp4`);
      const outputPath = path.join(TMP_DIR, `out-${post.id}.mp4`);
      try {
        log(`New video found: ${post.id}`);
        await downloadFile(post.videoUrl, inputPath);
        await rebrandVideo(inputPath, outputPath);
        const caption = rebrandCaption(post.caption);
        const mediaId = await postBridgeUpload(outputPath);
        await postBridgeCreatePost(mediaId, caption);

        state.lastProcessedId = post.id;
        processedCount++;
        log(`Posted ${post.id} to Polycool TikTok + YouTube.`);
      } catch (err) {
        log(`Failed on ${post.id}: ${err.message}`);
      } finally {
        await fsp.rm(inputPath, { force: true });
        await fsp.rm(outputPath, { force: true });
      }
    }

    await saveState();
    return { processed: processedCount };
  } catch (err) {
    log(`Check failed: ${err.message}`);
    await saveState();
    throw err;
  }
}

// ---------- routes ----------

app.get("/api/status", (req, res) => {
  res.json({
    lastCheck: state.lastCheck,
    lastProcessedId: state.lastProcessedId,
    intervalMinutes: ENV.intervalMinutes,
    history: state.history,
  });
});

app.post("/api/check-now", async (req, res) => {
  try {
    const result = await checkForNewContent();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- startup ----------

loadState().then(() => {
  app.listen(ENV.port, () => {
    log(`Server running on port ${ENV.port}`);
    cron.schedule(`*/${ENV.intervalMinutes} * * * *`, () => {
      checkForNewContent().catch(() => {});
    });
  });
});

