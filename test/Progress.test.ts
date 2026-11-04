import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { __setPlayersForTest } from "../src/db.js";
import { fakePlayers, sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

describe("progress", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());
  afterEach(() => __setPlayersForTest(null));

  it("sends a saved player their progress and saves what they send back", async () => {
    const fake = fakePlayers([{ _id: "u1", money: 5000, auras: ["silver"], aura: "silver", earned: 900, version: 1, updatedAt: new Date() }]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "u1", username: "Ann" });
    let got: any = null;
    c.onMessage("progress", (m: any) => (got = m));
    c.onMessage("leaderboard", () => {});
    c.onMessage("giftResult", () => {});
    fake.release();
    await sleep(150);
    assert.strictEqual(got?.money, 5000);
    assert.deepStrictEqual(got?.auras, ["silver"]);
    assert.strictEqual(got?.aura, "silver");

    c.send("saveProgress", { money: 7000, speed: 3, scareLevel: 12, earned: 400, scares: 2, costumes: ["ghost"], costume: "ghost", hack: 1 });
    await sleep(150);
    const doc = fake.docs.get("u1")! as any;
    assert.strictEqual(doc.money, 7000);
    assert.strictEqual(doc.speed, 3);
    assert.strictEqual(doc.costume, "ghost");
    assert.strictEqual(doc.earned, 900, "lifetime earnings never go down");
    assert.strictEqual(doc.scares, 2);
    assert.strictEqual(doc.username, "Ann");
    assert.ok(!("hack" in doc));
  });

  it("turns the time away into Offline Money, once, and keeps the base", async () => {
    const seen = Date.now() - 100_000;
    const fake = fakePlayers([
      { _id: "u5", money: 10, income: 12, pile: 50, lastSeen: seen, baseLevel: 3, baseItems: [{ name: "Yo Yo", rarity: "common", value: 320, rate: 4, active: true, x: 1, z: 2 }], version: 1, updatedAt: new Date() },
      { _id: "u6", income: 5, lastSeen: Date.now() - 400 * 3600 * 1000, version: 1, updatedAt: new Date() },
    ]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "u5" });
    const d = await colyseus.connectTo(room, { userId: "u6" });
    let got: any = null;
    let capped: any = null;
    c.onMessage("progress", (m: any) => (got = m));
    d.onMessage("progress", (m: any) => (capped = m));
    c.onMessage("leaderboard", () => {});
    d.onMessage("leaderboard", () => {});
    c.onMessage("giftResult", () => {});
    d.onMessage("giftResult", () => {});
    fake.release();
    await sleep(200);
    assert.ok(got.away >= 100 && got.away <= 103, "seconds away");
    assert.ok(got.offline >= 1200 && got.offline <= 1236, "income x seconds away");
    assert.strictEqual(got.pile, 50, "the uncollected pile is the client's to add up");
    assert.strictEqual(got.baseLevel, 3);
    assert.deepStrictEqual(got.baseItems, [{ name: "Yo Yo", rarity: "common", value: 320, rate: 4, active: true, x: 1, z: 2 }]);
    assert.strictEqual(capped.away, 24 * 3600, "offline earnings are capped at a day");
    assert.ok((fake.docs.get("u5") as any).lastSeen > seen + 99_000, "stamped on load, so it is counted once");

    c.send("saveProgress", { pile: 1250, income: 20, baseItems: [{ name: "<b>", rarity: "x", value: 1, rate: 1, active: true, x: 0, z: 0 }, { name: "Toaster", rarity: "rare", value: 9, rate: 1, active: true, x: 999, z: 0 }], basePackages: [{ tier: "common", hp: 5, x: 1, z: 1 }] });
    await sleep(150);
    const doc = fake.docs.get("u5") as any;
    assert.deepStrictEqual([doc.pile, doc.income], [1250, 20]);
    assert.strictEqual(doc.baseItems.length, 1, "a markup name is dropped");
    assert.strictEqual(doc.baseItems[0].x, 100, "floor spots are clamped");
    assert.strictEqual(doc.basePackages[0].tier, "common");
  });

  it("creates a new account's save and never saves a guest", async () => {
    const fake = fakePlayers();
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "new1" });
    let none = false;
    c.onMessage("noProgress", () => (none = true));
    c.onMessage("leaderboard", () => {});
    c.onMessage("giftResult", () => {});
    fake.release();
    await sleep(150);
    assert.ok(none);
    c.send("saveProgress", { money: 10 });
    await sleep(150);
    assert.strictEqual(fake.docs.get("new1")?.money, 10);

    const guest = await colyseus.connectTo(room, { userId: "guest-abc" });
    guest.onMessage("noProgress", () => {});
    guest.onMessage("leaderboard", () => {});
    guest.onMessage("giftResult", () => {});
    await sleep(150);
    guest.send("saveProgress", { money: 99 });
    await sleep(150);
    assert.strictEqual(fake.docs.size, 1, "a guest is never written");
    assert.strictEqual(room.state.players.get(guest.sessionId)?.signedIn, false);
    assert.strictEqual(room.state.players.get(c.sessionId)?.uid, "new1");
    assert.strictEqual(room.state.players.get(guest.sessionId)?.uid, "");
  });

  it("loads the new identity when a guest signs in mid-session", async () => {
    const fake = fakePlayers([{ _id: "u2", money: 42, version: 1, updatedAt: new Date() }]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "guest-x" });
    let got: any = null;
    c.onMessage("noProgress", () => {});
    c.onMessage("progress", (m: any) => (got = m));
    c.onMessage("leaderboard", () => {});
    c.onMessage("giftResult", () => {});
    fake.release();
    await sleep(150);
    c.send("identify", { userId: "u2", username: "Bea" });
    await sleep(150);
    assert.strictEqual(got?.money, 42);
    assert.strictEqual(room.state.players.get(c.sessionId)?.signedIn, true);
  });

  it("keeps saving off when the save could not be read", async () => {
    const fake = fakePlayers([{ _id: "u3", money: 1e9, version: 1, updatedAt: new Date() }]);
    (fake as any).findOne = async () => {
      await fake.gate;
      throw new Error("down");
    };
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "u3" });
    let failed = false;
    c.onMessage("serverError", () => (failed = true));
    fake.release();
    await sleep(150);
    assert.ok(failed);
    c.send("saveProgress", { money: 0 });
    await sleep(150);
    assert.strictEqual(fake.docs.get("u3")!.money, 1e9, "the unread save is never overwritten");
  });
});
