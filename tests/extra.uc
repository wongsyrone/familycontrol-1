// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

import { readfile } from 'fs';
import { cursor } from 'uci';

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
check(!!api.set_extra_until && !!api.cancel_extra, 'deadline and cancellation APIs exist');
function localClock(value) {
	const spec = localtime(value);
	return sprintf('%04d-%02d-%02dT%02d:%02d:%02d', spec.year, spec.mon, spec.mday, spec.hour, spec.min, spec.sec);
}
const originalMode = cursor().get('familycontrol', 'alice', 'mode');
api.set_mode.call({args: {person: 'alice', mode: 'paused'}});
const deadline = time() + 1811, untilLocal = localClock(deadline);
const beforeDeadline = readfile('/etc/config/familycontrol');
const deadlinePreview = api.preview_extra.call({args: {person: 'alice', until_local: untilLocal}});
check(deadlinePreview.ok && deadlinePreview.extra_until == deadline && deadlinePreview.resume_mode == 'paused',
	'exact deadline uses router-local seconds and preserves original mode');
check(readfile('/etc/config/familycontrol') == beforeDeadline, 'deadline preview is readonly');
const exact = api.set_extra_until.call({args: {person: 'alice', until_local: untilLocal}});
check(exact.ok && exact.extra_until == deadline, 'exact deadline replaces existing extra time');
const cancelled = api.cancel_extra.call({args: {person: 'alice'}});
check(cancelled.ok && cursor().get('familycontrol', 'alice', 'mode') == 'paused' &&
	!cursor().get('familycontrol', 'alice', 'extra_until'), 'cancellation preserves mode and removes only override');
const cancelAgain = api.cancel_extra.call({args: {person: 'alice'}});
check(cancelAgain.ok, 'cancellation is idempotent');
const afterCancellation = readfile('/etc/config/familycontrol');
for (let value in ['', 'bad', localClock(time() - 1), localClock(time() + 90000)])
	check(!api.set_extra_until.call({args: {person: 'alice', until_local: value}}).ok, 'invalid deadline rejected');
check(!api.preview_extra.call({args: {person: 'alice', until_local: untilLocal, minutes: 15}}).ok,
	'conflicting duration and deadline rejected');
check(readfile('/etc/config/familycontrol') == afterCancellation, 'invalid deadlines do not write configuration');
api.set_mode.call({args: {person: 'alice', mode: originalMode}});
print('PASS ' + checks + ' extra-time preview and validation checks\n');
