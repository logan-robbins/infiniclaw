# BUILD.md — Persistent Directive System for OpenClaw

**Status:** DESIGN COMPLETE — ready to implement
**Authors:** Logan + Chad Claugh
**Date (revised):** 2026-04-16
**Target runtime:** OpenClaw 2026 (`pi-embedded-runner`, plugin SDK hooks, Claude 4.7 + 1h prompt cache)

This document is the authoritative specification for the persistent directive system. It describes the full architecture: invariants, file schemas, hook infrastructure, prompt-cache coexistence, plan decomposition, sub-agent recursion, service registry for DRY prevention, verifier contract, compression event log, stuck detection, and implementation roadmap. Read it end to end before touching any code — every section is load-bearing.

---

## 0. Why this exists (the one-paragraph version)

Long-horizon agent work fails in four specific ways: (1) **amnesia** — context compression deletes operational state and the agent must re-derive it from lossy summaries; (2) **early stopping** — a step that is *kinda* done gets marked done, downstream builds on a cracked foundation; (3) **over-planning** — agents burn days "planning" with no artifacts; (4) **DRY violations** — one sub-agent rebuilds what another sub-agent already sealed because it has no way to discover what exists. This system fixes all four by externalizing state to disk, re-injecting it every turn, verifying every DoD criterion mechanically before advancement, and maintaining a global **Service Registry** that every agent consults before writing a single new file. The agent is never allowed to stop early, never allowed to skip a hard step, and never allowed to rebuild what's already sealed.

---

## 1. Problem Statement (the four failure modes)

### 1.1 Amnesia
Current LLM agents lose operational state on every compression. At ~256K+ tokens, the summary produced by compaction is lossy in the exact dimensions that matter: "which step am I on," "which DoD criteria are still open," "what did sub-agent A already produce." The agent wakes up from the compaction with a narrative summary instead of ground truth and must re-derive the work from that narrative. The longer the task, the more likely the agent loses its place, silently changes approach mid-flight, or declares "done" without meeting the original DoD.

### 1.2 Early stopping
"Kinda done" is lethal. A step that *looks* done but has an unchecked DoD criterion corrupts every downstream step that depends on its output contract. The failure is rarely loud — the downstream agent builds on the broken output, produces something that also seems to work, and the error compounds silently until integration.

### 1.3 Over-planning
Agents asked to "plan" unconstrained will happily spend a week refining the plan instead of producing artifacts. The fix is a hard rule: planning is a numbered step with its own DoD and a tight turn budget, and it produces concrete stage files on disk — not a discussion.

### 1.4 DRY violations
Three sub-agents spawned in parallel will happily implement the same utility three times, because each agent only sees its own DIRECTIVES.md. The fix is a global **Service Registry** (`SERVICES.md`) that every agent must consult (and every sealed output must publish to) before implementing anything. The registry is the single source of truth for "what is already built and how do I call it."

### 1.5 The root cause (one sentence)
**Disk does not compress.** Files survive reboots, image upgrades, context windows, and model swaps. The agent cannot forget what is written in a file it reads every single turn. This system makes disk the agent's memory and the context window disposable.

---

## 2. Design Principles (invariants every section upholds)

These are non-negotiable. Any code or schema that contradicts one of these is a bug, not a tradeoff.

1. **Disk is memory; context is scratch.** Operational state lives in `DIRECTIVES.md` (contract), `JOURNAL.md` (live tracker), `PLAN.md`, stage files, and `SERVICES.md`. The context window is just what the model needs for the current turn.
2. **Contract and tracker are separate files.** `DIRECTIVES.md` is what the agent *must do* — written once by the parent at spawn, truly immutable for the agent's lifetime, file-system-enforced read-only. `JOURNAL.md` is what the agent *is doing right now* — the only file the agent writes. This separation is what makes the cache story trivial (§ 13).
3. **Every turn re-injects live state.** `before_prompt_build` reads `JOURNAL.md` and injects a tiny status summary as `prependSystemContext`. The DIRECTIVES content lives in the cached system prompt and is not re-injected — the agent already has it.
4. **Compression is invisible to the agent.** The agent never sees `AGENT:COMPRESSION_EVENT`. Compression is an infrastructure event; the agent's worldview is identical before and after.
5. **Every DoD criterion is machine-verifiable.** "POST /auth/login returns JWT" is not a criterion; `curl http://localhost:3000/auth/login -d '...' | jq -e '.token | test("^ey")'` is. If you can't write the check as code, the criterion is not a criterion.
6. **Micro-tasks only.** A step whose verification cannot be encoded as a single command or single-file check is too large and must be split. See § 4.
7. **Black-box everything sealed.** Once a step is DONE DONE, its implementation is invisible to the rest of the system. Downstream work reads only the sealed output contract, never the implementation.
8. **Service Registry before every new file.** No agent writes a module without first grepping `SERVICES.md` for something that already fulfills the contract. DRY is a verification failure.
9. **No early stopping; no skipping.** A step that fails any DoD criterion stays `IN_PROGRESS`. "Hard" is not a reason to advance. The only terminal states are `SEALED` (verified done) or `ABANDONED` (explicit human decision, logged).
10. **Sub-agent scope reduction is absolute.** A sub-agent sees its own `DIRECTIVES.md`, its own `JOURNAL.md`, `SERVICES.md`, and the files in its `INPUT CONTRACT`. Nothing else. Not the parent's plan, not sibling agents, not the project root. Parents mediate.
11. **Writes are atomic.** `JOURNAL.md` writes use tmp-file + `fsync` + `rename` + directory `fsync`. `DIRECTIVES.md` is written once at spawn with the same atomicity, then chmod'd read-only.
12. **Prompt cache boundary = file boundary.** The cached portion contains the immutable DIRECTIVES (via `extraSystemPrompt`); the uncached portion contains the JOURNAL-derived status. Cache hits are structural, not coincidental. See § 13.
13. **Infinite-run by default, bounded by budget and by DoD.** The agent does not stop because the conversation is long. It stops only when all DoD is verified PASS, or when an explicit turn/cost/wall-clock budget triggers a `BUDGET_EXCEEDED` event that escalates to the parent.
14. **Constrain mechanical parts; delegate creative parts to the model.** The system hard-codes WHAT "done" means (typed verifiers, post-turn revert, independent re-verification, progressive retry), HOW state flows (DIRECTIVES/JOURNAL split, seal-and-archive, SERVICES.md), and WHICH claims are trustworthy (in-process verifier-pass map). The system does NOT hard-code how to decompose a task, how to phrase a sub-task, how to reason about a domain, or how to write a rubric — those are the model's job. When a new task type seems to need a new mechanism, first ask: can this be an `llm_judge` rubric (creative, delegated) instead of a new verifier type (mechanical, enforced)? Adding mechanism is a last resort; delegating to the model under a bounded rubric is the default path to generality. This is how the design handles HCAST's general-reasoning tier, research-writeup tasks, and anything with fuzzy success criteria — without ever letting the model self-assess completion.

---

## 3. The Five Artifacts

```
┌─────────────────────────────────────────────────────────────┐
│  ARTIFACT 1: PROJECT PLAN                                   │
│  PLAN.md + project-plan/stage-NN-name.md                    │
│  Written once; revised only via explicit REPLAN protocol.   │
│  ACTIVE stages are frozen, SEALED stages are immutable,     │
│  PENDING stages are editable until activation.              │
├─────────────────────────────────────────────────────────────┤
│  ARTIFACT 2a: DIRECTIVES.md  (one per agent — IMMUTABLE)    │
│  Written once by the parent at spawn. chmod 0444 +          │
│  SHA tamper check. Contains: goal, I/O contracts, DoD,      │
│  constraints, turn budget, initial decomposition, PROTOCOL. │
│  Becomes part of the cached system prompt via               │
│  extraSystemPrompt. Never re-injected per turn — it's       │
│  already in the cache. Agent cannot modify it.              │
├─────────────────────────────────────────────────────────────┤
│  ARTIFACT 2b: JOURNAL.md  (one per agent — MUTABLE)         │
│  The only file the agent writes. Contains: task stack,      │
│  current step, progress, blocker, working notes, sub-agent  │
│  registry. Re-read every turn; a ~150-token summary is      │
│  injected as prependSystemContext (outside cache boundary). │
│  Atomic writes (tmp + fsync + rename).                      │
├─────────────────────────────────────────────────────────────┤
│  ARTIFACT 3: SERVICE REGISTRY (SERVICES.md + services/*.md) │
│  Append-only catalog of every sealed output contract in the │
│  project. Each entry: name, I/O schema, location, usage     │
│  example, owner stage. MUST be consulted before any agent   │
│  creates a new module. Prevents DRY across sub-agents.      │
├─────────────────────────────────────────────────────────────┤
│  ARTIFACT 4: OBSERVER LOG (.agent-events.jsonl)             │
│  Append-only JSONL. Every compression, step complete, stage │
│  seal, stuck warning, budget event, tamper attempt. Agent   │
│  never reads this. Logan + monitoring scripts consume it.   │
└─────────────────────────────────────────────────────────────┘
```

The DIRECTIVES/JOURNAL split is load-bearing. Without it, either the contract mutates (breaking the cache) or the progress is trapped in the context window (breaking the amnesia fix). With it, each file has one job and the cache boundary lines up exactly with the file boundary.

### 3.1 The Recursion Principle
Every agent — main, sub, sub-sub — runs the same system. It has exactly one `DIRECTIVES.md` scoped to its task. It knows only what its Input Contract allows and publishes only what its Output Contract specifies. Parallelism is safe because scopes do not overlap; compression is survivable because the scope is re-injected every turn.

### 3.2 The Service Registry Principle (new, critical)
Before *any* agent writes a new module, class, function, script, or file, it must:
1. `read SERVICES.md`
2. `grep` for its intent (e.g., "JWT", "login", "redis session")
3. If a matching service exists → **consume it as a black box** (read its I/O contract, call it; do not re-read its implementation)
4. If no match → proceed with implementation *and* append a new entry to `SERVICES.md` on seal

This is the mechanism that turns parallel sub-agents from DRY hazards into compounding leverage.

### 3.3 DONE DONE vs Kinda Done
A step is **DONE DONE** when every DoD criterion for that step is **verified PASS** by the verifier runner (§ 7). Not believed. Not probably. Verified. Only then does the agent mark it done in `JOURNAL.md`, seal the output, and black-box the implementation. Kinda-done keeps the step `IN_PROGRESS`; the agent writes why to `WORKING NOTES` and keeps working or escalates `BLOCKED`. There is no third state.

---

## 4. Micro-Task Granularity (the decomposition bar)

This is the section that makes the anti-"skipping because it's hard" rule enforceable. A step is too large if *any* of the following holds:

### 4.1 The decomposition tests
Split the step if:

- **Verification test**: The DoD cannot be expressed as a single shell command, single HTTP probe, single file-existence check, single grep, or single test invocation. If you need a paragraph to describe how to check it, split it.
- **Turn budget test**: The step is expected to take more than **15 turns** of agent work. Hard ceiling: 30 turns. Beyond 30, the parent must decompose further before spawning.
- **Output cardinality test**: The step produces more than **one primary artifact** (one file, one endpoint, one migration, one schema). If it produces more than one, split.
- **Contract multiplicity test**: The step depends on more than **two inputs from other stages**. Collapse or split so each micro-step has ≤2 external inputs.
- **Reasoning-volume test**: The step requires holding more than ~5K tokens of external context in mind simultaneously (schemas + examples + source files). Split so each micro-step has <5K tokens of mandatory context.

### 4.2 Canonical micro-step shape

```yaml
id: step-3.4.2                         # stage.substage.step (hierarchical)
name: Implement POST /auth/login handler
input_contract:
  - path: db/schema.sql                # machine-readable path
    required_section: "users"
  - service: services/session-store.md # from Service Registry
output_contract:
  - path: src/routes/auth-login.ts
    exports: ["loginHandler"]
    signature: "(req, res) => Promise<Response>"
dod:
  - type: file_exists
    path: src/routes/auth-login.ts
  - type: shell_exit_zero
    cmd: "npx tsc --noEmit -p tsconfig.json"
  - type: test_passes
    cmd: "npx vitest run tests/auth-login.test.ts"
  - type: grep_absent                  # no smuggled TODOs or hardcoded creds
    pattern: "TODO|FIXME|password\\s*="
    path: src/routes/auth-login.ts
turn_budget: 12
```

Every step — in DIRECTIVES' INITIAL DECOMPOSITION and in JOURNAL's TASK STACK — follows this shape. No exceptions.

### 4.3 Anti-skipping rules
- A DoD criterion that FAILS keeps the step `IN_PROGRESS`. It cannot be removed, weakened, or marked "good enough."
- If the agent believes a DoD criterion is wrong (e.g., over-specified, unreachable), it reports `BLOCKED: contract-dispute` in JOURNAL.md with the specific criterion and stays put. Only the parent can amend DIRECTIVES, and doing so requires a respawn.
- "This is hard" is never a valid reason to advance. It is a valid reason to decompose further or escalate `BLOCKED`.
- After 3 failed verification runs on the same criterion with no progress delta, the agent emits `AGENT:STUCK_WARNING` and pauses for parent input rather than thrashing.

---

## 5. File Schemas

All schemas are authoritative. Parse with a typed reader, not regex. Atomic writes only (tmp + fsync + rename).

### 5.1 PLAN.md (project root)

Written by the user or main agent at project start. Updated only via the `REPLAN` protocol (§ 12).

```markdown
# PLAN — [Project Name]
schema_version: 1
created: 2026-04-16T03:14:22Z
last_replanned: 2026-04-16T03:14:22Z
status: ACTIVE | COMPLETE | ABANDONED
owner: main
turn_budget_total: 2000              # sum across all agents/stages
cost_budget_usd: 50.00               # soft cap; emits BUDGET_WARNING at 80%

## Goal
[One paragraph. What does the completed project look like from the outside?]

## High-Level Definition of Done
# Each line is a verifier criterion. Machine-checkable at project level.
- [ ] type: shell_exit_zero | cmd: "npm run test:e2e"
- [ ] type: http_status     | url: "http://localhost:3000/health" | status: 200
- [ ] type: file_exists     | path: "dist/server.js"

## Stages
# Ordered. Dependencies explicit. Status ∈ {PENDING, ACTIVE, SEALED, ABANDONED}.
1. stage-01-scaffold     | SEALED    | seal: 2026-04-16T03:30:00Z | out: src/ skeleton
2. stage-02-database     | SEALED    | seal: 2026-04-16T04:10:00Z | out: db/schema.sql
3. stage-03-auth         | ACTIVE    | depends: [stage-02]
4. stage-04-api          | PENDING   | depends: [stage-03]
5. stage-05-tests        | PENDING   | depends: [stage-04]
6. stage-06-deploy       | PENDING   | depends: [stage-05]

## Sealed Outputs Registry (append-only; mirror of SERVICES.md summary)
- stage-01: src/ scaffold — see services/src-scaffold.md
- stage-02: db/schema.sql — see services/db-schema.md

## Global Constraints
- No hardcoded secrets anywhere in the tree.
- All new modules must export a typed interface.
- Every sealed output publishes to SERVICES.md.

## Notes
[Tech constraints, conventions, anything project-wide.]
```

### 5.2 Stage Files (`project-plan/stage-NN-name.md`)

One file per stage. Written before the stage becomes ACTIVE. Immutable once ACTIVE. Sealed when DONE DONE.

