export interface VerificationMailCandidate {
    id?: string;
    sender?: string;
    recipient?: string | string[];
    subject?: string;
    content?: string;
    timestamp?: number;
    extraTexts?: string[];
}

interface FindVerificationMailOptions<T> {
    targetEmail?: string;
    /** Only accept mails received at/after this unix ms timestamp */
    since?: number;
    /** Skip these codes (already used / rejected / baseline) */
    rejectedCodes?: ReadonlySet<string> | string[];
    /** Skip these message ids (already present before OTP send) */
    seenIds?: ReadonlySet<string> | string[];
    candidateMatcher?: (mail: T) => boolean;
    rememberLastCode?: boolean;
}

const lastVerificationCodeByEmail = new Map<string, string>();
/** Codes rejected by OpenAI or pre-existing before OTP send */
const rejectedCodesByEmail = new Map<string, Set<string>>();

export function normalizeMailbox(value: string): string {
    const input = String(value ?? "").trim().toLowerCase();
    const angleMatch = input.match(/<([^>]+)>/);
    return (angleMatch?.[1] ?? input).trim();
}

/** Strip +alias so user+foo@x.com matches user@x.com base mailbox */
export function baseMailbox(value: string): string {
    const normalized = normalizeMailbox(value);
    const at = normalized.indexOf("@");
    if (at < 0) return normalized;
    const local = normalized.slice(0, at).split("+")[0];
    const domain = normalized.slice(at + 1);
    return `${local}@${domain}`;
}

/**
 * Decode quoted-printable to UTF-8 text.
 * Must accumulate raw bytes then Buffer.toString("utf8") — per-byte fromCharCode
 * breaks multi-byte Chinese sequences in OpenAI CN OTP mails.
 */
export function decodeQuotedPrintable(input: string): string {
    const s = String(input ?? "").replace(/=\r?\n/g, "");
    const bytes: number[] = [];
    for (let i = 0; i < s.length; i++) {
        if (s[i] === "=" && /[0-9A-Fa-f]{2}/.test(s.slice(i + 1, i + 3))) {
            bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
            i += 2;
        } else {
            bytes.push(s.charCodeAt(i) & 0xff);
        }
    }
    try {
        return Buffer.from(bytes).toString("utf8");
    } catch {
        return String.fromCharCode(...bytes);
    }
}

/**
 * Extract usable text from a raw RFC822 source:
 * - drop headers
 * - decode quoted-printable / base64 text parts when possible
 * - strip HTML tags
 */
export function extractMailTextContent(raw: string): string {
    const source = String(raw ?? "");
    if (!source) return "";

    // Split headers / body
    const splitIdx = source.search(/\r?\n\r?\n/);
    const headers = splitIdx >= 0 ? source.slice(0, splitIdx) : "";
    let body = splitIdx >= 0 ? source.slice(splitIdx).replace(/^\r?\n\r?\n/, "") : source;

    const contentType = /content-type:\s*([^\r\n;]+)/i.exec(headers)?.[1]?.toLowerCase() ?? "";
    const transferEncoding =
        /content-transfer-encoding:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim().toLowerCase() ?? "";

    // Multipart: walk parts recursively (simple splitter)
    if (contentType.includes("multipart") || /boundary=/i.test(headers) || /boundary=/i.test(source.slice(0, 2000))) {
        const boundaryMatch =
            /boundary="?([^";\r\n]+)"?/i.exec(headers) ||
            /boundary="?([^";\r\n]+)"?/i.exec(source.slice(0, 4000));
        if (boundaryMatch?.[1]) {
            const boundary = boundaryMatch[1].trim();
            const parts = source.split(new RegExp(`--${escapeRegExp(boundary)}(?:--)?`));
            const texts: string[] = [];
            for (const part of parts) {
                if (!part || !part.includes("Content-Type") && !part.includes("content-type")) {
                    // still try
                }
                const pSplit = part.search(/\r?\n\r?\n/);
                if (pSplit < 0) continue;
                const pHeaders = part.slice(0, pSplit);
                let pBody = part.slice(pSplit).replace(/^\r?\n\r?\n/, "");
                const pType = /content-type:\s*([^\r\n;]+)/i.exec(pHeaders)?.[1]?.toLowerCase() ?? "";
                if (pType.includes("multipart")) {
                    texts.push(extractMailTextContent(part));
                    continue;
                }
                if (!pType.includes("text/plain") && !pType.includes("text/html") && pType) {
                    continue;
                }
                const pEnc =
                    /content-transfer-encoding:\s*([^\r\n]+)/i.exec(pHeaders)?.[1]?.trim().toLowerCase() ??
                    "";
                if (pEnc === "base64") {
                    try {
                        pBody = Buffer.from(pBody.replace(/\s+/g, ""), "base64").toString("utf8");
                    } catch {
                        /* keep */
                    }
                } else if (pEnc === "quoted-printable") {
                    pBody = decodeQuotedPrintable(pBody);
                } else {
                    // OpenAI often QP without declaring clearly — try soft decode always
                    pBody = decodeQuotedPrintable(pBody);
                }
                texts.push(pBody);
            }
            if (texts.length) {
                body = texts.join("\n");
            }
        }
    } else {
        if (transferEncoding === "base64") {
            try {
                body = Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
            } catch {
                /* keep */
            }
        } else {
            body = decodeQuotedPrintable(body);
        }
    }

    // Also QP-decode whole source as fallback (helps when boundary parse fails)
    const qpWhole = decodeQuotedPrintable(source);
    const combined = `${body}\n${qpWhole}`;

    return normalizeTextForCodeMatching(combined);
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeTextForCodeMatching(text: string): string {
    return String(text ?? "")
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&#(\d+);/g, (_, codePoint) => String.fromCharCode(Number(codePoint)))
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, " ")
        .trim();
}

