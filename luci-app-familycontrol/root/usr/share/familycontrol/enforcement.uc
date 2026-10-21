// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

import { readfile, writefile, popen, mkdir, chmod, rename } from 'fs';
import { connect } from 'ubus';

export const RULES_FILE = '/var/run/familycontrol/enforcement.nft';

function command(text) {
	const pipe = popen(text, 'r');
	if (!pipe)
		die('Unable to start enforcement command');
	const output = pipe.read('all');
	if (pipe.close() != 0)
		die('Enforcement command failed');
	return output;
}

function list(value) {
	return value == null ? [] : type(value) == 'array' ? value : [ value ];
}

function unique(values) {
	return sort(filter(values, (value, position) => position == index(values, value)));
}

function port(value, ports) {
	const number = +value;
	if (number >= 1 && number <= 65535 && number == int(number))
		push(ports, number);
}

function localPorts(ctx) {
	let ports = [];
	ctx.foreach('dropbear', 'dropbear', section => {
		if (section.enable != '0')
			port(section.Port || '22', ports);
	});
	ctx.foreach('uhttpd', 'uhttpd', section => {
		for (let address in [ ...list(section.listen_http), ...list(section.listen_https) ])
			port(substr(address, rindex(address, ':') + 1), ports);
	});
	return unique(ports);
}

function devices(ctx) {
	const zoneName = ctx.get('familycontrol', 'main', 'src_zone') || 'lan';
	let zone;
	ctx.foreach('firewall', 'zone', section => {
		if (section.name == zoneName)
			zone = section;
	});
	if (!zone)
		die('The configured source firewall zone does not exist');

	const bus = connect();
	const interfaces = bus?.call('network.interface', 'dump')?.interface || [];
	let result = list(zone.device);
	for (let name in list(zone.network)) {
		const status = filter(interfaces, item => item.interface == name)[0];
		const device = status?.l3_device || status?.device ||
			ctx.get('network', name, 'device') || ctx.get('network', name, 'ifname');
		if (device)
			push(result, ...split(device, /[ \t]+/));
	}
	for (let device in result)
		if (!match(device, /^[A-Za-z0-9_.:@-]{1,15}$/))
			die('Source zone device patterns are not supported');
	if (!length(result))
		die('No source zone network devices could be resolved');
	return unique(result);
}

function addresses(macs, interfaces) {
	let ipv4 = [], ipv6 = [];
	if (!length(macs) || !length(interfaces))
		return { ipv4, ipv6 };
	const output = command('/sbin/ip -4 neigh show') + command('/sbin/ip -6 neigh show');
	for (let line in split(output, '\n')) {
		const fields = split(trim(line), /[ \t]+/);
		const dev = index(fields, 'dev'), lladdr = index(fields, 'lladdr');
		if (dev < 0 || lladdr < 0 ||
		    index(interfaces, fields[dev + 1]) < 0 ||
		    index(macs, uc(fields[lladdr + 1] || '')) < 0)
			continue;
		const bytes = iptoarr(fields[0]);
		if (length(bytes) == 4 && bytes[0] != 0 && bytes[0] != 127 && bytes[0] < 224)
			push(ipv4, arrtoip(bytes));
		if (length(bytes) == 16 && bytes[0] != 255)
			push(ipv6, arrtoip(bytes));
	}
	return { ipv4: unique(ipv4), ipv6: unique(ipv6) };
}

function localAddresses() {
	let ipv4 = [], ipv6 = [];
	const output = command('/sbin/ip -4 addr show') + command('/sbin/ip -6 addr show');
	for (let line in split(output, '\n')) {
		const fields = split(trim(line), /[ \t]+/);
		if (fields[0] != 'inet' && fields[0] != 'inet6')
			continue;
		const bytes = iptoarr(split(fields[1], '/')[0]);
		if (length(bytes) == 4)
			push(ipv4, arrtoip(bytes));
		if (length(bytes) == 16)
			push(ipv6, arrtoip(bytes));
	}
	return { ipv4: unique(ipv4), ipv6: unique(ipv6) };
}

function set(name, datatype, values, dynamic) {
	return `set familycontrol_${name} {
	type ${datatype}
	${dynamic ? 'flags dynamic; size 4096;' : ''}
	${length(values) ? 'elements = { ' + join(', ', values) + ' }' : ''}
}
`;
}

