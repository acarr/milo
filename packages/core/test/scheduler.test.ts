import { test } from "node:test";
import assert from "node:assert/strict";
import { Scheduler, type ScheduleDef } from "@milo/core";

test("Scheduler.isValid / nextRun validate cron patterns", () => {
  assert.equal(Scheduler.isValid("0 */6 * * *"), true);
  assert.equal(Scheduler.isValid("not a cron"), false);
  const next = Scheduler.nextRun("0 0 * * *");
  assert.ok(typeof next === "number" && next > Date.now());
  assert.equal(Scheduler.nextRun("garbage"), null);
});

test("Scheduler fires an enabled per-second schedule and records it in status", async () => {
  let fired = 0;
  let lastDef: ScheduleDef | undefined;
  const def: ScheduleDef = { name: "tick", cron: "* * * * * *", intent: { kind: "maintenance" }, enabled: true };
  const s = new Scheduler([def], (d) => {
    fired++;
    lastDef = d;
  });
  s.start();
  await new Promise((r) => setTimeout(r, 2100));
  s.stop();
  assert.ok(fired >= 1, `expected at least one fire, got ${fired}`);
  assert.equal(lastDef?.name, "tick");
});

test("Scheduler skips disabled and invalid schedules", async () => {
  let fired = 0;
  const s = new Scheduler(
    [
      { name: "off", cron: "* * * * * *", intent: {}, enabled: false },
      { name: "bad", cron: "nope", intent: {}, enabled: true },
    ],
    () => {
      fired++;
    },
  );
  s.start();
  await new Promise((r) => setTimeout(r, 1200));
  s.stop();
  assert.equal(fired, 0);
  const status = s.status();
  assert.equal(status.find((x) => x.name === "off")?.enabled, false);
});
