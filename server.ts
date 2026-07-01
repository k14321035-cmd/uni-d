import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { spawn, spawnSync } from "child_process";
import os from "os";
import fs from "fs";
import net from "net";

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

app.use(express.json());

// ---------------------------------------------------------------------------
// yt-dlp resolver
// Priority: python -m yt_dlp  >  yt-dlp(.exe) on PATH  >  bundled binary
// ---------------------------------------------------------------------------
function findYtDlpCommand(): { cmd: string; baseArgs: string[] } {
  const pythons = ["python", "python3", "py"];
  for (const py of pythons) {
    const r = spawnSync(py, ["-m", "yt_dlp", "--version"], {
      timeout: 5000,
      encoding: "utf8",
    });
    if (r.status === 0) {
      console.log(`[yt-dlp] Using: ${py} -m yt_dlp (${r.stdout.trim()})`);
      return { cmd: py, baseArgs: ["-m", "yt_dlp"] };
    }
  }
  const bin = os.platform() === "win32" ? "yt-dlp.exe" : "yt-dlp";
  const r = spawnSync(bin, ["--version"], { timeout: 5000, encoding: "utf8" });
  if (r.status === 0) {
    console.log(`[yt-dlp] Using: ${bin} (${r.stdout.trim()})`);
    return { cmd: bin, baseArgs: [] };
  }
  const bundled = path.join(process.cwd(), "yt-dlp");
  if (os.platform() !== "win32" && fs.existsSync(bundled)) {
    return { cmd: bundled, baseArgs: [] };
  }
  throw new Error("yt-dlp not found. Run: pip install yt-dlp");
}

let YTDLP: { cmd: string; baseArgs: string[] };

function spawnYtDlp(args: string[]) {
  return spawn(YTDLP.cmd, [...YTDLP.baseArgs, ...args], { windowsHide: true });
}

function execYtDlp(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawnYtDlp(args);
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (err += d));
    proc.on("close", (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || out.trim()))
    );
    proc.on("error", reject);
  });
}

function safeName(s: string, ext: string): string {
  return s.replace(/[^\w\-. ]/g, "_").slice(0, 120).trim() + "." + ext;
}

function friendlyError(raw: string): string {
  const r = raw.toLowerCase();
  if (r.includes("sign in") || r.includes("bot")) return "YouTube bot-detection triggered. Try again shortly.";
  if (r.includes("video unavailable") || r.includes("private video")) return "This video is unavailable or private.";
  if (r.includes("unsupported url") || r.includes("not a valid url")) return "URL not supported. Paste a direct video link.";
  if (r.includes("unable to download") || r.includes("http error")) return "Could not reach this video. It may require login or be removed.";
  if (r.includes("no video formats")) return "No downloadable formats found for this URL.";
  return raw.split("\n")[0].slice(0, 200);
}

// ---------------------------------------------------------------------------
// Shared yt-dlp speed flags — applied to every call
// -N 4           → 4 concurrent fragment threads (huge for DASH/HLS)
// --buffer-size  → bigger read buffer
// --no-mtime     → skip setting file modification time (minor win)
// --retries 3    → fast retry on transient errors
// ---------------------------------------------------------------------------
const SPEED_FLAGS = [
  "-N", "4",
  "--buffer-size", "16K",
  "--no-mtime",
  "--retries", "3",
  "--fragment-retries", "3",
];

// ---------------------------------------------------------------------------
// POST /api/video-info
// Uses --print with JSON template — much faster than --dump-json
// ---------------------------------------------------------------------------
app.post("/api/video-info", async (req, res) => {
  const { url } = req.body as { url?: string };
  if (!url) return res.status(400).json({ error: "Missing URL" });

  try {
    // --print "%(key)j" outputs the raw JSON value for each field.
    // Much faster than --dump-json which serialises the entire info dict.
    const raw = await execYtDlp([
      "--no-playlist",
      "--skip-download",
      "--no-warnings",
      // Print a compact JSON object with only what we need
      "--print", `{"title":%(title)j,"thumbnail":%(thumbnail)j,"duration":%(duration)j,"channel":%(uploader,channel)j}`,
      url,
    ]);

    // yt-dlp may print multiple lines for playlists — take first
    const line = raw.split("\n").find((l) => l.trim().startsWith("{")) || raw;
    const info = JSON.parse(line);

    return res.json({
      title: info.title || "Unknown Title",
      thumbnail: info.thumbnail || "",
      duration: typeof info.duration === "number" ? info.duration : 0,
      channel: info.channel || "Unknown",
    });
  } catch (err: any) {
    // Fallback: full --dump-json if --print template fails (older yt-dlp)
    try {
      const raw2 = await execYtDlp([
        "--dump-json", "--no-playlist", "--skip-download", "--no-warnings", url,
      ]);
      const info = JSON.parse(raw2.split("\n").find((l) => l.startsWith("{")) || raw2);
      const thumbnail =
        info.thumbnail ||
        (Array.isArray(info.thumbnails) && info.thumbnails.length
          ? info.thumbnails[info.thumbnails.length - 1].url
          : "");
      return res.json({
        title: info.title || "Unknown Title",
        thumbnail,
        duration: info.duration || 0,
        channel: info.uploader || info.channel || info.extractor_key || "Unknown",
      });
    } catch (err2: any) {
      console.error("[video-info error]", err2.message);
      return res.status(500).json({ error: friendlyError(err2.message) });
    }
  }
});

