import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  CLEANUP_ORDER,
  CLEANUP_PRESETS,
  buildCleanupFilter,
  estimateCleanupSeconds,
  getCleanupPreset,
} from './cleanup.js';

describe('cleanup presets', () => {
  it('expose every id declared in CLEANUP_ORDER', () => {
    for (const id of CLEANUP_ORDER) {
      assert.ok(CLEANUP_PRESETS[id], `missing preset for id ${id}`);
      assert.equal(CLEANUP_PRESETS[id].id, id);
    }
  });

  it('falls back to the "none" preset for unknown ids', () => {
    const preset = getCleanupPreset('does-not-exist');
    assert.equal(preset.id, 'none');
    assert.deepEqual(preset.filters, []);
  });

  it('builds a comma-joined filter chain', () => {
    const chain = buildCleanupFilter('lecture');
    assert.ok(chain.includes('highpass=f=100'));
    assert.ok(chain.includes('dynaudnorm'));
    assert.ok(chain.includes('silenceremove'));
  });

  it('uses dynaudnorm in the default lecture preset to stay fast', () => {
    const { filters } = CLEANUP_PRESETS.lecture;
    assert.ok(filters.some((filter) => filter.startsWith('dynaudnorm')));
    assert.ok(
      !filters.some((filter) => filter.startsWith('loudnorm')),
      'lecture preset should not use the slow EBU R128 loudnorm filter',
    );
    assert.ok(
      !filters.some((filter) => filter.startsWith('afftdn')),
      'lecture preset should not use the slow FFT denoiser',
    );
  });

  it('keeps an opt-in deep-clean preset with the heavier filters', () => {
    const { filters } = CLEANUP_PRESETS.deep;
    assert.ok(filters.some((filter) => filter.startsWith('afftdn')));
    assert.ok(filters.some((filter) => filter.startsWith('loudnorm')));
  });

  it('returns 0 from estimateCleanupSeconds when preset is "none"', () => {
    assert.equal(estimateCleanupSeconds('none', 600), 0);
  });

  it('returns 0 from estimateCleanupSeconds when duration is missing', () => {
    assert.equal(estimateCleanupSeconds('lecture', 0), 0);
    assert.equal(estimateCleanupSeconds('lecture'), 0);
  });

  it('estimates a positive amount of seconds for the lecture preset', () => {
    const estimate = estimateCleanupSeconds('lecture', 600);
    assert.ok(estimate > 0, 'estimate should be positive');
    assert.ok(estimate < 600, 'lecture preset must stay faster than realtime');
  });

  it('estimates the deep preset as slower than the lecture preset', () => {
    const lectureEstimate = estimateCleanupSeconds('lecture', 600);
    const deepEstimate = estimateCleanupSeconds('deep', 600);
    assert.ok(
      deepEstimate > lectureEstimate,
      'deep cleanup should be slower than the lecture preset',
    );
  });
});
