# 50-Stage REST Synthetic

This synthetic benchmark is the cheap proof path before HCAST. It generates a
deterministic long-running workspace with `PLAN.md`, `DIRECTIVES.md`,
`JOURNAL.md`, `INVENTORY.md`, and 50 stage files.

Each generated stage asks the agent to create one tiny ES module and publish a
service card on seal. The work is intentionally simple; the benchmark measures
whether InfiniClaw preserves state, enforces verified DONE transitions, keeps
the journal bounded, and avoids duplicate sealed services across many stages.

## Generate

```bash
node bench/synthetic/fifty-stage-rest/generate-fixture.mjs --out /tmp/infiniclaw-50-stage
```

Options:

- `--out <dir>`: target workspace directory.
- `--stages <n>`: stage count, default `50`.
- `--profile basic|api|api-compute`: task shape, default `basic`. Use `api`
  for branchy handler tasks and `api-compute` for benchmark-like handlers with
  arithmetic behavior plus hidden-edge verifier cases.

## Short Smoke Run

Build the package, then run a local no-model smoke test that seals a small
generated plan through the real plan/stage/inventory verifier path:

```bash
cd packages/directive-persistence
../../node_modules/.bin/tsc -p tsconfig.json
cd ../..
node bench/synthetic/fifty-stage-rest/run-smoke.mjs --stages 3
```

## Short Comparison Run

After building, run a deterministic baseline-vs-InfiniClaw comparison with one
planted defect. The baseline "claims done" after writing files; InfiniClaw must
reject the defective stage seal, repair it, and finish.

```bash
node bench/synthetic/fifty-stage-rest/run-comparison.mjs --stages 3 --defect-stage stage-02
```

## Optional Model Smoke Run

This uses an already-configured OpenAI-compatible doer model for a tiny run.
Keep `--stages` low until cost and behavior are measured.

```bash
INFINICLAW_DOER_PROVIDER=openai \
INFINICLAW_DOER_MODEL=<cheap-model-in-your-account> \
OPENAI_API_KEY=... \
node bench/synthetic/fifty-stage-rest/run-model-smoke.mjs --stages 1
```

## Optional Same-Model Comparison Run

Use this before public benchmark adapters. It gives vanilla baseline and
InfiniClaw the same first-pass model output, scores the baseline with the
external verifier, and lets InfiniClaw repair only after verifier-gated seal
failure.

```bash
INFINICLAW_DOER_PROVIDER=openai \
INFINICLAW_DOER_MODEL=<cheap-gpt-5-family-model> \
OPENAI_API_KEY=... \
node bench/synthetic/fifty-stage-rest/run-model-comparison.mjs --stages 10 --profile api-compute
```

For a local or proxy endpoint:

```bash
INFINICLAW_DOER_PROVIDER=openai-compatible \
INFINICLAW_DOER_BASE_URL=http://127.0.0.1:4000/v1 \
INFINICLAW_DOER_MODEL=<model> \
INFINICLAW_DOER_API_KEY=... \
node bench/synthetic/fifty-stage-rest/run-model-smoke.mjs --stages 1
```

## Intended Metrics

- stages sealed
- DONE accuracy
- compactions per sealed stage
- root `JOURNAL.md` size
- DRY violations
- parent re-prompt rate
- `AGENT:JOURNAL_DONE_REVERTED` recovery behavior
