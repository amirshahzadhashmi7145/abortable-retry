# Changelog

## 1.0.0 (2026-11-02)

- Initial release: `retry`, `bail`, `backoffDelay`, `sleep`, and `RetryError`, `AbortError`, `TimeoutError`.
- Exponential, linear, and fixed backoff with full or equal jitter and a max delay cap.
- Per-attempt timeouts and outer `AbortSignal` propagated to each attempt.
- ESM and CommonJS builds with TypeScript types. Node 18+.
