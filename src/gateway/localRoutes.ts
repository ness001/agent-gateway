import type * as vscode from "vscode";

/** Dependencies for the local (Copilot) model routes; structurally ProtocolDeps. */
export interface LocalRoutesDeps {
  getLocalModel(id: string): vscode.LanguageModelChat | undefined;
  /** `agentGateway.webSearch.maxSearchesPerRequest`. */
  maxSearchesPerRequest: number;
  /**
   * Hosted search/fetch engines, built per request so a key stored with the
   * setup command applies without a restart. Undefined when the provider is `none`.
   */
  getHostedEngines?: () => Promise<
    import("../protocol/hosted/types").HostedEngines | undefined
  >;
  /** `agentGateway.webSearch.model`. */
  getWebSearchModel?: () => string | undefined;
  logger?: import("../protocol/core/types").CoreLogger;
  noteRequestError?: (kind: string, providerCode?: string) => void;
}

type Handler = (request: Request) => Promise<Response>;

/** Local model handler: every request goes to the protocol core. */
export function createLocalHandler(deps: LocalRoutesDeps): Handler {
  let core: typeof import("../protocol") | undefined;
  return (request) => {
    core ??= require("../protocol") as typeof import("../protocol");
    return core.handle(request, deps);
  };
}
