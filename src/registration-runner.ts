import {generateRandomDeviceProfile} from "./device-profile.js";
import {
    markEmailUsed,
    clearUsedEmails,
    createAbortController,
    abortRegistration,
    getAbortSignal,
} from "./mailbox.js";
import {OpenAIClient} from "./openai.js";
import {
    chatgpt2ApiIsConfigured,
    testChatgpt2ApiConnection,
    uploadAccountToChatgpt2Api,
    type Chatgpt2ApiEndpoint,
} from "./chatgpt2api.js";

export interface RunnerConfig {
    proxyUrl: string;
    threads: number;
    totalRounds: number;
    password: string;
    loopDelayMs: number;
    /** When set and connection ok, auto-upload each account after register */
    chatgpt2api?: Chatgpt2ApiEndpoint;
    /** Pre-verified by WebUI /api/chatgpt2api/test; rechecked at start */
    chatgpt2apiConnected?: boolean;
}

export interface ProgressEvent {
    type: "progress" | "success" | "fail" | "done" | "log" | "stopped";
    round: number;
    total: number;
    success: number;
    fail: number;
    email?: string;
    tokenFile?: string;
    error?: string;
    message?: string;
    hasRefreshToken?: boolean;
    uploaded?: boolean;
    uploadMode?: "rt" | "at";
}

type ProgressCallback = (event: ProgressEvent) => void;

const ABORT_MESSAGE = "Registration aborted by user";

function isAbortError(error: unknown): boolean {
    if (!error) return false;
    if (typeof error === "object" && error !== null) {
        const name = String((error as {name?: unknown}).name ?? "");
        if (name === "AbortError") return true;
        const code = String((error as {code?: unknown}).code ?? "");
        if (code === "ABORT_ERR") return true;
    }
    const msg = error instanceof Error ? error.message : String(error);
    return /aborted by user|The operation was aborted|This operation was aborted|AbortError/i.test(
        msg,
    );
}

function sleepAbortable(ms: number): Promise<void> {
    const signal = getAbortSignal();
    if (!signal) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
    if (signal.aborted) {
        return Promise.reject(new Error(ABORT_MESSAGE));
    }
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
            reject(new Error(ABORT_MESSAGE));
        };
        signal.addEventListener("abort", onAbort, {once: true});
    });
}

export class RegistrationRunner {
    private running = false;
    private stopping = false;
    private config: RunnerConfig | null = null;
    private onProgress: ProgressCallback | null = null;
    private finalSuccess = 0;
    private finalFail = 0;
    private activeClients = new Set<OpenAIClient>();

    setCallback(cb: ProgressCallback) {
        this.onProgress = cb;
    }

    start(config: RunnerConfig) {
        if (this.running) return false;
        this.running = true;
        this.stopping = false;
        this.config = config;
        this.finalSuccess = 0;
        this.finalFail = 0;
        this.activeClients.clear();
        clearUsedEmails();
        process.env.REGISTRATION_PROXY_URL = config.proxyUrl;
        createAbortController();
        this.runLoop(config).finally(() => {
            this.running = false;
            this.stopping = false;
            this.activeClients.clear();
            delete process.env.REGISTRATION_PROXY_URL;
            this.onProgress?.({
                type: "done",
                round: config.totalRounds,
                total: config.totalRounds,
                success: this.finalSuccess,
                fail: this.finalFail,
            });
        });
        return true;
    }

    /**
     * Immediate stop: flip flags + abort in-flight OTP/IMAP/fetch.
     * Does not wait for the current round to finish.
     */
    stop() {
        if (!this.running && !this.stopping) {
            // Still abort any leftover controller
            abortRegistration();
            return;
        }
        this.stopping = true;
        this.running = false;
        console.log("[停止] 正在立即中断当前注册任务...");
        abortRegistration();
        this.onProgress?.({
            type: "stopped",
            round: 0,
            total: this.config?.totalRounds ?? 0,
            success: this.finalSuccess,
            fail: this.finalFail,
            message: "已请求立即停止",
        });
    }

    get isRunning() {
        return this.running;
    }

