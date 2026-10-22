# Family Control for OpenWrt

## Local adaptation

The `main` branch maintains the backend and both JavaScript
interfaces together, while keeping the upstream single-package layout.
It adds fw4 includes for device restrictions before transparent proxy
interception, runtime kernel-state checks, and rollback reporting.
DHCP, router DNS, IPv6 neighbour discovery and configured Dropbear/uhttpd
management ports remain available to restricted devices.

Flow offloading must be disabled before restrictions can be applied. The
package reports an error instead of changing that global setting.
Use OpenWrt with nftables support for `destroy set` (Linux 6.12/6.18 and current
nftables are the local test targets). Full application of the rules requires
fw4 automatic includes, which are enabled by default.

Installation preserves existing calendar and login configuration. It does not
import the bundled Czech holiday file or change the router timezone.
The login account uses OpenWrt's native account helpers with an allocated
UID/GID, preserving an existing identity and password without a shadow-utils
dependency.
The LuCI page provides status and explicit Allow always, Block always and
Use schedule controls; `/family/` remains the complete people, device and
schedule editor. Both pages show the control mode. Manual modes last until
changed; Use schedule also ends an extra-time override.

Each person's card has an Edit schedule button and a rule summary. Save schedule
keeps the current mode, while Save and use schedule saves and activates the rules
in one transaction. Times use the router's timezone, with second precision and
overnight windows. Device editing can move an existing device to another person
without deleting it. Deletions require a named confirmation that describes the
affected assignments.

Schedules support recurring clock times, one-time dates, and continuous date/time
ranges. A time range includes its start and excludes its end; an all-day date
range includes the entire final date. The router's timezone is authoritative.
Nonexistent local times at a daylight-saving jump are rejected; an ambiguous
date/time endpoint uses its first occurrence.

School / day-off dates is a shared date classification table, not a second
access policy. Its month view supports multi-selection, batch date ranges and
restoring defaults. Only School days, Days off and legacy school-day schedules
use these labels. Regular weekdays and continuous date ranges ignore them.
All windows for one person use the same allow/block policy and combine as a
union; mixed per-rule allow/block exceptions and daily usage quotas are not
implemented.

Both interfaces explain the configured access decision, including manual modes,
extra time, matching rule numbers, calendar classifications and invalid schedules.
An unapplied firewall state is labelled separately rather than presented as a
successful restriction. Overnight matches identify their starting date.

The schedule editor has a read-only **Preview before saving** panel. Inspect any
router-local date/time, or leave it empty for router now. The preview assumes
automatic schedule mode with no extra-time override and uses the saved shared
calendar. It shows the decision, matching rules, next change and the next seven
local days of allowed/blocked intervals. At most 32 intervals are returned;
truncation is explicit. Preview and enforcement share the same matcher, while
preview and saving share validation. Preview never saves, activates or reloads.

Extra time keeps the 15/30/60-minute shortcuts and adds a custom hours/minutes
dialog (1–1440 minutes per grant). Its read-only preview and the actual grant
share the same backend calculation and display the router's local deadline.
Extra time extends an existing grant, otherwise the current allowed period,
or starts now when blocked. Expiry restores the existing control mode.

Device choices merge static DHCP reservations, configured dnsmasq leasefiles,
saved assignments and IPv4/IPv6 neighbours by MAC. Recently detected means a
neighbour-table observation, not a live connectivity test. A reservation or
lease alone is not proof that a device is online.

The privileged packet tests require a **disposable** OpenWrt rootfs, because
they replace its synthetic configuration. They create private mount, PID and
network namespaces and never connect to a router:

```sh
sudo python3 tests/nft-integration.py /absolute/path/to/disposable-openwrt-rootfs
```

These tests exercise fw4 and simulated transparent proxy packet paths, not a
full Nikki/Mihomo deployment. The original Docker integration entry point
continues to use the same OpenWrt business regression checks.

A mobile-first, person-centric internet access controller for OpenWrt.

The first release will let an administrator:

- create a person;
- assign one or more devices to that person;
- pause, resume, or schedule internet access for all of the person's devices;
- grant temporary extra time;
- distinguish school days from days off using configured holidays and
  school-specific exceptions; and
- use the same LuCI interface remotely over Tailscale.

