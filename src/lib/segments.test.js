import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDownloadName,
  buildPlan,
  buildVirtualSegmentName,
  normalizeExtension,
} from './segments.js';

test('normalizeExtension accepts legacy extension values without dots', () => {
  assert.equal(normalizeExtension('m4a'), '.m4a');
  assert.equal(buildDownloadName('lezione', 1, 'm4a'), 'lezione - parte 1.m4a');
  assert.equal(buildVirtualSegmentName('segment', 0, 'M4A'), 'segment-000.m4a');
});

test('buildPlan rejects stale manual positions when the visible value is invalid', () => {
  const plan = buildPlan({
    duration: 120,
    mode: 'custom',
    equalParts: 2,
    customCuts: [{ id: 'cut-1', value: 'non valido', position: 30 }],
  });

  assert.match(plan.error, /non ha un formato valido/);
  assert.equal(plan.segments.length, 0);
});

test('buildPlan rejects segments shorter than the minimum duration', () => {
  const equalPlan = buildPlan({
    duration: 1,
    mode: 'equal',
    equalParts: 12,
    customCuts: [],
  });
  assert.match(equalPlan.error, /almeno 0,25 secondi/);

  const customPlan = buildPlan({
    duration: 20,
    mode: 'custom',
    equalParts: 2,
    customCuts: [
      { id: 'cut-1', value: '10', position: 10 },
      { id: 'cut-2', value: '10.1', position: 10.1 },
    ],
  });
  assert.match(customPlan.error, /almeno 0,25 secondi/);
});

test('buildPlan builds valid equal and custom plans', () => {
  const equal = buildPlan({ duration: 120, mode: 'equal', equalParts: 4, customCuts: [] });
  assert.equal(equal.error, '');
  assert.equal(equal.segments.length, 4);
  assert.deepEqual(equal.cutPoints, [30, 60, 90]);
  assert.equal(equal.segments[3].end, 120);

  const custom = buildPlan({
    duration: 120,
    mode: 'custom',
    equalParts: 2,
    customCuts: [
      { id: 'cut-1', value: '01:00', position: 60 },
      { id: 'cut-2', value: '30', position: 30 },
    ],
  });
  assert.equal(custom.error, '');
  assert.equal(custom.segments.length, 3);
  assert.deepEqual(custom.cutPoints, [30, 60]);
});
