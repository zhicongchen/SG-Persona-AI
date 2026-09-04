// Reads the policy_persona_project dataset and seeds generated Persona packs
// with the material derived from it.
//
// The dataset lives under data/, which is gitignored, so the generated configs
// in openpersona/configs/policy/ are the committed record of these Personas.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { profileMarkdown, seedMemories } from './policy-persona.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const DATASET_DIR = path.join(PROJECT_ROOT, 'data', 'policy_persona_project');
export const PROFILE_DIR = path.join(DATASET_DIR, 'data');
export const INTERVIEW_DIR = path.join(DATASET_DIR, 'memory', 'interview_chunks');
export const EVENTS_DIR = path.join(DATASET_DIR, 'memory', 'dynamic_events');
export const POLICY_CONFIG_DIR = path.join(PROJECT_ROOT, 'openpersona', 'configs', 'policy');

export const POLICY_SLUG_PREFIX = 'policy-';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

export function datasetAvailable() {
  return fs.existsSync(PROFILE_DIR);
}

// P001, P002, ... in file order so generated output is stable.
export function listProfiles() {
  if (!datasetAvailable()) return [];
  return fs.readdirSync(PROFILE_DIR)
    .filter(file => /^P\d+\.json$/.test(file))
    .sort()
    .map(file => readJson(path.join(PROFILE_DIR, file)));
}

export function readProfile(personaId) {
  const file = path.join(PROFILE_DIR, `${personaId}.json`);
  return fs.existsSync(file) ? readJson(file) : null;
}

// Five verbatim interview answers per respondent, one JSON object per line.
function readInterviewChunks(personaId) {
  const file = path.join(INTERVIEW_DIR, `${personaId}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf-8')
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line));
}

// 24 of the 58 respondents reported no qualifying experience, so an empty list
// is expected rather than an error.
function readDynamicEvents(personaId) {
  const file = path.join(EVENTS_DIR, `${personaId}.json`);
  if (!fs.existsSync(file)) return [];
  return readJson(file).dynamic_memory || [];
}

export function personaIdFromSlug(slug) {
  return slug.startsWith(POLICY_SLUG_PREFIX)
    ? slug.slice(POLICY_SLUG_PREFIX.length).toUpperCase()
    : null;
}

// Called after the OpenPersona CLI has created a pack. Writes the structured
// profile that personas.js folds into the system prompt, plus the Persona's own
// interview answers and lived experiences as retrievable Memory. No-op for the
// hand-authored Personas.
export function seedPolicyPack(slug, packDir) {
  const personaId = personaIdFromSlug(slug);
  if (!personaId) return false;

  const profile = readProfile(personaId);
  if (!profile) {
    throw new Error(
      `Config ${slug} has no matching profile at ${path.join(PROFILE_DIR, `${personaId}.json`)}.`
    );
  }

  fs.mkdirSync(path.join(packDir, 'soul'), { recursive: true });
  fs.writeFileSync(
    path.join(packDir, 'soul', 'policy-profile.md'),
    profileMarkdown(profile)
  );

  const memories = seedMemories(
    personaId,
    readInterviewChunks(personaId),
    readDynamicEvents(personaId),
    new Date().toISOString()
  );

  fs.mkdirSync(path.join(packDir, 'memory'), { recursive: true });
  fs.writeFileSync(
    path.join(packDir, 'memory', 'memories.jsonl'),
    memories.map(memory => JSON.stringify(memory)).join('\n') + (memories.length ? '\n' : '')
  );

  return true;
}
