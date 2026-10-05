// Headless analysis in Node — no browser needed.
//   node examples/analyze.mjs app/public/samples/koun-1999-05-04-00z.txt
import fs from 'node:fs';
import { parseSounding, analyze } from '../src/core.js';

const file = process.argv[2] || new URL('../app/public/samples/koun-1999-05-04-00z.txt', import.meta.url);
const sounding = parseSounding(fs.readFileSync(file, 'utf8'));
const a = analyze(sounding, { parcel: 'ML', motion: 'RM' });

const fmt = (w) => (w ? `${w.direction}° / ${Math.round(w.speed)} kt` : '--');
console.log(a.title);
console.log('');
for (const key of ['SB', 'ML', 'MU']) {
  const p = a.parcels[key];
  console.log(`${key}  CAPE ${p.cape} J/kg   CIN ${p.cin}   LCL ${p.lcl} m   LFC ${p.lfc} m   EL ${p.el} m`);
}
console.log('');
console.log(`Bunkers right ${fmt(a.stormMotion.RM)}   left ${fmt(a.stormMotion.LM)}`);
for (const layer of ['0-500m', '0-1km', '0-3km', '0-6km']) {
  const l = a.kinematics.layers[layer];
  console.log(`${layer.padEnd(7)} SRH ${String(l.srh).padStart(4)} m²/s²   shear ${fmt(l.bulkShear)}   EHI ${l.ehi}`);
}
if (a.effectiveInflow) console.log(`Effective inflow: ${a.effectiveInflow.bottomHeightAgl}-${a.effectiveInflow.topHeightAgl} m AGL, ESRH ${a.effectiveInflow.srh} m²/s²`);
console.log('');
console.log(`STP (eff) ${a.indices.stpEffective}   STP (fixed) ${a.indices.stpFixed}   SCP ${a.indices.scp}   SHIP ${a.indices.ship}   PWAT ${a.indices.pwat} in   DCAPE ${a.downdraft.dcape} J/kg`);
