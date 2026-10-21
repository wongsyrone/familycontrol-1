#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later

set -eu

repo_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"

node --check \
	"$repo_dir/luci-app-familycontrol/htdocs/luci-static/resources/view/familycontrol/overview.js"
node --check \
	"$repo_dir/luci-app-familycontrol/root/www/family/app.js"

npm --prefix "$repo_dir" run holidays >/dev/null
git -C "$repo_dir" diff --exit-code -- \
	luci-app-familycontrol/root/usr/share/familycontrol/cz-holidays-2026-2035.txt

for script in \
	"$repo_dir/luci-app-familycontrol/root/etc/init.d/familycontrol-telemetry" \
	"$repo_dir/luci-app-familycontrol/root/etc/init.d/familycontrol-scheduler" \
	"$repo_dir/luci-app-familycontrol/root/etc/uci-defaults/96-familycontrol-scheduler" \
	"$repo_dir/luci-app-familycontrol/root/etc/uci-defaults/97-familycontrol-schedule" \
	"$repo_dir/luci-app-familycontrol/root/etc/uci-defaults/98-familycontrol-telemetry" \
	"$repo_dir/luci-app-familycontrol/root/etc/uci-defaults/99-familycontrol-http" \
	"$repo_dir/luci-app-familycontrol/root/usr/sbin/familycontrol-otel-export" \
	"$repo_dir/luci-app-familycontrol/root/usr/sbin/familycontrol-otel-loop" \
	"$repo_dir/luci-app-familycontrol/root/etc/hotplug.d/iface/16-familycontrol" \
	"$repo_dir/tests/openwrt-integration.sh" \
	"$repo_dir/tests/account-setup.sh"
do
	sh -n "$script"
done

jq empty \
	"$repo_dir/luci-app-familycontrol/root/usr/share/luci/menu.d/luci-app-familycontrol.json" \
	"$repo_dir/luci-app-familycontrol/root/usr/share/rpcd/acl.d/luci-app-familycontrol.json"

jq -e '
	.["luci-app-familycontrol"].write.ubus.familycontrol
		| index("save_device") != null and
		  index("delete_device") != null and
		  index("save_person") != null and
		  index("delete_person") != null and
		  index("set_mode") != null and
		  index("add_extra") != null and
		  index("save_schedule") != null and
		  index("save_calendar") != null
' "$repo_dir/luci-app-familycontrol/root/usr/share/rpcd/acl.d/luci-app-familycontrol.json" \
	>/dev/null

jq -e '
	.["luci-app-familycontrol"].write.ubus.uci == null and
	.["luci-app-familycontrol"].write.uci == null
' "$repo_dir/luci-app-familycontrol/root/usr/share/rpcd/acl.d/luci-app-familycontrol.json" \
	>/dev/null

docker run --rm --platform linux/amd64 \
	-v "$repo_dir/luci-app-familycontrol/root:/src:ro" \
	openwrt/rootfs:x86_64 \
	/bin/sh -ec '
		mkdir -p /usr/share/familycontrol
		cp /src/usr/share/familycontrol/*.uc /usr/share/familycontrol/
		ucode -c -o /tmp/familycontrol.uc \
			/src/usr/share/rpcd/ucode/familycontrol
		ucode -c -o /tmp/familycontrol-firewall.uc \
			/src/usr/libexec/familycontrol-firewall
		ucode -c -o /tmp/familycontrol-otel-payload.uc \
			/src/usr/libexec/familycontrol-otel-payload
		ucode -c -o /tmp/familycontrol-scheduler.uc \
			/src/usr/sbin/familycontrol-scheduler
	'

docker run --rm --platform linux/amd64 \
	-v "$repo_dir:/src:ro" openwrt/rootfs:x86_64 /bin/sh -ec '
		mkdir -p /usr/share/familycontrol
		cp /src/luci-app-familycontrol/root/usr/share/familycontrol/*.uc /usr/share/familycontrol/
		ucode /src/tests/schedule.uc
	'

"$repo_dir/tests/integration.sh"

echo "Static checks passed."
