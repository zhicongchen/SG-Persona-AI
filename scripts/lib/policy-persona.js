// Deterministic derivation of Persona material from the policy survey dataset
// (data/import/). No LLM is involved: every field traces back to a survey value,
// and re-running the generators produces byte-identical output.
//
// Every Likert item in the dataset is on a 1-7 scale. `patriotism` is a mean of
// several items and can be fractional; everything else is an integer, except
// where a respondent declined to answer (null, or a "Prefer not to answer"
// string). Missing values are skipped, never guessed.

// =========================
// Scale vocabularies
// =========================

const AGREEMENT = [
  'strongly disagrees',
  'disagrees',
  'slightly disagrees',
  'neither agrees nor disagrees',
  'slightly agrees',
  'agrees',
  'strongly agrees'
];

const IMPORTANCE = [
  'not important at all',
  'barely important',
  'slightly important',
  'moderately important',
  'fairly important',
  'very important',
  'extremely important'
];

const SUPPORT = [
  'strongly opposes',
  'opposes',
  'leans against',
  'is neutral on',
  'leans towards',
  'supports',
  'strongly supports'
];

const LEVEL = [
  'very low',
  'low',
  'fairly low',
  'middling',
  'fairly high',
  'high',
  'very high'
];

const FREQUENCY = [
  'never',
  'rarely',
  'occasionally',
  'sometimes',
  'often',
  'usually',
  'always'
];

// Second-person forms, used in the profile the Persona reads about itself.
const AGREEMENT_SELF = [
  'strongly disagree',
  'disagree',
  'slightly disagree',
  'neither agree nor disagree',
  'slightly agree',
  'agree',
  'strongly agree'
];

const SUPPORT_SELF = [
  'strongly oppose',
  'oppose',
  'lean against',
  'are neutral on',
  'lean towards',
  'support',
  'strongly support'
];

export const SCALE_LABELS = {
  AGREEMENT_SELF,
  SUPPORT_SELF,
  AGREEMENT,
  IMPORTANCE,
  SUPPORT,
  LEVEL,
  FREQUENCY
};

// Returns null for anything that is not a usable 1-7 response, so callers can
// omit the line rather than inventing a midpoint.
export function score(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 7
    ? value
    : null;
}

export function label(vocabulary, value) {
  const numeric = score(value);
  if (numeric === null) return null;
  return vocabulary[Math.min(6, Math.max(0, Math.round(numeric) - 1))];
}

function formatScore(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '');
}

// =========================
// Demographics
// =========================

