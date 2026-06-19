import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as p from '@clack/prompts';
import { writeConfig } from './config.ts';

/**
 * `onehost init` — interactive first-run bootstrap. On a fresh clone, one command
 * stands up the two hand-edited files: the repo-root `.env` (so the CLI knows your
 * project/zone) and `infra/terraform.tfvars` (so Terraform knows what to build).
 *
 * Choices come from the local gcloud install where possible (projects, regions,
 * zones); if a list call fails — gcloud missing, compute API not yet enabled — it
 * degrades to a plain text prompt rather than dying. Non-destructive: an existing
 * file is shown and confirmed before it's overwritten.
 *
 * Scope is deliberately the base infra + CLI config. The Discord
 * bot / control-plane vars stay commented in the generated tfvars; turn them on by
 * editing the file per SETUP.md once you have a Discord app.
 */
export async function runInit(): Promise<void> {
  p.intro('OneHost first-run setup');

  const project = await pickProject();
  const region = await pickRegion(project);
  const zone = await pickZone(project, region);
  const sshRange = await askSshRange();
  const tcpPorts = await askPorts('TCP', '25565');
  const udpPorts = await askPorts('UDP', '');

  // --- .env (CLI config) — merged, never clobbers other keys ----------------
  const envPath = writeConfig({ GCP_PROJECT_ID: project, GCP_ZONE: zone });
  p.log.success(`wrote ${rel(envPath)}  (GCP_PROJECT_ID, GCP_ZONE)`);

  // --- infra/terraform.tfvars — confirm before overwriting ------------------
  const tfvarsPath = join(repoRoot(), 'infra', 'terraform.tfvars');
  if (existsSync(tfvarsPath)) {
    p.log.warn(`${rel(tfvarsPath)} already exists:`);
    p.log.message(readFileSync(tfvarsPath, 'utf8').trimEnd());
    const overwrite = await p.confirm({ message: 'Overwrite it?', initialValue: false });
    if (p.isCancel(overwrite) || !overwrite) {
      p.log.info('Left terraform.tfvars untouched.');
    } else {
      writeFileSync(tfvarsPath, renderTfvars({ project, region, zone, sshRange, tcpPorts, udpPorts }));
      p.log.success(`wrote ${rel(tfvarsPath)}`);
    }
  } else {
    writeFileSync(tfvarsPath, renderTfvars({ project, region, zone, sshRange, tcpPorts, udpPorts }));
    p.log.success(`wrote ${rel(tfvarsPath)}`);
  }

  p.note(
    [
      'gcloud auth application-default login   # creds the Node client uses',
      'pnpm setup                              # enable APIs + image registry',
      'cd infra && terraform init && terraform apply && cd ..',
      'pnpm cli create mc --port tcp:25565     # then SSH in + install your game',
    ].join('\n'),
    'Next steps',
  );
  p.outro('Done. Edit infra/terraform.tfvars to turn on the Discord bot (see SETUP.md).');
}

// --- pickers ----------------------------------------------------------------

async function pickProject(): Promise<string> {
  const rows = gcloudJson<{ projectId: string; name?: string }>(['projects', 'list']);
  if (!rows || rows.length === 0) return cancelable(await text('GCP project id', 'your-gcp-project-id'));
  const choice = await p.select({
    message: 'GCP project',
    options: rows.map((r) => ({ value: r.projectId, label: r.projectId, ...(r.name ? { hint: r.name } : {}) })),
  });
  return cancelable(choice);
}

async function pickRegion(project: string): Promise<string> {
  const rows = gcloudJson<{ name: string }>(['compute', 'regions', 'list', '--project', project]);
  if (!rows || rows.length === 0) {
    // compute API may not be enabled yet — fall back to free text.
    return cancelable(await text('Region', 'us-central1'));
  }
  const def = rows.find((r) => r.name === 'us-central1')?.name;
  const choice = await p.select({
    message: 'Region (where the network/firewall + control plane live)',
    options: rows.map((r) => ({ value: r.name, label: r.name })).sort((a, b) => a.label.localeCompare(b.label)),
    ...(def ? { initialValue: def } : {}),
  });
  return cancelable(choice);
}

async function pickZone(project: string, region: string): Promise<string> {
  const rows = gcloudJson<{ name: string }>([
    'compute', 'zones', 'list', '--project', project, '--filter', `region:${region}`,
  ]);
  if (!rows || rows.length === 0) return cancelable(await text('Default zone for new servers', `${region}-a`));
  const def = rows.find((r) => r.name === `${region}-a`)?.name;
  const choice = await p.select({
    message: 'Default zone for new servers',
    options: rows.map((r) => ({ value: r.name, label: r.name })),
    ...(def ? { initialValue: def } : {}),
  });
  return cancelable(choice);
}

