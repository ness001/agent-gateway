import type { RemoteUpstreamConfig } from "./types";

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function parseRemoteUpstreams(value: unknown): {
  upstreams: RemoteUpstreamConfig[];
  errors: string[];
} {
  const upstreams: RemoteUpstreamConfig[] = [];
  const errors: string[] = [];
  if (value === undefined || value === null) {
    return { upstreams, errors };
  }
  if (!Array.isArray(value)) {
    return { upstreams, errors: ["remoteUpstreams must be an array."] };
  }
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    const label = `remoteUpstreams[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      errors.push(`${label} must be an object.`);
      return;
    }
    const { name, url } = entry as Record<string, unknown>;
    if (typeof name !== "string" || name.length === 0) {
      errors.push(`${label}.name is required.`);
      return;
    }
    if (!NAME_PATTERN.test(name)) {
      errors.push(
        `${label}.name must start with an ASCII letter or digit and contain only letters, digits, '.', '_' or '-'.`,
      );
      return;
    }
    if (seen.has(name)) {
      errors.push(`${label}.name '${name}' is duplicated.`);
      return;
    }
    const origin = normalizeOrigin(url);
    if (!origin) {
      errors.push(
        `${label}.url must be an HTTP(S) origin without credentials, path, query or fragment.`,
      );
      return;
    }
    seen.add(name);
    upstreams.push({ name, url: origin });
  });
  return { upstreams, errors };
}

function normalizeOrigin(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  const raw = value.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return undefined;
  }
  // URL drops an empty "?" or "#", so check the raw text as well.
  if (
    parsed.username ||
    parsed.password ||
    raw.includes("@") ||
    raw.includes("?") ||
    raw.includes("#") ||
    (parsed.pathname !== "/" && parsed.pathname !== "")
  ) {
    return undefined;
  }
  return parsed.origin;
}
