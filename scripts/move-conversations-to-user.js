// Reassign every conversation and Persona record from one local account to
// another, and move the matching Persona instance folders with them.
//
//   node scripts/move-conversations-to-user.js <fromUserId> <toUserId>
//
// Written for the eval run: chats were driven under a throwaway account
// because the driver cannot log in as a real user, and this hands the result
// to the real account. Refuses to run if the target already has an instance
// folder for one of the personas being moved, since that would overwrite State
// and Memory the target account already built up.

import fs from 'fs';
import path from 'path';
import db, { DATA_DIR } from '../db.js';

const [fromArg, toArg] = process.argv.slice(2);
const FROM = Number(fromArg);
const TO = Number(toArg);

if (!Number.isInteger(FROM) || !Number.isInteger(TO) || FROM === TO) {
  console.error('Usage: node scripts/move-conversations-to-user.js <fromUserId> <toUserId>');
  process.exit(1);
}

const users = db.prepare('SELECT id, email FROM users WHERE id IN (?, ?)').all(FROM, TO);
const from = users.find(u => u.id === FROM);
const to = users.find(u => u.id === TO);
if (!from || !to) {
  console.error(`Both users must exist. Found: ${JSON.stringify(users)}`);
  process.exit(1);
}

const INSTANCES_DIR = path.resolve(DATA_DIR, 'persona-instances');
const fromDir = path.join(INSTANCES_DIR, String(FROM));
const toDir = path.join(INSTANCES_DIR, String(TO));

const packs = fs.existsSync(fromDir) ? fs.readdirSync(fromDir) : [];
const collisions = packs.filter(pack => fs.existsSync(path.join(toDir, pack)));
if (collisions.length) {
  console.error(
    `Refusing to move: user ${TO} already has Persona instances for ${collisions.join(', ')}.\n`
    + 'Moving would overwrite their existing State and Memory.'
  );
  process.exit(1);
}

const TABLES = [
  'conversations',
  'persona_interactions',
  'persona_evolution_runs',
  'persona_restore_events',
  'persona_relationship_settings'
];

console.log(`Moving from ${from.email} (${FROM}) to ${to.email} (${TO})`);

const move = db.transaction(() => {
  for (const table of TABLES) {
    const result = db.prepare(`UPDATE ${table} SET user_id = ? WHERE user_id = ?`).run(TO, FROM);
    console.log(`  ${table}: ${result.changes} row(s)`);
  }
});
move();

fs.mkdirSync(toDir, { recursive: true });
for (const pack of packs) {
  fs.renameSync(path.join(fromDir, pack), path.join(toDir, pack));
  console.log(`  moved instance ${pack}`);
}
if (fs.existsSync(fromDir) && fs.readdirSync(fromDir).length === 0) {
  fs.rmdirSync(fromDir);
}

console.log(`Done. ${to.email} now owns these conversations.`);
