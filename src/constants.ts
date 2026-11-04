// Keep in step with the client's src/config.js by hand (a contract change goes in both projects).

// Players per room = the number of player bases in the client's lobby (config.js BASES.plots: 5 south
// + 3 east + 3 west). Every player owns one base, so a room never holds more players than bases.
// The deploy workflow reads this line and sends it to Legion as `roomSize` (valid range 2-100).
export const ROOM_MAX_CLIENTS = 11;

// Longest accepted strings.
export const NAME_MAX = 64;
// Profile picture URL (Bloxity `pfp`), relayed so other players can draw it.
export const PFP_MAX_LEN = 512;
// The Bloxity user id (`uid` in the roster): lets a client match a Bloxity chat message to a player.
export const UID_MAX_LEN = 128;
// Presence (presence.ts): the Bloxity avatar JSON relayed for the others to draw, and the pose
// bounds (|x|, |z| up to `xy` m, y up to `y` m; speed in m/s). The lobby is a few hundred metres wide.
export const AVATAR_MAX_LEN = 3000;
// A player's base snapshot (packages, items, levels: client remoteBases.js), relayed as a JSON string.
export const PLOT_MAX_LEN = 6000;
export const POSE_BOUNDS = { xy: 2000, y: 200, speed: 200 };

// Colyseus drops the whole connection for a WebSocket message above this (default 4 KB).
export const MAX_PAYLOAD_BYTES = 128 * 1024;

// How long a dropped connection (WiFi blip, backgrounded tab) may reconnect with the same session.
export const RECONNECT_SECONDS = 20;

// Upper bounds for saved values, so a forged payload cannot store a bogus number. Generous
// ceilings, not game rules.
export const MONEY_MAX = 1e33; // money / lifetime earnings
export const STAT_MAX = 1e12; // speed, scare level, scare + steal counters
export const PLAY_SECONDS_MAX = 31_536_000; // ~1 year
export const OWNED_MAX = 64; // owned auras / costumes (client AURAS + COSTUMES, with slack)

// The player's base, saved so it keeps earning while they are away (client base.js store): items and
// packages on the floor and the levels. The base's income ($/s) is saved too; the server turns the time
// since the player was last seen into "Offline Money" (at most OFFLINE_MAX_SECONDS) when they come back.
export const BASE_ITEMS_MAX = 64;
export const BASE_PACKAGES_MAX = 64;
export const LEVEL_MAX = 100;
export const OFFLINE_MAX_SECONDS = 24 * 60 * 60;
export const BASE_COORD_MAX = 100; // plot-local metres

// Neighbours (client neighbours.js): the lobby has this many North Lane houses at most. A house the
// player is engaging is relayed through the roster so everybody sees the neighbour's animation.
export const HOUSES_MAX = 64;
export const NEIGHBOUR_TEXT_MAX = 96;
// The enums the client's neighbour state machine uses (anything else is dropped).
export const NEIGHBOUR_STATES = ["knocking", "answer", "laugh", "scared", "react", "chase", "grr", "gotcha", "return"] as const;
export const NEIGHBOUR_POSES = ["idle", "laugh", "scared", "gotcha", "grr", "chase", "walk"] as const;
export const NEIGHBOUR_FACES = ["happy", "scared", "angry", "laugh"] as const;
// A relayed house with no update for this long is dropped (the player who drove it left or crashed).
export const NEIGHBOUR_STALE_MS = 6000;

// Free Gift (client GIFT in config.js): watching a rewarded ad pays this much money, at most once per
// cooldown. The server verifies the ad's reward token with Bloxity before it says yes.
export const AD_GIFT_MONEY = 100;
export const AD_GIFT_COOLDOWN_MS = 60 * 1000;
export const REWARD_TOKEN_MAX_LEN = 512;

// Leaderboards (leaderboard.ts; client plaza.js board): the saved doc fields ranked, rows per board and
// how often the lists are re-read and re-sent.
export const LEADERBOARD_STATS = ["earned", "scares", "steals", "playtime"] as const;
export type LeaderboardStat = (typeof LEADERBOARD_STATS)[number];
export const LEADERBOARD_SIZE = 10;
export const LEADERBOARD_EVERY_MS = 60 * 1000;

// Ids from the client's catalogs (auras, costumes): camelCase slugs, so nothing odd is stored.
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

// The client's per-browser fallback id for players who are not signed in to Bloxity.
// Guests are never persisted.
export const GUEST_ID_PREFIX = "guest-";
