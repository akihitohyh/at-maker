import {mkdir, writeFile, appendFile} from "node:fs/promises";
import net from "node:net";
import tls from "node:tls";
import path from "node:path";
import {Agent, type Dispatcher, ProxyAgent, setGlobalDispatcher} from "undici";
import {SocksClient} from "socks";
import makeFetchCookie from "fetch-cookie";
import {CookieJar} from "tough-cookie";
import {appConfig} from "./config.js";
import {defaultDeviceProfile, type DeviceProfile, getDeviceClientHints} from "./device-profile.js";
import {
    AUTH_AUTHORIZE_CONTINUE_URL,
    AUTH_BASE_URL,
    AUTH_EMAIL_OTP_SEND_URL,
    AUTH_EMAIL_OTP_VALIDATE_URL,
    AUTH_REGISTER_URL,
    CHATGPT_AUTH_CSRF_URL,
    CHATGPT_BASE_URL,
    DEFAULT_USER_AGENT,
} from "./constants.js";
import {
    getEmailAddress,
    getEmailVerificationCode,
    prepareOtpBaseline,
    markVerificationCodeRejected,
    clearOtpPollState,
    getAbortSignal,
} from "./mailbox.js";
import {fetchSentinelToken} from "./sentinel.js";

type FetchLike = typeof fetch;

const REGISTRATION_ABORT_MESSAGE = "Registration aborted by user";

function throwIfRegistrationAborted(): void {
    const signal = getAbortSignal();
    if (signal?.aborted) {
        throw new Error(REGISTRATION_ABORT_MESSAGE);
    }
}

function mergeAbortSignals(
    ...signals: Array<AbortSignal | undefined | null>
): AbortSignal | undefined {
    const list = signals.filter((s): s is AbortSignal => !!s);
    if (list.length === 0) return undefined;
    if (list.length === 1) return list[0];
    // Node 20+: AbortSignal.any
    const anyFn = (AbortSignal as unknown as {any?: (s: AbortSignal[]) => AbortSignal}).any;
    if (typeof anyFn === "function") {
        return anyFn.call(AbortSignal, list);
    }
    // Fallback: first signal only
    return list[0];
}

function sleepAbortable(ms: number, signal?: AbortSignal | null): Promise<void> {
    if (!signal) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
    if (signal.aborted) {
        return Promise.reject(new Error(REGISTRATION_ABORT_MESSAGE));
    }
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
            reject(new Error(REGISTRATION_ABORT_MESSAGE));
        };
        signal.addEventListener("abort", onAbort, {once: true});
    });
}

const DEFAULT_INSECURE_TLS = true;
const FETCH_RETRY_COUNT = 3;
const FETCH_RETRY_DELAY_MS = 1500;

function resolveProxyUrl(): string {
    return process.env.REGISTRATION_PROXY_URL || appConfig.defaultProxyUrl;
}

function shouldAllowInsecureTLS(): boolean {
    return DEFAULT_INSECURE_TLS;
}

function createDispatcher(proxyUrl: string, allowInsecureTLS: boolean): Dispatcher {
    if (!proxyUrl) {
        return new Agent({
            connect: {
                rejectUnauthorized: !allowInsecureTLS,
            },
        });
    }

    const parsedProxyUrl = new URL(proxyUrl);
    if (parsedProxyUrl.protocol === "http:" || parsedProxyUrl.protocol === "https:") {
        return new ProxyAgent({
            uri: proxyUrl,
            requestTls: {
                rejectUnauthorized: !allowInsecureTLS,
            },
        });
    }

    if (isSocksProtocol(parsedProxyUrl.protocol)) {
        const connect = ((options, callback) => {
            void createSocksSocket(parsedProxyUrl, options as unknown as Record<string, unknown>, allowInsecureTLS)
                .then((socket) => callback(null, socket))
                .catch((error) => callback(error instanceof Error ? error : new Error(String(error)), null));
        }) as NonNullable<ConstructorParameters<typeof Agent>[0]>["connect"];

        return new Agent({
            connect,
        });
    }

    throw new Error(`不支持的代理协议: ${parsedProxyUrl.protocol}`);
}

