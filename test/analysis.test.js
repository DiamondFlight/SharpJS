import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSounding, analyze, levelAt, fromArrays } from '../src/core.js';
import { sample } from './helpers.js';

// Reference values are what the SharpJS chart draws for the same sounding
// (pixel-compared against the previous SharpJS 1.61 chart).
const oun = parseSounding(sample('koun-1999-05-04-00z.txt'));

test('parcels', () => {
  const a = analyze(oun);
  assert.equal(a.parcels.SB.cape, 2848);
  assert.equal(a.parcels.SB.cin, -41);
  assert.equal(a.parcels.SB.lcl, 410);
  assert.equal(a.parcels.SB.lfc, 2017);
  assert.equal(a.parcels.SB.el, 10504);
  assert.equal(a.parcels.ML.cape, 2554);
  assert.equal(a.parcels.ML.lcl, 810);
  assert.equal(a.parcels.MU.startPressure, 959);
  assert.equal(a.downdraft.dcape, 743);
});

test('storm motions and kinematics (Bunkers right)', () => {
  const a = analyze(oun);
  assert.deepEqual(a.stormMotion.RM, { direction: 233, speed: 27.6 });
  assert.deepEqual(a.stormMotion.used, a.stormMotion.RM);
  assert.equal(Math.round(a.stormMotion.LM.speed), 48);
  const l = a.kinematics.layers;
  assert.deepEqual([l['0-500m'].srh, l['0-1km'].srh, l['0-3km'].srh, l['0-6km'].srh], [192, 270, 332, 371]);
  assert.deepEqual(l['0-1km'].bulkShear, { direction: 219, speed: 25.5 });
  assert.deepEqual(l['0-1km'].stormRelativeWind, { direction: 117, speed: 22.6 });
  assert.equal(l['0-1km'].ehi, 4.8);
  assert.equal(Math.round(l['0-6km'].bulkShear.speed), 46);
  const eff = a.effectiveInflow;
  assert.equal(eff.srh, 293);
  assert.equal(eff.topHeightAgl, 1456);
  assert.deepEqual(eff.bulkShear, { direction: 234, speed: 27.8 });
  assert.equal(eff.ehi, 5.2);
});

test('composite indices', () => {
  const i = analyze(oun).indices;
  assert.equal(i.stpFixed, 4);
  assert.equal(i.stpEffective, 2.9);
  assert.equal(i.scp, 15.3);
  assert.equal(i.ship, 2.7);
  assert.equal(i.pwat, 1.03);
  assert.equal(i.rhDgzMean, 72);
});

test('storm motion choice changes SRH', () => {
  const lm = analyze(oun, { motion: 'LM' });
  assert.equal(lm.kinematics.layers['0-1km'].srh, 115);
  const custom = analyze(oun, { motion: { direction: 240, speed: 30 } });
  assert.deepEqual(custom.stormMotion.used, { direction: 240, speed: 30 });
  assert.equal(custom.kinematics.layers['0-1km'].srh, 297);
});

test('custom parcel', () => {
  const a = analyze(oun, { parcel: 'CU', parcelPressure: 850 });
  assert.equal(a.parcels.CU.startPressure, 850);
});

test('accepts text and arrays directly', () => {
  assert.equal(analyze(sample('koun-1999-05-04-00z.txt')).parcels.SB.cape, 2848);
  const a = analyze(fromArrays({
    pressure: [1000, 925, 850, 700, 500, 300, 200],
    temperature: [30, 24, 18, 8, -10, -38, -55],
    dewpoint: [22, 19, 14, 0, -25, -50, -70],
    windDirection: [150, 180, 210, 240, 250, 260, 260],
    windSpeed: [10, 30, 35, 40, 55, 75, 80],
  }));
  assert.ok(a.parcels.SB.cape > 2000);
  assert.ok(a.kinematics.layers['0-1km'].srh > 50);
});

test('levelAt', () => {
  assert.deepEqual(levelAt(oun, { pressure: 500 }).pressure, 500);
  const l = levelAt(oun, { height: 1000 });
  assert.equal(l.height, 1362);
});
