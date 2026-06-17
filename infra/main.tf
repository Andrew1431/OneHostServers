terraform {
  required_version = ">= 1.6"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# Enable the APIs OneHost needs. (Compute for VMs/disks/snapshots.)
resource "google_project_service" "compute" {
  service            = "compute.googleapis.com"
  disable_on_destroy = false
}

# Dedicated network so game servers are isolated from anything else in the project.
resource "google_compute_network" "onehost" {
  name                    = "onehost"
  auto_create_subnetworks = true
  depends_on              = [google_project_service.compute]
}

# SSH so you can do first-boot game installs. Lock source_ranges down to your IP.
resource "google_compute_firewall" "ssh" {
  name      = "onehost-allow-ssh"
  network   = google_compute_network.onehost.name
  direction = "INGRESS"

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  target_tags   = [var.network_tag]
  source_ranges = var.ssh_source_ranges
}

# Game ports. SHORTCUTS.md (#8): one shared rule for all servers in v1; per-server
# firewall scoping (so each server only opens its own ports) is a future refactor.
resource "google_compute_firewall" "game" {
  name      = "onehost-allow-game"
  network   = google_compute_network.onehost.name
  direction = "INGRESS"

  allow {
    protocol = "tcp"
    ports    = var.game_tcp_ports
  }

  allow {
    protocol = "udp"
    ports    = var.game_udp_ports
  }

  target_tags   = [var.network_tag]
  source_ranges = ["0.0.0.0/0"]
}
