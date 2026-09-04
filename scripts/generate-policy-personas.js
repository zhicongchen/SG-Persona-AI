// Writes one OpenPersona config per policy_persona_project respondent.
//
// Deterministic by design: no model call, no randomness, no timestamps. Running
// this twice produces byte-identical files, so a regenerated config directory
// diffs cleanly against the committed one.

import fs from 'fs';
import path from 'path';
import { buildConfig, slugFor } from './lib/policy-persona.js';
import {
  POLICY_CONFIG_DIR,
  PROFILE_DIR,
  datasetAvailable,
  listProfiles
} from './lib/policy-dataset.js';

if (!datasetAvailable()) {
  console.error(
    `No policy dataset found at ${PROFILE_DIR}.\n`
    + 'The dataset lives under data/, which is gitignored. Restore it before regenerating.'
  );
  process.exit(1);
}

fs.mkdirSync(POLICY_CONFIG_DIR, { recursive: true });

const profiles = listProfiles();
const written = new Set();

for (const profile of profiles) {
  const slug = slugFor(profile);
  const configPath = path.join(POLICY_CONFIG_DIR, `${slug}.json`);
  fs.writeFileSync(configPath, JSON.stringify(buildConfig(profile), null, 2) + '\n');
  written.add(`${slug}.json`);
}

// A respondent removed from the dataset should not linger as a Persona.
const stale = fs.readdirSync(POLICY_CONFIG_DIR)
  .filter(file => file.endsWith('.json') && !written.has(file));
for (const file of stale) {
  fs.unlinkSync(path.join(POLICY_CONFIG_DIR, file));
}

console.log(
  `Wrote ${written.size} policy persona config(s) to ${POLICY_CONFIG_DIR}`
  + (stale.length ? `, removed ${stale.length} stale file(s)` : '')
  + '.\nNext: npm run personas:generate'
);
