export {DEFAULT_USER_AGENT} from "./device-profile.js";

export const AUTH_BASE_URL = "https://auth.openai.com";

export const AUTH_AUTHORIZE_CONTINUE_URL =
  "https://auth.openai.com/api/accounts/authorize/continue";

export const AUTH_EMAIL_OTP_VALIDATE_URL =
  "https://auth.openai.com/api/accounts/email-otp/validate";

export const AUTH_REGISTER_URL =
  "https://auth.openai.com/api/accounts/user/register";

export const AUTH_EMAIL_OTP_SEND_URL =
  "https://auth.openai.com/api/accounts/email-otp/send";

export const CHATGPT_BASE_URL = "https://chatgpt.com";

export const CHATGPT_AUTH_CSRF_URL = "https://chatgpt.com/api/auth/csrf";

/** Platform OAuth client (oumiFree / Codex RT flow) */
export const PLATFORM_OAUTH_CLIENT_ID = "app_2SKx67EdpoN0G6j64rFvigXD";
export const PLATFORM_OAUTH_REDIRECT_URI =
  "https://platform.openai.com/auth/callback";
export const PLATFORM_OAUTH_AUDIENCE = "https://api.openai.com/v1";
export const PLATFORM_OAUTH_AUTH0_CLIENT =
  "eyJuYW1lIjoiYXV0aDAtc3BhLWpzIiwidmVyc2lvbiI6IjEuMjEuMCJ9";
export const AUTH_OAUTH_AUTHORIZE_URL =
  "https://auth.openai.com/api/accounts/authorize";
export const AUTH_OAUTH_TOKEN_URL =
  "https://auth.openai.com/api/accounts/oauth/token";
