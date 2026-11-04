import { MONEY_MAX, STAT_MAX, PLAY_SECONDS_MAX, OWNED_MAX, ID_PATTERN } from "./constants.js";
import type { PlayerDoc } from "./db.js";

export function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
export function clampNum(v: number, max: number): number {
  return Math.min(max, Math.max(0, v));
}
export function clampInt(v: number, max: number, min = 0): number {
  return Math.min(max, Math.max(min, Math.floor(v)));
}
function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
const isId = (v: unknown): v is string => typeof v === "string" && ID_PATTERN.test(v);

// Catalog ids (auras, costumes): slug strings, no duplicates, bounded count.
export function sanitizeIds(raw: unknown, max = OWNED_MAX): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter(isId))].slice(0, max);
}

// One owned list + its worn id. The worn one must be owned ("" = none); when this save doesn't carry
// the list, trust the id's shape only.
function ownedPair(raw: Record<string, unknown>, out: Partial<PlayerDoc>, listKey: "auras" | "costumes", idKey: "aura" | "costume") {
  if (raw[listKey] !== undefined) out[listKey] = sanitizeIds(raw[listKey]);
  const id = raw[idKey];
  const owned = out[listKey];
  if (id === "") out[idKey] = "";
  else if (isId(id) && (!owned || owned.includes(id))) out[idKey] = id;
}

// The game is client-authoritative -- no server-side gameplay validation. What IS enforced:
// shape and bounds, so a malformed payload can never corrupt this player's own Mongo document.
// A forged number can only ever affect the sender's own save (and its leaderboard places).
export function sanitizeProgress(raw: unknown): Partial<PlayerDoc> | null {
  if (!isObject(raw)) return null;
  const out: Partial<PlayerDoc> = {};

  if (finite(raw.money)) out.money = clampNum(raw.money, MONEY_MAX);
  if (finite(raw.speed)) out.speed = clampNum(raw.speed, STAT_MAX);
  if (finite(raw.scareLevel)) out.scareLevel = clampNum(raw.scareLevel, STAT_MAX);
  if (finite(raw.earned)) out.earned = clampNum(raw.earned, MONEY_MAX);
  if (finite(raw.scares)) out.scares = clampInt(raw.scares, STAT_MAX);
  if (finite(raw.steals)) out.steals = clampInt(raw.steals, STAT_MAX);
  if (finite(raw.playtime)) out.playtime = clampInt(raw.playtime, PLAY_SECONDS_MAX);
  if (finite(raw.lastSeen)) out.lastSeen = clampInt(raw.lastSeen, Date.now() + 10 * 60 * 1000);

  ownedPair(raw, out, "auras", "aura");
  ownedPair(raw, out, "costumes", "costume");
  return out;
}