```markdown
# Stage NN — [Name]
schema_version: 1
status: PENDING | ACTIVE | SEALED | ABANDONED
created: 2026-04-16T03:14:22Z
activated: 2026-04-16T03:45:00Z
sealed:   null
turn_budget: 200            # total across sub-agents for this stage

## Depends On
# Each entry is a Service Registry pointer.
- service: services/db-schema.md
  required_sections: ["users", "sessions"]

## Output Contract
# Every artifact this stage produces. Downstream stages read only these.
- kind: file
  path: src/routes/auth.ts
  exports: ["authRouter"]
  interface: "express.Router mounting POST /auth/login, POST /auth/logout"
- kind: file
  path: tests/auth.test.ts
  exports: []
  interface: "vitest test suite"
- kind: service
  path: services/auth.md                # published to registry on seal

## Definition of Done
- type: test_passes
  cmd: "npx vitest run tests/auth.test.ts"
- type: http_status
  url: "http://localhost:3000/auth/login"
  method: POST
  body_json: { "email": "u@x.com", "password": "..." }
  status: 200
  expect_json: { "token": { "$regex": "^ey" } }
- type: http_status
  url: "http://localhost:3000/auth/login"
  body_json: { "email": "u@x.com", "password": "wrong" }
  status: 401
- type: grep_absent
  path: "src/routes/auth.ts"
  pattern: "TODO|FIXME|hardcoded|password\\s*=\\s*[\"']"

## Sub-Tasks (decomposition plan)
# Each sub-task becomes one child agent's scoped DIRECTIVES.md.
A:
  id: stage-03.A
  goal: Implement /auth/login and /auth/logout route handlers
  input_contract:
    - service: services/db-schema.md#users
    - service: services/redis-session.md
  output_contract:
    - path: src/routes/auth.ts
  can_start: immediately
  turn_budget: 80

B:
  id: stage-03.B
  goal: Integration test suite for auth endpoints
  input_contract:
    - path: src/routes/auth.ts              # A's output contract; NOT implementation
    - service: services/test-harness.md
  output_contract:
    - path: tests/auth.test.ts
  can_start: after A.seal
  turn_budget: 60

## Context for Sub-Agents
# Parent distills this into each sub-agent's scoped DIRECTIVES.md.
# Nothing here leaks directly to children; children read only what their
# input contract points to.
- Convention: routes export Router, mounted in src/app.ts
- Token expiry: 24h access, 7d refresh (see constants/auth-config.ts if present)

## Execution Log (append-only during execution)
- 2026-04-16T03:45:00Z  ACTIVATED
- 2026-04-16T03:45:12Z  SPAWN sub:auth-a:d7e9 (stage-03.A)
- 2026-04-16T03:58:04Z  SEAL sub:auth-a:d7e9 → src/routes/auth.ts (sha: abc123)
- 2026-04-16T03:58:06Z  SPAWN sub:auth-b:f1a2 (stage-03.B)
- 2026-04-16T04:09:47Z  SEAL sub:auth-b:f1a2 → tests/auth.test.ts (sha: def456)
- 2026-04-16T04:10:00Z  STAGE SEALED

## SEALED SUMMARY (written at sealing, immutable after)
produced:
  - src/routes/auth.ts   sha: abc123
  - tests/auth.test.ts   sha: def456
registry_entry: services/auth.md
dod_status: all_pass
notes: |
  Auth uses jsonwebtoken. Session store is Redis via services/redis-session.md.
  No changes to db/schema.sql required.
```

### 5.3 DIRECTIVES.md (one per agent — IMMUTABLE)

Written **once** by the parent at spawn, then `chmod 0444` and SHA-recorded. The agent cannot modify it. Its content is copied into the agent's system prompt as `extraSystemPrompt` at spawn — which means it lives *inside* the Anthropic cache boundary and is not re-injected per turn. The agent sees it once as part of the initial system prompt; from then on it's cached for 1h and refreshed only on TTL expiry.

```markdown
# DIRECTIVES (immutable for this agent's lifetime)
schema_version: 1
agent: sub:auth-a:d7e9              # or "main"
parent: main                         # null for main
workspace: /workspace/sub-auth-a-d7e9
spawned: 2026-04-16T03:45:12Z
journal: ./JOURNAL.md                # where you record your progress

## GOAL
Implement POST /auth/login and POST /auth/logout in src/routes/auth.ts per the
auth stage output contract.

## INPUT CONTRACT
# Exact. Path-level. No "check the repo."
- service: services/db-schema.md
  sections: [users]
- service: services/redis-session.md
- path: constants/auth-config.ts  (token TTLs; may be absent, in which case
                                   constants default to 24h/7d)

## OUTPUT CONTRACT
- kind: file
  path: src/routes/auth.ts
  exports: ["authRouter"]
  interface: "express.Router mounting POST /auth/login, POST /auth/logout"

## DEFINITION OF DONE
- type: file_exists
  path: src/routes/auth.ts
- type: shell_exit_zero
  cmd: "npx tsc --noEmit -p tsconfig.json"
- type: grep_present
  path: src/routes/auth.ts
  pattern: "export\\s+const\\s+authRouter"
- type: grep_absent
  path: src/routes/auth.ts
  pattern: "TODO|FIXME|console\\.log|password\\s*=\\s*[\"']"

## CONSTRAINTS
- No hardcoded secrets.
- No new dependencies without parent approval (report BLOCKED).
- Must consume services/db-schema and services/redis-session as black boxes;
  no direct Redis client instantiation.

## TURN BUDGET
max_turns: 80
warning_at:  60
escalate_at: 75

## INITIAL DECOMPOSITION (parent's proposed step plan)
# You may refine wording or subdivide within JOURNAL.md's task stack, but
# you may not drop a step without reporting BLOCKED and getting parent
# approval. Adding sub-steps under an existing step is allowed.
- step-1: Read INPUT CONTRACT sources; confirm presence of services
- step-2: Implement loginHandler (happy path)
- step-3: Implement loginHandler (error paths: 401, 429)
- step-4: Implement logoutHandler
- step-5: Self-run full DoD verifier; report TASK_COMPLETE

## PROTOCOL (how you operate — read once, then live by it)
You are an OpenClaw agent under the Persistent Directive System.

1. You maintain exactly ONE mutable file: ./JOURNAL.md. It is the only file
   you write that represents your own state.
2. Each turn begins with a system-prompt injection from JOURNAL.md showing
   your current step, progress, and blockers. Use it. Trust it. It is
   re-read from disk every turn — it survives compression.
3. To advance any step: call the verifier runner on that step's DoD. Only
   if all criteria PASS may you mark the step DONE in JOURNAL.md. The
   write path enforces this — a DONE write with a failing verifier is
   rejected.
4. "Kinda done" is not a state. If a criterion FAILs, keep the step
   IN_PROGRESS and write the specific failure to WORKING NOTES.
5. Before creating any new file: read ../../SERVICES.md and grep it for a
   service that already covers your need. If one exists, consume it as a
   black box — do NOT read its implementation. If none exists, proceed,
   and the sealed output will be published to the registry by your parent.
6. You MAY NOT modify this file (DIRECTIVES.md). It is chmod 0444. Attempts
   are logged to .agent-events.jsonl as AGENT:DIRECTIVES_TAMPER_ATTEMPT and
   escalated to the parent.
7. If blocked for real (the spec is wrong, an input is missing, a
   dependency is broken), write blocker: in JOURNAL.md and emit BLOCKED.
   Do NOT thrash. Do NOT auto-advance. Wait for parent guidance.
8. When every step is DONE DONE and the full OUTPUT CONTRACT DoD passes,
   reply with a strict TASK_COMPLETE message (format in § 9.2 of BUILD.md)
   and stop. The parent will re-verify your claims independently.
9. Compression is an infrastructure event. You will not observe it. On the
   other side of any compression, JOURNAL.md is still the truth.
```

**There is no mutable zone in DIRECTIVES.md by design.** All mutation lives in JOURNAL.md (§ 5.3b). Compression telemetry lives in `.agent-events.jsonl` (§ 11). The agent has exactly one file it owns.

### 5.3b JOURNAL.md (one per agent — MUTABLE, agent-owned)

Written and rewritten by the agent as work progresses. Atomic writes. This is the *only* mutable per-agent file. Re-read every turn by `before_prompt_build`; a small summary is injected.

```markdown
# JOURNAL
schema_version: 1
agent: sub:auth-a:d7e9
last_updated: 2026-04-16T03:58:04Z
turns_used: 12
last_verifier_run: 2026-04-16T03:57:58Z

## TASK STACK
# Each step must obey § 4 granularity. Status ∈ {PENDING, IN_PROGRESS, DONE, BLOCKED}.
# Steps originate from DIRECTIVES.md INITIAL DECOMPOSITION; you may subdivide
# further but not drop. Every DONE carries verifier evidence.

#### step-1: Read INPUT CONTRACT sources; confirm presence of services
status: DONE
completed: 2026-04-16T03:46:30Z
verifier_run_id: vr-0001
verified_outputs:
  - services/db-schema.md  read, users section confirmed
  - services/redis-session.md  read, interface noted
black_box: YES

#### step-2: Implement loginHandler (happy path)
status: DONE
completed: 2026-04-16T03:52:11Z
verifier_run_id: vr-0004
verified_outputs:
  - src/routes/auth.ts exports authRouter (sha: 8f3e...)
  - tsc passes; grep_absent TODO passes
black_box: YES

#### step-3: Implement loginHandler (error paths: 401, 429)
status: IN_PROGRESS
started: 2026-04-16T03:52:11Z
progress: "Wired Redis rate-limit; 401 path done; adding 429 path."
blocker: null
turns_in_step: 4
last_verifier_failures: []

#### step-4: Implement logoutHandler
status: PENDING
depends_on: [step-3]
expected_output: "src/routes/auth.ts:logoutHandler invalidates session in Redis"

## WORKING NOTES
# Scratch only. Safe to clear on each step DONE.
- Redis session key pattern from services/redis-session.md: "sess:{jti}".
- Rate-limit key: "rl:login:{email}" with 5 req / 5 min window.
- After logout, SESSION:{jti} must be removed AND added to a blacklist set.

## SUB-AGENTS
# Populated only if THIS agent spawned children (recursion).
# (empty for this leaf agent)

## COMPLETION REPORT
# Written once, at TASK_COMPLETE. Empty until then.
```

**Injection derived from JOURNAL.md** (what actually goes into `prependSystemContext` each turn — see § 6.6 for the exact bytes):

```
## LIVE STATE  [from JOURNAL.md, re-read every turn]
CURRENT STEP: step-3 — Implement loginHandler (error paths: 401, 429)
PROGRESS:     Wired Redis rate-limit; 401 path done; adding 429 path.
BLOCKER:      none
TURNS USED:   12/80   (warn 60, escalate 75)
NEXT STEP:    step-4 — Implement logoutHandler
```

That's ~100-150 tokens. Cheap. Fresh every turn. Never busts the cache because it sits *after* the boundary.

### 5.4 SERVICES.md + `services/*.md` (Service Registry)

`SERVICES.md` is the index. One line per sealed service. `services/<name>.md` is the detail card.

```markdown
# SERVICES — Registry
schema_version: 1
# One line per sealed output. Append-only. Sorted by stage order, not time.

- db-schema        | stage-02 | services/db-schema.md      | Postgres schema (users, sessions, tokens)
- redis-session    | stage-02 | services/redis-session.md  | Session store client (get/set/invalidate)
- auth             | stage-03 | services/auth.md           | POST /auth/login, /auth/logout
- test-harness     | stage-01 | services/test-harness.md   | vitest config + fixtures
```

Each `services/<name>.md`:

```markdown
# Service: auth
schema_version: 1
stage: stage-03-auth
sealed: 2026-04-16T04:10:00Z
owner_agent: main                # who sealed it

## Purpose
Authenticate users via email/password → signed JWT. Invalidate sessions on logout.

## Interface
- POST /auth/login
    body:      { email: string, password: string }
    200 body:  { token: string }   # JWT, 24h expiry
    401 body:  { error: "invalid_credentials" }
    429 body:  { error: "rate_limited" }
- POST /auth/logout
    header:    Authorization: Bearer <token>
    200 body:  { ok: true }

## How to use
```ts
import { authRouter } from "./src/routes/auth.ts";
app.use("/auth", authRouter);
```

## Depends on (black-box)
- services/db-schema.md#users
- services/redis-session.md

## Verifier snippets (for downstream consumers)
- Smoke test: `curl -s -X POST localhost:3000/auth/login -d '{...}' | jq -e '.token'`

## Do NOT
- Instantiate a Redis client directly; use services/redis-session.md.
- Read `src/routes/auth.ts` to understand behavior — that file is sealed black-box.
  All contract information is in this file.
```

**Critical rule:** every agent reads `SERVICES.md` as step zero of every task. Grep for intent. If a service covers your need, consume it; do not reimplement.

### 5.5 `.agent-events.jsonl`

See § 9 for schema.

---

## 6. Hook Infrastructure (OpenClaw 2026 actual surface)

The signatures below are drawn from `src/agents/pi-embedded-runner/run/attempt.prompt-helpers.ts` and `src/agents/pi-embedded-runner/compaction-hooks.ts`. Do not guess — these are the real types.

### 6.0 Activation model (how the plugin becomes live)

This plugin is not a skill. Skills are model-invocable capabilities the model chooses to use; this system is the runtime substrate the model operates *inside*. It activates in three tiers:

**Tier 1 — Plugin always loaded, zero-footprint default.**
`extensions/directive-persistence/` ships with OpenClaw and is always loaded at startup. Hooks register, tools register. When no `DIRECTIVES.md` / `JOURNAL.md` exists in the session's `workspaceDir`, every hook is a no-op via early return (`if (!fileExists(journalPath)) return {};`) and the tools are never called. Installed-but-inactive is the zero-cost default for any user who doesn't want the directive system. No opt-out needed, no configuration needed, no skill to disable.

**Tier 2 — Per-session activation by presence of files.**
The moment `DIRECTIVES.md` exists in a session's `workspaceDir`:
- `before_prompt_build` starts injecting LIVE STATE from JOURNAL.
- `before_compaction` / `after_compaction` start emitting events to `.agent-events.jsonl`.
- `verifier.run`, `journal.write_done`, `journal.mark_blocked`, `journal.set_progress`, `report_task_complete`, `report_task_blocked` tools become callable.
- The `after_turn` DONE-revert validator (§ 10.3b) activates.

This is the sub-agent activation path: parent writes DIRECTIVES + JOURNAL into the child's workspace, calls `sessions_spawn` with `extraSystemPrompt = <DIRECTIVES content>`, and the child boots with the directive system fully live. No additional flag.

**Tier 3 — Explicit opt-in for the top-level (main) session.**
Main agents have no parent to spawn them, so `extraSystemPrompt` has to come from somewhere else. Three equivalent triggers, pick the one that fits the caller:

- **CLI flag:** `openclaw run --directives-mode` → plugin reads `./DIRECTIVES.md` on startup, injects as `extraSystemPrompt` at session-start, sets `workspaceDir` to cwd. Best for benchmark adapters (one flag per run).
- **Config field:** `openclaw.json` → `"agents.defaults.directive_mode": true` → same behavior but persistent for this project. Best for long-lived projects.
- **Bootstrap command:** `openclaw directives init [--preset software|research|ml|general]` → writes a skeleton `DIRECTIVES.md` and `PLAN.md` using the chosen preset (§ 6.0a) and drops into a session with directive-mode active. Best for first-time users.

**One wire-up in OpenClaw core:** the CLI / session-start path must accept a path-to-file (or string) for `extraSystemPrompt` the way `sessions_spawn` already does for sub-agents. If OpenClaw 2026 doesn't already expose this, it's a small upstream patch (~50 lines): read the file, pass its content into the existing session-startup `extraSystemPrompt` parameter. Everything downstream is already provided.

**What non-directive sessions see:** nothing. The plugin is loaded but its hooks return `{}` and its tools are not invoked. Zero tokens, zero behavior change, zero cognitive load on users who don't want the system. The directive system is purely additive.

### 6.0a Default DIRECTIVES template and presets

**One main-agent template, not two.** The orchestration contract (orch-loop A-K, PROTOCOL, atomicity rules, SERVICES pre-flight, seal-and-archive) is identical regardless of domain. Software vs research vs ML doesn't change HOW the main agent orchestrates; it changes WHAT the sub-agents verify against. So we ship:

