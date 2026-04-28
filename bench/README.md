# Benchmarks

This directory holds the benchmark adapters and the synthetic attribution harness described in [BUILD.md § 17](../BUILD.md#17-benchmarks--validation-hcast-4h-as-the-north-star).

## Structure (Phase 5-6)

```
bench/
├── adapters/
│   ├── hcast/                # HCAST task → PLAN.md + main DIRECTIVES
│   ├── the-agent-company/    # TheAgentCompany simulated-company tasks
│   └── swe-bench/            # SWE-Bench Verified / Pro issues
└── synthetic/
    └── fifty-stage-rest/     # 50-stage REST framework synthetic project
                              # for mechanism attribution + ablation
```

## North star

**HCAST 4h+ tier.** That's the tier where naive agents structurally fail due to context compaction state loss — precisely what the Persistent Directive System fixes. Per-tier thresholds in BUILD.md § 17.2.

## Secondary targets

- **TheAgentCompany** — multi-stage + shared resources + colleague comms. Best-of-field ≈30% (2024). Target for 1.0: ≥45%.
- **SWE-Bench Verified / Pro** — variance-reduction test (peak similar; variance sharply tighter due to verifier gate).
- **MLE-bench** — depends on quality of `mle-bench.ts` verifier library; target top-quartile on 10 representative competitions.

## Synthetic attribution bench

Run the 50-stage REST framework synthetic, then ablate each mechanism individually. Each ablation should cleanly attribute one metric delta to one mechanism (BUILD.md § 17.4). Phase 5-6 work.

## Status

Synthetic fixture generation exists under `synthetic/fifty-stage-rest`. The
first METR Task Standard/HCAST-style workspace adapter exists under
`adapters/hcast`; real benchmark scoring still needs to be run through the
official task environment/bridge.
