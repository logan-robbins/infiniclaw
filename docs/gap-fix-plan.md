# Gap Fix Plan

schema_version: 1
created: 2026-04-27T20:00:00Z
status: ACTIVE

## Goal

Move InfiniClaw from a tested prototype to a runnable long-horizon benchmark
system that can prove the persistence design cheaply first, then compete with a
strong doer model.

## Current Decision

Use YC-Bench as the first real leaderboard target because it directly measures
long-horizon coherence, context truncation, and persistent scratchpad quality.
Use `gpt-5-mini` for balanced cost/performance smoke and one-seed trials, and
use Kimi K2.6 through LiteLLM model `moonshot/kimi-k2.6` only after Moonshot
quota/balance is available. Keep HCAST/METR Task Standard as the Task Bridge
north-star path, but treat local HCAST execution as blocked until Docker is
available.

## Progress

- [x] Fix package typecheck blocker in verifier schema/types.
- [x] Add OpenAI-compatible provider layer with Kimi preset.
- [x] Wire provider-backed `llm_judge` into verifier execution.
- [x] Add provider tests with mocked Kimi-compatible chat completions.
- [x] Add provider-backed doer chat path for optional short model smoke runs.
- [x] Run short OpenAI model smoke with `gpt-4.1-nano`: 5/5 synthetic stages sealed.
- [x] Add runnable synthetic 50-stage benchmark fixture generator.
- [x] Add short no-model synthetic end-to-end smoke test and runnable script.
- [x] Add deterministic baseline-vs-InfiniClaw comparison with a planted defect.
- [x] Register real OpenClaw tools: `verifier.run`, `journal.*`,
      `report_task_complete`, and `report_task_blocked`.
- [x] Add synthetic API-handler profile with branchy verifier checks for method,
      path, auth, body validation, output shape, and forbidden implementation
      patterns.
- [x] Run live GPT-5-family model smoke with OpenAI `gpt-5-mini`, low reasoning:
      10/10 API-profile stages sealed.
- [x] Run live GPT-5-family model smoke with OpenAI `gpt-5-mini`, low reasoning:
      20/20 API-profile stages sealed, 20 inventory entries, 0 rejected seals,
      0 repairs, 250.76s wall time.
- [x] Add same-model live comparison runner: baseline gets the same first-pass
      model output and is scored externally; InfiniClaw must seal through the
      verifier/retry path.
- [x] Add `api-compute` synthetic profile with multi-input compute behavior,
      hidden-edge verifier cases, and labeled failure evidence.
- [x] Run same-model `gpt-5-mini`, low reasoning, API-profile comparison:
      20/20 baseline verified and 20/20 InfiniClaw sealed, so that profile is
      too easy for reliable lift attribution with `gpt-5-mini`.
- [x] Run same-model `gpt-5-nano`, low reasoning, `api-compute` comparison:
      3 stages -> baseline 0/3 verified, InfiniClaw 3/3 sealed after 3 repairs.
- [x] Run same-model `gpt-5-nano`, low reasoning, `api-compute` comparison:
      20 stages -> baseline 4/20 verified, InfiniClaw 20/20 sealed after 16
      repairs, 56,256 total tokens, 256.79s wall time.
- [x] Run full same-model `gpt-5-nano`, low reasoning, `api-compute`
      comparison: 50 stages -> baseline 4/50 verified, 46 false-done claims;
      InfiniClaw 50/50 sealed, 47 rejected-seal recoveries, 50 inventory
      entries, 154,180 total tokens, 669.98s wall time.
- [x] Re-run package gates after GPT-5 scaling changes: TypeScript no-emit,
      vitest, build, 3-stage smoke, and planted-defect comparison all pass.
- [x] Add HCAST/METR Task Standard adapter that emits `PLAN.md`,
      `DIRECTIVES.md`, `JOURNAL.md`, `INVENTORY.md`, stage files, and
      benchmark metadata while keeping official scoring external by default.
- [x] Select YC-Bench as first real leaderboard target: public, long-horizon,
      scratchpad-based, and already ranking Kimi K2.6.
- [x] Add YC-Bench adapter that generates an InfiniClaw-style persistent
      scratchpad system prompt while preserving the official default world
      mechanics.
- [x] Run short YC-Bench GPT-5-family smoke with `openai/gpt-5-mini`:
      4 turns -> structured scratchpad, accepted one task, assigned
      specialists, stopped by `max_turns`, $0.010231.
