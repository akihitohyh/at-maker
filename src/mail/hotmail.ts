// @ts-nocheck
import {readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {generateEmailName} from "./generate-email-name.js";
import {findLatestVerificationMail} from "./verification-matcher.js";

const HOTMAIL_TOKEN_DIR = path.resolve(process.cwd(), process.env.HOTMAIL_DIR || "hotmail");
const HOTMAIL_TOKENS_FILE = path.join(HOTMAIL_TOKEN_DIR, "tokens.txt");
const HOTMAIL_GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const HOTMAIL_OAUTH_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const HOTMAIL_DEFAULT_SCOPE = "offline_access https://graph.microsoft.com/Mail.Read";
const HOTMAIL_DEFAULT_REDIRECT_URI = "";
const HOTMAIL_POLL_ATTEMPTS = 12;
const HOTMAIL_POLL_INTERVAL_MS = 5000;
const HOTMAIL_MESSAGE_FETCH_LIMIT = 10;
const HOTMAIL_FOLDER_IDS = ["inbox", "junkemail"];
const aliasAccountMap = new Map();
let accountCache = null;

function normalizeEmail(value) {
    return String(value ?? "").trim().toLowerCase();
}

function resolveApiMode(_account) {
    return "graph";  // Graph API only
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
    const expireAtMs = getTokenExpireAtMs(account);
    if (!expireAtMs) {
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
    // Graph scope FIRST (matches Python: offline_access https://graph.microsoft.com/Mail.Read)
    const variants = [
        {redirectUri: "", scope: HOTMAIL_DEFAULT_SCOPE},
        {redirectUri: "", scope: ""},
        {redirectUri, scope: HOTMAIL_DEFAULT_SCOPE},
        {redirectUri, scope: ""},
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

        const response = await fetch(HOTMAIL_OAUTH_TOKEN_URL, {
            method: "POST",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: body.toString(),
        });

        const rawBody = await response.text();
        if (!response.ok) {
            lastError = `redirect=${variant.redirectUri || "(empty)"} scope=${variant.scope || "(empty)"} status=${response.status} body=${rawBody}`;
            continue;
        }

        const payload = JSON.parse(rawBody);
        account.accessToken = String(payload?.access_token ?? "").trim();
        account.refreshToken = String(payload?.refresh_token ?? account.refreshToken).trim();
        account.idToken = String(payload?.id_token ?? account.idToken ?? "").trim();
        account.tokenType = String(payload?.token_type ?? account.tokenType ?? "Bearer").trim();
        account.scope = String(payload?.scope ?? variant.scope ?? account.scope).trim();
        account.redirectUri = variant.redirectUri || account.redirectUri || HOTMAIL_DEFAULT_REDIRECT_URI;
        account.expiresIn = Number(payload?.expires_in ?? account.expiresIn ?? 0);
        account.extExpiresIn = Number(payload?.ext_expires_in ?? account.extExpiresIn ?? 0);
        account.obtainedAt = new Date().toISOString();
        account.apiMode = resolveApiMode(account);

        await persistAccount(account);
        console.log(`hotmailTokenRefreshed: ${account.loginHint} mode=${account.apiMode} scope=${account.scope}`);
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

    let response = await fetch(url, {
        method: "GET",
        headers: buildAuthHeaders(account),
    });

    if (response.status === 401) {
        await refreshAccessToken(account);
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
    return accounts[Math.floor(Math.random() * accounts.length)];
}

function buildAliasAddress(account) {
    const mailbox = normalizeEmail(account.loginHint);
    const [localPart, domain] = mailbox.split("@");
    if (!localPart || !domain) {
        throw new Error(`Hotmail 邮箱格式不正确: ${account.loginHint}`);
    }
    return `${localPart}+${generateEmailName()}@${domain}`;
}

function normalizeRecipientList(recipients) {
    if (!Array.isArray(recipients)) {
        return [];
    }
    return recipients
        .map((item) => normalizeEmail(item?.EmailAddress?.Address ?? item?.emailAddress?.address ?? item?.address ?? ""))
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
        from: normalizeEmail(message?.From?.EmailAddress?.Address ?? message?.from?.emailAddress?.address ?? ""),
        toRecipients: normalizeRecipientList(message?.ToRecipients ?? message?.toRecipients),
        receivedDateTime: String(message?.ReceivedDateTime ?? message?.receivedDateTime ?? ""),
        receivedAtMs: Date.parse(String(message?.ReceivedDateTime ?? message?.receivedDateTime ?? "")) || 0,
        raw: message,
    };
}

async function listFolderMessages(account, folderId) {
    const url = new URL(`${HOTMAIL_GRAPH_BASE_URL}/me/mailFolders/${encodeURIComponent(folderId)}/messages`);
    url.searchParams.set("$top", String(HOTMAIL_MESSAGE_FETCH_LIMIT));
    url.searchParams.set("$orderby", "receivedDateTime desc");
    url.searchParams.set("$select", "subject,receivedDateTime,from,body,bodyPreview");

    const payload = await graphRequest(account, url);
    return Array.isArray(payload?.value)
        ? payload.value.map((item) => normalizeMessage(item, folderId))
        : [];
}

async function getLatestVerificationMessage(targetEmail, account, since) {
    const messages = [];

    for (const folderId of HOTMAIL_FOLDER_IDS) {
        const folderMessages = await listFolderMessages(account, folderId);
        messages.push(...folderMessages);
    }

    messages.sort((a, b) => b.receivedAtMs - a.receivedAtMs);

    console.log(`hotmailMessagesFetched: targetEmail=${targetEmail} mailbox=${account.loginHint} count=${messages.length}`);
    return findLatestVerificationMail(
        messages.map((message) => ({
            ...message,
            recipient: message.toRecipients,
            content: message.bodyContent,
            timestamp: message.receivedAtMs,
            extraTexts: [message.bodyPreview],
        })),
        {
            targetEmail,
            since,
            candidateMatcher: (mail) =>
                /(OpenAI|ChatGPT)/i.test(
                    `${mail.subject ?? ""}\n${mail.bodyPreview ?? ""}\n${mail.from ?? ""}`,
                ),
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
    const baseLocalPart = String(localPart ?? "").split("+")[0];

    const matched = accounts.find((account) => {
        const [accountLocalPart, accountDomain] = normalizeEmail(account.loginHint).split("@");
        return accountLocalPart === baseLocalPart && accountDomain === domain;
    });

    if (matched) {
        aliasAccountMap.set(normalizeEmail(email), matched);
        return matched;
    }

    throw new Error(`Hotmail 未找到与邮箱匹配的 token: ${email}`);
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
        async getEmailVerificationCode(email) {
            const account = await resolveAccountForEmail(email);
            const since = Date.now(); // 只看开始轮询后收到的邮件，避免读到旧验证码

            for (let attempt = 1; attempt <= HOTMAIL_POLL_ATTEMPTS; attempt += 1) {
                console.log(
                    `pollHotmailOtp: attempt=${attempt}/${HOTMAIL_POLL_ATTEMPTS} targetEmail=${email} mailbox=${account.loginHint}`,
                );

                const message = await getLatestVerificationMessage(email, account, since);
                if (message?.verificationCode) {
                    console.log(`hotmailOtpCode: ${message.verificationCode}`);
                    console.log(`hotmailOtpFolder: ${message.folderId}`);
                    return message.verificationCode;
                }

                if (attempt < HOTMAIL_POLL_ATTEMPTS) {
                    await new Promise((resolve) => setTimeout(resolve, HOTMAIL_POLL_INTERVAL_MS));
                }
            }

            throw new Error(`Hotmail 中未找到验证码: targetEmail=${email}`);
        },
    };
}
