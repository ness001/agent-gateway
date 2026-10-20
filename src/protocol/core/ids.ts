import { randomBytes } from "node:crypto";

export const ID_PREFIX = {
  anthropicMessage: "msg_",
  anthropicToolUse: "toolu_",
  anthropicServerToolUse: "srvtoolu_",
  response: "resp_",
  responseMessage: "msg_",
  functionCallItem: "fc_",
  callId: "call_",
  chatCompletion: "chatcmpl-",
  webSearchCall: "ws_",
  reasoning: "rs_",
  customToolCall: "ctc_",
  toolSearchCall: "tsc_",
} as const;

export type IdKind = keyof typeof ID_PREFIX;

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
let counter = 0;

/** Random base62 string of `len` chars (rejection sampling, no modulo bias). */
export function randomToken(len = 24): string {
  let out = "";
  while (out.length < len) {
    for (const b of randomBytes(len * 2)) {
      if (b < 248 && out.length < len) {
        out += ALPHABET[b % 62];
      }
    }
  }
  return out;
}

/** Prefix + base36 counter (4 chars, process-unique ordering) + random tail. */
export function newId(kind: IdKind, randomLen = 20): string {
  counter = (counter + 1) % 36 ** 4;
  return (
    ID_PREFIX[kind] +
    counter.toString(36).padStart(4, "0") +
    randomToken(randomLen)
  );
}

/** Regex matching ids produced by `newId(kind)`. */
export function idPattern(kind: IdKind): RegExp {
  const p = ID_PREFIX[kind].replace(/[-]/g, "\-");
  return new RegExp(`^${p}[0-9a-z]{4}[A-Za-z0-9]+$`);
}
