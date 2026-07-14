import express from "express";
import {readFile, writeFile, rm, mkdir, readdir} from "node:fs/promises";
import {existsSync} from "node:fs";
import path from "node:path";
import {RegistrationRunner, type RunnerConfig} from "./registration-runner.js";
import {
    getAliasSuffix,
    setAliasSuffix,
    getRandomAliasEnabled,
    setRandomAliasEnabled,
    getMailApiMode,
    setMailApiMode,
    clearAccountCache,
    getEmailProviderId,
    setEmailProviderId,
    configureTempMail,
    configureYyds,
    getProviderSecrets,
    type MailProviderId,
} from "./mailbox.js";
import {
    chatgpt2ApiIsConfigured,
    testChatgpt2ApiConnection,
    type Chatgpt2ApiEndpoint,
} from "./chatgpt2api.js";
import {testProxyConnection} from "./proxy-test.js";

const app = express();
app.use(express.json({limit: "1mb"}));

const TOKENS_FILE = path.resolve(process.cwd(), "hotmail", "tokens.txt");
const ACCESS_TOKENS_FILE = path.resolve(process.cwd(), "auth", "access_tokens.txt");
/** oumiFree-compatible per-account JSON dir: {email}.json */
const CODEX_DIR = path.resolve(process.cwd(), "auth", "codex");
const CONFIG_FILE = path.resolve(process.cwd(), "config.json");

/** Last successful probe from UI test button (not durable; rechecked on start). */
let chatgpt2apiLastOk = false;

function readChatgpt2ApiFromConfig(cfg: Record<string, unknown>): Chatgpt2ApiEndpoint {
    return {
        baseUrl: String(cfg.chatgpt2apiBaseUrl ?? cfg.chatgpt2api_url ?? "").trim(),
        authKey: String(cfg.chatgpt2apiAuthKey ?? cfg.chatgpt2api_key ?? "").trim(),
    };
}

function applyMailProviderFromConfig(cfg: Record<string, unknown>): MailProviderId {
    const id = setEmailProviderId(
        String(cfg.emailProvider ?? cfg.mailProvider ?? "hotmail"),
    );
    configureTempMail(String(cfg.tempmailApiKey ?? cfg.tempMailApiKey ?? "").trim());
    configureYyds({
        apiKey: String(cfg.yydsApiKey ?? "").trim(),
        baseUrl: String(cfg.yydsBaseUrl ?? "").trim() || undefined,
        domain: String(cfg.yydsDomain ?? "").trim() || undefined,
    });
    return id;
}

async function loadConfigObject(): Promise<Record<string, unknown>> {
    try {
        return JSON.parse(await readFile(CONFIG_FILE, "utf8")) as Record<string, unknown>;
    } catch {
        return {};
    }
}

// Apply mailbox provider secrets at process boot
void loadConfigObject().then((cfg) => {
    try {
        applyMailProviderFromConfig(cfg);
        console.log(`[mailbox] boot provider=${getEmailProviderId()}`);
    } catch (err) {
        console.log(`[mailbox] boot apply failed: ${String(err)}`);
    }
});

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
        const config = await loadConfigObject();
        // Keep in-memory provider in sync with durable config
        applyMailProviderFromConfig(config);
        let emailPool = "";
        try { emailPool = await readFile(TOKENS_FILE, "utf8"); } catch {}
        let aliasSuffix = "";
        try { aliasSuffix = getAliasSuffix(); } catch {}
        let randomAliasEnabled = false;
        try { randomAliasEnabled = getRandomAliasEnabled(); } catch {}
        let mailApiMode = "auto";
        try { mailApiMode = getMailApiMode(); } catch {}
        const c2a = readChatgpt2ApiFromConfig(config);
        const secrets = getProviderSecrets();
        res.json({
            ok: true,
            config,
            emailPool,
            aliasSuffix,
            randomAliasEnabled,
            mailApiMode,
            emailProvider: getEmailProviderId(),
            tempmailApiKey: secrets.tempmailApiKey,
            yydsApiKey: secrets.yydsApiKey,
            yydsBaseUrl: secrets.yydsBaseUrl,
            yydsDomain: secrets.yydsDomain,
            chatgpt2apiConnected: chatgpt2apiLastOk && chatgpt2ApiIsConfigured(c2a),
        });
    } catch (err) {
        res.json({ok: false, error: String(err)});
    }
});

