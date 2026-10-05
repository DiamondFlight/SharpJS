/**
 * sharpjs/core: everything that works without a browser (Node, workers, servers).
 *
 *   import { parseSounding, analyze } from 'sharpjs/core';
 */
export { VERSION } from './version.js';
export * from './io/index.js';
export { analyze, levelAt } from './analysis.js';
export * from './settings/index.js';
