import { test } from "node:test";
import assert from "node:assert/strict";
import { retry, bail, backoffDelay, sleep, RetryError, AbortError, TimeoutError } from "../dist/index.js";

const fast = { delay: 1, jitter: false };

test("resolves on first success without retrying", async () => {
  let calls = 0;
  const v = await retry(async () => { calls++; return "ok"; }, fast);
  assert.equal(v, "ok");
  assert.equal(calls, 1);
});

test("retries until success and passes attempt number", async () => {
  const attempts = [];
  const v = await retry(async ({ attempt }) => {
    attempts.push(attempt);
    if (attempt < 3) throw new Error(`fail ${attempt}`);
    return attempt;
  }, { ...fast, retries: 5 });
  assert.equal(v, 3);
  assert.deepEqual(attempts, [1, 2, 3]);
});

test("accepts a synchronous function", async () => {
  let n = 0;
  const v = await retry(() => { if (n++ < 1) throw new Error("x"); return "sync"; }, fast);
  assert.equal(v, "sync");
});

test("throws RetryError with all errors after exhausting retries", async () => {
  let calls = 0;
  await assert.rejects(
    retry(async () => { calls++; throw new Error(`e${calls}`); }, { ...fast, retries: 2 }),
    (err) => {
      assert.ok(err instanceof RetryError);
      assert.equal(err.attempts, 3);
      assert.equal(err.errors.length, 3);
      assert.equal(err.cause.message, "e3");
      assert.match(err.message, /All 3 attempt\(s\) failed. Last error: Error: e3/);
      return true;
    },
  );
  assert.equal(calls, 3);
});

test("retries: 0 means a single attempt", async () => {
  let calls = 0;
  await assert.rejects(retry(async () => { calls++; throw new Error("x"); }, { ...fast, retries: 0 }), RetryError);
  assert.equal(calls, 1);
});

test("rejects invalid retries", async () => {
  await assert.rejects(retry(async () => 1, { retries: -1 }), RangeError);
  await assert.rejects(retry(async () => 1, { retries: 1.5 }), RangeError);
});

test("bail() stops immediately and rethrows the original error", async () => {
  let calls = 0;
  const original = new Error("not found");
  await assert.rejects(
    retry(async () => { calls++; throw bail(original); }, { ...fast, retries: 5 }),
    (err) => err === original,
  );
  assert.equal(calls, 1);
});

test("shouldRetry can stop early (sync and async)", async () => {
  let calls = 0;
  await assert.rejects(
    retry(async () => { calls++; throw new Error("fatal"); }, { ...fast, retries: 5, shouldRetry: (e) => e.message !== "fatal" }),
    RetryError,
  );
  assert.equal(calls, 1);

  calls = 0;
  await assert.rejects(
    retry(async () => { calls++; throw new Error("x"); }, { ...fast, retries: 5, shouldRetry: async (_e, attempt) => attempt < 2 }),
    RetryError,
  );
  assert.equal(calls, 2);
});

test("onRetry receives error, attempt, and delay", async () => {
  const seen = [];
  await retry(async ({ attempt }) => { if (attempt < 3) throw new Error(`e${attempt}`); }, {
    delay: 5, jitter: false, backoff: "fixed",
    onRetry: (e, attempt, d) => seen.push([e.message, attempt, d]),
  });
  assert.deepEqual(seen, [["e1", 1, 5], ["e2", 2, 5]]);
});

test("aborting the outer signal during a wait rejects with AbortError", async () => {
  const ac = new AbortController();
  let calls = 0;
  const p = retry(async () => { calls++; throw new Error("x"); }, { delay: 10_000, jitter: false, retries: 5, signal: ac.signal });
  await new Promise((r) => setTimeout(r, 10));
  ac.abort();
  await assert.rejects(p, (err) => err instanceof AbortError && err.name === "AbortError");
  assert.equal(calls, 1);
});

test("aborting the outer signal during an attempt aborts the attempt signal", async () => {
  const ac = new AbortController();
  let innerAborted = false;
  const p = retry(({ signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => { innerAborted = true; reject(signal.reason); });
  }), { ...fast, signal: ac.signal });
  await new Promise((r) => setTimeout(r, 5));
  ac.abort(new Error("user cancelled"));
  await assert.rejects(p, (err) => err instanceof AbortError && err.message === "user cancelled");
  assert.equal(innerAborted, true);
});

test("already-aborted signal rejects before calling fn", async () => {
  const ac = new AbortController();
  ac.abort();
  let calls = 0;
  await assert.rejects(retry(async () => { calls++; }, { signal: ac.signal }), AbortError);
  assert.equal(calls, 0);
});

test("per-attempt timeout aborts the attempt and retries", async () => {
  const log = [];
  const v = await retry(({ attempt, signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason));
    if (attempt === 1) return; // hang forever
    resolve("second try");
  }), { ...fast, timeout: 20, onRetry: (e) => log.push(e) });
  assert.equal(v, "second try");
  assert.equal(log.length, 1);
  assert.ok(log[0] instanceof TimeoutError);
});

test("timeout on every attempt surfaces TimeoutError inside RetryError", async () => {
  await assert.rejects(
    retry(({ signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))), { ...fast, retries: 1, timeout: 10 }),
    (err) => err instanceof RetryError && err.errors.every((e) => e instanceof TimeoutError),
  );
});

test("timeout does not fire after a fast success", async () => {
  const v = await retry(async () => "quick", { timeout: 50 });
  assert.equal(v, "quick");
  await new Promise((r) => setTimeout(r, 70)); // if the timer leaked, nothing should throw
});

test("an AbortError thrown by fn itself is not retried", async () => {
  let calls = 0;
  await assert.rejects(
    retry(async () => { calls++; const e = new Error("aborted"); e.name = "AbortError"; throw e; }, { ...fast, retries: 5 }),
    RetryError,
  );
  assert.equal(calls, 1);
});

test("default export is retry", async () => {
  const mod = await import("../dist/index.js");
  assert.equal(mod.default, retry);
});

test("abort rejects even when fn ignores its signal and never settles", async () => {
  const ac = new AbortController();
  const p = retry(() => new Promise(() => {}), { ...fast, signal: ac.signal });
  setTimeout(() => ac.abort(), 10);
  await assert.rejects(p, AbortError);
});

test("timeout fails the attempt even when fn ignores its signal", async () => {
  let calls = 0;
  const v = await retry(({ attempt }) => { calls++; return attempt === 1 ? new Promise(() => {}) : "done"; }, { ...fast, timeout: 15 });
  assert.equal(v, "done");
  assert.equal(calls, 2);
});
