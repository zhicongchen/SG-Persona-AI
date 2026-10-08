// Export chat history, interaction settlements and Persona evolution from the
// local SQLite database.
//
//   node scripts/export-chat-history.js [--user <id|email>] [--out <dir>]
//
// Writes three files, named with the export time:
//   chat-history-<stamp>.json               everything, nested by conversation
//   chat-history-<stamp>-messages.csv       one row per message
//   chat-history-<stamp>-interactions.csv   one row per ended interaction
//
// Output goes to data/exports/ by default, which is gitignored with the rest of
// data/ because it contains full chat transcripts. Stored system prompts are
// left out; they are large and identical to the Persona template.
//
// The CSVs start with a UTF-8 byte order mark so Excel shows non-ASCII text
// correctly. In pandas, read them with encoding="utf-8-sig".

import fs from 'fs';
import path from 'path';
import db, { DATA_DIR } from '../db.js';

// =========================
// Arguments
// =========================

function parseArgs(argv) {
  const args = { user: null, out: path.resolve(DATA_DIR, 'exports') };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--user' && value) {
      args.user = value;
      i++;
    } else if (flag === '--out' && value) {
      args.out = path.resolve(value);
      i++;
    } else if (flag === '--help' || flag === '-h') {
      console.log('Usage: node scripts/export-chat-history.js [--user <id|email>] [--out <dir>]');
      process.exit(0);
    } else {
      console.error(`Unknown or incomplete argument: ${flag}`);
      process.exit(1);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

// =========================
// Lookups
// =========================

function resolveUser(value) {
  const user = /^\d+$/.test(value)
    ? db.prepare('SELECT id, email FROM users WHERE id = ?').get(Number(value))
    : db.prepare('SELECT id, email FROM users WHERE email = ? COLLATE NOCASE').get(value);
  if (!user) {
    console.error(`No user matches "${value}".`);
    process.exit(1);
  }
  return user;
}

// Display names come from the generated Persona packs. If those are missing
// (a fresh clone before `npm run personas:generate`), fall back to the id
// rather than failing the whole export.
async function loadPersonaNames() {
  try {
    const { default: personas } = await import('../personas.js');
    return Object.fromEntries(
      Object.entries(personas).map(([id, persona]) => [id, persona.name])
    );
  } catch (err) {
    console.warn(`Persona names unavailable, using ids instead: ${err.message}`);
    return {};
  }
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

// =========================
// Build the export
// =========================

const filterUser = args.user ? resolveUser(args.user) : null;
const personaNames = await loadPersonaNames();

const conversations = db.prepare(`
  SELECT
    c.id,
    c.persona_id AS personaId,
    c.title,
    c.created_at AS createdAt,
    c.updated_at AS updatedAt,
    u.id AS userId,
    u.email AS userEmail
  FROM conversations c
  JOIN users u ON u.id = c.user_id
  ${filterUser ? 'WHERE c.user_id = ?' : ''}
  ORDER BY u.id, c.id
`).all(...(filterUser ? [filterUser.id] : []));

const messagesStatement = db.prepare(`
  SELECT id, role, content, created_at AS createdAt
  FROM messages
  WHERE conversation_id = ? AND role != 'system'
  ORDER BY id
`);

const interactionsStatement = db.prepare(`
  SELECT *
  FROM persona_interactions
  WHERE conversation_id = ?
  ORDER BY through_message_id
`);

function summarizeState(state) {
  if (!state) return null;
  return {
    stage: state.relationship?.stage ?? null,
    interactionCount: state.relationship?.interactionCount ?? null,
    mood: state.mood?.current ?? null,
    moodIntensity: state.mood?.intensity ?? null,
    evolvedTraits: (state.evolvedTraits || []).map(item => (
      typeof item === 'string' ? item : item?.trait || item?.name || JSON.stringify(item)
    )),
    speakingStyleDrift: state.speakingStyleDrift ?? null,
    interests: state.interests || {},
    milestones: (state.milestones || []).length
  };
}

function buildInteraction(row) {
  const memoryIds = parseJson(row.memory_ids_json, []);
  // The snapshot is the whole Memory archive after this interaction; keep only
  // the records this interaction itself wrote.
  const archive = parseJson(row.memory_snapshot_json, []);
  const byId = new Map(archive.map(memory => [memory.id, memory]));
  const storedMemories = memoryIds
    .map(id => byId.get(id))
    .filter(Boolean)
    .map(memory => ({
      id: memory.id,
      type: memory.type,
      subject: memory.subject,
      content: memory.content,
      evidence: memory.evidence,
      tags: memory.tags || []
    }));
  const durableFacts = storedMemories
    .filter(memory => !(memory.tags || []).includes('conversation-summary'));
  const stateAfter = parseJson(row.state_snapshot_json);

  return {
    number: row.interaction_number,
    throughMessageId: row.through_message_id,
    endedAt: row.created_at,
    summary: row.summary,
    shouldEvolve: Boolean(row.should_evolve),
    reason: row.reason,
    durableFactCount: durableFacts.length,
    storedMemories,
    appliedPatch: parseJson(row.applied_patch_json, {}),
    assessment: parseJson(row.assessment_json, {}),
    decision: parseJson(row.decision_json, {}),
    stateAfter: summarizeState(stateAfter),
    snapshotQuality: row.snapshot_quality
  };
}

// A message belongs to the first interaction whose boundary is at or after it.
// Anything after the last boundary has not been settled by End Interaction yet.
function interactionFor(messageId, interactions) {
  const match = interactions.find(item => messageId <= item.throughMessageId);
  return match ? match.number : null;
}

const exported = conversations.map(conversation => {
  const interactions = interactionsStatement.all(conversation.id).map(buildInteraction);
  const messages = messagesStatement.all(conversation.id).map(message => ({
    ...message,
    interaction: interactionFor(message.id, interactions)
  }));

  return {
    id: conversation.id,
    user: { id: conversation.userId, email: conversation.userEmail },
    persona: {
      id: conversation.personaId,
      name: personaNames[conversation.personaId] || conversation.personaId
    },
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    messageCount: messages.length,
    unsettledMessageCount: messages.filter(message => message.interaction === null).length,
    interactions,
    messages
  };
});

// =========================
// Write files
// =========================

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(header, rows) {
  const lines = [header, ...rows].map(row => row.map(csvCell).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

const messageRows = exported.flatMap(conversation => conversation.messages.map(message => [
  conversation.id,
  conversation.user.email,
  conversation.persona.id,
  conversation.persona.name,
  conversation.title,
  message.interaction ?? 'unsettled',
  message.id,
  message.role,
  message.createdAt,
  message.content
]));

const interactionRows = exported.flatMap(conversation => conversation.interactions.map(item => [
  conversation.id,
  conversation.user.email,
  conversation.persona.id,
  conversation.persona.name,
  item.number,
  item.endedAt,
  item.shouldEvolve,
  item.stateAfter?.stage,
  item.stateAfter?.mood,
  item.stateAfter?.moodIntensity,
  (item.stateAfter?.evolvedTraits || []).join('; '),
  Object.keys(item.stateAfter?.interests || {}).join('; '),
  item.stateAfter?.speakingStyleDrift,
  item.durableFactCount,
  item.summary,
  item.reason
]));

const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
const base = path.join(args.out, `chat-history-${stamp}`);
fs.mkdirSync(args.out, { recursive: true });

fs.writeFileSync(`${base}.json`, JSON.stringify({
  exportedAt: new Date().toISOString(),
  user: filterUser,
  conversationCount: exported.length,
  conversations: exported
}, null, 2) + '\n');

fs.writeFileSync(`${base}-messages.csv`, toCsv([
  'conversation_id', 'user_email', 'persona_id', 'persona_name', 'conversation_title',
  'interaction', 'message_id', 'role', 'created_at', 'content'
], messageRows));

fs.writeFileSync(`${base}-interactions.csv`, toCsv([
  'conversation_id', 'user_email', 'persona_id', 'persona_name', 'interaction',
  'ended_at', 'should_evolve', 'stage_after', 'mood_after', 'mood_intensity_after',
  'evolved_traits_after', 'interests_after', 'speaking_style_drift_after',
  'durable_facts_stored', 'summary', 'reason'
], interactionRows));

console.log(
  `Exported ${exported.length} conversation(s), ${messageRows.length} message(s), `
  + `${interactionRows.length} interaction(s)`
  + (filterUser ? ` for ${filterUser.email}` : ' for all users')
  + ':'
);
for (const suffix of ['.json', '-messages.csv', '-interactions.csv']) {
  console.log(`  ${base}${suffix}`);
}
