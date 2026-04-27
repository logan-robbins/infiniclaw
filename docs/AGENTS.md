# AGENTS.md — Complete Reference for AI Agents Working Under the Persistent Directive System

> Read this document once. After that, trust your files, not your context window.

---

## 1. What This System Is (One Paragraph)

You are operating under the **Persistent Directive System** — a plugin that keeps long-horizon work from failing. Without it, agents lose their place on context compression, silently mark half-done steps as done, and rebuild what a sibling already built. This system externalizes all state to disk, re-injects it every turn, enforces verified-done via a process-heap authority the agent cannot reach, and maintains a global inventory every agent consults before writing a single new file. You are expected to run indefinitely. Compression is a non-event. "Done" means every criterion in your Definition of Done passed a typed verifier. There is no other meaning of done.

---

## 2. The Four Failure Modes This System Prevents

```
┌─────────────────────────────────────────────────────────────────────┐
│ FAILURE MODE          │ WHAT HAPPENS WITHOUT THIS SYSTEM            │
├───────────────────────┼─────────────────────────────────────────────┤
│ Amnesia               │ Compaction produces lossy summaries.        │
│                       │ Agent loses "which step am I on" and        │
│                       │ re-derives work from narrative.             │
├───────────────────────┼─────────────────────────────────────────────┤
│ Silent early-stop     │ "Kinda done" step gets marked done.         │
│                       │ Downstream builds on cracked foundation.    │
│                       │ Error compounds silently until integration. │
├───────────────────────┼─────────────────────────────────────────────┤
│ Over-planning         │ Agent spends a week refining the plan       │
│                       │ instead of producing artifacts.             │
├───────────────────────┼─────────────────────────────────────────────┤
│ DRY violations        │ Parallel sub-agents each rebuild the same  │
│                       │ utility because each sees only its own      │
│                       │ DIRECTIVES.md.                              │
└─────────────────────────────────────────────────────────────────────┘
```

**The root cause of all four:** disk does not compress. Files survive reboots, image upgrades, and context windows. This system makes disk the agent's memory and the context window disposable.

---

## 3. System Overview

```
                    ┌──────────────────────────────────────────────────────┐
                    │  PROJECT ROOT WORKSPACE                               │
                    │                                                        │
                    │  PLAN.md                  ← project stages + DoD      │
                    │  project-plan/            ← one file per stage        │
                    │  INVENTORY.md             ← sealed outputs index      │
                    │  inventory/*.md           ← service cards             │
                    │  .agent-events.jsonl      ← observer log (shared)     │
                    │                                                        │
                    │  DIRECTIVES.md  ←── MAIN AGENT (write-once contract)  │
                    │  JOURNAL.md     ←── MAIN AGENT (mutable tracker)      │
                    │                                                        │
                    │  sub-a/                                                │
                    │    DIRECTIVES.md  ←── SUB-AGENT A (write-once)        │
                    │    JOURNAL.md     ←── SUB-AGENT A (mutable)           │
                    │    INVENTORY.md   ←── symlink → ../../INVENTORY.md    │
                    │    .agent-events.jsonl ← symlink → ../../.agent-...   │
                    │                                                        │
                    │  sub-a/sub-aa/                                         │
                    │    DIRECTIVES.md  ←── SUB-SUB-AGENT (write-once)      │
                    │    JOURNAL.md     ←── SUB-SUB-AGENT (mutable)         │
                    │    .agent-events.jsonl ← symlink → ../../../.agent-.. │
                    └──────────────────────────────────────────────────────┘
```

Every agent — main, sub, sub-sub — runs the **same system**. Every agent has exactly one DIRECTIVES.md (write-once contract) and one JOURNAL.md (the only file it writes). The `.agent-events.jsonl` symlink chain means all events from all depths land in one root file.

---

