import { schema, t, type SchemaType } from "@colyseus/schema";

// The live roster: who is in the room and what the others draw of them. Durable progress lives in
// Mongo (src/db.ts). To sync something new about a player, add a field here and accept it in a
// WorldRoom message (bounded in presence.ts).
export const PlayerState = schema(
  {
    username: t.string().default(""), // client-reported Bloxity displayName/username, not validated
    signedIn: t.boolean().default(false), // has a Bloxity id: only signed-in players are saved
    pfp: t.string().default(""), // Bloxity profile picture URL ("" = none)
    uid: t.string().default(""), // Bloxity user id ("" = guest): matches Bloxity chat messages to a player
    base: t.int16().default(-1), // the player base (client BASES.plots index) this player owns, -1 = none
    // Presence (presence.ts, `pose` / `state` / `loadout` / `setAvatar` / `emote`): what the others draw.
    x: t.float32().default(0), // feet position, m
    y: t.float32().default(0),
    z: t.float32().default(0),
    yaw: t.float32().default(0), // heading, rad (PI = facing -Z)
    speed: t.float32().default(0), // ground speed, m/s (drives the run cycle)
    vy: t.float32().default(0), // vertical speed, m/s (jump / fall pose)
    grounded: t.boolean().default(true),
    stunned: t.boolean().default(false), // caught by a neighbour: lying on their back
    hold: t.string().default(""), // what is in the right hand: "" | "pkg:<kind>" | "item:<name>" (stolen package / base item)
    aura: t.string().default(""), // worn aura / costume ids (client AURAS / COSTUMES), "" = none
    costume: t.string().default(""),
    emote: t.string().default(""), // "<id>#<n>": the Bloxity emote playing (n changes on every play), "" = none
    avatar: t.string().default(""), // Bloxity look JSON { equipped, proportions, skin }, "" = default
  },
  "PlayerState",
);
export type PlayerState = SchemaType<typeof PlayerState>;

// A North Lane house someone is engaging (neighbours.js state machine), relayed so every client
// sees the neighbour answer, drop the package, chase and walk home. Keyed by the house index.
export const HouseState = schema(
  {
    owner: t.string().default(""), // sessionId of the player driving it
    state: t.string().default(""), // client state: knocking | answer | laugh | scared | react | chase | grr | gotcha | return
    pose: t.string().default("idle"),
    face: t.string().default("happy"),
    x: t.float32().default(0), // the neighbour's position, m
    z: t.float32().default(0),
    facing: t.float32().default(0),
    speed: t.float32().default(0),
    held: t.boolean().default(false), // still holding the package
    pkg: t.boolean().default(false), // package lying on the step
    door: t.boolean().default(false), // door open (the neighbour model is out)
    emoji: t.string().default(""),
    bubble: t.string().default(""), // speech bubble text ("" = none)
    red: t.boolean().default(false), // shouting (red bubble)
    seq: t.uint32().default(0), // bumps on every new bubble, so a repeated line plays again
  },
  "HouseState",
);
export type HouseState = SchemaType<typeof HouseState>;

export const WorldState = schema(
  {
    players: t.map(PlayerState), // keyed by sessionId
    houses: t.map(HouseState), // keyed by house index
  },
  "WorldState",
);
export type WorldState = SchemaType<typeof WorldState>;
