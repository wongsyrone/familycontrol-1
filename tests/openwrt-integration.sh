#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
set -eu

assert_absent() {
	if uci -q get "$1" >/dev/null; then
		echo "Unexpected UCI entry: $1" >&2
		exit 1
	fi
}

/bin/sh /src/tests/account-setup.sh

mkdir -p /usr/share/rpcd/ucode /var/lock /var/run/ubus
cp /src/tests/fixtures/familycontrol /etc/config/familycontrol
cp /src/tests/fixtures/firewall-config /etc/config/firewall
cp /src/tests/fixtures/firewall /etc/init.d/firewall
cp /src/luci-app-familycontrol/root/usr/share/rpcd/ucode/familycontrol \
	/usr/share/rpcd/ucode/familycontrol
mkdir -p /usr/share/familycontrol /usr/share/nftables.d/table-post /usr/share/nftables.d/ruleset-pre
cp /src/luci-app-familycontrol/root/usr/share/familycontrol/*.uc /usr/share/familycontrol/
cp /src/luci-app-familycontrol/root/usr/share/nftables.d/table-post/30-familycontrol.nft /usr/share/nftables.d/table-post/
cp /src/luci-app-familycontrol/root/usr/share/nftables.d/ruleset-pre/30-familycontrol.nft /usr/share/nftables.d/ruleset-pre/
printf "%s\n" \
	"2000000000 00:11:22:33:44:55 192.168.1.20 alice-laptop *" \
	"2000000000 DE:AD:BE:EF:00:01 192.168.1.21 new-phone *" \
	> /tmp/dhcp.leases


ubusd >/tmp/familycontrol-ubus.log 2>&1 &
sleep 1
rpcd >/tmp/familycontrol-rpcd.log 2>&1 &
sleep 1

status="$(ubus call familycontrol status)"
echo "$status" | jsonfilter -e "@.people[0].id" | grep -qx alice
echo "$status" | jsonfilter -e "@.people[0].devices[1].mac" |
	grep -qx "AA:BB:CC:DD:EE:FF"
echo "$status" | jsonfilter -e "@.people[0].devices[1].connected" |
	grep -qx false

ubus call familycontrol save_calendar \
	"{\"day_off\":[\"2026-10-30\"],\"school_day\":[\"2026-11-17\"]}" \
	>/dev/null
test "$(uci get familycontrol.main.day_off)" = 2026-10-30
test "$(uci get familycontrol.main.school_day)" = 2026-11-17
invalid_date="$(ubus call familycontrol save_calendar \
	"{\"day_off\":[\"2026-02-30\"],\"school_day\":[]}")"
echo "$invalid_date" | jsonfilter -e "@.code" | grep -qx invalid_date

devices="$(ubus call familycontrol devices)"
echo "$devices" | jsonfilter -e "@.devices[0].hostname" |
	grep -qx alice-laptop
echo "$devices" | jsonfilter -e "@.devices[0].assigned_person" |
	grep -qx alice
echo "$devices" | jsonfilter -e "@.devices[1].mac" |
	grep -qx "DE:AD:BE:EF:00:01"

ucode /src/tests/devices.uc

ubus call familycontrol set_paused \
	"{\"person\":\"alice\",\"paused\":true}" >/dev/null

test "$(uci get familycontrol.alice.paused)" = 1
test "$(uci get firewall.familycontrol_alice.family)" = any
test "$(uci get firewall.familycontrol_alice.target)" = REJECT
test "$(uci get firewall.familycontrol_alice.src_mac)" = \
	"00:11:22:33:44:55 AA:BB:CC:DD:EE:FF"
fw4 print | grep -q "Family Control: alice"

# A schedule with no online slots blocks the person. Extra time grants
# temporary access, and tick restores enforcement when it expires.
zeros=000000000000000000000000000000000000000000000000
ubus call familycontrol save_schedule \
	"{\"person\":\"alice\",\"school_schedule\":\"$zeros\",\"dayoff_schedule\":\"$zeros\",\"school_night_cutoff\":1320,\"dayoff_night_cutoff\":1320}" \
	>/dev/null
ubus call familycontrol set_mode \
	"{\"person\":\"alice\",\"mode\":\"schedule\"}" >/dev/null
uci -q get firewall.familycontrol_alice >/dev/null
extra="$(ubus call familycontrol add_extra \
	"{\"person\":\"alice\",\"minutes\":15}")"
echo "$extra" | jsonfilter -e "@.extra_until" | grep -Eq "^[0-9]+$"
assert_absent firewall.familycontrol_alice
uci set familycontrol.alice.extra_until=1
uci commit familycontrol
ubus call familycontrol tick >/dev/null
uci -q get firewall.familycontrol_alice >/dev/null
reloads="$(wc -l </tmp/firewall-reloads)"
ubus call familycontrol tick >/dev/null
test "$(wc -l </tmp/firewall-reloads)" = "$reloads"

ucode /src/tests/extra.uc
ucode /src/tests/runtime.uc
ucode /src/tests/preview.uc
ubus call familycontrol preview_schedule \
	'{"person":"alice","format":"windows","policy":"allow","windows":[],"at_local":"2026-10-23T19:30:01"}' |
	jsonfilter -e '@.online' | grep -qx false
uci set familycontrol.main.enabled=0
uci commit familycontrol
ubus call familycontrol tick >/dev/null
disabled="$(ubus call familycontrol status)"
echo "$disabled" | jsonfilter -e '@.people[0].reason.code' | grep -qx disabled
echo "$disabled" | jsonfilter -e '@.people[0].paused' | grep -qx false
echo "$disabled" | jsonfilter -e '@.people[0].next_transition' | grep -qx 0
uci set familycontrol.main.enabled=1
uci commit familycontrol
uci set familycontrol.alice.extra_until=1
uci commit familycontrol
ubus call familycontrol tick >/dev/null

# Saving alone preserves the manual mode; activation changes it in one mutation.
ubus call familycontrol set_mode '{"person":"alice","mode":"online"}' >/dev/null
window='[{"repeat":"daily","all_day":true,"action":"block","priority":10}]'
ubus call familycontrol save_schedule \
	"{\"person\":\"alice\",\"format\":\"windows\",\"policy\":\"block\",\"windows\":$window}" >/dev/null
test "$(uci get familycontrol.alice.mode)" = online
ubus call familycontrol save_schedule \
	"{\"person\":\"alice\",\"format\":\"windows\",\"policy\":\"block\",\"windows\":$window,\"activate\":true}" >/dev/null
test "$(uci get familycontrol.alice.mode)" = schedule
uci get familycontrol.alice.schedule_windows | jsonfilter -e '@[0].priority' | grep -qx 10
uci get familycontrol.alice.schedule_windows | jsonfilter -e '@[0].action' | grep -qx block
uci -q get firewall.familycontrol_alice >/dev/null
ubus call familycontrol set_mode '{"person":"alice","mode":"online"}' >/dev/null
uci set familycontrol.alice.extra_until=2000000000
uci commit familycontrol
previous_windows="$(uci get familycontrol.alice.schedule_windows)"
touch /tmp/firewall-fail
failed="$(ubus call familycontrol save_schedule \
	'{"person":"alice","format":"windows","policy":"allow","windows":[],"activate":true}')"
echo "$failed" | jsonfilter -e "@.ok" | grep -qx false
test "$(uci get familycontrol.alice.mode)" = online
test "$(uci get familycontrol.alice.schedule_policy)" = block
test "$(uci get familycontrol.alice.schedule_windows)" = "$previous_windows"
test "$(uci get familycontrol.alice.extra_until)" = 2000000000
# The scratch test runner creates this flag; retain it as evidence via rename.
mv /tmp/firewall-fail /tmp/firewall-fail-activation-tested
ubus call familycontrol save_schedule \
	"{\"person\":\"alice\",\"format\":\"windows\",\"policy\":\"block\",\"windows\":$window,\"activate\":true}" >/dev/null
assert_absent familycontrol.alice.extra_until
echo "PASS schedule save/activation and full rollback"

# A device added to an already paused person is blocked immediately.
added="$(ubus call familycontrol save_device \
	"{\"person\":\"alice\",\"name\":\"New phone\",\"mac\":\"DE:AD:BE:EF:00:01\"}")"
echo "$added" | jsonfilter -e "@.ok" | grep -qx true
new_device="$(echo "$added" | jsonfilter -e "@.device")"
test "$(uci get firewall.familycontrol_alice.src_mac)" = \
	"00:11:22:33:44:55 AA:BB:CC:DD:EE:FF DE:AD:BE:EF:00:01"
duplicate="$(ubus call familycontrol save_device \
	"{\"person\":\"alice\",\"name\":\"Duplicate\",\"mac\":\"DE:AD:BE:EF:00:01\"}")"
echo "$duplicate" | jsonfilter -e "@.code" | grep -qx duplicate_mac

# Moving a device away from a paused person removes it from that rule.
bob="$(ubus call familycontrol save_person \
	"{\"name\":\"Bob\"}" | jsonfilter -e "@.person")"
ubus call familycontrol save_device \
	"{\"device\":\"$new_device\",\"person\":\"$bob\",\"name\":\"New phone\",\"mac\":\"DE:AD:BE:EF:00:01\"}" \
	>/dev/null
test "$(uci get firewall.familycontrol_alice.src_mac)" = \
	"00:11:22:33:44:55 AA:BB:CC:DD:EE:FF"
assert_absent "firewall.familycontrol_$bob"

# Removing the only device from a paused person removes its rule.
ubus call familycontrol set_paused \
	"{\"person\":\"$bob\",\"paused\":true}" >/dev/null
uci -q get "firewall.familycontrol_$bob" >/dev/null
ubus call familycontrol delete_device \
	"{\"device\":\"$new_device\"}" >/dev/null
assert_absent "firewall.familycontrol_$bob"

# Failed reloads restore both family configuration and firewall rules.
touch /tmp/firewall-fail
failed="$(ubus call familycontrol save_device \
	"{\"person\":\"alice\",\"name\":\"Failed phone\",\"mac\":\"DE:AD:BE:EF:00:02\"}")"
echo "$failed" | jsonfilter -e "@.ok" | grep -qx false
echo "$failed" | jsonfilter -e "@.code" | grep -qx firewall_reload_failed
if uci show familycontrol | grep -q "DE:AD:BE:EF:00:02"; then
	echo "Failed device survived rollback" >&2
	exit 1
fi
test "$(uci get firewall.familycontrol_alice.src_mac)" = \
	"00:11:22:33:44:55 AA:BB:CC:DD:EE:FF"
rm /tmp/firewall-fail

# Deleting a paused person removes devices and the generated rule.
ubus call familycontrol delete_person \
	"{\"person\":\"alice\"}" >/dev/null
assert_absent familycontrol.alice
assert_absent familycontrol.alice_phone
assert_absent familycontrol.alice_laptop
assert_absent firewall.familycontrol_alice
fw4 check

telemetry="$(ucode \
	/src/luci-app-familycontrol/root/usr/libexec/familycontrol-otel-payload)"
echo "$telemetry" | jsonfilter \
	-e "@.resourceMetrics[0].resource.attributes[0].value.stringValue" |
	grep -qx familycontrol
echo "$telemetry" |
	grep -Eq "\"name\":[[:space:]]*\"familycontrol.enforcement.drift\""
echo "$telemetry" |
	grep -Eq "\"name\":[[:space:]]*\"familycontrol.action.duration\""
