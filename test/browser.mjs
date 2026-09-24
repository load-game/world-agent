// Opt-in integration proof against a disposable compatible world.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { BrowserWorld } from "../src/browser-world.mjs";
if (!process.env.WORLD_TEST_URL)
  throw new Error(
    "Set WORLD_TEST_URL to a disposable world. This test joins and walks.",
  );
const world = new BrowserWorld();
let failure;
world.on("failure", (e) => (failure = e));
try {
  await world.connect({
    url: process.env.WORLD_TEST_URL,
    name: "Walking verification",
  });
  await delay(500);
  const start = await world.observe();
  console.log(JSON.stringify(start));
  assert.ok(start.ready);
  const p = start.position;
  // A nearby destination beside spawn, then a route around the plaza furnishings.
  for (const destination of [
    [p[0] + 5, p[1], p[2]],
    [13, 0.24, 25],
    [23, 0.24, 18],
  ]) {
    const result = await world.act("walk", destination);
    assert.equal(result.state, "walking");
    let previous = (await world.observe()).position,
      arrived = false;
    const samples = [];
    for (let i = 0; i < 250; i++) {
      await delay(100);
      if (failure) throw failure;
      const observation = await world.observe();
      const step = Math.hypot(
        ...observation.position.map((n, j) => n - previous[j]),
      );
      assert.ok(step < 1.5, `Unexpected position jump ${step}`);
      samples.push(observation.position);
      previous = observation.position;
      if (observation.motion.state === "arrived") {
        arrived = true;
        break;
      }
      assert.equal(
        observation.motion.state,
        "walking",
        JSON.stringify(observation.motion),
      );
    }
    assert.ok(arrived, "Did not arrive within 25 seconds");
    assert.ok(
      Math.hypot(previous[0] - destination[0], previous[2] - destination[2]) <
        0.6,
    );
    console.log(
      JSON.stringify({
        destination,
        position: previous,
        samples: samples.length,
      }),
    );
  }
  assert.ok((await world.observe()).landmarks.length > 0);
  const view = await world.view();
  assert.ok(view.startsWith("data:image/jpeg;base64,"));
  await mkdir(".local", { recursive: true });
  await writeFile(
    ".local/walking-proof.jpg",
    Buffer.from(view.split(",")[1], "base64"),
  );
  await world.act("stop");
  console.log(
    "Walking, collision detour, observation and camera checks passed.",
  );
} finally {
  await world.close();
}
