// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

import { readfile } from 'fs';
import { cursor } from 'uci';
import { personAccess } from '/usr/share/familycontrol/schedule.uc';

const api = loadfile('/usr/share/rpcd/ucode/familycontrol')().familycontrol;
let checks = 0;
function check(value, label) {
	if (!value)
		die('FAIL ' + label);
	checks++;
}
check(!!api.preview_schedule, 'draft schedule preview is supported');
const before = readfile('/etc/config/familycontrol');
const firewallBefore = readfile('/etc/config/firewall');
const reloadsBefore = readfile('/tmp/firewall-reloads');
const runtimeBefore = readfile('/var/run/familycontrol/runtime.json');
const range = {repeat: 'range', start_date: '2026-10-23', end_date: '2026-10-25',
	start: '19:30:00', end: '20:15:30'};
const draft = {person: 'alice', format: 'windows', policy: 'allow', windows: [range],
	at_local: '2026-10-23T19:30:00'};
const preview = api.preview_schedule.call({args: draft});
check(preview.ok && preview.online && preview.reason.matched_rules[0].index == 1,
	'continuous range preview includes start');
check(preview.inspected_local == '2026-10-23 19:30:00' &&
	preview.next_transition_local == '2026-10-25 20:15:30', 'preview uses router civil time');
check(preview.preview_end_local == '2026-10-30 19:30:00', 'preview spans seven router-local days');
if (getenv('TZ') == 'CET-1CEST,M3.5.0,M10.5.0/3')
	check(preview.preview_end - preview.inspected == 7 * 86400 + 3600,
		'preview horizon accounts for autumn clock change');
check(preview.segments[0].start == preview.inspected &&
	preview.segments[0].end == preview.next_transition && !preview.segments[1].online,
	'preview segments meet at exact decision boundary');
const epochPreview = api.preview_schedule.call({args: {...draft, at_local: '', at_epoch: preview.inspected}});
check(epochPreview.ok && epochPreview.inspected_local == preview.inspected_local,
	'timeline epoch inspection uses router time without browser conversion');
check(!api.preview_schedule.call({args: {...draft, at_epoch: preview.inspected}}).ok,
	'ambiguous epoch and civil inspection rejected');
check(length(preview.timeline_days) >= 7 && preview.diagnostics.from == preview.inspected &&
	preview.diagnostics.until == preview.preview_end, 'timeline and diagnostics share the preview horizon');
const ctx = cursor();
const candidate = {mode: 'schedule', schedule_policy: 'allow', schedule_windows: sprintf('%J', [range])};
for (let segment in preview.segments) {
	check(segment.online == personAccess(ctx, candidate, segment.start).online, 'segment agrees with execution engine');
	check(segment.online == personAccess(ctx, candidate, segment.end - 1).online, 'segment remains valid to last second');
}
check(api.preview_schedule.call({args: {...draft, at_local: '2026-10-25T20:15:30'}}).online == false,
	'preview excludes end');
check(api.preview_schedule.call({args: {...draft, windows: []}}).segments[0].online == false,
	'empty allow preview blocks despite saved manual mode');
check(api.preview_schedule.call({args: {...draft, policy: 'block', windows: []}}).online,
	'empty block preview allows');
const mixedWindows = [{repeat: 'daily', all_day: true, action: 'allow', priority: 0},
	{...range, action: 'block', priority: 10}];
const mixedPreview = api.preview_schedule.call({args: {...draft, windows: mixedWindows}});
check(mixedPreview.ok && !mixedPreview.online && mixedPreview.reason.winning_rules[0] == 2,
	'preview explains winning block exception');
const mixedCandidate = {mode: 'schedule', schedule_policy: 'allow',
	schedule_windows: sprintf('%J', mixedWindows)};
for (let segment in mixedPreview.segments)
	check(segment.online == personAccess(ctx, mixedCandidate, segment.start).online &&
		segment.online == personAccess(ctx, mixedCandidate, segment.end - 1).online,
		'mixed preview agrees with execution through boundaries');
check(mixedPreview.next_transition_local == '2026-10-25 20:15:30',
	'mixed preview ignores masked daily boundaries');
check(!api.preview_schedule.call({args: {...draft, windows: [{...range, priority: 101}]}}).ok &&
	!api.save_schedule.call({args: {...draft, windows: [{...range, priority: 101}]}}).ok,
	'preview and save both reject invalid priority');
const current = api.preview_schedule.call({args: {...draft, at_local: ''}});
check(current.ok && current.inspected >= time() - 5, 'empty inspection time defaults to router now');
const legacy = api.preview_schedule.call({args: {person: 'alice', format: 'legacy',
	school_schedule: '111111111111111111111111111111111111111111111111',
	dayoff_schedule: '111111111111111111111111111111111111111111111111',
	school_night_cutoff: 1320, dayoff_night_cutoff: 1320, at_local: '2026-10-23T21:59:59'}});
check(legacy.ok && legacy.online && legacy.next_transition_local == '2026-10-23 22:00:00',
	'legacy preview retains cutoffs');
let frequent = [];
for (let hour = 0; hour < 12; hour++)
	push(frequent, {repeat: 'daily', start: sprintf('%02d:00:00', hour), end: sprintf('%02d:30:00', hour)});
const bounded = api.preview_schedule.call({args: {...draft, windows: frequent, at_local: '2026-10-23T00:00:00'}});
check(bounded.ok && length(bounded.segments) == 32 && bounded.truncated, 'bounded preview explicitly reports truncation');
check(bounded.segments[31].end < bounded.preview_end, 'truncation does not invent final segment');
for (let args in [
	{...draft, at_local: '2026-02-30T12:00:00'},
	{...draft, at_local: '2026-10-23T24:00:00'},
	{...draft, at_local: '2026-10-23T19:30:00Z'},
	{...draft, person: 'missing'},
	{...draft, policy: 'deny'},
	{...draft, windows: [{...range, end_date: '2026-10-22'}]},
	{...draft, format: 'unknown'}
])
	check(!api.preview_schedule.call({args}).ok, 'invalid preview rejected');
check(!api.save_schedule.call({args: {...draft, windows: [{...range, end_date: '2026-10-22'}]}}).ok,
	'save uses same validation as preview');
check(readfile('/etc/config/familycontrol') == before, 'preview and invalid save preserve configuration');
check(readfile('/etc/config/firewall') == firewallBefore && readfile('/tmp/firewall-reloads') == reloadsBefore,
	'preview never writes firewall or reloads');
check(readfile('/var/run/familycontrol/runtime.json') == runtimeBefore, 'preview never appends runtime events');
print('PASS ' + checks + ' draft preview and readonly checks\n');
