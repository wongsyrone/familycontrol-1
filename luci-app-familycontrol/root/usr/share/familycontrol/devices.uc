// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

import { readfile, popen } from 'fs';

const MAC_PATTERN = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/;

function words(value) {
	return split(join(' ', type(value) == 'array' ? value : [ value || '' ]), /[ \t]+/);
}

function addAddress(device, address) {
	const bytes = iptoarr(address || '');
	if (length(bytes) == 4 || length(bytes) == 16) {
		const normalized = arrtoip(bytes);
		if (index(device.addresses, normalized) < 0)
			push(device.addresses, normalized);
	}
}

export function networkNeighbors() {
	let devices = {}, available = false;
	for (let family in [ '-4', '-6' ]) {
		const pipe = popen('/sbin/ip ' + family + ' neigh show 2>/dev/null', 'r');
		if (!pipe)
			continue;
		const output = pipe.read('all');
		if (pipe.close() != 0)
			continue;
		available = true;
		for (let line in split(output || '', '\n')) {
			const fields = split(trim(line), /[ \t]+/);
			const position = index(fields, 'lladdr');
			const mac = uc(fields[position + 1] || '');
			if (position < 0 || !match(mac, MAC_PATTERN) ||
			    index(fields, 'FAILED') >= 0 || index(fields, 'INCOMPLETE') >= 0)
				continue;
			devices[mac] ||= { addresses: [] };
			addAddress(devices[mac], fields[0]);
		}
	}
	return available ? devices : null;
};

export function discoverDevices(ctx) {
	const neighbors = networkNeighbors();
	let devices = {}, paths = [];
	function entry(value, source) {
		const mac = uc(value || '');
		if (!match(mac, MAC_PATTERN))
			return null;
		devices[mac] ||= { mac, hostname: '', addresses: [], sources: [],
			assigned_person: null, connected: neighbors ? !!neighbors[mac] : null };
		const device = devices[mac];
		if (index(device.sources, source) < 0)
			push(device.sources, source);
		return device;
	}

	ctx.foreach('dhcp', 'dnsmasq', section => {
		const path = section.leasefile || '/tmp/dhcp.leases';
		if (index(paths, path) < 0)
			push(paths, path);
	});
	if (!length(paths))
		push(paths, '/tmp/dhcp.leases');
	ctx.foreach('dhcp', 'host', section => {
		if (section.enable == '0')
			return;
		for (let mac in words(section.mac)) {
			const device = entry(mac, 'static');
			if (!device)
				continue;
			device.hostname = section.name || device.hostname;
			addAddress(device, section.ip);
		}
	});
	const now = time();
	for (let path in paths)
		for (let line in split(readfile(path) || '', '\n')) {
			const fields = split(trim(line), /[ \t]+/);
			if (length(fields) < 4 || !match(fields[0], /^[0-9]+$/) ||
			    (+fields[0] != 0 && +fields[0] <= now))
				continue;
			const device = entry(fields[1], 'lease');
			if (!device)
				continue;
			addAddress(device, fields[2]);
			if (!device.hostname && fields[3] != '*')
				device.hostname = fields[3];
		}
	ctx.foreach('familycontrol', 'device', section => {
		const device = entry(section.mac, 'saved');
		if (device) {
			device.assigned_person = section.person || null;
			device.hostname ||= section.name || '';
		}
	});
	for (let mac, neighbor in neighbors || {}) {
		const device = entry(mac, 'neighbor');
		for (let address in neighbor.addresses)
			addAddress(device, address);
	}
	let result = [];
	for (let _, device in devices) {
		device.ip = device.addresses[0] || '';
		push(result, device);
	}
	return result;
};