See [docs/design.md](docs/design.md) for the initial architecture and scope,
and [docs/architecture-risk-analysis.md](docs/architecture-risk-analysis.md)
for the current threat model and prioritized risk register.

## Development target

- OpenWrt 25.12
- LuCI JavaScript frontend
- rpcd/ucode backend
- firewall4/nftables enforcement
- remote access through an existing Tailscale connection

The package source is in `luci-app-familycontrol/`.

## Development checks

The checks require Node.js, `jq`, Docker, and internet access for the first
OpenWrt container package download:

```sh
./tests/check.sh
```

They validate JavaScript and JSON syntax, compile the rpcd ucode plugin, and run
pause/resume through real ubus, rpcd, UCI, and firewall4 components in an
OpenWrt container.

## AWS CI/CD learning environment

An optional AWS CodeBuild and CodePipeline implementation of these checks is
defined under [`aws/`](aws/README.md). It uses OpenTofu and intentionally
creates no release deployment, network path to the router, or deployment
credentials.

## Local security scan

Run an OWASP ZAP passive baseline scan from a laptop that can reach the router:

```sh
npm run test:zap
```

The command runs ZAP in Docker, maps `family.hajma.cz` to `192.168.1.1` inside
the container, and writes HTML, JSON, and Markdown reports under
`reports/zap/`. Reports are ignored by Git because they can contain details
about the local network.

The scan is deliberately not run by GitHub Actions: the target is LAN-only.
It is passive and does not perform ZAP's active attacks. Warnings are included
in the reports without making the command fail.

Override the defaults when needed:

```sh
ZAP_TARGET=https://family.hajma.cz/family/ \
ZAP_TARGET_IP=192.168.1.1 \
npm run test:zap
```

The baseline scan is unauthenticated, so it covers the login page and other
publicly reachable resources. Do not put the Family Control password in this
script or commit it to the repository.

## Privacy-safe telemetry

Release `r17` includes an optional, disabled-by-default OpenTelemetry metrics
exporter for Grafana Cloud. It reports aggregate Family Control enforcement
health and basic router health without exporting names, MAC addresses, IP
addresses, hostnames, or browsing activity.

See [docs/telemetry.md](docs/telemetry.md) for the metric catalog, Grafana
configuration, secret handling, dashboard import, and operational behavior.

## Software bill of materials

The repository includes a deterministic CycloneDX SBOM at
[`sbom/familycontrol.cdx.json`](sbom/familycontrol.cdx.json). It distinguishes
development-only npm packages from the OpenWrt runtime dependencies declared by
the application package. Regenerate and verify it with:

```sh
npm run sbom
npm run sbom:check
```

OpenWrt resolves the exact runtime package versions when the APK is installed,
so those components are identified by package name and explicitly marked as
installation-resolved. CI rejects a stale checked-in SBOM and retains the
verified file as a workflow artifact.

## Installing a development build

The package built for OpenWrt 25.12.4 is:

```text
dist/luci-app-familycontrol-0.1.0-r17.apk
SHA-256: 15ee72fe32c4742e81eb0f96acddc39d63aaf201d4b21962b064d0a0ce4efb70
```

Copy it to the router, install it, and restart rpcd:

```sh
ssh root@openwrt \
  'cat > /tmp/luci-app-familycontrol-0.1.0-r17.apk' \
  < dist/luci-app-familycontrol-0.1.0-r17.apk
ssh root@openwrt
apk add --allow-untrusted /tmp/luci-app-familycontrol-0.1.0-r17.apk
/etc/init.d/rpcd restart
/etc/init.d/familycontrol-scheduler restart
```

The package is unsigned because it is a local development build. Verify its
checksum before copying it if it is transferred through an untrusted system.

To build it from source with the OpenWrt 25.12 SDK, expose
`luci-app-familycontrol/` as an SDK package and use:

```sh
make defconfig
make NO_DEPS=1 package/luci-app-familycontrol/compile V=s
```

`NO_DEPS=1` is appropriate for this architecture-independent package: its
firewall4, LuCI, rpcd, and ucode dependencies are runtime dependencies already
provided by the router. It also prevents the release SDK's buildbot
configuration from repackaging every selected kernel module.

To uninstall the application:

```sh
apk del luci-app-familycontrol
/etc/init.d/rpcd restart
```

The application appears under **Services → Family Control**. Configure people
and devices first, then use the Overview page for pause/resume.

