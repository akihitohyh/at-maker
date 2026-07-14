import {createHotmailProvider} from "./mail/hotmail.js";
import {createTempMailProvider, setTempMailApiKey, getTempMailApiKey} from "./mail/tempmail.js";
import {
    createYydsProvider,
    setYydsConfig,
    getYydsConfig,
} from "./mail/yyds.js";

export type MailProviderId = "hotmail" | "tempmail" | "yyds";

export interface EmailCodeProvider {
    getEmailAddress(): Promise<string>;
    getEmailVerificationCode(email: string): Promise<string>;
    getAliasSuffix(): string;
    setAliasSuffix(suffix: string): Promise<void>;
    getRandomAliasEnabled(): boolean;
    setRandomAliasEnabled(enabled: boolean): void;
    getMailApiMode(): string;
    setMailApiMode(mode: string): void;
    markEmailUsed(email: string): void;
    clearUsedEmails(): void;
    clearAccountCache(): void;
    createAbortController(): AbortController;
    abortRegistration(): void;
    getAbortSignal?(): AbortSignal | undefined;
    prepareOtpBaseline?(email: string): Promise<boolean | void>;
    markVerificationCodeRejected?(email: string, code: string): void;
    clearOtpPollState?(email: string): void;
}

const hotmail = createHotmailProvider();
const tempmail = createTempMailProvider();
const yyds = createYydsProvider();

let activeProviderId: MailProviderId = "hotmail";

function normalizeProviderId(value: unknown): MailProviderId {
    const v = String(value || "")
        .trim()
        .toLowerCase();
    if (v === "tempmail" || v === "tempmail.lol" || v === "lol") return "tempmail";
    if (v === "yyds" || v === "yydsmail" || v === "maliapi") return "yyds";
    return "hotmail";
}

export function getEmailProviderId(): MailProviderId {
    return activeProviderId;
}

export function setEmailProviderId(id: string | MailProviderId): MailProviderId {
    activeProviderId = normalizeProviderId(id);
    console.log(`[mailbox] provider=${activeProviderId}`);
    return activeProviderId;
}

export function configureTempMail(apiKey: string): void {
    setTempMailApiKey(apiKey);
}

export function configureYyds(opts: {
    apiKey?: string;
    baseUrl?: string;
    domain?: string;
}): void {
    setYydsConfig(opts);
}

export function getProviderSecrets(): {
    tempmailApiKey: string;
    yydsApiKey: string;
    yydsBaseUrl: string;
    yydsDomain: string;
} {
    const y = getYydsConfig();
    return {
        tempmailApiKey: getTempMailApiKey(),
        yydsApiKey: y.apiKey,
        yydsBaseUrl: y.baseUrl,
        yydsDomain: y.domain,
    };
}

function provider(): EmailCodeProvider {
    switch (activeProviderId) {
        case "tempmail":
            return tempmail;
        case "yyds":
            return yyds;
        default:
            return hotmail;
    }
}

export async function getEmailAddress(): Promise<string> {
    return provider().getEmailAddress();
}

export async function getEmailVerificationCode(email: string): Promise<string> {
    return provider().getEmailVerificationCode(email);
}

export async function prepareOtpBaseline(email: string): Promise<void> {
    await provider().prepareOtpBaseline?.(email);
}

export function markVerificationCodeRejected(email: string, code: string): void {
    provider().markVerificationCodeRejected?.(email, code);
}

export function clearOtpPollState(email: string): void {
    provider().clearOtpPollState?.(email);
}

export function getAliasSuffix(): string {
    return provider().getAliasSuffix();
}

export async function setAliasSuffix(suffix: string): Promise<void> {
    return provider().setAliasSuffix(suffix);
}

export function getRandomAliasEnabled(): boolean {
    return provider().getRandomAliasEnabled();
}

export function setRandomAliasEnabled(enabled: boolean): void {
    provider().setRandomAliasEnabled(enabled);
}

export function getMailApiMode(): string {
    return provider().getMailApiMode();
}

export function setMailApiMode(mode: string): void {
    provider().setMailApiMode(mode);
}

export function markEmailUsed(email: string): void {
    provider().markEmailUsed(email);
}

export function clearUsedEmails(): void {
    provider().clearUsedEmails();
}

export function createAbortController(): AbortController {
    return provider().createAbortController();
}

export function abortRegistration(): void {
    provider().abortRegistration();
}

export function getAbortSignal(): AbortSignal | undefined {
    return provider().getAbortSignal?.();
}

export function clearAccountCache(): void {
    provider().clearAccountCache();
}
