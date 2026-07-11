import {generateRandomDeviceProfile} from "./device-profile.js";
import {
    markEmailUsed,
    clearUsedEmails,
    createAbortController,
    abortRegistration,
    getAbortSignal,
} from "./mailbox.js";
import {OpenAIClient} from "./openai.js";

export interface RunnerConfig {
    proxyUrl: string;
    threads: number;
    totalRounds: number;
    password: string;
    loopDelayMs: number;
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
                        const accessToken = await client.getChatGPTAccessToken();
                        if (!this.running || this.stopping || getAbortSignal()?.aborted) {
                            break;
                        }
                        const tokenFile = await client.saveChatGPTAccessToken(accessToken);
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
