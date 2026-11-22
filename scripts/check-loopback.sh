#!/bin/sh
# @id CODE-TUN-003 @implements REQ-TUN-003 REQ-TUN-004
set -eu

if [ "$#" -gt 1 ]; then
    printf 'Expected at most one listener port.\n' >&2
    exit 2
fi
port=${1-3000}
case "$port" in
    ''|*[!0-9]*|??????*|0*)
        printf 'Invalid listener port.\n' >&2
        exit 2
        ;;
esac
if [ "$port" -gt 65535 ]; then
    printf 'Invalid listener port.\n' >&2
    exit 2
fi

if command -v ss >/dev/null 2>&1; then
    if ! sockets=$(ss -H -ltn "sport = :$port"); then
        printf 'Socket tool failed; loopback listener was not verified.\n' >&2
        exit 1
    fi
elif command -v netstat >/dev/null 2>&1; then
    if ! sockets=$(netstat -lnt); then
        printf 'Socket tool failed; loopback listener was not verified.\n' >&2
        exit 1
    fi
else
    printf 'No supported socket tool; loopback listener was not verified.\n' >&2
    exit 1
fi

if ! printf '%s\n' "$sockets" | awk -v port="$port" '
    $4 ~ (":" port "$") {
        found = 1
        if ($4 != "127.0.0.1:" port) unsafe = 1
    }
    END { exit (!found || unsafe) }
'; then
    printf 'Refusing proxy: require only literal IPv4 loopback listeners on the upstream port.\n' >&2
    exit 1
fi
