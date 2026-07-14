/**
 * YYDS Mail provider — docs: YYDS Mail RESTful API
 * Base: https://maliapi.215.im/v1
 * Auth: X-API-Key: AC-...
 * Create: POST /accounts  or /accounts/wildcard
 * Poll OTP: GET /messages/next?address=&wait=30  (returns verificationCode)
 * Fallback: GET /messages?address= + body extract
 */
import {
    createAbortController as hotmailCreateAbort,
    abortRegistration as hotmailAbort,
    getAbortSignal as hotmailGetAbort,
} from "./hotmail.js";
import {generateEmailName} from "./generate-email-name.js";
import {
    findLatestVerificationMail,
    markVerificationCodeRejected as matcherReject,
    clearRememberedVerificationCode,
    clearRejectedVerificationCodes,
    type VerificationMailCandidate,
} from "./verification-matcher.js";
import type {EmailCodeProvider} from "../mailbox.js";

const DEFAULT_BASE = "https://maliapi.215.im/v1";
const POLL_ATTEMPTS = 24;
const POLL_WAIT_SEC = 15;

interface YydsSession {
    id: string;
    address: string;
    token: string;
    createdAt: number;
}

let apiKey = "";
let baseUrl = DEFAULT_BASE;
let preferredDomain = "";

const sessions = new Map<string, YydsSession>();
const otpSince = new Map<string, number>();
const baselineIds = new Map<string, Set<string>>();

export function setYydsConfig(opts: {
    apiKey?: string;
    baseUrl?: string;
    domain?: string;
}): void {
    if (opts.apiKey !== undefined) apiKey = String(opts.apiKey || "").trim();
    if (opts.baseUrl !== undefined) {
        baseUrl = String(opts.baseUrl || DEFAULT_BASE).trim().replace(/\/+$/, "") || DEFAULT_BASE;
    }
    if (opts.domain !== undefined) preferredDomain = String(opts.domain || "").trim();
}

export function getYydsConfig(): {apiKey: string; baseUrl: string; domain: string} {
    return {apiKey, baseUrl, domain: preferredDomain};
}

function keyOf(email: string): string {
    return String(email || "").trim().toLowerCase();
}

function requireKey(): string {
    if (!apiKey) {
        throw new Error("YYDS 需要 API Key（X-API-Key，通常以 AC- 开头）");
    }
    return apiKey;
}

async function sleepAbortable(ms: number): Promise<void> {
    const step = 250;
    for (let w = 0; w < ms; w += step) {
        if (hotmailGetAbort()?.aborted) {
            throw new Error("Registration aborted by user");
        }
        await new Promise((r) => setTimeout(r, Math.min(step, ms - w)));
    }
}

async function yydsFetch(
    path: string,
    init: {
        method?: string;
        body?: unknown;
        useTempToken?: string;
        timeoutMs?: number;
    } = {},
): Promise<{status: number; json: any; text: string}> {
    const headers: Record<string, string> = {
        accept: "application/json",
        "user-agent": "AT-Maker/0.1.0 YYDS",
    };
    if (init.useTempToken) {
        headers.authorization = `Bearer ${init.useTempToken}`;
    } else {
        headers["X-API-Key"] = requireKey();
    }
    if (init.body !== undefined) {
        headers["content-type"] = "application/json";
    }
    const resp = await fetch(`${baseUrl}${path}`, {
        method: init.method || (init.body !== undefined ? "POST" : "GET"),
        headers,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(init.timeoutMs ?? 45000),
    });
    const text = await resp.text();
    let json: any = null;
    if (text) {
        try {
            json = JSON.parse(text);
        } catch {
            json = null;
        }
    }
    return {status: resp.status, json, text};
}

async function listPublicDomains(): Promise<string[]> {
    try {
        const {status, json} = await yydsFetch("/domains");
        if (status >= 400) return [];
        const data = json?.data ?? json;
        const list = Array.isArray(data)
            ? data
            : Array.isArray(data?.domains)
              ? data.domains
              : [];
        const names: string[] = [];
        for (const item of list) {
            if (typeof item === "string") names.push(item);
            else if (item && typeof item === "object") {
                const d = String(item.domain || item.name || item.host || "").trim();
                if (d) names.push(d);
            }
        }
        return names;
    } catch {
        return [];
    }
}

