import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { AVATAR_MAX_LEN, NEIGHBOUR_STALE_MS, POSE_BOUNDS, ROOM_MAX_CLIENTS } from "../src/constants.js";
import { sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

describe("presence", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());

  it("seats as many players as the lobby has bases and gives each its own", async () => {
    assert.strictEqual(ROOM_MAX_CLIENTS, 11, "client config.js BASES.plots has 11 plots");
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "guest-a", base: 2 });
    const b = await colyseus.connectTo(room, { userId: "guest-b", base: 2 }); // taken: gets the lowest free one
    const c = await colyseus.connectTo(room, { userId: "guest-c" });
    await sleep(50);
    const bases = [a, b, c].map((x) => room.state.players.get(x.sessionId)!.base);
    assert.deepStrictEqual(bases, [2, 0, 1]);
    assert.strictEqual(room.maxClients, ROOM_MAX_CLIENTS);
    await a.leave();
    await sleep(100);
    const d = await colyseus.connectTo(room, { userId: "guest-d", base: 2 });
    await sleep(50);
    assert.strictEqual(room.state.players.get(d.sessionId)!.base, 2, "a freed base is handed out again");
  });

  it("takes the pose, held package, gear and look from the join options", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, {
      userId: "guest-a",
      pose: { x: 3, y: 0.5, z: -12, yaw: Math.PI, speed: 4 },
      loadout: { aura: "silver", costume: "ghost", hold: "pkg:box" },
      avatar: '{"equipped":{}}',
    });
    await sleep(50);
    const p = room.state.players.get(a.sessionId)!;
    assert.deepStrictEqual([p.x, p.y, p.z, p.speed], [3, 0.5, -12, 4]);
    assert.ok(Math.abs(Math.abs(p.yaw) - Math.PI) < 1e-5);
    assert.deepStrictEqual([p.aura, p.costume, p.hold], ["silver", "ghost", "pkg:box"]);
    assert.strictEqual(p.avatar, '{"equipped":{}}');
  });

  it("bounds poses and gear and relays them to the others", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "guest-a" });
    const b = await colyseus.connectTo(room, { userId: "guest-b" });
    await sleep(50);
    a.send("pose", { x: 1e9, y: "high", z: -1e12, yaw: 7, speed: -3, stunned: true, grounded: false });
    a.send("loadout", { aura: "Bad Id!", costume: "witch", hold: "item:Yo Yo" });
    a.send("setAvatar", { avatar: "x".repeat(AVATAR_MAX_LEN + 1) });
    await sleep(100);
    const p = room.state.players.get(a.sessionId)!;
    assert.strictEqual(p.x, POSE_BOUNDS.xy);
    assert.strictEqual(p.y, 0, "a non-number is ignored");
    assert.strictEqual(p.z, -POSE_BOUNDS.xy);
    assert.ok(Math.abs(p.yaw - Math.atan2(Math.sin(7), Math.cos(7))) < 1e-5, "yaw wrapped to -PI..PI");
    assert.strictEqual(p.speed, 0);
    assert.deepStrictEqual([p.stunned, p.grounded], [true, false]);
    assert.strictEqual(p.aura, "", "a malformed id is ignored");
    assert.deepStrictEqual([p.costume, p.hold], ["witch", "item:Yo Yo"]);
    assert.strictEqual(p.avatar, "", "an oversized look is ignored");

    a.send("loadout", { hold: "pkg:<script>" });
    await sleep(50);
    assert.strictEqual(p.hold, "item:Yo Yo", "a malformed hold is ignored");

    // b's synced copy of the roster sees a's presence.
    const seen = (b.state as any).players.get(a.sessionId);
    assert.strictEqual(seen.costume, "witch");
    assert.strictEqual(seen.x, POSE_BOUNDS.xy);
  });

  it("relays a player's base snapshot, only as capped JSON", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "guest-a" });
    await sleep(50);
    const p = room.state.players.get(a.sessionId)!;
    const snap = JSON.stringify({ b: 2, m: 1, l: 3, n: 3, p: [["box", 1, 2, 0]], i: [["Yo Yo", 4, 5]] });
    a.send("plot", { plot: snap });
    await sleep(50);
    assert.strictEqual(p.plot, snap);
    a.send("plot", { plot: "not json" });
    a.send("plot", { plot: "[1]" });
    a.send("plot", { plot: JSON.stringify({ x: "y".repeat(7000) }) });
    await sleep(50);
    assert.strictEqual(p.plot, snap, "malformed or oversized snapshots are ignored");
  });

  it("relays emotes with a counter, so the same emote plays again", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "guest-a" });
    await sleep(50);
    const p = room.state.players.get(a.sessionId)!;
    a.send("emote", { id: "000000000000000000000e01" });
    await sleep(50);
    assert.strictEqual(p.emote, "000000000000000000000e01#1");
    a.send("emote", { id: "000000000000000000000e01" });
    await sleep(50);
    assert.strictEqual(p.emote, "000000000000000000000e01#2");
    a.send("emote", { id: "" });
    await sleep(50);
    assert.strictEqual(p.emote, "");
  });

  it("relays a neighbour's animation, one driver per house, and drops it when the driver leaves", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "guest-a" });
    const b = await colyseus.connectTo(room, { userId: "guest-b" });
    await sleep(50);
    a.send("house", { i: 3, state: "chase", pose: "chase", face: "angry", x: 5, z: -40, facing: 1, speed: 6, held: false, pkg: false, door: true, emoji: "", bubble: "HEY! Come back!", red: true, say: true });
    await sleep(80);
    const h = room.state.houses.get("3")!;
    assert.deepStrictEqual([h.state, h.pose, h.face, h.x, h.z, h.door, h.red], ["chase", "chase", "angry", 5, -40, true, true]);
    assert.strictEqual(h.owner, a.sessionId);
    assert.strictEqual(h.bubble, "HEY! Come back!");
    assert.strictEqual(h.seq, 1);

    b.send("house", { i: 3, state: "answer", x: 0, z: 0 });
    b.send("house", { i: 9999, state: "answer" });
    b.send("house", { i: 4, state: "bogus", pose: "moonwalk", face: "x", bubble: "y".repeat(500) });
    await sleep(80);
    assert.strictEqual(room.state.houses.get("3")!.state, "chase", "another player cannot hijack a driven house");
    assert.strictEqual(room.state.houses.has("9999"), false);
    const four = room.state.houses.get("4")!;
    assert.deepStrictEqual([four.state, four.pose, four.face], ["answer", "idle", "happy"], "unknown enums fall back");
    assert.ok(four.bubble.length <= 96);

    a.send("houseEnd", { i: 3 });
    await sleep(80);
    assert.strictEqual(room.state.houses.has("3"), false);

    await b.leave();
    await sleep(100);
    assert.strictEqual(room.state.houses.has("4"), false, "a leaving player's houses stop");
    assert.ok(NEIGHBOUR_STALE_MS > 0);
  });
});
