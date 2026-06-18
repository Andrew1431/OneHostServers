output "network_name" {
  value = google_compute_network.onehost.name
}

output "network_tag" {
  value       = var.network_tag
  description = "Set GCP_NETWORK_TAG to this when running the CLI / apps."
}

output "interactions_url" {
  value       = var.enable_bot ? google_cloud_run_v2_service.interactions[0].uri : null
  description = "Set this as the Discord app's Interactions Endpoint URL (when enable_bot)."
}

output "worker_url" {
  value       = var.enable_bot ? google_cloud_run_v2_service.worker[0].uri : null
  description = "Private worker endpoint; the Pub/Sub push subscription targets it (when enable_bot)."
}

output "game_vm_service_account" {
  value       = var.enable_bot ? google_service_account.game_vm[0].email : null
  description = "Set GCP_GAME_VM_SA to this when running the CLI, so created/started VMs can signal idle stop."
}
