import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import fs from "fs";
import { spawn, spawnSync } from "child_process";
import crypto from "crypto";
import { Readable } from "stream";

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

app.use(express.json());

// ─── Version check config ──────────────────────────────────────────────────────
const APP_VERSION_CONFIG = {
  android: {
    minVersion: 1,
    latestVersion: 2,
    updateUrl: "https://codetutorium.com/downloads/all-video-downloader.apk"
  }
};

// Allow requests from Capacitor Android (http://localhost),
// Capacitor iOS (capacitor://localhost), and browsers (any origin).
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

// Enforce client version restrictions to block outdated requests
app.use((req, res, next) => {
  if (!req.path.startsWith("/api/") || req.path.startsWith("/api/version-check")) {
    return next();
  }
  const platform = req.query.platform || req.body?.platform;
  const versionStr = req.query.version || req.body?.version;
  if (platform === "android") {
    const clientVersion = parseInt(versionStr as string, 10) || 1;
    const config = APP_VERSION_CONFIG.android;
    if (clientVersion < config.minVersion) {
      return res.status(426).json({
        error: "App update required. This version is no longer supported and has stopped working.",
        updateUrl: config.updateUrl,
      });
    }
  }
  next();
});

const isWin = process.platform === "win32";
const YTDLP_FILENAME = isWin ? "yt-dlp.exe" : "yt-dlp";
const YTDLP_PATH = path.join(process.cwd(), YTDLP_FILENAME);

const downloadsDir = path.join(process.cwd(), "downloads");
if (!fs.existsSync(downloadsDir)) {
  fs.mkdirSync(downloadsDir, { recursive: true });
}

// ─── ffmpeg availability check ────────────────────────────────────────────────
// Without ffmpeg, yt-dlp cannot merge separate video+audio streams.
// We detect this at startup so we can choose the right format selector.
const hasFfmpeg: boolean = (() => {
  try {
    const result = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    if (result.status === 0) {
      console.log('[server] ffmpeg detected — merge formats enabled.');
      return true;
    }
  } catch { /* not found */ }
  console.warn('[server] ffmpeg NOT found — using pre-merged stream formats only. Videos will still be MP4 but limited to 720p.');
  return false;
})();

// ─── Valid media extensions — NEVER return metadata JSON or partials ──────────
const MEDIA_EXTS = new Set(['mp4', 'webm', 'mkv', 'mp3', 'm4a', 'ogg', 'opus', 'mov', 'avi']);

