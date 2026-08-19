import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './db.js';
import personas, { loadPersonaPack } from './personas.js';

const INSTANCES_DIR = path.resolve(DATA_DIR, 'persona-instances');

function instancePath(userId, personaId) {
  return path.join(INSTANCES_DIR, String(userId), personaId);
}

export function ensurePersonaInstance(userId, personaId) {
  const template = personas[personaId];
  if (!template) {
    throw new Error(`Unknown persona: ${personaId}`);
  }

  const target = instancePath(userId, personaId);
  if (!fs.existsSync(target)) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(template.packDir, target, {
      recursive: true,
      errorOnExist: true
    });
  }

  return loadPersonaPack(target);
}

export function getPersonaInstancePath(userId, personaId) {
  return instancePath(userId, personaId);
}
