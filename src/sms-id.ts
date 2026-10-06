import { createHash } from "node:crypto";

/**
 * Stable message id. The router's own index can be reused after a deletion,
 * so the id also covers the message date and the peer (ARCHITECTURE §5.1).
 * `timestamp` is whatever date string the caller holds consistently; the
 * parsers pass the router's raw date string so ids do not change if the
 * server's timezone does.
 */
export function smsId(index: number, timestamp: string, peer: string): string {
  return createHash("sha256")
    .update(`${index}\u0000${timestamp.trim()}\u0000${peer.trim()}`)
    .digest("hex")
    .slice(0, 16);
}