    private async runLoop(config: RunnerConfig) {
        const total = config.totalRounds;
        let round = 0,
            success = 0,
            fail = 0;

        // chatgpt2api auto-upload: re-verify at start when configured
        let uploadEnabled = false;
        const c2a = config.chatgpt2api;
        if (c2a && chatgpt2ApiIsConfigured(c2a)) {
            try {
                console.log("[chatgpt2api] 启动前检测连接...");
                this.onProgress?.({
                    type: "log",
                    round: 0,
                    total,
                    success: 0,
                    fail: 0,
                    message: `[chatgpt2api] 检测连接 ${c2a.baseUrl} ...`,
                });
                const probe = await testChatgpt2ApiConnection(c2a);
                if (probe.ok) {
                    uploadEnabled = true;
                    const n =
                        probe.accountCount !== undefined
                            ? `，号池 ${probe.accountCount} 个`
                            : "";
                    console.log(`[chatgpt2api] 连接成功${n}`);
                    this.onProgress?.({
                        type: "log",
                        round: 0,
                        total,
                        success: 0,
                        fail: 0,
                        message: `[chatgpt2api] 连接成功${n} — 将注册一个上传一个（优先 RT）`,
                    });
                } else {
                    console.log(`[chatgpt2api] 连接失败: ${probe.error}`);
                    this.onProgress?.({
                        type: "log",
                        round: 0,
                        total,
                        success: 0,
                        fail: 0,
                        message: `[chatgpt2api] 连接失败: ${probe.error} — AT/RT 仅保存本地`,
                    });
                }
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                this.onProgress?.({
                    type: "log",
                    round: 0,
                    total,
                    success: 0,
                    fail: 0,
                    message: `[chatgpt2api] 检测异常: ${msg} — AT/RT 仅保存本地`,
                });
            }
        } else {
            this.onProgress?.({
                type: "log",
                round: 0,
                total,
                success: 0,
                fail: 0,
                message: "[chatgpt2api] 未配置地址/鉴权 — AT/RT 仅保存本地供手动下载",
            });
        }

        const emit: ProgressCallback = (e) => {
            this.onProgress?.({
                ...e,
                round: e.round || round,
                total,
                success,
                fail,
            });
        };

        const originalLog = console.log;
        const originalError = console.error;
        console.log = (...args: unknown[]) => {
            const msg = args
                .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
                .join(" ");
            originalLog.apply(console, args);
            emit({type: "log", round: 0, total: 0, success: 0, fail: 0, message: msg});
        };
        console.error = (...args: unknown[]) => {
            const msg = args
                .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
                .join(" ");
            originalError.apply(console, args);
            emit({type: "log", round: 0, total: 0, success: 0, fail: 0, message: msg});
        };

        try {
            function nextRound(): number {
                round += 1;
                return round;
            }

            async function worker(this: RegistrationRunner, _id: number) {
                for (;;) {
                    if (!this.running || this.stopping) break;
                    const signal = getAbortSignal();
                    if (signal?.aborted) break;

                    const r = nextRound();
                    if (r > total) break;

                    emit({
                        type: "progress",
                        round: r,
                        total,
                        success,
                        fail,
                        email: undefined,
                        tokenFile: undefined,
                        error: undefined,
                    });

                    let client: OpenAIClient | null = null;
                    try {
                        const deviceProfile = generateRandomDeviceProfile();
                        client = new OpenAIClient({
                            password: config.password,
                            deviceProfile,
                        });
                        this.activeClients.add(client);
                        await client.authRegisterHTTP();
                        if (!this.running || this.stopping || getAbortSignal()?.aborted) {
                            break;
                        }
                        const session = await client.getChatGPTSession();
                        if (!this.running || this.stopping || getAbortSignal()?.aborted) {
                            break;
                        }

                        // Platform OAuth PKCE → refresh_token (oumiFree method)
                        let refreshToken = "";
                        let idToken = "";
                        let platformAccessToken = "";
                        try {
                            console.log("[OAuth PKCE] 获取 refresh_token...");
                            emit({
                                type: "log",
                                round: r,
                                total,
                                success,
                                fail,
                                message: `[${r}/${total}] OAuth PKCE 获取 refresh_token...`,
                            });
                            const oauth = await client.getPlatformOAuthTokens();
                            if (oauth?.refresh_token) {
                                refreshToken = oauth.refresh_token;
                                idToken = oauth.id_token || "";
                                platformAccessToken = oauth.access_token || "";
                                console.log(
                                    `[OAuth PKCE] 成功 email=${client.email} rt=yes`,
                                );
                                emit({
                                    type: "log",
                                    round: r,
                                    total,
                                    success,
                                    fail,
                                    message: `[${r}/${total}] OAuth PKCE 成功，已拿到 RT`,
                                });
                            } else {
                                console.log(
                                    `[OAuth PKCE] 未获取到 refresh_token email=${client.email}`,
                                );
                                emit({
                                    type: "log",
                                    round: r,
                                    total,
                                    success,
                                    fail,
                                    message: `[${r}/${total}] OAuth PKCE 未拿到 RT（仍保存 AT）`,
                                });
                            }
                        } catch (oauthErr) {
                            const omsg =
                                oauthErr instanceof Error
                                    ? oauthErr.message
                                    : String(oauthErr);
                            console.log(`[OAuth PKCE] 警告: ${omsg}`);
                            emit({
                                type: "log",
                                round: r,
                                total,
                                success,
                                fail,
                                message: `[${r}/${total}] OAuth PKCE 异常: ${omsg.slice(0, 120)}`,
                            });
                        }

                        if (!this.running || this.stopping || getAbortSignal()?.aborted) {
                            break;
                        }

                        const tokenFile = await client.saveChatGPTAccessToken(
                            session.accessToken,
                            {
                                refreshToken,
                                idToken,
                                sessionToken: session.sessionToken,
                                platformAccessToken,
                            },
                        );

                        // Auto-upload to chatgpt2api when connection is healthy
                        let uploaded = false;
                        let uploadMode: "rt" | "at" | undefined;
                        if (uploadEnabled && c2a) {
                            try {
                                emit({
                                    type: "log",
                                    round: r,
                                    total,
                                    success,
                                    fail,
                                    message: `[${r}/${total}] 上传到 chatgpt2api（${refreshToken ? "RT" : "AT"}）...`,
                                });
                                const up = await uploadAccountToChatgpt2Api(c2a, {
                                    accessToken: session.accessToken,
                                    platformAccessToken,
                                    refreshToken,
                                    idToken,
                                    email: client.email,
                                    password: config.password,
                                });
                                uploadMode = up.mode;
                                if (up.ok) {
                                    uploaded = true;
                                    console.log(
                                        `[chatgpt2api] 上传成功 email=${client.email} mode=${up.mode} added=${up.added} skipped=${up.skipped}`,
                                    );
                                    emit({
                                        type: "log",
                                        round: r,
                                        total,
                                        success,
                                        fail,
                                        message: `[${r}/${total}] chatgpt2api 上传成功 mode=${up.mode} added=${up.added ?? 0} skipped=${up.skipped ?? 0}`,
                                    });
                                } else {
                                    console.log(
                                        `[chatgpt2api] 上传失败 email=${client.email}: ${up.error}`,
                                    );
                                    emit({
                                        type: "log",
                                        round: r,
                                        total,
                                        success,
                                        fail,
                                        message: `[${r}/${total}] chatgpt2api 上传失败: ${up.error} — 已保留本地文件`,
                                    });
                                    // One failure does not disable the rest of the run;
                                    // next accounts still try. Local files always kept.
                                }
                            } catch (upErr) {
                                const um =
                                    upErr instanceof Error
                                        ? upErr.message
                                        : String(upErr);
                                emit({
                                    type: "log",
                                    round: r,
                                    total,
                                    success,
                                    fail,
                                    message: `[${r}/${total}] chatgpt2api 上传异常: ${um.slice(0, 140)} — 已保留本地文件`,
                                });
                            }
                        }

                        success += 1;
                        markEmailUsed(client.email);
                        emit({
                            type: "success",
                            round: r,
                            total,
                            success,
                            fail,
                            email: client.email,
                            tokenFile,
                            hasRefreshToken: Boolean(refreshToken),
                            uploaded,
                            uploadMode,
                        });
                    } catch (error) {
                        // Immediate stop: do not count as failure, exit worker
                        if (!this.running || this.stopping || isAbortError(error)) {
                            console.log(`[停止] 第${r}轮已中断`);
                            break;
                        }
                        fail += 1;
                        const msg = error instanceof Error ? error.message : String(error);

                        const emailMatch = msg.match(/email=(\S+@\S+)/);
                        const errEmail = emailMatch ? emailMatch[1] : "";
                        const isBurned =
                            /\bcode=(account_deactivated|user_already_exists)\b/.test(msg);

                        if (errEmail && isBurned) {
                            markEmailUsed(errEmail);
                            console.log(
                                `[邮箱已标记已用] ${errEmail} (原因: ${msg.match(/code=(\S+)/)?.[1] || "unknown"}) — 保留在池中，换别名可复用`,
                            );
                        }

                        if (errEmail && /\bcode=(rate_limit_exceeded)\b/.test(msg)) {
                            markEmailUsed(errEmail);
                            console.log(
                                `[邮箱已标记已用] ${errEmail} (原因: rate_limited) — 暂停使用`,
                            );
                        }

                        emit({
                            type: "fail",
                            round: r,
                            total,
                            success,
                            fail,
                            error: msg,
                        });
                    } finally {
                        if (client) this.activeClients.delete(client);
                    }

                    if (!this.running || this.stopping) break;
                    if (r < total && config.loopDelayMs > 0) {
                        try {
                            await sleepAbortable(config.loopDelayMs);
                        } catch {
                            break;
                        }
                    }
                }
            }

            const threads = Math.min(config.threads, total);
            const workers: Promise<void>[] = [];
            for (let i = 1; i <= threads; i++) {
                workers.push(worker.call(this, i));
            }
            await Promise.all(workers);

            this.finalSuccess = success;
            this.finalFail = fail;

            if (this.stopping) {
                console.log(
                    `[停止] 注册已停止 success=${success} fail=${fail} (进行中的轮次已立即中断)`,
                );
            }
        } finally {
            console.log = originalLog;
            console.error = originalError;
        }
    }
}
