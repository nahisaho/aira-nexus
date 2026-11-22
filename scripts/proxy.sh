#!/bin/sh
# @id CODE-TUN-001 @implements REQ-TUN-001 REQ-TUN-003 REQ-TUN-004
set -eu

if [ "$#" -ne 1 ]; then
    printf 'Usage: sh scripts/proxy.sh up|stop\n' >&2
    exit 2
fi
case "$1" in
    up|stop) ;;
    *)
        printf 'Usage: sh scripts/proxy.sh up|stop\n' >&2
        exit 2
        ;;
esac

CDPATH= cd -- "$(dirname -- "$0")/.."
if [ "$1" = up ]; then
    sh scripts/check-loopback.sh 3000
    exec docker compose -p aira-nexus-proxy -f compose.proxy.yml \
        up -d --wait --wait-timeout 30 nginx
fi
exec docker compose -p aira-nexus-proxy -f compose.proxy.yml stop nginx