// POST /api/config — save config
app.post("/api/config", async (req, res) => {
    try {
        const {
            proxyUrl,
            loopDelayMs,
            password,
            chatgpt2apiBaseUrl,
            chatgpt2apiAuthKey,
            emailProvider,
            tempmailApiKey,
            yydsApiKey,
            yydsBaseUrl,
            yydsDomain,
        } = req.body;
        const current: any = await loadConfigObject();
        if (proxyUrl !== undefined) current.defaultProxyUrl = String(proxyUrl).trim();
        if (loopDelayMs !== undefined) current.loopDelayMs = Math.max(0, Number(loopDelayMs) || 0);
        if (password !== undefined) current.defaultPassword = String(password).trim() || "kuaileshifu88";
        if (chatgpt2apiBaseUrl !== undefined) {
            current.chatgpt2apiBaseUrl = String(chatgpt2apiBaseUrl).trim().replace(/\/+$/, "");
        }
        if (chatgpt2apiAuthKey !== undefined) {
            current.chatgpt2apiAuthKey = String(chatgpt2apiAuthKey);
            // key changed → force re-test
            chatgpt2apiLastOk = false;
        }
        if (emailProvider !== undefined) {
            current.emailProvider = setEmailProviderId(String(emailProvider));
        }
        if (tempmailApiKey !== undefined) {
            current.tempmailApiKey = String(tempmailApiKey).trim();
            configureTempMail(current.tempmailApiKey);
        }
        if (yydsApiKey !== undefined) {
            current.yydsApiKey = String(yydsApiKey).trim();
        }
        if (yydsBaseUrl !== undefined) {
            current.yydsBaseUrl = String(yydsBaseUrl).trim().replace(/\/+$/, "");
        }
        if (yydsDomain !== undefined) {
            current.yydsDomain = String(yydsDomain).trim();
        }
        if (
            yydsApiKey !== undefined ||
            yydsBaseUrl !== undefined ||
            yydsDomain !== undefined
        ) {
            configureYyds({
                apiKey: String(current.yydsApiKey || ""),
                baseUrl: String(current.yydsBaseUrl || "") || undefined,
                domain: String(current.yydsDomain || "") || undefined,
            });
        }
        await writeFile(CONFIG_FILE, JSON.stringify(current, null, 2) + "\n", "utf8");
        res.json({
            ok: true,
            chatgpt2apiConnected: chatgpt2apiLastOk,
            emailProvider: getEmailProviderId(),
        });
    } catch (err) {
        res.json({ok: false, error: String(err)});
    }
});

// POST /api/proxy/test — probe registration proxy (TCP tunnel + chatgpt.com)
app.post("/api/proxy/test", async (req, res) => {
    try {
        let proxyUrl = String(req.body?.proxyUrl ?? "").trim();
        if (!proxyUrl) {
            try {
                const current = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
                proxyUrl = String(current.defaultProxyUrl || "").trim();
            } catch {}
        }
        if (!proxyUrl) {
            return res.json({ok: false, error: "请填写代理地址"});
        }
        const result = await testProxyConnection(proxyUrl);
        res.json(result);
    } catch (err) {
        res.json({ok: false, error: String(err)});
    }
});

