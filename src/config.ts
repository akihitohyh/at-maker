import {readFileSync} from "node:fs";
import path from "node:path";

interface AppConfigFile {
    defaultPassword?: unknown;
    loopDelayMs?: unknown;
    defaultProxyUrl?: unknown;
}

export interface AppConfig {
    defaultPassword: string;
    loopDelayMs: number;
    defaultProxyUrl: string;
}

const DEFAULT_CONFIG: AppConfig = {
    defaultPassword: "kuaileshifu88",
    loopDelayMs: 120000,
    defaultProxyUrl: "http://127.0.0.1:10808",
};

function normalizeNumber(value: unknown, fallback: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return fallback;
    }
    return value;
}

function loadConfig(): AppConfig {
    const configPath = path.resolve(process.cwd(), "config.json");
    let raw: string;
    try {
        raw = readFileSync(configPath, "utf8");
    } catch {
        throw new Error("未找到 config.json，请先复制 config.example.json 为 config.json 并按需修改配置");
    }

    const parsed = JSON.parse(raw) as AppConfigFile;
    return {
        defaultPassword:
            typeof parsed.defaultPassword === "string" && parsed.defaultPassword.trim()
                ? parsed.defaultPassword
                : DEFAULT_CONFIG.defaultPassword,
        loopDelayMs: normalizeNumber(parsed.loopDelayMs, DEFAULT_CONFIG.loopDelayMs),
        defaultProxyUrl:
            typeof parsed.defaultProxyUrl === "string"
                ? parsed.defaultProxyUrl.trim()
                : DEFAULT_CONFIG.defaultProxyUrl,
    };
}

export const appConfig = loadConfig();
