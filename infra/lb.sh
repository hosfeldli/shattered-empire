#!/usr/bin/env bash
# Put the Cloud Run service behind the existing global external Application Load Balancer.
# Additive only: creates a serverless NEG, a backend service, a host rule on the existing URL map
# and a Google-managed certificate, then restricts Cloud Run ingress to the load balancer. Safe to re-run.
set -euo pipefail
PROJECT="${PROJECT:-stem-471602}"; REGION="${REGION:-us-east1}"; SERVICE="shattered-empires"
HOST="${HOST:-game.liamhosfeld.com}"; URL_MAP="${URL_MAP:-stem-portfolio-url-map}"; PROXY="${PROXY:-stem-portfolio-https-proxy}"
NEG="$SERVICE-neg"; BACKEND="$SERVICE-backend"; CERT="${HOST//./-}-cert"
gcloud config set project "$PROJECT" --quiet >/dev/null
gcloud compute network-endpoint-groups describe "$NEG" --region "$REGION" >/dev/null 2>&1 || \
  gcloud compute network-endpoint-groups create "$NEG" --region "$REGION" --network-endpoint-type serverless --cloud-run-service "$SERVICE"
gcloud compute backend-services describe "$BACKEND" --global >/dev/null 2>&1 || {
  gcloud compute backend-services create "$BACKEND" --global --load-balancing-scheme EXTERNAL_MANAGED --protocol HTTP --enable-logging --logging-sample-rate 0.2
  gcloud compute backend-services add-backend "$BACKEND" --global --network-endpoint-group "$NEG" --network-endpoint-group-region "$REGION"; }
gcloud compute url-maps describe "$URL_MAP" --format='value(hostRules[].hosts)' | grep -q "$HOST" || \
  gcloud compute url-maps add-path-matcher "$URL_MAP" --path-matcher-name "$SERVICE" --default-service "$BACKEND" --new-hosts "$HOST"
gcloud compute ssl-certificates describe "$CERT" --global >/dev/null 2>&1 || gcloud compute ssl-certificates create "$CERT" --domains "$HOST" --global
CERTS="$(gcloud compute target-https-proxies describe "$PROXY" --format='value(sslCertificates)' | tr ';' '\n' | xargs -n1 basename | paste -sd, -)"
case ",$CERTS," in *",$CERT,"*) ;; *) gcloud compute target-https-proxies update "$PROXY" --ssl-certificates "$CERTS,$CERT";; esac
gcloud run services update "$SERVICE" --region "$REGION" --ingress internal-and-cloud-load-balancing
IP="$(gcloud compute forwarding-rules list --global --filter="target~$PROXY" --format='value(IPAddress)' | head -1)"
echo "Point DNS:  $HOST  A  $IP"
gcloud compute ssl-certificates describe "$CERT" --global --format='value(managed.status,managed.domainStatus)'
