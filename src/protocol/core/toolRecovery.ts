import type { Part, Turn } from "./types";

/** Match only the provider's missing-function-call rejection, never arbitrary IDs. */
export function recoverRejectedToolHistory(
  turns: readonly Turn[],
  error: unknown,
): Turn[] | undefined {
  const message = error instanceof Error ? error.message : "";
  const id =
    /No tool call found for function call output with call_id ([A-Za-z0-9_-]+)(?=[.\s"}]|$)/.exec(
      message,
    )?.[1];
  if (!id) {
    return undefined;
  }
  const hasCall = turns.some((t) =>
    t.parts.some((p) => p.type === "toolCall" && p.id === id),
  );
  const hasResult = turns.some((t) =>
    t.parts.some((p) => p.type === "toolResult" && p.callId === id),
  );
  if (!hasCall || !hasResult) {
    return undefined;
  }
  // Retain both sides as historical data. No new invocation is invented, no
  // tool is re-executed, and images/results are not silently discarded.
  return turns.map((turn) => ({
    ...turn,
    parts: turn.parts.flatMap((part): Part[] => {
      if (part.type === "toolCall" && part.id === id) {
        return [
          {
            type: "text",
            text: `[Historical tool call ${id}: ${part.name}]\n${JSON.stringify(part.input)}`,
          },
        ];
      }
      if (part.type === "toolResult" && part.callId === id) {
        return [
          {
            type: "text",
            text: `[Historical tool result ${id}${part.isError ? " (error)" : ""}]`,
          },
          ...part.content,
        ];
      }
      return [part];
    }),
  }));
}
