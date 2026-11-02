# abortable-retry

[![npm version](https://img.shields.io/npm/v/abortable-retry.svg)](https://www.npmjs.com/package/abortable-retry)
[![CI](https://github.com/amirshahzadhashmi7145/abortable-retry/actions/workflows/ci.yml/badge.svg)](https://github.com/amirshahzadhashmi7145/abortable-retry/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/abortable-retry.svg)](./LICENSE)

Retry async functions with exponential backoff, jitter, per-attempt timeouts, and first-class `AbortSignal` support. Zero dependencies, fully typed, about 1 kB.

```ts
import { retry } from "abortable-retry";

const user = await retry(
  ({ signal }) => fetch(`/api/users/${id}`, { signal }).then((r) => r.json()),
  { retries: 4, delay: 300, timeout: 5_000, signal: controller.signal },
);
```

Each attempt gets its own `signal` that aborts when the per-attempt `timeout` fires or when your outer `signal` aborts. Pass it to `fetch`, database drivers, or anything else that accepts one, and in-flight work is cancelled instead of leaking.

Even if the function ignores its signal, `retry` still settles: an abort rejects the caller right away, and a timeout fails that attempt and moves on. Your code never hangs on a promise that forgot to listen.

## Install

```sh
npm install abortable-retry
```

Node 18 or newer. ESM and CommonJS, TypeScript types included.

## API

### `retry(fn, options?)`

Runs `fn({ attempt, signal })` until it resolves.

| Option        | Default         | Description |
|---------------|-----------------|-------------|
| `retries`     | `3`             | Retries after the first failure. Total attempts is `retries + 1`. |
| `delay`       | `200`           | Base delay in ms, or `(attempt, error) => ms` for full control. |
| `backoff`     | `"exponential"` | `"exponential"`, `"linear"`, or `"fixed"`. Ignored when `delay` is a function. |
| `factor`      | `2`             | Multiplier for exponential backoff. |
| `maxDelay`    | `30000`         | Cap on any computed delay. |
| `jitter`      | `"full"`        | `"full"` picks in `[0, delay]`, `"equal"` in `[delay/2, delay]`, `false` disables. |
| `signal`      |                 | `AbortSignal` that cancels waits and the in-flight attempt. |
| `timeout`     |                 | Per-attempt timeout in ms. The attempt's `signal` aborts with a `TimeoutError`. |
| `shouldRetry` | retry all       | `(error, attempt) => boolean \| Promise<boolean>`. Return `false` to stop. |
| `onRetry`     |                 | `(error, attempt, delayMs) => void`, called before each wait. |

Outcomes:

- Resolves with `fn`'s value on the first success.
- Rejects with `RetryError` when every attempt failed. `error.errors` holds each attempt's error, `error.cause` is the last one, `error.attempts` is the count.
- Rejects with `AbortError` when `options.signal` aborts, whether during a wait or mid-attempt.
- Rejects with the original error, immediately, when `fn` throws `bail(error)`.

Errors whose `name` is `"AbortError"` are never retried.

### `bail(error)`

Throw this from inside `fn` to give up without retrying. The caller receives `error` itself.

```ts
await retry(async ({ signal }) => {
  const res = await fetch(url, { signal });
  if (res.status === 404) throw bail(new Error("Not found"));
  if (!res.ok) throw new Error(`HTTP ${res.status}`); // retried
  return res.json();
});
```

### `backoffDelay(attempt, options?, error?)`

The delay calculation on its own, in case you want to schedule something yourself. Takes `delay`, `backoff`, `factor`, `maxDelay`, and `jitter`.

```ts
backoffDelay(3, { delay: 100, jitter: false }); // 400
```

### `sleep(ms, signal?)`

Promise-based sleep that rejects with `AbortError` when the signal aborts.

### Error classes

`RetryError`, `AbortError`, and `TimeoutError` are exported so you can check with `instanceof`.

## Recipes

Retry only on network errors and 5xx:

```ts
await retry(callApi, {
  shouldRetry: (err) => err instanceof TypeError || (err.status >= 500 && err.status < 600),
});
```

Honour a `Retry-After` header:

```ts
await retry(callApi, {
  delay: (attempt, err) => err.retryAfterMs ?? 200 * 2 ** (attempt - 1),
});
```

Cancel from a request handler when the client disconnects:

```ts
app.get("/report", async (req, res) => {
  const ac = new AbortController();
  req.on("close", () => ac.abort());
  const data = await retry(({ signal }) => buildReport({ signal }), { signal: ac.signal, retries: 2 });
  res.json(data);
});
```

Log every retry:

```ts
await retry(task, {
  onRetry: (err, attempt, ms) => console.warn(`attempt ${attempt} failed (${err.message}), retrying in ${ms}ms`),
});
```

## License

MIT