async function downloadYtDlp() {
  if (fs.existsSync(YTDLP_PATH)) return;
  console.log(`Downloading yt-dlp binary for platform ${process.platform}...`);
  const url = isWin
    ? "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
    : "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp";

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download yt-dlp: HTTP ${res.status}`);
  }
  const fileStream = fs.createWriteStream(YTDLP_PATH);
  await new Promise<void>((resolve, reject) => {
    Readable.fromWeb(res.body as any).pipe(fileStream);
    fileStream.on("finish", () => {
      fileStream.close();
      if (!isWin) {
        fs.chmodSync(YTDLP_PATH, 0o755);
      }
      console.log("yt-dlp downloaded completely.");
      resolve();
    });
    fileStream.on("error", (err) => {
      fs.unlink(YTDLP_PATH, () => {});
      reject(err);
    });
  });
}

function cleanOldDownloads() {
  if (!fs.existsSync(downloadsDir)) return;
  const now = Date.now();
  const maxAge = 30 * 60 * 1000; // 30 minutes
  fs.readdir(downloadsDir, (err, files) => {
    if (err) return;
    for (const file of files) {
      const filepath = path.join(downloadsDir, file);
      fs.stat(filepath, (err, stats) => {
        if (err) return;
        if (now - stats.mtimeMs > maxAge) {
          fs.unlink(filepath, () => {});
        }
      });
    }
  });
}
setInterval(cleanOldDownloads, 10 * 60 * 1000);

const execYtDlp = (args: string[]): Promise<string> => {
  return new Promise((resolve, reject) => {
    const process = spawn(YTDLP_PATH, args);
    let stdout = "";
    let stderr = "";
    process.stdout.on("data", (data) => (stdout += data.toString()));
    process.stderr.on("data", (data) => (stderr += data.toString()));
    process.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr || stdout || "Unknown error stringifying"));
      }
    });
    process.on("error", (err) => reject(err));
  });
};

// ─── MIME type map ────────────────────────────────────────────────────────────
const MIME_MAP: Record<string, string> = {
  mp4:  "video/mp4",
  webm: "video/webm",
  mkv:  "video/x-matroska",
  mov:  "video/quicktime",
  avi:  "video/x-msvideo",
  mp3:  "audio/mpeg",
  m4a:  "audio/mp4",
  ogg:  "audio/ogg",
  opus: "audio/opus",
};

// ─── FIX 1: checkCachedFile — only return REAL media files, never .json ───────
/**
 * Returns the filename of a completed media file for the given cacheKey,
 * or null if not found. Only accepts known video/audio extensions.
 */
function checkCachedFile(cacheKey: string): string | null {
  try {
    const files = fs.readdirSync(downloadsDir);
    const match = files.find(f => {
      if (!f.startsWith(cacheKey)) return false;
      const ext = path.extname(f).substring(1).toLowerCase();
      // Only return actual completed media files
      return MEDIA_EXTS.has(ext) && !f.endsWith('.part') && !f.endsWith('.ytdl') && !f.endsWith('.tmp');
    });
    return match ?? null;
  } catch {
    return null;
  }
}

// ─── Video info endpoint ──────────────────────────────────────────────────────
app.post("/api/video-info", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "Missing URL field" });

  try {
    let title = "";
    let thumbnail = "";
    let uploader = "";

    const isYoutube = url.includes("youtube.com") || url.includes("youtu.be");

    if (isYoutube) {
      try {
        const oembedRes = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
        if (oembedRes.ok) {
          const oembed = await oembedRes.json();
          title = oembed.title;
          thumbnail = oembed.thumbnail_url;
          uploader = oembed.author_name;
        }
      } catch (e) {
        console.warn("oEmbed fetch failed", e);
      }
    }

    if (!title) {
      await downloadYtDlp();
      const output = await execYtDlp(["-j", "--no-warnings", url]);
      const info = JSON.parse(output);
      title = info.title;
      thumbnail = info.thumbnail;
uploader = info.uploader || info.extractor;
    }

    res.json({
      title: title || "Unknown Title",
      thumbnail: thumbnail || "",
      duration: 0,
      channel: uploader || "Unknown Channel",
    });
  } catch (error: any) {
    let errMsg = error.message || "Failed to fetch video information";
    if (errMsg.includes("Sign in to confirm you're not a bot")) {
      errMsg = "This video is protected by bot-detection. Please try a different URL or platform.";
    } else if (errMsg.includes("Video unavailable")) {
      errMsg = "This video is unavailable or private.";
    }
    res.status(500).json({ error: errMsg });
  }
});

// ─── Prepare stream endpoint ──────────────────────────────────────────────────
app.get("/api/prepare-stream", async (req, res) => {
  const { url, type, title, thumbnail } = req.query;
  if (!url || typeof url !== "string" || !type || typeof type !== "string") {
    return res.status(400).send("Missing parameters");
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const cacheKey = crypto.createHash("md5").update(`${url}_${type}`).digest("hex");
  const isYoutube = url.includes("youtube.com") || url.includes("youtu.be");

  // ─── Helper to emit SSE ───────────────────────────────────────────────────
  const emit = (data: object) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`); };
  const done = () => { if (!res.writableEnded) res.end(); };

  // ─── Serve from cache ─────────────────────────────────────────────────────
  const cachedFile = checkCachedFile(cacheKey);
  if (cachedFile) {
    const ext = path.extname(cachedFile).substring(1).toLowerCase();
    // Never serve cached WebM — Android won't play it. Delete and re-download.
    if (type === 'video' && (ext === 'webm' || ext === 'mkv')) {
      console.warn(`[cache] Deleting non-MP4 cached file: ${cachedFile}`);
      try { fs.unlinkSync(path.join(downloadsDir, cachedFile)); } catch {}
      try { fs.unlinkSync(path.join(downloadsDir, `${cacheKey}.json`)); } catch {}
      // fall through to re-download
    } else {
      const jsonPath = path.join(downloadsDir, `${cacheKey}.json`);
      if (!fs.existsSync(jsonPath)) {
        const metadata = { title: title || "Unknown Video", type, ext, thumbnail: thumbnail || "", downloadedAt: Date.now() };
        fs.writeFileSync(jsonPath, JSON.stringify(metadata, null, 2));
      }
      emit({ progress: 100, text: "Serving from cache", downloadUrl: `/api/download-file?key=${cacheKey}&ext=${ext}&title=${encodeURIComponent(title as string || "video")}` });
      done();
      return;
    }
  }

  // ─── Helper: download a direct URL and save it to the cache ─────────────────
  const saveDirectUrl = async (directUrl: string, ext: string): Promise<void> => {
    const destPath = path.join(downloadsDir, `${cacheKey}.${ext}`);
    const tmpPath = `${destPath}.tmp`;

    const fileRes = await fetch(directUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    if (!fileRes.ok || !fileRes.body) throw new Error(`HTTP ${fileRes.status}`);
    const ct = fileRes.headers.get('content-type') || '';
    if (ct.includes('text/html')) throw new Error('Server returned HTML instead of video');

    const fileStream = fs.createWriteStream(tmpPath);
    await new Promise<void>((resolve, reject) => {
      Readable.fromWeb(fileRes.body as any).pipe(fileStream);
      fileStream.on('finish', () => { fileStream.close(); resolve(); });
      fileStream.on('error', (e) => { fs.unlink(tmpPath, () => {}); reject(e); });
    });

    const savedSize = fs.statSync(tmpPath).size;
    if (savedSize < 4096) { fs.unlinkSync(tmpPath); throw new Error('File too small — likely an error page'); }

    fs.renameSync(tmpPath, destPath);
    const metadata = { title: title || 'Unknown Video', type, ext, thumbnail: thumbnail || '', downloadedAt: Date.now() };
    fs.writeFileSync(path.join(downloadsDir, `${cacheKey}.json`), JSON.stringify(metadata, null, 2));
  };

  // ─── Fallback chain — tried in order when yt-dlp fails ───────────────────
  // Service 1: cobalt.tools — fast, reliable, no polling loop needed
  // Service 2: loader.to — slower, needs progress polling
  // Both always return MP4/MP3, never WebM.
  const runFallbackChain = async () => {
    const ext = type === 'audio' ? 'mp3' : 'mp4';
    const downloadUrl = `/api/download-file?key=${cacheKey}&ext=${ext}&title=${encodeURIComponent(title as string || 'video')}`;

    // ── Service 1: cobalt.tools ───────────────────────────────────────────────
    try {
      emit({ progress: 15, text: 'Trying cobalt downloader...' });
      const cobaltRes = await fetch('https://api.cobalt.tools/', {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          videoQuality: type === 'audio' ? undefined : '1080',
          downloadMode: type === 'audio' ? 'audio' : 'auto',
          audioFormat: type === 'audio' ? 'mp3' : undefined,
          filenameStyle: 'basic'
        }),
        signal: AbortSignal.timeout(15000)
      });

      if (cobaltRes.ok) {
        const cobaltData = await cobaltRes.json();
        console.log('[cobalt]', cobaltData.status, cobaltData.url?.substring(0, 80));

        if ((cobaltData.status === 'stream' || cobaltData.status === 'tunnel' || cobaltData.status === 'redirect') && cobaltData.url) {
          emit({ progress: 60, text: 'Cobalt found the video! Saving...' });
          await saveDirectUrl(cobaltData.url, ext);
          emit({ progress: 100, text: 'Download complete!', downloadUrl });
          done();
          return;
        }

        if (cobaltData.status === 'picker' && cobaltData.picker?.[0]?.url) {
          emit({ progress: 60, text: 'Cobalt found the video! Saving...' });
          await saveDirectUrl(cobaltData.picker[0].url, ext);
          emit({ progress: 100, text: 'Download complete!', downloadUrl });
          done();
          return;
        }
      }
      console.warn('[cobalt] No usable URL — trying loader.to');
    } catch (cobaltErr: any) {
      console.warn('[cobalt] Failed:', cobaltErr.message, '— trying loader.to');
    }

    // ── Service 2: loader.to ──────────────────────────────────────────────────
    try {
      emit({ progress: 20, text: 'Trying loader.to downloader...' });
      const formatSelection = type === 'audio' ? 'mp3' : 'mp4';
      const startRes = await fetch(
        `https://loader.to/ajax/download.php?format=${formatSelection}&url=${encodeURIComponent(url)}`,
        { signal: AbortSignal.timeout(10000) }
      );
      const startData = await startRes.json();
      const progUrl = startData.progress_url || ('https://lto2.affadaffa.com/api/progress?id=' + startData.id);
      let proxyUrl: string | null = null;

      for (let i = 0; i < 30; i++) {  // 30 × 3s = 90s max
        await new Promise(r => setTimeout(r, 3000));
        const progRes = await fetch(progUrl, { signal: AbortSignal.timeout(8000) });
        const progData = await progRes.json();

        let pct = progData.progress || 0;
        if (pct > 100 && pct <= 1000) pct = Math.floor(pct / 10);
        emit({ progress: Math.min(80, Math.max(20, pct)), text: progData.text || 'Processing via loader.to...' });

        if (progData.success === 1 && progData.download_url) {
          proxyUrl = progData.download_url;
          break;
        }
      }

      if (proxyUrl) {
        emit({ progress: 88, text: 'Saving from loader.to...' });
        await saveDirectUrl(proxyUrl, ext);
        emit({ progress: 100, text: 'Download complete!', downloadUrl });
        done();
        return;
      }
      console.warn('[loader.to] Timed out — giving up');
    } catch (loaderErr: any) {
      console.warn('[loader.to] Failed:', loaderErr.message);
    }

    // All services failed
    emit({ error: 'All download services failed for this URL. Try a different video or platform.' });
    done();
  };

  // ─── Primary: yt-dlp ──────────────────────────────────────────────────────
  try {
    await downloadYtDlp();

    let args: string[] = [];

    // ── YouTube bot-detection bypass: use the iOS app client ─────────────────
    // The iOS YouTube client is less aggressively rate-limited than the web client.
    // This is the most effective bypass currently available without cookies.
    const ytBypassArgs = isYoutube
      ? ['--extractor-args', 'youtube:player_client=ios,mweb', '--user-agent',
         'com.google.ios.youtube/19.16.3 CFNetwork/1474 Darwin/23.0.0']
      : [];

    if (type === 'audio') {
      // Audio: extract to MP3 — universally playable on all devices
      args = [
        '-f', 'bestaudio[ext=m4a]/bestaudio',
        '-x', '--audio-format', 'mp3',
        '--audio-quality', '0',
        '--no-playlist',
        '--no-warnings',
        '--newline',
        '--progress-template', '%(progress)j',
        ...ytBypassArgs,
        url,
        '-o', path.join(downloadsDir, `${cacheKey}.mp3`)
      ];

    } else if (hasFfmpeg) {
      // ffmpeg available: merge H.264 + AAC → fast-start MP4
      args = [
        '-f', 'bestvideo[vcodec^=avc1][ext=mp4]+bestaudio[ext=m4a]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo[vcodec^=avc1]+bestaudio/best[ext=mp4]',
        '--merge-output-format', 'mp4',
        '--no-prefer-free-formats',
        '--no-playlist',
        '--no-warnings',
        '--newline',
        '--progress-template', '%(progress)j',
        '--postprocessor-args', 'ffmpeg:-movflags +faststart -c:v copy -c:a aac',
        ...ytBypassArgs,
        url,
        '-o', path.join(downloadsDir, `${cacheKey}.%(ext)s`)
      ];

    } else {
      // No ffmpeg: only pre-merged MP4 streams
      args = [
        '-f', 'best[ext=mp4][vcodec^=avc1]/best[ext=mp4]/worst[ext=mp4]',
        '--no-prefer-free-formats',
        '--no-playlist',
        '--no-warnings',
        '--newline',
        '--progress-template', '%(progress)j',
        ...ytBypassArgs,
        url,
        '-o', path.join(downloadsDir, `${cacheKey}.%(ext)s`)
      ];
    }

    const ytdlp = spawn(YTDLP_PATH, args);
    let buffer = "";
    let processFinished = false;

    emit({ progress: 1, text: "Starting download..." });

    ytdlp.stdout.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim().startsWith("{")) continue;
        try {
          const progress = JSON.parse(line.trim());
          if (progress.status === "downloading") {
            const pct = Math.floor(progress._percent || 0);
            const speed = progress._speed_str ? progress._speed_str.trim() : "";
            const eta = progress._eta_str ? progress._eta_str.trim() : "";
            const text = `Downloading ${pct}%${speed ? ` at ${speed}` : ""}${eta ? `, ETA ${eta}` : ""}`;
            emit({ progress: pct, text });
          }
        } catch {}
      }
    });

    ytdlp.stderr.on("data", (data) => {
      console.error("[yt-dlp stderr]", data.toString().trim());
    });

    let ytdlpFailed = false;
    ytdlp.on("error", (err) => {
      ytdlpFailed = true;
      processFinished = true;
      console.error("yt-dlp spawn error:", err);
      if (isYoutube && !res.writableEnded) { runFallbackChain(); }
      else { emit({ error: `yt-dlp error: ${err.message}` }); done(); }
    });

    ytdlp.on("close", (code) => {
      if (ytdlpFailed) return;
      processFinished = true;

      if (code === 0) {
        const finalFile = checkCachedFile(cacheKey);

        if (!finalFile) {
          console.warn("[yt-dlp] exit 0 but no output file found");
          if (isYoutube && !res.writableEnded) { runFallbackChain(); return; }
          emit({ error: "Download finished but no file was saved." });
          done();
          return;
        }

        const ext = path.extname(finalFile).substring(1).toLowerCase();
        const filePath = path.join(downloadsDir, finalFile);

        // ── CRITICAL MOBILE GUARD: WebM/MKV won't play on Android ─────────────
        // yt-dlp may succeed but output WebM. Detect, delete, fall back to loader.to.
        if (type === 'video' && (ext === 'webm' || ext === 'mkv')) {
          console.warn(`[yt-dlp] Unwanted format: ${ext} — falling back to loader.to`);
          try { fs.unlinkSync(filePath); } catch {}
          if (isYoutube && !res.writableEnded) { runFallbackChain(); return; }
          emit({ error: "Downloaded format (WebM) is not playable on mobile. Please try again." });
          done();
          return;
        }

        // ── Reject suspiciously small files ─────────────────────────────────
        try {
          const stat = fs.statSync(filePath);
          if (stat.size < 4096) {
            fs.unlinkSync(filePath);
            throw new Error("File too small — likely a download error.");
          }
        } catch (statErr: any) {
          if (isYoutube && !res.writableEnded) { runFallbackChain(); return; }
          emit({ error: statErr.message });
          done();
          return;
        }

        const metadata = { title: title || "Unknown Video", type, ext, thumbnail: thumbnail || "", downloadedAt: Date.now() };
        fs.writeFileSync(path.join(downloadsDir, `${cacheKey}.json`), JSON.stringify(metadata, null, 2));

        emit({ progress: 100, text: "Download complete!", downloadUrl: `/api/download-file?key=${cacheKey}&ext=${ext}&title=${encodeURIComponent(title as string || "video")}` });
        done();

      } else {
        console.warn(`[yt-dlp] Non-zero exit: ${code}`);
        if (isYoutube && !res.writableEnded) { runFallbackChain(); }
        else { emit({ error: `Download failed (yt-dlp exit ${code})` }); done(); }
      }
    });

    req.on("close", () => {
      if (!processFinished && ytdlp) {
        console.log("Client disconnected — killing yt-dlp");
        ytdlp.kill("SIGKILL");
      }
    });

  } catch (err: any) {
    console.error("prepare-stream error:", err);
    if (isYoutube && !res.writableEnded) { await runFallbackChain(); }
    else { emit({ error: err.message || "Failed to start download" }); done(); }
  }
});


