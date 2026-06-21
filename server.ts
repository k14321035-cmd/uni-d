import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import fs from "fs";
import { spawn } from "child_process";
import https from "https";
import crypto from "crypto";
import { Readable } from "stream";

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

app.use(express.json());

const isWin = process.platform === "win32";
const YTDLP_FILENAME = isWin ? "yt-dlp.exe" : "yt-dlp";
const YTDLP_PATH = path.join(process.cwd(), YTDLP_FILENAME);

const downloadsDir = path.join(process.cwd(), "downloads");
if (!fs.existsSync(downloadsDir)) {
  fs.mkdirSync(downloadsDir, { recursive: true });
}

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
      const output = await execYtDlp(["-j", "--js-runtimes", "node", "--no-warnings", url]);
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
      formats: [
        { format_id: "best_video", ext: "mp4", resolution: "1080p", format_note: "Best Video" }
      ]
    });
  } catch (error: any) {
    let errMsg = error.message || "Failed to fetch video information";
    if (errMsg.includes("Sign in to confirm you’re not a bot")) {
      errMsg = "This video is protected by bot-detection. Please try a different URL or platform.";
    } else if (errMsg.includes("Video unavailable")) {
      errMsg = "This video is unavailable or private.";
    }
    res.status(500).json({ error: errMsg });
  }
});

app.get("/api/prepare-stream", async (req, res) => {
  const { url, type, title, thumbnail } = req.query;
  if (!url || typeof url !== "string" || !type || typeof type !== "string") {
    return res.status(400).send("Missing parameters");
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const cacheKey = crypto.createHash("md5").update(`${url}_${type}`).digest("hex");

  // Helper to check if file already exists in downloads directory
  const checkCachedFile = (): string | null => {
    try {
      const files = fs.readdirSync(downloadsDir);
      const match = files.find(f => f.startsWith(cacheKey) && !f.endsWith('.part') && !f.endsWith('.ytdl'));
      return match ? match : null;
    } catch {
      return null;
    }
  };

  const cachedFile = checkCachedFile();
  if (cachedFile) {
    const ext = path.extname(cachedFile).substring(1);
    // Write/update metadata JSON file if it doesn't exist
    const jsonPath = path.join(downloadsDir, `${cacheKey}.json`);
    if (!fs.existsSync(jsonPath)) {
      const metadata = {
        title: title || "Unknown Video",
        type,
        ext,
        thumbnail: thumbnail || "",
        downloadedAt: Date.now()
      };
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

  // Define fallback to loader.to
  const runLoaderToFallback = async () => {
    try {
      res.write(`data: ${JSON.stringify({ progress: 10, text: "Yt-dlp failed, falling back to proxy downloader..." })}\n\n`);
      const formatSelection = type === 'audio' ? "mp3" : "1080";
      const startRes = await fetch(`https://loader.to/ajax/download.php?format=${formatSelection}&url=${encodeURIComponent(url)}`);
      const startData = await startRes.json();
      
      const progUrl = startData.progress_url || ('https://lto2.affadaffa.com/api/progress?id=' + startData.id);
      
      for (let i = 0; i < 60; i++) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const progRes = await fetch(progUrl);
        const progData = await progRes.json();
        
        let pct = progData.progress || 0;
        if (pct > 100 && pct <= 1000) pct = Math.floor(pct / 10);
        
        res.write(`data: ${JSON.stringify({ progress: Math.min(99, Math.max(10, pct)), text: progData.text || "Downloading via proxy" })}\n\n`);

        if (progData.success === 1 && progData.download_url) {
           res.write(`data: ${JSON.stringify({ downloadUrl: progData.download_url, progress: 100 })}\n\n`);
           res.end();
           return;
        }
      }
      res.write(`data: ${JSON.stringify({ error: "Timeout generating download link." })}\n\n`);
      res.end();
    } catch (err: any) {
      res.write(`data: ${JSON.stringify({ error: "Download failed: " + err.message })}\n\n`);
      res.end();
    }
  };

  // Run download using local yt-dlp
  try {
    await downloadYtDlp();
    
    // Choose arguments based on type
    let args: string[] = [];
    if (type === 'audio') {
      args = [
        '-f', 'ba*[ext=m4a]/ba/best', 
        '-x', '--audio-format', 'mp3', 
        '--newline', 
        '--progress-template', '%(progress)j', 
        '--js-runtimes', 'node', 
        '--no-warnings', 
        url, 
        '-o', path.join(downloadsDir, `${cacheKey}.%(ext)s`)
      ];
    } else {
      args = [
        '-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best', 
        '--merge-output-format', 'mp4', 
        '--newline', 
        '--progress-template', '%(progress)j', 
        '--js-runtimes', 'node', 
        '--no-warnings', 
        url, 
        '-o', path.join(downloadsDir, `${cacheKey}.%(ext)s`)
      ];
    }

    const ytdlp = spawn(YTDLP_PATH, args);
    let buffer = "";

    res.write(`data: ${JSON.stringify({ progress: 1, text: "Starting download..." })}\n\n`);

    ytdlp.stdout.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // Keep the last incomplete line

      for (const line of lines) {
        if (!line.trim().startsWith("{")) continue;
        try {
          const progress = JSON.parse(line.trim());
          if (progress.status === "downloading") {
            const pct = Math.floor(progress._percent || 0);
            const speed = progress._speed_str ? progress._speed_str.trim() : "";
            const eta = progress._eta_str ? progress._eta_str.trim() : "";
            const text = `Downloading (${pct}% at ${speed}, ETA ${eta})`;
            res.write(`data: ${JSON.stringify({ progress: pct, text })}\n\n`);
          }
        } catch (e) {
          // Ignore parsing errors of incomplete or invalid JSON
        }
      }
    });

    let hasFailed = false;
    ytdlp.on("error", (err) => {
      hasFailed = true;
      console.error("yt-dlp execution error:", err);
      const isYoutube = url.includes("youtube.com") || url.includes("youtu.be");
      if (isYoutube) {
        runLoaderToFallback();
      } else {
        res.write(`data: ${JSON.stringify({ error: `yt-dlp failed: ${err.message}` })}\n\n`);
        res.end();
      }
    });

    ytdlp.on("close", (code) => {
      if (hasFailed) return;
      
      if (code === 0) {
        // Find the actual file extension
        const finalFile = checkCachedFile();
        if (finalFile) {
          const ext = path.extname(finalFile).substring(1);
          // Write metadata JSON file
          const metadata = {
            title: title || "Unknown Video",
            type,
            ext,
            thumbnail: thumbnail || "",
            downloadedAt: Date.now()
          };
          fs.writeFileSync(path.join(downloadsDir, `${cacheKey}.json`), JSON.stringify(metadata, null, 2));

          res.write(`data: ${JSON.stringify({ 
            progress: 100, 
            text: "Finished preparing!", 
            downloadUrl: `/api/download-file?key=${cacheKey}&ext=${ext}&title=${encodeURIComponent(title as string || "video")}` 
          })}\n\n`);
          res.end();
        } else {
          res.write(`data: ${JSON.stringify({ error: "Download succeeded but file was not found on server." })}\n\n`);
          res.end();
        }
      } else {
        console.warn(`yt-dlp exited with non-zero code: ${code}`);
        const isYoutube = url.includes("youtube.com") || url.includes("youtu.be");
        if (isYoutube) {
          runLoaderToFallback();
        } else {
          res.write(`data: ${JSON.stringify({ error: `Download failed with exit code ${code}` })}\n\n`);
          res.end();
        }
      }
    });

    req.on("close", () => {
      if (ytdlp) ytdlp.kill("SIGKILL");
    });

  } catch (err: any) {
    console.error("Prepare stream general error:", err);
    const isYoutube = url.includes("youtube.com") || url.includes("youtu.be");
    if (isYoutube) {
      await runLoaderToFallback();
    } else {
      res.write(`data: ${JSON.stringify({ error: err.message || "Failed to initiate download process" })}\n\n`);
      res.end();
    }
  }
});