function normalizeSixDigitCode(value: string | undefined): string {
    const digitsOnly = String(value ?? "").replace(/\D/g, "");
    return digitsOnly.length === 6 ? digitsOnly : "";
}

/**
 * Bare 6-digit sequences that look like dates/years/server host fragments.
 */
function looksLikeJunkCode(code: string): boolean {
    if (!/^\d{6}$/.test(code)) return true;
    // YYYYMM 202001-203912
    if (/^20[2-3]\d(0[1-9]|1[0-2])$/.test(code)) return true;
    // Year-prefixed 2020-2039xxxxxx
    if (/^20[2-3]\d\d\d$/.test(code)) return true;
    // Common tracking / header noise
    if (/^12000\d$/.test(code)) return true;
    if (/^000000$|^123456$|^111111$/.test(code)) return true;
    return false;
}

/**
 * Prefer extracting from HTML/text body parts only — raw RFC822 headers contain
 * many 6-digit noise values (server host fragments, timestamps).
 */
function bodyOnlyForCodeExtraction(text: string): string {
    const source = String(text ?? "");
    // If it looks like full RFC822, strip headers for weak matching
    const splitIdx = source.search(/\r?\n\r?\n/);
    if (splitIdx > 0 && /^(?:Return-Path|Received|From|To|Subject|MIME-Version|Content-Type):/im.test(source.slice(0, 200))) {
        // Use extractMailTextContent path when possible (already decoded body preferred)
        return extractMailTextContent(source);
    }
    return normalizeTextForCodeMatching(decodeQuotedPrintable(source));
}

function extractVerificationCode(text: string, {allowWeak = true}: {allowWeak?: boolean} = {}): string {
    // Prefer properly decoded body (UTF-8 QP) so Chinese OpenAI templates match
    const raw = bodyOnlyForCodeExtraction(text);
    if (!raw) {
        return "";
    }

    // Strong context — EN + CN OpenAI templates
    // e.g. "你的 ChatGPT 临时验证码： 151057 如果"
    const contextPatterns = [
        /(?:验证码|校[验核]码|动态码|临时验证码)[^\d]{0,24}((?:\d[\s-]*){6})/i,
        /((?:\d[\s-]*){6})[^\d]{0,24}(?:验证码|校[验核]码)/i,
        /ChatGPT[^\d]{0,40}((?:\d[\s-]*){6})/i,
        /(?:one[-\s]?time|otp|security|verification|login|sign[-\s]?in)?\s*code[:\s]+((?:\d[\s-]*){6})\b/i,
        /((?:\d[\s-]*){6})(?=.{0,40}\b(?:is your|your code|verification code|security code)\b)/i,
        /(?:OpenAI|ChatGPT|verification|security|login|sign[-\s]?in|code).{0,80}?((?:\d[\s-]*){6})/i,
        /(?:继续|continue)[：:\s]*((?:\d[\s-]*){6})/i,
        /[：:\s]((?:\d[\s-]*){6})(?:\s*(?:如果|if|expires|有效))/i,
    ];
    for (const pattern of contextPatterns) {
        const matched = raw.match(pattern);
        const code = normalizeSixDigitCode(matched?.[1]);
        if (code && !looksLikeJunkCode(code)) {
            return code;
        }
    }

    if (!allowWeak) {
        return "";
    }

    // Weak: only non-junk 6-digit from decoded body (headers already stripped)
    const all = [...raw.matchAll(/\b(\d{6})\b/g)].map((m) => m[1]).filter(Boolean);
    for (const candidate of all) {
        if (!looksLikeJunkCode(candidate)) {
            return candidate;
        }
    }

    return "";
}

function normalizeRecipientList(recipient: string | string[] | undefined): string[] {
    if (Array.isArray(recipient)) {
        return recipient
            .map((item) => normalizeMailbox(item))
            .filter(Boolean);
    }
    const normalized = normalizeMailbox(recipient ?? "");
    return normalized ? [normalized] : [];
}

function recipientsMatchTarget(targetEmail: string, recipient: string | string[] | undefined): boolean {
    if (!targetEmail) return true;
    const recipients = normalizeRecipientList(recipient);
    if (recipients.length === 0) return true;
    if (recipients.includes(targetEmail)) return true;

    const targetBase = baseMailbox(targetEmail);
    return recipients.some((r) => baseMailbox(r) === targetBase);
}