- [x] Run patched YC-Bench smoke after adding post-accept inspection and
      cancellation workaround: 18 turns -> 2 completed successes, 0 completed
      failures, 2 planned tasks, final net worth $212,083.26, $0.063273.
- [ ] Run the HCAST adapter against a real Task Bridge task environment.
- [ ] Run YC-Bench 3-seed leaderboard-comparable attempt after the smoke passes.
- [x] Run baseline same-model agent and InfiniClaw agent on the synthetic bench.
- [x] Scale synthetic same-model comparison to 50 stages and capture token and
      latency metrics before public benchmark attempts.
- [ ] Run HCAST 2h/4h slices after synthetic attribution is stable.

## Execution Order

1. Keep the package buildable.
   - Required gate: `tsc --noEmit -p packages/directive-persistence/tsconfig.json`
     passes.
   - Required gate: package vitest suite passes.

2. Make model provider selection runtime-configurable.
   - Kimi preset uses `INFINICLAW_JUDGE_PROVIDER=kimi`.
   - Doer smoke runs use `INFINICLAW_DOER_PROVIDER`, `INFINICLAW_DOER_MODEL`,
     and provider credentials.
   - Generic OpenAI-compatible providers use
     `INFINICLAW_JUDGE_PROVIDER=openai-compatible`,
     `INFINICLAW_JUDGE_BASE_URL`, `INFINICLAW_JUDGE_API_KEY`, and
     `INFINICLAW_JUDGE_MODEL`.
   - OpenAI uses `INFINICLAW_JUDGE_PROVIDER=openai` plus an explicit model.

3. Turn verifier functions into real OpenClaw tools.
   - Tools must call the same in-process pass registry used by
     `after_turn` DONE-revert.
   - Tool calls must reject malformed reports before parent-agent parsing.

4. Prove the mechanism on synthetic long runs before public benchmarks.
   - Generate a deterministic 50-stage REST fixture.
   - Run full system, then ablations from `BUILD.md` section 17.4.
   - Track stages sealed, DONE accuracy, DRY violations, compactions per stage,
     cache-hit behavior, and `JOURNAL.md` size.

5. Run YC-Bench before HCAST.
   - Generate `infiniclaw-yc-bench.toml` from `bench/adapters/yc-bench`.
   - Run a short `openai/gpt-5-mini` smoke on seed 1 with a turn cap.
   - If the short smoke produces valid command use and scratchpad updates, run
     the one-year default on seeds 1, 2, and 3.
   - Try `moonshot/kimi-k2.6` only after Moonshot quota is available.

6. Add HCAST only after synthetic proof and YC-Bench smoke.
   - Adapter translates each task into `PLAN.md`, main `DIRECTIVES.md`, and
     stage files.
   - Compare Kimi baseline versus Kimi+InfiniClaw on 2h and 4h slices first.

## Open Gaps

- OpenClaw tool registration is implemented through a small SDK-adapter layer,
  but still needs validation against the real OpenClaw plugin SDK surface.
- `bench/` has synthetic smoke, deterministic comparison, live model smoke,
  same-model model comparison runners, an initial HCAST/METR Task Standard
  workspace adapter, and a YC-Bench leaderboard adapter. HCAST still needs
  execution against the official Task Bridge environment.
- Root scripts assume a `pnpm` command is on PATH; local fallback currently uses
  `corepack pnpm` or direct binaries.
- Prompt-cache behavior is still validated only by design/tests, not by a
  measured OpenClaw run with a configured provider.
- Optional model smoke runner has passed with OpenAI `gpt-4.1-nano` on the
  basic profile and with OpenAI `gpt-5-mini` on the benchmark-like API profile
  through 20 stages. Same-model comparison now shows synthetic lift with
  `gpt-5-nano` on the stricter `api-compute` profile.
- Kimi provider wiring exists, but live Kimi smoke is currently blocked by
  Moonshot account quota/balance.
- YC-Bench Kimi K2.6 should use LiteLLM model `moonshot/kimi-k2.6`; OpenAI
  smokes should use `openai/gpt-5-mini`.
- The current public YC-Bench checkout throws a SQLAlchemy traceback for
  `yc-bench task cancel` in the smoke environment, so the prompt treats cancel
  as unreliable and leaves infeasible post-accept tasks planned/abandoned
  instead of dispatching them.
- Anthropic-specific provider support is not implemented; keep it behind the
  OpenClaw runtime integration milestone unless it becomes necessary.
