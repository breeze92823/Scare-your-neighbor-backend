import { MongoClient, type Collection } from "mongodb";

import { LEADERBOARD_STATS } from "./constants.js";

// Bloxity Legion hosting injects MONGODB_URI per game+channel -- an isolated database with
// scoped credentials. A local `npm start` normally has no Mongo reachable, so a missing or
// unreachable URI must degrade to "no persistence" rather than crash the room.

// The persisted client state (what `saveProgress` carries, see sanitize.ts). The client keeps
// nothing in the browser: this document is the player's only save.
export interface PlayerDoc {
  _id: string; // Bloxity user id -- see WorldRoom.ts (guests are never saved)
  username?: string; // display name as of the last save
  money?: number; // the HUD's $ counter
  speed?: number; // the speed stat (HUD shoe)
  scareLevel?: number; // the scare level (HUD ghost)
  earned?: number; // lifetime money earned (leaderboard "Top Earners")
  scares?: number; // successful scares (leaderboard)
  steals?: number; // packages stolen (leaderboard)
  playtime?: number; // s with the game visible (leaderboard)
  auras?: string[]; // owned aura ids (client config.js AURAS)
  aura?: string; // the worn aura, "" = none
  costumes?: string[]; // owned costume ids (client config.js COSTUMES)
  costume?: string; // the worn costume, "" = none
  lastSeen?: number; // epoch ms of the last activity (the server stamps it: on load, on every save and when the player leaves)
  // The base (client base.js): saved so it keeps earning while the player is away.
  income?: number; // $/s the active items earn (offline money = seconds away x this)
  pile?: number; // Offline Money waiting at the base, not yet collected (the client adds it up)
  baseLevel?: number; // Upgrade Base level (minions)
  slotsBought?: number; // item slot purchases
  boothLevel?: number;
  millLevel?: number;
  baseItems?: SavedItem[];
  basePackages?: SavedPackage[];
  // Free Gift (ad reward): written only by the server's `adGift` handler, never by saveProgress.
  giftAt?: number; // epoch ms of the last paid ad gift
  version: number;
  updatedAt: Date;
}

// One base item / package on the floor (plot-local x, z).
export interface SavedItem {
  name: string;
  rarity: string;
  value: number;
  rate: number;
  active: boolean;
  x: number;
  z: number;
}
export interface SavedPackage {
  tier: string;
  hp: number;
  x: number;
  z: number;
}

let client: MongoClient | null = null;
let players: Collection<PlayerDoc> | null = null;

export async function connectDb(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn("[db] MONGODB_URI not set -- player progress will not persist");
    return;
  }
  try {
    client = new MongoClient(uri);
    await client.connect();
    // No dbName passed to .db() -- the injected URI already points at this game+channel's database.
    players = client.db().collection<PlayerDoc>("players");
    console.log("[db] connected to MongoDB");
    // The leaderboards sort and count by these (leaderboard.ts).
    for (const stat of LEADERBOARD_STATS) {
      players.createIndex({ [stat]: -1 }).catch((err) => console.warn(`[db] index on ${stat} failed`, err));
    }
  } catch (err) {
    console.warn("[db] connect failed -- player progress will not persist:", err);
    client = null;
    players = null;
  }
}

// Null whenever Mongo is unset/unreachable -- every caller must treat that as "skip persistence".
export function getPlayers(): Collection<PlayerDoc> | null {
  return players;
}

// Test-only seam: exercise the save/load logic against an in-memory fake collection.
export function __setPlayersForTest(fake: Collection<PlayerDoc> | null): void {
  players = fake;
}