async function askSshRange(): Promise<string> {
  const ip = await currentPublicIp();
  const def = ip ? `${ip}/32` : '0.0.0.0/0';
  const value = await p.text({
    message: 'CIDR allowed to SSH in (lock this to your IP)',
    initialValue: def,
    placeholder: def,
  });
  return cancelable(value);
}

async function askPorts(proto: 'TCP' | 'UDP', def: string): Promise<string[]> {
  const value = await p.text({
    message: `${proto} game ports (comma-separated, ranges OK e.g. 2456-2458)`,
    initialValue: def,
    placeholder: def || '(none)',
  });
  const raw = cancelable(value).trim();
  return raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

// --- file rendering ---------------------------------------------------------

function renderTfvars(o: {
  project: string;
  region: string;
  zone: string;
  sshRange: string;
  tcpPorts: string[];
  udpPorts: string[];
}): string {
  const list = (xs: string[]) => `[${xs.map((x) => `"${x}"`).join(', ')}]`;
  return `# Generated by \`pnpm cli init\`. terraform.tfvars is gitignored — safe to edit.
project_id   = "${o.project}"
region       = "${o.region}"
default_zone = "${o.zone}"

# Locked to your current public IP. If your ISP changes it, update this /32.
ssh_source_ranges = ${list([o.sshRange])}

game_tcp_ports = ${list(o.tcpPorts)}
game_udp_ports = ${list(o.udpPorts)}

# --- Discord bot / control plane (off by default) --------------------------
# Turn these on to stand up the Cloud Run + Pub/Sub stack. See SETUP.md for the
# Discord app + image-build steps that have to happen first.
# enable_control_plane        = true
# enable_bot                  = true
# discord_application_id      = ""
# discord_public_key          = ""
# discord_channel_id          = ""
# discord_channel_webhook_url = ""
# interactions_image          = "${o.region}-docker.pkg.dev/${o.project}/onehost/interactions:latest"
# worker_image                = "${o.region}-docker.pkg.dev/${o.project}/onehost/worker:latest"
#
# Reconcile sweep (long-running-server nag + lost-idle-signal backstop):
# max_uptime_hours      = 4   # warn once a server is up this many hours (0 = off)
# autostop_uptime_hours = 8   # also auto-stop at this many hours (0 = warn only)
# sweep_location        = ""  # set if var.region has no Cloud Scheduler (e.g. northeast2)
`;
}

// --- helpers ----------------------------------------------------------------

/** Resolve a clack prompt that may have been cancelled (Ctrl-C). */
function cancelable<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel('Setup cancelled — nothing written beyond this point.');
    process.exit(1);
  }
  return value;
}

async function text(message: string, initial: string): Promise<string | symbol> {
  return p.text({ message, initialValue: initial, placeholder: initial });
}

/** Best-effort current public IPv4, for the SSH-range default. Null on failure. */
async function currentPublicIp(): Promise<string | null> {
  try {
    const res = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(4000) });
    const ip = (await res.text()).trim();
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? ip : null;
  } catch {
    return null;
  }
}

/** Run a gcloud list with --format=json; null if gcloud is missing or the call fails. */
function gcloudJson<T>(args: string[]): T[] | null {
  const bin = findGcloud();
  if (!bin) return null;
  const full = [...args, '--format=json'];
  const isCmd = /\.(cmd|bat)$/i.test(bin);
  const res = isCmd
    ? spawnSync(`"${bin}" ${full.join(' ')}`, { encoding: 'utf8', shell: true })
    : spawnSync(bin, full, { encoding: 'utf8' });
  if (res.status !== 0 || !res.stdout) return null;
  try {
    return JSON.parse(res.stdout) as T[];
  } catch {
    return null;
  }
}

/** gcloud on PATH wins; else the default Windows SDK install. Null if absent. */
function findGcloud(): string | null {
  if (process.env.GCLOUD) return process.env.GCLOUD;
  const onPath = process.platform === 'win32' ? 'gcloud.cmd' : 'gcloud';
  if (spawnSync(onPath, ['--version'], { stdio: 'ignore' }).status === 0) return onPath;
  if (process.platform === 'win32') {
    const candidate = join(
      process.env.LOCALAPPDATA ?? '',
      'Google', 'Cloud SDK', 'google-cloud-sdk', 'bin', 'gcloud.cmd',
    );
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function repoRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

function rel(abs: string): string {
  const root = repoRoot();
  return abs.startsWith(root) ? abs.slice(root.length + 1).replace(/\\/g, '/') : abs;
}
