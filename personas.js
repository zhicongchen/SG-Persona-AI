import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.join(PROJECT_ROOT, 'openpersona', 'configs');
const TEMPLATE_DIR = path.join(PROJECT_ROOT, 'openpersona', 'templates');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function cleanMarkdown(markdown) {
  return markdown.replace(/<!--.*?-->/gs, '').trim();
}

function readMarkdownIfPresent(file) {
  return fs.existsSync(file)
    ? cleanMarkdown(fs.readFileSync(file, 'utf-8'))
    : '';
}

function identityPrompt(persona) {
  return [
    'Adopt the following persona identity consistently throughout the conversation:',
    persona.personaName ? `Name: ${persona.personaName}` : null,
    persona.bio ? `Background: ${persona.bio}` : null,
    persona.personality ? `Core personality: ${persona.personality}` : null,
    persona.speakingStyle ? `Speaking style: ${persona.speakingStyle}` : null,
    'Use this background when answering personal or situational questions, while following the safety and self-awareness rules below.'
  ].filter(Boolean).join('\n');
}

function markdownSection(markdown, heading) {
  const marker = `## ${heading}`;
  const start = markdown.indexOf(marker);
  if (start === -1) return '';
  const nextHeading = markdown.indexOf('\n## ', start + marker.length);
  return markdown.slice(start, nextHeading === -1 ? undefined : nextHeading).trim();
}

function removeMarkdownSection(markdown, heading) {
  const section = markdownSection(markdown, heading);
  return section ? markdown.replace(section, '').replace(/\n{3,}/g, '\n\n').trim() : markdown;
}

function chatInjection(injection) {
  const bodyMarker = '\n#### Body';
  const bodyStart = injection.indexOf(bodyMarker);
  return (bodyStart === -1 ? injection : injection.slice(0, bodyStart)).trim();
}

function relationshipBehavior(injection) {
  const marker = '**Behavior by stage:**';
  const start = injection.indexOf(marker);
  if (start === -1) return '';
  return [
    '## OpenPersona relationship behavior',
    injection.slice(start).trim()
  ].join('\n');
}

function memoryRecallProtocol(memoryReference) {
  return [
    markdownSection(memoryReference, 'When to Recall (Automatic)'),
    markdownSection(memoryReference, 'Privacy & Safety')
  ].filter(Boolean).join('\n\n');
}

function statePrompt(state) {
  if (!state) return null;

  const currentState = {
    relationship: {
      stage: state.relationship?.stage || 'stranger',
      interactionCount: state.relationship?.interactionCount || 0
    },
    mood: state.mood,
    evolvedTraits: state.evolvedTraits || [],
    speakingStyleDrift: state.speakingStyleDrift,
    interests: state.interests || {}
  };

  return [
    '## Current OpenPersona State',
    JSON.stringify(currentState, null, 2)
  ].join('\n');
}

export function loadPersonaPack(packDir) {
  const personaFile = path.join(packDir, 'persona.json');
  const injectionFile = path.join(packDir, 'soul', 'injection.md');
  const constitutionFile = path.join(packDir, 'soul', 'constitution.md');
  const memoryReferenceFile = path.join(packDir, 'references', 'memory.md');
  const stateFile = path.join(packDir, 'state.json');

  if (!fs.existsSync(personaFile) || !fs.existsSync(injectionFile)) {
    throw new Error(`Invalid OpenPersona pack: ${packDir}`);
  }

  const persona = readJson(personaFile);
  const constitution = readMarkdownIfPresent(constitutionFile);
  const injection = readMarkdownIfPresent(injectionFile);
  const memoryReference = readMarkdownIfPresent(memoryReferenceFile);
  const state = fs.existsSync(stateFile) ? readJson(stateFile) : null;
  const prompt = [
    removeMarkdownSection(constitution, '§8. Evolution Ethics'),
    identityPrompt(persona),
    chatInjection(injection),
    relationshipBehavior(injection),
    memoryRecallProtocol(memoryReference),
    statePrompt(state)
  ]
    .filter(Boolean)
    .join('\n\n');

  return {
    name: persona.personaName,
    description: persona.bio || '',
    personality: persona.personality || '',
    speakingStyle: persona.speakingStyle || '',
    prompt,
    packDir,
    state
  };
}

function loadPersona(configFile) {
  const config = readJson(configFile);
  const slug = config.soul?.identity?.slug;
  if (!slug) {
    throw new Error(`Missing soul.identity.slug in ${configFile}`);
  }

  const packDir = path.join(TEMPLATE_DIR, `persona-${slug}`);
  if (!fs.existsSync(packDir)) {
    throw new Error(
      `OpenPersona template for ${slug} is missing. Run: npm run personas:generate`
    );
  }

  return [slug, loadPersonaPack(packDir)];
}

const configFiles = fs.readdirSync(CONFIG_DIR)
  .filter(file => file.endsWith('.json'))
  .sort()
  .map(file => path.join(CONFIG_DIR, file));

const personas = Object.fromEntries(configFiles.map(loadPersona));

export default personas;
