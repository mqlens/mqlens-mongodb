#!/usr/bin/env bash
# Starts the Percona Server for MongoDB containers that the real MONGODB-OIDC
# handshake tests (src-tauri/src/oidc/handshake_tests.rs, #430) run against.
# Used by CI and by hand; both must configure mongod identically.
#
#   scripts/oidc-percona-fixture.sh start   # prints the env vars the tests need
#   scripts/oidc-percona-fixture.sh stop
#
# Two containers, trusting the same issuer and differing only in `audience`:
#   $NAME          audience "mqlens"      — the access-token tests
#   $NAME-idtoken  audience = clientId    — the "Use ID token" tests (T21):
#                                           an ID token's `aud` is always the
#                                           client id, so a deployment that
#                                           accepts ID tokens is configured so.
# One mongod cannot serve both: two providers sharing an issuer make a human
# login pick one by user-name hint, which these tests do not send.
#
# mongod only fetches an issuer's JWKS over HTTPS, so the mock IdP in the test
# process serves TLS with the TEST-ONLY leaf in fixtures/oidc-test-idp.*. Each
# container is made to trust the matching TEST-ONLY CA (fixtures/oidc-test-ca.pem)
# by installing it into the image's system trust store before mongod starts.
# Nothing outside these throwaway containers ever trusts that CA.
set -euo pipefail

NAME="${MQLENS_OIDC_CONTAINER:-mqlens-oidc}"
IMAGE="percona/percona-server-mongodb:8.0.29-13"
MONGO_PORT="${MQLENS_OIDC_MONGO_PORT:-27099}"
ID_TOKEN_MONGO_PORT="${MQLENS_OIDC_ID_TOKEN_MONGO_PORT:-$((MONGO_PORT + 1))}"
IDP_PORT="${MQLENS_TEST_OIDC_IDP_PORT:-41999}"
ISSUER="https://host.docker.internal:${IDP_PORT}"
CLIENT_ID="mqlens-test"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The provider mongod trusts. Every field is pinned by the tests:
#   issuer   = the mock IdP's issuer (discovery `issuer` and every token's `iss`)
#   audience = the `aud` the mock IdP mints: "mqlens" on its access tokens,
#              the client id on its ID tokens
#   clientId = what the driver hands our callback, and so what our flow sends
# useAuthorizationClaim=false: the principal is `test/<sub>` in $external, and
# mongod refuses it (UserNotFound) unless that $external user exists — created
# below. Simpler than faking a groups claim and a matching role.
#
# No JWKS tuning is needed: mongod's startup key fetch fails (the IdP lives in
# the test process and is not up yet), but it refetches on demand when a token
# with an unknown `kid` arrives, seconds after startup included.
providers() {
  local audience="$1"
  echo "[{\"issuer\":\"${ISSUER}\",\"audience\":\"${audience}\",\"authNamePrefix\":\"test\",\"clientId\":\"${CLIENT_ID}\",\"supportsHumanFlows\":true,\"useAuthorizationClaim\":false}]"
}

# start_one NAME PORT AUDIENCE
start_one() {
  local name="$1" port="$2" audience="$3"
  docker rm -f "$name" >/dev/null 2>&1 || true
  # Created, then the CA copied in, then started: `docker cp` needs no bind
  # mount, so the same steps work from Linux CI and from Git Bash on Windows.
  # Runs as root only long enough to install the CA; the image's own
  # /entrypoint.sh then drops to the mongodb user via gosu before exec'ing mongod.
  # enableTestCommands lets a test arm mongod's `failCommand` failpoint, so it
  # can make a ping fail *after* a successful OIDC login (#430). This is a
  # throwaway test container only.
  MSYS_NO_PATHCONV=1 docker create --name "$name" \
    --user root \
    --add-host host.docker.internal:host-gateway \
    -p "${port}:27017" \
    --entrypoint /bin/bash \
    "$IMAGE" \
    -c 'cp /tmp/oidc-test-ca.pem /etc/pki/ca-trust/source/anchors/mqlens-oidc-test-ca.pem \
        && update-ca-trust extract \
        && exec /entrypoint.sh mongod "$@"' \
    bash \
    --setParameter authenticationMechanisms=MONGODB-OIDC,SCRAM-SHA-256 \
    --setParameter "oidcIdentityProviders=$(providers "$audience")" \
    --setParameter enableTestCommands=1 \
    >/dev/null
  # Relative source path: Git Bash would otherwise hand docker a /c/... path.
  (cd "$ROOT" && MSYS_NO_PATHCONV=1 docker cp fixtures/oidc-test-ca.pem "$name:/tmp/oidc-test-ca.pem")
  docker start "$name" >/dev/null
}

# await_one NAME: wait for mongod, then create the principal the tests log in as.
await_one() {
  local name="$1"
  for _ in $(seq 1 60); do
    if docker exec "$name" mongosh --quiet --eval 'db.runCommand({ ping: 1 }).ok' >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  docker exec "$name" mongosh --quiet --eval 'db.runCommand({ ping: 1 }).ok' >/dev/null

  # The OIDC principal the tests authenticate as: `<authNamePrefix>/<sub>`,
  # with `sub` fixed by the mock IdP's /token route (the same in its access
  # and ID tokens).
  MSYS_NO_PATHCONV=1 docker exec "$name" mongosh --quiet --eval \
    'db.getSiblingDB("$external").runCommand({ createUser: "test/mock-user", roles: [{ role: "read", db: "admin" }] })' \
    >/dev/null
}

start() {
  start_one "$NAME" "$MONGO_PORT" "mqlens"
  start_one "$NAME-idtoken" "$ID_TOKEN_MONGO_PORT" "$CLIENT_ID"
  await_one "$NAME"
  await_one "$NAME-idtoken"

  echo "MQLENS_TEST_OIDC_IDP_PORT=${IDP_PORT}"
  # Where the test's mock IdP must listen for the containers to reach it.
  # Docker Desktop delivers host.docker.internal to host loopback, the test's
  # default. On Linux, host-gateway is the default bridge's gateway address.
  if [ "$(uname -s)" = "Linux" ]; then
    echo "MQLENS_TEST_OIDC_IDP_BIND=$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}')"
  fi
  echo "MQLENS_TEST_OIDC_URI=mongodb://localhost:${MONGO_PORT}/?authMechanism=MONGODB-OIDC&authSource=\$external"
  echo "MQLENS_TEST_OIDC_ID_TOKEN_URI=mongodb://localhost:${ID_TOKEN_MONGO_PORT}/?authMechanism=MONGODB-OIDC&authSource=\$external"
}

stop() {
  docker rm -f "$NAME" "$NAME-idtoken" >/dev/null 2>&1 || true
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  *) echo "usage: $0 start|stop" >&2; exit 2 ;;
esac