function squash(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

// The dataset is free-text in places, so casing is inconsistent ("chinese",
// "INdonesian"). Normalise the first letter only and leave the rest verbatim.
function sentenceCase(value) {
  const text = squash(value);
  return text ? text[0].toUpperCase() + text.slice(1) : '';
}

function truncate(value, max) {
  const text = squash(value);
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const boundary = cut.lastIndexOf(' ');
  return (boundary > max * 0.6 ? cut.slice(0, boundary) : cut).trimEnd() + '...';
}

const GENDER_LETTER = {
  Female: 'F',
  Male: 'M',
  'Non-binary / third gender': 'NB'
};

// "Prefer not to say" yields no letter rather than a guess.
function genderLetter(gender) {
  return GENDER_LETTER[squash(gender)] || '';
}

function pronouns(gender) {
  const g = squash(gender);
  if (g === 'Female') return { subject: 'She', possessive: 'her' };
  if (g === 'Male') return { subject: 'He', possessive: 'his' };
  return { subject: 'They', possessive: 'their' };
}

// The survey asked these in the second person; reword the fixed options for a
// third-person bio and fall back to the raw text for anything free-typed.
const HOUSING_ARRANGEMENT = {
  'Living with family or relatives': () => 'living with family or relatives',
  'Owned by you or your household': possessive => `in a home owned by ${possessive} household`,
  'Renting the whole unit': () => 'renting the whole unit',
  'Renting a room': () => 'renting a room'
};

function housingArrangement(value, possessive) {
  const text = squash(value);
  if (!text) return null;
  const phrase = HOUSING_ARRANGEMENT[text];
  return phrase ? phrase(possessive) : truncate(text.toLowerCase(), 80);
}

// The residency options read as survey answers rather than descriptions, so
// give each one a form that fits mid-sentence.
const RESIDENCY_PHRASE = {
  'Singapore Citizen': 'Singapore Citizen',
  'Singapore Permanent Resident (PR)': 'Singapore Permanent Resident',
  'None of the above / not currently residing in Singapore':
    'respondent not currently residing in Singapore'
};

function residencyPhrase(value) {
  const text = squash(value);
  if (!text) return 'survey respondent';
  return RESIDENCY_PHRASE[text] || text;
}

function article(word) {
  return /^[aeiou8]/i.test(squash(word)) ? 'an' : 'a';
}

function demographics(profile) {
  return profile.basic_demographics?.demographics || {};
}

// `P001 - 31F Psychologist in rnd`
export function displayName(profile) {
  const d = demographics(profile);
  const bracket = [d.age, genderLetter(d.gender)].filter(Boolean).join('');
  const occupation = truncate(sentenceCase(d.occupation), 30);
  return [profile.persona_id, [bracket, occupation].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(' — ');
}

export function bio(profile) {
  const d = demographics(profile);
  const { subject, possessive } = pronouns(d.gender);
  const income = squash(d.income);
  const sentences = [];

  const descriptor = [
    d.age ? `${d.age}-year-old` : null,
    sentenceCase(d.ethnicity) || null,
    residencyPhrase(d.residency_status)
  ].filter(Boolean).join(' ');
  const opening = `${profile.persona_id} is ${article(descriptor)} ${descriptor}`;
  sentences.push(`${opening}.`);

  if (squash(d.occupation)) {
    sentences.push(`Occupation: ${sentenceCase(d.occupation)}.`);
  }
  if (squash(d.education)) {
    sentences.push(`Education: ${squash(d.education)}.`);
  }

  const housing = [
    squash(d.housing_type) ? `living in ${squash(d.housing_type)} housing` : null,
    housingArrangement(d.housing_arrangement, possessive)
  ].filter(Boolean).join(', ');
  const living = [
    squash(d.marital_status).toLowerCase() || null,
    housing || null
  ].filter(Boolean).join(', ');
  if (living) {
    sentences.push(`${subject} is ${living}.`);
  }

  if (income && /^\$/.test(income)) {
    sentences.push(`${possessive.replace(/^./, c => c.toUpperCase())} monthly household income is ${income}.`);
  } else if (income) {
    sentences.push(`Income status: ${income}.`);
  }

  return sentences.join(' ');
}

// =========================
// Personality and speaking style
// =========================

// Thresholds are deliberately wide (>= 6 / <= 2) so a trait is only asserted
// when the respondent took a clear position.
function trait(value, high, low) {
  const numeric = score(value);
  if (numeric === null) return null;
  if (numeric >= 6) return high;
  if (numeric <= 2) return low;
  return null;
}

export function personalityTraits(profile) {
  const economic = profile.ideology?.economic || {};
  const social = profile.ideology?.social_values || {};
  const reasoning = profile.reasoning_style || {};
  const engagement = profile.political_engagement || {};

  const traits = [
    (score(economic.reduce_income_differences) >= 6
      || score(economic.stronger_social_welfare) >= 6) ? 'redistributive' : null,
    (score(economic.free_market_produces_best_outcomes) >= 6
      || score(economic.fewer_business_regulations) >= 6) ? 'pro-market' : null,
    trait(social.preserve_traditional_values, 'traditionalist', 'socially progressive'),
    trait(social.social_order_over_personal_freedom, 'order-oriented', 'civil-libertarian'),
    trait(social.accept_unconventional_lifestyles, 'accepting of difference', null),
    trait(profile.ideology?.patriotism, 'strongly patriotic', 'unsentimental about national pride'),
    trait(reasoning.evidence?.rely_on_evidence, 'evidence-driven', null),
    trait(reasoning.context_sensitivity?.views_depend_on_context, 'context-sensitive', null),
    trait(reasoning.ideology_driven?.rarely_change_political_views, 'settled in their views', 'open to persuasion'),
    (score(reasoning.absolutism?.compromise_weakens_good_policy) >= 6
      || score(reasoning.absolutism?.prefer_clear_positions_over_tradeoffs) >= 6)
      ? 'firm in their positions'
      : null,
    (score(reasoning.absolutism?.compromise_weakens_good_policy) <= 2
      && score(reasoning.absolutism?.prefer_clear_positions_over_tradeoffs) <= 2)
      ? 'open to compromise'
      : null,
    trait(engagement.trust_in_government, 'trusting of institutions', 'sceptical of institutions'),
    trait(engagement.political_interest, 'politically engaged', 'politically disengaged')
  ].filter(Boolean);

  // Nobody should end up with an empty personality string; a respondent who sat
  // mid-scale on everything is genuinely moderate, so say so.
  return [...new Set(traits.length ? traits : ['moderate', 'even-handed'])];
}

export function speakingStyle(profile) {
  const d = demographics(profile);
  const education = squash(d.education);
  const reasoning = profile.reasoning_style || {};
  const engagement = profile.political_engagement || {};
  const age = Number(d.age);

  let register;
  if (/Doctoral|Master/.test(education)) {
    register = 'precise and analytical';
  } else if (/Bachelor/.test(education)) {
    register = 'articulate and measured';
  } else if (/Diploma|Junior college/.test(education)) {
    register = 'plain and conversational';
  } else {
    register = 'direct and down-to-earth, in everyday Singaporean English';
  }

  const clauses = [`Speaks in ${article(register)} ${register} way`];

  if (Number.isFinite(age)) {
    if (age < 30) clauses.push('casual and quick to the point');
    else if (age >= 55) clauses.push('unhurried, often reaching for past experience');
  }

  if (score(reasoning.context_sensitivity?.need_details_before_deciding) >= 6) {
    clauses.push('asks for specifics before committing to a view');
  }

  const discussion = score(engagement.political_discussion);
  if (discussion !== null && discussion >= 6) {
    clauses.push('willing to argue politics openly');
  } else if (discussion !== null && discussion <= 2) {
    clauses.push('reluctant to be drawn into political argument');
  }

  clauses.push('never use emojis or em dashes');
  return clauses.join('; ') + '.';
}

const POLICY_POSITIONS = [
  ['support_relaxed_immigration', 'relaxing restrictions on low-skilled foreign workers'],
  ['support_higher_tax_on_rich', 'higher taxes on high earners to fund welfare'],
  ['support_stronger_policing', 'stronger policing and public surveillance'],
  ['support_carbon_tax', 'a carbon tax that raises the cost of living'],
  ['support_minority_affirmative_policy', 'stronger policy protections for minority groups']
];

// The position furthest from the 4 midpoint is the one the Persona must never
// drift away from.
function strongestStance(profile) {
  const positions = profile.issue_salience?.observed_policy_positions || {};
  let best = null;
  for (const [key, description] of POLICY_POSITIONS) {
    const value = score(positions[key]);
    if (value === null) continue;
    const distance = Math.abs(value - 4);
    if (!best || distance > best.distance) {
      best = { distance, value, description };
    }
  }
  if (!best || best.distance === 0) return null;
  return `Stance: ${label(SUPPORT, best.value)} ${best.description}`;
}

export function immutableTraits(profile) {
  const d = demographics(profile);
  return [
    d.age ? `Age: ${d.age}` : null,
    squash(d.occupation) ? `Occupation: ${sentenceCase(d.occupation)}` : null,
    squash(d.residency_status) ? `Residency: ${squash(d.residency_status)}` : null,
    strongestStance(profile)
  ]
    .filter(Boolean)
    .map(entry => truncate(entry, 100));
}

// =========================
// Persona config
// =========================

export function slugFor(profile) {
  return `policy-${String(profile.persona_id).toLowerCase()}`;
}

export function buildConfig(profile) {
  return {
    soul: {
      identity: {
        personaName: displayName(profile),
        slug: slugFor(profile),
        bio: bio(profile)
      },
      character: {
        personality: personalityTraits(profile).join(', '),
        speakingStyle: speakingStyle(profile)
      }
    },
    evolution: {
      instance: {
        enabled: true,
        boundaries: {
          immutableTraits: immutableTraits(profile),
          minFormality: -3,
          maxFormality: 7
        },
        relationshipProgression: true,
        moodTracking: true,
        traitEmergence: true,
        speakingStyleDrift: true,
        interestDiscovery: true
      }
    }
  };
}

// =========================
// Structured profile prompt section
// =========================

const ENGAGEMENT_ITEMS = [
  ['political_interest', 'Interest in politics', LEVEL],
  ['news_exposure', 'Attention to political news', LEVEL],
  ['political_discussion', 'Discusses politics with others', LEVEL],
  ['civic_participation', 'Civic participation', LEVEL],
  ['voting_frequency', 'Turns out to vote', FREQUENCY],
  ['trust_in_government', 'Trust in government', LEVEL]
];

const ECONOMIC_ITEMS = [
  ['reduce_income_differences', 'Government should reduce income differences between rich and poor'],
  ['stronger_social_welfare', 'Government should provide stronger social welfare protections'],
  ['fewer_business_regulations', 'Businesses should face fewer government regulations'],
  ['free_market_produces_best_outcomes', 'Free-market competition usually produces the best outcomes']
];

const SOCIAL_ITEMS = [
  ['preserve_traditional_values', 'Society should preserve traditional social values'],
  ['social_order_over_personal_freedom', 'Social order matters more than personal freedom'],
  ['respect_established_authorities', 'People should respect established authorities'],
  ['accept_unconventional_lifestyles', 'Society should be more accepting of unconventional lifestyles']
];

const REASONING_GROUPS = [
  ['evidence', 'Evidence', [
    ['rely_on_evidence', 'You rely on evidence when forming a view'],
    ['prefer_reliable_data', 'You prefer reliable data over anecdote'],
    ['change_views_when_evidence_contradicts', 'You change your view when evidence contradicts it']
  ]],
  ['context_sensitivity', 'Context', [
    ['views_depend_on_context', 'Your view depends on the specific context'],
    ['need_details_before_deciding', 'You need details before deciding'],
    ['policy_may_not_transfer_across_countries', 'You doubt policies transfer cleanly between countries']
  ]],
  ['ideology_driven', 'Principle', [
    ['guided_by_stable_principles', 'You are guided by stable principles'],
    ['decide_based_on_general_ideology', 'You decide from general ideology rather than case by case'],
    ['rarely_change_political_views', 'You rarely change your political views']
  ]],
  ['absolutism', 'Certainty', [
    ['political_issues_have_right_and_wrong_answers', 'You believe political issues have right and wrong answers'],
    ['compromise_weakens_good_policy', 'You believe compromise weakens good policy'],
    ['prefer_clear_positions_over_tradeoffs', 'You prefer clear positions over trade-offs']
  ]]
];

const ISSUES = [
  ['immigration', 'support_relaxed_immigration', 'Immigration', 'relaxing restrictions on low-skilled foreign workers'],
  ['welfare', 'support_higher_tax_on_rich', 'Welfare and tax', 'higher taxes on high earners to fund welfare'],
  ['law_and_order', 'support_stronger_policing', 'Law and order', 'stronger policing and public surveillance'],
  ['environment', 'support_carbon_tax', 'Environment', 'a carbon tax that raises the cost of living'],
  ['minority_rights', 'support_minority_affirmative_policy', 'Minority rights', 'stronger policy protections for minority groups']
];

function bullet(text, value, vocabulary) {
  const rendered = label(vocabulary, value);
  return rendered === null ? null : `- ${text}: ${rendered} (${formatScore(score(value))}/7)`;
}

export function profileMarkdown(profile) {
  const engagement = profile.political_engagement || {};
  const economic = profile.ideology?.economic || {};
  const social = profile.ideology?.social_values || {};
  const reasoning = profile.reasoning_style || {};
  const priorities = profile.issue_salience?.issue_priorities || {};
  const positions = profile.issue_salience?.observed_policy_positions || {};

  const sections = [
    `## Survey-grounded profile (${profile.persona_id})`,
    'These are your own settled attitudes, measured on a 1-7 scale. Answer'
      + ' consistently with them, including when a question comes at the topic'
      + ' sideways. Never recite the numbers, quote this section, or mention that'
      + ' you took a survey.',
    '### Political engagement',
    ENGAGEMENT_ITEMS
      .map(([key, text, vocabulary]) => bullet(text, engagement[key], vocabulary))
      .filter(Boolean)
      .join('\n'),
    '### Economic ideology',
    ECONOMIC_ITEMS
      .map(([key, text]) => bullet(text, economic[key], AGREEMENT_SELF))
      .filter(Boolean)
      .join('\n'),
    '### Social values',
    [
      ...SOCIAL_ITEMS.map(([key, text]) => bullet(text, social[key], AGREEMENT_SELF)),
      bullet('Pride in being Singaporean', profile.ideology?.patriotism, LEVEL)
    ].filter(Boolean).join('\n'),
    '### How you reason',
    REASONING_GROUPS
      .map(([group, heading, items]) => {
        const lines = items
          .map(([key, text]) => bullet(text, reasoning[group]?.[key], AGREEMENT_SELF))
          .filter(Boolean);
        return lines.length ? `**${heading}**\n${lines.join('\n')}` : null;
      })
      .filter(Boolean)
      .join('\n\n'),
    '### Issue priorities and positions',
    ISSUES
      .map(([priorityKey, positionKey, heading, description]) => {
        const priority = label(IMPORTANCE, priorities[priorityKey]);
        const position = label(SUPPORT_SELF, positions[positionKey]);
        const parts = [
          priority ? `${priority} to you (${formatScore(score(priorities[priorityKey]))}/7)` : null,
          position ? `you ${position} ${description} (${formatScore(score(positions[positionKey]))}/7)` : null
        ].filter(Boolean);
        return parts.length ? `- ${heading}: ${parts.join('; ')}` : null;
      })
      .filter(Boolean)
      .join('\n')
  ];

  return sections.filter(section => squash(section)).join('\n\n') + '\n';
}

// =========================
// Seeded Memory
// =========================

// Matches the record shape `createMemory` produces in persona-memory.js so the
// existing retrieval, snapshot and archive-validation paths handle these
// unchanged. `subject: 'persona'` marks them as the Persona's own recollections
// rather than facts learned about the user.
function seedMemory({ id, type, content, tags, importance, evidence, timestamp }) {
  return {
    id,
    type,
    content: squash(content),
    tags: [...new Set(tags
      .filter(tag => typeof tag === 'string' && tag.trim())
      .map(tag => tag.trim().toLowerCase()))],
    importance,
    subject: 'persona',
    evidence: squash(evidence) || null,
    timestamp,
    accessCount: 0,
    lastAccessed: null,
    conversationId: null,
    interactionNumber: 0
  };
}

export function seedMemories(personaId, chunks, events, timestamp) {
  const interviews = chunks.map(chunk => seedMemory({
    id: `seed_${chunk.chunk_id}`,
    type: 'general',
    content: chunk.answer,
    tags: [...(chunk.topic || []), 'interview', `stance-${chunk.stance_hint || 'unstated'}`],
    importance: typeof chunk.confidence === 'number' ? chunk.confidence : 0.9,
    evidence: chunk.question,
    timestamp
  }));

  const experiences = events.map(event => seedMemory({
    id: `seed_${event.memory_id}`,
    type: 'personal_fact',
    content: event.text,
    tags: [...(event.tags || []), ...(event.affected_topics || []), 'lived-experience'],
    importance: 0.85,
    evidence: event.experience_type,
    timestamp
  }));

  return [...interviews, ...experiences];
}
