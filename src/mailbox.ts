import {createHotmailProvider} from "./mail/hotmail.js";

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

const provider = createHotmailProvider();

export async function getEmailAddress(): Promise<string> {
  return provider.getEmailAddress();
}

export async function getEmailVerificationCode(email: string): Promise<string> {
  return provider.getEmailVerificationCode(email);
}

export async function prepareOtpBaseline(email: string): Promise<void> {
  await provider.prepareOtpBaseline?.(email);
}

export function markVerificationCodeRejected(email: string, code: string): void {
  provider.markVerificationCodeRejected?.(email, code);
}

export function clearOtpPollState(email: string): void {
  provider.clearOtpPollState?.(email);
}

export function getAliasSuffix(): string {
  return provider.getAliasSuffix();
}

export async function setAliasSuffix(suffix: string): Promise<void> {
  return provider.setAliasSuffix(suffix);
}

export function getRandomAliasEnabled(): boolean {
  return provider.getRandomAliasEnabled();
}

export function setRandomAliasEnabled(enabled: boolean): void {
  provider.setRandomAliasEnabled(enabled);
}

export function getMailApiMode(): string {
  return provider.getMailApiMode();
}

export function setMailApiMode(mode: string): void {
  provider.setMailApiMode(mode);
}

export function markEmailUsed(email: string): void {
  provider.markEmailUsed(email);
}

export function clearUsedEmails(): void {
  provider.clearUsedEmails();
}

export function createAbortController(): AbortController {
  return provider.createAbortController();
}

export function abortRegistration(): void {
  provider.abortRegistration();
}

export function getAbortSignal(): AbortSignal | undefined {
  return provider.getAbortSignal?.();
}

export function clearAccountCache(): void {
  provider.clearAccountCache();
}
