/** Single source of truth for the SharpJS version (kept in sync with package.json by test/version.test.js). */
export const VERSION = '1.7.1';

/** Short form drawn on charts ("SharpJS v1.7"). */
export const DISPLAY_VERSION = VERSION.split('.').slice(0, 2).join('.');
