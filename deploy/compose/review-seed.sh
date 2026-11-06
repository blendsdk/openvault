#!/bin/sh
# Seeds synthetic data for the local review environment.
#
# The script runs inside a throwaway container whose network namespace is the
# proxy container. It logs in with the one-time bootstrap password, then
# creates projects, secrets, certificates, identities, and grants. Every value
# is fake and safe to reveal on camera.
#
# The seed is idempotent: existing projects, secrets, certificates, identities,
# and grants are left alone. Run it through `review.sh seed`.
set -eu

: "${OPENVAULT_URL:?OPENVAULT_URL is required}"
: "${OPENVAULT_CA_FILE:?OPENVAULT_CA_FILE is required}"

PASSWORD_FILE=${OPENVAULT_REVIEW_PASSWORD_FILE:-/review/bootstrap-password}
ADMIN=${OPENVAULT_REVIEW_ADMIN:-admin@openvault.local}

if [ ! -r "$PASSWORD_FILE" ]; then
  echo "seed: the bootstrap password file is not readable: $PASSWORD_FILE" >&2
  echo "seed: run the seed once before changing the bootstrap password" >&2
  exit 1
fi

ov auth login --identifier "$ADMIN" --password-stdin <"$PASSWORD_FILE" >/dev/null

project_exists() {
  ov project list --json | grep -Fq "\"name\":\"$1\""
}

secret_exists() {
  ov secret list --project "$1" --json | grep -Fq "\"name\":\"$2\""
}

certificate_exists() {
  ov cert list --project "$1" --json | grep -Fq "\"name\":\"$2\""
}

identity_exists() {
  ov identity list --project "$1" --json | grep -Fq "\"name\":\"$2\""
}

ensure_project() {
  if ! project_exists "$1"; then
    ov project create "$1" >/dev/null
  fi
}

ensure_secret() {
  if ! secret_exists "$1" "$2"; then
    printf '%s\n' "$3" | ov secret set "$2" --project "$1" --stdin \
      --content-type text/plain --tag env=review >/dev/null
  fi
}

ensure_certificate() {
  if ! certificate_exists "$1" "$2"; then
    ov cert generate "$2" --project "$1" --subject "$3" --san "$4" \
      --validity-days "$5" --tag env=review >/dev/null
  fi
}

ensure_identity() {
  if ! identity_exists "$1" "$2"; then
    ov identity create "$2" --project "$1" >/dev/null
  fi
}

has_secret_grant() {
  ov access explain "$3" --project "$1" --target-type secret \
    --action secret.read --json | grep -Fq "\"name\":\"$2\""
}

has_certificate_grant() {
  ov access explain "$3" --project "$1" --target-type certificate \
    --action certificate.read --json | grep -Fq "\"name\":\"$2\""
}

ensure_project payments
ensure_project analytics
ensure_project platform

# Two versions of the first secret make the version history and rotation
# views meaningful. The second value is written only on the first seed.
if ! secret_exists payments stripe-api-key; then
  printf '%s\n' "sk_test_review_only_do_not_use_4f8a2c" |
    ov secret set stripe-api-key --project payments --stdin \
      --content-type text/plain --tag env=review >/dev/null
  printf '%s\n' "sk_test_review_only_rotated_do_not_use_2b91" |
    ov secret set stripe-api-key --project payments --stdin \
      --content-type text/plain >/dev/null
fi
ensure_secret payments database-url \
  "postgres://payments:review-only@db.payments.test:5432/payments"
ensure_secret analytics warehouse-api-key "wh_review_only_do_not_use_91bd"
ensure_secret platform smtp-password "smtp-review-only-do-not-use-7a3e"

ensure_certificate payments payments-api "CN=api.payments.test" \
  "DNS:api.payments.test" 30
ensure_certificate analytics analytics-api "CN=api.analytics.test" \
  "DNS:api.analytics.test" 14
ensure_certificate platform deploy-bot "CN=deploy-bot.platform.test" \
  "DNS:deploy-bot.platform.test" 90

ensure_identity payments payments-api
ensure_identity analytics analytics-worker
ensure_identity platform deploy-bot

if ! has_secret_grant payments payments-api stripe-api-key; then
  ov role grant payments-api secrets.reader --project payments \
    --scope object --object-type secret --object stripe-api-key >/dev/null
fi
if ! has_secret_grant payments payments-api database-url; then
  ov role grant payments-api secrets.reader --project payments \
    --scope object --object-type secret --object database-url >/dev/null
fi
if ! has_secret_grant analytics analytics-worker warehouse-api-key; then
  ov role grant analytics-worker secrets.reader --project analytics \
    --scope project >/dev/null
fi
if ! has_certificate_grant platform deploy-bot deploy-bot; then
  ov role grant deploy-bot certificates.reader --project platform \
    --scope project >/dev/null
fi

ov audit verify >/dev/null

cat <<'EOF'
Seeded synthetic review data.

  Projects:     payments, analytics, platform
  Secrets:      stripe-api-key (two versions), database-url,
                warehouse-api-key, smtp-password
  Certificates: payments-api (30 days), analytics-api (14 days),
                deploy-bot (90 days)
  Identities:   payments-api, analytics-worker, deploy-bot
  Grants:       object and project scope examples
  Audit:        chain verified

Every value is fake. Revealing it is the point of the review.
EOF
