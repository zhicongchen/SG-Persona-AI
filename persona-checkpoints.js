import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { isDeepStrictEqual } from 'util';
import db from './db.js';
import personas from './personas.js';
import {
  getMemoryArchive,
  replaceMemoryArchive
} from './persona-memory.js';

const NESTED_STATE_KEYS = new Set([
  'mood',
  'relationship',
  'speakingStyleDrift',
  'interests'
]);
const IMMUTABLE_STATE_KEYS = new Set([
  '$schema',
  'version',
  'personaSlug',
  'createdAt'
]);

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function readState(packDir) {
  const file = path.join(packDir, 'state.json');
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function writeState(packDir, state) {
  const file = path.join(packDir, 'state.json');
  const temporaryFile = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporaryFile, JSON.stringify(state, null, 2));
    fs.renameSync(temporaryFile, file);
  } finally {
    if (fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile);
  }
}

function parseStoredJson(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} contains invalid JSON.`);
  }
}

function normalizedTimestamp(value) {
  if (!value) return new Date().toISOString();
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function validateCheckpoint(checkpoint, expectedPersonaSlug = null) {
  if (!checkpoint
      || !checkpoint.state
      || typeof checkpoint.state !== 'object'
      || Array.isArray(checkpoint.state)
      || !checkpoint.state.relationship
      || typeof checkpoint.state.relationship !== 'object') {
    throw new Error('Persona State checkpoint is invalid.');
  }
  if (!Array.isArray(checkpoint.memories)) {
    throw new Error('Persona Memory checkpoint is invalid.');
  }
  const memoryIds = new Set();
  for (const memory of checkpoint.memories) {
    if (!memory || typeof memory !== 'object' || Array.isArray(memory)) {
      throw new Error('Persona Memory checkpoint contains an invalid entry.');
    }
    if (typeof memory.id === 'string') {
      if (memoryIds.has(memory.id)) {
        throw new Error(`Persona Memory checkpoint contains duplicate id ${memory.id}.`);
      }
      memoryIds.add(memory.id);
    }
  }
  if (expectedPersonaSlug
      && checkpoint.state.personaSlug !== expectedPersonaSlug) {
    throw new Error('Checkpoint belongs to a different Persona.');
  }
}

export function capturePersonaCheckpoint(packDir) {
  const checkpoint = {
    state: readState(packDir),
    memories: getMemoryArchive(packDir)
  };
  validateCheckpoint(checkpoint);
  return checkpoint;
}

export function getInitialPersonaCheckpoint(personaId) {
  const template = personas[personaId];
  if (!template) throw new Error(`Unknown Persona: ${personaId}`);
  return capturePersonaCheckpoint(template.packDir);
}

export function restorePersonaFiles(packDir, checkpoint, operations = {}) {
  const previous = capturePersonaCheckpoint(packDir);
  validateCheckpoint(checkpoint, previous.state.personaSlug);
  const writeStateFile = operations.writeState || writeState;
  const replaceMemory = operations.replaceMemory || replaceMemoryArchive;

  try {
    writeStateFile(packDir, cloneJson(checkpoint.state));
    replaceMemory(packDir, cloneJson(checkpoint.memories));
  } catch (err) {
    const rollbackErrors = [];
    try {
      writeStateFile(packDir, previous.state);
    } catch (rollbackError) {
      rollbackErrors.push(`State: ${rollbackError.message}`);
    }
    try {
      replaceMemory(packDir, previous.memories);
    } catch (rollbackError) {
      rollbackErrors.push(`Memory: ${rollbackError.message}`);
    }
    if (rollbackErrors.length) {
      err.message = `${err.message} File rollback also failed (${rollbackErrors.join('; ')}).`;
    }
    throw err;
  }

  return previous;
}

export function checkpointsEqual(first, second) {
  return isDeepStrictEqual(first?.state, second?.state)
    && isDeepStrictEqual(first?.memories, second?.memories);
}

export function applyStatePatchForCheckpoint(
  currentState,
  rawPatch,
  createdAt,
  evolutionBoundaries = null
) {
  const state = cloneJson(currentState);
  const patch = rawPatch && typeof rawPatch === 'object' && !Array.isArray(rawPatch)
    ? cloneJson(rawPatch)
    : {};
  const snapshot = cloneJson(state);
  delete snapshot.stateHistory;
  delete snapshot.eventLog;
  delete snapshot.pendingCommands;

  state.stateHistory = Array.isArray(state.stateHistory) ? state.stateHistory : [];
  if (state.stateHistory.length >= 10) state.stateHistory.shift();
  state.stateHistory.push(snapshot);

  const newEvents = Array.isArray(patch.eventLog) ? patch.eventLog : [];
  delete patch.eventLog;
  applyEvolutionBoundaries(patch, state, evolutionBoundaries);

  for (const [key, value] of Object.entries(patch)) {
    if (IMMUTABLE_STATE_KEYS.has(key)) continue;
    if (NESTED_STATE_KEYS.has(key)
        && value
        && typeof value === 'object'
        && !Array.isArray(value)
        && state[key]
        && typeof state[key] === 'object'
        && !Array.isArray(state[key])) {
      state[key] = { ...state[key], ...value };
    } else {
      state[key] = value;
    }
  }

  const timestamp = normalizedTimestamp(
    patch.relationship?.lastInteraction || createdAt
  );
  if (newEvents.length) {
    state.eventLog = Array.isArray(state.eventLog) ? state.eventLog : [];
    state.eventLog.push(...newEvents.map(event => ({
      ...event,
      timestamp: event.timestamp || timestamp
    })));
    if (state.eventLog.length > 50) state.eventLog = state.eventLog.slice(-50);
  }
  state.lastUpdatedAt = timestamp;
  return state;
}

export function ensureInteractionCheckpoints(userId, personaId, packDir) {
  const rows = db.prepare(`
    SELECT
      id,
      memory_ids_json AS memoryIds,
      applied_patch_json AS appliedPatch,
      state_snapshot_json AS stateSnapshot,
      memory_snapshot_json AS memorySnapshot,
      snapshot_quality AS snapshotQuality,
      created_at AS createdAt
    FROM persona_interactions
    WHERE user_id = ? AND persona_id = ?
    ORDER BY id
  `).all(userId, personaId);

  if (!rows.some(row => (
    !row.stateSnapshot || !row.memorySnapshot || !row.snapshotQuality
  ))) return 0;

  const initial = getInitialPersonaCheckpoint(personaId);
  const currentArchive = getMemoryArchive(packDir);
  const personaConfig = parseStoredJson(
    fs.readFileSync(path.join(packDir, 'persona.json'), 'utf-8'),
    `Persona configuration for ${personaId}`
  );
  const evolution = personaConfig.evolution || {};
  const evolutionBoundaries = evolution.instance?.boundaries
    || evolution.boundaries
    || null;
  const memoryById = new Map(
    currentArchive
      .filter(memory => typeof memory?.id === 'string')
      .map(memory => [memory.id, memory])
  );
  let replayState = cloneJson(initial.state);
  let replayMemories = cloneJson(initial.memories);
  let includedMemoryIds = new Set(
    replayMemories
      .map(memory => memory?.id)
      .filter(id => typeof id === 'string')
  );
  const updates = [];
  let reconstructionError = null;

  for (const row of rows) {
    try {
      if (row.stateSnapshot) {
        replayState = parseStoredJson(
          row.stateSnapshot,
          `State checkpoint for interaction row ${row.id}`
        );
      } else {
        replayState = applyStatePatchForCheckpoint(
          replayState,
          parseStoredJson(row.appliedPatch, `Applied patch for interaction row ${row.id}`),
          row.createdAt,
          evolutionBoundaries
        );
      }

      if (row.memorySnapshot) {
        replayMemories = parseStoredJson(
          row.memorySnapshot,
          `Memory checkpoint for interaction row ${row.id}`
        );
        if (!Array.isArray(replayMemories)) {
          throw new Error(`Memory checkpoint for interaction row ${row.id} is not an array.`);
        }
        includedMemoryIds = new Set(
          replayMemories
            .map(memory => memory?.id)
            .filter(id => typeof id === 'string')
        );
      } else {
        const memoryIds = parseStoredJson(
          row.memoryIds,
          `Memory IDs for interaction row ${row.id}`
        );
        if (!Array.isArray(memoryIds)) {
          throw new Error(`Memory IDs for interaction row ${row.id} are not an array.`);
        }
        for (const memoryId of memoryIds) {
          if (!memoryById.has(memoryId)) {
            throw new Error(
              `Cannot reconstruct interaction row ${row.id}: Memory ${memoryId} is missing.`
            );
          }
          if (!includedMemoryIds.has(memoryId)) {
            replayMemories.push(cloneJson(memoryById.get(memoryId)));
            includedMemoryIds.add(memoryId);
          }
        }
      }

      if (!row.stateSnapshot || !row.memorySnapshot || !row.snapshotQuality) {
        updates.push({
          id: row.id,
          stateSnapshot: JSON.stringify(replayState),
          memorySnapshot: JSON.stringify(replayMemories),
          snapshotQuality: row.stateSnapshot && row.memorySnapshot
            ? 'exact'
            : 'reconstructed'
        });
      }
    } catch (err) {
      reconstructionError = err;
      break;
    }
  }

  const update = db.prepare(`
    UPDATE persona_interactions
    SET state_snapshot_json = ?, memory_snapshot_json = ?, snapshot_quality = ?
    WHERE id = ? AND user_id = ? AND persona_id = ?
  `);
  db.transaction(items => {
    for (const item of items) {
      update.run(
        item.stateSnapshot,
        item.memorySnapshot,
        item.snapshotQuality,
        item.id,
        userId,
        personaId
      );
    }
  })(updates);

  if (reconstructionError) throw reconstructionError;
  return updates.length;
}

function applyEvolutionBoundaries(patch, currentState, boundaries) {
  if (!boundaries) return;

  if (Array.isArray(boundaries.immutableTraits)
      && Array.isArray(patch.evolvedTraits)) {
    const immutable = new Set(
      boundaries.immutableTraits.map(trait => String(trait).toLowerCase())
    );
    patch.evolvedTraits = patch.evolvedTraits.filter(entry => {
      const name = typeof entry === 'string'
        ? entry
        : entry?.trait || entry?.name || '';
      return !immutable.has(String(name).toLowerCase());
    });
    if (!patch.evolvedTraits.length) delete patch.evolvedTraits;
  }

  if (patch.speakingStyleDrift
      && typeof patch.speakingStyleDrift === 'object'
      && Number.isFinite(patch.speakingStyleDrift.formality)) {
    const minimum = boundaries.minFormality;
    const maximum = boundaries.maxFormality;
    if (Number.isFinite(minimum)) {
      patch.speakingStyleDrift.formality = Math.max(
        minimum,
        patch.speakingStyleDrift.formality
      );
    }
    if (Number.isFinite(maximum)) {
      patch.speakingStyleDrift.formality = Math.min(
        maximum,
        patch.speakingStyleDrift.formality
      );
    }
  }

  const proposedStage = patch.relationship?.stage;
  if (proposedStage === undefined) return;
  const stages = ['stranger', 'acquaintance', 'friend', 'close_friend', 'intimate'];
  const currentStage = currentState.relationship?.stage || 'stranger';
  const currentIndex = stages.indexOf(currentStage);
  const proposedIndex = stages.indexOf(proposedStage);
  if (proposedIndex === -1
      || (currentIndex !== -1
        && (proposedIndex < currentIndex || proposedIndex > currentIndex + 1))) {
    delete patch.relationship.stage;
  }
}
