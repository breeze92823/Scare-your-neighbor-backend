import {
  AVATAR_MAX_LEN, HOUSES_MAX, PLOT_MAX_LEN, ID_PATTERN, NEIGHBOUR_FACES, NEIGHBOUR_POSES, NEIGHBOUR_STATES, NEIGHBOUR_TEXT_MAX, POSE_BOUNDS, ROOM_MAX_CLIENTS,
} from "./constants.js";
import type { HouseState, PlayerState } from "./rooms/schema/WorldState.js";

// Presence: what the other clients need to draw a player in the world (client remotePlayers.js).
// Relayed through the roster as sent, only bounded here -- like the rest of the game it is
// client-authoritative and purely cosmetic.

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const isId = (v: unknown): v is string => typeof v === "string" && ID_PATTERN.test(v);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

// `pose` { x, y, z, yaw, speed, vy }: the feet position (m), heading (rad), ground speed (m/s) and
// vertical speed (m/s).
export function applyPose(p: PlayerState, msg: unknown): void {
  if (!msg || typeof msg !== "object") return;
  const m = msg as Record<string, unknown>;
  const b = POSE_BOUNDS;
  if (finite(m.x)) p.x = clamp(m.x, -b.xy, b.xy);
  if (finite(m.y)) p.y = clamp(m.y, -b.y, b.y);
  if (finite(m.z)) p.z = clamp(m.z, -b.xy, b.xy);
  if (finite(m.yaw)) p.yaw = wrap(m.yaw);
  if (finite(m.speed)) p.speed = clamp(m.speed, 0, b.speed);
  if (finite(m.vy)) p.vy = clamp(m.vy, -b.speed, b.speed);
  if (typeof m.grounded === "boolean") p.grounded = m.grounded;
  if (typeof m.stunned === "boolean") p.stunned = m.stunned;
}

// `state` { hold, aura, costume }: what is in the right hand ("" | "pkg:<kind>" | "item:<name>") and the
// worn aura / costume ids ("" = none). An item name may hold spaces and apostrophes (INDEX names).
const HOLD_PATTERN = /^(pkg:[A-Za-z0-9_-]{1,32}|item:[^<>\\"\u0000-\u001f]{1,48})?$/;
export function applyLoadout(p: PlayerState, msg: unknown): void {
  if (!msg || typeof msg !== "object") return;
  const m = msg as Record<string, unknown>;
  for (const key of ["aura", "costume"] as const) {
    const v = m[key];
    if (v === "" || isId(v)) p[key] = v as string;
  }
  if (typeof m.hold === "string" && HOLD_PATTERN.test(m.hold)) p.hold = m.hold;
}

// `setAvatar` { avatar }: the Bloxity look as an opaque JSON string ("" = default), length-capped.
export function applyAvatar(p: PlayerState, msg: unknown): void {
  const a = (msg as { avatar?: unknown })?.avatar;
  if (typeof a === "string" && a.length <= AVATAR_MAX_LEN) p.avatar = a;
}

// `plot` { plot }: the sender's base snapshot as a JSON object string (length-capped, must parse as an object):
// the other players draw it on that player's base.
export function applyPlot(p: PlayerState, msg: unknown): void {
  const s = (msg as { plot?: unknown })?.plot;
  if (typeof s !== "string" || s.length > PLOT_MAX_LEN) return;
  try {
    const v = JSON.parse(s);
    if (v && typeof v === "object" && !Array.isArray(v)) p.plot = s;
  } catch {
    // Not JSON: ignored.
  }
}

// `emote` { id }: a Bloxity emote id (24 hex chars in practice, any slug is accepted), "" = stopped.
// The roster entry is "<id>#<n>" so playing the same emote twice in a row is still a change.
export function applyEmote(p: PlayerState, msg: unknown): void {
  const id = (msg as { id?: unknown })?.id;
  if (id === "" || id === undefined || id === null) {
    p.emote = "";
    return;
  }
  if (!isId(id)) return;
  const n = Number(p.emote.split("#")[1] ?? 0) + 1;
  p.emote = `${id}#${n % 1_000_000}`;
}

// The lowest player base (0..ROOM_MAX_CLIENTS-1) nobody in the room owns, preferring `want` when it
// is free. -1 only when the room is somehow over its seat count.
export function assignBase(taken: Set<number>, want: unknown): number {
  if (Number.isInteger(want) && (want as number) >= 0 && (want as number) < ROOM_MAX_CLIENTS && !taken.has(want as number)) return want as number;
  for (let i = 0; i < ROOM_MAX_CLIENTS; i++) if (!taken.has(i)) return i;
  return -1;
}

const text = (v: unknown) => (typeof v === "string" ? v.slice(0, NEIGHBOUR_TEXT_MAX) : "");
const oneOf = <T extends string>(list: readonly T[], v: unknown, fallback: T): T => (list.includes(v as T) ? (v as T) : fallback);

// `house` { i, state, pose, face, x, z, facing, speed, held, pkg, door, emoji, bubble, red }: one North
// Lane house the sender is engaging. Returns the house index, or -1 when the message is malformed.
export function readHouseIndex(msg: unknown): number {
  const i = (msg as { i?: unknown })?.i;
  return Number.isInteger(i) && (i as number) >= 0 && (i as number) < HOUSES_MAX ? (i as number) : -1;
}

export function applyHouse(h: HouseState, owner: string, msg: unknown): void {
  const m = msg as Record<string, unknown>;
  h.owner = owner;
  h.state = oneOf(NEIGHBOUR_STATES, m.state, "answer");
  h.pose = oneOf(NEIGHBOUR_POSES, m.pose, "idle");
  h.face = oneOf(NEIGHBOUR_FACES, m.face, "happy");
  if (finite(m.x)) h.x = clamp(m.x, -POSE_BOUNDS.xy, POSE_BOUNDS.xy);
  if (finite(m.z)) h.z = clamp(m.z, -POSE_BOUNDS.xy, POSE_BOUNDS.xy);
  if (finite(m.facing)) h.facing = wrap(m.facing);
  if (finite(m.speed)) h.speed = clamp(m.speed, 0, POSE_BOUNDS.speed);
  h.held = m.held === true;
  h.pkg = m.pkg === true;
  h.door = m.door === true;
  h.emoji = text(m.emoji).slice(0, 12);
  h.red = m.red === true;
  const bubble = text(m.bubble);
  if (bubble !== h.bubble || (m.say === true && bubble)) h.seq = (h.seq + 1) >>> 0;
  h.bubble = bubble;
}
