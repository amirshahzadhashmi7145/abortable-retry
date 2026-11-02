import { test } from "node:test";
import assert from "node:assert/strict";
import { backoffDelay, sleep, AbortError } from "../dist/index.js";

test("exponential backoff", () => {
  const o = { delay: 100, jitter: false };
  assert.deepEqual([1, 2, 3, 4].map((a) => backoffDelay(a, o)), [100, 200, 400, 800]);
  assert.equal(backoffDelay(3, { ...o, factor: 3 }), 900);
});

test("linear and fixed backoff", () => {
  assert.deepEqual([1, 2, 3].map((a) => backoffDelay(a, { delay: 50, backoff: "linear", jitter: false })), [50, 100, 150]);
  assert.deepEqual([1, 2, 3].map((a) => backoffDelay(a, { delay: 50, backoff: "fixed", jitter: false })), [50, 50, 50]);
});

test("maxDelay caps the result", () => {
  assert.equal(backoffDelay(10, { delay: 100, maxDelay: 1000, jitter: false }), 1000);
});

test("custom delay function receives attempt and error", () => {
  const err = new Error("e");
  let seen;
  const d = backoffDelay(4, { delay: (a, e) => { seen = [a, e]; return 7; }, jitter: false }, err);
  assert.equal(d, 7);
  assert.deepEqual(seen, [4, err]);
});

test("full jitter stays within [0, delay]; equal jitter within [delay/2, delay]", () => {
  for (let i = 0; i < 200; i++) {
    const full = backoffDelay(1, { delay: 1000, jitter: "full" });
    assert.ok(full >= 0 && full <= 1000, `full ${full}`);
    const eq = backoffDelay(1, { delay: 1000, jitter: "equal" });
    assert.ok(eq >= 500 && eq <= 1000, `equal ${eq}`);
  }
  assert.equal(backoffDelay(1, { delay: 1000, jitter: false }), 1000);
});

test("negative delays clamp to zero", () => {
  assert.equal(backoffDelay(1, { delay: () => -5, jitter: false }), 0);
});

test("sleep resolves after ms and rejects on abort", async () => {
  const t = Date.now();
  await sleep(15);
  assert.ok(Date.now() - t >= 10);

  const ac = new AbortController();
  const p = sleep(10_000, ac.signal);
  ac.abort();
  await assert.rejects(p, AbortError);

  const pre = new AbortController();
  pre.abort();
  await assert.rejects(sleep(1, pre.signal), AbortError);
});
