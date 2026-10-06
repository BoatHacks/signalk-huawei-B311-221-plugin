import { createHash } from "node:crypto";

const sha256Hex = (data: string | Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");
const b64 = (data: Uint8Array): string => Buffer.from(data).toString("base64");

/**
 * Encodes the password the way the router's login form does, following
 * huawei-lte-api's `User._encode_password`. `password_type` 0 and 3 send
 * base64 of the password; 4 sends a salted double SHA-256 bound to the
 * session token. Anything else is refused instead of guessed at, so a
 * firmware we do not understand never receives a malformed login attempt.
 *
 * Kept in step with scripts/login.mjs (the capture tool cannot share code
 * with src/); both are pinned by the same known-answer tests.
 */
export function encodePassword(
  passwordType: number,
  username: string,
  password: string,
  token: string,
): string {
  if (![0, 3, 4].includes(passwordType)) {
    throw new Error(`Unsupported password_type ${passwordType}`);
  }
  if (!password) return "";
  if (passwordType === 4) {
    const inner = b64(Buffer.from(sha256Hex(password), "ascii"));
    const joined = Buffer.concat([
      Buffer.from(username, "utf8"),
      Buffer.from(inner, "ascii"),
      Buffer.from(token, "utf8"),
    ]);
    return b64(Buffer.from(sha256Hex(joined), "ascii"));
  }
  return b64(Buffer.from(password, "utf8"));
}
