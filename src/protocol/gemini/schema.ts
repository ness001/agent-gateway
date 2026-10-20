import { GatewayError } from "../core/errors";

/** JSON Schema keywords kept as-is (after recursive conversion where nested). */
const PASSTHROUGH = new Set([
  "description",
  "title",
  "format",
  "enum",
  "default",
  "example",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "pattern",
  "minProperties",
  "maxProperties",
]);

const TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "array",
  "object",
  "null",
]);

const MAX_DEPTH = 64;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Convert a Gemini (OpenAPI-subset) Schema to JSON Schema: UPPERCASE types are
 * lower-cased, `nullable` becomes a `null` type alternative, `propertyOrdering`
 * and unknown keywords are dropped. `TYPE_UNSPECIFIED` means no type.
 */
export function geminiSchemaToJsonSchema(
  schema: unknown,
  param = "parameters",
): Record<string, unknown> {
  return convert(schema, param, 0);
}

function convert(
  s: unknown,
  path: string,
  depth: number,
): Record<string, unknown> {
  if (!isObj(s)) {
    throw new GatewayError("invalid_request", `${path}: expected object`, {
      param: path,
    });
  }
  if (depth > MAX_DEPTH) {
    throw new GatewayError("invalid_request", `${path}: schema too deep`, {
      param: path,
    });
  }
  const out: Record<string, unknown> = {};
  let type: string | undefined;
  if (s.type !== undefined) {
    if (typeof s.type !== "string") {
      throw new GatewayError(
        "invalid_request",
        `${path}.type: expected string`,
        {
          param: `${path}.type`,
        },
      );
    }
    const t = s.type.toLowerCase();
    if (t !== "type_unspecified") {
      if (!TYPES.has(t)) {
        throw new GatewayError(
          "invalid_request",
          `${path}.type: unknown type ${JSON.stringify(s.type)}`,
          { param: `${path}.type` },
        );
      }
      type = t;
    }
  }
  if (type !== undefined) {
    out.type = s.nullable === true && type !== "null" ? [type, "null"] : type;
  }
  for (const [k, v] of Object.entries(s)) {
    if (PASSTHROUGH.has(k) && v !== undefined) {
      out[k] = v;
    }
  }
  if (
    Array.isArray(out.enum) &&
    s.nullable === true &&
    !out.enum.includes(null)
  ) {
    out.enum = [...out.enum, null];
  }
  if (s.items !== undefined) {
    out.items = convert(s.items, `${path}.items`, depth + 1);
  }
  if (s.properties !== undefined) {
    if (!isObj(s.properties)) {
      throw new GatewayError(
        "invalid_request",
        `${path}.properties: expected object`,
        { param: `${path}.properties` },
      );
    }
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s.properties)) {
      props[k] = convert(v, `${path}.properties.${k}`, depth + 1);
    }
    out.properties = props;
  }
  if (Array.isArray(s.required)) {
    const req = s.required.filter((x): x is string => typeof x === "string");
    if (req.length > 0) {
      out.required = req;
    }
  }
  if (s.anyOf !== undefined) {
    if (!Array.isArray(s.anyOf)) {
      throw new GatewayError(
        "invalid_request",
        `${path}.anyOf: expected array`,
        {
          param: `${path}.anyOf`,
        },
      );
    }
    out.anyOf = s.anyOf.map((x, i) =>
      convert(x, `${path}.anyOf[${i}]`, depth + 1),
    );
  }
  return out;
}