app.get("/api/download-file", (req, res) => {
  const { key, ext, title } = req.query;
  if (!key || typeof key !== "string" || !ext || typeof ext !== "string") {
    return res.status(400).send("Missing download parameters");
  }
  
  // Ensure parameters are safe
  const safeExt = ext.replace(/[^a-z0-9]/gi, '');
  const safeKey = key.replace(/[^a-f0-9]/gi, '');
  const filepath = path.join(downloadsDir, `${safeKey}.${safeExt}`);
  
  if (!fs.existsSync(filepath)) {
    return res.status(404).send("File not found or expired.");
  }
  
  // Generate download filename from title
  const cleanTitle = (typeof title === 'string' ? title : 'video')
    .replace(/[^a-zA-Z0-9\s-_]/g, '') // remove special characters
    .trim() || 'video';
    
  const downloadName = `${cleanTitle}.${safeExt}`;
  
  res.download(filepath, downloadName, (err) => {
    if (err) {
      console.error("Error sending file:", err);
    }
  });
});

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
          // Delete dangling metadata file
          fs.unlinkSync(jsonPath);
        }
      } catch {
        // Ignore corrupt JSON
      }
    }
    
    // Sort by downloadedAt descending
    list.sort((a, b) => b.downloadedAt - a.downloadedAt);
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

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

const APP_VERSION_CONFIG = {
  android: {
    minVersion: 2, // Minimum version code required to run without forcing update
    latestVersion: 2,
    updateUrl: "https://codetutorium.com/downloads/all-video-downloader.apk" // APK download link
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