function isSocksProtocol(protocol: string): boolean {
    return ["socks4:", "socks4a:", "socks5:", "socks5h:"].includes(protocol);
}

async function createSocksSocket(
    proxyUrl: URL,
    options: Record<string, unknown>,
    allowInsecureTLS: boolean,
): Promise<net.Socket> {
    const destinationHost = String(options.hostname ?? "");
    const rawPort = options.port;
    const destinationPort =
        rawPort === "" || rawPort == null
            ? (options.protocol === "https:" ? 443 : 80)
            : Number(rawPort);
    const proxyPort = Number(proxyUrl.port || (proxyUrl.protocol.startsWith("socks5") ? 1080 : 1080));
    const proxyType = proxyUrl.protocol.startsWith("socks4") ? 4 : 5;

    const connection = await SocksClient.createConnection({
        proxy: {
            host: proxyUrl.hostname,
            port: proxyPort,
            type: proxyType,
            userId: proxyUrl.username ? decodeURIComponent(proxyUrl.username) : undefined,
            password: proxyUrl.password ? decodeURIComponent(proxyUrl.password) : undefined,
        },
        command: "connect",
        destination: {
            host: destinationHost,
            port: destinationPort,
        },
    });

    const socket = connection.socket;
    if (options.protocol !== "https:") {
        return socket;
    }

    return await new Promise<net.Socket>((resolve, reject) => {
        const tlsSocket = tls.connect({
            socket,
            host: String(options.servername ?? destinationHost),
            servername: String(options.servername ?? destinationHost),
            rejectUnauthorized: !allowInsecureTLS,
        });
        tlsSocket.once("secureConnect", () => resolve(tlsSocket));
        tlsSocket.once("error", reject);
    });
}

interface ContinueResponse {
    continue_url: string;
    method?: string;
    page?: {
        type?: string;
        backstack_behavior?: string;
        payload?: {
            url?: string;
        };
    };
}

interface ChatGPTAuthSession {
    accessToken?: string;
    access_token?: string;
    error?: string;
}

interface ChatGPTAccessTokenClaims {
    exp?: number;
}

export interface OpenAIClientOptions {
    email?: string;
    password: string;
    userAgent?: string;
    deviceProfile?: DeviceProfile;
}

export class OpenAIClient {
    email: string;
    readonly password: string;
    readonly jar: CookieJar;
    readonly fetch: FetchLike;
    readonly userAgent: string;
    readonly deviceProfile: DeviceProfile;
    readonly clientHints: ReturnType<typeof getDeviceClientHints>;
    deviceID = "";

    constructor(options: OpenAIClientOptions) {
        this.email = options.email?.trim() ?? "";
        this.password = options.password;
        this.deviceProfile = options.deviceProfile
            ? {
                ...options.deviceProfile,
                languages: [...options.deviceProfile.languages],
            }
            : {
                ...defaultDeviceProfile(),
                userAgent: options.userAgent?.trim() || DEFAULT_USER_AGENT,
            };
        this.userAgent = this.deviceProfile.userAgent;
        this.clientHints = getDeviceClientHints(this.deviceProfile);
        this.jar = new CookieJar();
        setGlobalDispatcher(createDispatcher(resolveProxyUrl(), shouldAllowInsecureTLS()));
        const cookieFetch = makeFetchCookie(fetch, this.jar) as FetchLike;
        this.fetch = ((input: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) =>
            this.fetchWithRetry(cookieFetch, input, init)) as FetchLike;
    }

    private logProgress(current: number | string, total: number, message: string): void {
        console.log(`[${current}/${total}] ${message}`);
    }

