#!/usr/bin/env bash
# Starts the Percona Server for MongoDB container that the real MONGODB-OIDC
# handshake test (src-tauri/src/oidc/handshake_tests.rs, #430) runs against.
# Used by CI and by hand; both must configure mongod identically.
#
#   scripts/oidc-percona-fixture.sh start   # prints the env vars the test needs
#   scripts/oidc-percona-fixture.sh stop
#
# mongod only fetches an issuer's JWKS over HTTPS, so the mock IdP in the test
# process serves TLS with the TEST-ONLY leaf in fixtures/oidc-test-idp.*. This
# container is made to trust the matching TEST-ONLY CA (fixtures/oidc-test-ca.pem)
# by installing it into the image's system trust store before mongod starts.
# Nothing outside this throwaway container ever trusts that CA.
set -euo pipefail

NAME="${MQLENS_OIDC_CONTAINER:-mqlens-oidc}"
IMAGE="percona/percona-server-mongodb:8.0.29-13"
MONGO_PORT="${MQLENS_OIDC_MONGO_PORT:-27099}"
IDP_PORT="${MQLENS_TEST_OIDC_IDP_PORT:-41999}"
ISSUER="https://host.docker.internal:${IDP_PORT}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The provider mongod trusts. Every field is pinned by the test:
#   issuer   = the mock IdP's issuer (discovery `issuer` and every token's `iss`)
#   audience = the `aud` the mock IdP mints
#   clientId = what the driver hands our callback, and so what our flow sends
# useAuthorizationClaim=false: the principal is `test/<sub>` in $external, and
# mongod refuses it (UserNotFound) unless that $external user exists — created
# below. Simpler than faking a groups claim and a matching role.
#
# No JWKS tuning is needed: mongod's startup key fetch fails (the IdP lives in
# the test process and is not up yet), but it refetches on demand when a token
# with an unknown `kid` arrives, seconds after startup included.
PROVIDERS="[{\"issuer\":\"${ISSUER}\",\"audience\":\"mqlens\",\"authNamePrefix\":\"test\",\"clientId\":\"mqlens-test\",\"supportsHumanFlows\":true,\"useAuthorizationClaim\":false}]"

start() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  # Created, then the CA copied in, then started: `docker cp` needs no bind
  # mount, so the same steps work from Linux CI and from Git Bash on Windows.
  # Runs as root only long enough to install the CA; the image's own
  # /entrypoint.sh then drops to the mongodb user via gosu before exec'ing mongod.
  MSYS_NO_PATHCONV=1 docker create --name "$NAME" \
    --user root \
    --add-host host.docker.internal:host-gateway \
    -p "${MONGO_PORT}:27017" \
    --entrypoint /bin/bash \
    "$IMAGE" \
    -c 'cp /tmp/oidc-test-ca.pem /etc/pki/ca-trust/source/anchors/mqlens-oidc-test-ca.pem \
        && update-ca-trust extract \
        && exec /entrypoint.sh mongod "$@"' \
    bash \
    --setParameter authenticationMechanisms=MONGODB-OIDC,SCRAM-SHA-256 \
    --setParameter "oidcIdentityProviders=${PROVIDERS}" \
    >/dev/null
  # Relative source path: Git Bash would otherwise hand docker a /c/... path.
  (cd "$ROOT" && MSYS_NO_PATHCONV=1 docker cp fixtures/oidc-test-ca.pem "$NAME:/tmp/oidc-test-ca.pem")
  docker start "$NAME" >/dev/null

  for _ in $(seq 1 60); do
    if docker exec "$NAME" mongosh --quiet --eval 'db.runCommand({ ping: 1 }).ok' >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  docker exec "$NAME" mongosh --quiet --eval 'db.runCommand({ ping: 1 }).ok' >/dev/null

  # The OIDC principal the test authenticates as: `<authNamePrefix>/<sub>`,
  # with `sub` fixed by the mock IdP's /token route.
  MSYS_NO_PATHCONV=1 docker exec "$NAME" mongosh --quiet --eval \
    'db.getSiblingDB("$external").runCommand({ createUser: "test/mock-user", roles: [{ role: "read", db: "admin" }] })' \
    >/dev/null

  echo "MQLENS_TEST_OIDC_IDP_PORT=${IDP_PORT}"
  # Where the test's mock IdP must listen for the container to reach it.
  # Docker Desktop delivers host.docker.internal to host loopback, the test's
  # default. On Linux, host-gateway is the default bridge's gateway address.
  if [ "$(uname -s)" = "Linux" ]; then
    echo "MQLENS_TEST_OIDC_IDP_BIND=$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}')"
  fi
  echo "MQLENS_TEST_OIDC_URI=mongodb://localhost:${MONGO_PORT}/?authMechanism=MONGODB-OIDC&authSource=\$external"
}

stop() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  *) echo "usage: $0 start|stop" >&2; exit 2 ;;
esac
