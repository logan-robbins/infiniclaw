# CLAUDE.md — onboarding for AI coding agents working on infiniclaw

For Claude Code (or any AI agent) opening this repo cold. The design spec at `BUILD.md` is the source of truth (~2,000 lines); don't load it all upfront.

## What this is, in one sentence

An OpenClaw plugin that gives long-horizon agents a disk-based directive system (`DIRECTIVES.md` / `JOURNAL.md` / `INVENTORY.md` / verifier authority) so they survive context compaction, can't silently early-stop, and don't duplicate work across parallel sub-agents.

## Status

Phase 0 (scaffold + spec) is complete. **Phase 1 (Foundation) is the next implementation milestone** — and nothing else can proceed without it. The plugin entry at `packages/directive-persistence/src/index.ts` is a 39-line Phase 0 stub.

## Read order (before writing any code)

1. **`README.md`** — three load-bearing ideas, repo layout.
2. **`BUILD.md` § 0–3** — the four failure modes, the 14 design invariants, the five artifacts. **The invariants in § 2 are non-negotiable**; if your code contradicts one, it's a bug.
3. **`BUILD.md` § 15 — Phase 1** — the concrete task list and ship gate for the next milestone.
4. **`BUILD.md` § 5 (file schemas) and § 6 (hooks)** — the parsing and injection surfaces you'll implement.
5. **`BUILD.md` § 13** — the prompt-cache layout. Invariant 12 (system prompt byte-stable for the agent's lifetime) is what makes the design economical; if your code mutates the system prompt mid-run, you've broken it.
6. **`BUILD.md` § 7 (verifier contract) and § 10 (write protocol)** — the authority model. The in-heap `verifierPasses` map is the only path to DONE.

§§ 8, 9, 11, 12, 14, 16–18 can wait until Phases 3–6.

## Where to start coding (Phase 1)

Concrete tasks live at **`BUILD.md` § 15 Phase 1**. Package layout at § 6.4. Critical-path order:

1. `directives/schema.ts` — zod schemas (DIRECTIVES, JOURNAL, PLAN, stage, INVENTORY, events).
2. `directives/parse.ts` — typed DIRECTIVES parser; throws `DirectivesParseError` with line/column.
3. `directives/journal.ts` — JOURNAL parser + atomic writer (tmp + fsync + rename + dir-fsync).
4. `directives/inject.ts` — `buildLiveStateInjection(journal)` producing the byte-stable block from § 6.6.
5. `spawn/write-directives.ts` — atomic write that **refuses to overwrite** an existing file (write-once enforcement; § 10.4).
6. `events/log.ts` — `O_APPEND | O_CREAT` writer with per-line fsync and ≤400B snapshot cap.
7. `index.ts` — register `before_prompt_build`, `before_compaction`, `after_compaction` hooks. **All hooks no-op when `JOURNAL.md` is absent** — that's the zero-footprint default for non-directive sessions.
8. Unit + integration tests — see § 15 Phase 1 for the exact test matrix (parse round-trip, atomic write crash recovery, write-once refusal, prompt-cache observability over a 20-turn run).

**Ship gate:** all Phase 1 tests pass; no regression in `prompt-cache-observability.test.ts` or `run.overflow-compaction.*`; a measured 20-turn run shows ≥90% system-token cache hit rate. Don't merge without this.

## Things NOT to do

- **Don't mutate the system prompt mid-run.** § 2 invariant 12. Dynamic state goes into `prependSystemContext` (after the cache boundary), never into `system`. Adding a new turn must never invalidate the cached system prefix — same shape as a Responses-API-style implicit cache.
- **Don't reintroduce tamper detection / `chmod 0444` / SHA lock files.** That mechanism was deliberately removed (§ 10.4). The writer refusing to overwrite an existing `DIRECTIVES.md` is sufficient; the in-heap `verifierPasses` map is the real authority. Editing the contract bytes gains the agent nothing.
- **Don't drift from `BUILD.md`.** If implementation reality forces a spec change, edit `BUILD.md` *first*, then implement against the new spec. Code and spec must not diverge.
- **Don't expand scope past Phase 1.** Phases 2–6 depend on Phase 1 shipping clean. Stay focused.
- **Don't add comments that narrate what the code does.** Default is no comments; only add one when the *why* is non-obvious (a hidden constraint, a workaround, behavior that would surprise a reader).

## File map

| Path | Notes |
|---|---|
| `BUILD.md` | Source of truth; ~2,000 lines. Authoritative for every decision. |
| `README.md` | High-level overview; first read for humans and agents alike. |
| `packages/directive-persistence/src/index.ts` | Phase 0 stub; replace in Phase 1. |
| `packages/directive-persistence/templates/main-directives.md` | Main-agent DIRECTIVES template; ready to use. |
| `packages/directive-persistence/templates/presets/*.yaml` | Sub-agent preset library; ready to use. |
| `packages/directive-persistence/__tests__/` | Empty; populate in Phase 1. |
| `scripts/`, `bench/` | Phase 5–6 placeholders (READMEs only). |
| `.github/workflows/ci.yml` | CI; currently echoes "no tests yet — Phase 1". Wire up vitest in Phase 1. |
| `docs/activation.md` | How a session opts into the directive system (Tier 1/2/3). |

## When the spec and the world disagree

If `BUILD.md` says one thing and the OpenClaw runtime does another, **stop and surface the discrepancy** before coding around it. The plugin SDK signatures in § 6 are pulled from real source paths (`src/agents/pi-embedded-runner/run/attempt.prompt-helpers.ts`, `compaction-hooks.ts`); if those have moved or changed in the OpenClaw checkout you have, that's a spec-update event, not an implementation creativity event.
