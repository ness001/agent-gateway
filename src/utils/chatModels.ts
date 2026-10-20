import * as vscode from "vscode";

import { logger } from "./logger";

const SUPPORTED_VENDOR = "copilot";

class ChatModelsCache {
  private static instance: ChatModelsCache;
  private cachedModels: vscode.LanguageModelChat[] = [];
  private initializationPromise: Promise<void> | null = null;

  private constructor() {}

  static getInstance(): ChatModelsCache {
    if (!ChatModelsCache.instance) {
      ChatModelsCache.instance = new ChatModelsCache();
    }
    return ChatModelsCache.instance;
  }

  async initialize(): Promise<void> {
    if (this.cachedModels.length > 0) {
      return;
    }

    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    this.initializationPromise = (async () => {
      try {
        this.cachedModels = await vscode.lm.selectChatModels({
          vendor: SUPPORTED_VENDOR,
        });
        logger.info(`Loaded ${this.cachedModels.length} Copilot chat models`);
      } catch (error) {
        logger.error("Failed to load Copilot chat models:", error);
        this.cachedModels = [];
      } finally {
        this.initializationPromise = null;
      }
    })();

    return this.initializationPromise;
  }

  async getChatModels(): Promise<vscode.LanguageModelChat[]> {
    if (this.cachedModels.length > 0) {
      return this.cachedModels;
    }

    await this.initialize();
    return this.cachedModels;
  }

  async refresh(): Promise<void> {
    this.cachedModels = [];
    this.initializationPromise = null;
    await this.initialize();
  }

  getCachedModels(): vscode.LanguageModelChat[] {
    return this.cachedModels;
  }
}

export const chatModelsCache = ChatModelsCache.getInstance();

export type CopilotReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | (string & {});

export interface CopilotModelConfiguration {
  /** Prompt/input token budget used by Copilot for this request. */
  contextSize?: number;
  /** Thinking/reasoning effort level, validated by Copilot against the selected model. */
  reasoningEffort?: CopilotReasoningEffort;
  [key: string]: unknown;
}

interface ChatRequestOptionsWithConfig
  extends vscode.LanguageModelChatRequestOptions {
  configuration?: CopilotModelConfiguration;
}

export function getCopilotModelConfiguration({
  reasoningEffort,
}: {
  reasoningEffort?: unknown;
}): CopilotModelConfiguration {
  const configuration: CopilotModelConfiguration = {};
  if (typeof reasoningEffort === "string" && reasoningEffort.trim()) {
    configuration.reasoningEffort = reasoningEffort.trim();
  }
  return configuration;
}

/**
 * Copilot derives the upstream `prompt_cache_key` from
 * `modelOptions._conversationId`; without it, requests from the same client
 * session are not routed to a shared prompt cache.
 */
export function withCopilotConversationId(
  modelOptions: Record<string, unknown>,
  promptCacheKey: unknown,
): Record<string, unknown> {
  // The key is an opaque client identifier, so forward it verbatim.
  if (typeof promptCacheKey === "string" && promptCacheKey.trim()) {
    modelOptions._conversationId = promptCacheKey;
  }
  return modelOptions;
}

/**
 * VS Code stores provider-specific model configuration separately from public
 * `modelOptions`. Copilot reads this bag for settings like context size and
 * reasoning effort.
 */
export function withCopilotConfiguration(
  client: vscode.LanguageModelChat,
  options: vscode.LanguageModelChatRequestOptions,
  configuration: CopilotModelConfiguration = {},
): vscode.LanguageModelChatRequestOptions {
  if (client.vendor !== SUPPORTED_VENDOR || client.maxInputTokens <= 0) {
    return options;
  }

  // Copilot treats contextSize as the prompt/input budget; response tokens stay
  // controlled separately by max_tokens/max_output_tokens in modelOptions.
  const contextSize = client.maxInputTokens;
  const copilotConfiguration: CopilotModelConfiguration = {
    ...configuration,
    contextSize,
  };

  logger.debug(
    `Setting Copilot configuration for ${client.id}: contextSize=${copilotConfiguration.contextSize}, reasoningEffort=${copilotConfiguration.reasoningEffort ?? "default"}`,
  );

  return {
    ...options,
    configuration: copilotConfiguration,
  } as ChatRequestOptionsWithConfig;
}

export type ChatModelClientResult =
  | { client: vscode.LanguageModelChat; error?: undefined }
  | {
      client?: undefined;
      error: { error: { message: string; type: string } };
    };

/**
 * Resolves an exact local Copilot model ID only. Alias and fallback rules are
 * applied by the gateway before routes call this.
 */
export const getChatModelClient = async (
  modelId: string,
): Promise<ChatModelClientResult> => {
  const models = await chatModelsCache.getChatModels();
  const client = models.find((model) => model.id === modelId);
  if (client) {
    return { client };
  }

  logger.warn(`No VS Code LM model available for model ID: ${modelId}`);
  return {
    error: {
      error: {
        message: `Model '${modelId}' not found. Use GET /v1/models to list available models.`,
        type: "invalid_request_error",
      },
    },
  };
};
