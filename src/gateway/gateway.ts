import * as vscode from "vscode";

import { createHostedEngines } from "../protocol/hosted/engines";
import type { HostedEngines } from "../protocol/hosted/types";
import { type GatewayConfiguration, readConfiguration } from "../utils/config";
import {
  DEV_PORT,
  LLM_API_KEY_SECRET_KEY,
  remoteApiKeySecretKey,
  webSearchApiKeySecretKey,
} from "../utils/constant";
import { logger } from "../utils/logger";
import { createGatewayApp } from "./app";
import { buildRegistry, summarizeModels } from "./catalog";
import { BUILD_TIME, IS_DEV_VARIANT } from "./devVariant";
import { dedupeModels, toModelInfo, validateModelInfo } from "./discovery";
import { ErrorJournal } from "./errorJournal";
import {
  type GatewayStatus,
  type HealthSnapshot,
  sanitizeError,
} from "./health";
import {
  type Listener,
  PortConflictError,
  type PortOccupant,
  start,
} from "./listen";
import { createLocalHandler } from "./localRoutes";
import { resolveFallbackModel } from "./match";
import { discoverRemote } from "./remote";
import { parseRemoteUpstreams } from "./remoteConfig";
import type {
  CatalogEntry,
  ModelInfo,
  RemoteState,
  RemoteUpstreamConfig,
} from "./types";

export const COPILOT_CHAT_EXTENSION_ID = "github.copilot-chat";
export const PORT_RETRY_INTERVAL_MS = 5_000;

export interface PortConflictInfo {
  port: number;
  occupant: PortOccupant;
  message: string;
}

const WAIT_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000, 60_000];

export class Gateway implements vscode.Disposable {
  private status: GatewayStatus = "Starting";
  private listener: Listener | undefined;
  private localModels = new Map<string, vscode.LanguageModelChat>();
  private localInfos: ModelInfo[] = [];
  private remoteModels: { name: string; models: ModelInfo[] }[] = [];
  private remoteStates: RemoteState[] = [];
  private remotes: RemoteUpstreamConfig[] = [];
  private registry: CatalogEntry[] = [];
  private lastDiscoveryTime: Date | undefined;
  private lastStartupError: string | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private retryIndex = 0;
  private bindTimer: NodeJS.Timeout | undefined;
  private conflict: PortConflictInfo | undefined;
  private generation = 0;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly statusEmitter = new vscode.EventEmitter<GatewayStatus>();
  readonly onDidChangeStatus = this.statusEmitter.event;
  private readonly conflictEmitter =
    new vscode.EventEmitter<PortConflictInfo>();
  /** Fires once each time the gateway enters the port-conflict state. */
  readonly onDidEnterPortConflict = this.conflictEmitter.event;

  private readonly readConfig: () => GatewayConfiguration;
  private readonly portRetryMs: number;
  /** Lives across restarts so /health keeps recent failures. */
  readonly errorJournal: ErrorJournal;

  constructor(
    private readonly context: vscode.ExtensionContext,
    options: {
      readConfig?: () => GatewayConfiguration;
      portRetryMs?: number;
    } = {},
  ) {
    this.readConfig = options.readConfig ?? readConfiguration;
    this.portRetryMs = options.portRetryMs ?? PORT_RETRY_INTERVAL_MS;
    // logUri is the extension's own VS Code log folder; never the workspace.
    this.errorJournal = new ErrorJournal(context.logUri?.fsPath);
    this.disposables.push(
      this.statusEmitter,
      this.conflictEmitter,
      vscode.lm.onDidChangeChatModels(() => {
        void this.discoverLocal();
      }),
    );
  }

  get state(): GatewayStatus {
    return this.status;
  }

  get address(): string | undefined {
    return this.listener?.address;
  }

  get port(): number | undefined {
    return this.listener?.port;
  }

