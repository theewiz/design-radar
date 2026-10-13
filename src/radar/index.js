/**
 * Radar Pipeline (Phase 8 orchestrator, Phase 9 scheduling modes).
 *
 * Public surface of the orchestrator. `runRadar()` runs one pipeline — in full,
 * or restricted to discovery or digest delivery by `mode`. The status helpers are
 * the pure rules the run summary reports.
 */

export {
  runRadar,
  derivePipelineStatus,
  deriveDigestRunStatus,
  resolveRunMode,
  RADAR_MODES,
} from './run.js';