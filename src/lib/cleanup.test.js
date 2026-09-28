import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  CLEANUP_ORDER,
  CLEANUP_PRESETS,
  SHORTEN_PAUSES_FILTER,
  buildCleanupFilter,
  buildCleanupOutputArgs,
  cleanupChangesTimeline,
  estimateCleanupSeconds,
  getCleanupPreset,
} from './cleanup.js';

describe('cleanup presets', () => {
  it('expose every id declared in CLEANUP_ORDER', () => {
    for (const id of CLEANUP_ORDER) {
      assert.ok(CLEANUP_PRESETS[id], `missing preset for id ${id}`);
      assert.equal(CLEANUP_PRESETS[id].id, id);
      assert.ok(CLEANUP_PRESETS[id].filters.length > 0, id);
    }
  });

  it('falls back to the "none" preset for unknown ids', () => {
    const preset = getCleanupPreset('does-not-exist');
    assert.equal(preset.id, 'none');
    assert.deepEqual(preset.filters, []);
    assert.equal(buildCleanupFilter('does-not-exist'), '');
  });

  it('voice presets follow the measured professional order', () => {
    const chain = buildCleanupFilter('lecture');
    const order = [
      'aformat=channel_layouts=mono',
      'highpass',
      'dynaudnorm=f=500', // livellatore lento: normalizza il livello PRIMA delle soglie
      'afftdn',
      'equalizer',
      'deesser',
      'dynaudnorm=f=250', // livellatore veloce con soglia
      'agate',
      'acompressor',
      'alimiter',
      'volume',
    ];
    let last = -1;
    for (const step of order) {
      const index = chain.indexOf(step, last + 1);
      assert.ok(index > last, `${step} fuori ordine in ${chain}`);
      last = index;
    }
  });

  it('fast leveler has a threshold so long pauses are never pumped up', () => {
    for (const id of CLEANUP_ORDER) {
      const fast = buildCleanupFilter(id).split(',').find((filter) => filter.startsWith('dynaudnorm=f=250'));
      assert.ok(fast && /:t=0\.\d+/.test(fast), `${id}: ${fast}`);
    }
  });

  it('never uses loudnorm: 5x slower in wasm because it resamples to 192 kHz', () => {
    for (const id of CLEANUP_ORDER) {
      assert.ok(!buildCleanupFilter(id).includes('loudnorm'), id);
    }
  });

  it('only shortens pauses on request, as the last step', () => {
    for (const id of CLEANUP_ORDER) {
      assert.ok(!buildCleanupFilter(id).includes('silenceremove'), id);
    }
    const shortened = buildCleanupFilter('lecture', { shortenPauses: true });
    assert.ok(shortened.endsWith(SHORTEN_PAUSES_FILTER));
    assert.equal(cleanupChangesTimeline({ shortenPauses: true }), true);
    assert.equal(cleanupChangesTimeline({ shortenPauses: false }), false);
    assert.equal(cleanupChangesTimeline(), false);
  });

  it('encodes voice presets in mono and keeps stereo presets stereo', () => {
    const mono = buildCleanupOutputArgs('lecture');
    assert.equal(mono[mono.indexOf('-ac') + 1], '1');
    assert.equal(mono[mono.indexOf('-aac_coder') + 1], 'fast');
    assert.ok(mono.includes('+faststart'));
    const stereo = buildCleanupOutputArgs('podcast');
    assert.ok(!stereo.includes('-ac'));
    assert.equal(stereo[stereo.indexOf('-b:a') + 1], '160k');
  });

  it('returns 0 from estimateCleanupSeconds when preset is "none" or duration missing', () => {
    assert.equal(estimateCleanupSeconds('none', 600), 0);
    assert.equal(estimateCleanupSeconds('lecture', 0), 0);
    assert.equal(estimateCleanupSeconds('lecture'), 0);
  });

  it('estimates faster on desktop than mobile and prefers measured speed', () => {
    const desktop = estimateCleanupSeconds('lecture', 3600);
    const mobile = estimateCleanupSeconds('lecture', 3600, { mobile: true });
    assert.ok(desktop > 0 && desktop < mobile);
    assert.equal(estimateCleanupSeconds('lecture', 3600, { measuredSpeed: 60 }), 60);
    assert.ok(estimateCleanupSeconds('volume', 3600) < estimateCleanupSeconds('podcast', 3600));
  });
});
