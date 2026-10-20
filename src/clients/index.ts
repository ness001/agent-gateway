import { antigravityAdapter } from "./antigravity";
import { claudeCodeAdapter } from "./claudeCode";
import { clineAdapter } from "./cline";
import { codexAdapter } from "./codex";
import { cursorAdapter } from "./cursor";
import { deepseekHarnessAdapter } from "./deepseekHarness";
import { kiloAdapter } from "./kilo";
import { ompAdapter, piAdapter } from "./ompPi";
import { hermesAdapter, openclawAdapter } from "./openclawHermes";
import type { ClientAdapter } from "./types";

export const ALL_CLIENT_ADAPTERS: readonly ClientAdapter[] = [
  codexAdapter,
  claudeCodeAdapter,
  ompAdapter,
  piAdapter,
  openclawAdapter,
  hermesAdapter,
  kiloAdapter,
  clineAdapter,
  deepseekHarnessAdapter,
  antigravityAdapter,
  cursorAdapter,
];

export const DISCOVERY_LABELS: Record<ClientAdapter["discovery"], string> = {
  auto: "auto discovery",
  static: "writes model list",
  single: "single model",
  manual: "manual steps",
};
