import type { HostedEngines, WebSearchEngineId } from "../types";
import type { Engine, EngineDeps, EngineFactory } from "./engine";
import { createExaEngine } from "./exa";
import { createFirecrawlEngine } from "./firecrawl";
import { createJinaEngine } from "./jina";
import { createTavilyEngine } from "./tavily";
import { createYouEngine } from "./you";

export const ENGINE_FACTORIES: Record<WebSearchEngineId, EngineFactory> = {
  exa: createExaEngine,
  firecrawl: createFirecrawlEngine,
  tavily: createTavilyEngine,
  jina: createJinaEngine,
  you: createYouEngine,
};

export function createEngine(id: WebSearchEngineId, deps: EngineDeps): Engine {
  return ENGINE_FACTORIES[id](deps);
}

/**
 * Builds `HostedEngines` from the provider setting; `none` (the default)
 * yields undefined so no service is contacted.
 */
export function createHostedEngines(
  provider: WebSearchEngineId | "none" | undefined,
  deps: EngineDeps,
  maxSearchesPerRequest: number,
): HostedEngines | undefined {
  if (!provider || provider === "none" || !(provider in ENGINE_FACTORIES)) {
    return undefined;
  }
  const e = createEngine(provider, deps);
  return { search: e, fetch: e, maxSearchesPerRequest };
}
