#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# rpcd's $p$ account references are intentional literals.
# shellcheck disable=SC2016
set -eu

# Keep account and UCI writes in a synthetic root; never alter the host account.
fixture="$(mktemp -d /tmp/familycontrol-account.XXXXXX)"
export FAMILYCONTROL_ACCOUNT_FIXTURE="$fixture"
mkdir -p "$fixture/etc/config" "$fixture/bin"
printf 'root:x:0:0:root:/root:/bin/ash\n' >"$fixture/etc/passwd"
printf 'root:!:0:0:99999:7:::\n' >"$fixture/etc/shadow"
printf 'root:x:0:\n' >"$fixture/etc/group"
: >"$fixture/etc/config/rpcd"
cat >"$fixture/bin/uci" <<'EOF'
#!/bin/sh
exec /sbin/uci -c "$FAMILYCONTROL_ACCOUNT_FIXTURE/etc/config" "$@"
EOF
chmod 755 "$fixture/bin/uci"

run_defaults() {
	IPKG_INSTROOT="$fixture" PATH="$fixture/bin:$PATH" \
		/bin/sh /src/luci-app-familycontrol/root/etc/uci-defaults/99-familycontrol-http
}

run_defaults
grep -q '^familycontrol:x:[0-9]*:[0-9]*:familycontrol:/var/run/familycontrol:/bin/false$' \
	"$fixture/etc/passwd"
grep -q '^familycontrol:x:' "$fixture/etc/group"
test "$(/sbin/uci -c "$fixture/etc/config" get rpcd.familycontrol.username)" = familycontrol
test "$(/sbin/uci -c "$fixture/etc/config" get rpcd.familycontrol.password)" = '$p$familycontrol'

# Preserve existing credentials, identity and ACL settings on subsequent installs.
sed -i 's/^familycontrol:x:/familycontrol:!synthetic-retained:/' "$fixture/etc/shadow"
/sbin/uci -c "$fixture/etc/config" set 'rpcd.familycontrol.password=$p$existing-account'
/sbin/uci -c "$fixture/etc/config" set rpcd.familycontrol.read=existing-acl
/sbin/uci -c "$fixture/etc/config" commit rpcd
before="$(sha256sum "$fixture/etc/passwd" "$fixture/etc/shadow" "$fixture/etc/group" "$fixture/etc/config/rpcd")"
run_defaults
after="$(sha256sum "$fixture/etc/passwd" "$fixture/etc/shadow" "$fixture/etc/group" "$fixture/etc/config/rpcd")"
test "$before" = "$after"
echo "PASS native account creation and existing identity/password/ACL preservation"
