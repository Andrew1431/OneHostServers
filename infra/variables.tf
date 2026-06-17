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

# --- Discord control plane (Cloud Run + Pub/Sub) ---------------------------
# These power the Discord bot. None are real secrets at runtime: the public key
# is public, and the worker edits replies with the per-request interaction token
# (the bot token is only used by the one-off `register` script, never deployed).

variable "default_zone" {
  type        = string
  default     = "us-central1-a"
  description = "Zone the worker provisions into by default. Must be inside var.region."
}

variable "discord_application_id" {
  type        = string
  description = "Discord application id (Developer Portal → your app → General)."
}

variable "discord_public_key" {
  type        = string
  description = "Discord application public key — used to verify interaction signatures."
}

variable "discord_channel_id" {
  type        = string
  default     = ""
  description = "If set, commands are only accepted from this channel id (defense-in-depth)."
}

variable "interactions_image" {
  type        = string
  description = "Container image for the interactions endpoint (build + push first; see docs/DEPLOY.md)."
}

variable "worker_image" {
  type        = string
  description = "Container image for the job worker (build + push first; see docs/DEPLOY.md)."
}
