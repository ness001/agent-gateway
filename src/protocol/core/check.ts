/** Result of a check: the narrowed value, or a path-qualified error message. */
export type Checked<T> =
  | { ok: true; value: T }
  | { ok: false; message: string; path: string };

/** A validator receives a value and the path at which it was found. */
export type Check<T> = (value: unknown, path: string) => Checked<T>;

const ok = <T>(value: T): Checked<T> => ({ ok: true, value });
const fail = <T>(path: string, expected: string): Checked<T> => ({
  ok: false,
  path,
  message: `${path || "body"}: expected ${expected}`,
});

function describe(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

const failGot = <T>(
  path: string,
  expected: string,
  value: unknown,
): Checked<T> => {
  const r = fail<T>(path, expected);
  if (!r.ok) {
    r.message += `, got ${describe(value)}`;
  }
  return r;
};

export const str: Check<string> = (v, p) =>
  typeof v === "string" ? ok(v) : failGot(p, "string", v);

export const num: Check<number> = (v, p) =>
  typeof v === "number" && Number.isFinite(v) ? ok(v) : failGot(p, "number", v);

export const int: Check<number> = (v, p) =>
  typeof v === "number" && Number.isInteger(v)
    ? ok(v)
    : failGot(p, "integer", v);

export const bool: Check<boolean> = (v, p) =>
  typeof v === "boolean" ? ok(v) : failGot(p, "boolean", v);

export function arr<T>(item: Check<T>): Check<T[]> {
  return (v, p) => {
    if (!Array.isArray(v)) {
      return failGot(p, "array", v);
    }
    const out: T[] = [];
    for (let i = 0; i < v.length; i++) {
      const r = item(v[i], `${p}[${i}]`);
      if (!r.ok) {
        return r;
      }
      out.push(r.value);
    }
    return ok(out);
  };
}

type Shape = Record<string, Check<unknown>>;
type FromShape<S extends Shape> = {
  [K in keyof S]: S[K] extends Check<infer T> ? T : never;
};

/** Checks listed keys; unknown keys are allowed and preserved. */
export function obj<S extends Shape>(
  shape: S,
): Check<FromShape<S> & Record<string, unknown>> {
  return (v, p) => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      return failGot(p, "object", v);
    }
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = { ...src };
    for (const key of Object.keys(shape)) {
      const r = shape[key](src[key], p ? `${p}.${key}` : key);
      if (!r.ok) {
        return r;
      }
      if (r.value === undefined) {
        delete out[key];
      } else {
        out[key] = r.value;
      }
    }
    return ok(out as FromShape<S> & Record<string, unknown>);
  };
}

export function oneOf<const T extends readonly (string | number | boolean)[]>(
  ...values: T
): Check<T[number]> {
  return (v, p) =>
    values.includes(v as T[number])
      ? ok(v as T[number])
      : fail(p, `one of ${values.map((x) => JSON.stringify(x)).join(", ")}`);
}

/** Accepts `undefined` (absent key). `null` is rejected unless `allowNull`. */
export function optional<T>(
  check: Check<T>,
  allowNull = false,
): Check<T | undefined> {
  return (v, p) =>
    v === undefined || (allowNull && v === null) ? ok(undefined) : check(v, p);
}

/** Runs a check at the root. */
export function validate<T>(check: Check<T>, value: unknown): Checked<T> {
  return check(value, "");
}
