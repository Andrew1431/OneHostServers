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
  default     = ["2456-2458", "15637"] # Valheim range; Enshrouded query/game port
  description = "UDP ports opened on game VMs."
}

# --- Control plane (Cloud Run worker + Pub/Sub) ----------------------------
# The control plane is the job topic + worker that drive start/stop off-box. It's
# what makes idle self-teardown possible (a game VM publishes a stop; the worker
# snapshots + deletes it) — independent of Discord. The Discord bot is just one
# front-end onto the same topic. Both are OPT-IN: with everything off, the base
# network/firewall still apply and the pure-CLI hands-on path needs nothing here.
#
# enable_bot implies the control plane (the bot can't work without it). Set
# enable_control_plane = true on its own for headless idle-teardown (CLI users who
# want a VM to stop itself when empty) without standing up Discord.

variable "enable_control_plane" {
  type        = bool
  default     = false
  description = "Stand up the job worker + Pub/Sub topic (enables idle self-teardown). Needs worker_image. Implied by enable_bot."
}

variable "enable_bot" {
  type        = bool
  default     = false
  description = "Stand up the Discord bot front-end (interactions endpoint). Needs the discord_* + interactions_image vars. Implies enable_control_plane."
}

variable "default_zone" {
  type        = string
  default     = "us-central1-a"
  description = "Zone the worker provisions into by default. Must be inside var.region."
}

# --- Reconcile sweep (long-running-server nag + lost-idle-signal backstop) ---
# Cloud Scheduler publishes a {"kind":"sweep"} job on a cron; the worker flags
# (and optionally auto-stops) any RUNNING server up past the ceiling. The
# scheduler is only created when the control plane is on AND max_uptime_hours > 0.

variable "max_uptime_hours" {
  type        = number
  default     = 0
  description = "Warn once a RUNNING server has been up this many hours. 0 disables the sweep entirely (no scheduler created)."
}

variable "autostop_uptime_hours" {
  type        = number
  default     = 0
  description = "Also auto-stop a server once up this many hours. 0 (or below max_uptime_hours) = warn only, never auto-stop."
}

variable "sweep_schedule" {
  type        = string
  default     = "*/15 * * * *"
  description = "Cron for the reconcile sweep (unix-cron, scheduler's timezone is UTC by default)."
}

variable "sweep_location" {
  type        = string
  default     = ""
  description = "Cloud Scheduler location for the sweep cron. Scheduler isn't in every region (e.g. NOT northamerica-northeast2) — set a supported nearby location here when var.region isn't one (it only publishes to the global topic, so it need not match). Empty = use var.region."
}

variable "discord_application_id" {
  type        = string
  default     = ""
  description = "Discord application id (Developer Portal → your app → General)."
}

variable "discord_public_key" {
  type        = string
  default     = ""
  description = "Discord application public key — used to verify interaction signatures."
}

variable "discord_channel_id" {
  type        = string
  default     = ""
  description = "If set, commands are only accepted from this channel id (defense-in-depth)."
}

variable "discord_channel_webhook_url" {
  type        = string
  default     = ""
  sensitive   = true
  description = "Channel webhook the worker posts to for jobs with no interaction (idle self-teardown, future reconcile sweep / nag). Empty = those jobs run silently."
}

variable "interactions_image" {
  type        = string
  default     = ""
  description = "Container image for the interactions endpoint (build + push first; see SETUP.md)."
}

variable "worker_image" {
  type        = string
  default     = ""
  description = "Container image for the job worker (build + push first; see SETUP.md)."
}
