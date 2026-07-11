import {ImapFlow} from "imapflow";
// @ts-nocheck
import {readFileSync, existsSync} from "node:fs";
import {readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import {
    findLatestVerificationMail,
    extractAllVerificationCodes,
    markVerificationCodeRejected,
    clearRememberedVerificationCode,
    extractMailTextContent,
} from "./verification-matcher.js";

const HOTMAIL_TOKEN_DIR = path.resolve(process.cwd(), process.env.HOTMAIL_DIR || "hotmail");
const HOTMAIL_TOKENS_FILE = path.join(HOTMAIL_TOKEN_DIR, "tokens.txt");
const HOTMAIL_GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const HOTMAIL_OAUTH_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const HOTMAIL_GRAPH_SCOPE = "offline_access https://graph.microsoft.com/Mail.Read";
// Consumer Outlook tokens from most sellers are IMAP/POP scoped, not Graph
const HOTMAIL_IMAP_SCOPE =
    "https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/POP.AccessAsUser.All offline_access";
const HOTMAIL_DEFAULT_REDIRECT_URI = "";
const HOTMAIL_POLL_ATTEMPTS = 18;
const HOTMAIL_POLL_INTERVAL_MS = 3000;
const HOTMAIL_MESSAGE_FETCH_LIMIT = 15;
const HOTMAIL_FOLDER_IDS_GRAPH = ["inbox", "junkemail"];
const HOTMAIL_FOLDER_IDS_IMAP = ["inbox", "junkemail"];
const HOTMAIL_ALIAS_SUFFIX_FILE = path.join(HOTMAIL_TOKEN_DIR, "alias_suffix.txt");
const IMAP_HOST = "outlook.office365.com";
const IMAP_PORT = 993;
const IMAP_IDLE_TTL_MS = 90_000;
const IMAP_CONNECT_TIMEOUT_MS = 20_000;

const aliasAccountMap = new Map();
let accountCache = null;
let usedBaseEmails = new Set<string>();

// Per-mailbox IMAP session reuse (avoids CONNECT+AUTH every poll)
const imapSessions = new Map();

export function markEmailUsed(email: string): void {
    const base = email.replace(/\+[^@]*/, "").toLowerCase();
    usedBaseEmails.add(base);
    console.log(`[usedEmail] marked ${base} (total used: ${usedBaseEmails.size})`);
}

export function isEmailUsed(email: string): boolean {
    const base = email.replace(/\+[^@]*/, "").toLowerCase();
    return usedBaseEmails.has(base);
}

export function clearUsedEmails(): void {
    usedBaseEmails.clear();
}

let _abortController: AbortController | null = null;

export function createAbortController(): AbortController {
    _abortController = new AbortController();
    return _abortController;
}

export function abortRegistration(): void {
    if (_abortController) {
        _abortController.abort();
        _abortController = null;
    }
    // Drop IMAP sessions so stop is responsive and sockets are not leaked
    void closeAllImapSessions();
}

export function getAbortSignal(): AbortSignal | undefined {
    return _abortController?.signal;
}

export function clearAccountCache(): void {
    accountCache = null;
}

let currentAliasSuffix = "";
let randomAliasEnabled = false;
// Default imap: seller tokens almost always carry Outlook IMAP scopes, not Graph
let mailApiMode: "graph" | "imap" | "auto" = "auto";

function normalizeEmail(value) {
    return String(value ?? "").trim().toLowerCase();
}

function scopeLooksLikeImap(scope) {
    const s = String(scope ?? "").toLowerCase();
    return s.includes("outlook.office.com") || s.includes("imap.accessasuser");
}

function scopeLooksLikeGraph(scope) {
    const s = String(scope ?? "").toLowerCase();
    return s.includes("graph.microsoft.com");
}

function accessTokenLooksLikeJwt(token) {
    const parts = String(token ?? "").split(".");
    return parts.length === 3 && parts.every((p) => p.length > 0);
}

function resolveEffectiveMode(account) {
    if (mailApiMode === "graph" || mailApiMode === "imap") {
        return mailApiMode;
    }
    // auto: prefer IMAP when token is Outlook-scoped or non-JWT (Graph needs JWT)
    if (scopeLooksLikeImap(account?.scope) && !scopeLooksLikeGraph(account?.scope)) {
        return "imap";
    }
    if (account?.accessToken && !accessTokenLooksLikeJwt(account.accessToken)) {
        return "imap";
    }
    if (scopeLooksLikeGraph(account?.scope)) {
        return "graph";
    }
    // Unknown: IMAP is more reliable for consumer hotmail tokens
    return "imap";
}

function decodeJwtPayload(token) {
    const parts = String(token ?? "").split(".");
    if (parts.length < 2) {
        return {};
    }
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    try {
        return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    } catch {
        return {};
    }
}

function getTokenExpireAtMs(account) {
    const payload = decodeJwtPayload(account.accessToken);
    const exp = Number(payload.exp ?? 0);
    if (exp > 0) {
        return exp * 1000;
    }

    const obtainedAt = Date.parse(String(account.obtainedAt ?? ""));
    const expiresIn = Number(account.expiresIn ?? 0);
    if (Number.isFinite(obtainedAt) && expiresIn > 0) {
        return obtainedAt + expiresIn * 1000;
    }

    return 0;
}

function isAccessTokenExpired(account) {
    if (!account.accessToken) {
        return true;
    }
    const expireAtMs = getTokenExpireAtMs(account);
    if (!expireAtMs) {
        // Opaque token without expiry metadata: treat as valid for 45 min after obtain
        const obtainedAt = Date.parse(String(account.obtainedAt ?? ""));
        if (Number.isFinite(obtainedAt) && obtainedAt > 0) {
            return Date.now() >= obtainedAt + 45 * 60 * 1000;
        }
        return false;
    }
    return Date.now() >= expireAtMs - 60 * 1000;
}

async function loadTextAccounts() {
    try {
        const raw = await readFile(HOTMAIL_TOKENS_FILE, "utf8");
        return raw
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line, index) => {
                const [email, password, clientId, refreshToken] = line.split("----");
                const loginHint = normalizeEmail(email);
                const account = {
                    sourceType: "txt",
                    fileName: path.basename(HOTMAIL_TOKENS_FILE),
                    filePath: HOTMAIL_TOKENS_FILE,
                    lineIndex: index,
                    lineRaw: line,
                    loginHint,
                    password: String(password ?? "").trim(),
                    sourceAccount: loginHint,
                    tenant: "consumers",
                    clientId: String(clientId ?? "").trim(),
                    redirectUri: "",
                    scope: "",
                    tokenType: "Bearer",
                    accessToken: "",
                    refreshToken: String(refreshToken ?? "").trim(),
                    idToken: "",
                    obtainedAt: "",
                    expiresIn: 0,
                    extExpiresIn: 0,
                    raw: {},
                };
                return loginHint && account.clientId && account.refreshToken ? account : null;
            })
            .filter(Boolean);
    } catch (error) {
        if (error?.code === "ENOENT") {
            return [];
        }
        throw error;
    }
}

