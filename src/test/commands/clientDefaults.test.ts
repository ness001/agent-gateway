import * as assert from "node:assert/strict";
import * as vscode from "vscode";

import { clineAdapter } from "../../clients/cline";
import { CLIENT_DEFAULTS, sharedDefaultModel } from "../../clients/defaults";
import { ALL_CLIENT_ADAPTERS } from "../../clients/index";
import { openclawAdapter } from "../../clients/openclawHermes";
import type {
  ClientAdapter,
  ClientConfigInput,
  GatewayModel,
} from "../../clients/types";
import {
  clientConfigState,
  runClientConfiguration,
} from "../../commands/clients";
import type { Gateway } from "../../gateway/gateway";

suite("shared client defaults", () => {
  const models: GatewayModel[] = ["z-model", "claude-model", "a-model"].map(
    (id) => ({
      id,
      displayName: id,
      contextWindow: 1000,
      inputModalities: ["text"],
      supportsToolCalling: true,
      reasoning: false,
    }),
  );
  const input: ClientConfigInput = {
    gatewayUrl: "http://127.0.0.1:24444",
    models,
    defaultModel: "claude-model",
    home: "/example",
    platform: "linux",
  };

  test("shared fallback does not depend on catalog order and honors saved selection", () => {
    assert.equal(sharedDefaultModel(models)?.id, "claude-model");
    assert.equal(sharedDefaultModel([...models].reverse())?.id, "claude-model");
    assert.equal(sharedDefaultModel(models, "z-model")?.id, "z-model");
  });

  test("invalid OpenClaw is not matching and reordered Cline settings are matching", () => {
    const openclawFile = openclawAdapter.configPaths(
      input.home,
      input.platform,
    )[0];
    assert.equal(
      clientConfigState(openclawAdapter, input, { [openclawFile]: "{" }),
      "invalid configuration",
    );
    const plan = clineAdapter.plan(input, {});
    const file = JSON.parse(plan.changes[0].after!);
    file.providers["openai-compatible"].settings = Object.fromEntries(
      Object.entries(file.providers["openai-compatible"].settings).reverse(),
    );
    assert.equal(
      clientConfigState(clineAdapter, input, {
        [plan.changes[0].path]: JSON.stringify(file),
      }),
      "up to date",
    );
  });

  for (const outcome of ["cancel", "failure", "success"] as const) {
    test(`shared choice is saved only after successful configuration: ${outcome}`, async () => {
      const adapters = ALL_CLIENT_ADAPTERS as ClientAdapter[];
      const originalAdapters = [...adapters];
      const quickPick = vscode.window.showQuickPick;
      const info = vscode.window.showInformationMessage;
      const error = vscode.window.showErrorMessage;
      const open = vscode.workspace.openTextDocument;
      const execute = vscode.commands.executeCommand;
      const writes: unknown[][] = [];
      let picker = 0;
      const adapter: ClientAdapter = {
        id: "test",
        label: "test",
        discovery: "auto",
        detectPaths: () => [],
        configPaths: () => [],
        plan: () => ({
          changes:
            outcome === "success"
              ? []
              : [
                  {
                    path: "nonexistent-defaults-test-file",
                    before: "old",
                    after: "new",
                  },
                ],
          summary: [],
        }),
        unplan: () => ({ changes: [], summary: [] }),
      };
      adapters.splice(0, adapters.length, adapter);
      Object.assign(vscode.window, {
        showQuickPick: async (items: unknown[]) =>
          ++picker === 1 ? [items[0]] : { label: "z-model" },
        showInformationMessage: async (
          _message: string,
          options: unknown,
          apply: string,
        ) => (options && outcome !== "cancel" ? apply : undefined),
        showErrorMessage: async () => undefined,
      });
      Object.assign(vscode.workspace, {
        openTextDocument: async () => ({
          uri: vscode.Uri.parse("untitled:defaults-test"),
        }),
      });
      Object.assign(vscode.commands, { executeCommand: async () => undefined });
      const context = {
        secrets: { get: async () => undefined },
        globalState: {
          get: () => "claude-model",
          update: async (...args: unknown[]) => {
            writes.push(args);
          },
        },
      } as unknown as vscode.ExtensionContext;
      const gateway = {
        port: 24444,
        nativeModels: () =>
          models.map((model) => ({ ...model, supportedReasoningLevels: [] })),
      } as unknown as Gateway;
      try {
        await runClientConfiguration(context, gateway, "configure");
        assert.deepEqual(
          writes,
          outcome === "success"
            ? [[CLIENT_DEFAULTS.modelStateKey, "z-model"]]
            : [],
        );
      } finally {
        adapters.splice(0, adapters.length, ...originalAdapters);
        Object.assign(vscode.window, {
          showQuickPick: quickPick,
          showInformationMessage: info,
          showErrorMessage: error,
        });
        Object.assign(vscode.workspace, { openTextDocument: open });
        Object.assign(vscode.commands, { executeCommand: execute });
      }
    });
  }
});
