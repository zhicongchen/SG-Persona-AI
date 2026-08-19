import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-persona-checkpoints-'));
process.env.DATA_DIR = path.join(testRoot, 'data');

const { default: db } = await import('../db.js');
const { ensurePersonaInstance } = await import('../persona-instances.js');
const {
  applyStatePatchForCheckpoint,
  capturePersonaCheckpoint,
  ensureInteractionCheckpoints,
  getInitialPersonaCheckpoint,
  restorePersonaFiles
} = await import('../persona-checkpoints.js');
const {
  getMemoryArchive,
  replaceMemoryArchive
} = await import('../persona-memory.js');
const {
  beginPersonaChat,
  beginPersonaMutation,
  endPersonaChat,
  endPersonaMutation
} = await import('../persona-activity.js');

after(() => {
  db.close();
  fs.rmSync(testRoot, { recursive: true, force: true });
});

test('historical patches use nested merge, bounded evolution, and capped State history', () => {
  const initial = {
    personaSlug: 'test-persona',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastUpdatedAt: '2026-01-01T00:00:00.000Z',
    relationship: {
      stage: 'friend',
      interactionCount: 4
    },
    mood: {
      current: 'neutral',
      intensity: 0.5,
      baseline: 'steady'
    },
    evolvedTraits: [],
    speakingStyleDrift: {
      formality: 0,
      emoji_frequency: 0,
      verbosity: 0
    },
    interests: {},
    stateHistory: Array.from({ length: 10 }, (_, index) => ({ index })),
    eventLog: []
  };

  const result = applyStatePatchForCheckpoint(
    initial,
    {
      relationship: {
        stage: 'stranger',
        interactionCount: 5,
        lastInteraction: '2026-01-02T00:00:00.000Z'
      },
      speakingStyleDrift: {
        formality: 10
      },
      eventLog: [{
        type: 'speaking_style_drift',
        trigger: 'test',
        delta: 'changed',
        source: 'conversation'
      }]
    },
    '2026-01-02 00:00:00',
    {
      minFormality: -1,
      maxFormality: 1
    }
  );

  assert.equal(result.relationship.stage, 'friend');
  assert.equal(result.relationship.interactionCount, 5);
  assert.equal(result.speakingStyleDrift.formality, 1);
  assert.equal(result.speakingStyleDrift.emoji_frequency, 0);
  assert.equal(result.stateHistory.length, 10);
  assert.equal(result.stateHistory[0].index, 1);
  assert.equal(result.eventLog[0].timestamp, '2026-01-02T00:00:00.000Z');
});

