import { parseRemoteUpstreams } from "./remoteConfig";
import type { RemoteUpstreamConfig } from "./types";

export const REMOTE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Returns the normalized origin or an error message for an input URL. */
export function validateRemoteUrl(
  input: string,
): { url: string } | { error: string } {
  const { upstreams, errors } = parseRemoteUpstreams([
    { name: "probe", url: input },
  ]);
  if (upstreams.length === 1) {
    return { url: upstreams[0].url };
  }
  return {
    error:
      errors[0]?.replace("remoteUpstreams[0].url", "URL") ?? "Invalid URL.",
  };
}

/**
 * Tunnel hosts look like <label>-<port>.<region>.devtunnels.ms; the label is
 * the most recognizable part. Other hosts use their first DNS label.
 */
export function deriveRemoteName(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return "remote";
  }
  const first = host.split(".")[0] ?? "";
  const label = /\.devtunnels\.ms$/i.test(host)
    ? first.replace(/-\d+$/, "")
    : first;
  const cleaned = label
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "");
  return cleaned || "remote";
}

export function validateRemoteName(
  name: string,
  existing: readonly string[],
  allowExisting = false,
): string | undefined {
  if (!name) {
    return "Name is required.";
  }
  if (!REMOTE_NAME_PATTERN.test(name)) {
    return "Name must start with an ASCII letter or digit and contain only letters, digits, '.', '_' or '-'.";
  }
  if (!allowExisting && existing.includes(name)) {
    return `A remote named '${name}' already exists.`;
  }
  return undefined;
}

/**
 * Appends or replaces by name, keeping unrelated raw entries (even ones the
 * parser would reject) untouched so the user's settings are not rewritten.
 */
export function mergeRemote(
  current: unknown,
  entry: RemoteUpstreamConfig,
): { value: unknown[]; replaced: boolean } {
  const list = Array.isArray(current) ? [...current] : [];
  const index = list.findIndex(
    (e) =>
      e &&
      typeof e === "object" &&
      (e as { name?: unknown }).name === entry.name,
  );
  if (index >= 0) {
    list[index] = { ...(list[index] as object), url: entry.url };
    return { value: list, replaced: true };
  }
  list.push({ name: entry.name, url: entry.url });
  return { value: list, replaced: false };
}

export function removeRemote(current: unknown, name: string): unknown[] {
  const list = Array.isArray(current) ? current : [];
  return list.filter(
    (e) =>
      !(e && typeof e === "object" && (e as { name?: unknown }).name === name),
  );
}
