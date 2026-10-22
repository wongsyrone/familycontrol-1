// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

import { readfile, writefile } from 'fs';

const api = loadfile('/usr/share/rpcd/ucode/familycontrol')().familycontrol;
const previous = readfile('/etc/config/dhcp') || '';
let checks = 0;
function check(value, label) {
	if (!value)
		die('FAIL ' + label);
	checks++;
}

writefile('/etc/config/dhcp', `config dnsmasq
	option leasefile /tmp/familycontrol-discovery.leases
config dnsmasq
	option leasefile /tmp/familycontrol-discovery-extra.leases
config host static_phone
	option name Static-Phone
	option mac '02:00:00:00:00:a1 02:00:00:00:00:A2'
	option ip 192.0.2.101
config host listed_macs
	option name Static-Tablet
	list mac 02:00:00:00:00:a3
	list mac invalid
	option ip 192.0.2.103
config host disabled_host
	option enable 0
	option name Disabled-Phone
	option mac 02:00:00:00:00:AF
`);
writefile('/tmp/familycontrol-discovery.leases',
	'2000000000 02:00:00:00:00:a1 192.0.2.101 Runtime-Phone *\n' +
	'2000000000 02:00:00:00:00:a4 192.0.2.104 Dynamic-Phone *\n' +
	'1 02:00:00:00:00:a5 192.0.2.105 Expired-Phone *\n');
writefile('/tmp/familycontrol-discovery-extra.leases',
	'0 02:00:00:00:00:a6 192.0.2.106 Other-Instance *\n');

try {
	const result = api.devices.call();
	check(result.ok, 'device discovery succeeds');
	let devices = {};
	for (let device in result.devices)
		devices[device.mac] = device;
	check(!!devices['02:00:00:00:00:A2'], 'static reservation without runtime lease');
	check(!!devices['02:00:00:00:00:A3'], 'UCI MAC list supported');
	check(!devices.invalid && !devices['02:00:00:00:00:AF'], 'invalid and disabled hosts excluded');
	check(!!devices['02:00:00:00:00:A4'], 'configured leasefile used');
	check(!!devices['02:00:00:00:00:A6'], 'multiple dnsmasq leasefiles merged');
	check(!devices['02:00:00:00:00:A5'], 'expired lease excluded');
	check(!devices['DE:AD:BE:EF:00:01'], 'old default leasefile not used with custom instances');
	const phone = devices['02:00:00:00:00:A1'];
	check(phone.hostname == 'Static-Phone', 'configured name retained');
	check(index(phone.sources, 'static') >= 0 && index(phone.sources, 'lease') >= 0,
		'duplicate sources merged');
	check(length(filter(result.devices, item => item.mac == phone.mac)) == 1, 'MAC deduplicated');
	check(!phone.connected, 'reservation and lease are not proof of network detection');
	check(!!devices['00:11:22:33:44:55']?.assigned_person, 'saved ownership retained');
	print('PASS ' + checks + ' device discovery checks\n');
}
catch (error) {
	writefile('/etc/config/dhcp', previous);
	die(error.message);
}
writefile('/etc/config/dhcp', previous);
