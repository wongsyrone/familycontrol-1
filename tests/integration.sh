#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later

set -eu

repo_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"

docker run --rm --platform linux/amd64 --cap-add NET_ADMIN \
	-v "$repo_dir:/src:ro" \
	openwrt/rootfs:x86_64 \
	/bin/sh -ec 'apk update >/dev/null; apk add rpcd-mod-ucode ip-tiny >/dev/null; /bin/sh /src/tests/openwrt-integration.sh'

echo "OpenWrt integration checks passed."
