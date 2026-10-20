import { type ServerType, serve } from "@hono/node-server";
import type { Server } from "node:http";

export const LOOPBACK_HOST = "127.0.0.1";

export type PortOccupant = "extension" | "other-gateway" | "unknown";

export function portConflictMessage(
  port: number,
  occupant: PortOccupant,
): string {
  switch (occupant) {
    case "extension":
      return `Port ${port} is used by another Agent Gateway instance (probably another VS Code window). This gateway will take over automatically when it stops.`;
    case "other-gateway":
      return `Port ${port} is used by another local gateway. Stop it or change agentGateway.port; this extension retries automatically.`;
    default:
      return `Port ${port} is used by another process.`;
  }
}

export class PortConflictError extends Error {
  constructor(
    readonly port: number,
    readonly occupant: PortOccupant,
  ) {
    super(portConflictMessage(port, occupant));
    this.name = "PortConflictError";
  }
}

export interface Listener {
  port: number;
  address: string;
  close(): Promise<void>;
}

async function probeStatus(
  port: number,
  path: string,
  timeoutMs: number,
): Promise<{ status: number; body: unknown } | undefined> {
  try {
    const response = await fetch(`http://${LOOPBACK_HOST}:${port}${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    return { status: response.status, body };
  } catch {
    return undefined;
  }
}

/**
 * Identify who holds a port without disturbing it. The extension gateway answers
 * /health (200, or 401 when API-key protected); another local gateway that
 * serves /v1/models but returns 404 for /health and /v1/gateway/catalog.
 */
export async function probeOccupant(
  port: number,
  timeoutMs = 1500,
): Promise<PortOccupant> {
  const health = await probeStatus(port, "/health", timeoutMs);
  if (!health) {
    return "unknown";
  }
  const body = health.body as { bridgeVersion?: unknown } | undefined;
  if (
    health.status === 401 ||
    (health.status === 200 && typeof body?.bridgeVersion === "string")
  ) {
    return "extension";
  }
  if (health.status === 404) {
    const [models, catalog] = await Promise.all([
      probeStatus(port, "/v1/models", timeoutMs),
      probeStatus(port, "/v1/gateway/catalog", timeoutMs),
    ]);
    const data = (models?.body as { data?: unknown } | undefined)?.data;
    const modelsLike =
      (models?.status === 200 && Array.isArray(data)) || models?.status === 401;
    if (modelsLike && catalog?.status === 404) {
      return "other-gateway";
    }
  }
  return "unknown";
}

export function start(
  app: { fetch: (request: Request) => Response | Promise<Response> },
  port: number,
): Promise<Listener> {
  return new Promise((resolve, reject) => {
    let server: ServerType;
    const onError = (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        void probeOccupant(port).then((occupant) =>
          reject(new PortConflictError(port, occupant)),
        );
      } else {
        reject(error);
      }
    };
    server = serve(
      { fetch: app.fetch, port, hostname: LOOPBACK_HOST },
      (info) => {
        server.off("error", onError);
        const http = server as Server;
        http.headersTimeout = 30_000;
        // Streaming responses can legitimately run for many minutes.
        http.requestTimeout = 0;
        resolve({
          port: info.port,
          address: `http://${LOOPBACK_HOST}:${info.port}`,
          close: () =>
            new Promise<void>((done) => {
              http.closeAllConnections?.();
              http.close(() => done());
            }),
        });
      },
    );
    server.once("error", onError);
  });
}