// ---------------------------------------------------------------------------
// GET /api/prepare-stream  (SSE)
// Accepts optional ?title= so we skip a redundant yt-dlp info call
// ---------------------------------------------------------------------------
app.get("/api/prepare-stream", async (req, res) => {
  const { url, type, title: titleParam } = req.query as {
    url?: string; type?: string; title?: string;
  };
  if (!url) return res.status(400).send("Missing URL");

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  const ext = type === "audio" ? "m4a" : "mp4";

  // Use title from client if provided — avoids a whole extra yt-dlp spawn
  const title = titleParam?.trim() || `vidown_${Date.now()}`;
  const filename = safeName(title, ext);
  const tmpFile = path.join(os.tmpdir(), `vidown_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`);

  send({ progress: 2, text: "Starting download…" });

  // ---------------------------------------------------------------------------
  // Format selection — prefer native containers that skip ffmpeg re-encoding:
  //   video: mp4 video + m4a audio (no transcode) → else best ≤1080p
  //   audio: m4a or aac stream directly            → else best audio
  // ---------------------------------------------------------------------------
  const formatArgs =
    type === "audio"
      ? ["-f", "ba[ext=m4a]/ba[ext=aac]/ba", "--merge-output-format", "m4a"]
      : [
          "-f",
          "bv*[ext=mp4][height<=1080]+ba[ext=m4a]/bv*[height<=1080]+ba/best[height<=1080]/best",
          "--merge-output-format", "mp4",
        ];

  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawnYtDlp([
        ...formatArgs,
        ...SPEED_FLAGS,
        "--no-playlist",
        "--no-warnings",
        "--newline",
        "--progress",
        "--progress-template",
        "%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s",
        "-o", tmpFile,
        url,
      ]);

      let lastPct = 2;
      let stderrBuf = "";

      proc.stderr.on("data", (chunk: Buffer) => {
        const lines = chunk.toString().split(/\r?\n/);
        for (const line of lines) {
          const t = line.trim();
          if (!t) continue;
          stderrBuf += t + "\n";

          // "74.3%|3.21MiB/s|00:08"
          const m = t.match(/^([\d.]+)%\|(.*?)\|(.*)$/);
          if (m) {
            const pct = Math.min(95, Math.round(parseFloat(m[1])));
            if (pct > lastPct) {
              lastPct = pct;
              const speed = m[2].replace(/\s+/g, "");
              const eta = m[3].replace(/\s+/g, "");
              send({ progress: pct, text: `Downloading… ${speed}  ETA ${eta}` });
            }
          }
        }
      });

      proc.stdout.resume();
      proc.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(stderrBuf || `Exit ${code}`))
      );
      proc.on("error", reject);
      req.on("close", () => proc.kill("SIGKILL"));
    });

    send({ progress: 98, text: "Finalising…" });

    const token = Buffer.from(JSON.stringify({ tmpFile, filename })).toString("base64url");
    send({ progress: 100, downloadUrl: `/api/download-file?t=${token}` });
    res.end();
  } catch (err: any) {
    console.error("[prepare-stream error]", err.message);
    // Cleanup stale temp file if it exists
    fs.unlink(tmpFile, () => {});
    send({ error: friendlyError(err.message) });
    res.end();
  }
});

// ---------------------------------------------------------------------------
// GET /api/download-file?t=<token>  — serve the ready temp file
// ---------------------------------------------------------------------------
app.get("/api/download-file", (req, res) => {
  const { t } = req.query as { t?: string };
  if (!t) return res.status(400).send("Missing token");

  let tmpFile: string, filename: string;
  try {
    ({ tmpFile, filename } = JSON.parse(Buffer.from(t, "base64url").toString()));
  } catch {
    return res.status(400).send("Invalid token");
  }

  if (!fs.existsSync(tmpFile)) {
    return res.status(404).send("File expired or already downloaded");
  }

  const stat = fs.statSync(tmpFile);
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Length", stat.size);

  const stream = fs.createReadStream(tmpFile, { highWaterMark: 256 * 1024 });
  stream.pipe(res);

  const cleanup = () => fs.unlink(tmpFile, () => {});
  res.on("finish", cleanup);
  res.on("close", cleanup);
  stream.on("error", cleanup);
});

// ---------------------------------------------------------------------------
// Kill whatever is currently holding a port (Windows + Unix)
// ---------------------------------------------------------------------------
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port);
  });
}

async function freePort(port: number) {
  if (await isPortFree(port)) return;
  console.log(`[server] Port ${port} busy — killing occupying process…`);
  // Windows
  spawnSync("powershell", [
    "-Command",
    `Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }`,
  ]);
  // Unix fallback
  spawnSync("fuser", ["-k", `${port}/tcp`]);
  await new Promise((r) => setTimeout(r, 500));
}

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------
async function startServer() {
  try {
    YTDLP = findYtDlpCommand();
  } catch (err: any) {
    console.error("\n❌", err.message);
    process.exit(1);
  }

  await freePort(PORT);

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => res.sendFile(path.join(distPath, "index.html")));
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`\n🚀 ViDown running at http://localhost:${PORT}\n`);
  });
}

startServer();
