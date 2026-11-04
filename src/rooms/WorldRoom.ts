import { Room, Client, CloseCode } from "colyseus";
import { WorldState, PlayerState, HouseState } from "./schema/WorldState.js";
import {
  AD_GIFT_COOLDOWN_MS, AD_GIFT_MONEY, GUEST_ID_PREFIX, LEADERBOARD_EVERY_MS, NAME_MAX, NEIGHBOUR_STALE_MS, PFP_MAX_LEN, REWARD_TOKEN_MAX_LEN,
  OFFLINE_MAX_SECONDS, RECONNECT_SECONDS, ROOM_MAX_CLIENTS, UID_MAX_LEN,
} from "../constants.js";
import { getPlayers, type PlayerDoc } from "../db.js";
import { sanitizeProgress } from "../sanitize.js";
import { applyPlot, applyAvatar, applyEmote, applyHouse, applyLoadout, applyPose, assignBase, readHouseIndex } from "../presence.js";
import { ranksOf, topBoards } from "../leaderboard.js";
import { verifyReward } from "../ads.js";

function sanitizeName(raw: unknown): string {
  return typeof raw === "string" ? raw.slice(0, NAME_MAX) : "";
}

function sanitizePfp(raw: unknown): string {
  return typeof raw === "string" && raw.length <= PFP_MAX_LEN && /^https?:\/\//i.test(raw) ? raw : "";
}

/**
 * Room every client joins via `client.joinOrCreate("world", { userId, username })`. At most
 * ROOM_MAX_CLIENTS (= the lobby's player bases) players: each owns one base (`PlayerState.base`).
 * Loads and saves each signed-in player's progress (MongoDB, see db.ts) -- the client keeps no save of
 * its own, so this is the only place progress lives. The game is client-authoritative: no gameplay
 * rules live here, saves are only bounded (sanitize.ts). Full rooms spill into a fresh one
 * automatically (maxClients). The roster also carries what the others draw: every player's pose,
 * Bloxity look, worn gear, held package and emote, and the North Lane houses a player is engaging
 * (`state.houses`: the neighbour's animation).
 */
export class WorldRoom extends Room<{ state: WorldState }> {
  state = new WorldState();
  maxClients = ROOM_MAX_CLIENTS;

  // sessionId -> user id (Bloxity id). Deliberately NOT part of WorldState: it only gates this
  // room's own Mongo reads/writes. Guests have no entry.
  userIds = new Map<string, string>();

  // sessionIds that already got a progress/noProgress answer for their current identity.
  private identified = new Set<string>();
  // sessionIds whose current identity's save has been read: only these may write. A save sent
  // before the load answered would overwrite the stored progress with a fresh player's defaults.
  private loaded = new Set<string>();
  // sessionId -> epoch ms the next ad gift may be paid (read with the save; guests keep it for the connection).
  private giftAt = new Map<string, number>();
  private giftBusy = new Set<string>();
  // house index -> epoch ms of its last update (stale ones are dropped).
  private houseSeen = new Map<string, number>();

