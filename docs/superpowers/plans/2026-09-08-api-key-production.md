# API Key Production Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Add production-grade single-host API-key controls and operational safeguards.

**Architecture:** Extend the existing atomic JSON registry for durable key metadata and usage. Add a small in-memory admission/rate controller because this service is intentionally one process; integrate it into existing generation routes and expose sanitized state through the vanilla admin UI.

**Tech Stack:** Node.js, TypeScript, Express, native filesystem/AbortSignal, vanilla HTML/CSS/JS, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-08-api-key-production-design.md`

## Global Constraints

- No Kubernetes, Redis, frontend framework, or new dependency.
- Preserve current API keys and OpenAI route contracts.
- Never persist or log raw key secrets or prompts.
- Test behavior before implementation.

---

### Task 1: Durable key policy and usage

**Files:** Modify `src/auth.ts`, `test/auth.test.ts`.

Add optional expiry and requests-per-minute policy, usage counters, last-used timestamp, metadata update, and atomic usage recording. Legacy records receive safe defaults.

### Task 2: Admission, rate limits, timeouts, and observability

**Files:** Create `src/admission.ts`, `test/admission.test.ts`; modify `src/config.ts`, `src/server.ts`, relevant tests and `.env.example`.

Add bounded global/per-key execution, rolling per-key request limits, queue saturation errors, execution timeout signals, request IDs/logs, readiness, metrics, and usage recording for generation routes.

### Task 3: Admin dashboard and documentation

**Files:** Modify `src/public/index.html`, `src/public/styles.css`, `src/public/app.js`, `README.md`, and admin tests.

Expose editable expiry/rate policy, usage totals, last-used data, service capacity metrics, and copy-ready setup while preserving the one-time-secret behavior.

### Task 4: Integration and independent review

Run the entire test/type/dependency/static-JS suite, start the actual server, verify health/readiness/UI, inspect for secret leakage and API regressions, and resolve review findings.
