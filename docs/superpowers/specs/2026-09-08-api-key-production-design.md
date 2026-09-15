# API Key Production Design

## Goal

Make the existing single-host Codex proxy behave like a dependable API-key service without adding Kubernetes, Redis, a frontend framework, or another runtime dependency.

## Scope

- Preserve `dsh_live_...` keys, hash-only storage, existing OpenAI routes, per-key `CODEX_HOME`, and the loopback-only admin boundary.
- Add key expiry, per-minute limits, usage counters, last-used timestamps, and editable limits to the existing atomic key registry.
- Add bounded global/per-key concurrency, a bounded waiting queue, execution timeouts, OpenAI-shaped `429`/timeout errors, and `Retry-After`.
- Add `x-request-id`, structured request logs, readiness, admin metrics, and usage data in the UI.
- Do not add distributed infrastructure, background Responses, tool execution, billing, or multi-host coordination.

## Data and request flow

The existing key registry remains the single durable store. Authentication validates active and unexpired keys. Generation routes then consume an in-memory per-key rolling-minute allowance, enter a bounded admission queue, execute Codex with a timeout, and record durable request/token/success/failure totals. Informational endpoints authenticate but do not consume generation quota.

Every request receives an `x-request-id`. Completion logs contain only request ID, route, status, duration, and key ID after authentication; raw keys and prompts are never logged. `/readyz` validates the prepared filesystem and reports capacity. Local admin endpoints expose aggregate metrics and sanitized key metadata.

## Compatibility and failure behavior

Existing successful response bodies remain compatible. Capacity and rate-limit rejection use HTTP 429 with `Retry-After`; pre-stream timeouts use 504, while failures after streaming begins use the route's existing SSE error format. Disconnects abort queued or running work and release capacity.

## Verification

Tests cover expiry, metadata updates, persisted usage, rolling rate limits, queue saturation, release after failure, request IDs, readiness, metrics, and existing Chat Completions/Responses behavior. Browser verification covers the updated dashboard layout and controls.
