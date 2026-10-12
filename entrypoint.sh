#!/bin/bash
# The mounted directories arrive root-owned from the host on first boot; own them, then drop to `node`.
set -e
mkdir -p "${STACKWRIGHT_DATA:-/data}" "${STACKWRIGHT_WORKSPACE:-/workspace}"
chown node:node "${STACKWRIGHT_DATA:-/data}" "${STACKWRIGHT_WORKSPACE:-/workspace}"
exec gosu node "$@"
