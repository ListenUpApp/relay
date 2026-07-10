export type Platform = "android" | "ios";

export interface DeviceToken {
  platform: Platform;
  token: string;
}

export interface SendRequest {
  tokens: DeviceToken[];
  payload: Record<string, unknown>; // opaque — the relay NEVER interprets it
  collapseKey?: string;
}

export type Verdict = "delivered" | "invalid" | "retryable" | "unsupported";

export interface SendResponse {
  results: { token: string; status: Verdict }[];
}

export const MAX_TOKENS = 20;
export const MAX_TOKEN_LENGTH = 4096;
export const MAX_PAYLOAD_BYTES = 4096;
export const MAX_COLLAPSE_KEY_LENGTH = 64;