async function createAccount(): Promise<YydsSession> {
    requireKey();
    const localPart = generateEmailName();
    let domain = preferredDomain;

    // Prefer wildcard auto-assign when no domain configured
    if (!domain) {
        console.log("yyds: creating via /accounts/wildcard ...");
        const r = await yydsFetch("/accounts/wildcard", {
            method: "POST",
            body: {localPart},
        });
        if (r.status < 300 && r.json?.success !== false) {
            const d = r.json?.data || r.json;
            const address = String(d?.address || "").trim();
            const token = String(d?.token || "").trim();
            const id = String(d?.id || "").trim();
            if (address && token) {
                return {id, address, token, createdAt: Date.now()};
            }
        }
        console.log(
            `yyds wildcard create failed status=${r.status} body=${r.text.slice(0, 160)}`,
        );
        const domains = await listPublicDomains();
        domain = domains[0] || "";
        if (!domain) {
            throw new Error(
                "YYDS 创建邮箱失败：未配置 domain，且无法自动获取可用域名。请在配置中填写 yydsDomain",
            );
        }
    }

    console.log(`yyds: creating account localPart=${localPart} domain=${domain}`);
    const r = await yydsFetch("/accounts", {
        method: "POST",
        body: {localPart, domain},
    });
    if (r.status >= 400 || r.json?.success === false) {
        throw new Error(
            `YYDS 创建邮箱失败 HTTP ${r.status}: ${(r.json?.error || r.text || "").toString().slice(0, 200)}`,
        );
    }
    const d = r.json?.data || r.json;
    const address = String(d?.address || "").trim();
    const token = String(d?.token || "").trim();
    const id = String(d?.id || "").trim();
    if (!address || !token) {
        throw new Error(`YYDS 创建响应缺少 address/token: ${r.text.slice(0, 200)}`);
    }
    return {id, address, token, createdAt: Date.now()};
}

async function pollNextMessage(
    session: YydsSession,
): Promise<{code: string; subject?: string} | null> {
    // Preferred OTP path — server extracts verificationCode
    const q = new URLSearchParams({
        address: session.address,
        wait: String(POLL_WAIT_SEC),
    });
    const r = await yydsFetch(`/messages/next?${q.toString()}`, {
        useTempToken: session.token,
        timeoutMs: (POLL_WAIT_SEC + 10) * 1000,
    });
    if (r.status === 204) return null;
    if (r.status >= 400) {
        // Fallback without temp token (API key)
        const r2 = await yydsFetch(`/messages/next?${q.toString()}`, {
            timeoutMs: (POLL_WAIT_SEC + 10) * 1000,
        });
        if (r2.status === 204) return null;
        if (r2.status >= 400) {
            throw new Error(
                `YYDS messages/next HTTP ${r2.status}: ${r2.text.slice(0, 160)}`,
            );
        }
        return extractFromNext(r2.json);
    }
    return extractFromNext(r.json);
}

function extractFromNext(json: any): {code: string; subject?: string} | null {
    const msg = json?.data?.message || json?.message || json?.data;
    if (!msg) return null;
    const code = String(msg.verificationCode || msg.verification_code || "").trim();
    if (code) {
        return {code, subject: msg.subject};
    }
    // Fallback extract from body
    const candidate: VerificationMailCandidate = {
        id: String(msg.id || ""),
        sender:
            typeof msg.from === "object"
                ? String(msg.from?.address || "")
                : String(msg.from || ""),
        subject: String(msg.subject || ""),
        content: [
            String(msg.text || ""),
            Array.isArray(msg.html) ? msg.html.join("\n") : String(msg.html || ""),
        ].join("\n"),
        timestamp: msg.createdAt ? Date.parse(msg.createdAt) || Date.now() : Date.now(),
    };
    const hit = findLatestVerificationMail([candidate], {});
    if (hit?.verificationCode) {
        return {code: hit.verificationCode, subject: hit.subject};
    }
    return null;
}

async function listMessagesFallback(session: YydsSession): Promise<VerificationMailCandidate[]> {
    const q = new URLSearchParams({
        address: session.address,
        limit: "20",
        seen: "false",
    });
    const r = await yydsFetch(`/messages?${q.toString()}`, {
        useTempToken: session.token,
    });
    if (r.status >= 400) {
        const r2 = await yydsFetch(`/messages?${q.toString()}`);
        if (r2.status >= 400) {
            throw new Error(`YYDS messages HTTP ${r2.status}: ${r2.text.slice(0, 160)}`);
        }
        return mapMessages(r2.json);
    }
    return mapMessages(r.json);
}

