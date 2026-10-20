export const DEV_PORT = 24445;

export const LLM_API_KEY_SECRET_KEY = "agentGateway.apiKey";

export const EXA_API_KEY_SECRET_KEY = "agentGateway.exaApiKey";

const WEB_SEARCH_KEY_SECRET_PREFIX = "agentGateway.webSearchApiKey.";

/** Exa keeps its original secret name so keys stored before engines existed still work. */
export const webSearchApiKeySecretKey = (engine: string): string =>
  engine === "exa"
    ? EXA_API_KEY_SECRET_KEY
    : `${WEB_SEARCH_KEY_SECRET_PREFIX}${engine}`;

export const REMOTE_API_KEY_SECRET_PREFIX = "agentGateway.remoteApiKey.";

export const remoteApiKeySecretKey = (name: string): string =>
  `${REMOTE_API_KEY_SECRET_PREFIX}${name}`;
