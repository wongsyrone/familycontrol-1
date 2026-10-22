// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

import { readfile } from 'fs';

const api = loadfile('/usr/share/rpcd/ucode/familycontrol')().familycontrol;
let checks = 0;
function check(value, label) {
	if (!value)
		die('FAIL ' + label);
	checks++;
}
check(!!api.preview_extra, 'custom extra-time preview is supported');
const before = readfile('/etc/config/familycontrol');
const preview = api.preview_extra.call({args: {person: 'alice', minutes: 37}});
check(preview.ok && preview.extra_until - preview.from == 37 * 60, 'custom 37-minute preview');
check(readfile('/etc/config/familycontrol') == before, 'preview does not save configuration');
check(!!preview.extra_until_local && !!preview.from_local, 'preview uses router local time');
const granted = api.add_extra.call({args: {person: 'alice', minutes: 37}});
check(granted.ok && granted.extra_until >= preview.extra_until &&
	granted.extra_until - preview.extra_until < 5, 'grant agrees with fresh preview');
const appended = api.preview_extra.call({args: {person: 'alice', minutes: 90}});
check(appended.from == granted.extra_until, 'append starts at existing extra-time end');
const second = api.add_extra.call({args: {person: 'alice', minutes: 90}});
check(second.ok && second.extra_until == appended.extra_until, 'append agrees exactly with preview');
const after = readfile('/etc/config/familycontrol');
for (let minutes in [0, -1, 1441, '37', 1.5]) {
	const invalid = api.add_extra.call({args: {person: 'alice', minutes}});
	check(!invalid.ok && invalid.code == 'invalid_duration', 'invalid duration rejected');
}
check(readfile('/etc/config/familycontrol') == after, 'invalid requests do not change configuration');
check(api.preview_extra.call({args: {person: 'alice', minutes: 1440}}).ok, '24-hour upper bound');
check(!api.preview_extra.call({args: {person: 'missing', minutes: 30}}).ok, 'unknown person rejected');
print('PASS ' + checks + ' extra-time preview and validation checks\n');
