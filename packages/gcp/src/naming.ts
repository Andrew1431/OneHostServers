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
 * Build the GCP custom machine type string. GCP validates the exact vcpu/memory
 * combos (memory must be a multiple of 256MB and within per-vcpu bounds); we let
 * the API reject invalid specs rather than re-implement its rules here.
 */
export function machineTypeName(machine: MachineSpec): string {
  return `e2-custom-${machine.vcpus}-${machine.memoryMb}`;
}
