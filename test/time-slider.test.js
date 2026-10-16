import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandBufkitTimeSeries } from '../src/viewer/time-slider.js';

test('BUFKit timeline marks missing forecast hours as disabled positions', () => {
  const soundings = [
    { meta: { forecastHour: 0, valid: '2024-05-26T12:00:00.000Z' } },
    { meta: { forecastHour: 2, valid: '2024-05-26T14:00:00.000Z' } },
  ];
  const timeline = expandBufkitTimeSeries(soundings);
  assert.equal(timeline.length, 3);
  assert.equal(timeline[0].sounding, soundings[0]);
  assert.equal(timeline[1].disabled, true);
  assert.equal(timeline[1].time, Date.parse('2024-05-26T13:00:00.000Z'));
  assert.equal(timeline[2].sounding, soundings[1]);
});
