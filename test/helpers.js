import fs from 'node:fs';

export const fixture = (name, enc = 'utf8') => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), enc);
export const sample = (name) => fs.readFileSync(new URL(`../app/public/samples/${name}`, import.meta.url), 'utf8');
