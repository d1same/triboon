'use strict';
// Emits the hand-rolled store archives (for validation by real unrar inside Docker) and the
// deterministic payload used by Docker to build the real-tool fixtures.
// Run from repo root: node test/fixtures/gen-fixtures.js
// Then: see test/fixtures/README.md for the Docker generation/validation command.

const fs = require('fs');
const path = require('path');
const { seededPayload, writeRar4Store, writeRar5Store, writeZipStore } = require('../archive-fixtures');

const OUT = path.join(__dirname, 'work');
fs.mkdirSync(OUT, { recursive: true });

const payload = seededPayload(300 * 1024);
fs.writeFileSync(path.join(OUT, 'inner.mkv'), payload);

const sets = {
  js4single: writeRar4Store([{ name: 'inner.mkv', data: payload }], { base: 'js4single' }),
  js4multi: writeRar4Store([{ name: 'inner.mkv', data: payload }], { volSize: 80 * 1024, base: 'js4multi', naming: 'old' }),
  js5single: writeRar5Store([{ name: 'inner.mkv', data: payload }], { base: 'js5single' }),
  js5multi: writeRar5Store([{ name: 'inner.mkv', data: payload }], { volSize: 80 * 1024, base: 'js5multi', naming: 'part' }),
};
for (const vols of Object.values(sets)) {
  for (const v of vols) fs.writeFileSync(path.join(OUT, v.name), v.data);
}
fs.writeFileSync(path.join(OUT, 'jszip.zip'), writeZipStore([{ name: 'inner.mkv', data: payload }]));

console.log('Wrote payload + JS-built archives to', OUT);
