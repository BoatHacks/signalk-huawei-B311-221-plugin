// radioQuality (0-1) from RSRP and SINR, see ARCHITECTURE §3.1. Each input
// is mapped linearly between a poor and a good anchor and clamped; the lower
// of the two wins, since either one being bad makes the link bad. All
// thresholds live in this file so they can be tuned in one place.

/** RSRP in dBm at which quality is 0 / 1. */
export const RSRP_POOR_DBM = -120;
export const RSRP_GOOD_DBM = -80;
/** SINR in dB at which quality is 0 / 1. */
export const SINR_POOR_DB = 0;
export const SINR_GOOD_DB = 20;

/**
 * Zone boundaries published in `meta.zones` (SPEC §6.4). The server derives
 * weak-signal notifications from them. Normal at or above `*_WARN`, warn
 * between `*_ALARM` and `*_WARN`, alarm below `*_ALARM`.
 */
export const RSRP_WARN_DBM = -105;
export const RSRP_ALARM_DBM = -115;
export const SINR_WARN_DB = 5;
export const SINR_ALARM_DB = 0;

function scale(value: number | undefined, poor: number, good: number) {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const q = (value - poor) / (good - poor);
  return Math.min(1, Math.max(0, q));
}

export function radioQuality(input: {
  rsrp?: number;
  sinr?: number;
}): number | undefined {
  const parts = [
    scale(input.rsrp, RSRP_POOR_DBM, RSRP_GOOD_DBM),
    scale(input.sinr, SINR_POOR_DB, SINR_GOOD_DB),
  ].filter((q): q is number => q !== undefined);
  if (parts.length === 0) return undefined;
  return Math.min(...parts);
}
