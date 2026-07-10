import {generateRandomDeviceProfile} from "./device-profile.js";
import {OpenAIClient} from "./openai.js";

export interface RunnerConfig {
    proxyUrl: string;
    threads: number;
    totalRounds: number;
    password: string;
    loopDelayMs: number;
}

export interface ProgressEvent {
    type: "progress" | "success" | "fail" | "done" | "log";
    round: number;
    total: number;
    success: number;
    fail: number;
    email?: string;
    tokenFile?: string;
    error?: string;
}

type ProgressCallback = (event: ProgressEvent) => void;

export class RegistrationRunner {
    private running = false;
    private config: RunnerConfig | null = null;
    private onProgress: ProgressCallback | null = null;

    setCallback(cb: ProgressCallback) {
        this.onProgress = cb;
    }

    start(config: RunnerConfig) {
        if (this.running) return false;
        this.running = true;
        this.config = config;
        // Override proxy for this run
        process.env.REGISTRATION_PROXY_URL = config.proxyUrl;
        this.runLoop(config).finally(() => {
            this.running = false;
            delete process.env.REGISTRATION_PROXY_URL;
            this.onProgress?.({type: "done", round: 0, total: config.totalRounds, success: 0, fail: 0});
        });
        return true;
    }

    stop() {
        this.running = false;
    }

    get isRunning() { return this.running; }

    private async runLoop(config: RunnerConfig) {
        const total = config.totalRounds;
        let round = 0, success = 0, fail = 0;

        const emit: ProgressCallback = (e) => {
            this.onProgress?.({
                ...e,
                round: e.round || round,
                total,
                success,
                fail,
            });
        };

        function nextRound(): number { round += 1; return round; }

        async function worker(this: RegistrationRunner, id: number) {
            for (;;) {
                if (!this.running) break;
                const r = nextRound();
                if (r > total) break;
                emit({type: "progress", round: r, total, success, fail,
                    email: undefined, tokenFile: undefined, error: undefined});

                try {
                    const deviceProfile = generateRandomDeviceProfile();
                    const client = new OpenAIClient({
                        password: config.password,
                        deviceProfile,
                    });
                    await client.authRegisterHTTP();
                    const accessToken = await client.getChatGPTAccessToken();
                    const tokenFile = await client.saveChatGPTAccessToken(accessToken);
                    success += 1;
                    emit({type: "success", round: r, total, success, fail,
                        email: client.email, tokenFile});
                } catch (error) {
                    if (!this.running) break;
                    fail += 1;
                    const msg = error instanceof Error ? error.message : String(error);
                    emit({type: "fail", round: r, total, success, fail,
                        error: msg});
                }

                if (this.running && r < total && config.loopDelayMs > 0) {
                    await new Promise(res => setTimeout(res, config.loopDelayMs));
                }
            }
        }

        const threads = Math.min(config.threads, total);
        const workers: Promise<void>[] = [];
        for (let i = 1; i <= threads; i++) {
            workers.push(worker.call(this, i));
        }
        await Promise.all(workers);
    }
}
