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
