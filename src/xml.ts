import { XMLParser } from "fast-xml-parser";
import { BadResponse } from "./errors.ts";

// Values stay strings (`parseTagValue: false`): phone numbers, leading
// zeros ("03") and long counters must not be coerced. Whitespace is kept so
// SMS text survives intact; parsers trim the fields where it does not matter.
const parser = new XMLParser({
  ignoreAttributes: true,
  ignoreDeclaration: true,
  parseTagValue: false,
  trimValues: false,
  processEntities: true,
});

export interface ParsedResponse {
  /** The router's `<error><code>`, when the answer is an error. */
  errorCode?: number;
  /** Content of `<response>`: a string such as "OK", or an object. */
  data: unknown;
}

/** Parses a router answer. Anything that is neither `<response>` nor `<error>` is a BadResponse. */
export function parseResponseXml(text: string): ParsedResponse {
  if (!text.trim()) throw new BadResponse("Empty response from router");
  let root: unknown;
  try {
    root = parser.parse(text);
  } catch {
    throw new BadResponse("Router answer is not valid XML");
  }
  if (typeof root !== "object" || root === null) {
    throw new BadResponse("Router answer is not a <response> or <error>");
  }
  const obj = root as Record<string, unknown>;
  if ("error" in obj) {
    const err = obj.error;
    const raw =
      typeof err === "object" && err !== null
        ? (err as Record<string, unknown>).code
        : undefined;
    const code = Number(typeof raw === "string" ? raw.trim() : Number.NaN);
    if (!Number.isInteger(code)) {
      throw new BadResponse("Router error without a numeric code");
    }
    return { errorCode: code, data: undefined };
  }
  if ("response" in obj) {
    const data = obj.response;
    return { data: typeof data === "string" ? data.trim() : data };
  }
  throw new BadResponse("Router answer is not a <response> or <error>");
}
