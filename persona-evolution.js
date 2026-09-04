import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { isDeepStrictEqual, promisify } from 'util';
import { Router } from 'express';
import db from './db.js';
import { requireAuth } from './auth.js';
import personas from './personas.js';
import { ensurePersonaInstance } from './persona-instances.js';
import { getConversationForUser } from './conversations.js';
import { callModel } from './llm.js';
import {
  getMemorySnapshot,
  storeInteractionMemories
} from './persona-memory.js';
import {
  capturePersonaCheckpoint,
  restorePersonaFiles
} from './persona-checkpoints.js';
import {
  beginPersonaMutation,
  endPersonaMutation
} from './persona-activity.js';
import {
  getRelationshipMinimums,
  relationshipMinimumForStage,
  saveRelationshipMinimums
} from './persona-settings.js';

const execFileAsync = promisify(execFile);
const router = Router();
const VALID_MEMORY_CANDIDATE_TYPES = new Set([
  'preference',
  'personal_fact',
  'interest_signal',
  'emotional_moment'
]);
const VALID_MEMORY_SUBJECTS = new Set(['user']);
const RESERVED_MEMORY_TAGS = new Set([
  'conversation-summary',
  'interaction_count',
  'milestone',
  'relationship'
]);

router.put('/:personaId/settings', requireAuth, (req, res) => {
  const { personaId } = req.params;
  if (!personas[personaId]) {
    return res.status(404).json({ error: 'Persona not found.' });
  }

  try {
    const minimums = saveRelationshipMinimums(
      req.session.userId,
      personaId,
      req.body?.relationshipMinimums
    );
    res.json({ relationshipMinimums: minimums });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:personaId/end-interaction', requireAuth, async (req, res) => {
  const { personaId } = req.params;
  const conversationId = Number(req.body?.conversationId);
  const userId = req.session.userId;

  if (!personas[personaId]) {
    return res.status(404).json({ error: 'Persona not found.' });
  }

  const activity = beginPersonaMutation(userId, personaId);
  if (!activity.ok) {
    const detail = activity.reason === 'chat'
      ? 'Wait for the current reply to finish.'
      : 'Wait for the current Persona update to finish.';
    return res.status(409).json({ error: `Persona is busy. ${detail}` });
  }

  try {
    const conversation = getConversationForUser(conversationId, userId);
    if (!conversation || conversation.personaId !== personaId) {
      return res.status(404).json({ error: 'Conversation not found.' });
    }

    const lastSettlement = db.prepare(`
      SELECT through_message_id AS throughMessageId
      FROM persona_interactions
      WHERE user_id = ? AND persona_id = ? AND conversation_id = ?
      ORDER BY through_message_id DESC
      LIMIT 1
    `).get(userId, personaId, conversationId);
    const lastProcessedId = lastSettlement?.throughMessageId || 0;

    const messages = db.prepare(`
      SELECT id, role, content, created_at AS createdAt
      FROM messages
      WHERE conversation_id = ? AND role != 'system' AND id > ?
      ORDER BY id
    `).all(conversationId, lastProcessedId);

    if (!messages.length || messages.at(-1).role !== 'assistant') {
      return res.status(400).json({ error: 'There is no completed new exchange to end.' });
    }

    const completedExchanges = countCompletedExchanges(messages);
    if (completedExchanges < 1) {
      return res.status(400).json({ error: 'There is no completed new exchange to end.' });
    }

    const instance = ensurePersonaInstance(userId, personaId);
    const priorMemory = getMemorySnapshot(instance.packDir, { limit: 50 });
    const relationshipMinimums = getRelationshipMinimums(userId, personaId);
    const nextInteractionCount = (instance.state.relationship?.interactionCount || 0) + 1;
    const evaluationContext = {
      completedExchanges,
      relationshipMinimums,
      nextInteractionCount,
      priorMemory,
      personaName: instance.name,
      messages,
      userMessages: messages
        .filter(message => message.role === 'user')
        .map(message => message.content)
    };

    const assessmentMessages = buildInteractionAssessmentMessages(
      instance,
      messages,
      evaluationContext
    );
    const assessment = normalizeInteractionAssessment(
      await requestInteractionAssessment(
        assessmentMessages,
        instance.state,
        evaluationContext
      ),
      instance.state,
      evaluationContext
    );
    const patchMessages = buildEvolutionPatchMessages(
      instance,
      assessment,
      evaluationContext
    );
    const evolution = normalizeDecision(
      await requestEvolutionDecision(
        patchMessages,
        assessment,
        instance.state,
        evaluationContext
      ),
      instance.state,
      evaluationContext,
      assessment
    );
    const settlement = { ...assessment, evolution };
    const appliedPatch = buildAppliedPatch(
      settlement.evolution,
      instance.state,
      settlement.relationshipAssessment
    );
    const interactionNumber = appliedPatch.relationship.interactionCount;
    const originalCheckpoint = capturePersonaCheckpoint(instance.packDir);
    let storedMemories;

    try {
      await writePersonaState(instance.packDir, appliedPatch);
      storedMemories = storeInteractionMemories(instance.packDir, {
        conversationId,
        interactionNumber,
        summary: settlement.summary,
        memories: settlement.memories
      });
      const checkpoint = capturePersonaCheckpoint(instance.packDir);

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
          applied_patch_json,
          state_snapshot_json,
          memory_snapshot_json,
          snapshot_quality
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'exact')
      `).run(
        userId,
        personaId,
        conversationId,
        interactionNumber,
        messages.at(-1).id,
        settlement.summary,
        JSON.stringify(storedMemories.map(memory => memory.id)),
        settlement.evolution.shouldEvolve ? 1 : 0,
        settlement.evolution.reason,
        JSON.stringify({
          relationship: settlement.relationshipAssessment,
          evolution: settlement.evolutionAssessment
        }),
        JSON.stringify(settlement.evolution),
        JSON.stringify(appliedPatch),
        JSON.stringify(checkpoint.state),
        JSON.stringify(checkpoint.memories)
      );
    } catch (err) {
      try {
        restorePersonaFiles(instance.packDir, originalCheckpoint);
      } catch (rollbackError) {
        err.message = `${err.message} Persona file rollback also failed: ${rollbackError.message}`;
      }
      throw err;
    }

    const updatedInstance = ensurePersonaInstance(userId, personaId);
    const durableMemoryCount = storedMemories.filter(memory => (
      !(memory.tags || []).includes('conversation-summary')
    )).length;
    res.json({
      interactionNumber,
      throughMessageId: messages.at(-1).id,
      summary: settlement.summary,
      memories: storedMemories,
      summarySaved: true,
      durableMemoryCount,
      shouldEvolve: settlement.evolution.shouldEvolve,
      reason: settlement.evolution.reason,
      assessment: {
        relationship: settlement.relationshipAssessment,
        evolution: settlement.evolutionAssessment
      },
      patch: appliedPatch,
      state: updatedInstance.state
    });
  } catch (err) {
    console.error('Interaction settlement failed:', err);
    res.status(500).json({ error: `Could not end interaction: ${err.message}` });
  } finally {
    endPersonaMutation(userId, personaId);
  }
});

async function requestInteractionAssessment(messages, currentState, context) {
  let prompt = messages;
  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = parseModelJson(await callModel(prompt, { json: true }));
      const problem = assessmentOutputProblem(raw, currentState, context);
      if (problem) throw new Error(problem);
      return raw;
    } catch (err) {
      lastError = err;
      prompt = [
        ...messages,
        {
          role: 'user',
          content: [
            `Your previous assessment was invalid: ${err.message}`,
            'Evaluate the supplied interaction again and return only the required assessment JSON.',
            'Do not generate the final Persona patch in this step.',
            `Valid message evidence IDs are: ${(context.messages || []).map(message => message.id).join(', ') || 'none'}.`,
            `Valid prior Memory evidence IDs are: ${(context.priorMemory?.memories || []).map(memory => memory.id).join(', ') || 'none'}.`,
            'Every evidence quote must be an exact contiguous substring of the cited source.'
          ].join(' ')
        }
      ];
    }
  }

  throw lastError;
}

function buildInteractionAssessmentMessages(instance, messages, context) {
  const persona = readJson(path.join(instance.packDir, 'persona.json'));
  const injection = fs.readFileSync(
    path.join(instance.packDir, 'soul', 'injection.md'),
    'utf-8'
  );
  const memoryReferenceFile = path.join(instance.packDir, 'references', 'memory.md');
  const memoryReference = fs.existsSync(memoryReferenceFile)
    ? fs.readFileSync(memoryReferenceFile, 'utf-8')
    : '';

  const payload = {
    persona: {
      name: persona.personaName,
      bio: persona.bio,
      personality: persona.personality,
      speakingStyle: persona.speakingStyle,
      evolution: persona.evolution
    },
    currentState: currentStateForEvaluation(instance.state),
    nextInteractionCount: context.nextInteractionCount,
    completedExchangesInThisInteraction: context.completedExchanges,
    relationshipMinimums: context.relationshipMinimums,
    runtimeRelationshipPolicy: buildRuntimeRelationshipPolicy(
      instance.state,
      context
    ),
    priorMemory: context.priorMemory,
    openPersonaGrowthRules: extractGrowthRules(injection),
    openPersonaMemoryRules: extractMemoryAssessmentRules(memoryReference),
    completedInteractionMessages: messages.map(({ id, role, content, createdAt }) => ({
      id,
      role,
      content,
      createdAt
    }))
  };

  return [
    {
      role: 'system',
      content: [
        'You are the evidence-analysis pass for one completed OpenPersona interaction.',
        'Produce a factual summary, durable memory candidates, a relationship assessment, and an assessment of other potential Persona changes.',
        'Do not generate or return the final state patch in this pass.',
        'Use only the supplied interaction and prior memory. Never invent facts or shared history.',
        'The summary must be 1-3 concise, user-centered sentences directly entailed by user messages only. Assistant-proposed details, locations, plans, opinions, or experiences must not appear as facts in the summary, even when the user gives a short acknowledgment.',
        'The summary must preserve the exact strength and uncertainty of every claim. Do not turn liking X into preferring X over Y, and do not turn a question into a fact about the user.',
        'Keep speaker attribution strict: the Persona\'s biography, location, statements, preferences, and answers must never become user facts in the summary or Memory.',
        'Memory candidates must be atomic user facts worth recalling across interactions: explicit preferences, personal facts, recurring-topic signals, or emotional moments.',
        'Each memory candidate must have subject="user" and evidence containing an exact, contiguous quote from a user message.',
        'Every memory content field must be directly entailed by its evidence quote alone. It may paraphrase conservatively but must not add a location, comparison, cause, identity, emotion, intention, or certainty that the quote does not state.',
        'Do not store plans to meet the Persona, appointments with the Persona, role-play scenes, assistant proposals, or alleged shared physical experiences.',
        'A user asking where the Persona lives is not evidence of where the user lives. A user liking a cuisine is not evidence that they prefer it over another cuisine.',
        'Never return facts about the Persona as user Memory, even when the Persona mentioned them during the interaction.',
        'Never return milestone memories. The host creates milestones only after a real relationship-stage transition.',
        'If the user messages contain only greetings, farewells, thanks, or ordinary wellbeing small talk, memories must be [].',
        'Do not label a brief greeting or farewell as rude, abrupt, impolite, or emotionally meaningful, and do not infer response timing from a combined greeting/farewell message.',
        'Do not store filler, unsupported inference, passwords, credentials, or secrets.',
        'Use stable, concise lowercase tags so repeated topics can be counted across interactions.',
        'Follow the supplied OpenPersona growth rules, immutable boundaries, and configured relationship minimums exactly.',
        'runtimeRelationshipPolicy is authoritative for numeric interaction thresholds and replaces any default numeric threshold omitted from openPersonaGrowthRules.',
        'A stranger can become an acquaintance only when this interaction contains at least 3 meaningful completed exchanges and the user shared something personal.',
        'An acquaintance can become a friend only when the next interaction count reaches its configured minimum and prior/current evidence shows recurring topics plus warmth or mutual humor.',
        'Relationship stages may advance only one step at a time.',
        'Cite evidence using an exact quote and its message ID. Prior Memory evidence may cite a memory ID and an exact quote from that memory.',
        'Relationship assessment must explicitly say whether the relationship should advance and name the next stage when true.',
        'For other evolution dimensions, recommend complete, mutually consistent values. A mood recommendation must include both current and intensity.',
        'suggestedChanges must contain only dimensions that should actually change; when shouldChange is false it must be {}.',
        'All four top-level keys are mandatory: summary, memories, relationshipAssessment, and evolutionAssessment. Never omit a section.',
        'Return exactly one JSON object and no markdown.',
        'Required shape:',
        '{"summary":"...","memories":[{"content":"...","subject":"user","evidence":"exact quote from one user message","type":"preference|personal_fact|interest_signal|emotional_moment","tags":["..."],"importance":0.0}],"relationshipAssessment":{"shouldAdvance":boolean,"nextStage":"acquaintance|friend|close_friend|intimate|null","reason":"...","evidence":[{"source":"message|memory","id":"message id or memory id","quote":"exact quote","supports":"..."}]},"evolutionAssessment":{"shouldChange":boolean,"reason":"...","suggestedChanges":{"mood":{"current":"...","intensity":0.0},"evolvedTraits":[],"speakingStyleDrift":{},"interests":{}},"evidence":[{"source":"message|memory","id":"...","quote":"...","supports":"..."}]}}'
      ].join('\n')
    },
    {
      role: 'user',
      content: JSON.stringify(payload, null, 2)
    }
  ];
}

function normalizeInteractionAssessment(raw, currentState, context) {
  if (!isPlainObject(raw) || typeof raw.summary !== 'string' || !raw.summary.trim()) {
    throw new Error('Settlement model did not return a valid interaction summary.');
  }

  const memories = Array.isArray(raw.memories)
    ? raw.memories
      .filter(memory => isValidMemoryCandidate(memory, context))
      .slice(0, 8)
      .map(memory => ({
        content: memory.content.trim().slice(0, 500),
        subject: memory.subject,
        evidence: memory.evidence.trim().slice(0, 500),
        type: VALID_MEMORY_CANDIDATE_TYPES.has(memory.type) ? memory.type : 'general',
        tags: Array.isArray(memory.tags)
          ? memory.tags
            .filter(tag => typeof tag === 'string' && tag.trim())
            .map(tag => tag.trim().toLowerCase())
            .filter(tag => !RESERVED_MEMORY_TAGS.has(tag)
              && !/^interaction-\d+$/.test(tag))
            .slice(0, 8)
          : [],
        importance: clamp(Number(memory.importance), 0, 1, 0.5)
      }))
    : [];

  return {
    summary: raw.summary.trim().slice(0, 1200),
    memories,
    relationshipAssessment: normalizeRelationshipAssessment(
      raw.relationshipAssessment,
      currentState,
      context
    ),
    evolutionAssessment: normalizeEvolutionAssessment(
      raw.evolutionAssessment,
      currentState,
      context
    )
  };
}

function assessmentOutputProblem(raw, currentState, context) {
  if (!isPlainObject(raw) || typeof raw.summary !== 'string' || !raw.summary.trim()) {
    return 'summary must be a non-empty string.';
  }
  if (!Array.isArray(raw.memories)) return 'memories must be an array.';
  if (!isPlainObject(raw.relationshipAssessment)
      || typeof raw.relationshipAssessment.shouldAdvance !== 'boolean'
      || typeof raw.relationshipAssessment.reason !== 'string'
      || !Array.isArray(raw.relationshipAssessment.evidence)) {
    return 'relationshipAssessment must contain shouldAdvance, reason, and evidence.';
  }
  if (!isPlainObject(raw.evolutionAssessment)
      || typeof raw.evolutionAssessment.shouldChange !== 'boolean'
      || typeof raw.evolutionAssessment.reason !== 'string'
      || !isPlainObject(raw.evolutionAssessment.suggestedChanges)
      || !Array.isArray(raw.evolutionAssessment.evidence)) {
    return 'evolutionAssessment must contain shouldChange, reason, suggestedChanges, and evidence.';
  }

  if (raw.relationshipAssessment.shouldAdvance) {
    const expectedStage = nextRelationshipStage(currentState.relationship?.stage);
    if (!expectedStage || raw.relationshipAssessment.nextStage !== expectedStage) {
      return `relationshipAssessment.nextStage must be ${expectedStage || 'null'}.`;
    }
    const blockReason = relationshipStageBlockReason(expectedStage, currentState, context);
    if (!blockReason
        && !normalizeGroundedEvidence(raw.relationshipAssessment.evidence, context).length) {
      return 'a relationship advance requires at least one grounded evidence citation.';
    }
  }

  // A shouldChange flag that disagrees with suggestedChanges is not unusable
  // output: normalizeEvolutionAssessment resolves the pair by requiring both an
  // affirmative flag and a change that survives sanitizePatch, and clears
  // suggestedChanges otherwise. Rejecting the mismatch here would instead
  // discard the summary, Memory and relationship assessment produced by the
  // same pass, so this validator only enforces what normalization cannot fix.
  const invalidSuggestedKeys = Object.keys(raw.evolutionAssessment.suggestedChanges)
    .filter(key => !['mood', 'evolvedTraits', 'speakingStyleDrift', 'interests'].includes(key));
  if (invalidSuggestedKeys.length) {
    return `suggestedChanges contains unsupported keys: ${invalidSuggestedKeys.join(', ')}.`;
  }
  if (isPlainObject(raw.evolutionAssessment.suggestedChanges.mood)) {
    const mood = raw.evolutionAssessment.suggestedChanges.mood;
    if (typeof mood.current !== 'string'
        || !mood.current.trim()
        || !Number.isFinite(mood.intensity)
        || mood.intensity < 0
        || mood.intensity > 1) {
      return 'suggested mood change must include both current and intensity from 0 to 1.';
    }
  }
  if (raw.evolutionAssessment.shouldChange) {
    // Changes that sanitize away are coherent output, not malformed: the model
    // named a mood, trait or interest the Persona already holds, so nothing is
    // left to apply. That is a no-op, and normalizeEvolutionAssessment collapses
    // it to shouldChange:false. Failing the settlement here instead would throw
    // away the summary and Memory the same pass produced.
    const effectiveChanges = sanitizePatch(
      raw.evolutionAssessment.suggestedChanges,
      currentState,
      context
    );
    if (Object.keys(effectiveChanges).length
        && !normalizeGroundedEvidence(raw.evolutionAssessment.evidence, context).length) {
      return 'an evolution change requires at least one grounded evidence citation.';
    }
  }

  return null;
}

function normalizeRelationshipAssessment(raw, currentState, context) {
  const currentStage = currentState.relationship?.stage || 'stranger';
  const expectedStage = nextRelationshipStage(currentStage);
  const evidence = normalizeGroundedEvidence(raw?.evidence, context);
  const requestedAdvance = raw?.shouldAdvance === true;
  const blockReason = requestedAdvance && expectedStage
    ? relationshipStageBlockReason(expectedStage, currentState, context)
    : null;
  const shouldAdvance = Boolean(
    requestedAdvance
    && expectedStage
    && raw?.nextStage === expectedStage
    && evidence.length
    && !blockReason
  );
  let reason = typeof raw?.reason === 'string' && raw.reason.trim()
    ? raw.reason.trim()
    : shouldAdvance
      ? `Evidence supports advancing from ${currentStage} to ${expectedStage}.`
      : `Evidence does not support advancing beyond ${currentStage}.`;
  if (blockReason) reason = `${reason} ${blockReason}`;

  return {
    shouldAdvance,
    fromStage: currentStage,
    nextStage: shouldAdvance ? expectedStage : null,
    reason,
    evidence
  };
}

function normalizeEvolutionAssessment(raw, currentState, context) {
  const suggestedChanges = isPlainObject(raw?.suggestedChanges)
    ? { ...raw.suggestedChanges }
    : {};
  delete suggestedChanges.relationship;
  // Suggestions the Persona already satisfies patch to nothing. Treat that as
  // "no change supported" so the second pass and the patch consistency checks
  // all agree, rather than asking for a change that cannot be applied.
  const hasEffectiveChange = Object.keys(suggestedChanges).length > 0
    && Object.keys(sanitizePatch(suggestedChanges, currentState, context)).length > 0;
  const shouldChange = raw?.shouldChange === true && hasEffectiveChange;

  return {
    shouldChange,
    reason: typeof raw?.reason === 'string' && raw.reason.trim()
      ? raw.reason.trim()
      : shouldChange
        ? 'Evidence supports a Persona state change.'
        : 'No other Persona state change is supported.',
    suggestedChanges: shouldChange ? suggestedChanges : {},
    evidence: normalizeGroundedEvidence(raw?.evidence, context)
  };
}

function normalizeGroundedEvidence(rawEvidence, context) {
  if (!Array.isArray(rawEvidence)) return [];

  return rawEvidence.flatMap(item => {
    if (!isPlainObject(item)
        || !['message', 'memory'].includes(item.source)
        || typeof item.quote !== 'string'
        || !item.quote.trim()) {
      return [];
    }

    const sources = item.source === 'message'
      ? (context.messages || []).filter(candidate => candidate.role === 'user')
      : (context.priorMemory?.memories || []).filter(memory => (
        memory.subject === 'user'
        && typeof memory.evidence === 'string'
        && memory.evidence.trim()
      ));
    const normalizedQuote = normalizeEvidence(item.quote);
    let source = sources.find(candidate => (
      String(candidate.id) === String(item.id)
      && normalizeEvidence(candidate.content).includes(normalizedQuote)
    ));
    if (!source) {
      const quoteMatches = sources.filter(candidate => (
        normalizeEvidence(candidate.content).includes(normalizedQuote)
      ));
      if (quoteMatches.length !== 1) return [];
      [source] = quoteMatches;
    }
    if (!source?.content) {
      return [];
    }

    return [{
      source: item.source,
      id: String(source.id),
      quote: item.quote.trim().slice(0, 500),
      supports: typeof item.supports === 'string'
        ? item.supports.trim().slice(0, 300)
        : ''
    }];
  }).slice(0, 12);
}

function isValidMemoryCandidate(memory, context) {
  if (!isPlainObject(memory)
      || typeof memory.content !== 'string'
      || !memory.content.trim()
      || !VALID_MEMORY_SUBJECTS.has(memory.subject)
      || typeof memory.evidence !== 'string'
      || !memory.evidence.trim()
      || !VALID_MEMORY_CANDIDATE_TYPES.has(memory.type)) {
    return false;
  }

  const evidence = normalizeEvidence(memory.evidence);
  const importance = Number(memory.importance);
  if (!Number.isFinite(importance) || importance < 0.2) return false;
  if (memory.type === 'emotional_moment' && importance < 0.5) return false;
  if (isFillerOnlyEvidence(evidence)) return false;
  if (containsDirectContactInfo(evidence) || containsDirectContactInfo(memory.content)) {
    return false;
  }

  const grounded = (context.userMessages || []).some(message => (
    normalizeEvidence(message).includes(evidence)
  ));
  if (!grounded) return false;

  const personaName = normalizeEvidence(context.personaName || '');
  const content = normalizeEvidence(memory.content);
  const evidenceMentionsPersona = personaName && evidence.includes(personaName);
  if (personaName && content.includes(personaName) && !evidenceMentionsPersona) {
    return false;
  }

  return true;
}

function normalizeEvidence(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function isFillerOnlyEvidence(evidence) {
  let remaining = evidence
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const fillerPhrases = [
    'nice to meet you',
    'good to see you',
    'how are you',
    'i am okay',
    'i am ok',
    'i am fine',
    'im okay',
    'im ok',
    'im fine',
    'good morning',
    'good afternoon',
    'good evening',
    'thank you',
    'see you',
    'take care',
    'hello',
    'goodbye',
    'thanks',
    'hey',
    'hi',
    'bye',
    'okay',
    'ok',
    '你好',
    '您好',
    '很高兴认识你',
    '再见',
    '拜拜',
    '谢谢',
    '我很好',
    '还好',
    '没事'
  ];

  for (const phrase of fillerPhrases) {
    remaining = remaining
      .replace(new RegExp(`(^|\\s)${phrase.replace(/\s+/g, '\\s+')}($|\\s)`, 'gu'), ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  return remaining.length === 0;
}

function containsDirectContactInfo(value) {
  const text = String(value || '');
  return /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text)
    || (text.match(/\d/g) || []).length >= 7;
}

function buildEvolutionPatchMessages(instance, assessment, context) {
  const persona = readJson(path.join(instance.packDir, 'persona.json'));
  const injection = fs.readFileSync(
    path.join(instance.packDir, 'soul', 'injection.md'),
    'utf-8'
  );
  const payload = {
    persona: {
      name: persona.personaName,
      evolution: persona.evolution
    },
    currentState: currentStateForEvaluation(instance.state),
    nextInteractionCount: context.nextInteractionCount,
    relationshipMinimums: context.relationshipMinimums,
    openPersonaGrowthRules: extractGrowthRules(injection),
    validatedAssessment: {
      relationship: assessment.relationshipAssessment,
      evolution: assessment.evolutionAssessment
    }
  };

  return [
    {
      role: 'system',
      content: [
        'You are the second-pass OpenPersona patch composer.',
        'Use only the validated evidence assessment supplied by the first pass. Do not reanalyze or invent conversation evidence.',
        'Translate supported assessment conclusions into one minimal state patch.',
        'Copy every effective field and value from evolution.suggestedChanges exactly. Do not omit, reinterpret, or adjust those values.',
        'If relationship.shouldAdvance is true, shouldEvolve must be true and patch.relationship.stage must equal relationship.nextStage.',
        'If relationship.shouldAdvance is false, do not include relationship in the patch.',
        'If evolution.shouldChange is false, do not invent other state changes.',
        'A mood patch must always contain both a non-empty current value and an intensity from 0 to 1.',
        'Patch may contain only mood, relationship.stage, evolvedTraits, speakingStyleDrift, and interests.',
        'Do not include eventLog. The host creates deterministic events after validating the state patch.',
        'When no supported change exists, return shouldEvolve=false and patch={}.',
        'Return exactly one JSON object and no markdown.',
        'Required shape:',
        '{"shouldEvolve":boolean,"reason":"brief explanation grounded in the validated assessment","patch":{}}'
      ].join('\n')
    },
    {
      role: 'user',
      content: JSON.stringify(payload, null, 2)
    }
  ];
}

async function requestEvolutionDecision(messages, assessment, currentState, context) {
  let prompt = messages;
  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = parseModelJson(await callModel(prompt, { json: true }));
      const problem = patchDecisionProblem(raw, assessment, currentState, context);
      if (problem) throw new Error(problem);
      return raw;
    } catch (err) {
      lastError = err;
      prompt = [
        ...messages,
        {
          role: 'user',
          content: [
            `Your previous patch was inconsistent with the validated assessment: ${err.message}`,
            'Generate the patch again. Return only the required JSON object.'
          ].join(' ')
        }
      ];
    }
  }

  throw lastError;
}

function patchDecisionProblem(raw, assessment, currentState, context) {
  if (!isPlainObject(raw)
      || typeof raw.shouldEvolve !== 'boolean'
      || typeof raw.reason !== 'string'
      || !isPlainObject(raw.patch)) {
    return 'decision must contain shouldEvolve, reason, and an object patch.';
  }

  const expectedStage = assessment.relationshipAssessment.shouldAdvance
    ? assessment.relationshipAssessment.nextStage
    : null;
  const proposedStage = raw.patch.relationship?.stage;
  if (expectedStage && proposedStage !== expectedStage) {
    return `relationship evidence requires patch.relationship.stage="${expectedStage}".`;
  }
  if (!expectedStage && proposedStage !== undefined) {
    return 'relationship evidence does not support a stage change, so relationship must be omitted.';
  }
  if (proposedStage) {
    const blockReason = relationshipStageBlockReason(proposedStage, currentState, context);
    if (blockReason) return blockReason;
  }

  if (isPlainObject(raw.patch.mood)) {
    if (typeof raw.patch.mood.current !== 'string'
        || !raw.patch.mood.current.trim()
        || !Number.isFinite(raw.patch.mood.intensity)
        || raw.patch.mood.intensity < 0
        || raw.patch.mood.intensity > 1) {
      return 'mood patch must include both current and intensity from 0 to 1.';
    }
  }

  const otherPatchKeys = Object.keys(raw.patch)
    .filter(key => !['relationship', 'eventLog'].includes(key));
  const supportedOtherKeys = new Set(
    Object.keys(assessment.evolutionAssessment.suggestedChanges || {})
  );
  if (!assessment.evolutionAssessment.shouldChange && otherPatchKeys.length) {
    return `other evolution evidence supports no changes, but patch contains ${otherPatchKeys.join(', ')}.`;
  }
  const unsupportedKeys = otherPatchKeys.filter(key => !supportedOtherKeys.has(key));
  if (unsupportedKeys.length) {
    return `patch contains changes not supported by the first-pass assessment: ${unsupportedKeys.join(', ')}.`;
  }

  const expectedOtherPatch = sanitizePatch(
    assessment.evolutionAssessment.suggestedChanges,
    currentState,
    context
  );
  const proposedOtherPatch = sanitizePatch(raw.patch, currentState, context);
  delete expectedOtherPatch.relationship;
  delete expectedOtherPatch.eventLog;
  delete proposedOtherPatch.relationship;
  delete proposedOtherPatch.eventLog;

  const missingKeys = Object.keys(expectedOtherPatch)
    .filter(key => !Object.hasOwn(proposedOtherPatch, key));
  if (missingKeys.length) {
    return `patch is missing first-pass supported changes: ${missingKeys.join(', ')}.`;
  }
  const inconsistentKeys = Object.keys(proposedOtherPatch)
    .filter(key => !isDeepStrictEqual(proposedOtherPatch[key], expectedOtherPatch[key]));
  if (inconsistentKeys.length) {
    return `patch values conflict with the first-pass assessment: ${inconsistentKeys.join(', ')}.`;
  }

  const assessmentHasChanges = Boolean(
    assessment.relationshipAssessment.shouldAdvance
    || assessment.evolutionAssessment.shouldChange
  );
  if (assessmentHasChanges && !raw.shouldEvolve) {
    return 'validated assessment contains supported changes, so shouldEvolve must be true.';
  }
  if (!assessmentHasChanges && raw.shouldEvolve) {
    return 'validated assessment contains no supported changes, so shouldEvolve must be false.';
  }
  if (!raw.shouldEvolve && Object.keys(raw.patch).length > 0) {
    return 'patch must be empty when shouldEvolve is false.';
  }
  if (raw.shouldEvolve && Object.keys(raw.patch).length === 0) {
    return 'patch cannot be empty when shouldEvolve is true.';
  }
  if (raw.shouldEvolve
      && Object.keys(sanitizePatch(raw.patch, currentState, context)).length === 0) {
    return 'patch contains no effective change from the current state.';
  }

  return null;
}

function normalizeDecision(raw, currentState, context, assessment) {
  if (!isPlainObject(raw)) {
    throw new Error('Settlement model did not return a valid evolution decision.');
  }

  const requestedEvolution = raw.shouldEvolve === true;
  const patch = requestedEvolution ? sanitizePatch(raw.patch, currentState, context) : {};
  const proposedStage = raw.patch?.relationship?.stage;
  const stageBlockReason = requestedEvolution
    ? relationshipStageBlockReason(proposedStage, currentState, context)
    : null;

  const eventLog = [];
  if (patch.mood) {
    eventLog.push({
      type: 'mood_shift',
      trigger: assessment.evolutionAssessment.reason,
      delta: `mood changed from ${currentState.mood?.current || 'unknown'} (${currentState.mood?.intensity ?? 'unknown'}) to ${patch.mood.current} (${patch.mood.intensity})`,
      source: 'conversation'
    });
  }
  if (patch.evolvedTraits) {
    const previousTraits = new Set((currentState.evolvedTraits || []).map(String));
    const addedTraits = patch.evolvedTraits.filter(trait => !previousTraits.has(String(trait)));
    eventLog.push({
      type: 'trait_emergence',
      trigger: assessment.evolutionAssessment.reason,
      delta: `added evolved traits: ${addedTraits.join(', ')}`,
      source: 'conversation'
    });
  }
  if (patch.speakingStyleDrift) {
    eventLog.push({
      type: 'speaking_style_drift',
      trigger: assessment.evolutionAssessment.reason,
      delta: `updated speaking style: ${JSON.stringify(patch.speakingStyleDrift)}`,
      source: 'conversation'
    });
  }
  if (patch.interests) {
    eventLog.push({
      type: 'interest_discovery',
      trigger: assessment.evolutionAssessment.reason,
      delta: `updated interests: ${JSON.stringify(patch.interests)}`,
      source: 'conversation'
    });
  }
  if (patch.relationship?.stage && !stageBlockReason) {
    eventLog.push({
      type: 'relationship_signal',
      trigger: assessment.relationshipAssessment.reason,
      delta: `relationship.stage advanced from ${currentState.relationship?.stage || 'stranger'} to ${patch.relationship.stage}`,
      source: 'conversation'
    });
  }
  if (eventLog.length) patch.eventLog = eventLog;

  const shouldEvolve = requestedEvolution && Object.keys(patch).length > 0;
  let reason = typeof raw.reason === 'string' && raw.reason.trim()
    ? raw.reason.trim()
    : shouldEvolve
      ? 'The interaction contains evidence for a Persona state change.'
      : 'No meaningful Persona state change was identified.';
  if (stageBlockReason) reason = `${reason} ${stageBlockReason}`;

  return { shouldEvolve, reason, patch: shouldEvolve ? patch : {} };
}

function sanitizePatch(rawPatch, currentState, context) {
  if (!isPlainObject(rawPatch)) return {};
  const patch = {};

  if (isPlainObject(rawPatch.mood)) {
    const moodCurrent = typeof rawPatch.mood.current === 'string'
      ? rawPatch.mood.current.trim()
      : '';
    const moodIntensity = Number.isFinite(rawPatch.mood.intensity)
      ? clamp(rawPatch.mood.intensity, 0, 1, currentState.mood?.intensity)
      : null;
    if (moodCurrent
        && moodIntensity !== null
        && (moodCurrent !== currentState.mood?.current
          || moodIntensity !== currentState.mood?.intensity)) {
      patch.mood = {
        current: moodCurrent,
        intensity: moodIntensity
      };
    }
  }

  if (isPlainObject(rawPatch.relationship)
      && typeof rawPatch.relationship.stage === 'string'
      && rawPatch.relationship.stage !== currentState.relationship?.stage
      && !relationshipStageBlockReason(rawPatch.relationship.stage, currentState, context)) {
    patch.relationship = { stage: rawPatch.relationship.stage };
  }

  if (Array.isArray(rawPatch.evolvedTraits)) {
    const existingTraits = Array.isArray(currentState.evolvedTraits)
      ? currentState.evolvedTraits
      : [];
    const existingNames = new Set(existingTraits.map(item => (
      typeof item === 'string' ? item : item?.trait || item?.name || ''
    )).filter(Boolean).map(item => item.toLowerCase()));
    const proposedTraits = rawPatch.evolvedTraits
      .filter(item => typeof item === 'string' && item.trim())
      .map(item => item.trim())
      .filter(item => !existingNames.has(item.toLowerCase()));
    if (proposedTraits.length) {
      patch.evolvedTraits = [...existingTraits, ...new Set(proposedTraits)];
    }
  }

  if (isPlainObject(rawPatch.speakingStyleDrift)) {
    const drift = {};
    for (const key of ['formality', 'emoji_frequency', 'verbosity']) {
      if (Number.isFinite(rawPatch.speakingStyleDrift[key])) {
        const value = rawPatch.speakingStyleDrift[key];
        if (value !== currentState.speakingStyleDrift?.[key]) drift[key] = value;
      }
    }
    if (Object.keys(drift).length) patch.speakingStyleDrift = drift;
  }

  if (isPlainObject(rawPatch.interests)) {
    const interests = {};
    for (const [key, value] of Object.entries(rawPatch.interests)) {
      if (!Number.isFinite(value)) continue;
      const normalizedValue = clamp(value, 0, 1, 0);
      if (normalizedValue !== currentState.interests?.[key]) interests[key] = normalizedValue;
    }
    if (Object.keys(interests).length) patch.interests = interests;
  }

  return patch;
}

function relationshipStageBlockReason(proposedStage, currentState, context = {}) {
  if (!proposedStage || proposedStage === currentState.relationship?.stage) return null;

  const stages = ['stranger', 'acquaintance', 'friend', 'close_friend', 'intimate'];
  const currentStage = currentState.relationship?.stage || 'stranger';
  const currentIndex = stages.indexOf(currentStage);
  const proposedIndex = stages.indexOf(proposedStage);

  if (proposedIndex === -1) {
    return `Relationship stage "${proposedStage}" was rejected because it is not a valid OpenPersona stage.`;
  }
  if (currentIndex !== -1 && proposedIndex !== currentIndex + 1) {
    return `Relationship transition ${currentStage} → ${proposedStage} was rejected because stages must advance one step at a time.`;
  }

  if (currentStage === 'stranger' && (context.completedExchanges || 0) < 3) {
    return `Relationship transition stranger → acquaintance was not applied because OpenPersona requires at least 3 meaningful exchanges in the interaction; this interaction contains ${context.completedExchanges || 0} completed exchanges.`;
  }

  const nextInteractionCount = context.nextInteractionCount
    ?? (currentState.relationship?.interactionCount || 0) + 1;
  const minimumInteractions = relationshipMinimumForStage(
    context.relationshipMinimums,
    currentStage
  );
  if (minimumInteractions > 0 && nextInteractionCount < minimumInteractions) {
    return `Relationship transition ${currentStage} → ${proposedStage} was not applied because the configured minimum is ${minimumInteractions} completed interactions; this settlement reaches ${nextInteractionCount}.`;
  }

  return null;
}

function buildAppliedPatch(decision, currentState, relationshipAssessment = null) {
  const now = new Date().toISOString();
  const currentStage = currentState.relationship?.stage || 'stranger';
  const nextInteractionCount = (currentState.relationship?.interactionCount || 0) + 1;
  const relationship = {
    ...(decision.patch.relationship || {}),
    interactionCount: nextInteractionCount,
    lastInteraction: now
  };
  if (!currentState.relationship?.firstInteraction) {
    relationship.firstInteraction = now;
  }
  if (relationship.stage && relationship.stage !== currentStage) {
    relationship.stageHistory = [
      ...(currentState.relationship?.stageHistory || []),
      {
        from: currentStage,
        to: relationship.stage,
        interactionCount: nextInteractionCount,
        timestamp: now,
        reason: relationshipAssessment?.reason || decision.reason
      }
    ];
  }

  return {
    ...decision.patch,
    relationship
  };
}

function nextRelationshipStage(stage) {
  const stages = ['stranger', 'acquaintance', 'friend', 'close_friend', 'intimate'];
  const index = stages.indexOf(stage || 'stranger');
  return index >= 0 && index < stages.length - 1 ? stages[index + 1] : null;
}

function countCompletedExchanges(messages) {
  let pendingUserMessage = false;
  let completed = 0;

  for (const message of messages) {
    if (message.role === 'user') pendingUserMessage = true;
    if (message.role === 'assistant' && pendingUserMessage) {
      completed += 1;
      pendingUserMessage = false;
    }
  }

  return completed;
}

async function writePersonaState(packDir, patch) {
  const script = path.join(packDir, 'scripts', 'state-sync.js');
  await execFileAsync(
    process.execPath,
    [script, 'write', JSON.stringify(patch)],
    { cwd: packDir, maxBuffer: 1024 * 1024 }
  );
}

function currentStateForEvaluation(state) {
  return {
    relationship: state.relationship,
    mood: state.mood,
    evolvedTraits: state.evolvedTraits || [],
    speakingStyleDrift: state.speakingStyleDrift,
    interests: state.interests || {}
  };
}

function extractGrowthRules(injection) {
  const marker = '### How You Grow';
  const start = injection.indexOf(marker);
  const growthRules = start === -1 ? injection : injection.slice(start).trim();
  const criteriaMarker = '**Relationship stage criteria:**';
  const behaviorMarker = '**Behavior by stage:**';
  const criteriaStart = growthRules.indexOf(criteriaMarker);
  const behaviorStart = growthRules.indexOf(behaviorMarker);

  if (criteriaStart === -1 || behaviorStart === -1 || behaviorStart <= criteriaStart) {
    return growthRules;
  }

  return [
    growthRules.slice(0, criteriaStart).trim(),
    growthRules.slice(behaviorStart).trim()
  ].filter(Boolean).join('\n\n');
}

function buildRuntimeRelationshipPolicy(currentState, context) {
  const currentStage = currentState.relationship?.stage || 'stranger';
  const nextStage = nextRelationshipStage(currentStage);
  const minimumCompletedInteractions = relationshipMinimumForStage(
    context.relationshipMinimums,
    currentStage
  );

  return {
    authority: 'user-configured runtime override',
    currentStage,
    nextStage,
    nextInteractionCount: context.nextInteractionCount,
    minimumCompletedInteractions,
    countRequirementMet: minimumCompletedInteractions === 0
      || context.nextInteractionCount >= minimumCompletedInteractions,
    note: 'The count is a minimum gate; OpenPersona qualitative relationship evidence is still required.'
  };
}

function extractMemoryAssessmentRules(memoryReference) {
  return [
    extractMarkdownSection(memoryReference, 'When to Store (Automatic)'),
    extractMarkdownSection(memoryReference, 'Privacy & Safety')
  ].filter(Boolean).join('\n\n');
}

function extractMarkdownSection(markdown, heading) {
  const marker = `## ${heading}`;
  const start = markdown.indexOf(marker);
  if (start === -1) return '';
  const nextHeading = markdown.indexOf('\n## ', start + marker.length);
  return markdown.slice(start, nextHeading === -1 ? undefined : nextHeading).trim();
}

function parseModelJson(output) {
  const cleaned = output.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error('Settlement model did not return a JSON object.');
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clamp(value, min, max, fallback) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

export {
  buildEvolutionPatchMessages,
  buildInteractionAssessmentMessages,
  countCompletedExchanges,
  normalizeInteractionAssessment,
  patchDecisionProblem,
  relationshipStageBlockReason,
  requestEvolutionDecision,
  requestInteractionAssessment
};
export default router;
