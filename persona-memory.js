import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const VALID_TYPES = new Set([
  'preference',
  'personal_fact',
  'interest_signal',
  'emotional_moment',
  'milestone',
  'general'
]);

function memoryFile(packDir) {
  return path.join(packDir, 'memory', 'memories.jsonl');
}

function readAll(packDir) {
  const file = memoryFile(packDir);
  if (!fs.existsSync(file)) return [];

  return fs.readFileSync(file, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .flatMap(line => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function readAllStrict(packDir) {
  const file = memoryFile(packDir);
  if (!fs.existsSync(file)) return [];

  return fs.readFileSync(file, 'utf-8')
    .split('\n')
    .flatMap((line, index) => {
      if (!line.trim()) return [];
      try {
        return [JSON.parse(line)];
      } catch {
        throw new Error(`Memory archive contains invalid JSON on line ${index + 1}.`);
      }
    });
}

function writeAll(packDir, memories) {
  const file = memoryFile(packDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const output = memories.map(memory => JSON.stringify(memory)).join('\n');
  const temporaryFile = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporaryFile, output ? `${output}\n` : '');
    fs.renameSync(temporaryFile, file);
  } finally {
    if (fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile);
  }
}

export function getMemoryArchive(packDir) {
  return readAllStrict(packDir);
}

export function replaceMemoryArchive(packDir, memories) {
  if (!Array.isArray(memories)) {
    throw new Error('Memory snapshot must be an array.');
  }
  const seenIds = new Set();
  for (const memory of memories) {
    if (!memory || typeof memory !== 'object' || Array.isArray(memory)) {
      throw new Error('Every Memory snapshot entry must be an object.');
    }
    if (typeof memory.id === 'string') {
      if (seenIds.has(memory.id)) {
        throw new Error(`Memory snapshot contains duplicate id ${memory.id}.`);
      }
      seenIds.add(memory.id);
    }
  }
  writeAll(packDir, memories);
}

function activeMemories(packDir) {
  return readAll(packDir).filter(memory => !memory.supersededBy);
}

function timeDecayScore(memory, now = Date.now()) {
  const ageDays = Math.max(0, now - new Date(memory.timestamp).getTime()) / 86400000;
  const decay = Math.exp(-0.01 * ageDays);
  const accessBoost = Math.min(0.2, (memory.accessCount || 0) * 0.02);
  return (memory.importance ?? 0.5) * decay + accessBoost;
}

function queryTerms(query) {
  return String(query || '')
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu)?.filter(term => term.length >= 2) || [];
}

function relevanceScore(memory, terms) {
  if (!terms.length) return 0;
  const haystack = `${memory.content || ''} ${(memory.tags || []).join(' ')}`.toLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 0.25 : 0), 0);
}

export function retrieveMemories(packDir, { query = '', limit = 12, markAccessed = false } = {}) {
  const terms = queryTerms(query);
  const memories = activeMemories(packDir)
    .map(memory => ({
      memory,
      score: timeDecayScore(memory) + relevanceScore(memory, terms)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(item => item.memory);

  if (markAccessed && memories.length) {
    const selectedIds = new Set(memories.map(memory => memory.id));
    const all = readAll(packDir);
    const now = new Date().toISOString();
    for (const memory of all) {
      if (!selectedIds.has(memory.id)) continue;
      memory.accessCount = (memory.accessCount || 0) + 1;
      memory.lastAccessed = now;
    }
    writeAll(packDir, all);
  }

  return memories;
}

export function getMemorySnapshot(packDir, { limit = 50 } = {}) {
  const memories = activeMemories(packDir)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  const summaryCount = memories.filter(isConversationSummary).length;
  const durableMemoryCount = memories.length - summaryCount;
  const tagCounts = new Map();

  for (const memory of memories) {
    for (const tag of memory.tags || []) {
      if (tag === 'conversation-summary'
          || tag === 'milestone'
          || tag === 'relationship'
          || /^interaction-\d+$/.test(tag)) {
        continue;
      }
      tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    }
  }

  return {
    totalMemories: memories.length,
    summaryCount,
    durableMemoryCount,
    topTags: [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([tag, count]) => ({ tag, count })),
    memories: memories.slice(0, limit)
  };
}

export function storeInteractionMemories(packDir, {
  conversationId,
  interactionNumber,
  summary,
  memories
}) {
  const now = new Date().toISOString();
  const newMemories = [
    createMemory({
      type: 'general',
      content: redactDirectContactInfo(summary),
      tags: ['conversation-summary', 'episodic', `interaction-${interactionNumber}`],
      importance: 0.6,
      subject: 'interaction',
      evidence: null,
      timestamp: now,
      conversationId,
      interactionNumber
    }),
    ...memories.map(memory => createMemory({
      ...memory,
      timestamp: now,
      conversationId,
      interactionNumber
    }))
  ];

  writeAll(packDir, [...readAll(packDir), ...newMemories]);
  return newMemories;
}

export function removeMemories(packDir, memoryIds) {
  if (!memoryIds?.length) return;
  const ids = new Set(memoryIds);
  writeAll(packDir, readAll(packDir).filter(memory => !ids.has(memory.id)));
}

export function buildMemoryPrompt(memories) {
  const interactionContinuity = memories
    .filter(isConversationSummary)
    .map(memory => ({ content: memory.content }));
  const durableMemories = memories
    .filter(memory => (
      !isConversationSummary(memory)
      && memory.subject === 'user'
      && typeof memory.evidence === 'string'
      && memory.evidence.trim()
    ))
    .map(memory => ({
      type: memory.type,
      content: memory.content,
      evidence: memory.evidence
    }));

  if (!interactionContinuity.length && !durableMemories.length) {
    return [
      '## Private OpenPersona Memory context',
      'No recalled Memory is available.'
    ].join('\n');
  }

  return [
    '## Private OpenPersona Memory context',
    JSON.stringify({
      interactionContinuity,
      verifiedUserFacts: durableMemories
    }, null, 2)
  ].join('\n');
}

function createMemory(raw) {
  return {
    id: `mem_${crypto.randomBytes(8).toString('hex')}`,
    type: VALID_TYPES.has(raw.type) ? raw.type : 'general',
    content: String(raw.content || '').trim(),
    tags: [...new Set((raw.tags || [])
      .filter(tag => typeof tag === 'string' && tag.trim())
      .map(tag => tag.trim().toLowerCase()))],
    importance: clamp(Number(raw.importance), 0, 1, 0.5),
    subject: raw.subject || 'user',
    evidence: typeof raw.evidence === 'string' && raw.evidence.trim()
      ? raw.evidence.trim()
      : null,
    timestamp: raw.timestamp || new Date().toISOString(),
    accessCount: 0,
    lastAccessed: null,
    conversationId: raw.conversationId,
    interactionNumber: raw.interactionNumber
  };
}

function isConversationSummary(memory) {
  return (memory.tags || []).includes('conversation-summary');
}

function redactDirectContactInfo(value) {
  return String(value || '')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[contact detail]')
    .replace(/\+?\d[\d\s().-]{5,}\d/g, match => (
      (match.match(/\d/g) || []).length >= 7 ? '[contact detail]' : match
    ));
}

function clamp(value, min, max, fallback) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

export { VALID_TYPES };
