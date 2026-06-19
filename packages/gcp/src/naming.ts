import type { ServerId, MachineSpec } from '@onehost/core';

/**
 * GCP resource names must be RFC1035: lowercase letters, digits, hyphens;
 * start with a letter; max 63 chars. We derive disk/instance/snapshot names
 * deterministically from the server id so the provider stays stateless.
 */
export function sanitizeName(id: ServerId): string {
  const cleaned = id
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  const withPrefix = /^[a-z]/.test(cleaned) ? cleaned : `s-${cleaned}`;
  return withPrefix.slice(0, 50); // leave room for snapshot timestamp suffix
}

export function instanceName(id: ServerId): string {
  return sanitizeName(id);
}

/** Boot disk shares the instance name (GCP default for auto-created disks). */
export function diskName(id: ServerId): string {
  return sanitizeName(id);
}

export function snapshotName(id: ServerId, at: number = Date.now()): string {
  return `${sanitizeName(id)}-${at}`;
}

/**
 * Per-server network tag. The instance wears this *in addition to* the shared
 * `onehost` tag (which the global SSH rule targets); the server's own firewall
 * rule targets this tag so it opens only that server's ports. `onehost-srv-`
 * (12) + sanitizeName's ≤50 keeps us under GCP's 63-char tag limit and the
 * letter-start rule.
 */
export function serverTag(id: ServerId): string {
  return `onehost-srv-${sanitizeName(id)}`;
}

/** Name of the server's own ingress firewall rule (created/updated/deleted CLI-side). */
export function firewallRuleName(id: ServerId): string {
  return `onehost-game-${sanitizeName(id)}`;
}

/**
 * Resolve the GCP machine type. An explicit `machine.type` (e.g. "n2-standard-4")
 * wins; otherwise we build a custom e2 from vcpus/memory. GCP validates the exact
 * vcpu/memory combos, so we let the API reject invalid specs rather than
 * re-implement its rules here.
 */
export function machineTypeName(machine: MachineSpec): string {
  return machine.type ?? `e2-custom-${machine.vcpus}-${machine.memoryMb}`;
}
