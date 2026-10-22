// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

import { readfile, writefile, stat } from 'fs';
import { RUNTIME_FILE, runtimeState, recordRuntime } from '/usr/share/familycontrol/runtime.uc';

let checks = 0;
function check(value, label) {
	if (!value) die('FAIL ' + label);
	checks++;
}
const now = time();
const decision = {alice: {online: false, reason: 'schedule', priority: 10, rules: [2]}};
check(recordRuntime(now, {ok: true}, decision, 'tick', false, false), 'runtime record writes');
const permissions = stat(RUNTIME_FILE).perm;
check(permissions.user_read && permissions.user_write && !permissions.user_exec &&
	!permissions.group_read && !permissions.group_write && !permissions.group_exec &&
	!permissions.other_read && !permissions.other_write && !permissions.other_exec,
	'runtime data is private to root');
let state = runtimeState(), before = length(state.events);
check(recordRuntime(now + 1, {ok: true}, decision, 'tick', false, false), 'no-op runtime check writes heartbeat');
check(length(runtimeState().events) == before, 'no-op check does not append an event');
recordRuntime(now + 2, {ok: true}, decision, 'tick', false, true);
check(runtimeState().events[length(runtimeState().events) - 1].code == 'clock_changed', 'clock correction recorded');
recordRuntime(now + 3, {ok: false, message: 'Synthetic failure'}, {}, 'tick', false, false);
before = length(runtimeState().events);
recordRuntime(now + 4, {ok: false, message: 'Synthetic failure'}, {}, 'tick', false, false);
check(length(runtimeState().events) == before, 'repeated identical error is not spammed');
check(runtimeState().last_success == now + 2, 'failure preserves last successful check');
for (let i = 0; i < 110; i++)
	recordRuntime(now + 5 + i, {ok: true, person: 'alice'}, decision, 'set_mode', false, false);
check(length(runtimeState().events) == 100, 'memory event list is bounded');
const oldFile = readfile(RUNTIME_FILE);
writefile(RUNTIME_FILE, '{"events":{},"decisions":[]}');
check(recordRuntime(now, {ok: true}, {}, 'tick', false, false), 'malformed diagnostic structures recover');
writefile(RUNTIME_FILE, oldFile);
recordRuntime(now, {ok: true}, {}, 'tick', false, false);
print('PASS ' + checks + ' bounded runtime diagnostics checks\n');
