import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import session from 'express-session';
import sqliteStoreFactory from 'better-sqlite3-session-store';
import db from './db.js';
import authRouter, { getSessionSecret, requireAuth } from './auth.js';
import personas from './personas.js';
import { ensurePersonaInstance } from './persona-instances.js';
import personaEvolutionRouter from './persona-evolution.js';
import personaRestoreRouter from './persona-restore.js';
import { ensureInteractionCheckpoints } from './persona-checkpoints.js';
import {
  beginPersonaChat,
  endPersonaChat
} from './persona-activity.js';
import {
  buildMemoryPrompt,
  getMemorySnapshot,
  retrieveMemories
} from './persona-memory.js';
import { getRelationshipMinimums } from './persona-settings.js';
import { callModel } from './llm.js';
import conversationsRouter, {
  getConversationForUser,
  getCurrentInteractionHistory,
  saveMessage,
  setTitleIfEmpty
} from './conversations.js';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// =========================
// Sessions (stored in SQLite, survive restarts)
// =========================
const SqliteStore = sqliteStoreFactory(session);

app.use(session({
  store: new SqliteStore({
    client: db,
    expired: { clear: true, intervalMs: 15 * 60 * 1000 }
  }),
  name: 'sid',
  secret: getSessionSecret(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
  }
}));

app.use('/auth', authRouter);
app.use('/conversations', conversationsRouter);
app.use('/personas', personaEvolutionRouter);
app.use('/personas', personaRestoreRouter);

// =========================
// GET personas list
// =========================
app.get('/personas', (req, res) => {
  const list = Object.entries(personas).map(([id, p]) => ({
    id,
    name: p.name,
    description: p.description || ''
  }));
  res.json(list);
});

