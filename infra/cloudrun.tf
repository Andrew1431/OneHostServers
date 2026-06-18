# Control plane + Discord front-end: Cloud Run services joined by a Pub/Sub topic.
#
#   Discord --(HTTPS)--> interactions --(publish)--\
#                            |                      topic --(push)--> worker
#   game VM --(idle stop)---(publish)--------------/                    |
#                                                              drives the GCP
#                                                          provider (start/stop)
#
# Two opt-in layers, so the base network/firewall apply on their own (pure-CLI
# path needs nothing here):
#   * CONTROL PLANE (enable_control_plane) — topic + worker + their SAs + the
#     push subscription. This is what makes idle self-teardown work: a game VM
#     publishes a stop job and the worker snapshots + deletes it. NOT
#     Discord-specific — a headless CLI user wants this so a forgotten server
#     stops itself.
#   * DISCORD BOT (enable_bot) — the public interactions endpoint, one front-end
#     onto the same topic. Implies the control plane (it can't work without it).
#
# Why Pub/Sub: the interactions endpoint must answer Discord within 3s but
# start/stop take minutes — publish a job and return; the worker does the slow
# work with at-least-once delivery. Cost ~$0: both services scale to zero.

data "google_project" "this" {}

locals {
  # enable_bot implies the control plane; enable_control_plane stands it up alone.
  control_plane = var.enable_control_plane || var.enable_bot
  # The reconcile-sweep cron only exists when the control plane is up and a ceiling
  # is set — a 0-hour ceiling means the sweep would no-op, so skip the scheduler.
  sweep_enabled = local.control_plane && var.max_uptime_hours > 0
  # Scheduler isn't available in every region; fall back to var.region but let it
  # be overridden when the region isn't a Scheduler location (e.g. northeast2).
  sweep_location = var.sweep_location != "" ? var.sweep_location : var.region
}

resource "google_project_service" "run" {
  count              = local.control_plane ? 1 : 0
  service            = "run.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "pubsub" {
  count              = local.control_plane ? 1 : 0
  service            = "pubsub.googleapis.com"
  disable_on_destroy = false
}

# --- Job topic --------------------------------------------------------------

resource "google_pubsub_topic" "jobs" {
  count      = local.control_plane ? 1 : 0
  name       = "onehost-jobs"
  depends_on = [google_project_service.pubsub]
}

# --- Service accounts -------------------------------------------------------

resource "google_service_account" "worker" {
  count        = local.control_plane ? 1 : 0
  account_id   = "onehost-worker"
  display_name = "OneHost job worker"
}

# Identity Pub/Sub uses to authenticate its push requests to the worker.
resource "google_service_account" "pubsub_push" {
  count        = local.control_plane ? 1 : 0
  account_id   = "onehost-pubsub-push"
  display_name = "OneHost Pub/Sub push identity"
}

# Identity attached to GAME VMs. Deliberately powerless: its only IAM is
# pubsub.publisher on the jobs topic (below), so a compromised/untrusted game box
# can signal an idle stop but cannot touch instances, disks, or snapshots.
resource "google_service_account" "game_vm" {
  count        = local.control_plane ? 1 : 0
  account_id   = "onehost-game-vm"
  display_name = "OneHost game VM (idle-stop signal only)"
}

# Discord front-end only.
resource "google_service_account" "interactions" {
  count        = var.enable_bot ? 1 : 0
  account_id   = "onehost-interactions"
  display_name = "OneHost interactions endpoint"
}

# Game VMs may publish (their idle-stop signal) onto the topic — nothing else.
resource "google_pubsub_topic_iam_member" "game_vm_publish" {
  count  = local.control_plane ? 1 : 0
  topic  = google_pubsub_topic.jobs[0].name
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:${google_service_account.game_vm[0].email}"
}

# The worker (and an operator) attach the game-vm SA to instances on create/start,
# which requires actAs (serviceAccountUser) on that SA.
resource "google_service_account_iam_member" "worker_actas_game_vm" {
  count              = local.control_plane ? 1 : 0
  service_account_id = google_service_account.game_vm[0].name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.worker[0].email}"
}

# The worker drives Compute (instances + disks + snapshots). roles/compute.admin
# is broad for v1; SHORTCUTS.md (#3/#8) — tighten to a custom role later.
resource "google_project_iam_member" "worker_compute" {
  count   = local.control_plane ? 1 : 0
  project = var.project_id
  role    = "roles/compute.admin"
  member  = "serviceAccount:${google_service_account.worker[0].email}"
}