export function build(ctx, desired) {
	let macs = [];
	for (let _, rule in desired)
		push(macs, ...rule.src_mac);
	macs = unique(macs);
	ctx.foreach('firewall', 'defaults', defaults => {
		if (length(macs) &&
		    (defaults.flow_offloading == '1' || defaults.flow_offloading_hw == '1'))
			die('Disable flow offloading before applying device restrictions');
	});
	const interfaces = length(macs) ? devices(ctx) : [], ports = localPorts(ctx);
	const ips = addresses(macs, interfaces);
	const local = localAddresses();
	const signature = 'familycontrol-v1';
	let text = set('devices', 'ifname', map(interfaces, value => sprintf('%J', value))) +
		set('macs', 'ether_addr', macs) +
		set('management', 'inet_service', ports) +
		set('local4', 'ipv4_addr', local.ipv4) +
		set('local6', 'ipv6_addr', local.ipv6) +
		set('ipv4', 'ipv4_addr', ips.ipv4, true) +
		set('ipv6', 'ipv6_addr', ips.ipv6, true);
	text += `
chain familycontrol_prerouting {
	type filter hook prerouting priority -152; policy accept;
	comment "${signature}"
	iifname @familycontrol_devices ether saddr @familycontrol_macs jump familycontrol_client
}
chain familycontrol_client {
	ip daddr 255.255.255.255 udp sport 68 udp dport 67 return
	fib daddr type local meta nfproto ipv4 udp sport 68 udp dport 67 return
	ip6 daddr ff02::1:2 udp sport 546 udp dport 547 return
	fib daddr type local meta nfproto ipv6 udp sport 546 udp dport 547 return
	icmpv6 type { nd-router-solicit, nd-router-advert, nd-neighbor-solicit, nd-neighbor-advert } ip6 hoplimit 255 return
	fib daddr type local meta l4proto { tcp, udp } th dport 53 return
	fib daddr type local tcp dport @familycontrol_management return
	meta nfproto ipv4 update @familycontrol_ipv4 { ip saddr } counter drop
	meta nfproto ipv6 update @familycontrol_ipv6 { ip6 saddr } counter drop
	counter drop
}
chain familycontrol_forward {
	type filter hook forward priority -1; policy accept;
	oifname @familycontrol_devices ip daddr @familycontrol_ipv4 counter drop
	oifname @familycontrol_devices ip6 daddr @familycontrol_ipv6 counter drop
}
chain familycontrol_output {
	type filter hook output priority -1; policy accept;
	oifname @familycontrol_devices ip daddr @familycontrol_ipv4 jump familycontrol_reply
	oifname @familycontrol_devices ip6 daddr @familycontrol_ipv6 jump familycontrol_reply
}
chain familycontrol_reply {
	fib saddr type local meta nfproto ipv4 udp sport 67 udp dport 68 return
	fib saddr type local meta nfproto ipv6 udp sport 547 udp dport 546 return
	icmpv6 type { nd-router-solicit, nd-router-advert, nd-neighbor-solicit, nd-neighbor-advert } ip6 hoplimit 255 return
	ct direction reply ct original ip daddr @familycontrol_local4 meta l4proto { tcp, udp } ct original proto-dst 53 return
	ct direction reply ct original ip6 daddr @familycontrol_local6 meta l4proto { tcp, udp } ct original proto-dst 53 return
	ct direction reply ct original ip daddr @familycontrol_local4 tcp sport @familycontrol_management return
	ct direction reply ct original ip6 daddr @familycontrol_local6 tcp sport @familycontrol_management return
	counter drop
}
`;
	return { text, signature, macs, interfaces, ...ips, local_ipv4: local.ipv4,
		local_ipv6: local.ipv6, management_ports: ports };
};

export function store(text) {
	mkdir('/var/run/familycontrol', 0700);
	if (!chmod('/var/run/familycontrol', 0700) ||
	    writefile(RULES_FILE + '.tmp', text) != length(text) ||
	    !chmod(RULES_FILE + '.tmp', 0600) ||
	    !rename(RULES_FILE + '.tmp', RULES_FILE))
		die('Unable to persist runtime enforcement rules');
};

function kernel() {
	try {
		return json(command('/usr/sbin/nft -j list table inet fw4 2>/dev/null')).nftables;
	}
	catch (_) {
		return [];
	}
}

function elements(entries, name) {
	const entry = filter(entries, item => item.set?.name == 'familycontrol_' + name)[0];
	if (!entry)
		return null;
	return sort(map(entry.set.elem || [], value => '' + (type(value) == 'object' ? value.elem?.val : value)));
}

export function inspect(model) {
	const entries = kernel();
	const hooks = { familycontrol_prerouting: -152, familycontrol_forward: -1, familycontrol_output: -1 };
	for (let name, priority in hooks) {
		const chain = filter(entries, item => item.chain?.name == name)[0]?.chain;
		if (!chain || chain.prio != priority)
			return { ok: false, message: 'Device restriction chains are not loaded' };
	}
	const gate = filter(entries, item => item.chain?.name == 'familycontrol_prerouting')[0].chain;
	if (gate.comment != model.signature)
		return { ok: false, message: 'Loaded device restrictions differ from configuration' };
	const sets = { macs: map(model.macs, lc), devices: model.interfaces,
		management: model.management_ports, local4: model.local_ipv4, local6: model.local_ipv6 };
	for (let name, values in sets)
		if (sprintf('%J', elements(entries, name)) != sprintf('%J', sort(map(values, value => '' + value))))
			return { ok: false, message: 'Loaded device restriction sets differ from configuration' };
	const counts = { familycontrol_prerouting: 1, familycontrol_client: 10,
		familycontrol_forward: 2, familycontrol_output: 2, familycontrol_reply: 8 };
	for (let name, count in counts)
		if (length(filter(entries, item => item.rule?.chain == name)) != count)
			return { ok: false, message: 'Device restriction rules are incomplete' };
	return { ok: true, backend: 'fw4/nftables' };
};

export function refreshAddresses(model) {
	const entries = kernel();
	let commands = [];
	for (let name, values in { ipv4: model.ipv4, ipv6: model.ipv6 }) {
		if (sprintf('%J', elements(entries, name)) == sprintf('%J', sort(values)))
			continue;
		push(commands, 'flush set inet fw4 familycontrol_' + name);
		if (length(values))
			push(commands, 'add element inet fw4 familycontrol_' + name + ' { ' + join(', ', values) + ' }');
	}
	if (length(commands)) {
		if (writefile('/var/run/familycontrol/addresses.batch', join('\n', commands) + '\n') == null)
			die('Unable to prepare address update');
		command('/usr/sbin/nft -f /var/run/familycontrol/addresses.batch');
	}
};