test('legacy interactions are reconstructed globally and restore keeps database history intact', () => {
  const userId = Number(db.prepare(`
    INSERT INTO users (email, password_hash)
    VALUES ('checkpoint@example.test', 'hash')
  `).run().lastInsertRowid);
  const firstConversationId = Number(db.prepare(`
    INSERT INTO conversations (user_id, persona_id, title)
    VALUES (?, 'grab-uncle', 'First')
  `).run(userId).lastInsertRowid);
  const secondConversationId = Number(db.prepare(`
    INSERT INTO conversations (user_id, persona_id, title)
    VALUES (?, 'grab-uncle', 'Second')
  `).run(userId).lastInsertRowid);
  const firstMessageId = insertCompletedExchange(firstConversationId, 'one');
  const secondMessageId = insertCompletedExchange(secondConversationId, 'two');

  db.prepare(`
    INSERT INTO persona_relationship_settings (
      user_id,
      persona_id,
      stranger_to_acquaintance,
      acquaintance_to_friend,
      friend_to_close_friend,
      close_friend_to_intimate
    ) VALUES (?, 'grab-uncle', 3, 7, 11, 15)
  `).run(userId);

  const instance = ensurePersonaInstance(userId, 'grab-uncle');
  replaceMemoryArchive(instance.packDir, [
    memory('memory-one', 1, firstConversationId),
    memory('memory-two', 2, secondConversationId)
  ]);

  insertLegacyInteraction({
    userId,
    conversationId: firstConversationId,
    interactionNumber: 1,
    throughMessageId: firstMessageId,
    memoryIds: ['memory-one'],
    patch: {
      relationship: {
        stage: 'acquaintance',
        interactionCount: 1,
        firstInteraction: '2026-01-01T01:00:00.000Z',
        lastInteraction: '2026-01-01T01:00:00.000Z'
      }
    }
  });
  insertLegacyInteraction({
    userId,
    conversationId: secondConversationId,
    interactionNumber: 2,
    throughMessageId: secondMessageId,
    memoryIds: ['memory-two'],
    patch: {
      mood: {
        current: 'happy',
        intensity: 0.7
      },
      relationship: {
        interactionCount: 2,
        lastInteraction: '2026-01-01T02:00:00.000Z'
      }
    }
  });

  assert.equal(
    ensureInteractionCheckpoints(userId, 'grab-uncle', instance.packDir),
    2
  );

  const rows = db.prepare(`
    SELECT
      state_snapshot_json AS stateSnapshot,
      memory_snapshot_json AS memorySnapshot,
      snapshot_quality AS checkpointQuality
    FROM persona_interactions
    WHERE user_id = ? AND persona_id = 'grab-uncle'
    ORDER BY id
  `).all(userId);
  const first = {
    state: JSON.parse(rows[0].stateSnapshot),
    memories: JSON.parse(rows[0].memorySnapshot)
  };
  const second = {
    state: JSON.parse(rows[1].stateSnapshot),
    memories: JSON.parse(rows[1].memorySnapshot)
  };

  assert.deepEqual(rows.map(row => row.checkpointQuality), [
    'reconstructed',
    'reconstructed'
  ]);
  assert.equal(first.state.relationship.stage, 'acquaintance');
  assert.equal(first.state.relationship.interactionCount, 1);
  assert.deepEqual(first.memories.map(item => item.id), ['memory-one']);
  assert.equal(second.state.relationship.interactionCount, 2);
  assert.equal(second.state.mood.current, 'happy');
  assert.deepEqual(second.memories.map(item => item.id), [
    'memory-one',
    'memory-two'
  ]);

  const databaseBefore = databaseInvariantSnapshot(userId);
  restorePersonaFiles(instance.packDir, first);
  assert.equal(capturePersonaCheckpoint(instance.packDir).state.relationship.interactionCount, 1);
  assert.deepEqual(getMemoryArchive(instance.packDir).map(item => item.id), ['memory-one']);
  assert.deepEqual(databaseInvariantSnapshot(userId), databaseBefore);

  restorePersonaFiles(instance.packDir, second);
  assert.equal(capturePersonaCheckpoint(instance.packDir).state.relationship.interactionCount, 2);
  assert.deepEqual(getMemoryArchive(instance.packDir).map(item => item.id), [
    'memory-one',
    'memory-two'
  ]);

  restorePersonaFiles(instance.packDir, getInitialPersonaCheckpoint('grab-uncle'));
  assert.equal(capturePersonaCheckpoint(instance.packDir).state.relationship.interactionCount, 0);
  assert.deepEqual(getMemoryArchive(instance.packDir), []);
  assert.deepEqual(databaseInvariantSnapshot(userId), databaseBefore);
});

test('a Memory write failure restores both files to their previous checkpoint', () => {
  const userId = Number(db.prepare(`
    INSERT INTO users (email, password_hash)
    VALUES ('atomic@example.test', 'hash')
  `).run().lastInsertRowid);
  const instance = ensurePersonaInstance(userId, 'french-dude');
  const initial = capturePersonaCheckpoint(instance.packDir);
  const current = {
    state: applyStatePatchForCheckpoint(initial.state, {
      relationship: {
        interactionCount: 1,
        lastInteraction: '2026-01-03T00:00:00.000Z'
      }
    }, '2026-01-03T00:00:00.000Z'),
    memories: [memory('atomic-memory', 1, 1)]
  };
  restorePersonaFiles(instance.packDir, current);

  let memoryWriteCalls = 0;
  assert.throws(() => restorePersonaFiles(
    instance.packDir,
    initial,
    {
      replaceMemory(packDir, memories) {
        memoryWriteCalls += 1;
        if (memoryWriteCalls === 1) throw new Error('simulated Memory write failure');
        replaceMemoryArchive(packDir, memories);
      }
    }
  ), /simulated Memory write failure/);

  assert.deepEqual(capturePersonaCheckpoint(instance.packDir), current);
  assert.equal(memoryWriteCalls, 2);
});

