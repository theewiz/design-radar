/**
 * Phase 5 Run Status Tests.
 *
 * The pipeline previously printed "Phase 5 pipeline is operational" on every
 * run, including runs where Gemini classified nothing and every later stage was
 * skipped. These tests pin the status that is reported instead, so a broken
 * dependency cannot be presented as a healthy run.
 *
 * Covers:
 * - OPERATIONAL only when the pipeline actually executed end to end
 * - FAILED when classification produced nothing for infrastructure reasons
 * - PARTIAL when a stage was skipped or some candidates failed
 * - A run with no matching posts is a successful run, not a failure
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { derivePipelineStatus } from '../src/index.js';

/**
 * Builds the inputs derivePipelineStatus reads, with successful defaults.
 *
 * @param {object} [overrides]
 * @returns {object}
 */
function runState(overrides = {}) {
  return {
    dbReady: true,
    passedCount: 3,
    classificationSkipped: null,
    classificationResult: { succeeded: 3, failed: 0, failureReasons: {}, infrastructureFailure: false },
    scoringResult: { scored: 3, qualified: 1, irrelevant: 2, stale: 0, lowConfidence: 0, gateFailures: 0 },
    persistenceResult: { created: 3, skipped: 0, errors: 0 },
    ...overrides,
  };
}

describe('Phase 5 run status', () => {
  it('reports OPERATIONAL when every stage executed', () => {
    const status = derivePipelineStatus(runState());

    assert.equal(status.status, 'OPERATIONAL');
    assert.match(status.reason, /scored/);
  });

  it('reports FAILED when Gemini classified nothing', () => {
    const status = derivePipelineStatus(
      runState({
        classificationResult: {
          succeeded: 0,
          failed: 3,
          failureReasons: { quota_exhausted: 3 },
          infrastructureFailure: true,
        },
        scoringResult: { scored: 0, qualified: 0, irrelevant: 0, stale: 0, lowConfidence: 0, gateFailures: 0 },
        persistenceResult: { created: 0, skipped: 0, errors: 0 },
      })
    );

    assert.equal(status.status, 'FAILED');
    assert.match(status.reason, /Gemini classification produced 0 classifications/);
    assert.match(status.reason, /quota_exhausted/);
  });

  it('reports FAILED when every candidate failed an infrastructure error', () => {
    const status = derivePipelineStatus(
      runState({
        classificationResult: {
          succeeded: 0,
          failed: 3,
          failureReasons: { authentication_failed: 3 },
          infrastructureFailure: true,
        },
        scoringResult: { scored: 0, qualified: 0, irrelevant: 0, stale: 0, lowConfidence: 0, gateFailures: 0 },
        persistenceResult: { created: 0, skipped: 0, errors: 0 },
      })
    );

    assert.equal(status.status, 'FAILED');
    assert.match(status.reason, /authentication_failed/);
  });

  it('reports FAILED when the model is misconfigured', () => {
    const status = derivePipelineStatus(
      runState({
        classificationResult: {
          succeeded: 0,
          failed: 1,
          failureReasons: { model_unavailable: 1 },
          infrastructureFailure: true,
        },
        scoringResult: { scored: 0, qualified: 0, irrelevant: 0, stale: 0, lowConfidence: 0, gateFailures: 0 },
        persistenceResult: { created: 0, skipped: 0, errors: 0 },
      })
    );

    assert.equal(status.status, 'FAILED');
    assert.match(status.reason, /model_unavailable/);
  });

  it('reports PARTIAL when only some candidates were classified', () => {
    const status = derivePipelineStatus(
      runState({
        classificationResult: {
          succeeded: 2,
          failed: 1,
          failureReasons: { blocked: 1 },
          infrastructureFailure: false,
        },
        scoringResult: { scored: 2, qualified: 1, irrelevant: 1, stale: 0, lowConfidence: 0, gateFailures: 0 },
      })
    );

    assert.equal(status.status, 'PARTIAL');
    assert.match(status.reason, /2 classified, 1 failed/);
  });

  it('reports PARTIAL when the API key is missing', () => {
    const status = derivePipelineStatus(
      runState({
        classificationSkipped: 'GEMINI_API_KEY not configured',
        scoringResult: { scored: 0, qualified: 0, irrelevant: 0, stale: 0, lowConfidence: 0, gateFailures: 0 },
        persistenceResult: { created: 0, skipped: 0, errors: 0 },
      })
    );

    assert.equal(status.status, 'PARTIAL');
    assert.match(status.reason, /GEMINI_API_KEY/);
  });

  it('reports PARTIAL when the database is not configured', () => {
    const status = derivePipelineStatus(
      runState({
        dbReady: false,
        scoringResult: { scored: 3, qualified: 0, irrelevant: 3, stale: 0, lowConfidence: 0, gateFailures: 0 },
        persistenceResult: { created: 0, skipped: 0, errors: 0 },
      })
    );

    assert.equal(status.status, 'PARTIAL');
    assert.match(status.reason, /Database not configured/);
  });

  it('reports PARTIAL when persistence reported errors', () => {
    const status = derivePipelineStatus(
      runState({ persistenceResult: { created: 2, skipped: 0, errors: 1 } })
    );

    assert.equal(status.status, 'PARTIAL');
    assert.match(status.reason, /1 persistence errors/);
  });

  it('reports OPERATIONAL when nothing matched, because the pipeline worked', () => {
    const status = derivePipelineStatus(
      runState({
        passedCount: 0,
        classificationSkipped: 'no candidates to classify',
        classificationResult: { succeeded: 0, failed: 0, failureReasons: {}, infrastructureFailure: false },
        scoringResult: { scored: 0, qualified: 0, irrelevant: 0, stale: 0, lowConfidence: 0, gateFailures: 0 },
        persistenceResult: { created: 0, skipped: 0, errors: 0 },
      })
    );

    assert.equal(status.status, 'OPERATIONAL');
    assert.match(status.reason, /nothing to classify/);
  });

  it('never reports OPERATIONAL when classification ran and produced nothing', () => {
    const status = derivePipelineStatus(
      runState({
        classificationResult: {
          succeeded: 0,
          failed: 2,
          failureReasons: { malformed_response: 2 },
          infrastructureFailure: false,
        },
        scoringResult: { scored: 0, qualified: 0, irrelevant: 0, stale: 0, lowConfidence: 0, gateFailures: 0 },
        persistenceResult: { created: 0, skipped: 0, errors: 0 },
      })
    );

    assert.notEqual(status.status, 'OPERATIONAL');
  });
});