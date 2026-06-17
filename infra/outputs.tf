output "network_name" {
  value = google_compute_network.onehost.name
}

output "network_tag" {
  value       = var.network_tag
  description = "Set GCP_NETWORK_TAG to this when running the CLI / apps."
}
