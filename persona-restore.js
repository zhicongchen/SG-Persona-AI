import { Router } from 'express';
import db from './db.js';
import { requireAuth } from './auth.js';
import personas from './personas.js';
import { ensurePersonaInstance } from './persona-instances.js';
import { getConversationForUser } from './conversations.js';
import { getMemorySnapshot } from './persona-memory.js';
import {
  capturePersonaCheckpoint,
  checkpointsEqual,
  ensureInteractionCheckpoints,
  getInitialPersonaCheckpoint,
  restorePersonaFiles
} from './persona-checkpoints.js';
import {
  beginPersonaMutation,
  endPersonaMutation
} from './persona-activity.js';

const router = Router();

router.post('/:personaId/restore', requireAuth, (req, res) => {
  const { personaId } = req.params;
  const userId = req.session.userId;
  const hasInteractionId = Object.hasOwn(req.body || {}, 'interactionId');
  const rawInteractionId = req.body?.interactionId;
  const interactionId = rawInteractionId === null ? null : Number(rawInteractionId);
  const rawConversationId = req.body?.conversationId;
  const conversationId = rawConversationId == null ? null : Number(rawConversationId);

  if (!personas[personaId]) {
    return res.status(404).json({ error: 'Persona not found.' });
  }
  if (!hasInteractionId
      || (interactionId !== null
        && (!Number.isInteger(interactionId) || interactionId <= 0))) {
    return res.status(400).json({ error: 'interactionId must be a positive integer or null.' });
  }
  if (conversationId !== null
      && (!Number.isInteger(conversationId) || conversationId <= 0)) {
    return res.status(400).json({ error: 'conversationId must be a positive integer.' });
  }
  if (conversationId !== null) {
    const conversation = getConversationForUser(conversationId, userId);
    if (!conversation || conversation.personaId !== personaId) {
      return res.status(404).json({ error: 'Conversation not found.' });
    }
  }

  const activity = beginPersonaMutation(userId, personaId);
  if (!activity.ok) {
    const detail = activity.reason === 'chat'
      ? 'Wait for the current reply to finish.'
      : 'Wait for the current Persona update to finish.';
    return res.status(409).json({ error: `Persona is busy. ${detail}` });
  }

  try {
    const instance = ensurePersonaInstance(userId, personaId);

    let target;
    let targetKind;
    let targetInteractionNumber = null;
    let targetLabel;

    if (interactionId === null) {
      try {
        ensureInteractionCheckpoints(userId, personaId, instance.packDir);
      } catch (err) {
        console.warn(
          'Could not preserve every legacy checkpoint before initial reset:',
          err.message
        );
      }
      target = getInitialPersonaCheckpoint(personaId);
      targetKind = 'initial';
      targetLabel = 'the initial state';
    } else {
      const findCheckpoint = db.prepare(`
        SELECT
          interaction_number AS interactionNumber,
          state_snapshot_json AS stateSnapshot,
          memory_snapshot_json AS memorySnapshot
        FROM persona_interactions
        WHERE id = ? AND user_id = ? AND persona_id = ?
      `);
      let row = findCheckpoint.get(interactionId, userId, personaId);

      if (!row) {
        return res.status(404).json({ error: 'Interaction checkpoint not found.' });
      }
      let backfillError = null;
      if (!row.stateSnapshot || !row.memorySnapshot) {
        try {
          ensureInteractionCheckpoints(userId, personaId, instance.packDir);
        } catch (err) {
          backfillError = err;
        }
        row = findCheckpoint.get(interactionId, userId, personaId);
      }
      if (!row || !row.stateSnapshot || !row.memorySnapshot) {
        if (backfillError) throw backfillError;
        return res.status(409).json({ error: 'This interaction does not have a complete checkpoint.' });
      }

      target = {
        state: parseSnapshot(row.stateSnapshot, 'State'),
        memories: parseSnapshot(row.memorySnapshot, 'Memory')
      };
      targetKind = 'interaction';
      targetInteractionNumber = row.interactionNumber;
      targetLabel = `Interaction ${row.interactionNumber}`;
    }

    const current = capturePersonaCheckpoint(instance.packDir);
    if (checkpointsEqual(current, target)) {
      return res.json({
        unchanged: true,
        target: {
          kind: targetKind,
          interactionId,
          interactionNumber: targetInteractionNumber,
          label: targetLabel
        },
        state: current.state,
        memory: getMemorySnapshot(instance.packDir, { limit: 100 })
      });
    }

    let filesRestored = false;
    try {
      restorePersonaFiles(instance.packDir, target);
      filesRestored = true;

      db.prepare(`
        INSERT INTO persona_restore_events (
          user_id,
          persona_id,
          conversation_id,
          target_interaction_id,
          target_interaction_number,
          target_kind,
          previous_state_json,
          previous_memory_json,
          restored_state_json,
          restored_memory_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        userId,
        personaId,
        conversationId,
        interactionId,
        targetInteractionNumber,
        targetKind,
        JSON.stringify(current.state),
        JSON.stringify(current.memories),
        JSON.stringify(target.state),
        JSON.stringify(target.memories)
      );
    } catch (err) {
      if (filesRestored) {
        try {
          restorePersonaFiles(instance.packDir, current);
        } catch (rollbackError) {
          err.message = `${err.message} Audit rollback also failed: ${rollbackError.message}`;
        }
      }
      throw err;
    }

    const updated = ensurePersonaInstance(userId, personaId);
    res.json({
      unchanged: false,
      target: {
        kind: targetKind,
        interactionId,
        interactionNumber: targetInteractionNumber,
        label: targetLabel
      },
      state: updated.state,
      memory: getMemorySnapshot(updated.packDir, { limit: 100 })
    });
  } catch (err) {
    console.error('Persona restore failed:', err);
    res.status(500).json({ error: `Could not restore Persona: ${err.message}` });
  } finally {
    endPersonaMutation(userId, personaId);
  }
});

function parseSnapshot(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} checkpoint contains invalid JSON.`);
  }
}

export default router;