// ─── Download file endpoint ───────────────────────────────────────────────────
app.get("/api/download-file", (req, res) => {
  const { key, ext, title } = req.query;
  if (!key || typeof key !== "string" || !ext || typeof ext !== "string") {
    return res.status(400).send("Missing download parameters");
  }

  const safeExt = ext.replace(/[^a-z0-9]/gi, '').toLowerCase();
  const safeKey = key.replace(/[^a-f0-9]/gi, '');

  // ─── FIX 1: Guard — refuse to serve non-media extensions ─────────────────
  if (!MEDIA_EXTS.has(safeExt)) {
    return res.status(400).send("Invalid file type requested.");
  }

  const filepath = path.join(downloadsDir, `${safeKey}.${safeExt}`);

  if (!fs.existsSync(filepath)) {
    return res.status(404).send("File not found or expired.");
  }

  const mimeType = MIME_MAP[safeExt] || "application/octet-stream";

  // Generate a safe download filename
  const cleanTitle = (typeof title === 'string' ? title : 'video')
    .replace(/[^a-zA-Z0-9\s\-_]/g, '')
    .trim() || 'video';
  const downloadName = `${cleanTitle}.${safeExt}`;

  const stat = fs.statSync(filepath);

  // ─── FIX 2: Set headers manually AND use pipe instead of res.download() ──
  // res.download() re-sets Content-Type and can overwrite our explicit MIME.
  // Using pipe gives us full control over every header.
  res.setHeader("Content-Type", mimeType);
  res.setHeader("Content-Length", stat.size);
  res.setHeader("Content-Disposition", `attachment; filename="${downloadName}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`);
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "no-cache");

  // Support byte-range requests (needed for Android video seek before download finishes)
  const rangeHeader = req.headers.range;
  if (rangeHeader) {
    const parts = rangeHeader.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    const chunkSize = (end - start) + 1;

    res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
    res.setHeader("Content-Length", chunkSize);
    res.status(206);

    const stream = fs.createReadStream(filepath, { start, end });
    stream.pipe(res);
    stream.on("error", (err) => {
      console.error("Range stream error:", err);
      if (!res.writableEnded) res.end();
    });
  } else {
    // Full file — stream with pipe for memory efficiency
    const stream = fs.createReadStream(filepath);
    stream.pipe(res);
    stream.on("error", (err) => {
      console.error("File stream error:", err);
      if (!res.writableEnded) res.end();
    });
  }
});