## 4. The Five Artifacts

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ARTIFACT       │ OWNER   │ MUTABLE? │ PURPOSE                            │
├────────────────┼─────────┼──────────┼────────────────────────────────────┤
│ PLAN.md        │ main    │ REPLAN   │ Project stages, dependencies,       │
│ + stage files  │         │ only     │ global DoD, budget                 │
├────────────────┼─────────┼──────────┼────────────────────────────────────┤
│ DIRECTIVES.md  │ parent  │ NEVER    │ Agent contract: goal, I/O,         │
│ (per agent)    │ writes  │          │ DoD, constraints, turn budget,      │
│                │ once    │          │ decomposition, protocol            │
├────────────────┼─────────┼──────────┼────────────────────────────────────┤
│ JOURNAL.md     │ agent   │ YES      │ Live tracker: task stack,          │
│ (per agent)    │ owns    │ (atomic) │ progress, blockers, working notes  │
├────────────────┼─────────┼──────────┼────────────────────────────────────┤
│ INVENTORY.md   │ parent  │ append   │ Sealed outputs index. Every agent  │
│ + inventory/   │ seals   │ on seal  │ reads before writing anything new  │
├────────────────┼─────────┼──────────┼────────────────────────────────────┤
│ .agent-events  │ plugin  │ append   │ Observer log. Agent never reads.   │
│ .jsonl         │         │ only     │ Supervisor / scripts consume it    │
└──────────────────────────────────────────────────────────────────────────┘
```

**The load-bearing split:** DIRECTIVES lives in the cached system prompt (written once, never re-injected). JOURNAL lives after the cache boundary (re-read every turn, injected as `prependSystemContext`). These two files have exactly one job each. This split is why compression is a non-event.

---

## 5. Prompt Cache Layout (Every Turn)

```
┌────────────────────────────────────────────────────────────────┐
│  SYSTEM PROMPT  ← CACHE BOUNDARY                               │
│  ─────────────────────────────────────────────────────────     │
│  [base system prompt — static]                                 │
│  [tool definitions — static]                                   │
│  [DIRECTIVES.md contents — static, via extraSystemPrompt]      │
│                                                                 │
│  ^^^^  Everything above this line is cached for 1h.  ^^^^      │
│  ────────────────────────────────────────────────────────────  │
│  MESSAGES (not cached; changes every turn)                     │
│  ─────────────────────────────────────────────────────────     │
│  [prependSystemContext — LIVE STATE injected from JOURNAL.md]  │
│    ## LIVE STATE [from JOURNAL.md, re-read every turn]         │
│    CURRENT STEP: step-3 — Implement loginHandler error paths   │
│    PROGRESS:     Wired Redis rate-limit; 401 path done         │
│    BLOCKER:      none                                          │
│    TURNS USED:   12/80   (warn 60, escalate 75)                │
│    NEXT STEP:    step-4 — Implement logoutHandler              │
│                                                                 │
│  [LCM summary — if compaction happened]                        │
│  [conversation turns]                                          │
│  [current user/tool-result turn]                               │
└────────────────────────────────────────────────────────────────┘
```

**Critical invariant:** Adding a new turn NEVER invalidates the cached system prefix. DIRECTIVES.md is byte-stable for the agent's lifetime. All dynamic state (JOURNAL-derived live status, LCM summary, conversation) injects after the boundary. Cache hits are structural, not coincidental. **Never inject dynamic content into the system prompt — it breaks the cache.**

---

## 6. What You Write — What You Don't

```
┌──────────────────────────────────────────────────────────────────┐
│ FILE              │ YOU WRITE? │ NOTES                            │
├───────────────────┼────────────┼──────────────────────────────────┤
│ JOURNAL.md        │ YES        │ Only mutable file you own.       │
│                   │            │ Atomic writes only.              │
├───────────────────┼────────────┼──────────────────────────────────┤
│ DIRECTIVES.md     │ NO         │ Written once by your parent.     │
│                   │            │ Your PROTOCOL forbids edits.     │
│                   │            │ If you think it's wrong, report  │
│                   │            │ BLOCKED: contract-dispute.       │
├───────────────────┼────────────┼──────────────────────────────────┤
│ Output files      │ YES        │ Only paths in your OUTPUT        │
│ (your contract)   │            │ CONTRACT. Nothing else.          │
├───────────────────┼────────────┼──────────────────────────────────┤
│ INVENTORY.md      │ NO         │ Your parent appends at seal.     │
│                   │            │ You READ before writing anything.│
├───────────────────┼────────────┼──────────────────────────────────┤
│ PLAN.md /         │ NO         │ Main-agent-only, REPLAN-gated.   │
│ stage files       │            │                                  │
├───────────────────┼────────────┼──────────────────────────────────┤
│ .agent-events     │ NO         │ Plugin writes; you never read.   │
│ .jsonl            │            │                                  │
├───────────────────┼────────────┼──────────────────────────────────┤
│ Child DIRECTIVES  │ YES        │ Only if you spawn sub-agents.    │
│                   │            │ Atomic write; write-once.        │
└──────────────────────────────────────────────────────────────────┘
```

---

## 7. Step Lifecycle

```
                         ┌─────────┐
                         │ PENDING │  ← step created in INITIAL DECOMPOSITION
                         └────┬────┘
                              │ agent picks this step
                              ▼
                       ┌─────────────┐
                ┌─────▶│ IN_PROGRESS │◀─────────────────────────────┐
                │      └──────┬──────┘                               │
                │             │ agent works on step                  │
                │             │ calls verifier.run(step_id)          │
                │             ▼                                       │
                │       ┌──────────┐  any criterion FAIL             │
                │       │ verifier │─────────────────────────────────┘
                │       │  runner  │  write failure to WORKING NOTES
                │       └────┬─────┘
                │            │ ALL criteria PASS
                │            │ verifierPasses map updated in plugin heap
                │            ▼
                │       ┌──────────┐
                │       │ agent    │  agent writes status: DONE in JOURNAL.md
                │       │ writes   │
                │       │ DONE     │
                │       └────┬─────┘
                │            │
                │            ▼  (end of turn)
                │    ┌──────────────────┐
                │    │  after_turn hook │
                │    │  (plugin, §10.3b)│
                │    └────┬──────┬──────┘
                │         │      │
                │    pass  │      │  fail (no verifier this turn,
                │  check   │      │  stale pass, or DoD hash drift)
                │         │      ▼
                │         │  ┌───────────────────────────┐
                │         │  │ revert DONE → IN_PROGRESS │
                │         │  │ emit JOURNAL_DONE_REVERTED │
                │         │  │ queue nudge for next turn  │───────────┐
                │         │  └───────────────────────────┘           │
                │         │                                           │
                │         ▼                                           │
                │    ┌──────┐                                         │
                └────│ DONE │ ← only reachable with verified pass     │
                     └──────┘                                         │
                                                                      │
                          BLOCKED ◀──────────── agent files blocker ──┘
                          (if genuinely stuck; parent intervenes)
