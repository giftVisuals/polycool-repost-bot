// Polycool Repost Bot
// Pulls new videos from Polymarket's Instagram, swaps "Polymarket" -> "Polycool"
// in the caption AND the on-video logo, then posts to Polycool's TikTok + YouTube
// via Post Bridge.

const express = require("express");
const cron = require("node-cron");
const ffmpegPath = require("ffmpeg-static");
const { execFile } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const Tesseract = require("tesseract.js");

const app = express();
app.use(express.json());
app.use(express.static(__dirname)); // serves index.html

const DATA_DIR = path.join(__dirname, "data");
const RAW_DIR = path.join(DATA_DIR, "raw");
const PENDING_DIR = path.join(DATA_DIR, "pending");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const LOGO_PATH_DARK = path.join(__dirname, "assets", "polycool-logo.png");
const LOGO_PATH_LIGHT = path.join(__dirname, "assets", "polycool-logo-light.png");
const FONT_DIR = path.join(__dirname, "assets", "fonts");
const OCR_LANG_PATH = path.join(__dirname, "node_modules", "@tesseract.js-data", "eng", "4.0.0_best_int");

// no-store: filenames are reused (always <post-id>.mp4/.jpg), so a rejected-then-
// re-rebranded post could otherwise show a browser-cached copy of the old file.
const noCache = { setHeaders: (res) => res.set("Cache-Control", "no-store") };
app.use("/pending", express.static(PENDING_DIR, noCache)); // lets <video> tags play queued clips
app.use("/raw", express.static(RAW_DIR, noCache)); // serves raw clips + their frame previews for the box editor

const ENV = {
  apifyToken: process.env.APIFY_API_TOKEN,
  apifyActor: process.env.APIFY_ACTOR || "apify~instagram-scraper",
  igUrl: process.env.INSTAGRAM_SOURCE_URL,
  postBridgeKey: process.env.POST_BRIDGE_API_KEY,
  tiktokAccountId: process.env.POST_BRIDGE_TIKTOK_ACCOUNT_ID,
  youtubeAccountId: process.env.POST_BRIDGE_YOUTUBE_ACCOUNT_ID,
  intervalMinutes: parseInt(process.env.CHECK_INTERVAL_MINUTES || "20", 10),
  // Never process anything posted before this date, no matter what Apify returns.
  processSinceDate: new Date(process.env.PROCESS_SINCE_DATE || "2026-08-03T00:00:00Z"),
  approvalPassword: process.env.APPROVAL_PASSWORD || null,
  // Starting point for the box editor on each new video — not auto-applied anymore,
  // just a convenient prefill since Polymarket's layout keeps changing.
  defaultBox: {
    x: parseInt(process.env.LOGO_COVER_X || "16", 10),
    y: parseInt(process.env.LOGO_COVER_Y || "16", 10),
    w: parseInt(process.env.LOGO_COVER_W || "280", 10),
    h: parseInt(process.env.LOGO_COVER_H || "72", 10),
  },
  port: process.env.PORT || 3000,
};

// ---------- state + logging ----------

let state = { lastProcessedId: null, lastCheck: null, history: [], pending: [], raw: [], lastBox: null };

