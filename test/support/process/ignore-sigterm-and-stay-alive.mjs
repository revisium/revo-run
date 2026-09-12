/* eslint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access -- This plain-JavaScript preload runs in the DBOS child without the test TypeScript loader. */

import { writeFileSync } from 'node:fs';

const marker = process.env['REVO_RUN_PREPARATION_SIGTERM_MARKER'];

process.on('SIGTERM', () => {
  if (marker !== undefined) {
    writeFileSync(marker, 'received\n', { encoding: 'utf8', flag: 'a' });
  }
});

process.exit = (code) => {
  process.exitCode = typeof code === 'number' ? code : 0;
};

setInterval(() => undefined, 60_000);