```

**The key rule:** `status: DONE` written without a same-turn `verifierPasses` entry is automatically reverted at end-of-turn. This happens in the plugin's JavaScript heap — no bash trick, `fs.writeFile`, or `chmod` can bypass it. Authority is process memory the agent cannot reach.

---

## 8. Definition of Done — Writing Verifiable Criteria

Every DoD criterion must be machine-checkable. If you cannot write the check as a single command or single-file probe, the criterion is not a criterion — split the step.

### 8.1 Available Verifier Types

```
┌─────────────────────┬───────────────────────────────────────────────────┐
│ type                │ what it checks                                    │
├─────────────────────┼───────────────────────────────────────────────────┤
│ file_exists         │ path exists on disk                               │
│ file_absent         │ path does NOT exist                               │
│ shell_exit_zero     │ command exits 0 (stdout/stderr in evidence)       │
│ shell_exit_nonzero  │ command exits nonzero (intentional failure check) │
│ http_status         │ HTTP request returns expected status + body       │
│ grep_present        │ regex found in file (regex flags optional)        │
│ grep_absent         │ regex NOT found in file                           │
│ test_passes         │ test command exits 0 (same as shell_exit_zero     │
│                     │ but semantically explicit)                        │
│ json_schema_match   │ file or cmd output matches JSON Schema            │
│ fs_size_under       │ file < max_bytes                                  │
│ llm_judge           │ LLM scores output against rubric ≥ min_score      │
│ all_of              │ every sub-criterion passes (composite)            │
│ any_of              │ at least one sub-criterion passes (composite)     │
└─────────────────────┴───────────────────────────────────────────────────┘
```

### 8.2 Good vs Bad Criteria

```
BAD  (cannot be verified mechanically):
  "The auth module is well-implemented"
  "Login works correctly"
  "No obvious security issues"

GOOD (typed verifiers):
  { type: "file_exists",    path: "src/routes/auth.ts" }
  { type: "shell_exit_zero", cmd: "npx tsc --noEmit" }
  { type: "grep_absent",    path: "src/routes/auth.ts",
    pattern: "TODO|FIXME|password\\s*=\\s*[\"']" }
  { type: "http_status",    url: "http://localhost:3000/auth/login",
    method: "POST", status: 200 }
  { type: "llm_judge",      rubric: "score 1-10: correctness, completeness, clarity",
    inputs: [{path: "report.md"}], min_score: 7 }