  messages = {
    // Debounced push of the client's whole progress. Upserts, so a first save creates the document.
    saveProgress: async (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      const patch = sanitizeProgress(msg);
      if (!p || !patch || !this.loaded.has(client.sessionId)) return;

      const userId = this.userIds.get(client.sessionId);
      if (!userId) return;
      const players = getPlayers();
      if (!players) return; // Mongo unset/unreachable -- degrade silently
      // Lifetime counters only ever go up ($max), so a stale or replayed save can't lower a leaderboard place.
      const { earned, scares, steals, playtime, ...rest } = patch;
      const max: Record<string, number> = {};
      for (const [k, v] of Object.entries({ earned, scares, steals, playtime })) if (v !== undefined) max[k] = v;
      try {
        await players.updateOne(
          { _id: userId },
          {
            // Display name comes from this connection's own PlayerState, not `msg`.
            $set: { ...rest, username: p.username || "Player", lastSeen: Date.now(), updatedAt: new Date() },
            ...(Object.keys(max).length && { $max: max }),
            $setOnInsert: { version: 1 },
          },
          { upsert: true },
        );
      } catch (err) {
        console.warn("[WorldRoom] saveProgress failed", err);
      }
    },
    // Presence (presence.ts): the sender's pose ~10x/s, what it holds / wears and its Bloxity look,
    // relayed through the roster so everyone draws it in the world (client remotePlayers.js).
    pose: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyPose(p, msg);
    },
    loadout: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyLoadout(p, msg);
    },
    setAvatar: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyAvatar(p, msg);
    },
    // The sender's base (levels, packages, items, minions) for the others to draw on its plot.
    plot: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyPlot(p, msg);
    },
    // A Bloxity emote started ({ id }) or stopped ({ id: "" }).
    emote: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyEmote(p, msg);
    },
    // The sender is driving North Lane house `i` (its neighbour's state, ~10x/s): everybody else draws
    // the same animation. One driver per house: another player's update for a house already driven by
    // someone else is ignored until it goes quiet.
    house: (client: Client, msg: unknown) => {
      const i = readHouseIndex(msg);
      if (i < 0 || !this.state.players.has(client.sessionId)) return;
      const key = String(i);
      let h = this.state.houses.get(key);
      if (h && h.owner !== client.sessionId) return;
      if (!h) {
        h = new HouseState();
        this.state.houses.set(key, h);
      }
      applyHouse(h, client.sessionId, msg);
      this.houseSeen.set(key, Date.now());
    },
    // The sender is done with house `i` (the neighbour went home).
    houseEnd: (client: Client, msg: unknown) => {
      const i = readHouseIndex(msg);
      const key = String(i);
      if (i >= 0 && this.state.houses.get(key)?.owner === client.sessionId) this.dropHouse(key);
    },
    // Free Gift: the sender watched a rewarded ad (Legion.SDK.ads.showRewarded -> "completed") and sends its
    // reward token. The server verifies it with Bloxity and enforces the cooldown, then answers
    // `giftResult` { ok, amount, nextAt, serverTime } or { ok: false, reason: "cooldown" | "invalid" | "busy", nextAt }.
    // The client only grants the money on ok.
    adGift: async (client: Client, msg: { token?: unknown }) => {
      const sid = client.sessionId;
      const now = Date.now();
      const reply = (r: Record<string, unknown>) => {
        try {
          client.send("giftResult", { serverTime: Date.now(), nextAt: this.giftAt.get(sid) ?? 0, ...r });
        } catch {
          // Gone meanwhile.
        }
      };
      const token = msg?.token;
      if (typeof token !== "string" || !token || token.length > REWARD_TOKEN_MAX_LEN) return reply({ ok: false, reason: "invalid" });
      if (this.giftBusy.has(sid)) return reply({ ok: false, reason: "busy" });
      if ((this.giftAt.get(sid) ?? 0) > now) return reply({ ok: false, reason: "cooldown" });
      this.giftBusy.add(sid);
      try {
        const check = await verifyReward(token);
        if (!this.state.players.has(sid)) return;
        // A signed-in player's ad must belong to them (a guest's token has no user).
        const mine = this.userIds.get(sid);
        if (!check.valid || (check.userId && mine && check.userId !== mine)) return reply({ ok: false, reason: "invalid" });
        const nextAt = Date.now() + AD_GIFT_COOLDOWN_MS;
        this.giftAt.set(sid, nextAt);
        await this.saveGiftAt(sid, nextAt);
        reply({ ok: true, amount: AD_GIFT_MONEY, nextAt });
      } finally {
        this.giftBusy.delete(sid);
      }
    },
    // Re-states identity after a login/logout that happens AFTER join (a guest who signs in
    // mid-session). The server answers with progress/noProgress for the new identity.
    identify: (client: Client, msg: { username?: string; userId?: string; pfp?: string }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      if (typeof msg?.username === "string") p.username = sanitizeName(msg.username);
      if (typeof msg?.pfp === "string") p.pfp = sanitizePfp(msg.pfp);
      if (typeof msg?.userId === "string") this.setUserId(client, p, msg.userId);
    },
  };

  // Leaderboards (leaderboard.ts): everyone gets the top lists + their own ranks every
  // LEADERBOARD_EVERY_MS, and once right after their save loads. Houses nobody updates any more
  // (their driver crashed) are dropped every second.
  onCreate() {
    this.clock.setInterval(() => {
      for (const c of this.clients) void this.sendLeaderboard(c);
    }, LEADERBOARD_EVERY_MS);
    this.clock.setInterval(() => {
      const now = Date.now();
      for (const [key, at] of this.houseSeen) if (now - at > NEIGHBOUR_STALE_MS) this.dropHouse(key);
    }, 1000);
  }

  // `leaderboard` { boards: { earned|scares|steals|playtime: [{ name, value }] }, ranks: { stat: n | null } }.
  private async sendLeaderboard(client: Client) {
    const userId = this.userIds.get(client.sessionId) ?? "";
    const [boards, ranks] = await Promise.all([topBoards(), ranksOf(userId)]);
    if (!this.state.players.has(client.sessionId)) return;
    try {
      client.send("leaderboard", { boards, ranks });
    } catch {
      // Gone meanwhile.
    }
  }

  private dropHouse(key: string) {
    this.state.houses.delete(key);
    this.houseSeen.delete(key);
  }

  onJoin(client: Client, options?: { username?: string; userId?: string; pfp?: string; pose?: unknown; loadout?: unknown; avatar?: string; base?: unknown }) {
    const p = new PlayerState();
    p.username = sanitizeName(options?.username);
    p.pfp = sanitizePfp(options?.pfp);
    // The player's own base: the one they asked for (the client builds its machines there) if it is free.
    const taken = new Set<number>();
    this.state.players.forEach((o) => o.base >= 0 && taken.add(o.base));
    p.base = assignBase(taken, options?.base);
    // Presence from the join options, so the others draw the newcomer right away.
    applyPose(p, options?.pose);
    applyLoadout(p, options?.loadout);
    applyAvatar(p, options);
    this.state.players.set(client.sessionId, p);
    this.setUserId(client, p, typeof options?.userId === "string" ? options.userId : "");
  }

  // A deliberate `room.leave()` closes with CONSENTED -- drop the player at once. Anything
  // else (WiFi blip, backgrounded tab) gets RECONNECT_SECONDS to reconnect with the same session.
  async onLeave(client: Client, code?: number) {
    if (code === CloseCode.CONSENTED) {
      void this.stampLastSeen(client.sessionId);
      this.forgetSession(client.sessionId);
      return;
    }
    try {
      await this.allowReconnection(client, RECONNECT_SECONDS);
    } catch {
      void this.stampLastSeen(client.sessionId);
      this.forgetSession(client.sessionId);
    }
  }

  // The player is here now: offline time is counted from this moment on.
  private async stampSeen(sessionId: string, at: number) {
    const userId = this.userIds.get(sessionId);
    const players = getPlayers();
    if (!userId || !players) return;
    try {
      await players.updateOne({ _id: userId }, { $set: { lastSeen: at } });
    } catch (err) {
      console.warn("[WorldRoom] stampSeen failed", err);
    }
  }

  // Server-clock "last seen" for a player who has really gone. Call before forgetSession.
  private async stampLastSeen(sessionId: string) {
    const userId = this.userIds.get(sessionId);
    const players = getPlayers();
    if (!userId || !players) return;
    try {
      await players.updateOne({ _id: userId }, { $set: { lastSeen: Date.now() } });
    } catch (err) {
      console.warn("[WorldRoom] stampLastSeen failed", err);
    }
  }

  // Drops a session's per-connection bookkeeping: its base is free again and the houses it was driving stop.
  private forgetSession(sessionId: string) {
    this.state.players.delete(sessionId);
    this.userIds.delete(sessionId);
    this.identified.delete(sessionId);
    this.loaded.delete(sessionId);
    this.giftAt.delete(sessionId);
    this.giftBusy.delete(sessionId);
    this.state.houses.forEach((h, key) => {
      if (h.owner === sessionId) this.dropHouse(key);
    });
  }

  // The gift cooldown goes straight to Mongo (saveProgress never carries it).
  private async saveGiftAt(sessionId: string, giftAt: number) {
    const userId = this.userIds.get(sessionId);
    const players = getPlayers();
    if (!userId || !players) return;
    try {
      await players.updateOne({ _id: userId }, { $set: { giftAt, updatedAt: new Date() }, $setOnInsert: { version: 1 } }, { upsert: true });
    } catch (err) {
      console.warn("[WorldRoom] saveGiftAt failed", err);
    }
  }

  // Client-trusted Bloxity user id (guest ids are dropped, see GUEST_ID_PREFIX). A forged id can
  // only read/overwrite the SENDER's own save (there is no cross-player read in `saveProgress`).
  // Called from both onJoin and `identify`; answers with progress / noProgress / serverError.
  private setUserId(client: Client, p: PlayerState, raw: string) {
    let userId = raw.slice(0, UID_MAX_LEN);
    // Guests (client-made `guest-...` ids) get no identity: nothing is loaded or saved for them.
    if (userId.startsWith(GUEST_ID_PREFIX)) userId = "";
    const prev = this.userIds.get(client.sessionId) || "";
    // No change (e.g. a username-only identify) -- but the very first call must still answer.
    if (userId === prev && this.identified.has(client.sessionId)) return;
    this.identified.add(client.sessionId);
    this.loaded.delete(client.sessionId); // no writes until the new identity's save is read
    p.signedIn = !!userId;
    p.uid = userId;

    if (userId) {
      // Evict any OTHER live session already claiming this account, so one account never has
      // two racing Mongo writers (a crashed tab lingers up to RECONNECT_SECONDS via
      // allowReconnection in onLeave).
      for (const [sid, uid] of this.userIds) {
        if (sid === client.sessionId || uid !== userId) continue;
        this.forgetSession(sid);
        const stale = this.clients.find((c) => c.sessionId === sid);
        if (stale) {
          try {
            stale.leave(CloseCode.CONSENTED);
          } catch {
            // Already gone -- nothing to clean up.
          }
        }
      }
      this.userIds.set(client.sessionId, userId);
    } else {
      // No identity: stop persisting for this connection. (The client flushes a final
      // saveProgress under the OLD id before sending `identify`.)
      this.userIds.delete(client.sessionId);
    }

    void this.loadProgress(client, userId, p);
  }

  // Sends the saved doc to just this client so it can hydrate its state ("progress"), or
  // "noProgress" when there is nothing to load (new account, guest, or Mongo unset). A failed read
  // sends "serverError" and keeps saving off, so a save that could not be read is never overwritten.
  private async loadProgress(client: Client, userId: string, p: PlayerState) {
    const players = getPlayers();
    let doc: PlayerDoc | null = null;
    if (userId && players) {
      try {
        doc = await players.findOne({ _id: userId });
      } catch (err) {
        console.warn("[WorldRoom] loadProgress failed", err);
        client.send("serverError", {});
        return;
      }
    }
    // The player may have left, or switched identity again, while the read was in flight.
    if (this.state.players.get(client.sessionId) !== p || (this.userIds.get(client.sessionId) ?? "") !== userId) return;

    this.loaded.add(client.sessionId);
    const now = Date.now();
    if (!this.giftAt.has(client.sessionId) || userId) this.giftAt.set(client.sessionId, Number(doc?.giftAt) || 0);
    if (!doc) client.send("noProgress", { serverTime: now });
    else {
      // Offline Money: what the base earned while the player was away (income x time since last seen, capped).
      // The client adds it to the pile at its base; the stamp below makes sure it is counted only once.
      const away = doc.lastSeen ? Math.min(OFFLINE_MAX_SECONDS, Math.max(0, (now - doc.lastSeen) / 1000)) : 0;
      const offline = Math.floor((doc.income ?? 0) * away);
      client.send("progress", { ...(sanitizeProgress(doc) ?? {}), offline, away: Math.floor(away), serverTime: now });
      await this.stampSeen(client.sessionId, now);
    }
    client.send("giftResult", { ok: false, reason: "init", nextAt: this.giftAt.get(client.sessionId) ?? 0, serverTime: now });
    void this.sendLeaderboard(client);
  }
}
