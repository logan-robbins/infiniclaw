/**
 * @infiniclaw/directive-persistence
 *
 * OpenClaw plugin implementing the Persistent Directive System.
 * See BUILD.md at the repo root for the full design specification.
 *
 * This file is a Phase 0 stub. Phase 1 (see BUILD.md § 15) fills in:
 *
 *   Hooks
 *   - before_prompt_build  → LIVE STATE injection from JOURNAL
 *   - before_compaction    → pre-LCM JOURNAL snapshot
 *   - after_compaction     → AGENT:COMPRESSION_EVENT
 *   - after_turn           → DONE-revert validator (§ 10.3b)
 *
 *   Tools (plugin-registered)
 *   - verifier.run(step_id)              → runs DoD, populates verifierPasses map
 *   - journal.set_progress({step, note})
 *   - journal.mark_blocked({step, classification, detail})
 *   - journal.write_done({step, outputs})
 *   - report_task_complete({outputs, dod_evidence, service_card_proposal?})
 *   - report_task_blocked({classification, step, summary, detail, proposed_remediation?})
 *
 *   Authority
 *   - verifierPasses: Map<agentId, Map<stepId, PassRecord>>
 *     held in process heap; persisted to .plugin-state/verifier-passes.jsonl
 *     outside any agent's workspaceDir.
 */

export const PLUGIN_NAME = "directive-persistence";
export const PLUGIN_VERSION = "0.0.0";

/**
 * Plugin entry point. OpenClaw calls this at plugin load.
 * Phase 1 implementation registers hooks and tools here.
 */
export function register(): void {
  // Intentionally empty in Phase 0. See BUILD.md § 15 Phase 1.
}
