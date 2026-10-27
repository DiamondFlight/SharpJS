import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GetSWV } from '../src/calc/skewtCalcs.js';

const sounding = {
  P: [1000, 950, 900],
  Slice: [
    [1000, 0, 20, 10, 270, 10, 0, 0],
    [950, 500, 15, 5, 315, 14.1421356237, 0, 0],
    [900, 1000, 10, 0, 0, 20, 0, 0],
  ],
};

test('GetSWV integrates streamwise and crosswise components in both coordinate types', () => {
  const expectedSWV = (100 / Math.sqrt(125)) * 0.514444444;
  const expectedCWV = (50 / Math.sqrt(125)) * 0.514444444;
  const heightLayer = GetSWV(sounding, 0, 500, 'Hght', { x: 0, y: 0 });
  const pressureLayer = GetSWV(sounding, 1000, 950, 'Pres', { x: 0, y: 0 });

  for (const result of [heightLayer, pressureLayer]) {
    assert.ok(Math.abs(result.SWV - expectedSWV) < 1e-8);
    assert.ok(Math.abs(result.CWV - expectedCWV) < 1e-8);
    assert.ok(Math.abs(result.SWPercent - 89.4427191) < 1e-6);
  }
});

test('GetSWV preserves the signed midpoint streamwise contribution', () => {
  const reverseShearSounding = {
    P: [1000, 950, 900],
    Slice: [
      [1000, 0, 20, 10, 315, 14.1421356237, 0, 0],
      [950, 500, 15, 5, 270, 10, 0, 0],
      [900, 1000, 10, 0, 0, 20, 0, 0],
    ],
  };
  for (const skip of [false, true]) {
    const result = GetSWV(reverseShearSounding, 0, 500, 'Hght', { x: 0, y: 0 }, skip);

    assert.ok(result.SWV < 0);
    assert.ok(result.CWV < 0);
  }
});

test('GetSWV returns NaN values when the upper bound is outside the sounding', () => {
  const result = GetSWV(sounding, 0, 1100, 'Hght', { x: 0, y: 0 });

  assert.ok(Number.isNaN(result.SWV));
  assert.ok(Number.isNaN(result.CWV));
  assert.ok(Number.isNaN(result.SWPercent));
});