```

### 8.3 When to use `llm_judge`

Use `llm_judge` for fuzzy success criteria: research writeups, code review quality, interface clarity, architectural coherence. **Do not** use it as a shortcut to avoid writing mechanical checks — use it only when mechanical checks cannot capture the criterion. The rubric must specify the scoring dimensions and the passing threshold.

### 8.4 Step Decomposition Bar

Split a step if ANY of:
- DoD cannot be expressed as a single command / single file check
- Expected to take > 15 turns (hard ceiling: 30)
- Produces more than one primary artifact
- Depends on more than two inputs from other stages
- Requires holding > ~5K tokens of external context simultaneously

---

## 9. JOURNAL.md — How to Use It

JOURNAL.md is re-read every turn and a summary is injected as `prependSystemContext` before your conversation turn. **Trust what JOURNAL says about your current step.** It is the ground truth; your memory of previous turns is not.

### 9.1 Sections

```markdown
# JOURNAL
schema_version: 1
agent: sub:auth-a:d7e9
last_updated: 2026-04-16T03:58:04Z
turns_used: 12
last_verifier_run: 2026-04-16T03:57:58Z

## TASK STACK
#### step-1: [title]
status: DONE | IN_PROGRESS | PENDING | BLOCKED
started: <iso>          ← when you moved to IN_PROGRESS
completed: <iso>        ← when you verified DONE
verifier_run_id: vr-xx  ← from the verifier tool's response
verified_outputs:       ← what you confirmed exists
  - ...
progress: "..."         ← ≤3 lines; what you've done this turn
blocker: null | "..."   ← non-null triggers AGENT:BLOCKED event
turns_in_step: 4        ← auto-bumped by write layer
last_verifier_failures: []

## WORKING NOTES
# Scratch only. Safe to clear when step reaches DONE.

## SUB-AGENTS
# If you spawned children, track them here.
# - id: sub:x  goal: ...  status: IN_PROGRESS | DONE | BLOCKED

## COMPLETION REPORT
# Write exactly once, at TASK_COMPLETE. Empty until then.
```

### 9.2 What you may write to JOURNAL.md

| Field | When | Notes |
|-------|------|-------|
| step `IN_PROGRESS` | on step start | also bumps `turns_in_step` |
| step `progress` | any time | ≤3 lines |
| step `blocker` | when stuck | non-null triggers `AGENT:BLOCKED` |
| step `DONE` | **only after** `verifier.run → allPass` | write layer enforces; `after_turn` hook reverts violations |
| step subdivision | any time | may add sub-steps; may NOT drop a step from INITIAL DECOMPOSITION |
| WORKING NOTES | any time | cleared on step DONE |
| SUB-AGENTS | on spawn/completion | |
| COMPLETION REPORT | once, at TASK_COMPLETE | |
| `turns_used`, `last_updated` | every write | bumped automatically |

### 9.3 What you may NOT write to JOURNAL.md

- Backdating `completed` timestamps
- Setting `status: DONE` without running the verifier in the same turn
- Removing a step from the task stack
- Writing anything that contradicts your DIRECTIVES

---

## 10. DIRECTIVES.md — Your Contract

```markdown
# DIRECTIVES (immutable for this agent's lifetime)
schema_version: 1
agent: <your-id>              # e.g. "sub:auth-a:d7e9" or "main"
parent: <parent-id>           # null for the main agent
workspace: /path/to/workspace
spawned: <iso timestamp>
journal: ./JOURNAL.md

## GOAL
<one or two paragraphs — what you are being asked to produce>

## INPUT CONTRACT
# Exact paths. Read only these. Nothing else.
- service: inventory/db-schema.md
- path: src/config/auth.ts

## OUTPUT CONTRACT
# Exact paths. Write only these (plus JOURNAL.md).
- kind: file
  path: src/routes/auth.ts
  exports: ["authRouter"]
  interface: "express.Router mounting POST /auth/login, /auth/logout"

## DEFINITION OF DONE
# Typed verifiers. Each must pass before you may claim DONE.
- type: file_exists
  path: src/routes/auth.ts
- type: shell_exit_zero
  cmd: "npx tsc --noEmit"

## CONSTRAINTS
# Hard rules. Violating one is a BLOCKED: contract-dispute event.

## TURN BUDGET
max_turns: 80
warning_at: 60
escalate_at: 75

## INITIAL DECOMPOSITION
# Your step plan. You may subdivide; you may not drop a step.
- step-1: ...
- step-2: ...

