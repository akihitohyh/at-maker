/**
 * chatgpt2api client — test connection + upload AT/RT after registration.
 * Prefer full RT (codex) payload; fall back to bare access_token list.
 */

export interface Chatgpt2ApiEndpoint {
    baseUrl: string;
    authKey: string;
}

export interface UploadAccountInput {
    accessToken: string;
    /** Platform OAuth AT when RT flow succeeded (preferred for codex) */
    platformAccessToken?: string;
    refreshToken?: string;
    idToken?: string;
    email?: string;
    password?: string;
}

export interface ConnectionTestResult {
    ok: boolean;
    error?: string;
    accountCount?: number;
    status?: number;
}

export interface UploadResult {
    ok: boolean;
    mode: "rt" | "at";
    added?: number;
    skipped?: number;
    refreshed?: number;
    error?: string;
    status?: number;
}

function normalizeBaseUrl(baseUrl: string): string {
    return String(baseUrl || "")
        .trim()
        .replace(/\/+$/, "");
}

function isConfigured(endpoint: Chatgpt2ApiEndpoint): boolean {
    return Boolean(normalizeBaseUrl(endpoint.baseUrl) && String(endpoint.authKey || "").trim());
}

async function requestJson(
    endpoint: Chatgpt2ApiEndpoint,
    method: string,
    pathName: string,
    body?: unknown,
    timeoutMs = 30000,
): Promise<{status: number; json: unknown; text: string}> {
    const base = normalizeBaseUrl(endpoint.baseUrl);
    const key = String(endpoint.authKey || "").trim();
    if (!base || !key) {
        throw new Error("chatgpt2api 地址或鉴权 key 未配置");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(`${base}${pathName}`, {
            method,
            headers: {
                authorization: `Bearer ${key}`,
                accept: "application/json",
                ...(body !== undefined ? {"content-type": "application/json"} : {}),
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: controller.signal,
        });
        const text = await response.text();
        let json: unknown = null;
        if (text) {
            try {
                json = JSON.parse(text);
            } catch {
                json = null;
            }
        }
        return {status: response.status, json, text};
    } finally {
        clearTimeout(timer);
    }
}

/** GET /api/accounts — admin-only, proves baseUrl + auth key work. */
export async function testChatgpt2ApiConnection(
    endpoint: Chatgpt2ApiEndpoint,
): Promise<ConnectionTestResult> {
    if (!isConfigured(endpoint)) {
        return {ok: false, error: "请填写 chatgpt2api 地址和鉴权 key"};
    }
    try {
        const {status, json, text} = await requestJson(
            endpoint,
            "GET",
            "/api/accounts",
            undefined,
            15000,
        );
        if (status === 401 || status === 403) {
            return {ok: false, status, error: `鉴权失败 HTTP ${status}`};
        }
        if (status < 200 || status >= 300) {
            return {
                ok: false,
                status,
                error: `HTTP ${status}: ${text.slice(0, 160) || "无响应体"}`,
            };
        }
        const items = (json as {items?: unknown})?.items;
        const accountCount = Array.isArray(items) ? items.length : undefined;
        return {ok: true, status, accountCount};
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/aborted|timeout|Timeout/i.test(msg)) {
            return {ok: false, error: `连接超时: ${msg}`};
        }
        return {ok: false, error: `连接失败: ${msg}`};
    }
}

/**
 * Upload one account. Prefer RT full payload; else bare AT.
 * chatgpt2api: POST /api/accounts
 */
export async function uploadAccountToChatgpt2Api(
    endpoint: Chatgpt2ApiEndpoint,
    account: UploadAccountInput,
): Promise<UploadResult> {
    const accessToken = String(account.accessToken || "").trim();
    const platformAt = String(account.platformAccessToken || "").trim();
    const refreshToken = String(account.refreshToken || "").trim();
    const idToken = String(account.idToken || "").trim();
    const email = String(account.email || "").trim();
    const password = String(account.password || "").trim();

    if (!accessToken && !platformAt) {
        return {ok: false, mode: "at", error: "缺少 access_token"};
    }

    // Prefer RT path when refresh_token is present
    if (refreshToken) {
        const tokenForPool = platformAt || accessToken;
        const body = {
            accounts: [
                {
                    type: "codex",
                    email,
                    password,
                    access_token: tokenForPool,
                    refresh_token: refreshToken,
                    id_token: idToken,
                    source_type: "codex",
                },
            ],
        };
        try {
            const {status, json, text} = await requestJson(
                endpoint,
                "POST",
                "/api/accounts",
                body,
                60000,
            );
            if (status < 200 || status >= 300) {
                return {
                    ok: false,
                    mode: "rt",
                    status,
                    error: `HTTP ${status}: ${text.slice(0, 200) || "upload failed"}`,
                };
            }
            const result = (json || {}) as {
                added?: number;
                skipped?: number;
                refreshed?: number;
                errors?: unknown[];
            };
            const errors = Array.isArray(result.errors) ? result.errors : [];
            if (errors.length > 0 && !result.added && !result.skipped) {
                return {
                    ok: false,
                    mode: "rt",
                    status,
                    error: JSON.stringify(errors).slice(0, 200),
                };
            }
            return {
                ok: true,
                mode: "rt",
                status,
                added: Number(result.added || 0),
                skipped: Number(result.skipped || 0),
                refreshed: Number(result.refreshed || 0),
            };
        } catch (err) {
            return {
                ok: false,
                mode: "rt",
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }

    // AT-only fallback
    const body = {tokens: [accessToken || platformAt]};
    try {
        const {status, json, text} = await requestJson(
            endpoint,
            "POST",
            "/api/accounts",
            body,
            60000,
        );
        if (status < 200 || status >= 300) {
            return {
                ok: false,
                mode: "at",
                status,
                error: `HTTP ${status}: ${text.slice(0, 200) || "upload failed"}`,
            };
        }
        const result = (json || {}) as {
            added?: number;
            skipped?: number;
            refreshed?: number;
        };
        return {
            ok: true,
            mode: "at",
            status,
            added: Number(result.added || 0),
            skipped: Number(result.skipped || 0),
            refreshed: Number(result.refreshed || 0),
        };
    } catch (err) {
        return {
            ok: false,
            mode: "at",
            error: err instanceof Error ? err.message : String(err),
        };
    }
}

export function chatgpt2ApiIsConfigured(endpoint: Chatgpt2ApiEndpoint): boolean {
    return isConfigured(endpoint);
}
