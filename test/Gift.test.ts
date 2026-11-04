import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { __setPlayersForTest } from "../src/db.js";
import { __setRewardVerifierForTest } from "../src/ads.js";
import { AD_GIFT_MONEY } from "../src/constants.js";
import { fakePlayers, sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

describe("free gift (rewarded ad)", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());
  afterEach(() => {
    __setPlayersForTest(null);
    __setRewardVerifierForTest(null);
  });

  it("pays only for a token Bloxity verifies, then makes the player wait", async () => {
    const seen: string[] = [];
    __setRewardVerifierForTest(async (t) => (seen.push(t), { valid: t === "good", userId: null }));
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "guest-g" });
    const results: any[] = [];
    c.onMessage("giftResult", (m: any) => results.push(m));
    c.onMessage("noProgress", () => {});
    c.onMessage("leaderboard", () => {});
    await sleep(100);

    c.send("adGift", { token: "forged" });
    await sleep(100);
    assert.strictEqual(results.at(-1).ok, false);
    assert.strictEqual(results.at(-1).reason, "invalid");

    c.send("adGift", { token: "good" });
    await sleep(100);
    assert.strictEqual(results.at(-1).ok, true);
    assert.strictEqual(results.at(-1).amount, AD_GIFT_MONEY);
    assert.strictEqual(AD_GIFT_MONEY, 100);
    assert.ok(results.at(-1).nextAt > Date.now());

    c.send("adGift", { token: "good" });
    await sleep(100);
    assert.deepStrictEqual([results.at(-1).ok, results.at(-1).reason], [false, "cooldown"]);
    assert.deepStrictEqual(seen, ["forged", "good"], "the cooldown is checked before asking Bloxity again");
  });

  it("rejects a token that belongs to another player and keeps the cooldown in the save", async () => {
    const fake = fakePlayers();
    __setPlayersForTest(fake);
    __setRewardVerifierForTest(async (t) => ({ valid: true, userId: t === "mine" ? "u1" : "someone-else" }));
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "u1" });
    const results: any[] = [];
    c.onMessage("giftResult", (m: any) => results.push(m));
    c.onMessage("noProgress", () => {});
    c.onMessage("leaderboard", () => {});
    fake.release();
    await sleep(100);
    c.send("adGift", { token: "theirs" });
    await sleep(100);
    assert.strictEqual(results.at(-1).reason, "invalid");
    c.send("adGift", { token: "mine" });
    await sleep(100);
    assert.strictEqual(results.at(-1).ok, true);
    assert.ok((fake.docs.get("u1") as any).giftAt > Date.now(), "the cooldown survives a reload");
  });
});
