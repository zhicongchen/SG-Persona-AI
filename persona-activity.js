const activePersonaMutations = new Set();
const activePersonaChats = new Map();

function personaActivityKey(userId, personaId) {
  return `${userId}:${personaId}`;
}

export function beginPersonaMutation(userId, personaId) {
  const key = personaActivityKey(userId, personaId);
  if (activePersonaMutations.has(key)) {
    return { ok: false, reason: 'mutation' };
  }
  if ((activePersonaChats.get(key) || 0) > 0) {
    return { ok: false, reason: 'chat' };
  }

  activePersonaMutations.add(key);
  return { ok: true };
}

export function endPersonaMutation(userId, personaId) {
  activePersonaMutations.delete(personaActivityKey(userId, personaId));
}

export function beginPersonaChat(userId, personaId) {
  const key = personaActivityKey(userId, personaId);
  if (activePersonaMutations.has(key)) {
    return { ok: false, reason: 'mutation' };
  }

  activePersonaChats.set(key, (activePersonaChats.get(key) || 0) + 1);
  return { ok: true };
}

export function endPersonaChat(userId, personaId) {
  const key = personaActivityKey(userId, personaId);
  const remaining = (activePersonaChats.get(key) || 0) - 1;
  if (remaining > 0) {
    activePersonaChats.set(key, remaining);
  } else {
    activePersonaChats.delete(key);
  }
}