## Standalone family interface

Release `r9` also provides a mobile standalone interface at:

```text
https://family.hajma.cz/family/
```

It uses the separate `familycontrol` account, whose rpcd access is limited to
the Family Control business API, with no general UCI write access. Set its password on the router
after installation:

```sh
passwd familycontrol
```

When adding a device, the interface offers static DHCP reservations, leasefile
clients and neighbours by hostname, IP address, and MAC address. Manual MAC entry
remains available. Saved devices show a Recently detected or Not recently detected
indicator based on the router's validated neighbour table, rather than the
longer-lived DHCP lease. The page refreshes this state every 30 seconds while
no editor is open.

## Schedules and school calendar

Schedules use the router's local time. Before relying on them, make sure
OpenWrt is configured for the household's timezone. These Prague settings are
an upstream example; retain the settings appropriate to your household:

```sh
uci set system.@system[0].zonename='Europe/Prague'
uci set system.@system[0].timezone='CET-1CEST,M3.5.0,M10.5.0/3'
uci commit system
/etc/init.d/system reload
/etc/init.d/rpcd restart
/etc/init.d/familycontrol-scheduler restart
```

Verify that `date` on the router reports `CET` or `CEST`. A UTC-configured
router would enforce a 22:00 cutoff at midnight during Czech summer time.

Each person can be **Online**, **Paused**, or set to **Use schedule**. Select
**Edit schedule** to edit time windows with `HH:mm:ss` precision:

- Repeat every day, Monday to Friday, weekends, selected weekdays, or once on
  a specific date. Optional School days / Days off use the existing calendar.
- Choose **Allow internet only during these windows** (blocked otherwise) or
  **Block internet only during these windows** (allowed otherwise).
- Multiple windows form a union. Start is included and end is excluded.
  Friday `22:00:01` to `02:00:03` lasts until Saturday `02:00:03`;
  the Friday recurrence controls that overnight window.
- Use **All day** for a whole day. Recurring windows otherwise require different
  start and end times. Continuous date/time ranges must end after they start.
  Empty Allow schedules block all the time; empty Block schedules allow all the time.

New people start with a daily `06:00:00` to `22:00:00` Allow schedule.
Existing half-hour school/day-off schedules and evening cutoffs keep their
original behavior. The editor identifies these as an existing school-day
schedule; explicitly selecting Dates and times and saving replaces that timing
model. Ordinary weekday repeats ignore school-calendar exceptions.

The ucode scheduler checks its clock and a RAM deadline once per second.
It reconciles at the next transition, after a clock correction, and at least
every 30 seconds for rule recovery. Idle checks do not start subprocesses or
reload the firewall. This is second-resolution scheduling, not a hard
real-time guarantee: system load and firewall application take time.

The **Extra time** menu adds 15, 30, or 60 minutes, or a custom duration, and can be used repeatedly.
During scheduled online time it extends the next cutoff; while paused or
outside the schedule it grants temporary online access. Choosing Online,
Paused, or Use schedule cancels the temporary override.

The optional bundled Czech statutory-holiday calendar covers 2026 through 2035.
It is not imported automatically in this branch and is generated deterministically with:

```sh
npm run holidays
```

Use **School / day-off dates** in the standalone app for school vacations,
director-declared days off, or exceptional school Saturdays. An explicit
School day entry overrides weekends and public holidays; otherwise an explicit
Day off entry overrides the normal weekday classification.

For LAN name resolution, configure dnsmasq to answer locally and not forward
IPv6 queries to public DNS:

```sh
uci add_list dhcp.@dnsmasq[0].address='/family.hajma.cz/192.168.1.1'
uci add_list dhcp.@dnsmasq[0].server='/family.hajma.cz/'
uci commit dhcp
/etc/init.d/dnsmasq restart
```

The router uses a Let's Encrypt certificate obtained with automated DNS-01
validation. The service remains limited to LAN and, eventually, Tailscale:
uhttpd is not exposed through the WAN firewall. See
[docs/https.md](docs/https.md) for DNS, certificate renewal, recovery, and
secret-handling details.

Do not publish LuCI on the WAN. Connect to its Tailscale address to manage it
remotely.

## License

Family Control is free software licensed under the
[GNU General Public License, version 3 or later](LICENSE).