// ─── List downloads endpoint ──────────────────────────────────────────────────
app.get("/api/downloads", (req, res) => {
  try {
    const files = fs.readdirSync(downloadsDir);
    const jsonFiles = files.filter(f => f.endsWith('.json'));
    const list = [];

    for (const jsonFile of jsonFiles) {
      const key = path.basename(jsonFile, '.json');
      const jsonPath = path.join(downloadsDir, jsonFile);

      try {
        const metadata = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        const mediaFilepath = path.join(downloadsDir, `${key}.${metadata.ext}`);

        if (fs.existsSync(mediaFilepath)) {
          list.push({
            key,
            title: metadata.title,
            type: metadata.type,
            ext: metadata.ext,
            thumbnail: metadata.thumbnail || "",
            downloadedAt: metadata.downloadedAt
          });
        } else {
          fs.unlinkSync(jsonPath);
        }
      } catch {
        // Ignore corrupt JSON
      }
    }

    list.sort((a, b) => b.downloadedAt - a.downloadedAt);
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Delete download endpoint ─────────────────────────────────────────────────
app.post("/api/delete-download", (req, res) => {
  const { key, ext } = req.body;
  if (!key || !ext) return res.status(400).send("Missing parameters");

  const safeKey = key.replace(/[^a-f0-9]/gi, '');
  const safeExt = ext.replace(/[^a-z0-9]/gi, '');

  const jsonPath = path.join(downloadsDir, `${safeKey}.json`);
  const mediaPath = path.join(downloadsDir, `${safeKey}.${safeExt}`);

  try {
    if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);
    if (fs.existsSync(mediaPath)) fs.unlinkSync(mediaPath);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Version check endpoint ───────────────────────────────────────────────────

app.get("/api/version-check", (req, res) => {
  const { platform, version } = req.query;
  const plat = platform === "android" ? "android" : "web";

  if (plat !== "android") {
    return res.json({ updateRequired: false });
  }

  const clientVersion = parseInt(version as string) || 1;
  const config = APP_VERSION_CONFIG.android;
  const updateRequired = clientVersion < config.minVersion;

  res.json({
    updateRequired,
    latestVersion: config.latestVersion,
    updateUrl: config.updateUrl
  });
});

// ─── Server startup ───────────────────────────────────────────────────────────
async function startServer() {
  await downloadYtDlp();

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();