async function loadAccounts() {
    if (accountCache) {
        return accountCache;
    }

    const textAccounts = await loadTextAccounts();
    const accounts = textAccounts;
    if (!accounts.length) {
        throw new Error(`未在文件找到 Hotmail token: ${HOTMAIL_TOKENS_FILE}`);
    }

    accountCache = accounts;
    return accounts;
}

async function persistTextAccount(account) {
    const raw = await readFile(HOTMAIL_TOKENS_FILE, "utf8");
    const lines = raw.split(/\r?\n/);
    const nextLine = [
        account.loginHint,
        account.password ?? "",
        account.clientId ?? "",
        account.refreshToken ?? "",
    ].join("----");
    const index = Number(account.lineIndex ?? -1);

    if (index >= 0 && index < lines.length) {
        lines[index] = nextLine;
    } else {
        lines.push(nextLine);
        account.lineIndex = lines.length - 1;
    }

    await writeFile(HOTMAIL_TOKENS_FILE, `${lines.filter((line) => line != null).join("\n").replace(/\n+$/g, "")}\n`, "utf8");
    account.lineRaw = nextLine;
}

async function persistAccount(account) {
    await persistTextAccount(account);
}

function buildRefreshVariants(account) {
    const redirectUri = String(account.redirectUri ?? "").trim();
    const preferredMode = resolveEffectiveMode(account);
    // Prefer scope that matches the active mail mode so we don't burn rate limits on useless Graph tokens
    const preferredScope = preferredMode === "imap" ? HOTMAIL_IMAP_SCOPE : HOTMAIL_GRAPH_SCOPE;
    const secondaryScope = preferredMode === "imap" ? HOTMAIL_GRAPH_SCOPE : HOTMAIL_IMAP_SCOPE;

    const variants = [
        {redirectUri: "", scope: preferredScope},
        {redirectUri: "", scope: ""},
        {redirectUri: "", scope: secondaryScope},
        {redirectUri, scope: preferredScope},
        {redirectUri, scope: ""},
        {redirectUri, scope: secondaryScope},
    ];
    const seen = new Set();

    return variants.filter((item) => {
        const key = `${item.redirectUri}|||${item.scope}`;
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}

async function refreshAccessToken(account) {
    if (!account.clientId || !account.refreshToken) {
        throw new Error(`Hotmail token 缺少刷新所需字段: ${account.fileName}`);
    }

    let lastError = "";
    for (const variant of buildRefreshVariants(account)) {
        const body = new URLSearchParams({
            client_id: account.clientId,
            grant_type: "refresh_token",
            refresh_token: account.refreshToken,
        });

        if (variant.redirectUri) {
            body.set("redirect_uri", variant.redirectUri);
        }
        if (variant.scope) {
            body.set("scope", variant.scope);
        }

        let response;
        try {
            response = await fetch(HOTMAIL_OAUTH_TOKEN_URL, {
                method: "POST",
                headers: {
                    Accept: "application/json",
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                body: body.toString(),
            });
        } catch (err) {
            lastError = `redirect=${variant.redirectUri || "(empty)"} scope=${variant.scope || "(empty)"} network=${String(err)}`;
            continue;
        }

        const rawBody = await response.text();
        if (!response.ok) {
            lastError = `redirect=${variant.redirectUri || "(empty)"} scope=${variant.scope || "(empty)"} status=${response.status} body=${rawBody.slice(0, 300)}`;
            continue;
        }

        const payload = JSON.parse(rawBody);
        const nextAccess = String(payload?.access_token ?? "").trim();
        if (!nextAccess) {
            lastError = `empty access_token scope=${variant.scope || "(empty)"}`;
            continue;
        }

        // Invalidate cached IMAP session when access token rotates
        if (account.accessToken && account.accessToken !== nextAccess) {
            await closeImapSession(account.loginHint);
        }

        account.accessToken = nextAccess;
        account.refreshToken = String(payload?.refresh_token ?? account.refreshToken).trim();
        account.idToken = String(payload?.id_token ?? account.idToken ?? "").trim();
        account.tokenType = String(payload?.token_type ?? account.tokenType ?? "Bearer").trim();
        account.scope = String(payload?.scope ?? variant.scope ?? account.scope).trim();
        account.redirectUri = variant.redirectUri || account.redirectUri || HOTMAIL_DEFAULT_REDIRECT_URI;
        account.expiresIn = Number(payload?.expires_in ?? account.expiresIn ?? 3600);
        account.extExpiresIn = Number(payload?.ext_expires_in ?? account.extExpiresIn ?? 0);
        account.obtainedAt = new Date().toISOString();
        account.apiMode = resolveEffectiveMode(account);

        // Persist refresh_token rotation only (access token stays in memory)
        await persistAccount(account);
        console.log(
            `hotmailTokenRefreshed: ${account.loginHint} mode=${account.apiMode} jwt=${accessTokenLooksLikeJwt(account.accessToken)} scope=${account.scope.slice(0, 120)}`,
        );
        return account;
    }

    throw new Error(`Hotmail 刷新 token 失败: ${lastError}`);
}

async function ensureFreshAccount(account) {
    if (!account.accessToken || isAccessTokenExpired(account)) {
        await refreshAccessToken(account);
    }
    return account;
}

function buildAuthHeaders(account) {
    return {
        Accept: "application/json",
        Authorization: `Bearer ${account.accessToken}`,
    };
}

async function graphRequest(account, url) {
    await ensureFreshAccount(account);

    // Graph requires a JWT access token; Outlook IMAP tokens will never work
    if (!accessTokenLooksLikeJwt(account.accessToken)) {
        throw new Error(
            "Hotmail Graph token is not a JWT (Outlook/IMAP scope). Switch mailApiMode to imap or auto.",
        );
    }

    let response = await fetch(url, {
        method: "GET",
        headers: buildAuthHeaders(account),
    });

    if (response.status === 401) {
        await refreshAccessToken(account);
        if (!accessTokenLooksLikeJwt(account.accessToken)) {
            throw new Error(
                "Hotmail Graph 401 and refreshed token is still not a Graph JWT. Use IMAP mode.",
            );
        }
        response = await fetch(url, {
            method: "GET",
            headers: buildAuthHeaders(account),
        });
    }

    if (!response.ok) {
        const body = await response.text();
        let detail = body;
        try {
            const err = JSON.parse(body);
            detail = err?.error?.message || body;
        } catch {}
        throw new Error(`Hotmail Graph request failed: HTTP ${response.status}, ${detail}`);
    }

    return response.json();
}

function chooseRandomAccount(accounts) {
    const available = accounts.filter((a) => !usedBaseEmails.has(normalizeEmail(a.loginHint)));
    if (available.length === 0) {
        console.log("[usedEmail] All emails used, resetting tracking");
        usedBaseEmails.clear();
        return accounts[Math.floor(Math.random() * accounts.length)];
    }
    return available[Math.floor(Math.random() * available.length)];
}

function buildAliasAddress(account) {
    const mailbox = normalizeEmail(account.loginHint);
    let suffix = currentAliasSuffix.replace(/^\++/, "");
    if (!suffix) {
        return mailbox;
    }
    if (randomAliasEnabled) {
        suffix = suffix + "_" + generateRandomSuffix(6);
    }
    const [localPart, domain] = mailbox.split("@");
    if (!localPart || !domain) {
        throw new Error(`Hotmail 邮箱格式不正确: ${account.loginHint}`);
    }
    return `${localPart}+${suffix}@${domain}`;
}

function generateRandomSuffix(length: number): string {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let result = "";
    for (let i = 0; i < length; i++) {
        result += chars[Math.floor(Math.random() * chars.length)];
    }
    return result;
}

export function getAliasSuffix(): string {
    return currentAliasSuffix;
}

export function getRandomAliasEnabled(): boolean {
    return randomAliasEnabled;
}

export function setRandomAliasEnabled(enabled: boolean): void {
    randomAliasEnabled = !!enabled;
}

export async function setAliasSuffix(suffix: string): Promise<void> {
    currentAliasSuffix = String(suffix ?? "").trim();
    await writeFile(HOTMAIL_ALIAS_SUFFIX_FILE, currentAliasSuffix + "\n", "utf8");
}

export function getMailApiMode(): string {
    return mailApiMode;
}

export function setMailApiMode(mode: string): void {
    if (mode === "imap" || mode === "graph" || mode === "auto") {
        mailApiMode = mode;
        accountCache = null;
        void closeAllImapSessions();
    }
}

function loadAliasSuffix(): void {
    try {
        if (existsSync(HOTMAIL_ALIAS_SUFFIX_FILE)) {
            currentAliasSuffix = readFileSync(HOTMAIL_ALIAS_SUFFIX_FILE, "utf8").trim();
        }
    } catch (error) {
        console.error("loadAliasSuffix error:", error);
    }
}

loadAliasSuffix();

function normalizeRecipientList(recipients) {
    if (!Array.isArray(recipients)) {
        return [];
    }
    return recipients
        .map((item) =>
            normalizeEmail(
                item?.EmailAddress?.Address ??
                    item?.emailAddress?.address ??
                    item?.address ??
                    "",
            ),
        )
        .filter(Boolean);
}

function normalizeMessage(message, folderId) {
    const bodyContent = String(message?.Body?.Content ?? message?.body?.content ?? "");
    return {
        id: String(message?.Id ?? message?.id ?? ""),
        folderId,
        subject: String(message?.Subject ?? message?.subject ?? ""),
        bodyContent,
        bodyPreview: String(message?.BodyPreview ?? message?.bodyPreview ?? ""),
        from: normalizeEmail(
            message?.From?.EmailAddress?.Address ??
                message?.from?.emailAddress?.address ??
                "",
        ),
        toRecipients: normalizeRecipientList(message?.ToRecipients ?? message?.toRecipients),
        receivedDateTime: String(message?.ReceivedDateTime ?? message?.receivedDateTime ?? ""),
        receivedAtMs:
            Date.parse(String(message?.ReceivedDateTime ?? message?.receivedDateTime ?? "")) || 0,
        raw: message,
    };
}

// ── Proxy helpers (HTTP CONNECT + SOCKS5) ──

function getImapProxyConfig() {
    const proxyUrl = process.env.REGISTRATION_PROXY_URL || "";
    if (!proxyUrl) return null;
    try {
        const u = new URL(proxyUrl);
        return {
            protocol: (u.protocol || "http:").replace(":", "").toLowerCase(),
            host: u.hostname,
            port: Number(u.port) || (u.protocol.startsWith("socks") ? 1080 : 3128),
            username: decodeURIComponent(u.username || ""),
            password: decodeURIComponent(u.password || ""),
            raw: proxyUrl,
        };
    } catch {
        return null;
    }
}

function httpConnectTunnel(proxy, targetHost, targetPort) {
    return new Promise((resolve, reject) => {
        const headers = {
            Host: `${targetHost}:${targetPort}`,
            "Proxy-Connection": "Keep-Alive",
        };
        if (proxy.username) {
            headers["Proxy-Authorization"] =
                "Basic " + Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64");
        }
        const req = http.request({
            host: proxy.host,
            port: proxy.port,
            method: "CONNECT",
            path: `${targetHost}:${targetPort}`,
            headers,
            timeout: IMAP_CONNECT_TIMEOUT_MS,
        });
        req.on("connect", (res, socket) => {
            if (res.statusCode && res.statusCode >= 400) {
                socket.destroy();
                reject(new Error(`Proxy CONNECT failed: HTTP ${res.statusCode}`));
                return;
            }
            socket.setKeepAlive(true, 30_000);
            resolve(socket);
        });
        req.on("error", reject);
        req.on("timeout", () => {
            req.destroy();
            reject(new Error("Proxy CONNECT timeout"));
        });
        req.end();
    });
}

async function socksConnectTunnel(proxy, targetHost, targetPort) {
    const {SocksClient} = await import("socks");
    const type = proxy.protocol.includes("4") ? 4 : 5;
    const info = await SocksClient.createConnection({
        proxy: {
            host: proxy.host,
            port: proxy.port,
            type,
            userId: proxy.username || undefined,
            password: proxy.password || undefined,
        },
        command: "connect",
        destination: {host: targetHost, port: targetPort},
        timeout: IMAP_CONNECT_TIMEOUT_MS,
    });
    info.socket.setKeepAlive(true, 30_000);
    return info.socket;
}

async function openProxySocket(targetHost, targetPort) {
    const proxy = getImapProxyConfig();
    if (!proxy) return null;
    if (proxy.protocol.startsWith("socks")) {
        console.log(
            `[imapProxy] SOCKS ${proxy.host}:${proxy.port} -> ${targetHost}:${targetPort}`,
        );
        return socksConnectTunnel(proxy, targetHost, targetPort);
    }
    console.log(
        `[imapProxy] CONNECT ${proxy.host}:${proxy.port} -> ${targetHost}:${targetPort}`,
    );
    return httpConnectTunnel(proxy, targetHost, targetPort);
}

// ── IMAP session pool ──

async function closeImapSession(loginHint) {
    const key = normalizeEmail(loginHint);
    const session = imapSessions.get(key);
    if (!session) return;
    imapSessions.delete(key);
    if (session.idleTimer) clearTimeout(session.idleTimer);
    try {
        await session.client.logout().catch(() => {});
    } catch {}
    try {
        session.client.close();
    } catch {}
}

async function closeAllImapSessions() {
    const keys = [...imapSessions.keys()];
    await Promise.all(keys.map((k) => closeImapSession(k)));
}

function touchImapSession(loginHint) {
    const key = normalizeEmail(loginHint);
    const session = imapSessions.get(key);
    if (!session) return;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
        void closeImapSession(key);
    }, IMAP_IDLE_TTL_MS);
    session.lastUsedAt = Date.now();
}

async function getImapClient(account) {
    const key = normalizeEmail(account.loginHint);
    const existing = imapSessions.get(key);
    if (existing?.client?.usable) {
        touchImapSession(key);
        return existing.client;
    }
    if (existing) {
        await closeImapSession(key);
    }

    await ensureFreshAccount(account);

    const rawSocket = await openProxySocket(IMAP_HOST, IMAP_PORT);
    const clientOptions = {
        host: IMAP_HOST,
        port: IMAP_PORT,
        secure: true,
        auth: {user: account.loginHint, accessToken: account.accessToken},
        logger: false,
        emitLogs: false,
        socketTimeout: 60_000,
        greetingTimeout: IMAP_CONNECT_TIMEOUT_MS,
        connectionTimeout: IMAP_CONNECT_TIMEOUT_MS,
    };

    if (rawSocket) {
        clientOptions.tls = {
            socket: rawSocket,
            servername: IMAP_HOST,
            rejectUnauthorized: false,
        };
    }

    const client = new ImapFlow(clientOptions);

    client.on("error", (err) => {
        console.log(`[imap] session error ${account.loginHint}: ${String(err).slice(0, 120)}`);
        void closeImapSession(key);
    });
    client.on("close", () => {
        if (imapSessions.get(key)?.client === client) {
            imapSessions.delete(key);
        }
    });

    try {
        await client.connect();
    } catch (err) {
        try {
            client.close();
        } catch {}
        // Auth failures often mean stale access token — force refresh next time
        if (/AUTH|authentication|Invalid credentials|LOGIN/i.test(String(err))) {
            account.accessToken = "";
            account.obtainedAt = "";
        }
        throw err;
    }

    imapSessions.set(key, {client, idleTimer: null, lastUsedAt: Date.now()});
    touchImapSession(key);
    return client;
}

function folderIdToImapName(folderId) {
    if (folderId === "junkemail") return "Junk";
    return "INBOX";
}

function buildImapSinceDate(sinceMs) {
    // IMAP SINCE is date-only (UTC day). Go back 1 day for timezone safety.
    const d = new Date((sinceMs || Date.now()) - 24 * 60 * 60 * 1000);
    return d;
}

async function imapFetchMessages(account, folderId, sinceMs = 0) {
    let client = await getImapClient(account);
    const folderName = folderIdToImapName(folderId);

    let lock;
    try {
        lock = await client.getMailboxLock(folderName);
    } catch (err) {
        // Junk may be named differently; try common alternatives once
        if (folderId === "junkemail") {
            for (const alt of ["Junk Email", "Junk E-mail", "Spam"]) {
                try {
                    lock = await client.getMailboxLock(alt);
                    break;
                } catch {}
            }
        }
        if (!lock) {
            // Session may be dead — recreate once
            await closeImapSession(account.loginHint);
            client = await getImapClient(account);
            lock = await client.getMailboxLock(folderName);
        }
    }

    try {
        const total = client.mailbox?.exists ?? 0;
        if (!total) return [];

        // Prefer SEARCH (SINCE + FROM/SUBJECT) over blind tail fetch
        let uids = [];
        try {
            const sinceDate = buildImapSinceDate(sinceMs);
            const orCriteria = [
                ["FROM", "openai.com"],
                ["FROM", "openai"],
                ["SUBJECT", "OpenAI"],
                ["SUBJECT", "ChatGPT"],
                ["SUBJECT", "verification"],
            ];
            // imapflow search: { since, or: [...] }
            uids = await client.search(
                {
                    since: sinceDate,
                    or: orCriteria,
                },
                {uid: true},
            );
        } catch (searchErr) {
            console.log(
                `[imap] search fallback ${folderId}: ${String(searchErr).slice(0, 100)}`,
            );
            uids = [];
        }

        // Fallback: last N messages by sequence
        let fetchQuery;
        if (Array.isArray(uids) && uids.length > 0) {
            const sliced = uids.slice(-HOTMAIL_MESSAGE_FETCH_LIMIT);
            fetchQuery = {uid: sliced.join(",")};
        } else {
            const start = Math.max(1, total - HOTMAIL_MESSAGE_FETCH_LIMIT + 1);
            fetchQuery = {seq: `${start}:*`};
        }

        const messages = [];
        for await (const msg of client.fetch(fetchQuery, {
            envelope: true,
            source: true,
            uid: true,
        })) {
            const envelope = msg.envelope || {};
            const source = msg.source ? Buffer.from(msg.source).toString("utf-8") : "";
            const decodedBody = extractMailTextContent(source);
            const toList = [
                ...(envelope.to || []),
                ...(envelope.cc || []),
                ...(envelope.bcc || []),
            ];

            messages.push(
                normalizeMessage(
                    {
                        Id: String(msg.uid || msg.seq),
                        Subject: envelope.subject || "",
                        From: envelope.from?.length
                            ? {EmailAddress: {Address: envelope.from[0].address || ""}}
                            : {},
                        ToRecipients: toList.map((t) => ({
                            EmailAddress: {Address: t.address || ""},
                        })),
                        ReceivedDateTime: envelope.date ? envelope.date.toISOString() : "",
                        Body: {Content: decodedBody || source},
                        BodyPreview: (decodedBody || source).slice(0, 400),
                    },
                    folderId,
                ),
            );
        }

        touchImapSession(account.loginHint);
        return messages;
    } finally {
        try {
            lock?.release();
        } catch {}
    }
}

// ── Unified message list (routes to Graph or IMAP) ──
async function listFolderMessages(account, folderId, sinceMs = 0) {
    const mode = resolveEffectiveMode(account);
    if (mode === "imap") {
        return imapFetchMessages(account, folderId, sinceMs);
    }

    const url = new URL(
        HOTMAIL_GRAPH_BASE_URL +
            "/me/mailFolders/" +
            encodeURIComponent(folderId) +
            "/messages",
    );
    url.searchParams.set("$top", String(HOTMAIL_MESSAGE_FETCH_LIMIT));
    url.searchParams.set("$orderby", "receivedDateTime desc");
    url.searchParams.set("$select", "subject,receivedDateTime,from,toRecipients,body,bodyPreview");
    // Server-side filter when possible
    if (sinceMs > 0) {
        const iso = new Date(sinceMs - 60_000).toISOString();
        url.searchParams.set(
            "$filter",
            `receivedDateTime ge ${iso} and (contains(subject,'OpenAI') or contains(subject,'ChatGPT') or contains(from/emailAddress/address,'openai'))`,
        );
    }

    try {
        const payload = await graphRequest(account, url);
        return Array.isArray(payload?.value)
            ? payload.value.map((item) => normalizeMessage(item, folderId))
            : [];
    } catch (err) {
        // Auto-fallback to IMAP when Graph is impossible with this token
        const msg = String(err);
        if (
            /not a JWT|Use IMAP|JWT is not well formed|MailboxNotEnabledForRESTAPI|InvalidAuthenticationToken/i.test(
                msg,
            )
        ) {
            console.log(
                `[mail] Graph unavailable for ${account.loginHint}, falling back to IMAP: ${msg.slice(0, 120)}`,
            );
            account._forceImap = true;
            return imapFetchMessages(account, folderId, sinceMs);
        }
        throw err;
    }
}

// Track per-target registration start time for since-filter
const otpStartTime = new Map();
/** Message ids already in mailbox when OTP poll started (old mails) */
const otpBaselineIds = new Map();
/** Codes already present before OTP send (must never be submitted) */
const otpBaselineCodes = new Map();

function isOpenAiMail(mail) {
    const blob =
        (mail.subject || "") +
        "\n" +
        (mail.bodyPreview || "") +
        "\n" +
        (mail.from || "") +
        "\n" +
        String(mail.bodyContent || mail.content || "").slice(0, 1200);
    // Require OpenAI identity — bare "验证码" matches Alibaba/etc and must not qualify
    return /(OpenAI|ChatGPT|openai\.com|tm\.openai\.com|noreply@tm\.openai)/i.test(blob);
}

async function listAllFolderMessages(account, sinceMs = 0) {
    const mode = account._forceImap ? "imap" : resolveEffectiveMode(account);
    const folders = mode === "imap" ? HOTMAIL_FOLDER_IDS_IMAP : HOTMAIL_FOLDER_IDS_GRAPH;
    const messages = [];

    if (mode === "imap") {
        for (const folderId of folders) {
            try {
                const folderMessages = await listFolderMessages(account, folderId, sinceMs);
                messages.push(...folderMessages);
            } catch (e) {
                console.log(
                    `listFolderMessages error for ${folderId}:`,
                    String(e).slice(0, 160),
                );
            }
        }
    } else {
        const results = await Promise.all(
            folders.map(async (folderId) => {
                try {
                    return await listFolderMessages(account, folderId, sinceMs);
                } catch (e) {
                    console.log(
                        `listFolderMessages error for ${folderId}:`,
                        String(e).slice(0, 160),
                    );
                    return [];
                }
            }),
        );
        for (const list of results) messages.push(...list);
    }

    messages.sort((a, b) => b.receivedAtMs - a.receivedAtMs);
    return {mode, messages};
}

/**
 * Snapshot existing OpenAI-looking mails/codes BEFORE we wait for a new OTP.
 * Anything already present is treated as stale and never returned.
 */
async function captureOtpBaseline(targetEmail, account) {
    const {mode, messages} = await listAllFolderMessages(account, 0);
    const ids = new Set();
    const codes = new Set();
    // Anything at/after since is treated as potentially the current OTP — do NOT blacklist
    const since = otpStartTime.get(targetEmail) || (Date.now() - 5_000);
    let skippedFresh = 0;

    for (const message of messages) {
        if (!isOpenAiMail(message)) continue;
        const ts = Number(message.receivedAtMs || 0);
        // Keep mails newer than since out of baseline (they may be the OTP we need)
        if (ts > 0 && ts >= since - 15_000) {
            skippedFresh += 1;
            continue;
        }
        if (message.id) ids.add(String(message.id));
        const mapped = {
            ...message,
            recipient: message.toRecipients,
            content: message.bodyContent,
            timestamp: message.receivedAtMs,
            extraTexts: [message.bodyPreview, message.from, message.subject],
        };
        for (const code of extractAllVerificationCodes(mapped)) {
            codes.add(code);
            markVerificationCodeRejected(targetEmail, code);
        }
    }

    otpBaselineIds.set(targetEmail, ids);
    otpBaselineCodes.set(targetEmail, codes);
    console.log(
        `hotmailOtpBaseline: mode=${mode} mailbox=${account.loginHint} staleMails=${ids.size} staleCodes=[${[...codes].join(",")}] skippedFresh=${skippedFresh} since=${new Date(since).toISOString()}`,
    );
    return {ids, codes};
}

async function getLatestVerificationMessage(targetEmail, account) {
    if (!otpStartTime.has(targetEmail)) {
        otpStartTime.set(targetEmail, Date.now() - 90_000);
    }
    const since = otpStartTime.get(targetEmail) || 0;
    const baselineIds = otpBaselineIds.get(targetEmail) || new Set();
    const baselineCodes = otpBaselineCodes.get(targetEmail) || new Set();

    // Fetch recent mails without relying on IMAP SINCE (date-only, too coarse).
    // Client-side since + baseline ids filter stale content.
    const {mode, messages} = await listAllFolderMessages(account, 0);

    const openaiMails = messages.filter((m) => isOpenAiMail(m));
    const fresh = openaiMails.filter((m) => m.id && !baselineIds.has(String(m.id)));
    // Always prefer fresh OpenAI mails; never fall back to pre-baseline ids
    const candidates = fresh;

    // Debug: show top candidates
    for (const m of candidates.slice(0, 3)) {
        const ageSec = m.receivedAtMs ? Math.round((Date.now() - m.receivedAtMs) / 1000) : -1;
        console.log(
            `hotmailOtpCandidate: id=${m.id} ageSec=${ageSec} from=${m.from} subj=${String(m.subject || "").slice(0, 50)} body=${String(m.bodyContent || "").slice(0, 80)}`,
        );
    }

    console.log(
        `hotmailMessagesFetched: mode=${mode} targetEmail=${targetEmail} mailbox=${account.loginHint} total=${messages.length} openai=${openaiMails.length} fresh=${fresh.length} since=${new Date(since).toISOString()}`,
    );

    return findLatestVerificationMail(
        candidates.map((message) => ({
            ...message,
            recipient: message.toRecipients,
            content: message.bodyContent,
            timestamp: message.receivedAtMs,
            extraTexts: [message.bodyPreview, message.from, message.subject],
        })),
        {
            targetEmail,
            since,
            seenIds: baselineIds,
            rejectedCodes: baselineCodes,
            candidateMatcher: (mail) => isOpenAiMail(mail),
        },
    );
}

async function resolveAccountForEmail(email) {
    const normalizedEmail = normalizeEmail(email);
    const mapped = aliasAccountMap.get(normalizedEmail);
    if (mapped) {
        return mapped;
    }

    const accounts = await loadAccounts();
    const [localPart, domain] = normalizedEmail.split("@");
    const baseLocalPart = String(localPart || "").split("+")[0];

    const matched = accounts.find((account) => {
        const [accountLocalPart, accountDomain] = normalizeEmail(account.loginHint).split("@");
        return accountLocalPart === baseLocalPart && accountDomain === domain;
    });

    if (matched) {
        aliasAccountMap.set(normalizeEmail(email), matched);
        return matched;
    }

    throw new Error("Hotmail 未找到与邮箱匹配的 token: " + email);
}

async function sleepAbortable(ms) {
    const step = 250;
    for (let w = 0; w < ms; w += step) {
        if (_abortController?.signal.aborted) {
            throw new Error("Registration aborted by user");
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(step, ms - w)));
    }
}