function mapMessages(json: any): VerificationMailCandidate[] {
    const data = json?.data || json;
    const list = Array.isArray(data?.messages)
        ? data.messages
        : Array.isArray(data)
          ? data
          : [];
    return list.map((m: any) => ({
        id: String(m.id || ""),
        sender:
            typeof m.from === "object"
                ? String(m.from?.address || "")
                : String(m.from || ""),
        recipient: Array.isArray(m.to)
            ? m.to.map((t: any) => (typeof t === "object" ? t.address : t))
            : m.to,
        subject: String(m.subject || ""),
        content: [
            String(m.text || m.body || ""),
            Array.isArray(m.html) ? m.html.join("\n") : String(m.html || ""),
            String(m.verificationCode || ""),
        ].join("\n"),
        timestamp: m.createdAt ? Date.parse(m.createdAt) || Date.now() : Date.now(),
        extraTexts: [String(m.verificationCode || "")],
    }));
}

export function createYydsProvider(): EmailCodeProvider {
    return {
        async getEmailAddress() {
            const session = await createAccount();
            sessions.set(keyOf(session.address), session);
            console.log(`registerEmail(yyds): ${session.address}`);
            return session.address;
        },

        async prepareOtpBaseline(email) {
            const k = keyOf(email);
            otpSince.set(k, Date.now() - 5000);
            clearRememberedVerificationCode(email);
            clearRejectedVerificationCodes(email);
            const seen = new Set<string>();
            const session = sessions.get(k);
            if (session) {
                try {
                    const mails = await listMessagesFallback(session);
                    for (const m of mails) {
                        if (m.id) seen.add(m.id);
                    }
                } catch (err) {
                    console.log(`yyds baseline warn: ${String(err).slice(0, 160)}`);
                }
            }
            baselineIds.set(k, seen);
            console.log(`yyds baseline: email=${email} seen=${seen.size}`);
            return true;
        },

        async getEmailVerificationCode(email) {
            const k = keyOf(email);
            const session = sessions.get(k);
            if (!session) {
                throw new Error(`YYDS 会话不存在: ${email}`);
            }
            if (!otpSince.has(k)) {
                otpSince.set(k, Date.now() - 120_000);
            }
            const since = otpSince.get(k) || 0;
            const seen = baselineIds.get(k) || new Set();

            let lastError = "";
            for (let attempt = 1; attempt <= POLL_ATTEMPTS; attempt += 1) {
                if (hotmailGetAbort()?.aborted) {
                    throw new Error("Registration aborted by user");
                }
                console.log(
                    `pollYydsOtp: attempt=${attempt}/${POLL_ATTEMPTS} email=${email}`,
                );
                try {
                    // Prefer atomic next+code
                    const next = await pollNextMessage(session);
                    if (next?.code) {
                        console.log(
                            `yydsOtpCode: ${next.code} subject=${String(next.subject || "").slice(0, 60)}`,
                        );
                        return next.code;
                    }
                    // Fallback list+extract
                    const mails = await listMessagesFallback(session);
                    const hit = findLatestVerificationMail(mails, {
                        targetEmail: email,
                        since,
                        seenIds: seen,
                    });
                    if (hit?.verificationCode) {
                        console.log(
                            `yydsOtpCode(fallback): ${hit.verificationCode} subject=${String(hit.subject || "").slice(0, 60)}`,
                        );
                        return hit.verificationCode;
                    }
                } catch (err) {
                    lastError = String(err);
                    console.log(`pollYydsOtp error: ${lastError.slice(0, 200)}`);
                    // brief pause on error before retry
                    await sleepAbortable(2000);
                }
            }
            throw new Error(
                `YYDS 未找到验证码: ${email}${lastError ? ` lastError=${lastError.slice(0, 160)}` : ""}`,
            );
        },

        markVerificationCodeRejected(email, code) {
            matcherReject(email, code);
        },
        clearOtpPollState(email) {
            const k = keyOf(email);
            baselineIds.delete(k);
            otpSince.delete(k);
            clearRememberedVerificationCode(email);
        },
        getAliasSuffix: () => "",
        async setAliasSuffix() {},
        getRandomAliasEnabled: () => false,
        setRandomAliasEnabled() {},
        getMailApiMode: () => "auto",
        setMailApiMode() {},
        markEmailUsed() {},
        clearUsedEmails() {},
        clearAccountCache() {
            sessions.clear();
            baselineIds.clear();
            otpSince.clear();
        },
        createAbortController: hotmailCreateAbort,
        abortRegistration: hotmailAbort,
        getAbortSignal: hotmailGetAbort,
    };
}