1. **One main-agent DIRECTIVES template** (`templates/main-directives.md`). The orch-loop and PROTOCOL are fixed; GOAL, INPUT/OUTPUT CONTRACT, CONSTRAINTS, TURN BUDGET get filled in from PLAN.md or the `directives init` wizard.

2. **N sub-agent DIRECTIVES presets**, each bound to a verifier library from § 15 Phase 5. The main agent selects the preset when writing each child's DIRECTIVES, either from an explicit hint in the stage file's sub-task entry or by task-shape inference. Each preset is: a default verifier set + a small default-constraints overlay + suggested turn-budget heuristics.

| Preset | Default verifiers | Default constraints | Suggested budget |
|--------|-------------------|---------------------|------------------|
| `software-implementation` | `file_exists`, `shell_exit_zero` (typecheck), `test_passes`, `grep_absent` (TODO/secrets) | No hardcoded secrets; no TODO/FIXME in sealed files; tests exist for new exports | 40-120 turns |
| `refactor` | `test_passes` (existing suite), `shell_exit_zero` (typecheck), `grep_absent` (behavior-change markers) | No behavior change; no new deps; existing tests pass unchanged | 30-80 turns |
| `debugging` | `shell_exit_zero` (repro is gone), `test_passes` (new regression test), `test_passes` (existing suite) | Root cause identified in JOURNAL; regression test added; no broader scope changes | 30-100 turns |
| `data-pipeline` / `ml` | `file_exists` (submission), `shell_exit_zero` (submission script), `json_schema_match` (submission format), `llm_judge` (approach quality) | No data leakage across train/test; submission matches schema; results reproducible from `seed` | 60-200 turns |
| `research-writeup` | `llm_judge` (structured-report rubric: intro/method/evidence/conclusion/citations), `grep_present` (citations) | Cite sources; include method section; no unsubstantiated claims | 30-80 turns |
| `general-task` | `llm_judge` (task-specific rubric authored at decomposition time), plus any applicable typed verifiers | Rubric-gated; task-specific; `min_score` set per task difficulty | 30-100 turns |

