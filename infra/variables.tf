variable "project_id" {
  type        = string
  description = "GCP project to deploy OneHost into."
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "network_tag" {
  type        = string
  default     = "onehost"
  description = "Tag applied to game VMs; firewall rules target it. Must match GCP_NETWORK_TAG."
}

variable "ssh_source_ranges" {
  type        = list(string)
  default     = ["0.0.0.0/0"]
  description = "CIDRs allowed to SSH. Strongly recommend narrowing to your own IP."
}

variable "game_tcp_ports" {
  type        = list(string)
  default     = ["25565"] # Minecraft default
  description = "TCP ports opened on game VMs."
}

variable "game_udp_ports" {
  type        = list(string)
  default     = ["2456-2458"] # Valheim default range
  description = "UDP ports opened on game VMs."
}
