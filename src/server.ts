import express from "express";
import {readFile, writeFile, rm, mkdir} from "node:fs/promises";
import {existsSync} from "node:fs";
import path from "node:path";
import {RegistrationRunner, type RunnerConfig} from "./registration-runner.js";
import {getAliasSuffix, setAliasSuffix, getRandomAliasEnabled, setRandomAliasEnabled, getMailApiMode, setMailApiMode, clearAccountCache} from "./mailbox.js";

const app = express();
app.use(express.json({limit: "1mb"}));

const TOKENS_FILE = path.resolve(process.cwd(), "hotmail", "tokens.txt");
const ACCESS_TOKENS_FILE = path.resolve(process.cwd(), "auth", "access_tokens.txt");
const CONFIG_FILE = path.resolve(process.cwd(), "config.json");

// ── serve static UI ──
const PUBLIC_DIR = path.resolve(process.cwd(), "public");
app.use(express.static(PUBLIC_DIR));

// ── SSE clients ──
const sseClients = new Set<express.Response>();

function broadcast(event: string, data: unknown) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
        try { client.write(payload); } catch {}
    }
}

app.get("/api/events", (_req, res) => {
    res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
    });
    res.write(":connected\n\n");
    sseClients.add(res);
    res.on("close", () => sseClients.delete(res));
});

// ── runner ──
const runner = new RegistrationRunner();
runner.setCallback((event) => {
    broadcast("progress", event);
});

// ── API routes ──

// GET /api/config — load config
app.get("/api/config", async (_req, res) => {
    try {
        const raw = await readFile(CONFIG_FILE, "utf8");
        const config = JSON.parse(raw);
        let emailPool = "";
        try { emailPool = await readFile(TOKENS_FILE, "utf8"); } catch {}
        let aliasSuffix = "";
        try { aliasSuffix = getAliasSuffix(); } catch {}
        let randomAliasEnabled = false;
        try { randomAliasEnabled = getRandomAliasEnabled(); } catch {}
        let mailApiMode = "auto";
        try { mailApiMode = getMailApiMode(); } catch {}
        res.json({ok: true, config, emailPool, aliasSuffix, randomAliasEnabled, mailApiMode});
    } catch (err) {
        res.json({ok: false, error: String(err)});
    }
});

// POST /api/config — save config
app.post("/api/config", async (req, res) => {
    try {
        const {proxyUrl, loopDelayMs, password} = req.body;
        let current: any = {};
        try { current = JSON.parse(await readFile(CONFIG_FILE, "utf8")); } catch {}
        if (proxyUrl !== undefined) current.defaultProxyUrl = String(proxyUrl).trim();
        if (loopDelayMs !== undefined) current.loopDelayMs = Math.max(0, Number(loopDelayMs) || 0);
        if (password !== undefined) current.defaultPassword = String(password).trim() || "kuaileshifu88";
        await writeFile(CONFIG_FILE, JSON.stringify(current, null, 2) + "\n", "utf8");
        res.json({ok: true});
    } catch (err) {
        res.json({ok: false, error: String(err)});
    }
});

// POST /api/email-pool — update email pool
app.post("/api/email-pool", async (req, res) => {
    try {
        const {emails} = req.body;
        if (typeof emails !== "string" || !emails.trim()) {
            return res.json({ok: false, error: "邮箱池不能为空"});
        }
        const dir = path.dirname(TOKENS_FILE);
        await mkdir(dir, {recursive: true});
        await writeFile(TOKENS_FILE, emails.trim().replace(/\r\n/g, "\n") + "\n", "utf8");
        clearAccountCache();
        res.json({ok: true, count: emails.trim().split(/\n/).filter(Boolean).length});
    } catch (err) {
        res.json({ok: false, error: String(err)});
    }
});

// GET /api/alias-suffix — get alias suffix
app.get("/api/alias-suffix", (_req, res) => {
    try {
        const suffix = getAliasSuffix();
        res.json({ok: true, suffix});
    } catch (err) {
        res.json({ok: false, error: String(err)});
    }
});

// POST /api/alias-suffix — set alias suffix
app.post("/api/alias-suffix", async (req, res) => {
    try {
        const {suffix} = req.body;
        await setAliasSuffix(String(suffix ?? "").trim());
        res.json({ok: true, suffix: getAliasSuffix()});
    } catch (err) {
        res.json({ok: false, error: String(err)});
    }
});

// POST /api/random-alias — toggle random alias
app.post("/api/random-alias", (req, res) => {
    try {
        const {enabled} = req.body;
        setRandomAliasEnabled(!!enabled);
        res.json({ok: true, randomAliasEnabled: getRandomAliasEnabled()});
    } catch (err) {
        res.json({ok: false, error: String(err)});
    }
});

// POST /api/mail-api-mode — set mail API mode
app.post("/api/mail-api-mode", (req, res) => {
    try {
        const {mode} = req.body;
        setMailApiMode(String(mode || "auto"));
        res.json({ok: true, mailApiMode: getMailApiMode()});
    } catch (err) {
        res.json({ok: false, error: String(err)});
    }
});

// POST /api/start — start registration
app.post("/api/start", async (req, res) => {
    if (runner.isRunning) {
        return res.json({ok: false, error: "注册已在运行中"});
    }
    try {
        const {proxyUrl, threads, totalRounds, password, loopDelayMs} = req.body;
        const config: RunnerConfig = {
            proxyUrl: String(proxyUrl || "").trim(),
            threads: Math.max(1, Number(threads) || 1),
            totalRounds: Math.max(1, Number(totalRounds) || 1),
            password: String(password || "kuaileshifu88").trim(),
            loopDelayMs: Math.max(0, Number(loopDelayMs) || 0),
        };
        if (!config.proxyUrl) {
            return res.json({ok: false, error: "代理地址不能为空"});
        }
        runner.start(config);
        res.json({ok: true});
    } catch (err) {
        res.json({ok: false, error: String(err)});
    }
});

// POST /api/stop — stop registration
app.post("/api/stop", (_req, res) => { runner.stop(); res.json({ok: true}); });
app.get("/api/stop", (_req, res) => {
    runner.stop();
    res.json({ok: true});
});

// GET /api/status — check if running
app.get("/api/status", (_req, res) => {
    res.json({running: runner.isRunning});
});

// GET /api/download — download access_tokens.txt and delete it
app.get("/api/download", async (_req, res) => {
    try {
        if (!existsSync(ACCESS_TOKENS_FILE)) {
            return res.status(404).json({ok: false, error: "暂无 access_tokens.txt"});
        }
        const content = await readFile(ACCESS_TOKENS_FILE, "utf8");
        // Delete after sending
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.setHeader("content-disposition", `attachment; filename="access_tokens_${Date.now()}.txt"`);
        res.send(content);
        // Delete after response is sent
        await rm(ACCESS_TOKENS_FILE).catch(() => {});
    } catch (err) {
        res.status(500).json({ok: false, error: String(err)});
    }
});

// ── start ──
const PORT = Number(process.env.PORT) || 8318;
app.listen(PORT, () => {
    console.log(`[WebUI] http://localhost:${PORT}`);
});