  async start(): Promise<void> {
    const generation = ++this.generation;
    const config = this.readConfig();
    logger.setLevel(config.logLevel);
    this.lastStartupError = undefined;
    if (!config.enabled) {
      // Rollback path: never hold the port while disabled.
      await this.stop();
      logger.info("Gateway disabled by setting; listener stopped.");
      this.setStatus("Disabled");
      return;
    }
    this.setStatus("Starting");
    try {
      await this.discoverLocal();
      await this.discoverRemotes(config);
      if (generation !== this.generation) {
        return;
      }
      const port = IS_DEV_VARIANT ? DEV_PORT : config.port;
      const app = createGatewayApp({
        getRegistry: () => this.registry,
        getLocalModels: () => this.localInfos,
        handleLocal: createLocalHandler({
          getLocalModel: (id) => this.localModels.get(id),
          maxSearchesPerRequest: config.webSearch.maxSearchesPerRequest,
          getHostedEngines: () => this.createHostedEngines(),
          getWebSearchModel: () => this.readConfig().webSearch.model,
        }),
        getRemote: (name) => this.remotes.find((r) => r.name === name),
        getRemoteStates: () => this.remoteStates,
        getRemoteApiKey: async (name) =>
          (await this.context.secrets.get(remoteApiKeySecretKey(name))) ||
          undefined,
        getApiKey: async () =>
          (await this.context.secrets.get(LLM_API_KEY_SECRET_KEY)) || undefined,
        getHealth: () => this.health(),
        errorJournal: this.errorJournal,
        getWebSearchModel: () => this.readConfig().webSearch.model,
        getModelAliases: () => this.readConfig().modelAliases,
        getFallbackModel: () => this.readConfig().fallbackModel,
        logger,
      });
      await this.bind(app, port, generation);
    } catch (error) {
      this.fail(error);
    }
  }

  get portConflict(): PortConflictInfo | undefined {
    return this.conflict;
  }

  /** Bind the listener; on a port conflict, keep retrying until stop/restart/disable. */
  private async bind(
    app: Parameters<typeof start>[0],
    port: number,
    generation: number,
  ): Promise<void> {
    try {
      this.listener = await start(app, port);
    } catch (error) {
      if (generation !== this.generation) {
        return;
      }
      if (!(error instanceof PortConflictError)) {
        throw error;
      }
      const message = sanitizeError(error.message);
      this.lastStartupError = message;
      const entering =
        this.conflict === undefined ||
        this.conflict.occupant !== error.occupant;
      if (entering) {
        this.conflict = { port, occupant: error.occupant, message };
        logger.warn(`${message} Retrying every ${this.portRetryMs / 1000} s.`);
        this.setStatus("Port conflict");
        this.conflictEmitter.fire(this.conflict);
      }
      this.bindTimer = setTimeout(() => {
        this.bindTimer = undefined;
        if (generation !== this.generation) {
          return;
        }
        void this.bind(app, port, generation).catch((e) => this.fail(e));
      }, this.portRetryMs);
      return;
    }
    if (generation !== this.generation) {
      await this.listener.close();
      this.listener = undefined;
      return;
    }
    const recovered = this.conflict !== undefined;
    this.conflict = undefined;
    this.lastStartupError = undefined;
    logger.info(
      `Gateway ${this.bridgeVersion()} listening on ${this.listener.address}${recovered ? " (port conflict resolved)" : ""}`,
    );
    for (const line of summarizeModels(
      this.registry,
      this.readConfig().fallbackModel,
    )) {
      logger.info(line);
    }
    this.updateReadiness();
  }