function collectCandidateTexts(mail: VerificationMailCandidate): string[] {
    // Prefer decoded body; subject often has no code for OpenAI CN mails
    const texts = [
        mail.content ?? "",
        mail.subject ?? "",
        ...(mail.extraTexts ?? []),
    ];
    return texts
        .map((item) => String(item ?? "").trim())
        .filter(Boolean);
}

function toSet(value: ReadonlySet<string> | string[] | undefined): Set<string> {
    if (!value) return new Set();
    if (value instanceof Set) return value;
    return new Set(value);
}

function isCodeRejected(email: string, code: string, extra?: ReadonlySet<string> | string[]): boolean {
    if (!code) return true;
    if (extra && toSet(extra).has(code)) return true;
    const set = rejectedCodesByEmail.get(normalizeMailbox(email));
    return !!(set && set.has(code));
}

export function markVerificationCodeRejected(email: string, code: string): void {
    const key = normalizeMailbox(email);
    if (!key || !code) return;
    let set = rejectedCodesByEmail.get(key);
    if (!set) {
        set = new Set();
        rejectedCodesByEmail.set(key, set);
    }
    set.add(String(code).replace(/\D/g, "").slice(0, 6));
    if (lastVerificationCodeByEmail.get(key) === code) {
        lastVerificationCodeByEmail.delete(key);
    }
    console.log(`[otp] rejected code=${code} email=${key} (total rejected=${set.size})`);
}

export function getRejectedVerificationCodes(email: string): Set<string> {
    return rejectedCodesByEmail.get(normalizeMailbox(email)) ?? new Set();
}

/** Extract all plausible OTP codes from a mail (for baseline blacklisting). */
export function extractAllVerificationCodes(mail: VerificationMailCandidate): string[] {
    const found = new Set<string>();
    for (const text of collectCandidateTexts(mail)) {
        const strong = extractVerificationCode(text, {allowWeak: false});
        if (strong) found.add(strong);
        const weak = extractVerificationCode(text, {allowWeak: true});
        if (weak) found.add(weak);
    }
    return [...found];
}

export function findLatestVerificationMail<T extends VerificationMailCandidate>(
    mails: T[],
    options: FindVerificationMailOptions<T> = {},
): (T & { verificationCode: string }) | null {
    const targetEmail = normalizeMailbox(options.targetEmail ?? "");
    const previousCode = targetEmail ? lastVerificationCodeByEmail.get(targetEmail) ?? "" : "";
    const since = Number(options.since ?? 0) || 0;
    // Allow 2 min skew: OTP may arrive slightly before local "send" timestamp
    const sinceFloor = since > 0 ? since - 120_000 : 0;
    const seenIds = toSet(options.seenIds);
    const rejectedExtra = toSet(options.rejectedCodes);

    const sorted = [...mails].sort(
        (left, right) => Number(right.timestamp ?? 0) - Number(left.timestamp ?? 0),
    );

    for (const mail of sorted) {
        const ts = Number(mail.timestamp ?? 0) || 0;
        const id = String(mail.id ?? "");

        if (sinceFloor > 0) {
            // If timestamp missing, still allow (IMAP envelope sometimes empty)
            if (ts > 0 && ts < sinceFloor) {
                continue;
            }
        }

        if (id && seenIds.has(id)) {
            continue;
        }

        if (targetEmail && !recipientsMatchTarget(targetEmail, mail.recipient)) {
            continue;
        }

        if (options.candidateMatcher && !options.candidateMatcher(mail)) {
            continue;
        }

        let verificationCode = "";
        for (const text of collectCandidateTexts(mail)) {
            verificationCode = extractVerificationCode(text, {allowWeak: false});
            if (verificationCode) break;
        }
        if (!verificationCode) {
            for (const text of collectCandidateTexts(mail)) {
                verificationCode = extractVerificationCode(text, {allowWeak: true});
                if (verificationCode) break;
            }
        }

        if (!verificationCode) {
            continue;
        }

        if (previousCode && verificationCode === previousCode) {
            continue;
        }

        if (targetEmail && isCodeRejected(targetEmail, verificationCode, rejectedExtra)) {
            continue;
        }

        const matchedMail = {
            ...mail,
            verificationCode,
        };
        if (targetEmail && options.rememberLastCode !== false) {
            lastVerificationCodeByEmail.set(targetEmail, verificationCode);
        }
        return matchedMail;
    }

    return null;
}

export function clearRememberedVerificationCode(email?: string): void {
    if (!email) {
        lastVerificationCodeByEmail.clear();
        return;
    }
    lastVerificationCodeByEmail.delete(normalizeMailbox(email));
}

export function clearRejectedVerificationCodes(email?: string): void {
    if (!email) {
        rejectedCodesByEmail.clear();
        return;
    }
    rejectedCodesByEmail.delete(normalizeMailbox(email));
}
