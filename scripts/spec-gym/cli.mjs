#!/usr/bin/env node
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { splitModelSelector } from '../../pi/extensions/spec-runtime/model-selector.mjs';
import { atomicWrite, discoverSkills, indexDrift, loadScenario, validateScenario } from './core.mjs';
import { runCampaign } from './runner.mjs';

// Test plumbing: the integration suite points SPEC_GYM_REPO at a temp gym.
// Production resolves the repository from this script's location.
const repoRoot = process.env.SPEC_GYM_REPO ? resolve(process.env.SPEC_GYM_REPO) : resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const skillsDir = join(repoRoot, 'skills');
const scenariosRoot = join(repoRoot, 'scenarios');

const USAGE = `Usage: spec-gym <command> [options]

Commands:
  list      List eligible skills and their scenarios
  validate  Check scenario contracts and generated indexes
  run       Run scenarios against one or more models

Options:
  --skill <name>             Exact spec skill
  --scenario <id>            Scenario id (repeatable)
  --model <selector>         Model selector provider/model[:thinking] (repeatable)
  --editor-model <selector>  Editor model selector
  --scout-model <selector>   Scout model selector
  --repeat <n>               Repetitions per cell (default 1)
  --timeout-ms <n>           Cell deadline in ms (default 1800000)
  --root <dir>               Run directory override
  --pi <path>                Pi executable (default pi)
  --child-extension <path>   Child extension (repeatable)
  --write-index              Write generated indexes during validate
  --help                     Show this help
`;

function scenarioFolders(typeFolder) {
  if (!existsSync(typeFolder)) return [];
  return readdirSync(typeFolder).sort()
    .map(name => join(typeFolder, name))
    .filter(path => statSync(path).isDirectory());
}

function scenarioRows(typeFolder) {
  return scenarioFolders(typeFolder)
    .map(folder => loadScenario(folder))
    .sort((a, b) => (a.scenario.id < b.scenario.id ? -1 : a.scenario.id > b.scenario.id ? 1 : 0));
}

function selectedSkills(values, eligible) {
  return values.skill ? [values.skill] : eligible;
}

function list(values) {
  const eligible = discoverSkills(skillsDir);
  let failed = false;
  for (const skill of selectedSkills(values, eligible)) {
    if (!eligible.includes(skill)) {
      process.stderr.write(`skill not eligible: ${skill}\n`);
      failed = true;
      continue;
    }
    const rows = scenarioRows(join(scenariosRoot, skill));
    if (!rows.length) {
      process.stdout.write(`${skill}: no curated scenarios\n`);
      continue;
    }
    for (const { scenario, version } of rows) {
      process.stdout.write(`${skill}: ${scenario.id} ${scenario.status} ${String(version).slice(0, 12)} ${scenario.driver}\n`);
    }
  }
  return failed ? 1 : 0;
}

function validate(values) {
  const eligible = discoverSkills(skillsDir);
  let failed = false;
  for (const skill of selectedSkills(values, eligible)) {
    if (!eligible.includes(skill)) {
      process.stderr.write(`skill not eligible: ${skill}\n`);
      failed = true;
      continue;
    }
    const typeFolder = join(scenariosRoot, skill);
    const indexPath = join(typeFolder, 'scenarios.md');
    const drift = indexDrift(skill, typeFolder);
    if (!drift.same) {
      if (values['write-index']) {
        atomicWrite(indexPath, drift.expected);
      } else {
        process.stderr.write(`index drift: ${indexPath}\n`);
        failed = true;
      }
    }
    for (const folder of scenarioFolders(typeFolder)) {
      const result = validateScenario(folder);
      if (!result.ok) {
        for (const error of result.errors) process.stderr.write(`${error}\n`);
        failed = true;
      }
    }
  }
  return failed ? 1 : 0;
}

async function run(values) {
  if (!values.skill) {
    process.stderr.write('run requires --skill\n');
    return 2;
  }
  const scenarioIds = values.scenario ?? [];
  if (!scenarioIds.length) {
    process.stderr.write('run requires at least one --scenario\n');
    return 2;
  }
  const models = values.model ?? [];
  if (!models.length) {
    process.stderr.write('run requires at least one --model\n');
    return 2;
  }
  const roles = {};
  if (values['editor-model'] !== undefined) roles.editor_model = values['editor-model'];
  if (values['scout-model'] !== undefined) roles.scout_model = values['scout-model'];
  for (const selector of [...models, ...Object.values(roles)]) {
    try {
      splitModelSelector(selector);
    } catch {
      process.stderr.write(`invalid model selector: ${selector}\n`);
      return 2;
    }
  }
  const scenarios = scenarioIds.map(id => join(scenariosRoot, values.skill, id));
  try {
    const record = await runCampaign({
      repoRoot,
      root: values.root,
      skill: values.skill,
      scenarios,
      models,
      roles,
      timeoutMs: values['timeout-ms'] !== undefined ? Number(values['timeout-ms']) : 1800000,
      repeats: values.repeat !== undefined ? Number(values.repeat) : 1,
      childExtensions: values['child-extension'] ?? [],
      pi: values.pi ?? 'pi',
    }, { log: line => process.stdout.write(`${line}\n`) });
    return record.cells.some(cell => cell.outcome === 'invalid') ? 1 : 0;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
}

let parsed;
try {
  parsed = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    allowPositionals: true,
    options: {
      help: { type: 'boolean' },
      skill: { type: 'string' },
      scenario: { type: 'string', multiple: true },
      model: { type: 'string', multiple: true },
      'editor-model': { type: 'string' },
      'scout-model': { type: 'string' },
      repeat: { type: 'string' },
      'timeout-ms': { type: 'string' },
      root: { type: 'string' },
      pi: { type: 'string' },
      'child-extension': { type: 'string', multiple: true },
      'write-index': { type: 'boolean' },
    },
  });
} catch (error) {
  process.stderr.write(`${error.message}\n\n${USAGE}`);
  process.exit(2);
}

const command = parsed.positionals[0];
if (parsed.values.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}
if (!command) {
  process.stderr.write(USAGE);
  process.exit(2);
}
if (!['list', 'validate', 'run'].includes(command)) {
  process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
  process.exit(2);
}

const code = command === 'list' ? list(parsed.values) : command === 'validate' ? validate(parsed.values) : await run(parsed.values);
process.exit(code);
