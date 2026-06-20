import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { renderTfvars } from './init.ts';

/**
 * Invariant tests: assert that artifacts which MUST agree actually agree.
 * Not behavior tests — these guard against silent cross-file drift, the class of
 * bug where `init` once emitted `game_tcp_ports` after that variable was removed
 * from infra/variables.tf (Terraform ignores unknown keys, so nothing failed).
 */

/** Walk up from this file to the monorepo root (the dir with pnpm-workspace.yaml). */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('repo root not found');
    dir = parent;
  }
}

/** Every `variable "x" {` declared in the Terraform module. */
function declaredTfVars(): Set<string> {
  const tf = readFileSync(join(repoRoot(), 'infra', 'variables.tf'), 'utf8');
  return new Set([...tf.matchAll(/variable\s+"([^"]+)"/g)].map((m) => m[1] as string));
}

/** Every uncommented `key = ...` assignment in an HCL / dotenv-ish body. */
function assignedKeys(body: string): Set<string> {
  return new Set(
    body
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
      .map((l) => l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1])
      .filter((k): k is string => Boolean(k)),
  );
}

const SAMPLE = { project: 'p', region: 'us-central1', zone: 'us-central1-a', sshRange: '0.0.0.0/0' };

describe('init terraform.tfvars generation', () => {
  it('only assigns variables that infra/variables.tf declares', () => {
    const declared = declaredTfVars();
    const undeclared = [...assignedKeys(renderTfvars(SAMPLE))].filter((k) => !declared.has(k));
    expect(undeclared).toEqual([]);
  });
});

describe('infra/terraform.tfvars.example', () => {
  it('only assigns variables that infra/variables.tf declares', () => {
    const declared = declaredTfVars();
    const example = readFileSync(join(repoRoot(), 'infra', 'terraform.tfvars.example'), 'utf8');
    const undeclared = [...assignedKeys(example)].filter((k) => !declared.has(k));
    expect(undeclared).toEqual([]);
  });
});

describe('.env.example', () => {
  it('keeps the vars the CLI requires active (uncommented)', () => {
    // configFromEnv (packages/gcp) hard-requires GCP_PROJECT_ID; GCP_ZONE is the
    // other value init writes and the CLI relies on as its default zone.
    const env = readFileSync(join(repoRoot(), '.env.example'), 'utf8');
    const active = assignedKeys(env);
    for (const required of ['GCP_PROJECT_ID', 'GCP_ZONE']) {
      expect(active).toContain(required);
    }
  });
});
