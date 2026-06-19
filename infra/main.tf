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

# Game ports are now per-server: the provider creates an `onehost-game-<id>` rule
# targeting that server's own `onehost-srv-<id>` tag, opening only its ports
# (`pnpm cli create --port …` / `pnpm cli ports …`). No shared game rule here —
# see SHORTCUTS.md #8 and PER_GAME_PORT_INSTRUCTIONS.md.
