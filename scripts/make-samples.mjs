// Regenerate app/public/samples from the IEM RAOB archive (NWS radiosonde data, public domain).
//   node scripts/make-samples.mjs
import fs from 'node:fs';
import { fetchIemRaob } from '../src/sources/index.js';
import { exportSounding } from '../src/core.js';

export const SAMPLES = [
  { file: 'koun-1999-05-04-00z.txt', station: 'OUN', time: '1999-05-04T00:00:00Z', label: 'Norman, OK — 00Z 4 May 1999 (3 May 1999 outbreak)' },
  { file: 'koax-2014-06-16-19z.txt', station: 'OAX', time: '2014-06-16T19:00:00Z', label: 'Omaha, NE — 19Z 16 Jun 2014 (Pilger special launch)' },
  { file: 'koun-2013-05-20-12z.txt', station: 'OUN', time: '2013-05-20T12:00:00Z', label: 'Norman, OK — 12Z 20 May 2013 (morning of the Moore tornado)' },
  { file: 'kbuf-2014-11-18-12z.txt', station: 'BUF', time: '2014-11-18T12:00:00Z', label: 'Buffalo, NY — 12Z 18 Nov 2014 (lake-effect snow)' },
  { file: 'kdnr-2021-12-30-12z.txt', station: 'DNR', time: '2021-12-30T12:00:00Z', label: 'Denver, CO — 12Z 30 Dec 2021 (Marshall Fire)' },
];

const out = new URL('../app/public/samples/', import.meta.url);
fs.mkdirSync(out, { recursive: true });
const index = [];
for (const s of SAMPLES) {
  const snd = await fetchIemRaob({ station: s.station, time: s.time });
  const { text } = exportSounding(snd, 'Default', { savedBy: 'SharpJS sample (NWS radiosonde via IEM)' });
  fs.writeFileSync(new URL(s.file, out), text + '\n');
  index.push({ file: s.file, label: s.label, location: snd.Coords || null });
  console.log(s.file, snd.Title.trim(), snd.Sounding.Slice.length, 'levels');
}
fs.writeFileSync(new URL('index.json', out), JSON.stringify(index, null, 2) + '\n');