// The inspector reads the logged-in user's own Persona instance. When a
// conversation is supplied, it also returns the system-prompt snapshot that
// conversation actually uses.
app.get('/personas/:personaId/instance', requireAuth, (req, res) => {
  const { personaId } = req.params;
  if (!personas[personaId]) {
    return res.status(404).json({ error: 'Persona not found.' });
  }

  const instance = ensurePersonaInstance(req.session.userId, personaId);
  let checkpointWarning = null;
  try {
    ensureInteractionCheckpoints(
      req.session.userId,
      personaId,
      instance.packDir
    );
  } catch (err) {
    console.error('Could not prepare Persona checkpoints:', err);
    checkpointWarning = err.message;
  }
  const memory = getMemorySnapshot(instance.packDir, { limit: 100 });
  const relationshipMinimums = getRelationshipMinimums(
    req.session.userId,
    personaId
  );
  let conversation = null;
  const interactionHistory = db.prepare(`
    SELECT
      pi.id AS interactionId,
      pi.interaction_number AS interactionNumber,
      pi.conversation_id AS conversationId,
      c.title AS conversationTitle,
      pi.summary,
      pi.should_evolve AS shouldEvolve,
      pi.reason,
      pi.assessment_json AS assessment,
      pi.snapshot_quality AS checkpointQuality,
      CASE
        WHEN pi.state_snapshot_json IS NOT NULL
          AND pi.memory_snapshot_json IS NOT NULL
        THEN 1 ELSE 0
      END AS canRestore,
      pi.created_at AS createdAt
    FROM persona_interactions pi
    LEFT JOIN conversations c ON c.id = pi.conversation_id
    WHERE pi.user_id = ? AND pi.persona_id = ?
    ORDER BY pi.id DESC
  `).all(req.session.userId, personaId).map(item => ({
    ...item,
    shouldEvolve: Boolean(item.shouldEvolve),
    canRestore: Boolean(item.canRestore),
    assessment: parseJsonValue(item.assessment, {})
  }));
  const restoreHistory = db.prepare(`
    SELECT
      id AS restoreEventId,
      conversation_id AS conversationId,
      target_interaction_id AS targetInteractionId,
      target_interaction_number AS targetInteractionNumber,
      target_kind AS targetKind,
      created_at AS createdAt
    FROM persona_restore_events
    WHERE user_id = ? AND persona_id = ?
    ORDER BY id DESC
  `).all(req.session.userId, personaId);

  if (req.query.conversationId) {
    const conversationId = Number(req.query.conversationId);
    const ownedConversation = getConversationForUser(
      conversationId,
      req.session.userId
    );

    if (!ownedConversation || ownedConversation.personaId !== personaId) {
      return res.status(404).json({ error: 'Conversation not found.' });
    }

    conversation = db.prepare(`
      SELECT
        c.id,
        c.created_at AS createdAt,
        c.updated_at AS updatedAt,
        (SELECT COUNT(*) FROM messages m
          WHERE m.conversation_id = c.id AND m.role != 'system') AS messageCount,
        (SELECT content FROM messages m
          WHERE m.conversation_id = c.id AND m.role = 'system'
          ORDER BY m.id LIMIT 1) AS storedSystemPrompt
      FROM conversations c
      WHERE c.id = ?
    `).get(conversationId);

    const conversationMessages = db.prepare(`
      SELECT id, role, content, created_at AS createdAt
      FROM messages
      WHERE conversation_id = ?
        AND role != 'system'
        AND id > COALESCE((
          SELECT MAX(through_message_id)
          FROM persona_interactions
          WHERE conversation_id = ?
        ), 0)
      ORDER BY id
    `).all(conversationId, conversationId);
    const recalledMemories = retrieveMemories(instance.packDir, { limit: 12 });
    const latestUserIndex = conversationMessages.findLastIndex(message => message.role === 'user');
    const messagesBeforeLatestUser = latestUserIndex === -1
      ? conversationMessages
      : conversationMessages.slice(0, latestUserIndex);
    const messagesFromLatestUser = latestUserIndex === -1
      ? []
      : conversationMessages.slice(latestUserIndex);
    conversation.messages = [
      {
        role: 'system',
        content: instance.prompt,
        createdAt: instance.state?.lastUpdatedAt || null,
        source: 'current-persona-state'
      },
      {
        role: 'system',
        content: buildMemoryPrompt(recalledMemories, instance),
        createdAt: memory.memories[0]?.timestamp || null,
        source: 'recalled-memory'
      },
      ...messagesBeforeLatestUser,
      ...messagesFromLatestUser
    ];
    conversation.currentInteractionMessageCount = conversationMessages.length;
    conversation.canEndInteraction = conversationMessages.some(message => message.role === 'user')
      && conversationMessages.at(-1)?.role === 'assistant';
    conversation.interactions = db.prepare(`
      SELECT
        id AS interactionId,
        interaction_number AS interactionNumber,
        through_message_id AS throughMessageId,
        summary,
        should_evolve AS shouldEvolve,
        reason,
        assessment_json AS assessment,
        applied_patch_json AS appliedPatch,
        created_at AS createdAt
      FROM persona_interactions
      WHERE user_id = ? AND persona_id = ? AND conversation_id = ?
      ORDER BY id DESC
      LIMIT 50
    `).all(req.session.userId, personaId, conversationId).map(item => ({
      ...item,
      shouldEvolve: Boolean(item.shouldEvolve),
      assessment: JSON.parse(item.assessment),
      appliedPatch: JSON.parse(item.appliedPatch)
    }));
    const legacyEvolutionRuns = db.prepare(`
      SELECT
        should_evolve AS shouldEvolve,
        reason,
        applied_patch_json AS appliedPatch,
        created_at AS createdAt
      FROM persona_evolution_runs
      WHERE user_id = ? AND persona_id = ? AND conversation_id = ?
      ORDER BY id DESC
      LIMIT 20
    `).all(req.session.userId, personaId, conversationId).map(run => ({
      ...run,
      shouldEvolve: Boolean(run.shouldEvolve),
      appliedPatch: JSON.parse(run.appliedPatch),
      legacy: true
    }));
    conversation.evolutionRuns = [
      ...conversation.interactions,
      ...legacyEvolutionRuns
    ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  res.json({
    id: personaId,
    name: instance.name,
    description: instance.description,
    state: instance.state,
    currentPrompt: instance.prompt,
    memory,
    interactionHistory,
    restoreHistory,
    checkpointWarning,
    relationshipMinimums,
    conversation
  });
});

app.post('/chat', requireAuth, async (req, res) => {
  const { message, conversationId } = req.body;
  let chatActivity = null;

  try {
    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Message is empty.' });
    }

    // The conversation must exist and belong to the logged-in user
    const conversation = getConversationForUser(Number(conversationId), req.session.userId);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found.' });
    }

    const activity = beginPersonaChat(
      req.session.userId,
      conversation.personaId
    );
    if (!activity.ok) {
      return res.status(409).json({
        error: 'Persona is being updated. Wait for the update to finish.'
      });
    }
    chatActivity = {
      userId: req.session.userId,
      personaId: conversation.personaId
    };

    // Save the user message first so it is kept even if the model call fails
    saveMessage(conversation.id, 'user', message);
    setTitleIfEmpty(conversation.id, conversation.title, message);

    // Keep the original system prompt in SQLite for auditability, but build
    // each model request from the user's latest Persona state.
    const currentPersona = ensurePersonaInstance(
      req.session.userId,
      conversation.personaId
    );
    const storedHistory = getCurrentInteractionHistory(conversation.id);
    const recalledMemories = retrieveMemories(currentPersona.packDir, {
      query: message,
      limit: 12,
      markAccessed: true
    });
    const history = [
      { role: 'system', content: currentPersona.prompt },
      { role: 'system', content: buildMemoryPrompt(recalledMemories, currentPersona) },
      ...storedHistory
    ];

    const reply = await callModel(history);

    saveMessage(conversation.id, 'assistant', reply);

    res.json({ reply });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not generate a reply.' });
  } finally {
    if (chatActivity) {
      endPersonaChat(chatActivity.userId, chatActivity.personaId);
    }
  }
});

function parseJsonValue(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

export function startServer(port = PORT, host = HOST) {
  return app.listen(port, host, () => {
    console.log(`Server running on http://${host}:${port}`);
  });
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) startServer();

export { app };