// POST /api/chatgpt2api/test — probe baseUrl + auth key
app.post("/api/chatgpt2api/test", async (req, res) => {
    try {
        let baseUrl = String(req.body?.baseUrl ?? "").trim();
        let authKey = String(req.body?.authKey ?? "");
        // Fall back to saved config when body omits fields
        if (!baseUrl || !authKey) {
            let current: Record<string, unknown> = {};
            try {
                current = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
            } catch {}
            const saved = readChatgpt2ApiFromConfig(current);
            if (!baseUrl) baseUrl = saved.baseUrl;
            if (!authKey) authKey = saved.authKey;
        }
        baseUrl = baseUrl.replace(/\/+$/, "");
        const endpoint = {baseUrl, authKey};
        if (!chatgpt2ApiIsConfigured(endpoint)) {
            chatgpt2apiLastOk = false;
            return res.json({ok: false, error: "请填写 chatgpt2api 地址和鉴权 key"});
        }
        const result = await testChatgpt2ApiConnection(endpoint);
        chatgpt2apiLastOk = result.ok;
        // Persist last-tested credentials so start can reuse them
        if (result.ok) {
            let current: any = {};
            try {
                current = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
            } catch {}
            current.chatgpt2apiBaseUrl = baseUrl;
            current.chatgpt2apiAuthKey = authKey;
            await writeFile(CONFIG_FILE, JSON.stringify(current, null, 2) + "\n", "utf8");
        }
        res.json({
            ok: result.ok,
            error: result.error,
            accountCount: result.accountCount,
            status: result.status,
            chatgpt2apiConnected: chatgpt2apiLastOk,
        });
    } catch (err) {
        chatgpt2apiLastOk = false;
        res.json({ok: false, error: String(err), chatgpt2apiConnected: false});
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
        const saved = await loadConfigObject();
        // Re-apply provider from durable config before each run
        const providerId = applyMailProviderFromConfig(saved);
        if (providerId === "yyds" && !String(saved.yydsApiKey || "").trim()) {
            return res.json({ok: false, error: "YYDS 需要填写 API Key（X-API-Key，AC- 开头）"});
        }
        if (providerId === "hotmail") {
            let pool = "";
            try { pool = await readFile(TOKENS_FILE, "utf8"); } catch {}
            if (!pool.trim()) {
                return res.json({ok: false, error: "本地微软邮箱池为空，请先更新邮箱池"});
            }
        }
        const c2a = readChatgpt2ApiFromConfig(saved);
        const config: RunnerConfig = {
            proxyUrl: String(proxyUrl || "").trim(),
            threads: Math.max(1, Number(threads) || 1),
            totalRounds: Math.max(1, Number(totalRounds) || 1),
            password: String(password || "kuaileshifu88").trim(),
            loopDelayMs: Math.max(0, Number(loopDelayMs) || 0),
            chatgpt2api: chatgpt2ApiIsConfigured(c2a) ? c2a : undefined,
            chatgpt2apiConnected: chatgpt2apiLastOk,
        };
        if (!config.proxyUrl) {
            return res.json({ok: false, error: "代理地址不能为空"});
        }
        // Persist proxy used for this run
        if (proxyUrl !== undefined) {
            saved.defaultProxyUrl = config.proxyUrl;
            await writeFile(CONFIG_FILE, JSON.stringify(saved, null, 2) + "\n", "utf8").catch(() => {});
        }
        runner.start(config);
        res.json({
            ok: true,
            chatgpt2apiConfigured: Boolean(config.chatgpt2api),
            emailProvider: providerId,
        });
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

// GET /api/download-rt — download oumiFree-format codex JSON(s), then clear pending codex dir
// Each account: {email}.json with fields matching oumiFree export
app.get("/api/download-rt", async (_req, res) => {
    try {
        if (!existsSync(CODEX_DIR)) {
            return res.status(404).json({ok: false, error: "暂无 RT 账号（auth/codex 为空）"});
        }
        const names = (await readdir(CODEX_DIR)).filter((n) => n.endsWith(".json"));
        if (names.length === 0) {
            return res.status(404).json({ok: false, error: "暂无 RT 账号（auth/codex 为空）"});
        }

        const files: {name: string; data: Buffer}[] = [];
        for (const name of names) {
            const raw = await readFile(path.join(CODEX_DIR, name), "utf8");
            let obj: Record<string, unknown>;
            try {
                obj = JSON.parse(raw) as Record<string, unknown>;
            } catch {
                continue;
            }
            // Normalize to exact oumiFree schema
            const email = String(obj.email ?? name.replace(/\.json$/i, ""));
            const out = {
                type: "codex",
                email,
                password: String(obj.password ?? ""),
                expired: String(obj.expired ?? ""),
                id_token: String(obj.id_token ?? ""),
                account_id: String(obj.account_id ?? ""),
                disabled: Boolean(obj.disabled ?? false),
                access_token: String(obj.access_token ?? ""),
                session_token: String(obj.session_token ?? ""),
                workspace_id: String(obj.workspace_id ?? ""),
                last_refresh: String(obj.last_refresh ?? ""),
                refresh_token: String(obj.refresh_token ?? ""),
            };
            if (!out.refresh_token) {
                continue;
            }
            const safeName = `${email.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")}.json`;
            files.push({
                name: safeName,
                data: Buffer.from(`${JSON.stringify(out, null, 2)}\n`, "utf8"),
            });
        }

        if (files.length === 0) {
            return res.status(404).json({ok: false, error: "暂无含 refresh_token 的账号"});
        }

        // Single account → raw .json (same as oumiFree one-file export)
        // Multiple → zip of {email}.json files
        if (files.length === 1) {
            res.setHeader("content-type", "application/json; charset=utf-8");
            res.setHeader(
                "content-disposition",
                `attachment; filename="${files[0].name}"`,
            );
            res.send(files[0].data);
        } else {
            const zipBuf = buildZipStore(files);
            res.setHeader("content-type", "application/zip");
            res.setHeader(
                "content-disposition",
                `attachment; filename="codex_${Date.now()}.zip"`,
            );
            res.send(zipBuf);
        }

        // Clear pending codex export dir after download (auth/at archive kept)
        for (const name of names) {
            await rm(path.join(CODEX_DIR, name)).catch(() => {});
        }
    } catch (err) {
        res.status(500).json({ok: false, error: String(err)});
    }
});

/**
 * Minimal ZIP (store / no compression) for bundling multiple {email}.json files.
 */
function buildZipStore(files: {name: string; data: Buffer}[]): Buffer {
    const localParts: Buffer[] = [];
    const centralParts: Buffer[] = [];
    let offset = 0;

    for (const file of files) {
        const nameBuf = Buffer.from(file.name, "utf8");
        const data = file.data;
        const crc = crc32(data);
        const size = data.length;

        const local = Buffer.alloc(30 + nameBuf.length);
        local.writeUInt32LE(0x04034b50, 0); // local file header sig
        local.writeUInt16LE(20, 4); // version needed
        local.writeUInt16LE(0, 6); // flags
        local.writeUInt16LE(0, 8); // method = store
        local.writeUInt16LE(0, 10); // time
        local.writeUInt16LE(0, 12); // date
        local.writeUInt32LE(crc >>> 0, 14);
        local.writeUInt32LE(size, 18);
        local.writeUInt32LE(size, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28); // extra len
        nameBuf.copy(local, 30);

        localParts.push(local, data);

        const central = Buffer.alloc(46 + nameBuf.length);
        central.writeUInt32LE(0x02014b50, 0); // central dir sig
        central.writeUInt16LE(20, 4); // version made by
        central.writeUInt16LE(20, 6); // version needed
        central.writeUInt16LE(0, 8);
        central.writeUInt16LE(0, 10); // store
        central.writeUInt16LE(0, 12);
        central.writeUInt16LE(0, 14);
        central.writeUInt32LE(crc >>> 0, 16);
        central.writeUInt32LE(size, 20);
        central.writeUInt32LE(size, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt16LE(0, 30);
        central.writeUInt16LE(0, 32);
        central.writeUInt16LE(0, 34);
        central.writeUInt16LE(0, 36);
        central.writeUInt32LE(0, 38);
        central.writeUInt32LE(offset, 42);
        nameBuf.copy(central, 46);
        centralParts.push(central);

        offset += local.length + data.length;
    }

    const centralDir = Buffer.concat(centralParts);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(centralDir.length, 12);
    end.writeUInt32LE(offset, 16);
    end.writeUInt16LE(0, 20);

    return Buffer.concat([...localParts, centralDir, end]);
}

function crc32(buf: Buffer): number {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
        crc ^= buf[i];
        for (let j = 0; j < 8; j++) {
            const mask = -(crc & 1);
            crc = (crc >>> 1) ^ (0xedb88320 & mask);
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

// ── start ──
const PORT = Number(process.env.PORT) || 8318;
app.listen(PORT, () => {
    console.log(`[WebUI] http://localhost:${PORT}`);
});
