# HCAST / METR Task Standard Adapter

This adapter converts a METR Task Standard-style task description into an
InfiniClaw workspace:

- `PLAN.md`
- immutable `DIRECTIVES.md`
- `JOURNAL.md`
- `INVENTORY.md`
- `project-plan/*.md`
- `.infiniclaw/hcast-task.json`

The adapter is intended for leaderboard-oriented work. Official benchmark
scoring should remain outside the agent workspace. The optional local score
helper is only for adapter smoke tests and local fixtures.

## Task Spec

Use JSON:

```json
{
  "schema_version": 1,
  "benchmark": "metr-task-standard",
  "task_family": "reverse_hash",
  "task_name": "abandon",
  "tier": "2h-4h",
  "expertise": "software_engineering",
  "instructions": "Official task instructions shown to the agent.",
  "submission": {
    "path": "submission.txt",
    "format": "Plain text Task Standard submission."
  },
  "public_verifiers": [
    { "type": "file_exists", "path": "submission.txt" }
  ],
  "score": {
    "command": "python score.py",
    "min": 1,
    "timeout_sec": 300,
    "cwd": "."
  }
}
```

`score` is optional and is not exposed to the generated workspace unless
`--with-local-score-helper` is explicitly passed.

## Generate

```bash
node bench/adapters/hcast/generate-workspace.mjs \
  --spec /path/to/task-spec.json \
  --out /tmp/infiniclaw-hcast-task
```

For a local smoke fixture only:

```bash
node bench/adapters/hcast/run-fixture-smoke.mjs
```

## Benchmark Flow

1. Use the official Task Standard or Task Bridge environment to obtain the task
   instructions, public setup, public tests, and submission path.
2. Generate the InfiniClaw workspace without `--with-local-score-helper`.
3. Run the agent inside the official task environment with directive mode
   enabled.
4. Submit the final artifact through the official task runner and record the
   official score.

This keeps hidden scoring external while still giving InfiniClaw verifier-gated
progress on public, benchmark-compliant artifacts.