    async authRegisterHTTP(): Promise<string> {
        const stepMessages = [
            "初始化注册会话",
            "生成注册邮箱",
            "打开注册页",
            "提交注册邮箱",
        ];
        let totalSteps = stepMessages.length;
        let step = 1;

        throwIfRegistrationAborted();
        this.logProgress(step++, totalSteps, "初始化注册会话");
        await this.bootChatGPTSession();

        throwIfRegistrationAborted();
        this.logProgress(step++, totalSteps, "生成注册邮箱");
        this.email = await this.generateRegisterEmail();
        console.log("registerEmail:", this.email);

        throwIfRegistrationAborted();
        this.logProgress(step++, totalSteps, "打开注册页");
        await this.openSignupPage(this.email);

        throwIfRegistrationAborted();
        this.logProgress(step++, totalSteps, "提交注册邮箱");
        let continueURL = await this.authorizeContinueForSignup();

        if (continueURL === `${AUTH_BASE_URL}/create-account/password`) {
            throwIfRegistrationAborted();
            totalSteps += 1;
            this.logProgress(step++, totalSteps, "提交注册密码");
            continueURL = await this.registerPassword();
        }

        if (continueURL === AUTH_EMAIL_OTP_SEND_URL) {
            throwIfRegistrationAborted();
            totalSteps += 1;
            this.logProgress(step++, totalSteps, "发送邮箱验证码");
            continueURL = await this.sendEmailOtp();
        }

        if (continueURL === `${AUTH_BASE_URL}/email-verification`) {
            throwIfRegistrationAborted();
            totalSteps += 1;
            this.logProgress(step++, totalSteps, "提交邮箱验证码");
            continueURL = await this.emailOtpValidate();
        }

        if (continueURL === `${AUTH_BASE_URL}/about-you`) {
            throwIfRegistrationAborted();
            totalSteps += 1;
            this.logProgress(step++, totalSteps, "填写基础资料");
            continueURL = await this.completeAboutYou();
        }

        if (continueURL.startsWith(`${CHATGPT_BASE_URL}/api/auth/callback/openai`)) {
            throwIfRegistrationAborted();
            totalSteps += 1;
            this.logProgress(step++, totalSteps, "完成注册");
            await this.finishChatGPTRegistration(continueURL);
            console.log(`[注册成功] 邮箱：${this.email} 密码：${this.password}`);
        }

        return continueURL;
    }

    async getChatGPTAccessToken(): Promise<string> {
        const response = await this.fetch(`${CHATGPT_BASE_URL}/api/auth/session`, {
            method: "GET",
            headers: this.createBrowserHeaders({
                accept: "application/json",
                "sec-fetch-dest": "empty",
                "sec-fetch-mode": "cors",
                "sec-fetch-site": "same-origin",
                referer: `${CHATGPT_BASE_URL}/`,
            }),
        });
        if (!response.ok) {
            throw new Error(`获取 ChatGPT accessToken 失败: ${await this.formatErrorResponse(response)}`);
        }

        const payload = (await response.json()) as ChatGPTAuthSession;
        const accessToken = String(payload.accessToken ?? payload.access_token ?? "").trim();
        if (!accessToken) {
            throw new Error(`ChatGPT session 中缺少 accessToken: ${JSON.stringify(payload)}`);
        }
        return accessToken;
    }

    async saveChatGPTAccessToken(accessToken: string): Promise<string> {
        const atDir = path.resolve(process.cwd(), "auth", "at");
        await mkdir(atDir, {recursive: true});
        const fileName = this.buildAuthFileName(this.email);
        const filePath = path.join(atDir, fileName);
        const accessClaims = this.decodeJwtPayload<ChatGPTAccessTokenClaims>(accessToken);
        const expiresAt = accessClaims.exp
            ? new Date(accessClaims.exp * 1000).toISOString()
            : "";
        await writeFile(
            filePath,
            `${JSON.stringify({
                access_token: accessToken,
                expires_at: expiresAt,
                expires_in: accessClaims.exp
                    ? Math.max(0, Math.floor(accessClaims.exp - Date.now() / 1000))
                    : 0,
                email: this.email,
                cookie: await this.jar.getCookieString(CHATGPT_BASE_URL),
                last_refresh: new Date().toISOString(),
                type: "chatgpt",
            }, null, 2)}\n`,
            "utf8",
        );
        // Also append access_token to centralized txt (one per line)
        const tokenListFile = path.resolve(process.cwd(), "auth", "access_tokens.txt");
        await mkdir(path.dirname(tokenListFile), {recursive: true});
        await appendFile(tokenListFile, accessToken + "\n", "utf8");
        return filePath;
    }

