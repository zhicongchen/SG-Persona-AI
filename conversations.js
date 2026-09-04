import { Router } from 'express';
import db from './db.js';
import { requireAuth } from './auth.js';
import personas from './personas.js';
import { ensurePersonaInstance } from './persona-instances.js';
import {
  beginPersonaMutation,
  endPersonaMutation
} from './persona-activity.js';

// =========================
// Conversation storage
// =========================
// Each chat belongs to one user and one persona. For now the UI always
// works with the user's most recent conversation per persona; older ones
// stay in the database (the multi-conversation UI comes later).

const TITLE_MAX_LENGTH = 50;

function latestConversation(userId, personaId) {
  return db.prepare(`
    SELECT id, title FROM conversations
    WHERE user_id = ? AND persona_id = ?
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
  `).get(userId, personaId);
}

// New conversations start with the persona's system prompt, stored as a
// message so old chats keep their original prompt even if persona.json changes
export function createConversation(userId, personaId) {
  const personaInstance = ensurePersonaInstance(userId, personaId);

  const info = db.prepare(
    'INSERT INTO conversations (user_id, persona_id) VALUES (?, ?)'
  ).run(userId, personaId);

  const id = Number(info.lastInsertRowid);

  db.prepare(
    'INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)'
  ).run(id, 'system', personaInstance.prompt);

  return { id, title: null };
}

export function saveMessage(conversationId, role, content) {
  db.prepare(
    'INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)'
  ).run(conversationId, role, content);

  db.prepare(
    "UPDATE conversations SET updated_at = datetime('now') WHERE id = ?"
  ).run(conversationId);
}

// The first user message doubles as the conversation title
export function setTitleIfEmpty(conversationId, title, message) {
  if (title) return;
  db.prepare('UPDATE conversations SET title = ? WHERE id = ?')
    .run(message.trim().slice(0, TITLE_MAX_LENGTH), conversationId);
}

export function getConversationHistory(conversationId) {
  return db.prepare(
    'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id'
  ).all(conversationId);
}

export function getCurrentInteractionHistory(conversationId) {
  const lastInteraction = db.prepare(`
    SELECT through_message_id AS throughMessageId
    FROM persona_interactions
    WHERE conversation_id = ?
    ORDER BY through_message_id DESC
    LIMIT 1
  `).get(conversationId);

  return db.prepare(`
    SELECT role, content
    FROM messages
    WHERE conversation_id = ? AND role != 'system' AND id > ?
    ORDER BY id
  `).all(conversationId, lastInteraction?.throughMessageId || 0);
}

// Conversation by id, only if it belongs to this user (else undefined).
// Used by the routes below and by /chat in server.js.
export function getConversationForUser(conversationId, userId) {
  return db.prepare(
    'SELECT id, persona_id AS personaId, title FROM conversations WHERE id = ? AND user_id = ?'
  ).get(conversationId, userId);
}

// =========================
// Routes (/conversations/...)
// =========================

const router = Router();
router.use(requireAuth);

// GET /conversations
// All conversations of the current user, most recently active first —
// fills the "Recent" sidebar.
router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT
      c.id,
      c.persona_id AS personaId,
      c.title,
      c.updated_at AS updatedAt,
      (SELECT COUNT(*) FROM messages m
        WHERE m.conversation_id = c.id AND m.role != 'system') AS messageCount
    FROM conversations c
    WHERE c.user_id = ?
    ORDER BY c.updated_at DESC, c.id DESC
  `).all(req.session.userId);

  const list = rows.map(row => ({
    ...row,
    personaName: personas[row.personaId]?.name || row.personaId
  }));

  res.json(list);
});

// POST /conversations/new  { personaId }
// Start a fresh conversation with a persona (the Reset button).
// Reuses the latest conversation if it has no messages yet, so clicking
// Reset repeatedly does not pile up empty conversations.
router.post('/new', (req, res) => {
  const personaId = req.body?.personaId;
  if (!personaId || !personas[personaId]) {
    return res.status(400).json({ error: 'Unknown persona.' });
  }

  const latest = latestConversation(req.session.userId, personaId);
  if (latest) {
    const { n } = db.prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND role != 'system'"
    ).get(latest.id);
    if (n === 0) {
      return res.json({ id: latest.id });
    }
  }

  const conversation = createConversation(req.session.userId, personaId);
  res.json({ id: conversation.id });
});

// GET /conversations/:id
// One conversation with its messages (system prompt excluded) —
// fills the chat window when the user opens a conversation.
router.get('/:id', (req, res) => {
  const conversation = getConversationForUser(Number(req.params.id), req.session.userId);
  if (!conversation) {
    return res.status(404).json({ error: 'Conversation not found.' });
  }

  const messages = db.prepare(`
    SELECT id, role, content, created_at AS createdAt FROM messages
    WHERE conversation_id = ? AND role != 'system'
    ORDER BY id
  `).all(conversation.id);

  const interactions = db.prepare(`
    SELECT
      interaction_number AS interactionNumber,
      through_message_id AS throughMessageId,
      summary,
      created_at AS createdAt
    FROM persona_interactions
    WHERE conversation_id = ?
    ORDER BY through_message_id
  `).all(conversation.id);

  res.json({
    id: conversation.id,
    personaId: conversation.personaId,
    title: conversation.title,
    messages,
    interactions
  });
});

// DELETE /conversations/:id
// Remove one conversation and everything recorded against it. Messages,
// interactions and evolution runs are removed by the foreign-key cascades in
// db.js; restore events keep their history with a null conversation.
//
// This does not roll back the Persona itself. State and Memory the conversation
// produced live in the user's Persona instance, not in the conversation, so a
// deleted chat leaves the Persona where it stood. Use the restore controls in
// the Persona details drawer to wind that back.
router.delete('/:id', (req, res) => {
  const conversation = getConversationForUser(Number(req.params.id), req.session.userId);
  if (!conversation) {
    return res.status(404).json({ error: 'Conversation not found.' });
  }

  // Take the same lock as an interaction settlement so a conversation cannot
  // vanish underneath an in-flight chat, evolution or restore.
  const activity = beginPersonaMutation(req.session.userId, conversation.personaId);
  if (!activity.ok) {
    return res.status(409).json({
      error: activity.reason === 'chat'
        ? 'Persona is replying. Wait for the reply to finish.'
        : 'Persona is being updated. Wait for the update to finish.'
    });
  }

  try {
    db.prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?')
      .run(conversation.id, req.session.userId);
  } finally {
    endPersonaMutation(req.session.userId, conversation.personaId);
  }

  res.json({ deleted: conversation.id });
});

export default router;
