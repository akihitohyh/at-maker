/**
 * TempMail.lol provider — https://tempmail.lol/zh/api
 * API: https://api.tempmail.lol/v2
 *   POST /inbox/create  → { address, token }
 *   GET  /inbox?token=  → { emails, expired? }
 */
import {
    createAbortController as hotmailCreateAbort,
    abortRegistration as hotmailAbort,
    getAbortSignal as hotmailGetAbort,
} from "./hotmail.js";
import {
    findLatestVerificationMail,
    markVerificationCodeRejected as matcherReject,
    clearRememberedVerificationCode,
    clearRejectedVerificationCodes,
    type VerificationMailCandidate,
} from "./verification-matcher.js";
import type {EmailCodeProvider} from "../mailbox.js";

const BASE_URL = "https://api.tempmail.lol/v2";
const POLL_ATTEMPTS = 30;
const POLL_INTERVAL_MS = 4000;

interface InboxSession {
    address: string;
    token: string;
    createdAt: number;
}

interface TempMailEmail {
    from?: string;
    to?: string;
    subject?: string;
    body?: string;
    html?: string | null;
    date?: number;
    ip?: string;
}

let apiKey = "";
const sessions = new Map<string, InboxSession>(); // email lower → session
const baselineIds = new Map<string, Set<string>>();
const otpSince = new Map<string, number>();

export function setTempMailApiKey(key: string): void {
    apiKey = String(key || "").trim();
}

export function getTempMailApiKey(): string {
    return apiKey;
}

function keyOf(email: string): string {
    return String(email || "").trim().toLowerCase();
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

async function apiRequest(
    path: string,
    init: {method?: string; body?: unknown} = {},
): Promise<unknown> {
    const headers: Record<string, string> = {
        accept: "application/json",
        "user-agent": "AT-Maker/0.1.0 TempMail",
    };
    if (apiKey) {
        headers.authorization = `Bearer ${apiKey}`;
    }
    if (init.body !== undefined) {
        headers["content-type"] = "application/json";
    }
    const resp = await fetch(`${BASE_URL}${path}`, {
        method: init.method || (init.body !== undefined ? "POST" : "GET"),
        headers,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(30000),
    });
    const text = await resp.text();
    if (!resp.ok) {
        throw new Error(`TempMail HTTP ${resp.status}: ${text.slice(0, 240)}`);
    }
    if (!text) return {};
    try {
        return JSON.parse(text);
    } catch {
        throw new Error(`TempMail 响应非 JSON: ${text.slice(0, 120)}`);
    }
}

async function createInbox(): Promise<InboxSession> {
    // Free tier: empty body; Plus can pass domain/prefix via future config
    const data = (await apiRequest("/inbox/create", {
        method: "POST",
        body: {},
    })) as {address?: string; token?: string};
    const address = String(data.address || "").trim();
    const token = String(data.token || "").trim();
    if (!address || !token) {
        throw new Error(`TempMail 创建邮箱失败: ${JSON.stringify(data).slice(0, 200)}`);
    }
    return {address, token, createdAt: Date.now()};
}

async function listEmails(token: string): Promise<TempMailEmail[]> {
    const data = (await apiRequest(`/inbox?token=${encodeURIComponent(token)}`)) as {
        emails?: TempMailEmail[];
        expired?: boolean;
    };
    if (data.expired) {
        throw new Error("TempMail 收件箱已过期");
    }
    return Array.isArray(data.emails) ? data.emails : [];
}

function toCandidates(emails: TempMailEmail[]): VerificationMailCandidate[] {
    return emails.map((e, i) => ({
        id: `${e.date || 0}-${e.from || ""}-${i}-${String(e.subject || "").slice(0, 40)}`,
        sender: e.from || "",
        recipient: e.to || "",
        subject: e.subject || "",
        content: [e.body || "", e.html || ""].filter(Boolean).join("\n"),
        timestamp: Number(e.date || 0) || Date.now(),
        extraTexts: [e.body || "", e.html || "", e.subject || ""],
    }));
}

export function createTempMailProvider(): EmailCodeProvider {
    return {
        async getEmailAddress() {
            console.log(
                `tempmail: creating inbox${apiKey ? " (with API key)" : " (free tier)"}...`,
            );
            const session = await createInbox();
            sessions.set(keyOf(session.address), session);
            console.log(`registerEmail(tempmail): ${session.address}`);
            return session.address;
        },

        async prepareOtpBaseline(email) {
            const k = keyOf(email);
            const session = sessions.get(k);
            otpSince.set(k, Date.now() - 5000);
            clearRememberedVerificationCode(email);
            clearRejectedVerificationCodes(email);
            const seen = new Set<string>();
            if (session) {
                try {
                    const emails = await listEmails(session.token);
                    for (const c of toCandidates(emails)) {
                        if (c.id) seen.add(c.id);
                    }
                } catch (err) {
                    console.log(`tempmail baseline warn: ${String(err).slice(0, 160)}`);
                }
            }
            baselineIds.set(k, seen);
            console.log(`tempmail baseline: email=${email} seen=${seen.size}`);
            return true;
        },

        async getEmailVerificationCode(email) {
            const k = keyOf(email);
            const session = sessions.get(k);
            if (!session) {
                throw new Error(`TempMail 会话不存在: ${email}`);
            }
            if (!otpSince.has(k)) {
                otpSince.set(k, Date.now() - 120_000);
                baselineIds.set(k, baselineIds.get(k) || new Set());
            }
            const since = otpSince.get(k) || 0;
            const seen = baselineIds.get(k) || new Set();

            let lastError = "";
            for (let attempt = 1; attempt <= POLL_ATTEMPTS; attempt += 1) {
                if (hotmailGetAbort()?.aborted) {
                    throw new Error("Registration aborted by user");
                }
                console.log(
                    `pollTempMailOtp: attempt=${attempt}/${POLL_ATTEMPTS} email=${email}`,
                );
                try {
                    const emails = await listEmails(session.token);
                    const hit = findLatestVerificationMail(toCandidates(emails), {
                        targetEmail: email,
                        since,
                        seenIds: seen,
                    });
                    if (hit?.verificationCode) {
                        console.log(
                            `tempmailOtpCode: ${hit.verificationCode} subject=${String(hit.subject || "").slice(0, 60)}`,
                        );
                        return hit.verificationCode;
                    }
                } catch (err) {
                    lastError = String(err);
                    console.log(`pollTempMailOtp error: ${lastError.slice(0, 200)}`);
                }
                if (attempt < POLL_ATTEMPTS) {
                    await sleepAbortable(POLL_INTERVAL_MS);
                }
            }
            throw new Error(
                `TempMail 未找到验证码: ${email}${lastError ? ` lastError=${lastError.slice(0, 160)}` : ""}`,
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
