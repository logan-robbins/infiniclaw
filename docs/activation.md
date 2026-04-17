# Activation model

The full reference is [BUILD.md § 6.0](../BUILD.md#60-activation-model-how-the-plugin-becomes-live). This document is the short user-facing version.

## Three tiers

### Tier 1 — plugin always loaded, zero cost when idle

Once `@infiniclaw/directive-persistence` is installed in your OpenClaw environment, it's loaded at every session startup. But **without `DIRECTIVES.md` in the workspace, every hook is a no-op**. No tokens, no behavior change, no configuration. If you never create a `DIRECTIVES.md`, you'll never notice the plugin exists.

### Tier 2 — per-session activation by file presence

The moment `DIRECTIVES.md` (and `JOURNAL.md`) exist in a session's `workspaceDir`:

- `before_prompt_build` starts injecting LIVE STATE from JOURNAL.
- `before_compaction` / `after_compaction` start emitting events.
- Plugin tools (`verifier.run`, `journal.*`, `report_task_*`) become callable.
- The post-turn DONE-revert validator activates.

This is the automatic path for **sub-agents**: the parent writes `DIRECTIVES.md` + `JOURNAL.md` into the child's workspace before `sessions_spawn`, and the child boots with the directive system fully live. No additional configuration.

### Tier 3 — explicit opt-in for the top-level (main) session

Main agents have no parent, so their `extraSystemPrompt` has to come from somewhere. Three equivalent triggers:

**CLI flag** (recommended for benchmark adapters):
```bash
openclaw run --directives-mode
```
Plugin reads `./DIRECTIVES.md` at startup, injects as `extraSystemPrompt`, sets `workspaceDir` to cwd.

**Config field** (recommended for long-lived projects):
```jsonc
// openclaw.json
{
  "agents": {
    "defaults": {
      "directive_mode": true
    }
  }
}
```

**Bootstrap command** (recommended for first-time setup):
```bash
openclaw directives init --preset software
```
Writes skeleton `PLAN.md` + `DIRECTIVES.md` using the chosen preset, then drops into a directive-mode session.

## Presets

Sub-agent DIRECTIVES are composed from a preset + task-specific fill. Current presets:

| Preset | Use when |
|--------|----------|
| `software-implementation` | Primary output is a new file under `src/`, `tests/`, etc. |
| `refactor` | Primary output is a diff to an existing file; behavior must not change. |
| `debugging` | Primary output is a bug fix + regression test. |
| `data-pipeline` / `ml` | Primary output is a submission file + script (Kaggle-style). |
| `research-writeup` | Primary output is an analysis or report with citations. |
| `general-task` | Fuzzy success criteria; uses `llm_judge` with a task-specific rubric. |

See [BUILD.md § 6.0a](../BUILD.md#60a-default-directives-template-and-presets) for the full table with default verifiers, constraints, and turn-budget heuristics.
