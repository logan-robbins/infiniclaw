# InfiniClaw

**A persistent directive system for long-horizon agents. Verified-done work that survives arbitrary context compaction, runs indefinitely, and never silently skips a step.**

---

## Status

**Design-complete, pre-implementation.** The architecture is specified in full at [BUILD.md](./BUILD.md) (~2100 lines). Phase 1 implementation tracks the roadmap in § 15.

## What this is

A plugin for OpenClaw that lets an agent (or a tree of agents) work on tasks that would normally be too long to complete — hours to days of human-equivalent work — without the usual failure modes:

- **Amnesia** on context compression
- **Silent early-stopping** ("the agent thinks it's done; it isn't")
- **Over-planning** ("the agent plans for a week and ships nothing")
- **DRY violations** across parallel sub-agents rebuilding the same utilities

It fixes these by putting the agent's contract and state on disk, re-injecting them every turn, mechanically verifying every "done" claim, and keeping a global service registry that every agent consults before writing anything.

## Three ideas load-bearing the whole design

1. **Disk is memory; context is scratch.** Each agent has `DIRECTIVES.md` (immutable contract, chmod 0444, lives in the cached system prompt) and `JOURNAL.md` (mutable tracker, re-read every turn, injected after the cache boundary). The context window is disposable. Compression is a recoverable non-event.

2. **Verifier authority, not self-report.** Thirteen typed verifier types — from `shell_exit_zero` to `test_passes` to `llm_judge` — are the only path to marking a step `DONE`. Authority lives in the plugin's JavaScript heap (the `verifierPasses` map), unreachable from any agent bash, `fs.writeFile`, or `chmod` escape hatch. A post-turn validator reverts any forged `DONE` transitions.

3. **Black-box service registry.** Every sealed output publishes to `SERVICES.md`. Every agent consults it before writing a new file. DRY across parallel sub-agents becomes a structural impossibility, not a best-effort convention.

## Benchmark target

**HCAST 4h+ tier.** That's where naive agents structurally fail due to compaction state loss — precisely what this design fixes. See [BUILD.md § 17](./BUILD.md#17-benchmarks--validation-hcast-4h-as-the-north-star) for per-tier thresholds and the ablation protocol.

Secondary targets: TheAgentCompany (multi-agent coordination), MLE-bench (multi-stage ML pipelines), SWE-Bench Pro (long-horizon SWE).

## Where to read next

- **Design spec:** [BUILD.md](./BUILD.md) — the whole architecture, load-bearing for every implementation decision.
- **Activation model:** [docs/activation.md](./docs/activation.md) — how to turn the system on for a session.
- **Design principles:** [BUILD.md § 2](./BUILD.md#2-design-principles-invariants-every-section-upholds) — 14 invariants every mechanism upholds.
- **Roadmap:** [BUILD.md § 15](./BUILD.md#15-implementation-roadmap) — Phases 1-6, tracked as GitHub milestones.

## Repository layout

```
infiniclaw/
├── BUILD.md                        # canonical design spec
├── packages/
│   └── directive-persistence/      # the OpenClaw plugin
│       ├── src/                    # plugin code (Phase 1+)
│       ├── templates/              # main-directives.md + presets/*.yaml
│       └── __tests__/
├── bench/                          # HCAST, TheAgentCompany, SWE-bench adapters + synthetic
├── docs/                           # user-facing docs
├── scripts/                        # watch-events, agent-report, etc.
└── .github/workflows/              # CI
```

## Contributing

This is a single-author research project during Phase 0. Contributions welcome once Phase 1 ships a working plugin skeleton — track issues under the **Phase 1 — Foundation** milestone.

## License

MIT — see [LICENSE](./LICENSE).
