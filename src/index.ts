export type Backoff = "exponential" | "linear" | "fixed";

export interface RetryContext {
  /** 1-based attempt number. */
  attempt: number;
  /** Aborts when the caller's signal aborts or the per-attempt timeout fires. Pass it to fetch etc. */
  signal: AbortSignal;
}

export interface RetryOptions {
  /** How many times to retry after the first failure. Total attempts = retries + 1. Default: 3. */
  retries?: number;
  /** Base delay in ms before the first retry, or a function returning the delay for a given attempt. Default: 200. */
  delay?: number | ((attempt: number, error: unknown) => number);
  /** Growth strategy when `delay` is a number. Default: "exponential". */
  backoff?: Backoff;
  /** Multiplier for exponential backoff. Default: 2. */
  factor?: number;
  /** Upper bound on any computed delay in ms. Default: 30_000. */
  maxDelay?: number;
  /** Randomize delays. `true`/"full" picks uniformly in [0, delay]; "equal" picks in [delay/2, delay]; false disables. Default: "full". */
  jitter?: boolean | "full" | "equal";
  /** Abort retrying and the in-flight attempt. */
  signal?: AbortSignal;
  /** Per-attempt timeout in ms. The attempt's signal aborts and the attempt counts as failed with a TimeoutError. */
  timeout?: number;
  /** Decide whether an error is retryable. Default: everything except AbortError and bail(). */
  shouldRetry?: (error: unknown, attempt: number) => boolean | Promise<boolean>;
  /** Called before each wait. Useful for logging. */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

/** Thrown when every attempt failed. `errors` holds each attempt's error; `cause` is the last one. */
export class RetryError extends Error {
  readonly attempts: number;
  readonly errors: unknown[];
  override readonly cause: unknown;
  constructor(errors: unknown[]) {
    const last = errors[errors.length - 1];
    super(`All ${errors.length} attempt(s) failed. Last error: ${describe(last)}`);
    this.name = "RetryError";
    this.attempts = errors.length;
    this.errors = errors;
    this.cause = last;
  }
}

/** Thrown when the caller's AbortSignal aborts. Mirrors the DOM AbortError shape. */
export class AbortError extends Error {
  override readonly cause: unknown;
  constructor(cause?: unknown) {
    super(cause instanceof Error ? cause.message : "The operation was aborted");
    this.name = "AbortError";
    this.cause = cause;
  }
}

/** Thrown into an attempt's signal when `timeout` elapses. */
export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Attempt timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

class BailError extends Error {
  constructor(public readonly original: unknown) {
    super("bail");
    this.name = "BailError";
  }
}

/**
 * Throw this from inside `fn` to stop retrying immediately.
 * The original error is rethrown to the caller unchanged.
 *
 * @example
 *   retry(async () => { const r = await fetch(url); if (r.status === 404) throw bail(new Error("not found")); })
 */
export function bail(error: unknown): Error {
  return new BailError(error);
}

function describe(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

function isAbortLike(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}

/** Compute the delay before retry number `attempt` (1-based), applying backoff, cap, and jitter. */
export function backoffDelay(
  attempt: number,
  options: Pick<RetryOptions, "delay" | "backoff" | "factor" | "maxDelay" | "jitter"> = {},
  error?: unknown,
): number {
  const { delay = 200, backoff = "exponential", factor = 2, maxDelay = 30_000, jitter = "full" } = options;
  let ms: number;
  if (typeof delay === "function") {
    ms = delay(attempt, error);
  } else if (backoff === "fixed") {
    ms = delay;
  } else if (backoff === "linear") {
    ms = delay * attempt;
  } else {
    ms = delay * Math.pow(factor, attempt - 1);
  }
  ms = Math.min(Math.max(0, ms), maxDelay);
  if (jitter === "equal") ms = ms / 2 + Math.random() * (ms / 2);
  else if (jitter === true || jitter === "full") ms = Math.random() * ms;
  return Math.round(ms);
}

/** Promise-based sleep that rejects with AbortError when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortError(signal.reason));
    const onAbort = () => {
      clearTimeout(t);
      reject(new AbortError(signal?.reason));
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Run `fn` until it resolves, retrying on failure with backoff.
 *
 * - Resolves with `fn`'s value on the first success.
 * - Rejects with `RetryError` when all attempts fail.
 * - Rejects with `AbortError` when `options.signal` aborts, during a wait or an attempt.
 * - Rejects with the original error immediately when `fn` throws `bail(error)`.
 */
export async function retry<T>(
  fn: (ctx: RetryContext) => Promise<T> | T,
  options: RetryOptions = {},
): Promise<T> {
  const { retries = 3, signal, timeout, shouldRetry, onRetry } = options;
  if (!Number.isInteger(retries) || retries < 0) throw new RangeError("retries must be a non-negative integer");
  const errors: unknown[] = [];

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    if (signal?.aborted) throw new AbortError(signal.reason);

    const controller = new AbortController();
    const onOuterAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onOuterAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut: TimeoutError | undefined;
    if (timeout !== undefined) {
      timer = setTimeout(() => {
        timedOut = new TimeoutError(timeout);
        controller.abort(timedOut);
      }, timeout);
    }

    // Race the attempt against its own signal so a function that ignores the
    // signal cannot hang the caller: abort or timeout always settles the attempt.
    const aborted = new Promise<never>((_, reject) => {
      const onAbort = () => reject(controller.signal.reason);
      if (controller.signal.aborted) onAbort();
      else controller.signal.addEventListener("abort", onAbort, { once: true });
    });

    try {
      const run = Promise.resolve().then(() => fn({ attempt, signal: controller.signal }));
      run.catch(() => {}); // the orphaned attempt must not surface as an unhandled rejection
      return await Promise.race([run, aborted]);
    } catch (raw) {
      let error: unknown = raw;
      if (signal?.aborted) throw new AbortError(signal.reason);
      if (raw instanceof BailError) throw raw.original;
      if (timedOut) error = timedOut;
      errors.push(error);

      const last = attempt === retries + 1;
      const retryable = isAbortLike(error) ? false : shouldRetry ? await shouldRetry(error, attempt) : true;
      if (last || !retryable) throw new RetryError(errors);

      const wait = backoffDelay(attempt, options, error);
      onRetry?.(error, attempt, wait);
      await sleep(wait, signal);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onOuterAbort);
      aborted.catch(() => {});
    }
  }
  // Unreachable: the loop either returns or throws.
  throw new RetryError(errors);
}

export default retry;
