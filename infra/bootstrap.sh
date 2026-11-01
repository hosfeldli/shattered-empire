#!/usr/bin/env bash
# One-time Google Cloud + GitHub setup for Shattered Empires. Safe to re-run.
#
#   ./infra/bootstrap.sh ["path/to/service-account-key.json"]
#
# Creates: Artifact Registry repo, a runtime service account, a GitHub Actions deployer
# service account, and a Workload Identity Federation pool so GitHub Actions deploys to
# Cloud Run without any long-lived key stored in GitHub. Then sets the GitHub repo
# variables and pushes main, which triggers the first deployment.
set -euo pipefail

KEY="${1:-$HOME/Downloads/Stem IAM Admin.json}"
GH_REPO="${GH_REPO:-hosfeldli/shattered-empire}"
REGION="${REGION:-us-east1}"
SERVICE="shattered-empires"
AR_REPO="shattered-empires"
POOL="github-pool"
PROVIDER="github"
DEPLOYER="gha-deployer"
RUNTIME="se-runtime"

say() { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing '$1'. Install it with: $2"; exit 1; }; }
need gcloud "brew install --cask google-cloud-sdk"
need git "xcode-select --install"
[ -f "$KEY" ] || { echo "Service account key not found at: $KEY"; exit 1; }

PROJECT="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["project_id"])' "$KEY")"
say "Authenticating as the service account in $(basename "$KEY") (project $PROJECT)"
gcloud auth activate-service-account --key-file "$KEY" --quiet
gcloud config set project "$PROJECT" --quiet >/dev/null
NUM="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"

say "Enabling APIs"
gcloud services enable run.googleapis.com artifactregistry.googleapis.com iam.googleapis.com \
  iamcredentials.googleapis.com sts.googleapis.com cloudresourcemanager.googleapis.com --quiet

say "Artifact Registry repository $AR_REPO ($REGION)"
gcloud artifacts repositories describe "$AR_REPO" --location "$REGION" >/dev/null 2>&1 || \
  gcloud artifacts repositories create "$AR_REPO" --repository-format=docker --location "$REGION" --description="Shattered Empires images" --quiet

say "Service accounts"
for SA in "$RUNTIME" "$DEPLOYER"; do
  gcloud iam service-accounts describe "$SA@$PROJECT.iam.gserviceaccount.com" >/dev/null 2>&1 || \
    gcloud iam service-accounts create "$SA" --display-name "Shattered Empires $SA" --quiet
done
DEPLOY_SA="$DEPLOYER@$PROJECT.iam.gserviceaccount.com"
RUNTIME_SA="$RUNTIME@$PROJECT.iam.gserviceaccount.com"
for ROLE in roles/run.admin roles/artifactregistry.writer; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$DEPLOY_SA" --role "$ROLE" --condition=None --quiet >/dev/null
done
gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" --member "serviceAccount:$DEPLOY_SA" --role roles/iam.serviceAccountUser --quiet >/dev/null
# the desktop release workflow publishes installers to downloads/ in the game's bucket
gcloud storage buckets add-iam-policy-binding "gs://${SNAPSHOT_BUCKET:-stem-471602-se-snapshots}" --member "serviceAccount:$DEPLOY_SA" --role roles/storage.objectAdmin --quiet >/dev/null 2>&1 || echo "  (could not grant bucket access for desktop publishing; publish from a machine with access instead)"

say "Workload Identity Federation for GitHub repo $GH_REPO"
gcloud iam workload-identity-pools describe "$POOL" --location global >/dev/null 2>&1 || \
  gcloud iam workload-identity-pools create "$POOL" --location global --display-name "GitHub Actions" --quiet
gcloud iam workload-identity-pools providers describe "$PROVIDER" --location global --workload-identity-pool "$POOL" >/dev/null 2>&1 || \
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" --location global --workload-identity-pool "$POOL" \
    --issuer-uri "https://token.actions.githubusercontent.com" \
    --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition "assertion.repository == '$GH_REPO'" --quiet
gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_SA" --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/projects/$NUM/locations/global/workloadIdentityPools/$POOL/attribute.repository/$GH_REPO" --quiet >/dev/null
WIF="projects/$NUM/locations/global/workloadIdentityPools/$POOL/providers/$PROVIDER"

say "GitHub repository variables"
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  gh variable set GCP_PROJECT --repo "$GH_REPO" --body "$PROJECT"
  gh variable set GCP_REGION --repo "$GH_REPO" --body "$REGION"
  gh variable set GCP_WIF_PROVIDER --repo "$GH_REPO" --body "$WIF"
  gh variable set GCP_DEPLOY_SA --repo "$GH_REPO" --body "$DEPLOY_SA"
  gh variable set GCP_RUNTIME_SA --repo "$GH_REPO" --body "$RUNTIME_SA"
else
  echo "gh CLI not installed or not logged in. Add these at https://github.com/$GH_REPO/settings/variables/actions :"
  printf '  GCP_PROJECT      = %s\n  GCP_REGION       = %s\n  GCP_WIF_PROVIDER = %s\n  GCP_DEPLOY_SA    = %s\n  GCP_RUNTIME_SA   = %s\n' "$PROJECT" "$REGION" "$WIF" "$DEPLOY_SA" "$RUNTIME_SA"
  echo "(or: brew install gh && gh auth login, then re-run this script)"
fi

say "Pushing to GitHub (this triggers test + deploy)"
cd "$(dirname "$0")/.."
git remote get-url origin >/dev/null 2>&1 || git remote add origin "https://github.com/$GH_REPO.git"
git push -u origin main

cat <<DONE

Done. Follow the deployment at https://github.com/$GH_REPO/actions
When it finishes, the game URL is:
  gcloud run services describe $SERVICE --region $REGION --format 'value(status.url)'
DONE
