# Discord control plane: two Cloud Run services joined by a Pub/Sub topic.
# OPT-IN — everything here is gated on var.enable_bot, so the base network +
# firewall apply without any Discord config. Set enable_bot = true (+ the
# discord_* and *_image vars) to stand it up. See SETUP.md.
#
#   Discord --(HTTPS)--> interactions --(publish)--> topic --(push)--> worker
#                            |                                            |
#                         3s ACK                                  drives the GCP
#                       "⏳ working"                              provider, then
#                                                          edits the Discord reply
#
# Why Pub/Sub between them: the interactions endpoint must answer Discord within
# 3 seconds, but start/stop take minutes. Publishing a job and returning keeps the
# ACK fast; the worker does the slow work and gets at-least-once delivery (free
# retries) from the subscription. Cost is effectively $0 — both services scale to
# zero and the message volume sits inside the free tier (see README cost model).

data "google_project" "this" {}

resource "google_project_service" "run" {
  count              = var.enable_bot ? 1 : 0
  service            = "run.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "pubsub" {
  count              = var.enable_bot ? 1 : 0
  service            = "pubsub.googleapis.com"
  disable_on_destroy = false
}

# --- Job topic --------------------------------------------------------------

resource "google_pubsub_topic" "jobs" {
  count      = var.enable_bot ? 1 : 0
  name       = "onehost-jobs"
  depends_on = [google_project_service.pubsub]
}

# --- Service accounts -------------------------------------------------------

resource "google_service_account" "interactions" {
  count        = var.enable_bot ? 1 : 0
  account_id   = "onehost-interactions"
  display_name = "OneHost interactions endpoint"
}

resource "google_service_account" "worker" {
  count        = var.enable_bot ? 1 : 0
  account_id   = "onehost-worker"
  display_name = "OneHost job worker"
}

# Identity Pub/Sub uses to authenticate its push requests to the worker.
resource "google_service_account" "pubsub_push" {
  count        = var.enable_bot ? 1 : 0
  account_id   = "onehost-pubsub-push"
  display_name = "OneHost Pub/Sub push identity"
}

# interactions may publish jobs onto the topic.
resource "google_pubsub_topic_iam_member" "interactions_publish" {
  count  = var.enable_bot ? 1 : 0
  topic  = google_pubsub_topic.jobs[0].name
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:${google_service_account.interactions[0].email}"
}

# The worker drives Compute (instances + disks + snapshots). roles/compute.admin
# is broad for v1; SHORTCUTS.md (#3/#8) — tighten to a custom role later.
resource "google_project_iam_member" "worker_compute" {
  count   = var.enable_bot ? 1 : 0
  project = var.project_id
  role    = "roles/compute.admin"
  member  = "serviceAccount:${google_service_account.worker[0].email}"
}

# Let the Pub/Sub service agent mint OIDC tokens as the push identity. Without
# this, authenticated push to a private Cloud Run service silently 401s.
resource "google_service_account_iam_member" "pubsub_token_creator" {
  count              = var.enable_bot ? 1 : 0
  service_account_id = google_service_account.pubsub_push[0].name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:service-${data.google_project.this.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
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

# --- worker: private (only the push identity may invoke) --------------------

resource "google_cloud_run_v2_service" "worker" {
  count      = var.enable_bot ? 1 : 0
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
    }
  }
}

resource "google_cloud_run_v2_service_iam_member" "worker_push" {
  count    = var.enable_bot ? 1 : 0
  name     = google_cloud_run_v2_service.worker[0].name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.pubsub_push[0].email}"
}

# --- Push subscription: topic -> worker, authenticated with OIDC ------------

resource "google_pubsub_subscription" "jobs_to_worker" {
  count                = var.enable_bot ? 1 : 0
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
