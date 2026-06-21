import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import fs from "fs";
import { spawn } from "child_process";
import crypto from "crypto";
import { Readable } from "stream";

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

app.use(express.json());

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

const isWin = process.platform === "win32";
const YTDLP_FILENAME = isWin ? "yt-dlp.exe" : "yt-dlp";
const YTDLP_PATH = path.join(process.cwd(), YTDLP_FILENAME);

const downloadsDir = path.join(process.cwd(), "downloads");
if (!fs.existsSync(downloadsDir)) {
  fs.mkdirSync(downloadsDir, { recursive: true });
}

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
  // Flush headers immediately so client knows connection is alive
  res.flushHeaders();

  const cacheKey = crypto.createHash("md5").update(`${url}_${type}`).digest("hex");

  // Serve from cache if available
  const cachedFile = checkCachedFile(cacheKey);
  if (cachedFile) {
    const ext = path.extname(cachedFile).substring(1).toLowerCase();
    // Ensure JSON metadata exists
    const jsonPath = path.join(downloadsDir, `${cacheKey}.json`);
    if (!fs.existsSync(jsonPath)) {
      const metadata = { title: title || "Unknown Video", type, ext, thumbnail: thumbnail || "", downloadedAt: Date.now() };
      fs.writeFileSync(jsonPath, JSON.stringify(metadata, null, 2));
    }
    res.write(`data: ${JSON.stringify({
      progress: 100,
      text: "Serving from cache",
      downloadUrl: `/api/download-file?key=${cacheKey}&ext=${ext}&title=${encodeURIComponent(title as string || "video")}`
    })}\n\n`);
    res.end();
    return;
  }

  // ─── Loader.to fallback (server-side fetch, no redirect to client) ──────────
  const runLoaderToFallback = async () => {
    try {
      res.write(`data: ${JSON.stringify({ progress: 10, text: "Using proxy downloader..." })}\n\n`);
      const formatSelection = type === 'audio' ? "mp3" : "1080";
      const startRes = await fetch(`https://loader.to/ajax/download.php?format=${formatSelection}&url=${encodeURIComponent(url)}`);
      const startData = await startRes.json();

      const progUrl = startData.progress_url || ('https://lto2.affadaffa.com/api/progress?id=' + startData.id);
      let proxyDownloadUrl: string | null = null;

      for (let i = 0; i < 60; i++) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const progRes = await fetch(progUrl);
        const progData = await progRes.json();

        let pct = progData.progress || 0;
        if (pct > 100 && pct <= 1000) pct = Math.floor(pct / 10);
        res.write(`data: ${JSON.stringify({ progress: Math.min(85, Math.max(10, pct)), text: progData.text || "Downloading via proxy..." })}\n\n`);

        if (progData.success === 1 && progData.download_url) {
          proxyDownloadUrl = progData.download_url;
          break;
        }
      }

      if (!proxyDownloadUrl) {
        res.write(`data: ${JSON.stringify({ error: "Timeout generating download link." })}\n\n`);
        res.end();
        return;
      }

      res.write(`data: ${JSON.stringify({ progress: 90, text: "Saving file to server..." })}\n\n`);

      const ext = type === 'audio' ? 'mp3' : 'mp4';
      const destPath = path.join(downloadsDir, `${cacheKey}.${ext}`);
      const tmpPath = `${destPath}.tmp`;

      // ─── FIX 3: Write to .tmp first, rename on success ───────────────────
      const fileRes = await fetch(proxyDownloadUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      if (!fileRes.ok || !fileRes.body) {
        throw new Error(`Proxy file fetch failed: HTTP ${fileRes.status}`);
      }

      const fileStream = fs.createWriteStream(tmpPath);
      await new Promise<void>((resolve, reject) => {
        Readable.fromWeb(fileRes.body as any).pipe(fileStream);
        fileStream.on("finish", () => { fileStream.close(); resolve(); });
        fileStream.on("error", (err) => { fs.unlink(tmpPath, () => {}); reject(err); });
      });

      // Atomic rename: only expose file when it's 100% written
      fs.renameSync(tmpPath, destPath);

      const metadata = { title: title || "Unknown Video", type, ext, thumbnail: thumbnail || "", downloadedAt: Date.now() };
      fs.writeFileSync(path.join(downloadsDir, `${cacheKey}.json`), JSON.stringify(metadata, null, 2));

      res.write(`data: ${JSON.stringify({
        progress: 100,
        text: "Finished!",
        downloadUrl: `/api/download-file?key=${cacheKey}&ext=${ext}&title=${encodeURIComponent(title as string || "video")}`
      })}\n\n`);
      res.end();

    } catch (err: any) {
      res.write(`data: ${JSON.stringify({ error: "Download failed: " + err.message })}\n\n`);
      res.end();
    }
  };

  // ─── Primary: yt-dlp download ─────────────────────────────────────────────
  try {
    await downloadYtDlp();

    let args: string[] = [];
    if (type === 'audio') {
      // ─── FIX 3: Use explicit output name so no intermediate extension confusion
      args = [
        '-f', 'ba[ext=m4a]/ba/bestaudio',
        '-x', '--audio-format', 'mp3',
        '--audio-quality', '0',
        '--newline',
        '--progress-template', '%(progress)j',
        '--no-warnings',
        url,
        // Use explicit .mp3 output — no %(ext)s ambiguity
        '-o', path.join(downloadsDir, `${cacheKey}.mp3`)
      ];
    } else {
      // H.264 + AAC = universally playable on Android/iOS native players
      // Format priority:
      //   1. Best H.264 video + M4A audio (ideal: hardware decoded on all phones)
      //   2. Any MP4 video + M4A audio (fallback)
      //   3. Best H.264 video alone (no separate audio)
      //   4. Best MP4 container
      //   5. Absolute best available
      args = [
        '-f', 'bv[vcodec^=avc1][ext=mp4]+ba[ext=m4a]/bv[ext=mp4]+ba[ext=m4a]/bv[vcodec^=avc1]+ba/b[ext=mp4]/best[ext=mp4]/best',
        '--merge-output-format', 'mp4',
        '--newline',
        '--progress-template', '%(progress)j',
        '--no-warnings',
        // Add ffmpeg post-processing to remux into a clean, seekable MP4
        // (moov atom at start = fast mobile seeking, no 0:00 duration bug)
        '--postprocessor-args', 'ffmpeg:-movflags +faststart',
        url,
        '-o', path.join(downloadsDir, `${cacheKey}.%(ext)s`)
      ];
    }

    // ─── FIX 4: Track yt-dlp process independently from request lifecycle ────
    // Do NOT kill yt-dlp just because the SSE connection briefly drops.
    // Only kill on explicit user cancel (detected by checking if res is still writable).
    const ytdlp = spawn(YTDLP_PATH, args);
    let buffer = "";
    let processFinished = false;

    res.write(`data: ${JSON.stringify({ progress: 1, text: "Starting download..." })}\n\n`);

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
            const text = `Downloading ${pct}%${speed ? ` at ${speed}` : ''}${eta ? `, ETA ${eta}` : ''}`;
            // Only write if response is still open
            if (!res.writableEnded) {
              res.write(`data: ${JSON.stringify({ progress: pct, text })}\n\n`);
            }
          }
        } catch (e) {
          // Ignore JSON parse errors from partial lines
        }
      }
    });

    // Log stderr for debugging but don't treat as failure (yt-dlp writes progress there too)
    ytdlp.stderr.on("data", (data) => {
      console.error("[yt-dlp stderr]", data.toString().trim());
    });

    let hasFailed = false;
    ytdlp.on("error", (err) => {
      hasFailed = true;
      processFinished = true;
      console.error("yt-dlp execution error:", err);
      const isYoutube = url.includes("youtube.com") || url.includes("youtu.be");
      if (isYoutube && !res.writableEnded) {
        runLoaderToFallback();
      } else if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: `yt-dlp failed: ${err.message}` })}\n\n`);
        res.end();
      }
    });

    ytdlp.on("close", (code) => {
      if (hasFailed) return;
      processFinished = true;

      if (code === 0) {
        // ─── FIX 1 applied here: checkCachedFile only returns real media files
        const finalFile = checkCachedFile(cacheKey);
        if (finalFile) {
          const ext = path.extname(finalFile).substring(1).toLowerCase();

          // ─── Extra safety: verify the file is non-zero bytes ────────────
          try {
            const stat = fs.statSync(path.join(downloadsDir, finalFile));
            if (stat.size < 1024) {
              // File is suspiciously tiny — delete and report error
              fs.unlinkSync(path.join(downloadsDir, finalFile));
              throw new Error("Downloaded file is too small — likely corrupt.");
            }
          } catch (statErr: any) {
            if (!res.writableEnded) {
              const isYoutube = url.includes("youtube.com") || url.includes("youtu.be");
              if (isYoutube) {
                runLoaderToFallback();
              } else {
                res.write(`data: ${JSON.stringify({ error: statErr.message })}\n\n`);
                res.end();
              }
            }
            return;
          }

          const metadata = {
            title: title || "Unknown Video",
            type,
            ext,
            thumbnail: thumbnail || "",
            downloadedAt: Date.now()
          };
          fs.writeFileSync(path.join(downloadsDir, `${cacheKey}.json`), JSON.stringify(metadata, null, 2));

          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({
              progress: 100,
              text: "Finished preparing!",
              downloadUrl: `/api/download-file?key=${cacheKey}&ext=${ext}&title=${encodeURIComponent(title as string || "video")}`
            })}\n\n`);
            res.end();
          }
        } else {
          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ error: "Download succeeded but file was not found on server." })}\n\n`);
            res.end();
          }
        }
      } else {
        console.warn(`yt-dlp exited with non-zero code: ${code}`);
        const isYoutube = url.includes("youtube.com") || url.includes("youtu.be");
        if (isYoutube && !res.writableEnded) {
          runLoaderToFallback();
        } else if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ error: `Download failed with exit code ${code}` })}\n\n`);
          res.end();
        }
      }
    });

    // ─── FIX 4: Only kill yt-dlp if it HASN'T finished yet ─────────────────
    req.on("close", () => {
      if (!processFinished && ytdlp) {
        console.log("Client disconnected mid-download — killing yt-dlp");
        ytdlp.kill("SIGKILL");
      }
    });

  } catch (err: any) {
    console.error("Prepare stream general error:", err);
    const isYoutube = url.includes("youtube.com") || url.includes("youtu.be");
    if (isYoutube && !res.writableEnded) {
      await runLoaderToFallback();
    } else if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: err.message || "Failed to initiate download process" })}\n\n`);
      res.end();
    }
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
const APP_VERSION_CONFIG = {
  android: {
    minVersion: 2,
    latestVersion: 2,
    updateUrl: "https://codetutorium.com/downloads/all-video-downloader.apk"
  }
};

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