test('Persona activity lock blocks restore/end while chatting and blocks chat while mutating', () => {
  assert.deepEqual(beginPersonaMutation(99, 'grab-uncle'), { ok: true });
  assert.deepEqual(beginPersonaChat(99, 'grab-uncle'), {
    ok: false,
    reason: 'mutation'
  });
  endPersonaMutation(99, 'grab-uncle');

  assert.deepEqual(beginPersonaChat(99, 'grab-uncle'), { ok: true });
  assert.deepEqual(beginPersonaMutation(99, 'grab-uncle'), {
    ok: false,
    reason: 'chat'
  });
  endPersonaChat(99, 'grab-uncle');
  assert.deepEqual(beginPersonaMutation(99, 'grab-uncle'), { ok: true });
  endPersonaMutation(99, 'grab-uncle');
});

function insertCompletedExchange(conversationId, suffix) {
  db.prepare(`
    INSERT INTO messages (conversation_id, role, content)
    VALUES (?, 'user', ?)
  `).run(conversationId, `user-${suffix}`);
  return Number(db.prepare(`
    INSERT INTO messages (conversation_id, role, content)
    VALUES (?, 'assistant', ?)
  `).run(conversationId, `assistant-${suffix}`).lastInsertRowid);
}

function insertLegacyInteraction({
  userId,
  conversationId,
  interactionNumber,
  throughMessageId,
  memoryIds,
  patch
}) {
  db.prepare(`
    INSERT INTO persona_interactions (
      user_id,
      persona_id,
      conversation_id,
      interaction_number,
      through_message_id,
      summary,
      memory_ids_json,
      should_evolve,
      reason,
      assessment_json,
      decision_json,
      applied_patch_json
    ) VALUES (?, 'grab-uncle', ?, ?, ?, 'summary', ?, 1, 'reason', '{}', '{}', ?)
  `).run(
    userId,
    conversationId,
    interactionNumber,
    throughMessageId,
    JSON.stringify(memoryIds),
    JSON.stringify(patch)
  );
}

function memory(id, interactionNumber, conversationId) {
  return {
    id,
    type: 'general',
    content: id,
    tags: [],
    importance: 0.5,
    subject: 'user',
    evidence: id,
    timestamp: `2026-01-0${interactionNumber}T00:00:00.000Z`,
    accessCount: 0,
    lastAccessed: null,
    conversationId,
    interactionNumber
  };
}

function databaseInvariantSnapshot(userId) {
  return {
    interactionCount: db.prepare(`
      SELECT COUNT(*) AS count
      FROM persona_interactions
      WHERE user_id = ?
    `).get(userId).count,
    messageCount: db.prepare(`
      SELECT COUNT(*) AS count
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE c.user_id = ?
    `).get(userId).count,
    throughMessageId: db.prepare(`
      SELECT MAX(through_message_id) AS value
      FROM persona_interactions
      WHERE user_id = ?
    `).get(userId).value,
    relationshipSettings: db.prepare(`
      SELECT
        stranger_to_acquaintance AS stranger,
        acquaintance_to_friend AS acquaintance,
        friend_to_close_friend AS friend,
        close_friend_to_intimate AS closeFriend
      FROM persona_relationship_settings
      WHERE user_id = ? AND persona_id = 'grab-uncle'
    `).get(userId)
  };
}