    // ── private helpers ──

    private async bootChatGPTSession(): Promise<void> {
        const response = await this.fetch(`${CHATGPT_BASE_URL}/`, {
            method: "GET",
            redirect: "follow",
            headers: this.createBrowserHeaders({
                "accept-encoding": "gzip, deflate, br",
                "sec-fetch-dest": "document",
                "sec-fetch-mode": "navigate",
                "sec-fetch-site": "none",
            }),
        });
        if (!response.ok) {
            throw new Error(`打开 chatgpt.com 失败: ${response.status}`);
        }

        this.deviceID =
            (await this.readCookie(CHATGPT_BASE_URL, "oai-did")) ||
            (await this.readCookie("https://openai.com", "oai-did"));
        if (!this.deviceID) {
            throw new Error("chatgpt.com 未返回 oai-did cookie");
        }
    }

    private async openSignupPage(email: string): Promise<void> {
        const csrfToken = await this.nextAuthCSRFToken();

        const query = new URLSearchParams({
            prompt: "login",
            "ext-oai-did": this.deviceID,
            auth_session_logging_id: globalThis.crypto.randomUUID(),
            "ext-passkey-client-capabilities": "0111",
            screen_hint: "login_or_signup",
            login_hint: email,
        });
        const body = new URLSearchParams({
            callbackUrl: `${CHATGPT_BASE_URL}/`,
            csrfToken,
            json: "true",
        });

        const response = await this.fetch(
            `${CHATGPT_BASE_URL}/api/auth/signin/openai?${query.toString()}`,
            {
                method: "POST",
                redirect: "follow",
                headers: this.createBrowserHeaders({
                    accept: "*/*",
                    "content-type": "application/x-www-form-urlencoded",
                    origin: CHATGPT_BASE_URL,
                    referer: `${CHATGPT_BASE_URL}/`,
                    "sec-fetch-dest": "empty",
                    "sec-fetch-mode": "cors",
                    "sec-fetch-site": "same-origin",
                }),
                body,
            },
        );
        if (!response.ok) {
            throw new Error(`打开注册页失败: ${response.status}`);
        }

        const payload = (await response.json()) as { url?: string };
        if (!payload.url) {
            throw new Error(`打开注册页缺少跳转URL: ${JSON.stringify(payload)}`);
        }

        const authorizeResp = await this.fetch(payload.url, {
            method: "GET",
            redirect: "follow",
            headers: this.createBrowserHeaders({
                "accept-encoding": "gzip, deflate, br",
                referer: `${CHATGPT_BASE_URL}/`,
                "sec-fetch-dest": "document",
                "sec-fetch-mode": "navigate",
                "sec-fetch-site": "same-site",
            }),
        });
        if (!authorizeResp.ok) {
            throw new Error(`打开 OpenAI authorize 页失败: ${authorizeResp.status}`);
        }
    }

    private async authorizeContinueForSignup(screenHint = "login_or_signup"): Promise<string> {
        const sentinelToken = await this.fetchSentinelToken("authorize_continue");
        const response = await this.postJSON(
            AUTH_AUTHORIZE_CONTINUE_URL,
            {
                username: {
                    kind: "email",
                    value: this.email,
                },
                screen_hint: screenHint,
            },
            {
                referer: `${AUTH_BASE_URL}/log-in-or-create-account?usernameKind=email`,
                sentinelToken,
            },
        );
        if (!response.ok) {
            await this.throwStepError("AuthorizeContinue", response);
        }
        const payload = (await response.json()) as ContinueResponse;
        return payload.continue_url;
    }

