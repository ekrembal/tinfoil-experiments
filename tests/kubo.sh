#!/bin/sh
set -eu
export IPFS_PATH=/tmp/attestai-ipfs
ipfs init --profile=test >/dev/null
ipfs add --only-hash --cid-version=1 -Qr /evidence/dist