## PROTOCOL
# How you operate. Read once; live by it.
```

**You may not modify this file.** If you believe a field is wrong, write `blocker: "contract-dispute: ..."` in JOURNAL.md and wait for parent guidance. Only your parent can amend your DIRECTIVES, and only by aborting and respawning you with a new contract.

---

## 11. Before You Create Any New File — The INVENTORY Check

```
You are about to create a new module / file / service?

           ┌─────────────────────────────────────┐
           │  1. Read INVENTORY.md               │
           │  2. grep for your intent            │
           │     e.g. "auth", "JWT", "redis",    │
           │          "rate limit", "session"    │
           └────────────┬─────────────┬──────────┘
                        │             │
              MATCH FOUND             NO MATCH
                        │             │
                        ▼             ▼
             ┌─────────────────┐   ┌───────────────────────────┐
             │ Consume it as   │   │ Implement it. When sealed, │
             │ a BLACK BOX.    │   │ your parent will append    │
             │ Read only its   │   │ the entry to INVENTORY.md  │
             │ inventory/*.md  │   │ and write inventory/<name> │
             │ card. Do NOT    │   │ .md with your I/O contract.│
             │ read its source.│   └───────────────────────────┘
             └─────────────────┘
```

**DRY is a verification failure**, not a best-effort convention. If you build something that already exists in INVENTORY, the parent's re-verification will catch it. Do the check first.

---

## 12. Sub-Agent Spawning (Parent-Side Protocol)

If you are the main agent or an orchestrating sub-agent, you spawn children using this sequence:

```
1. Read INVENTORY.md — run the reuse check for each sub-task (§ 11).
   Skip or reuse any task a sealed service already covers.

2. For each surviving sub-task:
   a. mkdir -p /workspace/<child-id>
   b. Write INVENTORY.md symlink into child workspace (read-only view)
   c. Write DIRECTIVES.md atomically into child workspace (write-once)
   d. Verify file_exists + schema validates — refuse to spawn if not
   e. Call sessions_spawn with:
        workspaceDir: /workspace/<child-id>
        attachments:  [DIRECTIVES.md]
   f. Update JOURNAL.md SUB-AGENTS section with child status
   g. Emit AGENT:SUBAGENT_SPAWNED (plugin does this via spawnChildDirectives)

3. Monitor: next turn, check child reply for TASK_COMPLETE or TASK_BLOCKED.
```

### 12.1 Child Workspace Layout

```
/workspace/sub:auth-a:d7e9/
  DIRECTIVES.md          ← write-once; child's contract
  JOURNAL.md             ← child writes this; parent reads on completion
  INVENTORY.md           ← symlink → ../../INVENTORY.md  (read-only)
  .agent-events.jsonl    ← symlink → ../../.agent-events.jsonl
  <output files>         ← only paths from child's OUTPUT CONTRACT
```

### 12.2 Child Isolation Rules

A child agent may:
- Read its own `DIRECTIVES.md`, `JOURNAL.md`, `INVENTORY.md`
- Read files listed in its INPUT CONTRACT
- Write files listed in its OUTPUT CONTRACT
- Write its own `JOURNAL.md`
- Spawn its own sub-sub-agents (recursively, same system)

A child agent may NOT:
- Read the parent's `DIRECTIVES.md`, `JOURNAL.md`, `PLAN.md`, or stage files
- Read sibling workspaces
- Append to `INVENTORY.md` (parent does this at seal time)
- Call `sessions_spawn` on siblings

---

## 13. TASK_COMPLETE and TASK_BLOCKED Reports

### 13.1 TASK_COMPLETE (child → parent, via plugin tool)

The child calls `report_task_complete` **only after every DoD criterion has passed verification**.

```typescript
{
  outputs: [
    {
      kind: "file" | "service" | "artifact",
      path: "src/routes/auth.ts",
      sha256: "<64-char hex>",        // must match on-disk file
      interface_summary: "..."        // ≤200 chars
    }
  ],
  dod_evidence: [
    {
      criterion_index: 0,             // maps to DIRECTIVES.definitionOfDone[0]
      verifier_run_id: "vr-xxx",      // from verifier.run() response
      result: "PASS"
    }
  ],
  service_card_proposal: "..."        // markdown for inventory/<name>.md;
                                      // parent reviews and commits
                                      // null if no service output
}
```

**Preconditions enforced by plugin before the tool call completes:**
1. Every DoD criterion has a `dod_evidence` entry
2. Every `verifier_run_id` exists in the plugin's `verifierPasses` map with `allPass: true`
3. Every output's `sha256` matches the on-disk file
4. Agent is not already in `DONE` state (no double-submits)

If any check fails: tool call errors with a specific reason. The agent must fix and retry. The parent is never burdened with an invalid completion report.

### 13.2 TASK_BLOCKED (child → parent, via plugin tool)

Call `report_task_blocked` when genuinely blocked — NOT when the task is just hard.

```typescript
{
  classification: "contract-dispute"      // your DIRECTIVES has a wrong field
               | "input-missing"          // a promised input doesn't exist
               | "infra-issue"            // env is broken (out of your control)
               | "implementation-hard",   // you've tried everything; need help
  step_id: "step-3",
  summary: "...",                         // ≤200 chars
  detail: "...",                          // what you tried, why truly blocked
  proposed_remediation: "..."             // what the parent could do to unblock
                                          // required unless "infra-issue"
}
```

### 13.3 Parent Re-verification Protocol

**The parent never trusts a child's TASK_COMPLETE claim.** Always re-verify:

```
1. Parse the TASK_COMPLETE report (plugin enforces schema).
2. For each claimed output: re-run the child's DoD independently.
   - Read child's DIRECTIVES.md to get definitionOfDone.
   - Call reVerifyChildClaim({ childDirectivesPath, ctx }).
3. If any verifier FAILS:
   - Mark child as IN_PROGRESS (not DONE).
   - Reply with exactly which criterion failed and verifier evidence.
   - Never auto-mark DONE on child's claim.
4. If all PASS:
   - Mark child DONE in your JOURNAL.md SUB-AGENTS section.
   - Author inventory/<name>.md from child's service_card_proposal.
   - Append to INVENTORY.md.
   - Proceed to next sub-task or seal the stage.
```

---

## 14. Turn Budget Enforcement

```
turns_used < warning_at    → normal operation
turns_used ≥ warning_at    → AGENT:BUDGET_WARNING emitted to event log
                             no agent-facing change
turns_used ≥ escalate_at   → agent MUST emit TASK_BLOCKED with
                             classification: "implementation-hard" and
                             reason: "budget_escalation". Parent decides:
                             extend budget, decompose further, or abandon.
```

**Budget is not a suggestion.** If you reach `escalate_at` without completing, report BLOCKED immediately. Do not try to squeeze in one more step. The parent can extend the budget; the parent cannot undo a broken deliverable shipped at turn 78/75.

---

## 15. What Happens on Context Compression

```
    Turn N:  JOURNAL.md shows step-3 IN_PROGRESS.
    Turn N+k: [COMPRESSION HAPPENS]
    Turn N+k+1: You wake up.

    What you see:
    - prependSystemContext: ## LIVE STATE from JOURNAL.md (re-read from disk)
      CURRENT STEP: step-3 — Implement loginHandler error paths
      PROGRESS:     Wired Redis rate-limit; 401 path done; adding 429 path.
      BLOCKER:      none
      TURNS USED:   12/80

    What this means:
    - You are on step-3. This is ground truth.
    - Your working notes are in JOURNAL.md ## WORKING NOTES.
    - DIRECTIVES.md is in your system prompt (cached; unchanged).
    - Everything you need is in your files.
    - The compression event does not exist from your perspective.
    - Continue from where JOURNAL.md says you are.
```

Compression is invisible to you. You will not observe it. The summary injected by the LCM after compression is supplementary context — your files are the ground truth. When context tells you one thing and JOURNAL.md tells you another, trust JOURNAL.md.

---

## 16. Event Log Reference (Observer Only — You Never Read This)

The plugin appends structured JSON events to `.agent-events.jsonl`. You do not read this file. Your supervisor and monitoring scripts do. For completeness:

```jsonl
{"event":"AGENT:SUBAGENT_SPAWNED","agent":"main","child":"sub:auth-a:d7e9"}
{"event":"AGENT:STEP_COMPLETE","agent":"sub:auth-a:d7e9","step":"step-2"}
{"event":"AGENT:VERIFIER_RUN","agent":"sub:auth-a:d7e9","step":"step-3","all_pass":false,
  "failures":[{"type":"shell_exit_zero","detail":"tsc error TS2345"}]}
{"event":"AGENT:PRE_COMPRESSION_SNAPSHOT","agent":"sub:auth-a:d7e9","msgs_before":450}
{"event":"AGENT:COMPRESSION_EVENT","agent":"sub:auth-a:d7e9","msgs_before":450,"msgs_after":64}
{"event":"AGENT:BLOCKED","agent":"sub:auth-a:d7e9","step":"step-3","reason":"dod-dispute"}
{"event":"AGENT:STUCK_WARNING","agent":"sub:auth-a:d7e9","heuristic":"3+ compressions at same step"}
{"event":"AGENT:BUDGET_WARNING","agent":"sub:auth-a:d7e9","turns_used":61,"turn_budget":80}
{"event":"AGENT:BUDGET_EXCEEDED","agent":"sub:auth-a:d7e9","turns_used":80}
{"event":"AGENT:JOURNAL_DONE_REVERTED","agent":"sub:auth-a:d7e9","step":"step-3",
  "reason":"no-verifier-run"}
{"event":"AGENT:TASK_COMPLETE","agent":"sub:auth-a:d7e9","outputs":["src/routes/auth.ts"]}
{"event":"AGENT:STAGE_SEALED","agent":"main","stage":"stage-03-auth"}
{"event":"AGENT:REPLAN","agent":"main","affected_stages":["stage-04","stage-05"]}
```

---

## 17. Common Situations — Decision Reference

### "I finished a step. What do I do?"

```
1. Call verifier.run("step-N") with the step's DoD.
2. Review results:
   - All PASS → write status: DONE in JOURNAL.md with verifier_run_id.
               The after_turn hook will confirm the pass and leave DONE intact.
   - Any FAIL → keep status: IN_PROGRESS.
               Write specific failure to WORKING NOTES.
               Try to fix it. Call verifier.run again on the next turn.
               After 3 identical failures: report BLOCKED.
```

### "I need a utility that might already exist."

```
1. Read INVENTORY.md.
2. grep for keywords related to your need.
3. If found: read inventory/<name>.md for the interface. Use it. Stop.
4. If not found: implement it. Your parent will register it on seal.
```

### "I think my DIRECTIVES.md has a wrong criterion."

```
1. Do NOT modify DIRECTIVES.md.
2. Write in JOURNAL.md:
     blocker: "contract-dispute: DEFINITION OF DONE criterion 2 specifies
               path 'src/utils/auth.ts' but my OUTPUT CONTRACT specifies
               'src/routes/auth.ts' — these are inconsistent."
3. Call report_task_blocked with classification: "contract-dispute".
4. Stop. Your parent will respawn you with a corrected DIRECTIVES.md.
```

### "I got a SYSTEM NOTICE about a reverted DONE."

```
This means: at the end of the previous turn, the plugin detected that
you wrote status: DONE without a valid same-turn verifier pass.
The DONE was reverted automatically.

You must:
1. Call verifier.run("step-N") for the step named in the notice.
2. Wait for allPass: true.
3. Only then write status: DONE.

DO NOT write DONE again without calling verifier.run first.
```

### "I've been working on this step for many turns and the verifier keeps failing."

```
After 3 consecutive failures with the same failure signature:
1. The plugin emits AGENT:STUCK_WARNING to the observer log.
2. You should:
   a. Write the exact failure to WORKING NOTES.
   b. Check if the step is too large (§ 8 decomposition bar).
      If so: subdivide the step in JOURNAL.md and work the sub-steps.
   c. Check if a DoD criterion is wrong (contract-dispute).
      If so: report BLOCKED.
   d. If none of the above: report BLOCKED with classification
      "implementation-hard" and detail of what you tried.
DO NOT thrash. DO NOT auto-advance. DO NOT weaken the criterion.
```

### "I am the main agent. A child reported TASK_COMPLETE."

```
1. Parse the report (plugin enforces schema).
2. Call reVerifyChildClaim with the child's DIRECTIVES.md.
3. If all PASS:
   - Mark child DONE in your JOURNAL.md SUB-AGENTS.
   - Author inventory/<name>.md from service_card_proposal.
   - Append to INVENTORY.md.
4. If any FAIL:
   - Do NOT mark child DONE.
   - Reply to child with which criterion failed and the verifier evidence.
   - Child will resume work.
NEVER mark a child DONE on their claim alone.
```

---

## 18. File Schema Quick Reference

### DIRECTIVES.md metadata fields

| Field | Type | Notes |
|-------|------|-------|
| `schema_version` | int | currently 1 |
| `agent` | string | your agent ID |
| `parent` | string \| null | parent agent ID; null for main |
| `workspace` | string | absolute path to your workspace |
| `spawned` | ISO timestamp | when you were spawned |
| `journal` | string | relative path to JOURNAL.md |

### JOURNAL.md metadata fields

| Field | Type | Notes |
|-------|------|-------|
| `schema_version` | int | currently 1 |
| `agent` | string | your agent ID |
| `last_updated` | ISO timestamp | bumped on every write |
| `turns_used` | int | bumped by write layer |
| `last_verifier_run` | ISO timestamp \| null | |
| `max_turns` | int | from DIRECTIVES turn budget |
| `warning_at` | int | turn at which BUDGET_WARNING fires |
| `escalate_at` | int | turn at which you must report BLOCKED |

### Step status values

| Status | Meaning |
|--------|---------|
| `PENDING` | not yet started |
| `IN_PROGRESS` | active; you are working on this |
| `DONE` | verified DONE; all DoD criteria passed |
| `BLOCKED` | cannot proceed; parent intervention required |

### PLAN.md stage status values

| Status | Mutability |
|--------|------------|
| `PENDING` | freely editable |
| `ACTIVE` | frozen mid-flight; no edits |
| `SEALED` | immutable; outputs are in INVENTORY |
| `ABANDONED` | explicit decision; logged |

---

## 19. Plugin SDK Surface (for agents that spawn children)

The plugin exposes these functions to orchestrating agents:

```typescript
// Write a child agent's DIRECTIVES.md and set up the workspace
spawnChildDirectives({
  parentWorkspaceDir: string,
  childId: string,              // e.g. "sub:auth-a:d7e9"
  directivesContent: string,    // full DIRECTIVES.md content
  parentAgent?: string,
  inventorySourcePath?: string  // if provided, symlinks INVENTORY.md
}) → { childWorkspaceDir, directivesPath, extraSystemPrompt }

// Validate a child's TASK_COMPLETE report (pre-spawn check)
validateTaskComplete({
  report: TaskCompleteReport,
  agent: string,
  directivesPath: string,
  workspaceDir: string
}) → void (throws TaskCompleteValidationError on failure)

// Independently re-run a child's DoD (parent-side re-verification)
reVerifyChildClaim({
  childDirectivesPath: string,
  ctx: { workspaceDir: string, agent: string }
}) → { allPass: boolean, failures: ReVerifyFailure[] }
```

### Built-in verifier library templates

Pre-built `buildDoD(spec) → Verifier[]` for common task shapes:

| Template | Use for |
|----------|---------|
| `verify/libraries/swe-bench` | Software engineering: patch applies + tests pass |
| `verify/libraries/mle-bench` | ML submission: schema + script + metric threshold |
| `verify/libraries/hcast-swe` | HCAST software tier: files exist + lint + tests |
| `verify/libraries/hcast-general` | HCAST general: file exists + llm_judge rubric |
| `verify/libraries/research-writeup` | Report: file + word count + llm_judge rubric |
| `verify/libraries/refactor` | Refactor: tests pass + behavioral diff empty |

---

## 20. The 14 Invariants (Non-Negotiable)

Any code or behavior that contradicts one of these is a bug, not a tradeoff.

1. **Disk is memory; context is scratch.** Operational state lives in files. The context window is disposable.
2. **Contract and tracker are separate files.** DIRECTIVES (what you must do) is immutable. JOURNAL (what you are doing) is the only thing you write.
3. **Every turn re-injects live state.** `before_prompt_build` reads JOURNAL and injects a summary. DIRECTIVES is already cached.
4. **Compression is invisible to the agent.** AGENT:COMPRESSION_EVENT is never shown to you. Your worldview is identical before and after.
5. **Every DoD criterion is machine-verifiable.** If you can't write the check as code, it is not a criterion.
6. **Micro-tasks only.** A step that can't be checked with a single command is too large.
7. **Black-box everything sealed.** Once DONE, implementation is invisible. Downstream reads only the output contract.
8. **Inventory before every new file.** No module without first grepping INVENTORY.md.
9. **No early stopping; no skipping.** A failing criterion keeps the step IN_PROGRESS.
10. **Sub-agent scope reduction is absolute.** A sub-agent sees only its own files and its INPUT CONTRACT.
11. **Writes are atomic.** JOURNAL writes use tmp + fsync + rename + directory fsync.
12. **The system prompt is byte-stable for the agent's lifetime.** DIRECTIVES never changes after spawn. Dynamic state injects after the cache boundary.
13. **Infinite-run by default, bounded by budget and DoD.** Stop only when DoD is fully verified PASS, or budget triggers BLOCKED escalation.
14. **Constrain mechanical parts; delegate creative parts to the model.** The system hard-codes WHAT "done" means and HOW state flows. It does NOT hard-code how to decompose, how to reason, or how to write a rubric — those are your job.