function clearOtpState(email) {
    otpStartTime.delete(email);
    otpBaselineIds.delete(email);
    otpBaselineCodes.delete(email);
}

export function createHotmailProvider() {
    return {
        async getEmailAddress() {
            const accounts = await loadAccounts();
            const account = chooseRandomAccount(accounts);
            const aliasEmail = buildAliasAddress(account);
            aliasAccountMap.set(normalizeEmail(aliasEmail), account);
            return aliasEmail;
        },
        /**
         * Capture mailbox baseline BEFORE OpenAI sends the OTP.
         * Call this right before sendEmailOtp so new OTP mails are not blacklisted.
         */
        async prepareOtpBaseline(email) {
            // Idempotent: sendEmailOtp + emailOtpValidate may both call this
            if (otpBaselineIds.has(email) && otpStartTime.has(email)) {
                console.log(`[otp] baseline already prepared for ${email}`);
                return true;
            }
            const account = await resolveAccountForEmail(email);
            clearOtpState(email);
            clearRememberedVerificationCode(email);
            // since = now, before OTP is requested (or slightly before if validate-only path)
            otpStartTime.set(email, Date.now() - 5_000);
            try {
                await captureOtpBaseline(email, account);
            } catch (err) {
                console.log(`hotmailOtpBaseline error: ${String(err).slice(0, 200)}`);
                otpBaselineIds.set(email, new Set());
                otpBaselineCodes.set(email, new Set());
            }
            return true;
        },
        async getEmailVerificationCode(email) {
            const account = await resolveAccountForEmail(email);

            // If caller forgot prepareOtpBaseline, do a light baseline now but keep a wide since window
            if (!otpBaselineIds.has(email)) {
                console.log(`[otp] prepareOtpBaseline was not called; capturing late baseline for ${email}`);
                // Wide window: OTP may have arrived up to ~2 min ago when flow skips sendEmailOtp
                otpStartTime.set(email, Date.now() - 120_000);
                try {
                    await captureOtpBaseline(email, account);
                } catch (err) {
                    console.log(`hotmailOtpBaseline error: ${String(err).slice(0, 200)}`);
                    otpBaselineIds.set(email, new Set());
                    otpBaselineCodes.set(email, new Set());
                }
                clearRememberedVerificationCode(email);
            } else if (!otpStartTime.has(email)) {
                otpStartTime.set(email, Date.now() - 90_000);
            }

            let lastError = "";
            let lastReturnedCode = "";
            for (let attempt = 1; attempt <= HOTMAIL_POLL_ATTEMPTS; attempt += 1) {
                if (_abortController?.signal.aborted) {
                    throw new Error("Registration aborted by user");
                }

                console.log(
                    `pollHotmailOtp: attempt=${attempt}/${HOTMAIL_POLL_ATTEMPTS} mode=${resolveEffectiveMode(account)} targetEmail=${email} mailbox=${account.loginHint}`,
                );

                try {
                    const message = await getLatestVerificationMessage(email, account);
                    if (message?.verificationCode) {
                        const code = message.verificationCode;
                        const ageSec = message.timestamp
                            ? Math.round((Date.now() - Number(message.timestamp)) / 1000)
                            : -1;

                        // Hard cap: OpenAI OTPs expire quickly; anything older is almost certainly stale
                        if (ageSec >= 0 && ageSec > 15 * 60) {
                            console.log(
                                `hotmailOtpSkip: code=${code} too old ageSec=${ageSec} id=${message.id || ""}`,
                            );
                            markVerificationCodeRejected(email, code);
                            if (message.id) {
                                const ids = otpBaselineIds.get(email) || new Set();
                                ids.add(String(message.id));
                                otpBaselineIds.set(email, ids);
                            }
                        } else if (code === lastReturnedCode) {
                            console.log(`hotmailOtpSkip: already returned code=${code}, waiting for newer mail`);
                        } else {
                            console.log(
                                `hotmailOtpCode: ${code} folder=${message.folderId} ageSec=${ageSec} id=${message.id || ""} subject=${String(message.subject || "").slice(0, 60)}`,
                            );
                            lastReturnedCode = code;
                            return code;
                        }
                    }
                } catch (err) {
                    lastError = String(err);
                    console.log(`pollHotmailOtp error: ${lastError.slice(0, 200)}`);
                    await closeImapSession(account.loginHint);
                }

                if (attempt < HOTMAIL_POLL_ATTEMPTS) {
                    await sleepAbortable(HOTMAIL_POLL_INTERVAL_MS);
                }
            }

            clearOtpState(email);
            throw new Error(
                "Hotmail 中未找到验证码: targetEmail=" +
                    email +
                    (lastError ? ` lastError=${lastError.slice(0, 160)}` : ""),
            );
        },
        markVerificationCodeRejected(email, code) {
            markVerificationCodeRejected(email, code);
            // Also add to baseline so matcher skips it for this poll cycle
            const set = otpBaselineCodes.get(email) || new Set();
            set.add(String(code || "").replace(/\D/g, "").slice(0, 6));
            otpBaselineCodes.set(email, set);
            clearRememberedVerificationCode(email);
        },
        clearOtpPollState(email) {
            clearOtpState(email);
        },
        getAliasSuffix(): string {
            return currentAliasSuffix;
        },
        getRandomAliasEnabled(): boolean {
            return randomAliasEnabled;
        },
        setRandomAliasEnabled(enabled: boolean): void {
            randomAliasEnabled = !!enabled;
        },
        markEmailUsed(email: string): void {
            markEmailUsed(email);
        },
        isEmailUsed(email: string): boolean {
            return isEmailUsed(email);
        },
        clearUsedEmails(): void {
            clearUsedEmails();
        },
        clearAccountCache(): void {
            clearAccountCache();
        },
        createAbortController(): AbortController {
            return createAbortController();
        },
        abortRegistration(): void {
            abortRegistration();
        },
        getAbortSignal(): AbortSignal | undefined {
            return getAbortSignal();
        },
        getMailApiMode(): string {
            return mailApiMode;
        },
        setMailApiMode(mode: string): void {
            setMailApiMode(mode);
        },
        async setAliasSuffix(suffix: string): Promise<void> {
            currentAliasSuffix = String(suffix ?? "").trim();
            await writeFile(HOTMAIL_ALIAS_SUFFIX_FILE, currentAliasSuffix + "\n", "utf8");
        },
    };
}
