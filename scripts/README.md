# scripts/

Helper scripts shipped alongside the plugin. Phase 5 fills this in.

Planned:

- `watch-events.sh` — `tail -f .agent-events.jsonl | jq .` with filters.
- `agent-report.ts` — per-agent compression count, step histogram, cost, budget.
- `validate-plan.ts` — schema-check PLAN.md and stage files; pre-commit friendly.
- `verifier-passes-inspect.ts` — dump the in-process `verifierPasses` mirror from `.plugin-state/` for debugging.

See [BUILD.md § 15 Phase 5](../BUILD.md#phase-5--observability-supervision-and-verifier-libraries).