**Philosophy (principle #14 at work):** presets are *verifier-flavor* overlays, not *behavior* overlays. The agent's operating rules (the PROTOCOL) do not change between presets. What changes is how "done" is checked — which is exactly what principle #14 says should be mechanism-configurable while the rest stays constant.

**Preset selection flow** at sub-agent spawn:
1. Stage sub-task entry may include `preset: <name>` (explicit hint from human or upstream decomposition).
2. If absent, main agent infers from Output Contract shape:
   - Output is a file under `src/` or `tests/` → `software-implementation` or `refactor` (refactor if the file already exists)
   - Output is a `.md` analysis/report → `research-writeup`
   - Output is a CSV/JSON submission + script → `data-pipeline`
   - Output is a diff plus a test → `debugging`
   - Anything else → `general-task` with a rubric the main agent must author
3. The main agent's template fill step (§ 8.4 Step 5) pulls the preset's default verifiers into the child's DoD field and the preset's default constraints into CONSTRAINTS.
4. The main agent may *add* to the DoD (task-specific criteria), but may not *remove* preset defaults except via an explicit override recorded in the stage file's Execution Log.

**Where presets live:**
```
extensions/directive-persistence/
  templates/
    main-directives.md            # the one main-agent template
    presets/
      software-implementation.yaml
      refactor.yaml
      debugging.yaml
      data-pipeline.yaml
      research-writeup.yaml
      general-task.yaml
```

Each preset YAML is ~20-40 lines: verifier list, constraint list, budget heuristics, rubric pointer (for llm_judge presets), and a short "when to use" description the main agent reads during preset selection.

### 6.1 `before_prompt_build`

```typescript
// types from src/plugins/types.ts (OpenClaw 2026)
type PluginHookBeforePromptBuildResult = {
  systemPrompt?: string;          // full replacement (rare; breaks cache)
  prependContext?: string;        // prepended to user message, pre-cache
  prependSystemContext?: string;  // prepended to system prompt AFTER cache boundary
  appendSystemContext?: string;   // appended to system prompt AFTER cache boundary
};

type PluginHookAgentContext = {
  sessionId: string;
  agentId: string;
  sessionKey: string;
  workspaceDir: string;
  messageProvider?: string;
};
```

**Fires:** every turn, pre-prompt-assembly. Errors are swallowed via `log.warn` (see `attempt.prompt-helpers.ts:51-54`), so a broken plugin does not brick the session.

**Our hook uses `prependSystemContext`** — this sits after the cache boundary (via `prependSystemPromptAdditionAfterCacheBoundary`), which is exactly what we want: stable system prompt gets cached for 1h; the directive injection updates every turn at normal input cost.

### 6.2 `before_compaction` (new — we use this too)

```typescript
runBeforeCompaction?: (
  metrics: { messageCount: number; tokenCount?: number; sessionFile?: string },
  ctx: PluginHookAgentContext,
) => Promise<void> | void;
```

**Fires:** immediately before compaction, **before `ContextEngine.maintain()` runs**. We use this as a **snapshot checkpoint** — we read the agent's JOURNAL.md (which is unchanged by compaction because it lives on disk, not in the transcript) and emit `AGENT:PRE_COMPRESSION_SNAPSHOT` with step/DoD state. This is belt-and-suspenders: it lets external observers correlate "what was the agent doing right before LCM restructured the history."

### 6.3 `after_compaction`

```typescript
runAfterCompaction?: (
  metrics: {
    messageCount: number;
    tokenCount?: number;
    compactedCount: number;
    sessionFile: string;
  },
  ctx: PluginHookAgentContext,
) => Promise<void> | void;
```

**Fires:** after every compaction (overflow-triggered and manual). We emit `AGENT:COMPRESSION_EVENT` to `.agent-events.jsonl` — and nothing else. `DIRECTIVES.md` is not touched; compression is invisible to the agent.

### 6.4 Plugin package layout

```
extensions/directive-persistence/
  package.json
  src/
    index.ts                # plugin entry; registers hooks
    directives/
      schema.ts             # zod schemas: DIRECTIVES (immutable), JOURNAL (mutable), PLAN, stage, SERVICES
      parse.ts              # typed parser for DIRECTIVES.md
      journal.ts            # typed parser + atomic writer for JOURNAL.md (DONE gate included)
      tamper.ts             # SHA check vs .directives-lock.json
      inject.ts             # buildLiveStateInjection(journal) → prependSystemContext
      snapshot.ts           # pre-compression JOURNAL snapshot (≤400B)
    spawn/
      write-directives.ts   # atomic write → chmod 0444 → record lock; builds extraSystemPrompt
      parse-task-complete.ts
    services/
      registry.ts           # read SERVICES.md, grep, register new entry (parent-side only)
    plan/
      plan.ts               # read/write PLAN.md
      stage.ts              # read/write stage files
      seal.ts               # sealing orchestration
    verify/
      runner.ts             # executes each DoD criterion
      types/
        file-exists.ts
        shell-exit-zero.ts
        http-status.ts
        grep-present.ts
        grep-absent.ts
        test-passes.ts
        json-schema-match.ts
    events/
      log.ts                # append to .agent-events.jsonl (fsync on each append)
      stuck-detector.ts     # compression/idle/budget heuristics
    spawn/
      write-child-directives.ts
      parse-task-complete.ts
    __tests__/              # vitest
```

### 6.5 Two injection paths (spawn-time and per-turn)

Because DIRECTIVES.md is immutable and belongs in the cache, and JOURNAL.md is mutable and belongs after the cache boundary, we use two distinct injection paths:

**Path A — spawn-time, cached (DIRECTIVES → extraSystemPrompt):**
The parent, when calling `sessions_spawn`, sets `extraSystemPrompt` to the verbatim content of the child's DIRECTIVES.md. OpenClaw places `extraSystemPrompt` inside the system prompt block, which carries `cache_control: { type: "ephemeral", ttl: "1h" }`. Result: the DIRECTIVES content becomes part of the cached prefix. Cache hit on every turn for 1h; refreshed automatically on TTL lapse; effectively 0.1× input-token cost per subsequent turn.

**Path B — per-turn, not cached (JOURNAL → prependSystemContext):**
The `before_prompt_build` hook reads JOURNAL.md every turn and returns a small `prependSystemContext` with the live state. This sits *after* the cache boundary (per `prependSystemPromptAdditionAfterCacheBoundary`). Small (~150 tokens). Recomputed every turn. Normal input-token cost, which is negligible at this size.

```typescript
// extensions/directive-persistence/src/index.ts
import { sdk } from "@openclaw/plugin-sdk";
import { readJournal } from "./directives/journal.ts";
import { buildLiveStateInjection } from "./directives/inject.ts";
import { verifyDirectivesIntegrity } from "./directives/tamper.ts";
import { appendEvent } from "./events/log.ts";
import { snapshotJournal } from "./directives/snapshot.ts";

sdk.registerHook("before_prompt_build", async (_event, ctx) => {
  const journalPath    = path.join(ctx.workspaceDir, "JOURNAL.md");
  const directivesPath = path.join(ctx.workspaceDir, "DIRECTIVES.md");

  // Non-directive sessions: no-op. We do NOT inject anything from
  // DIRECTIVES.md here — it lives in the cached system prompt (extraSystemPrompt)
  // and is already visible to the model.
  if (!(await fileExists(journalPath))) return {};

  // Cheap tamper check: compare SHA of DIRECTIVES.md to the SHA recorded
  // at spawn time in .directives-lock.json. If mismatch, log and STILL inject
  // live state (don't brick the session) — parent will intervene.
  const tampered = await verifyDirectivesIntegrity(ctx.workspaceDir).catch(() => false);
  if (tampered) {
    await appendEvent(ctx.workspaceDir, {
      event: "AGENT:DIRECTIVES_TAMPER_ATTEMPT",
      ts: new Date().toISOString(),
      agent: ctx.agentId,
      session: ctx.sessionKey,
      directives_path: directivesPath,
    });
  }

  const journal = await readJournal(journalPath); // throws on malformed → log.warn swallows
  return { prependSystemContext: buildLiveStateInjection(journal) };
});

sdk.registerHook("before_compaction", async (metrics, ctx) => {
  // Pre-compression snapshot of JOURNAL — the belt-and-suspenders.
  const journalPath = path.join(ctx.workspaceDir, "JOURNAL.md");
  const snap = await snapshotJournal(journalPath).catch(() => null);
  await appendEvent(ctx.workspaceDir, {
    event: "AGENT:PRE_COMPRESSION_SNAPSHOT",
    ts: new Date().toISOString(),
    agent: ctx.agentId,
    session: ctx.sessionKey,
    snapshot: snap,                 // capped at 400 bytes; oversized → pointer only
    msgs_before: metrics.messageCount,
    tokens_before: metrics.tokenCount,
  });
});

sdk.registerHook("after_compaction", async (metrics, ctx) => {
  const journalPath = path.join(ctx.workspaceDir, "JOURNAL.md");
  const step = await getCurrentStepName(journalPath).catch(() => "unknown");
  await appendEvent(ctx.workspaceDir, {
    event: "AGENT:COMPRESSION_EVENT",
    event_id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    agent: ctx.agentId,
    session: ctx.sessionKey,
    msgs_before: metrics.messageCount + metrics.compactedCount,
    msgs_after: metrics.messageCount,
    compacted_count: metrics.compactedCount,
    tokens_after: metrics.tokenCount,
    step_at_time: step,
    session_file: metrics.sessionFile,
  });
  // Deliberately NO writes to JOURNAL.md or DIRECTIVES.md. Compression is
  // invisible to the agent. The next before_prompt_build fires and
  // re-injects live state from JOURNAL.md automatically.
});
```

### 6.6 The exact bytes, by zone

**Cached (in `extraSystemPrompt`, set once at spawn — never changes for this agent's life):**
The full content of DIRECTIVES.md (§ 5.3), verbatim, prefixed with a short header so the model knows what it's looking at:

```
## AGENT CONTRACT  [immutable, in system prompt cache; set once at spawn]

<contents of DIRECTIVES.md verbatim>

--- end contract ---
```

This is 500-1500 tokens depending on DoD size. Cached at 1h TTL. Refreshed by Anthropic only on TTL lapse or explicit invalidation.

**Per-turn (as `prependSystemContext`, re-read from JOURNAL.md every turn):**

```
## LIVE STATE  [from JOURNAL.md, re-read every turn — survives compression]

CURRENT STEP:   step-3 — Implement loginHandler (error paths: 401, 429)
PROGRESS:       Wired Redis rate-limit; 401 path done; adding 429 path.
BLOCKER:        none
TURNS USED:     12/80   (warn 60, escalate 75)
LAST VERIFIER:  2026-04-16T03:57:58Z — failed: none   (ok to attempt DONE)
NEXT STEP:      step-4 — Implement logoutHandler

REMINDERS:
  - Your contract (goal, I/O, DoD, constraints, PROTOCOL) is in your system
    prompt — already visible above. Do not re-read DIRECTIVES.md per turn.
  - To mark a step DONE, you must first call the verifier runner and have
    every DoD criterion return PASS. The write layer enforces this.
  - Before any new file, grep ../../SERVICES.md for existing services.
```

~100-150 tokens. Sits after the cache boundary; always recomputed. Cost per turn is trivial.

**Design notes:**
- **No timestamps** in the LIVE STATE block beyond `LAST VERIFIER` (which is itself a JOURNAL field — only changes when the agent runs the verifier, not per turn).
- The `REMINDERS` block is byte-stable across all agents and all turns — it's part of the `buildLiveStateInjection` template, not JOURNAL-derived. Zero-cost reinforcement of the invariants.
- The cached CONTRACT block includes the full PROTOCOL section — the agent sees the rules every turn without paying for them beyond the cache write.

---

## 7. Verifier Contract (the mechanism that enforces DoD)

Every DoD criterion is one of a closed set of typed verifiers. No free-form checks. If a criterion cannot be expressed with one of these types, decompose the step until it can.

### 7.1 Verifier types

| type | fields | PASS when |
|------|--------|-----------|
| `file_exists` | `path` | `fs.exists(path)` |
| `file_absent` | `path` | `!fs.exists(path)` |
| `shell_exit_zero` | `cmd`, `cwd?`, `timeout_s?` (default 300) | exit code 0 |
| `shell_exit_nonzero` | same | exit code != 0 |
| `http_status` | `url`, `method?`, `headers?`, `body_json?`, `status`, `expect_json?`, `timeout_s?` | response matches |
| `grep_present` | `path`, `pattern`, `flags?` | ripgrep finds ≥1 match |
| `grep_absent` | `path`, `pattern`, `flags?` | ripgrep finds 0 matches |
| `test_passes` | `cmd` (test runner invocation), `timeout_s?` | exit 0 |
| `json_schema_match` | `path` or `cmd`, `schema` (JSON schema) | validates |
| `fs_size_under` | `path`, `max_bytes` | size < max |
| `llm_judge` | `rubric_path` or `rubric`, `inputs`, `min_score`, `judge_model?`, `seed?` | judge score ≥ min |
| `all_of` | `checks: [Verifier]` | every child PASS |
| `any_of` | `checks: [Verifier]` | at least one PASS |

`expect_json` supports `{ "$regex": "..." }` and `{ "$eq": ... }` leaves, matched by JSONPath.

### 7.1a The `llm_judge` verifier (generality without giving up authority)

The `llm_judge` type is how the system handles tasks whose success is not expressible as a command-exit or a file check: research writeups, analyses, explanations, generated content. It does *not* relax verifier authority — the judge's output is still a deterministic PASS/FAIL gate, just one where the comparator is a model call rather than a shell exit code.

```yaml
- type: llm_judge
  rubric_path: rubrics/code-review-quality.md   # or inline `rubric:` string
  inputs:                                        # what the judge sees
    - artifact: src/routes/auth.ts
    - interface: services/auth.md
    - constraint: "JWT expiry must be 24h; no hardcoded secrets"
  min_score: 4.0           # out of 5 on the rubric's scale
  judge_model: sonnet-4.6  # independent of the doer's model
  seed: 42                 # reproducibility
```

**Design properties:**
- **Independent pass.** The judge runs with no access to the doer's conversation, JOURNAL, or reasoning — only the declared `inputs`. Its prompt is `{ rubric, inputs, scoring instructions }`. Gameable in theory (the doer could write artifacts that manipulate the judge), structurally much harder than self-report.
- **Rubric is part of the contract.** It lives at decomposition time alongside the other DoD entries. Rubric quality is part of decomposition quality; bad rubric → bad decomposition → caught by granularity tests or by the parent on re-verification.
- **Reproducible.** Same `seed` + same `judge_model` + same inputs + same rubric → same score. Re-verification by the parent uses the same call and should produce the same result.
- **Bounded cost.** Judge model is typically smaller/cheaper than the doer (e.g., Sonnet judging Opus work).
- **Still a verifier.** Returns `{ pass: bool, detail: score, evidence: rationale }` like every other verifier. The in-memory `verifierPasses` map records it the same way.

**When to use:** any DoD criterion that can't be expressed as a mechanical check but CAN be expressed as "here is an artifact, here is a rubric, score it." HCAST's general-reasoning tier, research-report tasks, analysis outputs, explanation quality, code-review quality.

**When NOT to use:** any criterion that *can* be mechanical. If `test_passes` covers it, use `test_passes`. `llm_judge` is last-resort generality, not first-choice convenience.

### 7.2 Runner contract

```typescript
type VerifierResult =
  | { pass: true;  detail?: string }
  | { pass: false; detail: string; evidence?: string };

async function runVerifier(v: Verifier, ctx: { workspaceDir: string }): Promise<VerifierResult>;
async function runAllDoD(dod: Verifier[], ctx): Promise<{
  allPass: boolean;
  results: { verifier: Verifier; result: VerifierResult }[];
}>;
```

Every agent calls `runAllDoD` before advancing any step. The result is written to `WORKING NOTES` on FAIL (for visibility) and to the step's `verified_outputs` on PASS.

### 7.3 The rule
**An agent MUST NOT mark a step DONE without a PASS from `runAllDoD` for that step's DoD.** The write path for "mark DONE" literally calls the runner and refuses to write DONE if any check FAILs. This is enforced in `extensions/directive-persistence/src/directives/write.ts`, not by convention.

---

## 8. Main Agent Operations (Bootstrap, Decompose, Dispatch, Seal, Archive)

The main agent is "just another agent" in that it runs under the same DIRECTIVES/JOURNAL/hook system. But four properties make it unique enough to warrant a dedicated section:

1. **Longest-lived.** Exists for the entire project lifetime; will experience orders of magnitude more compactions than any child.
2. **Only writer of child DIRECTIVES.** Every sub-agent's contract is authored here.
3. **Only agent with cross-stage state.** Tracks stages end-to-end; JOURNAL would grow unbounded without explicit archival.
4. **No parent.** Its "parent" is the human. Its bootstrap and its completion are both human handoffs.

Everything below is engineered so the main agent can still function correctly at turn 10,000 — when 99% of the conversation has been compacted away and most of what happened is only discoverable by reading files.

### 8.0 Bootstrap (who writes what, when)

**The "plan" is the task.** `PLAN.md` is the task specification handed in by the human (or by a benchmark adapter). It is *not* a document the main agent authors — the better the task is specified, the better the main agent's decomposition. Quality of decomposition is capped by quality of PLAN.md.

**Human writes** (once, at project start):
- `PLAN.md` — the task. Minimum: Goal (one paragraph), project-level DoD (machine-verifiable or LLM-judge), and a stage list. Stage list can be as terse as one bullet per stage; the main agent will scaffold the per-stage files from these bullets. If the task is exploratory and stages aren't known yet, the first listed stage is `stage-00-discover` whose output contract is "enough additional structure in PLAN.md to proceed."
- The main agent's `DIRECTIVES.md` — the orchestration contract (template in § 8.1). This and PLAN.md are the only files a human writes by hand; everything else is produced by agents.

**For benchmarks:** a thin adapter per benchmark converts the task description into a minimal PLAN.md + main-agent DIRECTIVES.md. For HCAST-style tasks, the adapter is ~50 lines. The agent system is benchmark-agnostic; the adapter is benchmark-specific.

**Main agent writes** (continuously, over the project lifetime):
- `JOURNAL.md` (its own)
- Every stage file under `project-plan/` (scaffolded from the stage entries in PLAN.md)
- Every sub-agent's `DIRECTIVES.md` + `.directives-lock.json`
- `services/<name>.md` cards at seal time
- Appends to `SERVICES.md`, PLAN.md Sealed Outputs Registry, and `.agent-events.jsonl`

**Main agent never writes:**
- `PLAN.md` top-level sections (Goal, project DoD, Stages list) — only the human edits those via REPLAN (§ 12.3). Main agent DOES append to PLAN.md's Sealed Outputs Registry on seal; that section is explicitly main-writable.
- Its own DIRECTIVES.md — `chmod 0444`, same rule as every other agent.
- Any file under `src/`, `tests/`, or other implementation directories. Main dispatches; children implement.

### 8.1 Main agent's DIRECTIVES.md (the orchestration contract)

```markdown
# DIRECTIVES  (main agent — project orchestrator)
schema_version: 1
agent: main
parent: null                        # human-initiated
workspace: /workspace/
spawned: 2026-04-16T03:14:22Z
journal: ./JOURNAL.md

## GOAL
Deliver the project defined in ./PLAN.md through to every stage SEALED and
every project-level DoD criterion verified PASS. Coordinate sub-agents;
do not implement.

## INPUT CONTRACT
- ./PLAN.md                           # human-authored; REPLAN-gated edits
- ./SERVICES.md                       # starts empty; you append on seal
- ./project-plan/                     # starts empty; you scaffold stage files

## OUTPUT CONTRACT
- All stages in PLAN.md reach status: SEALED
- All sealed outputs published to SERVICES.md + services/*.md cards
- Project DoD verifier (from PLAN.md) returns allPass

## DEFINITION OF DONE
- type: shell_exit_zero
  cmd: "node scripts/verify-plan-dod.ts --all-stages-sealed --project-dod-pass"
- type: json_schema_match
  path: PLAN.md
  schema: "all-stages-sealed.schema.json"
- type: file_absent
  path: .active-subagent-sessions    # no orphan children

## CONSTRAINTS
- Do NOT execute implementation work. Dispatch to sub-agents.
- Do NOT read files under src/, tests/, or other implementation dirs.
  To understand what a sealed stage produced, read its services/*.md card —
  never the source.
- Do NOT modify a SEALED stage file or an already-written services/*.md.
- Do NOT mark a child DONE on their claim alone — always re-verify (§ 8.5).
- Maintain the bounded-JOURNAL invariant (§ 8.7): every stage seal triggers
  an archival step that collapses the stage's JOURNAL detail into a one-line
  pointer.

## TURN BUDGET
max_turns: 2000     warning_at: 1600    escalate_at: 1900
# Cost budget lives in PLAN.md and is enforced by the supervisor (§ 12.2).

## INITIAL DECOMPOSITION — the orchestration loop
# Not linear. A repeating pattern. JOURNAL tracks current instance.
- orch-A: Bootstrap validation (once, on first turn)
- orch-B: Pick next runnable stage (one whose deps are all SEALED)
- orch-C: Read/validate stage file; scaffold if missing
- orch-D: Pre-flight SERVICES.md reuse check for each declared sub-task
- orch-E: Decompose → write one DIRECTIVES.md per surviving sub-task (§ 8.4)
- orch-F: Spawn sub-agents (parallel where can_start allows)
- orch-G: Monitor + re-verify TASK_COMPLETE claims (§ 8.5)
- orch-H: Seal stage (§ 8.6)
- orch-I: Archive stage detail out of JOURNAL (§ 8.7)
- orch-J: Loop to orch-B until no runnable stages remain
- orch-K: Run project-level DoD verifier; TASK_COMPLETE or BLOCKED to human

## PROTOCOL (how you operate — read once, then live by it)
You are the main agent of an OpenClaw project under the Persistent Directive
System. You coordinate; you do not implement.

1. You maintain ./JOURNAL.md. Its structure is defined in § 8.2.
2. Each stage is a repeat of orch-B through orch-I. You do NOT hold "the
   whole project" in context at once; you hold exactly the current stage.
3. Before any decomposition step, read ./SERVICES.md and grep it. Reuse
   before implementation. DRY is a verification failure.
4. Never read implementation files. If you need to know what stage-02
   produced, read services/<name>.md — never src/. The black-box rule is
   strictest for you because your context has to survive the longest.
5. Never trust a child's TASK_COMPLETE message. Re-verify every claim by
   running that child's DoD independently (§ 8.5).
6. Compaction is invisible. On the other side, PLAN.md + JOURNAL.md +
   SERVICES.md + the stage file of your CURRENT STAGE give you complete
   situational awareness. Trust the files, not the conversation.
7. On every stage seal: run orch-I (archival). The stage's detail moves
   from JOURNAL into the stage file's SEALED SUMMARY. JOURNAL keeps only
   a one-line pointer. This is what keeps you viable at turn 10,000.
8. If stuck for real (not "this is hard"), emit BLOCKED with a specific
   classification (contract-dispute / input-missing / infra-issue /
   implementation-hard) and wait. Do not thrash.
```

This content is the main agent's `extraSystemPrompt`. It's cached at 1h TTL; refreshed only when the TTL lapses. The main agent sees the PROTOCOL every turn without paying for it beyond the cache write.

### 8.2 Main agent's JOURNAL.md (differs from a sub-agent's)

A sub-agent's JOURNAL (§ 5.3b) has a simple task stack. The main's JOURNAL tracks stages, active children, and rolling orchestration-steps — and it must stay bounded as stages complete.

```markdown
# JOURNAL (main)
schema_version: 1
agent: main
last_updated: 2026-04-16T04:12:07Z
turns_used: 847

## CURRENT STAGE
# Exactly one active stage at a time (or none, between stages).
stage: stage-03-auth
activated: 2026-04-16T03:45:00Z
sub_tasks_total: 2
sub_tasks_dispatched: 2
sub_tasks_sealed: 1
sub_tasks_blocked: 0

### Active Children (bounded; DONE children are removed on seal-child)
- id: sub:auth-b:f1a2
  sub_task: stage-03.B
  status: IN_PROGRESS
  spawned: 2026-04-16T03:58:06Z
  turns_used: 14
  last_event_ts: 2026-04-16T04:11:55Z
  last_event: AGENT:STEP_COMPLETE (step-2)

### Sub-tasks NOT yet dispatched (pending gates)
# (empty for stage-03 — both already spawned)

## ORCHESTRATION TASK STACK
# Rolling window of orch-steps FOR THE CURRENT STAGE only.
# Cleared on stage archival (§ 8.7).

#### orch-E: Decompose stage-03 into child DIRECTIVES
status: DONE
completed: 2026-04-16T03:58:04Z
verifier_run_id: vr-main-0041
verified_outputs:
  - project-plan/stage-03-auth/sub-a-d7e9/DIRECTIVES.md  sha 8f3e...
  - project-plan/stage-03-auth/sub-a-d7e9/.directives-lock.json
  - project-plan/stage-03-auth/sub-b-f1a2/DIRECTIVES.md  sha 2a9c...
  - project-plan/stage-03-auth/sub-b-f1a2/.directives-lock.json
black_box: YES

#### orch-F: Spawn children for stage-03
status: DONE
completed: 2026-04-16T03:58:07Z

#### orch-G: Monitor + re-verify children for stage-03
status: IN_PROGRESS
started: 2026-04-16T03:58:07Z
progress: "sub:auth-a DONE+re-verified; waiting on sub:auth-b (turn 14/60)."
blocker: null

#### orch-H: Seal stage-03
status: PENDING

#### orch-I: Archive stage-03 detail from JOURNAL
status: PENDING

## COMPLETED STAGES (one-line archive; append-only)
# Each line = pointer to stage file's SEALED SUMMARY. No inline detail.
- stage-01-scaffold  SEALED 2026-04-16T03:30:00Z → project-plan/stage-01-scaffold.md
- stage-02-database  SEALED 2026-04-16T04:10:00Z → project-plan/stage-02-database.md

## PENDING STAGES (mirror of PLAN.md; refreshed on each orch-B)
- stage-04-api    PENDING   depends: [stage-03]
- stage-05-tests  PENDING   depends: [stage-04]
- stage-06-deploy PENDING   depends: [stage-05]

## WORKING NOTES
# Scratch for CURRENT STAGE only. Cleared on archival.
- sub:auth-b appears blocked-ready; last_heartbeat 12s ago is fine.
- Reminder: on seal, verify src/routes/auth.ts interface matches the
  services/auth.md card I'll author, not by reading the source — by
  asking sub:auth-b to echo its interface in TASK_COMPLETE.

## SUB-AGENTS (historical — empty; use .agent-events.jsonl for history)

## COMPLETION REPORT (written once, at all-stages-sealed)
```

**What makes this JOURNAL bounded:**
- CURRENT STAGE section: one stage's worth of detail, cleared on archival (~0.5-3 KB).
- Active Children: only currently-in-flight; removed on seal (~200 bytes per child).
- ORCHESTRATION TASK STACK: rolling window for current stage; cleared on archival.
- COMPLETED STAGES: one line per sealed stage (~80 bytes each; 50 stages = 4 KB).
- PENDING STAGES: one line per remaining stage (shrinks as stages seal).
- WORKING NOTES: scratch for current stage; cleared on archival.

**Size ceiling:** ~8 KB across any project of any length. LIVE STATE injection stays ≤500 tokens.

### 8.3 The LIVE STATE injection for the main agent

Derived from main's JOURNAL every turn. Slightly richer than a leaf agent's injection because the main has more concurrent state to track, but still bounded:

```
## LIVE STATE  [from JOURNAL.md, re-read every turn]

CURRENT STAGE:   stage-03-auth  (activated 2026-04-16T03:45:00Z)
                 2 sub-tasks total  |  1 sealed  |  0 blocked  |  1 in flight

ACTIVE CHILDREN:
  - sub:auth-b:f1a2  stage-03.B  IN_PROGRESS  turns 14/60
    last: AGENT:STEP_COMPLETE (step-2)  12s ago

CURRENT ORCH-STEP: orch-G — Monitor + re-verify children for stage-03
PROGRESS:          sub:auth-a DONE+re-verified; waiting on sub:auth-b.
BLOCKER:           none
TURNS USED:        847/2000  (warn 1600, escalate 1900)

NEXT ORCH-STEPS:   orch-H (seal stage-03) → orch-I (archive) → orch-B (pick next stage)

STAGE PROGRESS:    2 SEALED / 1 ACTIVE / 3 PENDING      (of 6 total)

REMINDERS:
  - Your orchestration contract is in your system prompt above.
  - On seal: run orch-I archival to keep JOURNAL bounded.
  - Re-verify children via their own DoD before marking them DONE.
  - Never read src/ — read services/*.md cards.
```

~250 tokens. Recomputed every turn. Bounded regardless of project size because the COMPLETED STAGES count appears as a scalar, not a list.

### 8.4 Writing child DIRECTIVES (the deterministic methodology)

The main agent does not freehand child DIRECTIVES. It follows a template-driven pipeline with validation at each step. Every child DIRECTIVES is the output of this pipeline; it is not "written" in the creative sense.

**Step 1 — Resolve inputs to path-level pointers.**
Every Input Contract entry must be one of: a file path that exists, or `services/<name>.md` pointer. "Check the repo" / "look at the db stuff" are rejected by the validator. If the main agent can't specify an exact input, the sub-task is not ready.

**Step 2 — Resolve outputs to single-artifact Output Contracts.**
Each Output Contract entry must be: exactly one file, OR one service card, OR one well-defined artifact. If a sub-task has two primary outputs (`src/foo.ts` AND `src/bar.ts` of unrelated concerns), split it.

**Step 3 — Express DoD in the 12 verifier types (§ 7).**
For each acceptance criterion, pick a verifier type. If no type fits, one of three things is true: (a) the criterion is wrong → reformulate; (b) the criterion belongs at a higher level (stage DoD, project DoD) → move it; (c) a new verifier type is genuinely needed → STOP, escalate to human. Never paper over with free-form text.

**Step 4 — Apply the § 4 granularity tests.**
- Verification: each DoD is one typed entry.
- Turn budget: ≤30 turns expected; hard ceiling. Estimate from the complexity of the Output Contract.
- Output cardinality: one primary artifact.
- Contract multiplicity: ≤2 external inputs.
- Reasoning volume: <5K tokens of mandatory context. If the sub-task would need the agent to reason over more than ~5K tokens of input files + service cards simultaneously, split.

If any test fails: split into N smaller sub-tasks, make them sequential (each depends on the previous SEAL), and write N DIRECTIVES instead of one.

**Step 5 — Fill the DIRECTIVES template (§ 5.3).**
The template is fixed; the fields that vary are:
- GOAL (one sentence from the sub-task goal in the stage file)
- INPUT CONTRACT (from step 1)
- OUTPUT CONTRACT (from step 2)
- DEFINITION OF DONE (from step 3)
- CONSTRAINTS (copied from stage file + global constraints from PLAN.md)
- TURN BUDGET (estimate + 20% safety margin)
- INITIAL DECOMPOSITION (3-7 steps; child may subdivide but not drop)
- PROTOCOL (byte-identical across all children — part of the template, not written by main)

**Step 6 — Schema validate.**
Run the DIRECTIVES zod validator on the generated content. Any failure → fix and retry. No child spawn without a valid DIRECTIVES.

**Step 7 — Atomic write + chmod + lock.**
In one atomic sequence:
1. `writeDirectivesAtomic(path)` (tmp + fsync + rename + dir-fsync).
2. `chmod 0444` the file.
3. Compute SHA-256; write `.directives-lock.json` with `{ sha256, size, written_at }`.
4. `AGENT:CHILD_DIRECTIVES_WRITTEN` event.

The *existence of `.directives-lock.json`* is the marker "this child has been prepared." It is what makes orch-E resumable across compactions: if main is compacted mid-decomposition, the next turn re-scans the stage directory, sees which locks exist, and only processes sub-tasks that don't have a lock yet.

**Step 8 — Spawn.**
`sessions_spawn` with `extraSystemPrompt` set to the DIRECTIVES content, `workspaceDir` set to the sub-agent's directory, `attachments` including DIRECTIVES.md as redundancy. Record the session key in JOURNAL Active Children + emit `AGENT:SUBAGENT_SPAWNED`.

**Idempotency guarantee:** Steps 1-7 are resumable; step 8 is guarded by checking whether the session is already active (Active Children already contains this `sub_task` id). The main agent can be compacted between any two steps and come back to the same state.

### 8.5 Monitoring and re-verification (the anti-early-stopping layer for main)

When a child sends `TASK_COMPLETE`:

1. **Parse strict.** The format is fixed (§ 9.2). Any deviation → re-prompt the child with the exact format, no progress.

2. **Verify file-level claims cheaply.** For each claimed output file: `file_exists`, `fs_size_under`, optional `grep_present` on the claimed exports. If the file doesn't exist or is empty, the child's report is wrong — re-prompt.

3. **Re-run the child's DoD.** Independently. Do not trust self-report. This is the same `runAllDoD` the child ran; main runs it again from its own workspace with its own cwd. If any criterion FAILs, the child stays IN_PROGRESS and gets a remediation message with:
   - The exact failing criterion
   - Verifier evidence (stdout/stderr/HTTP body)
   - "Your JOURNAL.md says DONE but criterion X fails as follows. Return to step N."

4. **Cost optimization:** skip re-running verifiers whose outcome can be cryptographically confirmed from git state. `file_exists` and `grep_present` can be confirmed from the file's git SHA matching the child's report. `shell_exit_zero` and `http_status` and `test_passes` always re-run — their outcome isn't in git.

5. **On all-pass:** remove child from Active Children, emit `AGENT:STEP_COMPLETE` (at main level, referencing the child's output), advance JOURNAL's `sub_tasks_sealed` counter.

When a child sends `TASK_BLOCKED`:

1. **Read child's JOURNAL** (main is allowed to read child's JOURNAL for triage; it's not allowed to WRITE).
2. **Classify the blocker:**
   - `contract-dispute` — child thinks DIRECTIVES is wrong. Main decides: respawn with amended DIRECTIVES (creates a new child; old is marked ABANDONED), or push back with reasoning.
   - `input-missing` — upstream output isn't there or doesn't match interface. Main investigates upstream; may respawn upstream with a new DIRECTIVES targeting the specific gap.
   - `infra-issue` — tooling broken (network, LSP, binary missing). Emit `AGENT:HUMAN_ESCALATION`; wait.
   - `implementation-hard` — genuine decomposition error. Kill child (emit ABANDONED), write N smaller DIRECTIVES for sub-sub-tasks, respawn.

3. **Always log the decision** in JOURNAL WORKING NOTES with the classification + action.

### 8.5a Progressive-granularity retry (automatic decomposition on repeat failure)

When a child's `report_task_complete` fails parent re-verification, or a child emits `report_task_blocked` with `implementation-hard`, the default path is NOT "re-prompt harder." It's **automatically decompose that child's work into smaller sub-children.** Thrashing a stuck child rarely recovers; decomposing almost always does.

**The rule:**
- **1st failure** of a given child on the same DoD criterion: remediation prompt with specific evidence (per § 8.5.3). Child stays.
- **2nd failure** on the same criterion: main **abandons this child** and re-decomposes its Output Contract into N smaller sub-tasks, each with its own DIRECTIVES. N is typically 2-4; the failed DoD criterion becomes the DoD of the *last* sub-child, and preceding sub-children establish its preconditions.
- **3rd failure across the re-decomposed sub-children** on any single DoD criterion: escalate to human via `AGENT:HUMAN_ESCALATION`. No infinite descent.

**Concrete example.** A child trying to "implement auth endpoints" fails `test_passes` twice. Main inspects the failure evidence, decomposes into:
- `stage-03.A.1`: Implement login happy path; DoD = `test_passes` on `tests/auth/login-happy.test.ts` only.
- `stage-03.A.2`: Implement login 401 error path; DoD = `test_passes` on `tests/auth/login-401.test.ts` only. Depends on A.1.
- `stage-03.A.3`: Implement login 429 rate limit; DoD = `test_passes` on `tests/auth/login-rate.test.ts` only. Depends on A.2.
- `stage-03.A.4`: Consolidate into the stage-03.A output; DoD = full `test_passes` on `tests/auth.test.ts`. Depends on A.3.

Each is smaller. Each has a clearer DoD. Sequential dependencies prevent the sub-children from stepping on each other.

**Events emitted:**
- `AGENT:CHILD_ABANDONED` when main decides to abandon.
- `AGENT:PROGRESSIVE_DECOMPOSE` with the new sub-task count.
- Each new sub-child gets the usual `AGENT:SUBAGENT_SPAWNED` sequence.

**Why this matters for the "incremental perfection" claim:**
A failing child on a too-coarse task, re-prompted repeatedly, eventually produces one of: (a) a silent false-positive DONE that slips past re-verification on the Nth try, (b) a BLOCKED that stalls the whole project. Progressive decomposition converts "this slice is too hard for one child" into "this slice is N smaller slices for N smaller children." Because each smaller slice has a smaller DoD, the verifier gate stays meaningful. The system never has to accept "good enough" — it just makes the slices small enough that actual completion becomes tractable.

**Recursion limit.** A sub-child of a re-decomposed child may itself fail and trigger another progressive-decompose, but only to **depth 2** from the original stage sub-task. Depth 3+ escalates to human. This prevents the system from drilling into the earth trying to split an irreducibly hard problem.

### 8.6 Stage sealing (orch-H)

DoD for this orch-step, in order:
1. Every Active Child for this stage has reached DONE or is ABANDONED (no children in IN_PROGRESS / BLOCKED).
2. `runAllDoD(stage.DoD)` returns allPass.
3. Each Output Contract item is independently verified:
   - File outputs: file exists, matches interface (exports grep, signatures, etc.)
   - Service outputs: card exists, interface matches Output Contract

Then:
1. Write SEALED SUMMARY block into stage file (§ 5.2).
2. For each service output: write `services/<name>.md` (main authors; child's TASK_COMPLETE may have proposed it, but main writes it so the card is trusted).
3. Append to `SERVICES.md` index.
4. Append to `PLAN.md` Sealed Outputs Registry. (This is the one place main writes to PLAN.md.)
5. `chmod 0444` the stage file.
6. Emit `AGENT:STAGE_SEALED` with outputs + service cards.

Stage is now immutable. Its detail leaves JOURNAL in the next step.

### 8.7 Bounded-JOURNAL invariant (orch-I — archive)

This is the step that makes main viable at turn 10,000. It runs after every seal.

**What orch-I does:**
1. In JOURNAL, delete the CURRENT STAGE block, the ORCHESTRATION TASK STACK (for this stage), and the WORKING NOTES.
2. Append one line to COMPLETED STAGES: `- stage-NN-name  SEALED <ts> → project-plan/stage-NN-name.md`.
3. Update PENDING STAGES (remove the just-sealed stage).
4. Clear Active Children for this stage (they're all DONE or ABANDONED by definition; the entries are redundant with the stage file's Execution Log).
5. Atomic write.
6. Emit `AGENT:JOURNAL_ARCHIVED` with bytes-freed delta.

**Why this is safe:** nothing is lost. Every deleted datum is already preserved:
- Sub-agent detail → stage file's Execution Log.
- Orch-step history → `.agent-events.jsonl`.
- Decisions → stage file's SEALED SUMMARY notes field, or WORKING NOTES dumped into the stage file at seal time (new: add this to seal step).
- Verifier outputs → `.agent-events.jsonl` (`AGENT:VERIFIER_RUN` events).

**What remains in JOURNAL post-archive:**
- Base header (schema, agent, last_updated, turns_used).
- COMPLETED STAGES: +1 new line.
- PENDING STAGES: -1 line.
- Empty CURRENT STAGE, empty ORCHESTRATION TASK STACK, empty Active Children, empty WORKING NOTES.

JOURNAL size after archive: `base_header + N × 80 bytes`. Over 50 stages: ~6 KB. LIVE STATE injection stays lean forever.

### 8.8 Long-horizon resilience (how main orients at turn 10,000)

On any turn — whether turn 5 or turn 10,000 — the main agent's orientation comes from exactly these sources, in this order:

1. **Cached system prompt** (DIRECTIVES via `extraSystemPrompt`): GOAL, project-level Output Contract, DoD, CONSTRAINTS, PROTOCOL, orchestration loop shape. Never changes.
2. **LIVE STATE injection** (from JOURNAL): CURRENT STAGE (if any), Active Children (bounded), current orch-step with DoD, next orch-steps, completed stages count, reminders. ≤500 tokens.
3. **PLAN.md** — read at orch-B (stage selection) and whenever PENDING STAGES mirror goes stale. Never more than once per stage.
4. **Current stage file** — read at orch-C and whenever orch-steps need its sub-task list or Output Contract. Bounded size.
5. **SERVICES.md** — read at orch-D (pre-flight DRY check) and on any seal when authoring new service cards. Append-only, small.
6. **Previous stage files** — read only if the current stage's Input Contract references their output. Stage file's service card is the first read; source code is never read.
7. **`.agent-events.jsonl`** — NEVER read by main. That file is for humans.

That's it. Everything else the main agent "knew" at turn 10 is either (a) in the cache, (b) in a file it will re-read when it needs to, or (c) legitimately forgotten because it's irrelevant to orch-B onward.

**The turn-10,000 test:**
> "Can a fresh instance of the main agent, given its DIRECTIVES.md as system prompt and its current JOURNAL.md as live state, with ZERO conversation history, pick up and correctly execute the next orchestration step?"

If yes: the design works. If no: JOURNAL is under-specified or something critical is only in the conversation history.

Our design passes this test by construction because:
- Every orch-step has its DoD written into JOURNAL alongside its status.
- Every completed step has verifier evidence in `.agent-events.jsonl` (reachable if main needs to verify a claim).
- Every active child's status is in JOURNAL.
- Every sealed stage's outputs are in its stage file, published to SERVICES.md, and summarized in PLAN.md.

### 8.9 Main agent's self-completion

Main is DONE when:
- Every stage in PLAN.md has `status: SEALED`.
- `runAllDoD(PLAN.md project-level DoD)` returns allPass.
- No Active Children; no pending orch-steps except orch-K.
- `SERVICES.md` has a card for every Output Contract entry across all sealed stages.

On verified completion:
1. Emit `AGENT:PROJECT_COMPLETE` with total turn count, total cost, service count, total compactions.
2. Write final COMPLETION REPORT into JOURNAL.
3. Send a structured summary message to the human:
   ```
   PROJECT_COMPLETE
   stages_sealed: 6
   services_published: 8
   total_turns: 1847
   total_compactions_all_agents: 42
   cost_usd: 38.42
   next_action: human-review (ship / deploy / …)
   ```
4. Stop. Human takes over.

---

---

## 9. Sub-Agent Recursion (actual `sessions_spawn` mechanics)

OpenClaw 2026 exposes `sessions_spawn` via the `sessions-spawn-tool` (see `src/agents/tools/sessions-spawn-tool.ts`). The spawning agent passes `task`, `workspaceDir`, `attachments`, and session-routing fields. Session keys carry the `sub:` prefix (per `routing/session-key.ts`), which triggers `resolvePromptModeForSession → "minimal"` — exactly what we want for sub-agents.

### 9.1 Parent's spawn sequence (atomic)

```
1. mkdir -p /workspace/<sub-id>
2. write SERVICES.md symlink or copy into /workspace/<sub-id>/SERVICES.md
   (read-only view; sub-agent consults but cannot seal new services — parent does)
3. write /workspace/<sub-id>/DIRECTIVES.md  (atomic)
4. verify file_exists + schema validates (refuse to spawn if not)
5. call sessions_spawn:
     task: <spawn message, § 9.2>
     workspaceDir: /workspace/<sub-id>
     sessionKey prefix: sub:<short-name>:<uuid-short>
     attachments: [DIRECTIVES.md]            # redundant but cheap; hook still reads workspace
6. record in main DIRECTIVES.md SUB-AGENTS:
     - id: sub:<...>  goal: <one liner>  status: IN_PROGRESS  output: null
7. emit AGENT:SUBAGENT_SPAWNED
```

### 9.2 Completion and blocker reports (structured tool calls, not free-form text)

Free-form TASK_COMPLETE messages are error-prone — one misplaced colon and the parent re-prompts, burning a turn. We replace them with **plugin-registered tools** so the schema is enforced at tool-call time, not at message-parse time.

**Tool 1: `report_task_complete`** (child invokes when all DoD PASS)

```jsonc
// Tool schema (zod-validated; malformed → tool call rejected before the agent sees a reply)
{
  "name": "report_task_complete",
  "description": "Report that every DoD criterion in your DIRECTIVES.md has passed verification. Before calling this, you MUST have called verifier.run(step_id) for each step and received allPass. The plugin will verify this precondition and reject the tool call otherwise.",
  "input_schema": {
    "outputs": [
      {
        "kind": "file" | "service" | "artifact",
        "path": "string",
        "sha256": "string (hex, 64 chars)",
        "interface_summary": "string (<=200 chars; for services, the I/O contract)"
      }
    ],
    "dod_evidence": [
      {
        "criterion_index": "integer (matches DIRECTIVES DoD array order)",
        "verifier_run_id": "string",
        "result": "PASS"
      }
    ],
    "service_card_proposal": "string | null  (markdown body of services/<name>.md the PARENT will author; null if no service output)"
  }
}
```

**Plugin-side precondition check:** before the tool call is allowed to return, the plugin checks:
1. Every DoD criterion in DIRECTIVES has a matching `dod_evidence` entry.
2. Every `verifier_run_id` exists in the `verifierPasses` map (§ 10.3a) with `all_pass: true`.
3. Every output's `sha256` matches the on-disk file.
4. The current agent is not already in a `DONE` state (no double-submits).

If any check fails: tool call errors out with a specific reason (`missing_verifier_run_id_for_criterion_2`, `sha_mismatch_for_outputs[0]`, etc.). Agent sees the error and must fix before retrying. No parent re-prompt burns a turn; the feedback is immediate and structured.

On pass: plugin emits `AGENT:TASK_COMPLETE` to `.agent-events.jsonl`, marks the child's session as awaiting-parent-verification, and signals the parent via `sessions_yield`. Parent's next turn processes it per § 8.5.

**Tool 2: `report_task_blocked`** (child invokes when genuinely blocked)

```jsonc
{
  "name": "report_task_blocked",
  "input_schema": {
    "classification": "contract-dispute" | "input-missing" | "infra-issue" | "implementation-hard",
    "step_id": "string",
    "summary": "string (<=200 chars)",
    "detail": "string (what you tried; why this is genuinely blocked, not just hard)",
    "proposed_remediation": "string | null   (e.g., 'decompose step-3 further into 3a,3b' or 'parent should amend DIRECTIVES to change output path')"
  }
}
```

**Plugin-side check:** `classification` must be one of the four values; `step_id` must exist in JOURNAL task stack; `proposed_remediation` required unless classification is `infra-issue`. On pass: emit `AGENT:BLOCKED` with the payload; signal parent.

**Why this is better than free-form messages:**
- Zero parse-error re-prompts — the tool schema is enforced at the SDK layer, not by the parent.
- Preconditions (verifier ran, SHAs match) are checked *before* the parent sees anything, so invalid completions never reach the parent's monitor loop.
- The agent cannot "forget" to run verifiers — the tool call fails if `verifierPasses` is empty for any DoD criterion.
- Observers get structured JSONL events instead of prose they have to scrape.

**The only other message shape a child produces** is normal assistant text during its work. TASK_COMPLETE and TASK_BLOCKED are terminal tool calls — after them, the child awaits parent.

### 9.3 Sub-agent isolation rules
- Reads only: own `DIRECTIVES.md`, own `JOURNAL.md`, own `SERVICES.md` symlink, files listed in Input Contract.
- Writes only: paths in Output Contract, own `JOURNAL.md`. DIRECTIVES.md is `chmod 0444` — writes fail at the OS layer.
- Does NOT read parent's `DIRECTIVES.md`/`JOURNAL.md`, `PLAN.md`, stage files, or sibling workspaces.
- Does NOT call `sessions_spawn` directly on siblings. It MAY spawn its own sub-sub-agents (recursive same system) if its own plan decomposition calls for it — in which case it is itself a parent and writes the child's DIRECTIVES + lock file.
- On `BLOCKED`: writes `blocker:` into JOURNAL.md, emits `AGENT:BLOCKED`, sends `TASK_BLOCKED` to parent, stops.

### 9.4 Parent's completion-handling
1. Parse `TASK_COMPLETE` message (strict, structured parser; any deviation → reject + re-prompt).
2. For each reported output: run verifiers to **independently** confirm (do not trust the child's self-report blindly).
3. If any verifier FAILs → mark sub-agent `IN_PROGRESS` again, send back a remediation prompt with exactly which criterion failed and the verifier's evidence. Never auto-mark DONE on child's claim.
4. If all PASS: mark sub-agent DONE in main `DIRECTIVES.md` SUB-AGENTS, append to stage Execution Log, proceed to next sub-agent or seal stage.

---

## 10. Agent Write Protocol

Agents write exactly one file: `JOURNAL.md`. `DIRECTIVES.md` is `chmod 0444` immediately after spawn-time write, and its SHA is recorded in `.directives-lock.json`. Every `before_prompt_build` re-verifies that SHA; mismatch emits `AGENT:DIRECTIVES_TAMPER_ATTEMPT` and the parent is expected to intervene.

### 10.1 JOURNAL.md — what agents MAY write

| Section | Writable? | When | Notes |
|---------|-----------|------|-------|
| TASK STACK: step `IN_PROGRESS` | YES | On step start | Also bumps `turns_in_step`. |
| TASK STACK: step `progress` | YES | Any time during step | ≤3 lines; short-form. |
| TASK STACK: step `blocker` | YES | When stuck | Non-null triggers `AGENT:BLOCKED`. |
| TASK STACK: step `DONE` | YES, **only** after `runAllDoD → allPass` | On verified completion | Write layer refuses if verifier last-run failed. |
| TASK STACK: step subdivision | YES | Any time | May add sub-steps under an existing step (see § 4). May NOT drop a step from DIRECTIVES' INITIAL DECOMPOSITION. |
| WORKING NOTES | YES | Any time | Volatile; cleared on step DONE. |
| SUB-AGENTS | YES | On spawn/completion | Mirrored to `.agent-events.jsonl`. |
| COMPLETION REPORT | YES, once | At `TASK_COMPLETE` | Written just before replying to parent. |
| `turns_used`, `last_updated`, `last_verifier_run` | YES | Every write | Bumped automatically by the write layer. |

### 10.2 DIRECTIVES.md — what agents MUST NOT write

*Nothing.* The file is read-only. If the agent believes a field in DIRECTIVES is wrong (over-specified DoD, incorrect input path, unreachable criterion), it reports `BLOCKED: contract-dispute` in JOURNAL.md with the specific field and reasoning. Only the parent can rewrite DIRECTIVES — and rewriting DIRECTIVES mid-flight requires a formal replan of the sub-agent (parent aborts the current session and respawns with a new DIRECTIVES.md).

### 10.3 Atomic write for JOURNAL.md

```typescript
export async function writeJournalAtomic(path: string, content: string) {
  const dir = dirname(path);
  const tmp = join(dir, `.JOURNAL.md.tmp.${process.pid}.${randomUUID()}`);
  await fs.writeFile(tmp, content, "utf8");
  const fd = await fs.open(tmp, "r+");
  try { await fd.sync(); } finally { await fd.close(); }
  await fs.rename(tmp, path);                  // atomic on POSIX
  const dirFd = await fs.open(dir, "r");
  try { await dirFd.sync(); } finally { await dirFd.close(); }  // durability of rename
}
```

The agent writes JOURNAL either through the `journal.write_done` / `journal.mark_blocked` / `journal.set_progress` plugin tools, OR through raw bash/`fs.writeFile`. Both paths eventually reach the atomic writer above. **But only one path is authoritative for DONE transitions** — see § 10.3a.

### 10.3a The write-authority mechanism (in-process verifier-pass map)

The agent has bash. It can bypass any plugin tool and `echo "status: DONE" >> JOURNAL.md`. File permissions can't stop it (the agent needs to write JOURNAL). The verifier-as-authority rule therefore cannot live on the filesystem. It lives in the **plugin's JavaScript process heap** — unreachable from inside the agent regardless of escape hatch.

**Structure (in `extensions/directive-persistence/src/verify/pass-registry.ts`):**

```typescript
type PassRecord = {
  agent: string;
  step_id: string;
  turn_no: number;      // agent turn at which verifier ran
  ts: string;           // ISO timestamp
  all_pass: true;       // map only stores passes
  verifier_run_id: string;
  dod_hash: string;     // SHA of the DoD criteria that passed; catches post-pass DoD drift
};

// Process-global, per plugin init. Agent cannot reach this memory.
const verifierPasses = new Map<string /*agent*/, Map<string /*step_id*/, PassRecord>>();

export function recordPass(rec: PassRecord): void { /* sets map entry */ }
export function getLatestPass(agent: string, step_id: string): PassRecord | undefined;
export function clearPass(agent: string, step_id: string): void;   // on DONE→IN_PROGRESS revert
```

**The `verifier.run(step_id)` plugin tool is the only code path that writes this map.** The tool:
1. Reads DIRECTIVES.md to find the step's DoD.
2. Runs `runAllDoD`.
3. If allPass: appends to `verifierPasses` with `turn_no` = current turn, plus a SHA of the DoD entries actually evaluated (guards against DoD drift post-pass).
4. Emits `AGENT:VERIFIER_RUN` to `.agent-events.jsonl` for observers.
5. Returns result to the agent.

**Persistence across process restarts:** the map is mirrored to `.plugin-state/verifier-passes.jsonl` at a path *outside* the agent's workspaceDir (i.e., the agent has no read or write access). On plugin load, the map rehydrates from that file. An attacker with arbitrary bash inside the workspace can't forge the state because the file lives in a path the plugin-init code scopes to project-root plus some plugin-private subdirectory.

### 10.3b The post-turn DONE-revert validator

Every agent turn fires a plugin `after_turn` hook (OpenClaw exposes `afterTurn` via the context-engine maintenance surface; we piggyback or register our own). The hook:

```typescript
sdk.registerHook("after_turn", async (_event, ctx) => {
  const journalPath = path.join(ctx.workspaceDir, "JOURNAL.md");
  if (!(await fileExists(journalPath))) return;

  const before = turnStartSnapshots.get(ctx.sessionKey);   // captured pre-turn
  const after  = await readJournal(journalPath);

  const transitions = diffTaskStack(before, after);
  const revertEdits: JournalEdit[] = [];

  for (const t of transitions) {
    if (t.from !== "DONE" && t.to === "DONE") {
      const pass = getLatestPass(ctx.agentId, t.step_id);
      const ok = pass
        && pass.turn_no === currentTurn(ctx)            // fresh this turn
        && pass.dod_hash === sha256OfDoD(ctx, t.step_id);  // DoD hasn't drifted

      if (!ok) {
        revertEdits.push({ step_id: t.step_id, restore_status: "IN_PROGRESS" });
        await appendEvent(ctx.workspaceDir, {
          event: "AGENT:JOURNAL_DONE_REVERTED",
          ts: new Date().toISOString(),
          agent: ctx.agentId,
          step_id: t.step_id,
          reason: !pass ? "no-verifier-run" :
                  pass.turn_no !== currentTurn(ctx) ? "stale-verifier-run" :
                  "dod-hash-mismatch",
        });
      }
    }
  }

  if (revertEdits.length > 0) {
    await applyEditsAtomic(journalPath, revertEdits);
    // Inject a system-level nudge on the next turn telling the agent what
    // happened, so it doesn't loop. This goes into LIVE STATE's REMINDERS.
    pushNextTurnNudge(ctx.sessionKey, revertEdits);
  }
});
```

**Properties:**
- Agent can `echo "status: DONE"` into JOURNAL all it wants. The post-turn hook reverts the transition next turn end, before any downstream code trusts it.
- Legitimate DONE (agent called `verifier.run`, got allPass, then wrote DONE) passes through unchanged.
- `dod_hash` check catches a pathological case: agent runs verifier, gets pass, then edits DIRECTIVES (impossible due to chmod, but defensive) or the step's DoD interpretation — revert triggers.
- Reverts are non-destructive: other JOURNAL changes on that turn (progress notes, blocker updates) are preserved. Only the `status: DONE` field reverts.
- The nudge mechanism prevents infinite reverts — next turn's LIVE STATE tells the agent "step-3 was reverted because you didn't run `verifier.run(step-3)` — call it before claiming DONE."

**This is the correct enforcement point.** No bash trick, no chmod game, no direct filesystem write can bypass it, because the authority is process-memory the agent cannot touch.

### 10.4 DIRECTIVES tamper handling

On spawn, the parent:
1. Writes DIRECTIVES.md atomically.
2. Records `{ sha256: <hex>, written_at: <ts>, size: <bytes> }` into `.directives-lock.json` (alongside DIRECTIVES.md).
3. `chmod 0444 DIRECTIVES.md` (file-system enforcement — most attempts fail before reaching the plugin).

On every `before_prompt_build`:
1. Stat DIRECTIVES.md; read first-N-bytes hash (cheap).
2. If full verification needed (e.g. size changed), compute full SHA.
3. Mismatch → emit `AGENT:DIRECTIVES_TAMPER_ATTEMPT` with agent ID + observed vs expected SHA. Do NOT restore the file from the hook (the parent owns recovery); do inject live state so the agent can at least report BLOCKED.

### 10.5 DONE DONE verification sequence

```
1. Agent believes step N is complete → calls verifier runner on step N DoD.
2. Runner executes each verifier; returns per-criterion results.
3. Runner writes AGENT:VERIFIER_RUN to .agent-events.jsonl with all results.
4. If any FAIL:
     a. Agent writes failing criteria + evidence to JOURNAL WORKING NOTES.
     b. Step remains IN_PROGRESS; writer rejects DONE transition.
     c. If this is the 3rd consecutive FAIL for the same criterion →
        stuck-detector emits AGENT:STUCK_WARNING; agent reports BLOCKED.
5. If all PASS:
     a. Atomic JOURNAL write: step N → DONE, verifier_run_id recorded,
        verified_outputs filled, black_box: YES, completed timestamp.
     b. Clear WORKING NOTES.
     c. Advance to next PENDING step, OR (if last step) assemble the
        TASK_COMPLETE reply and stop.
```

No shortcuts. No "I think it's fine." The runner is the authority, the write layer is the gate.

---

## 11. Observer Log (`.agent-events.jsonl`)

### 11.1 Location and audience
- Path: `{project-root}/.agent-events.jsonl` (single global file; all agents append).
- Append-only; never truncated; rotate daily to `.agent-events.YYYY-MM-DD.jsonl` via an out-of-band cron (optional).
- Audience: **external observers only** — Logan, `tail -f | jq`, monitoring scripts. **Agents never read this file.** Compression is not an agent concern.

### 11.2 Event catalog

All events include `event`, `event_id` (UUIDv4), `ts` (ISO8601 UTC), `agent`, `session`.

```jsonl
{"event":"AGENT:PLAN_BOOTSTRAPPED","agent":"main","session":"agent:main:abc","stages":6}
{"event":"AGENT:STAGE_ACTIVATED","agent":"main","stage":"stage-03-auth"}
{"event":"AGENT:SUBAGENT_SPAWNED","agent":"main","child":"sub:auth-a:d7e9","sub_task":"stage-03.A"}
{"event":"AGENT:STEP_STARTED","agent":"sub:auth-a:d7e9","step":"step-3"}
{"event":"AGENT:STEP_COMPLETE","agent":"sub:auth-a:d7e9","step":"step-2","outputs":["src/routes/auth.ts"]}
{"event":"AGENT:PRE_COMPRESSION_SNAPSHOT","agent":"sub:auth-a:d7e9","snapshot":{"current_step":"step-3","progress":"...","blocker":null},"msgs_before":450,"tokens_before":180000}
{"event":"AGENT:COMPRESSION_EVENT","agent":"sub:auth-a:d7e9","msgs_before":450,"msgs_after":64,"compacted_count":386,"tokens_after":52000,"step_at_time":"step-3"}
{"event":"AGENT:BLOCKED","agent":"sub:auth-a:d7e9","step":"step-3","reason":"dod-dispute","detail":"redis key schema from services/redis-session.md differs from implementation"}
{"event":"AGENT:STUCK_WARNING","agent":"sub:auth-a:d7e9","heuristic":"3+ compressions at same step","step":"step-3","compressions_here":4,"last_step_advance_age_s":2100}
{"event":"AGENT:BUDGET_WARNING","agent":"sub:auth-a:d7e9","turns_used":61,"turn_budget":80,"pct":0.76}
{"event":"AGENT:BUDGET_EXCEEDED","agent":"sub:auth-a:d7e9","turns_used":80,"turn_budget":80}
{"event":"AGENT:DIRECTIVES_TAMPER_ATTEMPT","agent":"sub:auth-a:d7e9","directives_path":"/ws/.../DIRECTIVES.md","expected_sha":"ab12...","observed_sha":"cd34..."}
{"event":"AGENT:JOURNAL_WRITE","agent":"sub:auth-a:d7e9","diff":{"step-3":"status IN_PROGRESS → DONE","step-4":"status PENDING → IN_PROGRESS"}}
{"event":"AGENT:VERIFIER_RUN","agent":"sub:auth-a:d7e9","step":"step-3","all_pass":false,"failures":[{"type":"shell_exit_zero","detail":"tsc error TS2345"}]}
{"event":"AGENT:TASK_COMPLETE","agent":"sub:auth-a:d7e9","outputs":["src/routes/auth.ts"],"dod_pass":true}
{"event":"AGENT:STAGE_SEALED","agent":"main","stage":"stage-03-auth","outputs":["src/routes/auth.ts","tests/auth.test.ts"],"registry":["services/auth.md"]}
{"event":"AGENT:REPLAN","agent":"main","affected_stages":["stage-04-api","stage-05-tests"],"reason":"requirements clarification"}
```

### 11.3 One-liners for live monitoring

```bash
# All events
tail -f .agent-events.jsonl | jq .

# Compressions only
tail -f .agent-events.jsonl | jq 'select(.event=="AGENT:COMPRESSION_EVENT")'

# Stuck + budget warnings (the two that need eyes)
tail -f .agent-events.jsonl | jq 'select(.event | test("STUCK|BUDGET"))'

# Per-agent compression count
jq -r 'select(.event=="AGENT:COMPRESSION_EVENT") | .agent' .agent-events.jsonl | sort | uniq -c

# Timeline for one agent
jq 'select(.agent=="sub:auth-a:d7e9")' .agent-events.jsonl

# Find stages that took the longest (seal_ts - activate_ts)
jq -s 'map(select(.event=="AGENT:STAGE_SEALED" or .event=="AGENT:STAGE_ACTIVATED"))
       | group_by(.stage)[] | ...' .agent-events.jsonl
```

---

## 12. Stuck Detection, Budgets, and Re-Planning

### 12.1 Stuck detection heuristics (observer-side)

Runs as a daemon that tails `.agent-events.jsonl`. Emits `AGENT:STUCK_WARNING` when any of:

- **Compression stall:** ≥3 `AGENT:COMPRESSION_EVENT`s at the same `step_at_time` for the same agent with zero `AGENT:STEP_COMPLETE` between them.
- **Idle stall:** ≥30 minutes (configurable) since the agent's last non-COMPRESSION event.
- **Verifier thrash:** ≥3 consecutive `AGENT:VERIFIER_RUN` failures on the same step with identical failure signatures.
- **Budget overshoot:** turns_used > 1.0 × turn_budget (triggers `AGENT:BUDGET_EXCEEDED` in addition).

The warning is written back to `.agent-events.jsonl`. **The agent never sees it** — Logan or an external supervisor acts on it.

### 12.2 Budgets
- Every `DIRECTIVES.md` and every stage file carries `turn_budget`, `warning_at` (80%), `escalate_at` (95%).
- When `turns_used ≥ warning_at`: emit `AGENT:BUDGET_WARNING`. No agent-facing change.
- When `turns_used ≥ escalate_at`: agent **must** emit `TASK_BLOCKED` with `reason: budget_escalation` and stop. Parent decides: extend budget, decompose further, or abandon.
- Cost budget is project-wide in `PLAN.md`. The supervisor can derive per-agent cost from session metrics and emit `AGENT:COST_WARNING` at 80% project budget.

### 12.3 Re-planning protocol (REPLAN)
Only the main agent (or human) can invoke REPLAN. Sequence:

1. Write `PLAN.md.replan-draft` with the proposed new state.
2. For every stage: determine impact:
   - `SEALED` → **immutable**. Cannot be edited. Must be worked around (new stage that supersedes, or abandoned and replaced).
   - `ACTIVE` → **frozen mid-flight**. Option A: wait for the current sub-agents to complete or fail; then re-plan. Option B: abort (emit `TASK_BLOCKED` to all children, wait for graceful stop, mark stage `ABANDONED`). No mid-flight edits.
   - `PENDING` → **freely editable**. May be rewritten, reordered, removed, or replaced.
3. Atomically replace `PLAN.md`. Emit `AGENT:REPLAN` with `affected_stages`.
4. `last_replanned` timestamp updated.
5. Any PENDING stage files that are now invalid must be rewritten or removed before any sub-agent can use them.

---

## 13. Prompt Cache Coexistence (Claude 4.7 / Anthropic 2026)

This section answers **"when is the prompt cached and when does it change?"** in one diagram.

### 13.1 The exact layout per API request

This is the complete top-down order of a request, including where LCM's output lands. Read it carefully — placement is not a guess.

```
╔═════════════════════════════════════════════════════════════════╗
║                   CACHED PREFIX (1h TTL)                        ║
║                                                                 ║
║  [tools]                                                        ║
║       OpenClaw tool catalog. Byte-stable per agent lifetime.    ║
║                                                                 ║
║  [system prompt]                                                ║
║       (a) OpenClaw base system prompt                           ║
║       (b) extraSystemPrompt = AGENT CONTRACT                    ║
║                             = full DIRECTIVES.md content        ║
║                               (goal, I/O, DoD, constraints,     ║
║                                PROTOCOL, initial decomposition) ║
║                                                                 ║
║  ← cache_control: { type: "ephemeral", ttl: "1h" }              ║
╚═════════════════════════════════════════════════════════════════╝
                        ↓ CACHE BOUNDARY ↓
╔═════════════════════════════════════════════════════════════════╗
║              UNCACHED SUFFIX (recomputed per turn)              ║
║                                                                 ║
║  [prependSystemContext]   ← from before_prompt_build hook       ║
║       = "LIVE STATE" block (§ 6.6)                              ║
║       = JOURNAL-derived: current step, progress, blocker,       ║
║         turn count, next step, reminders                        ║
║       ≈ 100-150 tokens                                          ║
║                                                                 ║
║  [messages]   ← this is where LCM operates                      ║
║    ┌─────────────────────────────────────────────────────────┐  ║
║    │ (on compaction, OpenClaw's ContextEngine produces       │  ║
║    │  { summary, firstKeptEntryId } and rewrites messages:)  │  ║
║    │                                                          │  ║
║    │  [LCM summary]                                           │  ║
║    │     assistant-role message containing the lossless      │  ║
║    │     compression of older turns. Inserted in-place       │  ║
║    │     where dropped messages were.                         │  ║
║    │                                                          │  ║
║    │  [kept messages from firstKeptEntryId onward]            │  ║
║    │     verbatim recent history (the "hot tail")             │  ║
║    │                                                          │  ║
║    │  [current user/tool-result message]                      │  ║
║    └─────────────────────────────────────────────────────────┘  ║
║                                                                 ║
╚═════════════════════════════════════════════════════════════════╝
```

**Placement summary (the answer to "where does our stuff go?"):**
1. **DIRECTIVES content** → inside the cached system prompt, above everything.
2. **JOURNAL LIVE STATE** → between the cache boundary and the messages array. Above the LCM summary, above the kept tail.
3. **LCM output** → inside the `messages` array. We never touch it; it never touches us.

### 13.2 Interaction with LCM (the Lossless Context Engine)

OpenClaw's compaction pipeline delegates to whichever `ContextEngine` plugin is registered (the "lossless-context-engine" plugin is the default in 2026). The engine's `maintain()` is called during both turn-level maintenance and full compaction. On compaction, it returns `{ summary, firstKeptEntryId }` and the runtime rewrites the transcript: messages up to `firstKeptEntryId` are replaced by a single `assistant`-role message containing `summary`; messages from `firstKeptEntryId` onward are kept verbatim. The system prompt is never touched by LCM.

**Hook ordering relative to LCM:**

```
  turn N:  before_prompt_build hook fires
           ├─ reads JOURNAL.md
           └─ injects LIVE STATE as prependSystemContext

  ...agent turn executes...

  (overflow or preemptive trigger)
  → before_compaction hook fires
           ├─ reads JOURNAL.md (pre-LCM snapshot)
           └─ emits AGENT:PRE_COMPRESSION_SNAPSHOT

  → ContextEngine.maintain() runs
           ├─ produces { summary, firstKeptEntryId }
           └─ runtime rewrites messages array

  → after_compaction hook fires
           └─ emits AGENT:COMPRESSION_EVENT with metrics

  turn N+1:  before_prompt_build hook fires again
             ├─ re-reads JOURNAL.md (unchanged from turn N — disk is durable)
             └─ re-injects LIVE STATE (identical text if no writes since)
```

**Why DIRECTIVES + JOURNAL strictly complement LCM:**

- **LCM preserves conversational content losslessly.** Tool calls, tool results, reasoning traces, decisions — the stuff LCM is genuinely useful for.
- **We preserve the agent's *state* orthogonally.** The contract (DIRECTIVES) is above the messages array entirely — LCM can never drop, rewrite, or misinterpret it. The live tracker (JOURNAL) is re-read from disk every turn, so it cannot be compressed away either.
- **LCM's job gets easier, not harder, because of our system.** The agent no longer needs to "remember from conversation" which step it's on, which DoD are open, which sub-agents have reported in. LCM can compress older tool results and reasoning aggressively without risking operational state loss, because operational state is not in the messages array.
- **The LCM summary never needs to mention the agent's goal, DoD, or current step.** Those are in the cached system prompt and the uncached live-state block respectively. This shrinks the summary LCM has to produce and lowers the chance LCM paraphrases something critical incorrectly.

**Consequence for the plugin:** our extension does not register any `context-engine` maintenance callback, and does not read or write `summary` / `firstKeptEntryId`. LCM is a peer system. We coexist by design via file-based state — exactly the same way we coexist with compression events. If someone swaps the ContextEngine plugin for a different implementation, our system is unaffected.

### 13.3 When things change

| Thing | Changes when | Cache impact |
|-------|--------------|--------------|
| Tools list | Agent session restart | Cache rewrite at next turn (one-time). |
| Base system prompt | OpenClaw upgrade | Cache rewrite on first affected turn. |
| DIRECTIVES content (in `extraSystemPrompt`) | **Never, for the life of this agent.** Parent can only replace by spawning a new session with a new DIRECTIVES. | 0 cache invalidations during an agent's run. |
| Prompt cache TTL lapse | 1h of idle | Silent rewrite on next turn. Cheap relative to a bad design: 1.25-2× on ONE turn, then 0.1× forever. |
| JOURNAL-derived LIVE STATE | Every agent write (every step, every progress update) | **Zero impact on the cache** — sits after the boundary. Only recosts the ~150-token suffix. |

### 13.4 Why the split matters

The naive design puts everything in one file and hopes the cache still hits. It doesn't — because any mutation to the contract (goal, DoD, step list) would force a cache rebuild. With DIRECTIVES in the cache and JOURNAL outside it, mutations to the tracker never invalidate the cache. The agent can update its progress a thousand times without paying a cache-write cost on the contract.

Concretely for a 1000-token DIRECTIVES + 150-token LIVE STATE + 20k-token tools/system, over a 100-turn session:
- **Without split (all in one mutable file, no cache):** 100 × (20k + 1k + 0.15k) × 1.0 = 2,115,000 input tokens.
- **With split:** 1 × (20k + 1k) × 1.25 + 99 × (20k + 1k) × 0.1 + 100 × 0.15k × 1.0 = 26,250 + 207,900 + 15,000 = **249,150 input tokens**.

~8.5× cheaper, and the longer the session the better the ratio.

### 13.5 Multiple cache breakpoints

Anthropic caps explicit `cache_control` breakpoints at 4 per request. We use **exactly one**: after the system prompt (which now includes `extraSystemPrompt`). Do not add more without a compelling reason — a second breakpoint after the first few messages is tempting but usually not worth it for agent sessions, because the messages don't stabilize the same way.

### 13.6 Required TTL config

```jsonc
{
  "agents": {
    "defaults": {
      "prompt_cache": {
        "system_ttl": "1h",     // critical: default is 5m since 2026-03-06
        "tools_ttl":  "1h"
      }
    }
  }
}
```

Long-horizon agents idle between turns (waiting for a verifier to run, for a sub-agent to finish). A 5-minute TTL means every ~6-minute gap pays a cache rebuild. The 1h TTL costs 2× on writes (vs 1.25×) but the overall economics are massively better for our workload. Verify at runtime via the existing `prompt-cache-observability` harness (`pi-embedded-runner/prompt-cache-observability.test.ts`). Target: ≥90% cache hit rate on system tokens across a 100+ turn session.

### 13.7 What NOT to put in the LIVE STATE injection

- **Per-turn timestamps.** They change every turn. (`last_updated` is fine — it only changes when the agent writes JOURNAL.)
- **Request IDs / trace IDs.** Not the agent's concern.
- **Sub-agent lists if they mutate constantly.** Summarize: "3 children, 2 DONE, 1 IN_PROGRESS" is fine; one line per child with status is fine; a dozen lines of rapidly-changing child state is not.
- **Tool output snippets.** That's what the message history is for.

### 13.8 What NOT to put in the CONTRACT (DIRECTIVES)

- **Anything the parent expects to update mid-flight.** If you need to update it, it belongs in JOURNAL, not DIRECTIVES. If JOURNAL isn't the right home, the parent needs to respawn the agent with a new DIRECTIVES — that's the formal "update contract" path.
- **Data derived from other agents' runs.** Those are services; reference them via SERVICES.md.
- **Time-sensitive deadlines past TTL.** If a deadline is soft, put it in the PROTOCOL; if it's hard, it becomes a DoD criterion (`shell_exit_zero` on a clock check) or a budget.

---

## 14. Files Created at Runtime

```
{project-root}/
  PLAN.md                              ← project plan; REPLAN-gated edits
  SERVICES.md                          ← service registry index
  services/
    db-schema.md
    redis-session.md
    auth.md
    ...                                ← one per sealed service
  DIRECTIVES.md                        ← main agent's contract (chmod 0444)
  JOURNAL.md                           ← main agent's live tracker (agent-owned)
  .directives-lock.json                ← SHA + size + ts of DIRECTIVES.md
  .agent-events.jsonl                  ← global observer log
  project-plan/
    stage-01-scaffold.md
    stage-02-database.md
    stage-03-auth.md                   ← ACTIVE
    stage-03-auth/
      sub-a-d7e9/                      ← sub-agent workspace dir
        DIRECTIVES.md                  ← immutable, chmod 0444
        JOURNAL.md                     ← mutable, agent-owned
        .directives-lock.json
        SERVICES.md                    ← symlink to top-level registry
        .agent-events.jsonl -> ../../../.agent-events.jsonl   (symlink, shared)
      sub-b-f1a2/
        DIRECTIVES.md
        JOURNAL.md
        .directives-lock.json
        SERVICES.md
        .agent-events.jsonl -> ../../../.agent-events.jsonl
    stage-04-api.md                    ← PENDING (editable)
```

**Key properties:**
- `DIRECTIVES.md` is `chmod 0444` immediately after spawn-time write. File-system-enforced read-only. Tamper attempts (e.g., `chmod` by the agent) are caught by the SHA check in `.directives-lock.json` and logged.
- `JOURNAL.md` is `chmod 0644`. The agent writes it via atomic tmp-rename (§ 10.3).
- `.agent-events.jsonl` is a symlink in each sub-agent workspace pointing at the shared top-level file. Appends from any agent land in the same jsonl; `tail -f | jq` at the top level sees everything. POSIX `O_APPEND` makes single-line writes atomic up to PIPE_BUF (≥512 bytes); cap `PRE_COMPRESSION_SNAPSHOT` payloads at 400 bytes to stay under.
- `SERVICES.md` is readable to every agent (symlink into sub-agent workspaces). Writes go through the parent at seal time — children never append directly.

---

## 15. Implementation Roadmap

### Phase 1 — Foundation (plugin skeleton; DIRECTIVES/JOURNAL split; cache-aware injection)

**Tasks:**
- Scaffold `extensions/directive-persistence/` with TypeScript + vitest.
- `schema.ts`: zod schemas for DIRECTIVES (immutable), JOURNAL (mutable), PLAN, stage, SERVICES, event log entries. Separate schemas per file — no shared "zone" enum.
- `directives/parse.ts`: typed parser for DIRECTIVES.md. Throws `DirectivesParseError` with line/column on malformed.
- `directives/journal.ts`: typed parser + atomic writer for JOURNAL.md.
- `directives/tamper.ts`: SHA-based integrity check against `.directives-lock.json`. Emits `AGENT:DIRECTIVES_TAMPER_ATTEMPT`.
- `directives/inject.ts`: `buildLiveStateInjection(journal)` — produces the exact ~150-token block in § 6.6. Byte-stable template with only JOURNAL-derived fields changing.
- `spawn/write-directives.ts`: atomic write → `chmod 0444` → record SHA/size/ts to `.directives-lock.json`. Also builds `extraSystemPrompt` payload from DIRECTIVES content for the parent to pass to `sessions_spawn`.
- `events/log.ts`: `O_APPEND | O_CREAT` writer with per-line fsync and ≤400B snapshot cap.
- Hook registration (`index.ts`): `before_prompt_build` (no-op when JOURNAL absent; reads JOURNAL + SHA-checks DIRECTIVES), `before_compaction` (JOURNAL snapshot), `after_compaction` (`COMPRESSION_EVENT`).
- Unit tests: DIRECTIVES parse round-trip; JOURNAL parse/write round-trip; atomic write crash recovery (kill mid-write → prior file intact); tamper detector (flip one byte → SHA mismatch → event emitted); `chmod 0444` is honored by the write helper (refuses second write).
- Integration: load plugin into local OpenClaw; run two sessions — one with DIRECTIVES+JOURNAL, one without. Confirm:
  - Non-directive session: zero behavior change.
  - Directive session: DIRECTIVES content appears in the cached system prompt (verify via `prompt-cache-observability`), LIVE STATE injection appears after the cache boundary every turn, cache hit rate stays ≥90% across a 20-turn scripted run.

**Ship gate:** all Phase 1 tests pass locally; no regression in `prompt-cache-observability.test.ts` or `run.overflow-compaction.*` tests; a measured 20-turn run shows ≥90% system-token cache hit rate.

### Phase 2 — Verifier Runner + JOURNAL write protocol

- `verify/runner.ts` + one file per verifier type. Each verifier has unit tests with fixture setup/teardown.
- `directives/journal.ts` integration: `markStepDone` helper refuses the write unless the runner's most recent run for that step returned `allPass`. No verifier run ever = no DONE allowed.
- `AGENT:VERIFIER_RUN`, `AGENT:STEP_COMPLETE`, `AGENT:BLOCKED`, `AGENT:BUDGET_WARNING`, `AGENT:JOURNAL_WRITE` events plumbed.
- Document the agent write protocol in AGENTS.md / SOUL.md so the agent knows the rules at a glance (the rules are also in DIRECTIVES.md PROTOCOL, but AGENTS.md is where OpenClaw surfaces them at session start).
- End-to-end test: a single-agent session with a three-step DIRECTIVES. Scripted failures on step 2 of `shell_exit_zero` (tsc error) — confirm:
  - Agent receives the failure in LIVE STATE next turn.
  - Agent stays on step 2, writes failure to JOURNAL WORKING NOTES.
  - After 3 failures, `AGENT:STUCK_WARNING` emits and the agent reports BLOCKED.

### Phase 3 — PLAN + stage + SERVICES layer

- `plan/plan.ts`, `plan/stage.ts`, `services/registry.ts`.
- `plan/seal.ts`: stage sealing orchestration (runs DoD, publishes service cards, updates PLAN.md registry, atomic).
- `AGENT:STAGE_ACTIVATED`, `AGENT:STAGE_SEALED`, `AGENT:PLAN_BOOTSTRAPPED` events.
- Tests:
  - 3-stage plan; agent advances 1→2→3 with seal gates.
  - REPLAN protocol: PENDING editable, ACTIVE rejected, SEALED rejected.
  - Service registry lookup: a second agent that would duplicate an existing service gets redirected by the pre-spawn reuse check.

### Phase 4 — Sub-agent recursion

- `spawn/write-child-directives.ts`: pre-spawn atomic write + schema validation.
- `spawn/parse-task-complete.ts`: strict parser for TASK_COMPLETE / TASK_BLOCKED reply format.
- Parent-side re-verification: parent runs DoD independently on child claims.
- `AGENT:SUBAGENT_SPAWNED` emitted; child's COMPRESSION_EVENTs appear in global jsonl via symlink.
- Tests:
  - main → 2 parallel sub-agents → seal stage.
  - main → sub → sub-sub (recursion depth 2), each with own COMPRESSION_EVENTs.
  - Child reports TASK_COMPLETE with a false claim (DoD actually fails) → parent rejects and re-prompts.

### Phase 5 — Observability, supervision, and verifier libraries

- `watch-agent-events.sh` (shipped in repo).
- Stuck-detector daemon: implements § 12.1 heuristics, writes STUCK_WARNING back to jsonl.
- Summary command: `bin/agent-report` — per-agent compression count, step histogram, cost, budget status.
- `after_turn` hook: the DONE-revert validator from § 10.3b; integration tests confirming echo-DONE bypass is caught and reverted.
- **Verifier library (`extensions/directive-persistence/src/verify/libraries/`):** pre-built DoD templates for common task shapes. Ships with:
  - `swe-bench.ts` — diff applies cleanly, target tests pass, no new failures in neighbor tests
  - `mle-bench.ts` — submission file matches schema, submission-script exits zero, leaderboard metric above threshold
  - `hcast-swe.ts` — task-specific DoD patterns pulled from HCAST's software tier
  - `hcast-general.ts` — `llm_judge` rubrics for HCAST's general-reasoning tier
  - `research-writeup.ts` — `llm_judge` rubric for structured reports (intro, evidence, conclusion, citations)
  - `refactor.ts` — tests still pass, behavioral diff empty under property-based fuzzing
  Each template is a typed function `buildDoD(taskSpec) → Verifier[]` callable by the main agent at decomposition time. Reduces rubric-authoring burden for benchmark adapters.
- Dashboard plan (optional): Grafana/Loki pointed at `.agent-events.jsonl` via promtail. Not required; `jq` suffices for now.

### Phase 6 — Hardening and HCAST benchmark gate

- Load test: 20 parallel sub-agents appending to the shared jsonl. Confirm no interleaved partial lines.
- Crash test: kill the agent process mid-JOURNAL-write; confirm rename-atomicity keeps the prior file intact. Kill mid-verifier-run; confirm `verifierPasses` rehydrates correctly from `.plugin-state/verifier-passes.jsonl`.
- Long-run test: 72-hour autonomous loop on a synthetic multi-stage project. Target: zero manual intervention; verifier enforcement prevents any false-positive seals; main JOURNAL size stays bounded (<10KB).
- Prompt-cache observability: confirm ≥90% cache hit on system tokens across 100+ compactions per agent.
- Write-authority test: automated red-team script attempts every known bypass (direct bash echo, fs.writeFile, chmod games, forged AGENT:VERIFIER_RUN events). Confirm post-turn validator reverts all of them.
- **HCAST benchmark gate** (see § 17): must meet target thresholds on HCAST 2h and 4h tiers before shipping 1.0.

---

## 16. Open Questions (most prior questions resolved via code inspection)

1. **Cross-agent write collision on `.agent-events.jsonl`.** POSIX `O_APPEND` guarantees atomicity up to PIPE_BUF (≥512 on Linux). A single JSON event line is typically ~300B but can exceed PIPE_BUF for large events (`PRE_COMPRESSION_SNAPSHOT` with a long progress string). **Mitigation:** cap the `snapshot` field size at 400 bytes; use the `session_file` pointer for anything larger.

2. **Service card generation from sealed outputs.** Who writes `services/<name>.md`? Two options: (a) the sub-agent writes it as part of its OUTPUT CONTRACT; (b) the parent writes it at seal time. **Decision:** parent writes, because the parent is the one that verifies; sub-agent's claim about its own interface can't be trusted for the registry. Sub-agent proposes via a `service_card:` block in its TASK_COMPLETE; parent reviews and commits.

3. **Parent re-verification cost.** Parent running `runAllDoD` on every child completion doubles verifier runtime. For cheap checks (file_exists, grep) this is fine; for `test_passes` on a full suite it's wasteful. **Decision:** parent re-runs only the verifiers whose outcomes can't be cryptographically established from git state (i.e., skip `file_exists` / `grep` re-runs if the file's git SHA matches the child's report; always re-run `shell_exit_zero` / `http_status` / `test_passes`).

4. **REPLAN mid-ACTIVE stage.** Currently option B (abort children, mark ABANDONED) is clean but wasteful. Option A (wait for natural completion) is cheaper but slow. **Decision pending:** default to Option B but allow a `replan_mode: "wait"` flag in REPLAN for non-urgent replans.

5. **Sub-sub-agent service registry.** Does a sub-sub-agent see the full `SERVICES.md` or only services relevant to its ancestors' scope? **Leaning:** full registry is fine — reading is safe, writing is parent-mediated. DRY prevention benefits from wide visibility.

---

## 17. Benchmarks & Validation (HCAST 4h+ as the north star)

The system's central claim — *agents stay coherent through N compactions and deliver verified-complete work on long-horizon tasks* — maps cleanly onto one public benchmark: **HCAST**. METR publishes the time-horizon curve, other systems' numbers are comparable, and the 2h+ tiers are where naive agents collapse specifically due to the failure modes this design targets. HCAST is the north star.

### 17.1 Ship gates per phase

| Phase | Benchmark requirement to ship |
|-------|-------------------------------|
| 1 — Foundation | Synthetic 5-stage smoke project completes end-to-end. ≥90% cache hit rate. |
| 2 — Verifier runner | Synthetic: all 12 verifier types exercised; `journal.write_done` preconditions enforced; `AGENT:JOURNAL_DONE_REVERTED` fires on bash-echo bypass. |
| 3 — PLAN + SERVICES | Synthetic 10-stage project with 2 sub-agent DRY-collisions; SERVICES.md pre-flight catches both; 0 duplicated implementations. |
| 4 — Sub-agent recursion | Synthetic 3-stage project with parallel sub-agents; progressive-granularity retry demonstrated on an intentionally-too-coarse sub-task. |
| 5 — Observability + verifier libraries | SWE-Bench Verified lite run (50 issues): measurable reduction in false-positive "done" claims vs. a baseline agent with same model. Verifier library templates exercised. |
| 6 — Hardening + HCAST gate | See § 17.2. |
| 1.0 release | HCAST thresholds met; TheAgentCompany ≥ baseline + 15pp absolute improvement. |

### 17.2 HCAST target thresholds

HCAST is tiered by human-equivalent time. We target progressive tiers:

| HCAST tier | Baseline (naive agent, same model) | InfiniClaw 1.0 target | Stretch |
|------------|------------------------------------|-----------------------|---------|
| <10 min   | ~70-80% | match baseline (±3pp) — don't regress on short tasks | match |
| 10 min – 1h | ~50-60% | match baseline | +5pp |
| 1h – 2h | ~30-40% | **+5-10pp** over baseline | +15pp |
| 2h – 4h | ~15-25% | **+15-20pp** over baseline | +30pp |
| 4h – 8h | ~5-15% | **+20-30pp** over baseline | +40pp |
| 8h+ | ~0-5% | **measurable** completion where baseline is ~0 | +15pp |

The magnitude of claimed wins scales with time horizon — precisely because that's where our mechanisms structurally matter. If we don't beat baseline on the 2h+ tiers, the design isn't doing what it claims.

### 17.3 Secondary benchmarks

- **TheAgentCompany.** Multi-stage + shared resources. Best-of-field ~30% (2024). Target: ≥45% for 1.0. Directly tests main-agent orchestration and SERVICES.md DRY prevention.
- **SWE-Bench Verified / Pro.** Primarily a variance-reduction test for us: same peak as baseline, much tighter variance across runs, driven by the verifier gate preventing false-positive "done."
- **MLE-bench.** Depends on quality of the `mle-bench.ts` verifier library. Target for 1.0: top-quartile on 10 representative competitions.

### 17.4 Internal synthetic benchmark (mechanism attribution)

Before public benchmarks, validate mechanism-by-mechanism on a controlled synthetic. Spec: **50-stage minimal REST framework** (auth, DB, routing, tests, docs, deploy) with file-level Output Contracts and typed DoD. Run InfiniClaw once in-distribution; measure:

| Metric | Target | Measures |
|--------|--------|----------|
| Stages sealed | 50/50 | End-to-end viability |
| DONE DONE accuracy (children passing main re-verif) | ≥98% | Verifier gate works |
| Mean compactions per sealed stage | bounded (not superlinear in project length) | Main agent resilience |
| Cache hit rate, system tokens | ≥90% across 1000+ turns | DIRECTIVES/JOURNAL split works |
| Main JOURNAL size at stage 50 | <10 KB | Seal-and-archive works |
| DRY violations | 0 | SERVICES.md pre-flight works |
| Parent re-prompt rate | <10% of TASK_COMPLETE calls | Children self-verify honestly |
| Mean turns between STUCK_WARNING | >200 | Sustained progress |
| `AGENT:JOURNAL_DONE_REVERTED` events (planted-bypass test) | reverts caught, progress resumes | Write-authority works |

Then **ablate and re-run** to attribute each metric to its mechanism:

- Turn off the `after_turn` revert validator → DONE DONE accuracy drops.
- Turn off SERVICES.md pre-flight → DRY violations appear.
- Turn off seal-and-archive → main JOURNAL grows unboundedly.
- Turn off progressive-granularity retry → parent re-prompt rate spikes.
- Turn off cache (use `ttl: "5m"` default) → cache hit rate collapses under idle gaps.

Each ablation should cleanly attribute one metric delta to one mechanism. If ablating X doesn't move metric Y, Y isn't being driven by X and the design claim for that piece is wrong.

### 17.5 Publication plan

- v0.5 internal milestone: all synthetic bench metrics at target; ablations show clean attribution.
- v0.9 pre-release: SWE-Bench Verified run with published variance comparison vs. naive baseline.
- v1.0 release: HCAST full run with published per-tier deltas vs. baseline; TheAgentCompany published number. METR's time-horizon curve includes InfiniClaw as a data point.
- Stretch: submit as a data point to the next iteration of [A Hitchhiker's Guide to Agent Evaluation](https://iclr-blogposts.github.io/2026/blog/2026/agent-evaluation/).

---

## 18. The Invariant (unchanged, sharpened)

No matter what happens — context compression, model swap, session timeout, VM reboot, VM image upgrade — when the agent resumes:

1. `before_prompt_build` fires.
2. It reads `DIRECTIVES.md` from disk (atomic read; no torn bytes).
3. It injects: goal, current step, DoD, output contract, constraints, turn budget, protocol.
4. The agent knows exactly where it is, what to do next, and how it will be checked.

The agent never knows it was compressed. It doesn't need to. It wakes, reads its directives, consults `SERVICES.md`, and continues from exactly where the task stack says it is. `DIRECTIVES.md` is the agent's memory. Everything in the context window is ephemeral.

Meanwhile, the observer log gives Logan a complete external view: which agents ran, when they compressed, whether they advanced or got stuck, what they produced, what they reused, what they spent. Two audiences, two files, zero overlap.

The context window is ephemeral. The files are permanent. Compression is a recoverable non-event. Premature DONE is structurally impossible because the verifier runner is the only path to the DONE state. DRY is structurally discouraged because `SERVICES.md` is the mandatory first read.

**The agent runs until every DoD is verified PASS. No early stopping. No skipping because it's hard. No planning for weeks. No rebuilding what already exists. Just micro-tasks, black-box contracts, and a file that tells the agent exactly what to do next, every single turn, forever.**

That is the point of this entire system.
