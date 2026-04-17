# @infiniclaw/directive-persistence

The core OpenClaw plugin for the Persistent Directive System.

Full design: see [../../BUILD.md](../../BUILD.md) at repo root.

## What this package does (once Phase 1 ships)

- Registers OpenClaw hooks (`before_prompt_build`, `before_compaction`, `after_compaction`, `after_turn`) that implement the DIRECTIVES/JOURNAL split.
- Registers plugin tools (`verifier.run`, `journal.*`, `report_task_*`) that are the authoritative paths for state changes.
- Enforces verifier-authority via an in-process `verifierPasses` map that the agent cannot reach.
- Ships the main-agent DIRECTIVES template and the sub-agent preset library.

## Structure

```
src/
  index.ts            # plugin entry; registers hooks + tools
  directives/         # DIRECTIVES/JOURNAL schema, parse, atomic write
  verify/             # runner + 13 verifier types + pass-registry
  spawn/              # child DIRECTIVES writer + atomic lock
  services/           # SERVICES.md registry operations
  plan/               # PLAN.md + stage file operations + sealing
  events/             # .agent-events.jsonl writer + stuck detector
templates/
  main-directives.md           # the one universal main-agent template
  presets/
    software-implementation.yaml
    refactor.yaml
    debugging.yaml
    data-pipeline.yaml
    research-writeup.yaml
    general-task.yaml
__tests__/            # vitest suites
```

## Status

Phase 0 stub. Do not install.
