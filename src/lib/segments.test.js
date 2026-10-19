import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDownloadName,
  buildPlan,
  buildVirtualSegmentName,
  cutsFromEqualPlan,
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

// Regressione tablet: «Taglia qui» mentre si è in "Parti uguali" deve
// CONSERVARE i tagli uguali già presenti. Prima li scartava e si tornava
// sempre a 2 parti, rendendo impossibile dividere in più di 2 parti
// partendo dai preset (il gesto più naturale col dito).
test('cutsFromEqualPlan preserves equal cuts when adding a cut beyond 2 parts', () => {
  let seq = 0;
  const createId = () => `cut-${(seq += 1)}`;
  const equal = buildPlan({ duration: 3600, mode: 'equal', equalParts: 3, customCuts: [] });
  assert.deepEqual(equal.cutPoints, [1200, 2400]);

  const base = cutsFromEqualPlan(equal.cutPoints, createId);
  assert.deepEqual(base.map((cut) => cut.position), [1200, 2400]);
  assert.equal(base[0].value, '20:00');
  assert.ok(base.every((cut) => typeof cut.id === 'string' && cut.id.length > 0));

  const next = [...base, { id: createId(), value: '10:00', position: 600 }]
    .sort((a, b) => a.position - b.position);
  const plan = buildPlan({ duration: 3600, mode: 'custom', equalParts: 3, customCuts: next });
  assert.equal(plan.error, '');
  assert.equal(plan.segments.length, 4);
  assert.deepEqual(plan.cutPoints, [600, 1200, 2400]);
});

test('cutsFromEqualPlan ignores invalid points and sorts ascending', () => {
  const cuts = cutsFromEqualPlan([90, Number.NaN, 30, -5, Infinity], () => 'id');
  assert.deepEqual(cuts.map((cut) => cut.position), [30, 90]);
  assert.deepEqual(cutsFromEqualPlan([], () => 'id'), []);
  assert.deepEqual(cutsFromEqualPlan(undefined, () => 'id'), []);
});
