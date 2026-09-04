import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { seedPolicyPack } from './lib/policy-dataset.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_DIR = path.join(PROJECT_ROOT, 'openpersona', 'configs');
const POLICY_CONFIG_DIR = path.join(CONFIG_DIR, 'policy');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'openpersona', 'templates');
const LOCAL_CLI = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'openpersona');
const WORKSPACE_CLI = path.resolve(PROJECT_ROOT, '..', 'openpersona-trial', 'node_modules', '.bin', 'openpersona');

function resolveCli() {
  if (process.env.OPENPERSONA_CLI) {
    return { command: process.env.OPENPERSONA_CLI, prefixArgs: [] };
  }
  if (fs.existsSync(LOCAL_CLI)) {
    return { command: LOCAL_CLI, prefixArgs: [] };
  }
  if (fs.existsSync(WORKSPACE_CLI)) {
    return { command: WORKSPACE_CLI, prefixArgs: [] };
  }
  return {
    command: 'npx',
    prefixArgs: ['--yes', 'openpersona@0.21.1']
  };
}

function listConfigFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(file => file.endsWith('.json'))
    .sort()
    .map(file => path.join(dir, file));
}

const cli = resolveCli();
const configs = [
  ...listConfigFiles(CONFIG_DIR),
  ...listConfigFiles(POLICY_CONFIG_DIR)
];

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

for (const configPath of configs) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const slug = config.soul?.identity?.slug;
  if (!slug) throw new Error(`Missing soul.identity.slug in ${configPath}`);

  execFileSync(
    cli.command,
    [...cli.prefixArgs, 'create', '--config', configPath, '--output', OUTPUT_DIR],
    {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
      shell: process.platform === 'win32'
    }
  );

  const packDir = path.join(OUTPUT_DIR, `persona-${slug}`);
  fs.writeFileSync(
    path.join(packDir, 'package.json'),
    JSON.stringify({ private: true, type: 'commonjs' }, null, 2) + '\n'
  );

  // Survey-grounded Personas also get their structured attitude profile and
  // their own interview answers written into the pack. No-op for the
  // hand-authored Personas.
  seedPolicyPack(slug, packDir);
}

console.log(`Generated ${configs.length} OpenPersona templates in ${OUTPUT_DIR}`);
