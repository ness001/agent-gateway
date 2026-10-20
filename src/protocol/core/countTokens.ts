import { classifyLmError } from "./errors";
import { type LmApi, toLmMessages } from "./lmRequest";
import type { CoreRequest, LmChatLike } from "./types";

/**
 * Sums `model.countTokens` over the rendered LM messages. Any failure is
 * classified and thrown as a GatewayError; no estimate is ever returned.
 */
export async function countTokens(
  api: LmApi,
  model: Pick<LmChatLike, "countTokens">,
  req: CoreRequest,
  token?: unknown,
): Promise<number> {
  const messages = toLmMessages(api, req);
  let total = 0;
  try {
    for (const m of messages) {
      const n = await model.countTokens(m, token);
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
        throw new Error("countTokens returned an invalid value");
      }
      total += n;
    }
  } catch (err) {
    throw classifyLmError(err);
  }
  return total;
}
