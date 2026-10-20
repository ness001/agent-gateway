import * as path from "path";

import { ClientAdapter, ClientPlan, PLACEHOLDER_API_KEY } from "./types";

function homeJoin(
  home: string,
  platform: NodeJS.Platform,
  ...parts: string[]
): string {
  return platform === "win32"
    ? path.win32.join(home, ...parts)
    : path.posix.join(home, ...parts);
}

function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "[::1]" ||
      host === "::1" ||
      host === "0.0.0.0" ||
      host.startsWith("127.")
    );
  } catch {
    return false;
  }
}

export const cursorAdapter: ClientAdapter = {
  id: "cursor",
  label: "Cursor",
  discovery: "manual",
  caveat:
    "Cursor routes BYOK requests through its own servers, so the gateway must be publicly reachable (dev tunnel).",
  detectPaths(home, platform) {
    if (platform === "win32") {
      return [path.win32.join(home, "AppData", "Roaming", "Cursor")];
    }
    if (platform === "darwin") {
      return [
        path.posix.join(home, "Library", "Application Support", "Cursor"),
      ];
    }
    return [path.posix.join(home, ".config", "Cursor")];
  },
  configPaths() {
    return [];
  },
  plan(input): ClientPlan {
    const baseUrl = `${input.gatewayUrl}/v1`;
    const loopback = isLoopback(input.gatewayUrl);
    const ids = input.models.map((m) => m.id);
    const steps: string[] = [];
    if (loopback) {
      steps.push(
        `WARNING: ${input.gatewayUrl} is a loopback address. Cursor sends BYOK requests via its servers and cannot reach it. Run 'Agent Gateway: Share Gateway via Dev Tunnel' and use that public URL + /v1 instead.`,
      );
    }
    steps.push(
      `Open Cursor Settings > Models and set OpenAI API Key = ${input.apiKey ? "<your gateway API key>" : PLACEHOLDER_API_KEY}.`,
      `Enable "Override OpenAI Base URL" and set it to ${loopback ? "<PUBLIC dev tunnel URL>/v1" : baseUrl}.`,
      "Cursor sends BYOK requests via its servers, so a 127.0.0.1 gateway URL will not work; use 'Agent Gateway: Share Gateway via Dev Tunnel' and paste that URL.",
      `Click "+ Add model" for each id: ${ids.join(", ")}.`,
    );
    return {
      changes: [],
      summary: [
        loopback
          ? `Cursor: manual setup; gateway URL ${input.gatewayUrl} is loopback and will NOT work from Cursor - share it via Dev Tunnel first.`
          : `Cursor: manual setup with base URL ${baseUrl} and ${ids.length} model(s).`,
      ],
      manualSteps: steps,
      clipboard: [`Base URL: ${baseUrl}`, "Models:", ...ids, ""].join("\n"),
    };
  },
  unplan(): ClientPlan {
    return {
      changes: [],
      summary: ["Cursor: no files were changed; nothing to revert."],
      manualSteps: [
        'In Cursor Settings > Models, disable "Override OpenAI Base URL", clear the OpenAI API Key and remove the added gateway models.',
      ],
    };
  },
};
