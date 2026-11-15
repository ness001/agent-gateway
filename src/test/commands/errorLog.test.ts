import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

import { openErrorLog } from "../../commands/status";
import type { Gateway } from "../../gateway/gateway";

suite("commands/error log", () => {
  let dir: string;
  const showTextDocument = vscode.window.showTextDocument;
  const showInformationMessage = vscode.window.showInformationMessage;
  const executeCommand = vscode.commands.executeCommand;
  let opened: (vscode.Uri | vscode.TextDocument)[];
  let commands: string[];
  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-error-log-"));
    opened = [];
    commands = [];
    Object.assign(vscode.window, {
      showTextDocument: async (target: vscode.Uri | vscode.TextDocument) => {
        opened.push(target);
      },
      showInformationMessage: async () => undefined,
    });
    Object.assign(vscode.commands, {
      executeCommand: async (command: string) => {
        commands.push(command);
      },
    });
  });
  teardown(async () => {
    Object.assign(vscode.window, { showTextDocument, showInformationMessage });
    Object.assign(vscode.commands, { executeCommand });
    await fs.rm(dir, { recursive: true, force: true });
  });
  const gateway = (directory: string) =>
    ({
      errorJournal: { logDirectory: directory, flush: async () => undefined },
    }) as unknown as Gateway;

  test("opens the latest existing log in VS Code when today has no file", async () => {
    await fs.writeFile(path.join(dir, "errors-2025-01-01.jsonl"), "{}\n");
    await fs.writeFile(path.join(dir, "errors-2025-01-02.jsonl"), "{}\n");
    await fs.writeFile(path.join(dir, "unrelated.jsonl"), "{}");
    await openErrorLog(gateway(dir));
    assert.equal(opened.length, 1);
    assert.equal(
      (opened[0] as vscode.Uri).fsPath,
      vscode.Uri.file(path.join(dir, "errors-2025-01-02.jsonl")).fsPath,
    );
    assert.deepEqual(commands, []);
  });
  test("prefers today's log", async () => {
    const name = `errors-${new Date().toISOString().slice(0, 10)}.jsonl`;
    await fs.writeFile(path.join(dir, name), "{}\n");
    await openErrorLog(gateway(dir));
    assert.equal(
      (opened[0] as vscode.Uri).fsPath,
      vscode.Uri.file(path.join(dir, name)).fsPath,
    );
  });
  test("opens an empty editor document when no log exists", async () => {
    await openErrorLog(gateway(path.join(dir, "not-created")));
    assert.equal(opened.length, 1);
    const document = opened[0] as vscode.TextDocument;
    assert.equal(document.uri.scheme, "untitled");
    assert.equal(document.getText(), "");
    assert.deepEqual(commands, []);
  });
});