    private async registerPassword(): Promise<string> {
        const sentinelToken = await this.fetchSentinelToken("username_password_create");
        const response = await this.postJSON(
            AUTH_REGISTER_URL,
            {
                password: this.password,
                username: this.email,
            },
            {
                referer: `${AUTH_BASE_URL}/create-account/password`,
                sentinelToken,
            },
        );
        if (!response.ok) {
            await this.throwStepError("RegisterPassword", response);
        }
        const payload = (await response.json()) as ContinueResponse;
        return payload.continue_url;
    }

    private async sendEmailOtp(): Promise<string> {
        // Snapshot mailbox BEFORE OpenAI sends the code, so the new OTP is not treated as stale
        try {
            await prepareOtpBaseline(this.email);
        } catch (err) {
            console.log(`prepareOtpBaseline warning: ${String(err).slice(0, 160)}`);
        }

        const response = await this.fetch(AUTH_EMAIL_OTP_SEND_URL, {
            method: "GET",
            headers: {
                accept: "application/json",
                referer: `${AUTH_BASE_URL}/create-account/password`,
                "user-agent": this.userAgent,
                "accept-language": this.deviceProfile.acceptLanguage,
                "sec-ch-ua": this.clientHints.secChUa,
                "sec-ch-ua-full-version-list": this.clientHints.secChUaFullVersionList,
                "sec-ch-ua-mobile": this.clientHints.secChUaMobile,
                "sec-ch-ua-platform": this.clientHints.secChUaPlatform,
                "sec-ch-ua-platform-version": this.clientHints.secChUaPlatformVersion,
                "sec-ch-viewport-width": this.clientHints.secChViewportWidth,
            },
        });
        if (!response.ok) {
            await this.throwStepError("EmailOtpSend", response);
        }
        const payload = (await response.json()) as ContinueResponse;
        return payload.continue_url;
    }

    private async emailOtpValidate(): Promise<string> {
        // Retry when mailbox returns a stale/wrong code (common with reused hotmail accounts)
        const maxAttempts = 4;
        let lastDetail = "";

        // Safety: if flow skipped sendEmailOtp, still try to baseline before first poll
        try {
            await prepareOtpBaseline(this.email);
        } catch (err) {
            console.log(`prepareOtpBaseline(validate) warning: ${String(err).slice(0, 160)}`);
        }

        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            const code = await this.resolveEmailOtpCode();
            console.log(`emailOtpValidate: attempt=${attempt}/${maxAttempts} code=${code}`);

            const response = await this.fetch(AUTH_EMAIL_OTP_VALIDATE_URL, {
                method: "POST",
                headers: {
                    accept: "application/json",
                    "content-type": "application/json",
                    origin: AUTH_BASE_URL,
                    referer: `${AUTH_BASE_URL}/email-verification`,
                    "user-agent": this.userAgent,
                },
                body: JSON.stringify({code}),
            });

            if (response.ok) {
                const payload = (await response.json()) as ContinueResponse;
                clearOtpPollState(this.email);
                return payload.continue_url;
            }

            const body = await response.text();
            let errCode = "";
            try {
                const payload = JSON.parse(body) as {error?: {code?: string | null}};
                errCode = payload.error?.code ?? "";
            } catch {}
            lastDetail = errCode
                ? `${response.status} code=${errCode}`
                : `${response.status} body=${body.slice(0, 200)}`;

            const retryable =
                errCode === "wrong_email_otp_code" ||
                errCode === "email_otp_invalid" ||
                errCode === "invalid_code";

            if (retryable && attempt < maxAttempts) {
                console.log(
                    `emailOtpValidate: reject stale/wrong code=${code} (${errCode}), continue polling for newer OTP`,
                );
                markVerificationCodeRejected(this.email, code);
                // Brief wait so a just-arrived mail is more likely visible next poll
                await sleepAbortable(1500, getAbortSignal());
                continue;
            }

            throw new Error(`EmailOtpValidate: ${lastDetail} email=${this.email}`);
        }

