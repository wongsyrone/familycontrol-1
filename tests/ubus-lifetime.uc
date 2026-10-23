// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

import { lsdir, readfile, writefile } from 'fs';
import { cursor } from 'uci';
import { build } from '/usr/share/familycontrol/enforcement.uc';

function check(condition, message) {
	if (!condition)
		die('FAIL ' + message + '\n');
}

const mode = ARGV[0] || 'all';
if (mode == 'all' || mode == 'model') {
	const baseline = length(lsdir('/proc/self/fd'));
	const ctx = cursor();
	for (let i = 0; i < 300; i++)
		build(ctx, { test: { src_mac: ['00:11:22:33:44:55'] } });
	const after = length(lsdir('/proc/self/fd'));
	check(after <= baseline + 4,
		sprintf('enforcement connection lifetime: %d -> %d file descriptors', baseline, after));
	print('PASS enforcement ubus connections remain bounded across 300 builds\n');
}

if (mode == 'all' || mode == 'scheduler') {
	let source = readfile('/usr/sbin/familycontrol-scheduler');
	const tick = "result = bus?.call('familycontrol', 'tick', { clock_changed: !!clockChanged });";
	check(index(source, tick) >= 0, 'scheduler tick interception matches');
	source = replace(source, "import { readfile }", "import { readfile, lsdir }");
	source = replace(source, "while (true) {",
		"let probes = 0, failures = 0, connections = 0; const baseline = length(lsdir('/proc/self/fd'));\nwhile (true) {");
	source = replace(source, "const next = +(readfile('/var/run/familycontrol/next-check') || 0);",
		"const next = 0;");
	source = replace(source, tick, "if (!bus) failures++; connections++; result = { ok: true };");
	source = replace(source, "sleep(1000 - int(clock()[1] / 1000000));", `
	if (++probes == 300) {
		const after = length(lsdir('/proc/self/fd'));
		if (failures || connections != 300 || after > baseline + 4)
			die(sprintf('FAIL scheduler connection lifetime: %d -> %d, failures=%d, connections=%d\\n', baseline, after, failures, connections));
		print('PASS scheduler ubus connections remain bounded across 300 ticks\\n');
		exit(0);
	}
	sleep(1);`);
	check(writefile('/tmp/familycontrol-scheduler-lifetime.uc', source) != null, 'write scheduler probe');
	check(system('/usr/bin/ucode /tmp/familycontrol-scheduler-lifetime.uc') == 0,
		'scheduler connection lifetime');
	source = replace(source, 'result = { ok: true };', "die('injected-ubus-failure');");
	source = replace(source, 'retryAfter = now + 5;', 'retryAfter = 0;');
	source = replace(source, 'PASS scheduler ubus connections remain bounded across 300 ticks',
		'PASS scheduler exceptions close all 300 ubus connections');
	check(writefile('/tmp/familycontrol-scheduler-error.uc', source) != null, 'write scheduler error probe');
	check(system('/usr/bin/ucode /tmp/familycontrol-scheduler-error.uc') == 0,
		'scheduler exceptional connection lifetime');
}

if (mode == 'all' || mode == 'error') {
	const source = readfile('/usr/share/familycontrol/enforcement.uc');
	const call = "bus?.call('network.interface', 'dump')";
	check(index(source, call) >= 0, 'interface lookup interception matches');
	check(writefile('/tmp/familycontrol-enforcement-error.uc',
		replace(source, call, "die('injected-ubus-failure')")) != null, 'write error module');
	check(writefile('/tmp/familycontrol-enforcement-error-probe.uc', `
import { lsdir } from 'fs';
import { cursor } from 'uci';
import { build } from '/tmp/familycontrol-enforcement-error.uc';
const baseline = length(lsdir('/proc/self/fd'));
const ctx = cursor();
let caught = 0;
for (let i = 0; i < 300; i++) {
	try { build(ctx, { test: { src_mac: ['00:11:22:33:44:55'] } }); }
	catch (error) {
		if (index(error.message || '', 'injected-ubus-failure') < 0) die(error);
		caught++;
	}
}
const after = length(lsdir('/proc/self/fd'));
if (caught != 300 || after > baseline + 4)
	die(sprintf('FAIL exceptional connection lifetime: %d -> %d, caught=%d\\n', baseline, after, caught));
print('PASS interface lookup exceptions close all 300 ubus connections\\n');
`) != null, 'write error probe');
	check(system('/usr/bin/ucode /tmp/familycontrol-enforcement-error-probe.uc') == 0,
		'exceptional connection lifetime');
}
