import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const expectedRoot = JSON.parse(
  readFileSync(new URL('./public-root-exports.json', import.meta.url), 'utf8'),
);

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const root = await import('@revisium/revo-run');
assert(
  JSON.stringify(Object.keys(root).sort()) === JSON.stringify([...expectedRoot].sort()),
  'Root export drift.',
);
assert(typeof root.createRunManager === 'function', 'createRunManager is missing.');
assert(!Object.hasOwn(root, 'default'), 'Default export present.');

for (const specifier of [
  '@revisium/revo-run/package.json',
  '@revisium/revo-run/dist/index.js',
  '@revisium/revo-run/src/index.ts',
  '@revisium/revo-run/unknown',
]) {
  try {
    await import(specifier);
    throw new Error(`Deep import unexpectedly succeeded: ${specifier}.`);
  } catch (error) {
    assert(
      error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED',
      `Wrong deep-import failure for ${specifier}.`,
    );
  }
}

const require = createRequire(import.meta.url);
try {
  require('@revisium/revo-run');
  throw new Error('CommonJS import unexpectedly succeeded.');
} catch (error) {
  assert(
    error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED' || error?.code === 'ERR_REQUIRE_ESM',
    `Wrong CommonJS failure: ${error?.code}.`,
  );
}