  private fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.lastStartupError = sanitizeError(message);
    this.setStatus("Error");
    logger.error(`Gateway startup failed: ${this.lastStartupError}`);
  }

  async stop(): Promise<void> {
    this.generation++;
    this.clearRetry();
    if (this.bindTimer) {
      clearTimeout(this.bindTimer);
      this.bindTimer = undefined;
    }
    this.conflict = undefined;
    const listener = this.listener;
    this.listener = undefined;
    await listener?.close();
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  /** Re-read the log level without restarting. */
  applyLogLevel(): void {
    logger.setLevel(this.readConfig().logLevel);
  }

  health(): HealthSnapshot {
    const copilot = vscode.extensions.getExtension(COPILOT_CHAT_EXTENSION_ID);
    return {
      status: this.status,
      bridgeVersion: this.bridgeVersion(),
      buildTime: BUILD_TIME,
      listener: {
        active: this.listener !== undefined,
        address: this.listener?.address ?? null,
      },
      vscodeVersion: vscode.version,
      copilot: {
        installed: copilot !== undefined,
        active: copilot?.isActive ?? false,
      },
      modelCount: this.localInfos.length,
      lastDiscoveryTime: this.lastDiscoveryTime?.toISOString() ?? null,
      lastStartupError: this.lastStartupError ?? null,
      remotes: this.remoteStates,
      ...this.fallbackHealth(),
      errors: {
        counts: this.errorJournal.countsByKind(),
        recent: this.errorJournal.recentErrors(),
      },
    };
  }

  private fallbackHealth(): Pick<
    HealthSnapshot,
    "fallbackModel" | "fallbackModelSource"
  > {
    const choice = resolveFallbackModel(this.registry, {
      fallbackModel: this.readConfig().fallbackModel,
    });
    return {
      fallbackModel: choice?.entry.id ?? null,
      fallbackModelSource: choice?.source ?? null,
    };
  }

  /** Native (non-alias) registry entries, local and remote. */
  nativeModels(): CatalogEntry[] {
    return this.registry.filter((e) => !e.isAlias);
  }

  remoteNames(): string[] {
    return parseRemoteUpstreams(
      this.readConfig().remoteUpstreams,
    ).upstreams.map((r) => r.name);
  }

  dispose(): void {
    void this.stop();
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  private bridgeVersion(): string {
    return String(this.context.extension.packageJSON.version ?? "unknown");
  }

  private async discoverLocal(): Promise<void> {
    let models: vscode.LanguageModelChat[] = [];
    try {
      models = await vscode.lm.selectChatModels({ vendor: "copilot" });
    } catch (error) {
      logger.warn(
        `Copilot model discovery failed: ${sanitizeError(error instanceof Error ? error.message : String(error))}`,
      );
    }
    const infos: ModelInfo[] = [];
    const byId = new Map<string, vscode.LanguageModelChat>();
    for (const model of dedupeModels(models)) {
      try {
        infos.push(toModelInfo(model as never));
        byId.set(model.id, model);
      } catch (error) {
        logger.warn(
          `Skipping model ${JSON.stringify(model.id)}: ${error instanceof Error ? error.message : "invalid metadata"}`,
        );
      }
    }
    const previous = this.localInfos.length;
    this.localModels = byId;
    this.localInfos = infos;
    this.lastDiscoveryTime = new Date();
    this.rebuildRegistry();
    if (infos.length !== previous) {
      logger.info(`Discovered ${infos.length} Copilot model(s).`);
    }
    if (this.listener) {
      this.updateReadiness();
    }
  }

  private async discoverRemotes(config: GatewayConfiguration): Promise<void> {
    const { upstreams, errors } = parseRemoteUpstreams(config.remoteUpstreams);
    for (const message of errors) {
      logger.warn(`remoteUpstreams: ${message}`);
    }
    this.remotes = upstreams;
    const results = await Promise.all(
      upstreams.map(async (remote) =>
        discoverRemote(remote, {
          apiKey:
            (await this.context.secrets.get(
              remoteApiKeySecretKey(remote.name),
            )) || undefined,
          validate: validateModelInfo,
        }),
      ),
    );
    this.remoteStates = results.map((r) => r.state);
    this.remoteModels = results
      .filter((r) => r.state.status === "ready")
      .map((r) => ({ name: r.state.name, models: r.models }));
    for (const state of this.remoteStates) {
      if (state.status === "ready") {
        logger.info(
          `Remote ${JSON.stringify(state.name)}: ${state.modelCount} model(s).`,
        );
      } else {
        logger.warn(
          `Remote ${JSON.stringify(state.name)} skipped: ${state.reason}`,
        );
      }
    }
    this.rebuildRegistry();
  }

  private rebuildRegistry(): void {
    try {
      this.registry = buildRegistry(this.localInfos, this.remoteModels);
    } catch (error) {
      logger.error(
        `Catalogue build failed: ${sanitizeError(error instanceof Error ? error.message : String(error))}`,
      );
      this.registry = buildRegistry(this.localInfos, []);
    }
  }

  /**
   * Hosted engines for the protocol core, from the current settings and
   * the SecretStorage key (read per request, never logged).
   */
  private async createHostedEngines(): Promise<HostedEngines | undefined> {
    const config = this.readConfig();
    const engine = config.webSearch.provider;
    if (!engine || engine === "none") {
      return undefined;
    }
    const apiKey =
      (await this.context.secrets.get(webSearchApiKeySecretKey(engine))) ||
      undefined;
    return createHostedEngines(
      engine,
      { apiKey },
      config.webSearch.maxSearchesPerRequest,
    );
  }

  private updateReadiness(): void {
    if (this.localInfos.length > 0) {
      this.clearRetry();
      this.retryIndex = 0;
      this.setStatus("Ready");
      return;
    }
    this.setStatus("Waiting for Copilot");
    if (
      this.retryTimer === undefined &&
      this.retryIndex < WAIT_RETRY_DELAYS_MS.length
    ) {
      const delay = WAIT_RETRY_DELAYS_MS[this.retryIndex++];
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        void this.discoverLocal();
      }, delay);
    }
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  private setStatus(status: GatewayStatus): void {
    if (status !== this.status) {
      this.status = status;
      logger.info(`Gateway status: ${status}`);
      this.statusEmitter.fire(status);
    }
  }
}
