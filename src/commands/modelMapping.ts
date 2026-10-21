import * as vscode from "vscode";

import type { Gateway } from "../gateway/gateway";
import {
  DEFAULT_MAPPING_SOURCES,
  mappingCandidates,
  mappingPrompt,
  mappingSources,
  parseMappings,
} from "../gateway/modelMapping";
import { CONFIG_SECTION } from "../utils/config";

/** Generate and review explicit modelAliases without changing the fallback. */
export async function initializeModelMappings(
  gw: Pick<Gateway, "nativeModels">,
): Promise<void> {
  try {
    const candidates = mappingCandidates(gw.nativeModels());
    if (!candidates.length) {
      throw new Error(
        "No local tool-capable models are available for mapping.",
      );
    }
    const text = await vscode.window.showInputBox({
      title: "Initialize model mappings with AI",
      prompt: "Requested model IDs to map (exact IDs; comma-separated).",
      value: DEFAULT_MAPPING_SOURCES,
      validateInput: (value) => {
        try {
          mappingSources(value);
          return undefined;
        } catch (e) {
          return (e as Error).message;
        }
      },
      ignoreFocusOut: true,
    });
    if (text === undefined) {
      return;
    }
    const sources = mappingSources(text);
    const models = await vscode.lm.selectChatModels({ vendor: "copilot" });
    const advisor = await vscode.window.showQuickPick(
      models
        .filter((m) => candidates.some((c) => c.id === m.id))
        .map((model) => ({ label: model.name, description: model.id, model })),
      {
        title: "Choose AI to recommend mappings",
        placeHolder:
          "Uses Copilot quota. Sends only requested IDs and model metadata; no files or chat history.",
        ignoreFocusOut: true,
      },
    );
    if (!advisor) {
      return;
    }
    const snapshot = JSON.stringify(
      vscode.workspace.getConfiguration(CONFIG_SECTION).get("modelAliases", {}),
    );
    const response = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Suggesting model mappings",
        cancellable: true,
      },
      async (_progress, token) => {
        const cancellation = new vscode.CancellationTokenSource();
        const subscription = token.onCancellationRequested(() =>
          cancellation.cancel(),
        );
        if (token.isCancellationRequested) {
          cancellation.cancel();
        }
        const timeout = setTimeout(() => cancellation.cancel(), 60000);
        try {
          if (cancellation.token.isCancellationRequested) {
            return undefined;
          }
          const result = await advisor.model.sendRequest(
            [
              vscode.LanguageModelChatMessage.User(
                mappingPrompt(sources, candidates),
              ),
            ],
            {
              justification:
                "Recommend model aliases for Agent Gateway; user reviews before saving.",
              modelOptions: { max_tokens: 4096 },
            },
            cancellation.token,
          );
          let answer = "";
          for await (const chunk of result.text) {
            if (cancellation.token.isCancellationRequested) {
              return undefined;
            }
            answer += chunk;
            if (answer.length > 32000) {
              cancellation.cancel();
              throw new Error("AI mapping response is too large.");
            }
          }
          return cancellation.token.isCancellationRequested
            ? undefined
            : answer;
        } catch (error) {
          if (cancellation.token.isCancellationRequested) {
            return undefined;
          }
          throw error;
        } finally {
          clearTimeout(timeout);
          subscription.dispose();
          cancellation.dispose();
        }
      },
    );
    if (response === undefined) {
      return;
    }
    const suggestions = parseMappings(response, sources, gw.nativeModels());
    const existing = JSON.parse(snapshot) as Record<string, string>;
    const picked = await vscode.window.showQuickPick(
      suggestions.map((mapping) => ({
        label: `${mapping.source} → ${mapping.target}`,
        description: Object.hasOwn(existing, mapping.source)
          ? `Existing: ${existing[mapping.source] || "disabled"}; replace only if selected`
          : "New mapping",
        detail: mapping.reason,
        picked: !Object.hasOwn(existing, mapping.source),
        mapping,
      })),
      {
        title: "Review AI suggestions — select mappings to save",
        placeHolder:
          "Suggestions are not benchmarks. Existing mappings are unchecked; Esc saves nothing.",
        canPickMany: true,
        ignoreFocusOut: true,
      },
    );
    if (!picked?.length) {
      return;
    }
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const current = config.get<Record<string, string>>("modelAliases", {});
    if (JSON.stringify(current) !== snapshot) {
      throw new Error(
        "Mappings changed while AI was running. Run the command again to review current settings.",
      );
    }
    // Revalidate availability after the review, without exposing raw model output.
    parseMappings(
      JSON.stringify({ mappings: picked.map((p) => p.mapping) }),
      picked.map((p) => p.mapping.source),
      gw.nativeModels(),
    );
    const aliases = { ...current };
    for (const { mapping } of picked) {
      aliases[mapping.source] = mapping.target;
    }
    const inspected = config.inspect("modelAliases");
    await config.update(
      "modelAliases",
      aliases,
      inspected?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global,
    );
    void vscode.window.showInformationMessage(
      `Saved ${picked.length} model mappings. Fallback model unchanged; no gateway restart needed.`,
    );
  } catch {
    // Provider errors can contain request data: keep notifications generic.
    void vscode.window.showErrorMessage(
      "Model mapping initialization failed. Check model availability/access and retry. No mapping update was confirmed.",
    );
  }
}