async function loadState() {
  await fsp.mkdir(RAW_DIR, { recursive: true });
  await fsp.mkdir(PENDING_DIR, { recursive: true });
  try {
    state = JSON.parse(await fsp.readFile(STATE_FILE, "utf8"));
    state.pending = state.pending || [];
    state.raw = state.raw || [];
    state.lastBox = state.lastBox || null;
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
  return fetchInstagramPosts([ENV.igUrl], 5);
}

async function fetchInstagramPosts(directUrls, resultsLimit) {
  const url = `https://api.apify.com/v2/acts/${ENV.apifyActor}/run-sync-get-dataset-items?token=${ENV.apifyToken}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      directUrls,
      resultsType: "posts",
      resultsLimit,
    }),
  });
  if (!res.ok) throw new Error(`Apify request failed: ${res.status}`);
  const posts = await res.json();

  // Diagnostic: Apify actors occasionally rename/rearrange fields between versions —
  // this makes the actual type/productType values visible in the dashboard's Activity
  // log so field-matching problems below can be fixed against real data, not guesses.
  const summary = posts.map((p) => `${String(p.id).slice(-6)}:type=${p.type}/pt=${p.productType}`).join(", ");
  log(`Fetched ${posts.length} post(s) — ${summary}`);

  // Reels/Shorts are marked productType "clips" by Apify's Instagram scraper — that's
  // the documented signal, more reliable than guessing at carousel-specific fields.
  const isReel = (p) => (p.productType ? p.productType === "clips" : p.videoUrl && !isCarousel(p));
  const skipped = posts.filter((p) => !isReel(p)).length;
  if (skipped > 0) log(`Skipped ${skipped} non-Reel post(s) — only Reels/Shorts are processed.`);

  return posts.filter(isReel).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

// Fallback only used if this actor's response has no productType field at all.
// Carousels ("Sidecar" posts) have multiple slides.
function isCarousel(post) {
  return post.type === "Sidecar" || (Array.isArray(post.childPosts) && post.childPosts.length > 0);
}

// ---------- step 2: download the source video ----------

async function downloadFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  await fsp.writeFile(destPath, buffer);
  return destPath;
}

// ---------- step 2b: read the downloaded video's actual dimensions ----------

function getVideoDimensions(filePath) {
  return new Promise((resolve, reject) => {
    // ffmpeg exits non-zero when given no output file — that's expected, we just want
    // the "Video: ... WxH" line it prints to stderr while probing the input.
    execFile(ffmpegPath, ["-i", filePath], (err, stdout, stderr) => {
      const match = /Video:.*?(\d{2,5})x(\d{2,5})/.exec(stderr || "");
      if (!match) return reject(new Error("Could not read video dimensions"));
      resolve({ width: parseInt(match[1], 10), height: parseInt(match[2], 10) });
    });
  });
}

// ---------- step 2c: grab a still frame so the dashboard can show a box editor ----------

function extractFirstFrame(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, ["-i", inputPath, "-vframes", "1", "-y", outputPath], (err) =>
      err ? reject(err) : resolve(outputPath)
    );
  });
}

// ---------- step 2c-2: OCR the frame to suggest where "Polymarket" actually is ----------
// Dragging a box by eye is the most annoying part of this workflow. Since the branding
// almost always includes the word "Polymarket" as text, OCR can usually find its exact
// pixel position automatically — the box editor still lets you drag/adjust if it's wrong
// or missing, this is just a starting point instead of starting from nothing.

let ocrWorkerPromise = null;
function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = Tesseract.createWorker("eng", 1, {
      langPath: OCR_LANG_PATH,
      cachePath: path.join(DATA_DIR, "ocr-cache"),
    });
  }
  return ocrWorkerPromise;
}

function looksLikePolymarket(text) {
  const t = text.toLowerCase().replace(/[^a-z]/g, "");
  return t.includes("polymarket") || t.includes("polymark") || (t.startsWith("poly") && t.length >= 6);
}

async function suggestTextBox(framePath) {
  try {
    const worker = await getOcrWorker();
    const result = await worker.recognize(framePath, {}, { text: true, blocks: true });
    const words = [];
    for (const block of result.data.blocks || []) {
      for (const para of block.paragraphs || []) {
        for (const line of para.lines || []) {
          for (const word of line.words || []) words.push(word);
        }
      }
    }
    const match = words.find((w) => looksLikePolymarket(w.text));
    if (!match) return { found: false };

    const { x0, y0, x1, y1 } = match.bbox;
    const textBox = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    // Logo mode also needs to cover an icon that usually sits just left of the word —
    // pad generously so a first drag isn't required, only fine-tuning.
    const pad = Math.round(textBox.h * 0.3);
    const iconWidth = Math.round(textBox.h * 1.4);
    const logoBox = {
      x: Math.max(0, textBox.x - iconWidth - pad),
      y: Math.max(0, textBox.y - pad),
      w: textBox.w + iconWidth + pad * 2,
      h: textBox.h + pad * 2,
    };
    return { found: true, textBox, logoBox };
  } catch (err) {
    log(`OCR suggestion failed: ${err.message}`);
    return { found: false };
  }
}

// ---------- step 2d: detect whether a given box region is light or dark themed ----------
// Polymarket's posts use a white card with dark text sometimes, and a black card with
// light text other times. Sample the average brightness of the box on the first frame
// to pick a matching cover color + text/logo color automatically.

function detectBoxTheme(inputPath, box) {
  return new Promise((resolve) => {
    const { x, y, w, h } = box;
    const filter = `crop=${w}:${h}:${x}:${y},signalstats,metadata=print:key=lavfi.signalstats.YAVG`;
    execFile(ffmpegPath, ["-i", inputPath, "-vf", filter, "-vframes", "1", "-f", "null", "-"], (err, stdout, stderr) => {
      const match = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(stderr || "");
      // Default to "dark" (the original assumption) if we can't read a frame at all.
      if (!match) return resolve("dark");
      resolve(parseFloat(match[1]) > 128 ? "light" : "dark");
    });
  });
}

// ffmpeg-static's bundled binary has no "drawtext" filter compiled in, so custom text
// is rendered via the "ass" (libass subtitle) filter instead, which is available and
// works with our bundled font regardless of what fonts the host OS has installed.
// Curly braces/backslashes are stripped since they're ASS override-tag syntax — left in,
// injected text could add its own positioning/formatting commands.
function escapeAssText(str) {
  return String(str).replace(/[{}\\]/g, "").replace(/\r?\n/g, " ");
}

async function buildAssFile(assPath, text, box, theme, videoWidth, videoHeight) {
  const isLight = theme === "light";
  const color = isLight ? "&H00000000" : "&H00FFFFFF"; // ASS is &HAABBGGRR; 00 alpha = opaque
  const fontSize = Math.max(10, Math.floor(box.h * 0.6));
  const cx = Math.round(box.x + box.w / 2);
  const cy = Math.round(box.y + box.h / 2);
  const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: ${videoWidth}
PlayResY: ${videoHeight}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,DejaVu Sans,${fontSize},${color},&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,5,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,9:59:59.00,Default,,0,0,0,,{\\pos(${cx},${cy})}${escapeAssText(text)}
`;
  await fsp.writeFile(assPath, ass);
}

// ---------- step 3: cover old branding + put Polycool's logo or text in its place ----------
// box = { x, y, w, h } drawn by hand on the dashboard for this specific video.
// mode "logo" pastes the (auto light/dark) Polycool logo, scaled to fit inside the box.
// mode "text" draws custom text in the box instead — for layouts where only the word
// needs swapping and the icon next to it doesn't need covering.

async function rebrandVideo(inputPath, outputPath, box, mode, text, theme) {
  const { x, y, w, h } = box;
  const isLight = theme === "light";
  const coverColor = isLight ? "white" : "black";
  const args = ["-i", inputPath];
  let filter;
  let assPath = null;

  if (mode === "text") {
    const { width, height } = await getVideoDimensions(inputPath);
    assPath = `${outputPath}.ass`;
    await buildAssFile(assPath, text, box, theme, width, height);
    filter =
      `[0:v]drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${coverColor}:t=fill,` +
      `ass=filename=${assPath}:fontsdir=${FONT_DIR}`;
  } else {
    const logoPath = isLight ? LOGO_PATH_LIGHT : LOGO_PATH_DARK;
    args.push("-i", logoPath);
    filter =
      `[0:v]drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${coverColor}:t=fill[bg];` +
      `[1:v]scale=w=${w}:h=${h}:force_original_aspect_ratio=decrease,` +
      `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=0x00000000[logo];` +
      `[bg][logo]overlay=x=${x}:y=${y}`;
  }

  args.push(
    "-filter_complex", filter,
    "-c:v", "libx264", "-crf", "18", "-preset", "veryfast",
    "-pix_fmt", "yuv420p", "-c:a", "copy", "-movflags", "+faststart",
    "-y", outputPath
  );

  try {
    await new Promise((resolve, reject) => {
      execFile(ffmpegPath, args, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve()));
    });
  } finally {
    if (assPath) await fsp.rm(assPath, { force: true });
  }
  return outputPath;
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

// Downloads one post's video + first frame into the raw/Needs Setup queue.
// Returns true if it was added, false if skipped (already queued, or download failed).
async function queueRawVideo(post) {
  const alreadyQueued = state.raw.some((r) => r.id === post.id) || state.pending.some((p) => p.id === post.id);
  if (alreadyQueued) return false;

  const filename = `${post.id}.mp4`;
  const videoPath = path.join(RAW_DIR, filename);
  const framePath = path.join(RAW_DIR, `${post.id}.jpg`);
  try {
    log(`New video found: ${post.id}`);
    await downloadFile(post.videoUrl, videoPath);
    await extractFirstFrame(videoPath, framePath);
    const suggestion = await suggestTextBox(framePath);

    state.raw.push({
      id: post.id,
      filename,
      caption: rebrandCaption(post.caption),
      originalCaption: post.caption || "",
      addedAt: new Date().toISOString(),
      suggestion,
    });
    log(
      suggestion.found
        ? `New video ready for setup: ${post.id} (auto-detected "Polymarket" text)`
        : `New video ready for setup: ${post.id} (couldn't auto-detect text — drag manually)`
    );
    return true;
  } catch (err) {
    log(`Failed on ${post.id}: ${err.message}`);
    await fsp.rm(videoPath, { force: true });
    await fsp.rm(framePath, { force: true });
    return false;
  }
}

// ---------- the full pipeline ----------

// Guards against overlapping runs — e.g. auto-check firing at the same moment as a
// manual "Check now" click — which previously could queue the same post twice.
let checkInProgress = false;

async function checkForNewContent() {
  if (checkInProgress) {
    log("Check already in progress, skipped.");
    return { processed: 0, skipped: true };
  }
  checkInProgress = true;
  state.lastCheck = new Date().toISOString();
  try {
    const posts = await fetchLatestInstagramPosts();
    const tooOld = posts.filter((p) => new Date(p.timestamp) < ENV.processSinceDate).length;
    if (tooOld > 0) log(`Skipped ${tooOld} post(s) from before ${ENV.processSinceDate.toDateString()}.`);

    const newPosts = posts.filter(
      (p) => p.id !== state.lastProcessedId && new Date(p.timestamp) >= ENV.processSinceDate
    );

    if (newPosts.length === 0) {
      log("No new videos found.");
      await saveState();
      return { processed: 0 };
    }

    let processedCount = 0;
    for (const post of newPosts) {
      const added = await queueRawVideo(post);
      if (added) {
        state.lastProcessedId = post.id;
        processedCount++;
      }
    }

    await saveState();
    return { processed: processedCount };
  } catch (err) {
    log(`Check failed: ${err.message}`);
    await saveState();
    throw err;
  } finally {
    checkInProgress = false;
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

// Manually pull specific Instagram Reel URLs into Needs Setup, for testing —
// bypasses the profile URL, the date cutoff, and the last-processed-id dedup.
app.post("/api/test-fetch", async (req, res) => {
  const urls = (req.body && req.body.urls) || [];
  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ ok: false, error: "Provide at least one Instagram Reel URL." });
  }
  try {
    const posts = await fetchInstagramPosts(urls, urls.length);
    let added = 0;
    for (const post of posts) {
      if (await queueRawVideo(post)) added++;
    }
    await saveState();
    res.json({ ok: true, added, found: posts.length });
  } catch (err) {
    log(`Test fetch failed: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/pending", (req, res) => {
  res.json({
    pending: state.pending.map((p) => ({ ...p, videoUrl: `/pending/${p.filename}` })),
  });
});

app.get("/api/raw", (req, res) => {
  res.json({
    raw: state.raw.map((r) => ({
      ...r,
      videoUrl: `/raw/${r.filename}`,
      frameUrl: `/raw/${r.id}.jpg`,
    })),
    defaultBox: state.lastBox || ENV.defaultBox,
  });
});

app.get("/api/raw/:id/meta", async (req, res) => {
  const item = state.raw.find((r) => r.id === req.params.id);
  if (!item) return res.status(404).json({ ok: false, error: "Not found" });
  try {
    const dimensions = await getVideoDimensions(path.join(RAW_DIR, item.filename));
    res.json({ ok: true, ...dimensions });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/raw/:id/discard", async (req, res) => {
  const item = state.raw.find((r) => r.id === req.params.id);
  if (!item) return res.status(404).json({ ok: false, error: "Not found" });
  state.raw = state.raw.filter((r) => r.id !== item.id);
  await fsp.rm(path.join(RAW_DIR, item.filename), { force: true });
  await fsp.rm(path.join(RAW_DIR, `${item.id}.jpg`), { force: true });
  log(`Discarded ${item.id} from Needs Setup — not posted.`);
  await saveState();
  res.json({ ok: true });
});

app.post("/api/raw/:id/rebrand", async (req, res) => {
  const item = state.raw.find((r) => r.id === req.params.id);
  if (!item) return res.status(404).json({ ok: false, error: "Not found" });

  const rawPathNoEdit = path.join(RAW_DIR, item.filename);
  const outputPathNoEdit = path.join(PENDING_DIR, item.filename);
  if (req.body && req.body.mode === "none") {
    try {
      await fsp.rename(rawPathNoEdit, outputPathNoEdit);
      state.pending.push({
        id: item.id,
        filename: item.filename,
        caption: item.caption,
        originalCaption: item.originalCaption,
        addedAt: new Date().toISOString(),
        theme: null,
        box: null,
        mode: "none",
      });
      state.raw = state.raw.filter((r) => r.id !== item.id);
      await fsp.rm(path.join(RAW_DIR, `${item.id}.jpg`), { force: true });
      log(`Queued ${item.id} for review with no on-video edit.`);
      await saveState();
      return res.json({ ok: true });
    } catch (err) {
      log(`Queueing failed for ${item.id}: ${err.message}`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  const { x, y, w, h, mode, text } = req.body || {};
  const box = { x: Math.round(Number(x)), y: Math.round(Number(y)), w: Math.round(Number(w)), h: Math.round(Number(h)) };
  if (!Number.isFinite(box.x) || !Number.isFinite(box.y) || box.w <= 0 || box.h <= 0) {
    return res.status(400).json({ ok: false, error: "Invalid box — drag a rectangle over the branding first." });
  }
  if (mode === "text" && !String(text || "").trim()) {
    return res.status(400).json({ ok: false, error: "Enter replacement text first." });
  }

  const rawPath = path.join(RAW_DIR, item.filename);
  const outputPath = path.join(PENDING_DIR, item.filename);
  try {
    const theme = await detectBoxTheme(rawPath, box);
    await rebrandVideo(rawPath, outputPath, box, mode, text, theme);

    state.pending.push({
      id: item.id,
      filename: item.filename,
      caption: item.caption,
      originalCaption: item.originalCaption,
      addedAt: new Date().toISOString(),
      theme,
      box,
      mode,
    });
    state.raw = state.raw.filter((r) => r.id !== item.id);
    state.lastBox = box;
    await fsp.rm(rawPath, { force: true });
    await fsp.rm(path.join(RAW_DIR, `${item.id}.jpg`), { force: true });
    log(`Rebranded ${item.id} (${theme} theme, ${mode} mode) — ready for review.`);
    await saveState();
    res.json({ ok: true });
  } catch (err) {
    log(`Rebrand failed for ${item.id}: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

function isPasswordValid(submitted) {
  if (!ENV.approvalPassword) return false;
  const a = Buffer.from(String(submitted || ""));
  const b = Buffer.from(ENV.approvalPassword);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.post("/api/pending/:id/approve", async (req, res) => {
  if (!ENV.approvalPassword) {
    return res.status(500).json({ ok: false, error: "APPROVAL_PASSWORD is not set on the server." });
  }
  if (!isPasswordValid(req.body && req.body.password)) {
    return res.status(401).json({ ok: false, error: "Incorrect password." });
  }
  const item = state.pending.find((p) => p.id === req.params.id);
  if (!item) return res.status(404).json({ ok: false, error: "Not found" });
  try {
    const filePath = path.join(PENDING_DIR, item.filename);
    const mediaId = await postBridgeUpload(filePath);
    await postBridgeCreatePost(mediaId, item.caption);
    state.pending = state.pending.filter((p) => p.id !== item.id);
    await fsp.rm(filePath, { force: true });
    log(`Approved & posted ${item.id} to Polycool TikTok + YouTube.`);
    await saveState();
    res.json({ ok: true });
  } catch (err) {
    log(`Approve failed for ${item.id}: ${err.message}`);
    await saveState();
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/pending/:id/reject", async (req, res) => {
  if (!ENV.approvalPassword) {
    return res.status(500).json({ ok: false, error: "APPROVAL_PASSWORD is not set on the server." });
  }
  if (!isPasswordValid(req.body && req.body.password)) {
    return res.status(401).json({ ok: false, error: "Incorrect password." });
  }
  const item = state.pending.find((p) => p.id === req.params.id);
  if (!item) return res.status(404).json({ ok: false, error: "Not found" });
  state.pending = state.pending.filter((p) => p.id !== item.id);
  await fsp.rm(path.join(PENDING_DIR, item.filename), { force: true });
  log(`Rejected ${item.id} — not posted.`);
  await saveState();
  res.json({ ok: true });
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

