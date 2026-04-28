# YC-Bench Adapter

YC-Bench is the first leaderboard target for InfiniClaw because it directly
tests long-horizon coherence, context truncation, and persistent scratchpad
quality. The public leaderboard already ranks Kimi K2.6, so it gives us a
realistic path to check whether the persistence design can improve a ranked
model without immediately paying for frontier-model full sweeps.

This adapter does not modify YC-Bench. It generates a custom YC-Bench TOML
config that preserves the official default world mechanics while replacing the
agent system prompt with an InfiniClaw-style persistent directive protocol.

## Prerequisites

```bash
git clone https://github.com/collinear-ai/yc-bench.git /tmp/yc-bench
uv sync --project /tmp/yc-bench
```

API keys can be provided through the shell environment or with `--env-file`.
The runner reads the file into the child process environment and does not print
secret values.

## Short Smoke

Use a GPT-5-family model for the first end-to-end smoke:

```bash
node bench/adapters/yc-bench/run-smoke.mjs \
  --yc-bench-dir /tmp/yc-bench \
  --env-file /home/azureuser/.openclaw/.env \
  --model openai/gpt-5-mini \
  --seed 1 \
  --max-turns 12
```

`max_turns` intentionally stops the benchmark before the one-year horizon. The
wrapper treats a generated rollout with `max_turns` terminal detail as a valid
smoke result.

Use the same wrapper for a full one-seed run by replacing `--max-turns N` with
`--full`.

Latest local GPT-5-mini smoke:

- `seed=1`, `max_turns=18`, `model=openai/gpt-5-mini`
- final net worth: `$212,083.26`
- task stats: 2 completed successes, 0 completed failures, 2 planned
- total API cost reported by LiteLLM: `$0.063273`

The current public YC-Bench checkout produced a SQLAlchemy traceback for
`yc-bench task cancel` during smoke testing. The generated prompt therefore
treats cancellation as unreliable: if post-accept inspection reveals scope
creep, it leaves the task planned/abandoned and avoids dispatching it.

## Kimi Path

YC-Bench uses LiteLLM model IDs. With a working Moonshot account, Kimi K2.6 is:

```bash
node bench/adapters/yc-bench/run-smoke.mjs \
  --yc-bench-dir /tmp/yc-bench \
  --env-file /home/azureuser/.openclaw/.env \
  --model moonshot/kimi-k2.6 \
  --seed 1 \
  --max-turns 12
```

If Moonshot quota is unavailable, keep using `openai/gpt-5-mini` for integration
smokes and only switch to Kimi for a real 3-seed attempt after a one-seed
short run succeeds.

## Leaderboard Attempt

For a leaderboard-comparable local result, generate the config without
`--max-turns` and run the official one-year default on seeds 1, 2, and 3:

```bash
RUN_DIR=/tmp/infiniclaw-yc-bench-full
mkdir -p "$RUN_DIR"
node bench/adapters/yc-bench/generate-config.mjs \
  --out "$RUN_DIR/infiniclaw-yc-bench.toml"

for SEED in 1 2 3; do
  node bench/adapters/yc-bench/run-smoke.mjs \
    --yc-bench-dir /tmp/yc-bench \
    --env-file /home/azureuser/.openclaw/.env \
    --work-dir "$RUN_DIR/seed-$SEED" \
    --model openai/gpt-5-mini \
    --seed "$SEED" \
    --full
done
```

Average final `time_series.funds[-1].funds_cents / 100` across the three result
JSON files. That average is the number to compare against the YC-Bench public
leaderboard.
