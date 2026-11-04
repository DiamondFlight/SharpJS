import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSounding } from '../src/core.js';
import { computeThermo, computeWindParams } from '../src/calc/params.js';
import { DrawInsetParams, UpdateCSMotStorm } from '../src/calc/skewtCalcs.js';
import { sample } from './helpers.js';

function renderInset(units, wind) {
  const entries = [];
  const context = {
    fillRect() {},
    fillText(text) {
      entries.push({ text: String(text), color: this.fillStyle });
    },
  };
  const canvas = { width: 0, height: 0, getContext: () => context };
  const sounding = parseSounding(sample('koun-1999-05-04-00z.txt'));
  const thermo = computeThermo(sounding.Sounding);
  UpdateCSMotStorm({ x: 0, y: 0 });
  const baseWind = computeWindParams(sounding, thermo, thermo.MUParcel, { x: 0, y: 0 });
  DrawInsetParams(
    sounding,
    wind || baseWind,
    { DCapeProf: thermo.DCapeProf },
    thermo.SBParcel,
    thermo.MLParcel,
    thermo.MUParcel,
    false,
    { WindLapse: 'Default', Inset: 'Default', Vertical: 'Default' },
    canvas,
    units,
  );
  const values = new Map();
  for (let i = 0; i < entries.length; i += 2) {
    values.set(entries[i].text, entries[i + 1]);
  }
  return values;
}

test('parameter inset displays metric precipitable water and temperatures', () => {
  const metric = renderInset('metric');
  assert.match(metric.get('PWAT: ').text, /^\d+\.\d mm$/);
  assert.match(metric.get('LCL Temp:').text, /^-?\d+°C$/);
  assert.match(metric.get('ConvT:').text, /^-?\d+ °C$/);
  assert.match(metric.get('MaxT:').text, /^-?\d+ °C$/);

  const defaultUnits = renderInset('default');
  assert.match(defaultUnits.get('PWAT: ').text, /^\d+(\.\d+)? in$/);
  assert.match(defaultUnits.get('LCL Temp:').text, /^-?\d+°F$/);
});

test('negative left-motion composite indices use their magnitude for color bands', () => {
  const sounding = parseSounding(sample('koun-1999-05-04-00z.txt'));
  const thermo = computeThermo(sounding.Sounding);
  UpdateCSMotStorm({ x: 0, y: 0 });
  const baseWind = computeWindParams(sounding, thermo, thermo.MUParcel, { x: 0, y: 0 });
  const leftMotionWind = {
    ...baseWind,
    ESRH: -800,
    SRH01: { ...baseWind.SRH01, SRHP: -800, SRHM: 0 },
  };
  const values = renderInset('metric', leftMotionWind);

  assert.match(values.get('STP (cin):').text, /^-/);
  assert.equal(values.get('STP (cin):').color, 'rgba(255,0,0,1)');
  assert.match(values.get('STP (fixed):').text, /^-/);
  assert.equal(values.get('STP (fixed):').color, 'rgba(255,0,255,1)');
  assert.match(values.get('Supercell Comp:').text, /^-/);
  assert.equal(values.get('Supercell Comp:').color, 'rgba(255,0,255,1)');
});
