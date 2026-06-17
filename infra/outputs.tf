output "network_name" {
  value = google_compute_network.onehost.name
}

output "network_tag" {
  value       = var.network_tag
  description = "Set GCP_NETWORK_TAG to this when running the CLI / apps."
}

output "interactions_url" {
  value       = google_cloud_run_v2_service.interactions.uri
  description = "Set this (+ /) as the Discord app's Interactions Endpoint URL."
}

output "worker_url" {
  value       = google_cloud_run_v2_service.worker.uri
  description = "Private worker endpoint; the Pub/Sub push subscription targets it."
}