# Let the Pub/Sub service agent mint OIDC tokens as the push identity. Without
# this, authenticated push to a private Cloud Run service silently 401s.
resource "google_service_account_iam_member" "pubsub_token_creator" {
  count              = local.control_plane ? 1 : 0
  service_account_id = google_service_account.pubsub_push[0].name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:service-${data.google_project.this.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

# interactions may publish jobs onto the topic.
resource "google_pubsub_topic_iam_member" "interactions_publish" {
  count  = var.enable_bot ? 1 : 0
  topic  = google_pubsub_topic.jobs[0].name
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:${google_service_account.interactions[0].email}"
}

# --- worker: private (only the push identity may invoke) --------------------

resource "google_cloud_run_v2_service" "worker" {
  count      = local.control_plane ? 1 : 0
  name       = "onehost-worker"
  location   = var.region
  ingress    = "INGRESS_TRAFFIC_ALL" # push arrives over the internet; IAM gates it
  depends_on = [google_project_service.run]

  template {
    service_account = google_service_account.worker[0].email
    timeout         = "600s" # a slow start must finish before the push is acked

    containers {
      image = var.worker_image
      ports { container_port = 8080 }

      env {
        name  = "DISCORD_APPLICATION_ID"
        value = var.discord_application_id
      }
      # Webhook for tokenless jobs (idle self-teardown / future sweep). Empty = silent.
      env {
        name  = "DISCORD_CHANNEL_WEBHOOK_URL"
        value = var.discord_channel_webhook_url
      }
      env {
        name  = "GCP_PROJECT_ID"
        value = var.project_id
      }
      env {
        name  = "GCP_ZONE"
        value = var.default_zone
      }
      env {
        name  = "GCP_NETWORK_TAG"
        value = var.network_tag
      }
      # So restarted VMs get the powerless game-vm SA attached (enables idle self-stop).
      env {
        name  = "GCP_GAME_VM_SA"
        value = google_service_account.game_vm[0].email
      }
      # Reconcile-sweep thresholds (read when a {"kind":"sweep"} job arrives).
      env {
        name  = "ONEHOST_MAX_UPTIME_HOURS"
        value = tostring(var.max_uptime_hours)
      }
      env {
        name  = "ONEHOST_AUTOSTOP_UPTIME_HOURS"
        value = tostring(var.autostop_uptime_hours)
      }
    }
  }
}

resource "google_cloud_run_v2_service_iam_member" "worker_push" {
  count    = local.control_plane ? 1 : 0
  name     = google_cloud_run_v2_service.worker[0].name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.pubsub_push[0].email}"
}

# --- Push subscription: topic -> worker, authenticated with OIDC ------------

resource "google_pubsub_subscription" "jobs_to_worker" {
  count                = local.control_plane ? 1 : 0
  name                 = "onehost-jobs-worker"
  topic                = google_pubsub_topic.jobs[0].name
  ack_deadline_seconds = 600 # match the worker's request timeout (max allowed)

  push_config {
    push_endpoint = google_cloud_run_v2_service.worker[0].uri
    oidc_token {
      service_account_email = google_service_account.pubsub_push[0].email
      audience              = google_cloud_run_v2_service.worker[0].uri
    }
  }

  depends_on = [google_service_account_iam_member.pubsub_token_creator]
}

# --- Reconcile sweep: Cloud Scheduler -> topic -> worker --------------------
# A cron publishes {"kind":"sweep"} onto the same jobs topic; the existing push
# subscription delivers it to the worker, which flags / auto-stops servers up
# past the ceiling (long-running-server nag + lost-idle-signal backstop). Reuses
# the whole Pub/Sub path — no new ingress or auth. Only created when the control
# plane is on AND a ceiling is set; same-project Pub/Sub targets need no extra IAM.

resource "google_project_service" "cloudscheduler" {
  count              = local.sweep_enabled ? 1 : 0
  service            = "cloudscheduler.googleapis.com"
  disable_on_destroy = false
}

resource "google_cloud_scheduler_job" "sweep" {
  count     = local.sweep_enabled ? 1 : 0
  name      = "onehost-sweep"
  region    = local.sweep_location
  schedule  = var.sweep_schedule
  time_zone = "Etc/UTC"

  pubsub_target {
    topic_name = google_pubsub_topic.jobs[0].id
    data       = base64encode(jsonencode({ kind = "sweep" }))
  }

  depends_on = [google_project_service.cloudscheduler]
}

# --- interactions: public (Discord calls it; signature verification is the gate) ---

resource "google_cloud_run_v2_service" "interactions" {
  count      = var.enable_bot ? 1 : 0
  name       = "onehost-interactions"
  location   = var.region
  ingress    = "INGRESS_TRAFFIC_ALL"
  depends_on = [google_project_service.run]

  template {
    service_account = google_service_account.interactions[0].email

    containers {
      image = var.interactions_image
      ports { container_port = 8080 }

      env {
        name  = "DISCORD_PUBLIC_KEY"
        value = var.discord_public_key
      }
      env {
        name  = "DISCORD_APPLICATION_ID"
        value = var.discord_application_id
      }
      env {
        name  = "DISCORD_CHANNEL_ID"
        value = var.discord_channel_id
      }
      env {
        name  = "JOB_TRANSPORT"
        value = "pubsub"
      }
      env {
        name  = "PUBSUB_TOPIC"
        value = google_pubsub_topic.jobs[0].name
      }
      env {
        name  = "GCP_PROJECT_ID"
        value = var.project_id
      }
    }
  }
}

# Discord is unauthenticated — Ed25519 signature verification in the app is the
# real gate, so the endpoint must allow unauthenticated invocations.
resource "google_cloud_run_v2_service_iam_member" "interactions_public" {
  count    = var.enable_bot ? 1 : 0
  name     = google_cloud_run_v2_service.interactions[0].name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}
