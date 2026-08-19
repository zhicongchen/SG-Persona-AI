import db from './db.js';

export const DEFAULT_RELATIONSHIP_MINIMUMS = Object.freeze({
  stranger: 1,
  acquaintance: 10,
  friend: 0,
  close_friend: 0
});

const COLUMN_BY_STAGE = Object.freeze({
  stranger: 'stranger_to_acquaintance',
  acquaintance: 'acquaintance_to_friend',
  friend: 'friend_to_close_friend',
  close_friend: 'close_friend_to_intimate'
});

export function getRelationshipMinimums(userId, personaId) {
  const row = db.prepare(`
    SELECT
      stranger_to_acquaintance AS stranger,
      acquaintance_to_friend AS acquaintance,
      friend_to_close_friend AS friend,
      close_friend_to_intimate AS closeFriend
    FROM persona_relationship_settings
    WHERE user_id = ? AND persona_id = ?
  `).get(userId, personaId);

  return row
    ? {
        stranger: row.stranger,
        acquaintance: row.acquaintance,
        friend: row.friend,
        close_friend: row.closeFriend
      }
    : { ...DEFAULT_RELATIONSHIP_MINIMUMS };
}

export function saveRelationshipMinimums(userId, personaId, rawMinimums) {
  const minimums = {};
  for (const [stage, defaultValue] of Object.entries(DEFAULT_RELATIONSHIP_MINIMUMS)) {
    const value = Number(rawMinimums?.[stage]);
    if (!Number.isInteger(value) || value < 0 || value > 10000) {
      throw new Error(`Minimum interactions for ${stage} must be an integer from 0 to 10000.`);
    }
    minimums[stage] = value ?? defaultValue;
  }

  db.prepare(`
    INSERT INTO persona_relationship_settings (
      user_id,
      persona_id,
      stranger_to_acquaintance,
      acquaintance_to_friend,
      friend_to_close_friend,
      close_friend_to_intimate,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, persona_id) DO UPDATE SET
      stranger_to_acquaintance = excluded.stranger_to_acquaintance,
      acquaintance_to_friend = excluded.acquaintance_to_friend,
      friend_to_close_friend = excluded.friend_to_close_friend,
      close_friend_to_intimate = excluded.close_friend_to_intimate,
      updated_at = datetime('now')
  `).run(
    userId,
    personaId,
    minimums.stranger,
    minimums.acquaintance,
    minimums.friend,
    minimums.close_friend
  );

  return minimums;
}

export function relationshipMinimumForStage(minimums, stage) {
  if (!COLUMN_BY_STAGE[stage]) return 0;
  return minimums?.[stage] ?? DEFAULT_RELATIONSHIP_MINIMUMS[stage];
}
