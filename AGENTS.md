# InfiniClaw Agent Write Protocol

This repository implements the OpenClaw persistent directive system from
`BUILD.md`.

- Treat `DIRECTIVES.md` as immutable. It is the agent contract and must not be
  edited by the active agent.
- `JOURNAL.md` is the only mutable agent-state file.
- To mark any step `DONE`, run the verifier runner for that exact step first.
  The latest verifier run for the step must return `allPass`; otherwise the
  JOURNAL write layer rejects the `DONE` transition.
- If any verifier fails, keep the step `IN_PROGRESS` and write the specific
  failure evidence to `WORKING NOTES`.
- After three consecutive identical verifier failures on the same step, the
  system emits `AGENT:STUCK_WARNING`; the agent should report `BLOCKED` instead
  of thrashing.
- Before creating a new implementation file, consult `INVENTORY.md` and reuse a
  matching sealed service as a black box.