        throw new Error(`EmailOtpValidate: ${lastDetail || "exhausted retries"} email=${this.email}`);
    }

    private async completeAboutYou(): Promise<string> {
        const sentinelToken = await this.fetchSentinelToken("oauth_create_account");
        const profile = this.randomProfile();
        console.log("registerProfile:", JSON.stringify(profile));

        const response = await this.postJSON(
            `${AUTH_BASE_URL}/api/accounts/create_account`,
            profile,
            {
                referer: `${AUTH_BASE_URL}/about-you`,
                sentinelToken,
            },
        );
        if (!response.ok) {
            await this.throwStepError("CreateAccount", response);
        }
        const payload = (await response.json()) as ContinueResponse;
        return payload.page?.payload?.url ?? payload.continue_url;
    }

    private async finishChatGPTRegistration(callbackURL: string): Promise<void> {
        const response = await this.fetch(callbackURL, {
            method: "GET",
            redirect: "follow",
            headers: {
                accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                referer: `${AUTH_BASE_URL}/about-you`,
                "user-agent": this.userAgent,
                "accept-language": this.deviceProfile.acceptLanguage,
                "sec-ch-ua": this.clientHints.secChUa,
                "sec-ch-ua-full-version-list": this.clientHints.secChUaFullVersionList,
                "sec-ch-ua-mobile": this.clientHints.secChUaMobile,
                "sec-ch-ua-platform": this.clientHints.secChUaPlatform,
                "sec-ch-ua-platform-version": this.clientHints.secChUaPlatformVersion,
                "sec-ch-viewport-width": this.clientHints.secChViewportWidth,
            },
        });
        if (!response.ok) {
            throw new Error(`完成 ChatGPT 注册回调失败: ${response.status}`);
        }
    }

    async fetchSentinelToken(
        flow:
            | "authorize_continue"
            | "username_password_create"
            | "oauth_create_account",
    ): Promise<string> {
        return fetchSentinelToken({
            flow,
            deviceID: this.deviceID,
            fetch: this.fetch,
            reqEndpoint: "https://sentinel.openai.com/backend-api/sentinel/req",
            userAgent: this.userAgent,
            deviceProfile: this.deviceProfile,
        });
    }

    private async resolveEmailOtpCode(): Promise<string> {
        console.log(`autoEmailOtp: provider=hotmail targetEmail=${this.email}`);
        return getEmailVerificationCode(this.email);
    }

    private async generateRegisterEmail(): Promise<string> {
        if (this.email) {
            return this.email;
        }
        return getEmailAddress();
    }

    // ── CSRF ──

    private async nextAuthCSRFToken(): Promise<string> {
        const fromCookie = await this.nextAuthCSRFTokenFromCookie();
        if (fromCookie) {
            return fromCookie;
        }

        const response = await this.fetch(CHATGPT_AUTH_CSRF_URL, {
            method: "GET",
            redirect: "follow",
            headers: this.createBrowserHeaders({
                accept: "application/json",
                referer: `${CHATGPT_BASE_URL}/`,
                "sec-fetch-dest": "empty",
                "sec-fetch-mode": "cors",
                "sec-fetch-site": "same-origin",
            }),
        });
        if (response.ok) {
            try {
                const payload = (await response.json()) as {csrfToken?: string};
                const token = payload.csrfToken?.trim() ?? "";
                if (token) {
                    return token;
                }
            } catch {
                // 忽略 JSON 解析失败，回退到 cookie
            }
        }

        const retryCookie = await this.nextAuthCSRFTokenFromCookie();
        if (retryCookie) {
            return retryCookie;
        }

        throw new Error("未找到 NextAuth csrfToken，无法打开注册页");
    }

    private async nextAuthCSRFTokenFromCookie(): Promise<string> {
        for (const name of [
            "__Host-next-auth.csrf-token",
            "__Secure-next-auth.csrf-token",
            "next-auth.csrf-token",
        ]) {
            const token = decodeCsrfCookie(await this.readCookie(CHATGPT_BASE_URL, name));
            if (token) {
                return token;
            }
        }
        return "";
    }

    // ── HTTP helpers ──

    private async postJSON(
        url: string,
        payload: unknown,
        options: {
            referer: string;
            sentinelToken?: string;
        },
    ): Promise<Response> {
        const headers = this.createBrowserHeaders({
            accept: "application/json",
            "content-type": "application/json",
            origin: AUTH_BASE_URL,
            referer: options.referer,
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-origin",
        });
        if (options.sentinelToken) {
            headers.set("openai-sentinel-token", options.sentinelToken);
        }
        return this.fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
        });
    }

    private async readCookie(url: string, key: string): Promise<string> {
        const cookies = await this.jar.getCookies(url);
        return cookies.find((cookie) => cookie.key === key)?.value ?? "";
    }

    private createBrowserHeaders(init: Record<string, string>): Headers {
        return new Headers({
            "user-agent": this.userAgent,
            "accept-language": this.deviceProfile.acceptLanguage,
            "sec-ch-ua": this.clientHints.secChUa,
            "sec-ch-ua-full-version-list": this.clientHints.secChUaFullVersionList,
            "sec-ch-ua-mobile": this.clientHints.secChUaMobile,
            "sec-ch-ua-platform": this.clientHints.secChUaPlatform,
            "sec-ch-ua-platform-version": this.clientHints.secChUaPlatformVersion,
            "sec-ch-viewport-width": this.clientHints.secChViewportWidth,
            ...init,
        });
    }

    private async throwStepError(step: string, response: Response): Promise<never> {
        const body = await response.text();
        let code = "";
        try {
            const payload = JSON.parse(body) as {
                error?: { code?: string | null };
            };
            code = payload.error?.code ?? "";
        } catch {}
        const detail = code ? `${response.status} code=${code}` : `${response.status} body=${body}`;
        throw new Error(`${step}: ${detail} email=${this.email}`);
    }

    private async formatErrorResponse(response: Response): Promise<string> {
        const body = await response.text();
        try {
            const payload = JSON.parse(body) as {
                error?: {
                    code?: string | null;
                };
            };
            const code = payload.error?.code;
            if (code) {
                return `${response.status} code=${code}`;
            }
        } catch {
            // ignore parse error and fall back to raw body
        }
        return `${response.status} body=${body}`;
    }

    // ── fetch retry ──

    private async fetchWithRetry(
        baseFetch: FetchLike,
        input: Parameters<FetchLike>[0],
        init?: Parameters<FetchLike>[1],
    ): Promise<Response> {
        throwIfRegistrationAborted();
        const regSignal = getAbortSignal();
        const nextInit: RequestInit = {...(init ?? {})};
        const merged = mergeAbortSignals(regSignal, init?.signal ?? undefined);
        if (merged) {
            nextInit.signal = merged;
        }

        let lastError: unknown;
        for (let attempt = 1; attempt <= FETCH_RETRY_COUNT; attempt++) {
            throwIfRegistrationAborted();
            try {
                return await baseFetch(input, nextInit);
            } catch (error) {
                lastError = error;
                // User stop: never retry
                if (
                    regSignal?.aborted ||
                    (error instanceof Error &&
                        (/aborted by user|The operation was aborted|AbortError/i.test(
                            error.message,
                        ) ||
                            error.name === "AbortError"))
                ) {
                    throw new Error(REGISTRATION_ABORT_MESSAGE);
                }
                if (!isRetryableFetchError(error) || attempt >= FETCH_RETRY_COUNT) {
                    throw error;
                }
                console.log(
                    `[网络重试 ${attempt}/${FETCH_RETRY_COUNT}] ${this.describeRetryTarget(input)} ${this.describeRetryError(error)}`,
                );
                console.log(`[延迟] 网络重试等待 ${FETCH_RETRY_DELAY_MS * attempt}ms`);
                await sleepAbortable(FETCH_RETRY_DELAY_MS * attempt, regSignal);
            }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    private describeRetryTarget(input: Parameters<FetchLike>[0]): string {
        if (typeof input === "string") {
            return input;
        }
        if (input instanceof URL) {
            return input.toString();
        }
        if (typeof Request !== "undefined" && input instanceof Request) {
            return input.url;
        }
        return "unknown-url";
    }

    private describeRetryError(error: unknown): string {
        const cause = getErrorCause(error);
        if (!cause) {
            return error instanceof Error ? error.message : String(error);
        }
        const code = "code" in cause ? String((cause as { code?: unknown }).code ?? "") : "";
        return code ? `${cause.message} (${code})` : cause.message;
    }

    // ── profile / jwt helpers ──

    private randomProfile(): { name: string; birthdate: string } {
        const firstNames = [
            "Ethan", "Noah", "Liam", "Mason", "Lucas", "Logan", "Owen", "Ryan", "Leo", "Adam",
            "Ella", "Ava", "Mia", "Luna", "Chloe", "Grace", "Ruby", "Nora", "Ivy", "Sofia",
        ];
        const lastNames = [
            "Smith", "Brown", "Taylor", "Walker", "Wilson", "Clark", "Hall", "Young",
            "Allen", "King", "Scott", "Green", "Baker", "Adams", "Turner",
        ];
        const age = this.randomInt(25, 34);
        const today = new Date();
        const birthYear = today.getFullYear() - age;
        const birthMonth = this.randomInt(1, 12);
        const maxDay = new Date(birthYear, birthMonth, 0).getDate();
        const birthDay = this.randomInt(1, maxDay);

        return {
            name: `${this.pick(firstNames)} ${this.pick(lastNames)}`,
            birthdate: [
                birthYear,
                `${birthMonth}`.padStart(2, "0"),
                `${birthDay}`.padStart(2, "0"),
            ].join("-"),
        };
    }

    private pick<T>(items: T[]): T {
        return items[Math.floor(Math.random() * items.length)];
    }

    private randomInt(min: number, max: number): number {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    private decodeJwtPayload<T>(token: string): T {
        const parts = token.split(".");
        if (parts.length < 2) {
            throw new Error(`JWT格式不正确: ${token.slice(0, 24)}...`);
        }
        return this.decodeSignedJson<T>(parts[1]);
    }

    private decodeSignedJson<T>(encoded: string): T {
        const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
        const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
        const json = Buffer.from(padded, "base64").toString("utf8");
        return JSON.parse(json) as T;
    }

    private buildAuthFileName(email: string): string {
        const now = new Date();
        const date = [
            now.getFullYear(),
            `${now.getMonth() + 1}`.padStart(2, "0"),
            `${now.getDate()}`.padStart(2, "0"),
        ].join("-");
        const safeEmail = email.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
        return `${date}-${safeEmail}.json`;
    }
}

// ── pure utility functions ──

function decodeCsrfCookie(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) {
        return "";
    }
    let decoded = trimmed;
    try {
        decoded = decodeURIComponent(trimmed);
    } catch {
        // 值不是合法的百分号编码时，保留原始值
    }
    return decoded.split("|")[0]?.trim() ?? "";
}

function isRetryableFetchError(error: unknown): boolean {
    const message = collectErrorMessages(error).join(" ").toLowerCase();
    return [
        "econnreset",
        "etimedout",
        "socket hang up",
        "proxy connection timed out",
        "fetch failed",
        "eai_again",
        "ecannotassignrequestedaddress",
        "ehostunreach",
        "enetunreach",
    ].some((keyword) => message.includes(keyword));
}

function getErrorCause(error: unknown): Error | null {
    if (error instanceof Error && error.cause instanceof Error) {
        return error.cause;
    }
    return error instanceof Error ? error : null;
}

function collectErrorMessages(error: unknown): string[] {
    const messages: string[] = [];
    if (error instanceof Error) {
        messages.push(error.message);
        if (error.cause instanceof Error) {
            messages.push(error.cause.message);
            const code = "code" in error.cause ? String((error.cause as { code?: unknown }).code ?? "") : "";
            if (code) {
                messages.push(code);
            }
        }
        const code = "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
        if (code) {
            messages.push(code);
        }
    } else if (error != null) {
        messages.push(String(error));
    }
    return messages;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
