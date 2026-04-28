# Benchmarks

This directory holds the benchmark adapters and the synthetic attribution harness described in [BUILD.md § 17](../BUILD.md#17-benchmarks--validation-hcast-4h-as-the-north-star).

## Structure (Phase 5-6)

```
bench/
├── adapters/
│   ├── hcast/                # HCAST task → PLAN.md + main DIRECTIVES
│   ├── yc-bench/             # YC-Bench config/prompt adapter for leaderboard runs
│   ├── the-agent-company/    # TheAgentCompany simulated-company tasks
│   └── swe-bench/            # SWE-Bench Verified / Pro issues
└── synthetic/
    └── fifty-stage-rest/     # 50-stage REST framework synthetic project
                              # for mechanism attribution + ablation
```

## North star

**YC-Bench first, then HCAST 4h+ tier.** YC-Bench is currently the most direct
public long-horizon leaderboard target for this design because it explicitly
tests scratchpad persistence under context truncation. HCAST remains the north
star for Task Standard/METR-style task environments once the official bridge can
be run in a Docker-capable environment.

## Secondary targets

- **HCAST / METR Task Standard** — official task bridge path for autonomy tasks;
  currently blocked locally by missing Docker.
- **TheAgentCompany** — multi-stage + shared resources + colleague comms. Best-of-field ≈30% (2024). Target for 1.0: ≥45%.
- **SWE-Bench Verified / Pro** — variance-reduction test (peak similar; variance sharply tighter due to verifier gate).
- **MLE-bench** — depends on quality of `mle-bench.ts` verifier library; target top-quartile on 10 representative competitions.

## Synthetic attribution bench

Run the 50-stage REST framework synthetic, then ablate each mechanism individually. Each ablation should cleanly attribute one metric delta to one mechanism (BUILD.md § 17.4). Phase 5-6 work.

## Status

Synthetic fixture generation exists under `synthetic/fifty-stage-rest`. The
first METR Task Standard/HCAST-style workspace adapter exists under
`adapters/hcast`; real HCAST scoring still needs to be run through the official
task environment/bridge. YC-Bench prompt/config generation exists under
`adapters/yc-bench` for near-term leaderboard-comparable runs.
