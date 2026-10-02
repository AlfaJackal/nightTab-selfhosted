#!/bin/sh
# Runs test/e2e.mjs against a throwaway server and a headless Chrome in their
# own Docker network. The real profile in ./data is not touched.
set -e
cd "$(dirname "$0")/.."

cleanup() {
  docker rm -f nt-test-app nt-test-chrome >/dev/null 2>&1 || true
  docker network rm nt-test >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

docker build -q -t nighttab-server:test . >/dev/null
docker network create nt-test >/dev/null
docker run -d --rm --name nt-test-app --network nt-test nighttab-server:test >/dev/null
docker run -d --rm --name nt-test-chrome --network nt-test chromedp/headless-shell:latest >/dev/null
sleep 4

docker run --rm --network nt-test -v "$PWD/test:/t:ro" \
  -e APP=http://nt-test-app:8080/ -e CHROME=nt-test-chrome:9222 \
  node:22-alpine node /t/e2e.mjs
