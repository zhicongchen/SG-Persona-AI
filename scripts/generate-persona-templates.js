import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_DIR = path.join(PROJECT_ROOT, 'openpersona', 'configs');
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

const cli = resolveCli();
const configs = fs.readdirSync(CONFIG_DIR)
  .filter(file => file.endsWith('.json'))
  .sort();

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

for (const file of configs) {
  const configPath = path.join(CONFIG_DIR, file);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const slug = config.soul?.identity?.slug;
  if (!slug) throw new Error(`Missing soul.identity.slug in ${configPath}`);

  execFileSync(
    cli.command,
    [...cli.prefixArgs, 'create', '--config', configPath, '--output', OUTPUT_DIR],
    {
      cwd: PROJECT_ROOT,
      stdio: 'inherit'
    }
  );

  const packDir = path.join(OUTPUT_DIR, `persona-${slug}`);
  fs.writeFileSync(
    path.join(packDir, 'package.json'),
    JSON.stringify({ private: true, type: 'commonjs' }, null, 2) + '\n'
  );
}

console.log(`Generated ${configs.length} OpenPersona templates in ${OUTPUT_DIR}`);
