// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

import { localInstant, validateWindows, personAccess, nextTransition } from '/usr/share/familycontrol/schedule.uc';

let checks = 0;
function check(value, label) {
	if (!value)
		die('FAIL ' + label);
	checks++;
}

let settings = {};
const ctx = { get_all: () => settings };
function epoch(date, clock, isdst) {
	const d = split(date, '-'), t = split(clock, ':');
	return timelocal({ year: +d[0], mon: +d[1], mday: +d[2],
		hour: +t[0], min: +t[1], sec: +t[2], isdst: isdst ?? -1 });
}
function person(policy, windows) {
	return { mode: 'schedule', schedule_policy: policy, schedule_windows: sprintf('%J', windows) };
}
function online(p, date, clock) {
	return personAccess(ctx, p, epoch(date, clock)).online;
}
function invalid(windows, label) {
	let rejected = false;
	try { validateWindows(windows); }
	catch (_) { rejected = true; }
	check(rejected, label);
}

check(localInstant('2026-10-23T19:30:01') == epoch('2026-10-23', '19:30:01'),
	'local inspection datetime keeps seconds and router timezone');
const weekly = { repeat: 'weekly', days: [1, 2, 3, 4, 5], start: '19:30:00', end: '20:15:30' };
const allowed = person('allow', [weekly]);
check(!online(allowed, '2026-10-20', '19:29:59'), 'before start');
check(online(allowed, '2026-10-20', '19:30:00'), 'inclusive start');
check(online(allowed, '2026-10-20', '20:15:29'), 'last allowed second');
check(!online(allowed, '2026-10-20', '20:15:30'), 'exclusive end');
check(!online(allowed, '2026-10-24', '19:45:00'), 'weekday repeat');
check(nextTransition(ctx, allowed, epoch('2026-10-20', '19:29:59')) ==
	epoch('2026-10-20', '19:30:00'), 'next start at second precision');
check(nextTransition(ctx, allowed, epoch('2026-10-20', '19:30:00')) ==
	epoch('2026-10-20', '20:15:30'), 'next end at second precision');
const denied = person('block', [weekly]);
check(online(denied, '2026-10-20', '19:29:59'), 'block policy outside window');
check(!online(denied, '2026-10-20', '19:30:00'), 'block policy inside window');
check(online(denied, '2026-10-20', '20:15:30'), 'block policy end');

const night = person('allow', [{ repeat: 'weekly', days: [5], start: '22:00:01', end: '02:00:03' }]);
check(online(night, '2026-10-23', '22:00:01'), 'Friday overnight start');
check(online(night, '2026-10-24', '01:59:59'), 'Saturday belongs to Friday');
check(!online(night, '2026-10-24', '02:00:03'), 'overnight exclusive end');
check(!online(night, '2026-10-23', '01:59:59'), 'Friday morning not Friday night');
check(nextTransition(ctx, night, epoch('2026-10-23', '22:01:00')) ==
	epoch('2026-10-24', '02:00:03'), 'overnight next end');

const once = person('allow', [{ repeat: 'once', date: '2027-01-01', start: '23:59:58', end: '00:00:02' }]);
check(online(once, '2027-01-02', '00:00:01'), 'once overnight');
check(!online(once, '2027-01-09', '00:00:01'), 'once does not repeat');
check(nextTransition(ctx, once, epoch('2026-10-20', '12:00:00')) ==
	epoch('2027-01-01', '23:59:58'), 'distant one-time start');
check(nextTransition(ctx, once, epoch('2027-01-02', '00:00:02')) == 0, 'expired once has no transition');

const rangeWindow = { repeat: 'range', start_date: '2026-10-23', end_date: '2026-10-25',
	start: '19:30:00', end: '20:15:30' };
const range = person('allow', [rangeWindow]);
check(!online(range, '2026-10-23', '19:29:59'), 'date range before inclusive start');
check(online(range, '2026-10-23', '19:30:00'), 'date range inclusive start');
check(online(range, '2026-10-24', '03:00:00'), 'date range stays continuous between dates');
check(online(range, '2026-10-25', '20:15:29'), 'date range last second');
check(!online(range, '2026-10-25', '20:15:30'), 'date range exclusive end');
check(nextTransition(ctx, range, epoch('2026-01-01', '00:00:00')) ==
	epoch('2026-10-23', '19:30:00'), 'distant date range start');
check(nextTransition(ctx, range, epoch('2026-10-24', '12:00:00')) ==
	epoch('2026-10-25', '20:15:30'), 'continuous date range next end');
check(nextTransition(ctx, range, epoch('2026-10-25', '20:15:30')) == 0, 'expired range');
const dates = person('block', [{repeat: 'range', start_date: '2026-12-31',
	end_date: '2027-01-02', all_day: true}]);
check(online(dates, '2026-12-30', '23:59:59'), 'date-only before first day');
check(!online(dates, '2026-12-31', '00:00:00'), 'date-only includes first day');
check(!online(dates, '2027-01-02', '23:59:59'), 'date-only includes entire last day');
check(online(dates, '2027-01-03', '00:00:00'), 'date-only stops after last day');
check(nextTransition(ctx, dates, epoch('2027-01-01', '00:00:00')) ==
	epoch('2027-01-03', '00:00:00'), 'date-only cross-year next end');
check(online(person('allow', [{repeat: 'range', start_date: '2028-02-29',
	end_date: '2028-02-29', all_day: true}]), '2028-02-29', '12:00:00'), 'single leap day');
const rangeOverlap = person('allow', [weekly, {...rangeWindow,
	start_date: '2026-10-21', end_date: '2026-10-23', start: '12:00:00', end: '19:45:00'}]);
check(nextTransition(ctx, rangeOverlap, epoch('2026-10-21', '12:00:00')) ==
	epoch('2026-10-23', '20:15:30'), 'range ending inside recurring window uses union');
invalid([{...rangeWindow, end_date: '2026-10-22'}], 'reversed date range');
invalid([{...rangeWindow, start_date: '2026-02-30'}], 'invalid range date');
invalid([{...rangeWindow, end_date: rangeWindow.start_date, end: rangeWindow.start}],
	'zero datetime range');

const overlap = person('allow', [weekly,
	{ repeat: 'daily', start: '20:00:00', end: '21:00:07' }]);
check(nextTransition(ctx, overlap, epoch('2026-10-20', '19:45:00')) ==
	epoch('2026-10-20', '21:00:07'), 'overlap uses union');
const allDay = person('block', [{ repeat: 'weekends', all_day: true }]);
check(online(allDay, '2026-10-23', '23:59:59'), 'all day before weekend');
check(!online(allDay, '2026-10-24', '00:00:00'), 'all day starts midnight');
check(online(allDay, '2026-10-26', '00:00:00'), 'all day stops Monday');
check(!online(person('allow', []), '2026-10-20', '12:00:00'), 'empty allow blocks');
check(online(person('block', []), '2026-10-20', '12:00:00'), 'empty block allows');
check(online(person('allow', [{repeat: 'weekdays', all_day: true}]), '2026-10-20', '12:00:00'),
	'weekday preset');

settings = { day_off: ['2026-10-20'], school_day: ['2026-10-24'] };
const school = person('allow', [{ repeat: 'school', all_day: true }]);
check(!online(school, '2026-10-20', '12:00:00'), 'school calendar day off');
check(online(school, '2026-10-24', '12:00:00'), 'school calendar exceptional Saturday');
check(online(allowed, '2026-10-20', '19:45:00'), 'ordinary weekdays ignore calendar');
check(online(person('allow', [{repeat: 'dayoff', all_day: true}]), '2026-10-20', '12:00:00'),
	'dayoff calendar repeat');
settings = {};
const legacy = { mode: 'schedule', school_schedule: '111111111111111111111111111111111111111111111111',
	dayoff_schedule: '111111111111111111111111111111111111111111111111',
	school_night_cutoff: '1320', dayoff_night_cutoff: '1320' };
check(online(legacy, '2026-10-20', '21:59:59'), 'legacy read preserved');
check(!online(legacy, '2026-10-20', '22:00:00'), 'legacy cutoff preserved');

const extra = { ...allowed, extra_until: epoch('2026-10-20', '20:30:11') };
check(online(extra, '2026-10-20', '20:30:10'), 'extra override');
check(!online(extra, '2026-10-20', '20:30:11'), 'extra expires at exact second');
check(nextTransition(ctx, extra, epoch('2026-10-20', '19:45:00')) ==
	epoch('2026-10-20', '20:30:11'), 'extra masks scheduled cutoff');
check(!online({...allowed, mode: 'paused'}, '2026-10-20', '19:45:00'), 'manual pause');
check(online({...allowed, mode: 'online'}, '2026-10-20', '22:00:00'), 'manual online');
check(nextTransition(ctx, allowed, epoch('2026-10-20', '20:15:30')) ==
	epoch('2026-10-21', '19:30:00'), 'reevaluate after forward clock correction');
check(nextTransition(ctx, allowed, epoch('2026-10-20', '19:00:00')) ==
	epoch('2026-10-20', '19:30:00'), 'reevaluate after backward clock correction');
check(!online({...allowed, schedule_windows: 'corrupt'}, '2026-10-20', '19:45:00'),
	'invalid stored schedule fails closed');

let reason = personAccess(ctx, allowed, epoch('2026-10-20', '19:45:00')).reason;
check(reason?.code == 'schedule' && reason.matched_rules[0].index == 1, 'explanation identifies matched rule');
check(length(personAccess(ctx, allowed, epoch('2026-10-20', '22:00:00')).reason.matched_rules) == 0,
	'explanation identifies no matching window');
check(personAccess(ctx, {...allowed, mode: 'paused'}, epoch('2026-10-20', '19:45:00')).reason.code == 'manual_block',
	'explanation respects manual pause');
check(personAccess(ctx, {...extra, mode: 'paused'}, epoch('2026-10-20', '19:45:00')).reason.code == 'extra',
	'explanation respects extra-time override');
check(personAccess(ctx, {...allowed, mode: 'online'}, epoch('2026-10-20', '22:00:00')).reason.code == 'manual_allow',
	'explanation respects manual allow');
check(personAccess(ctx, {...allowed, schedule_windows: 'corrupt'}, epoch('2026-10-20', '19:45:00')).reason.code == 'invalid_schedule',
	'explanation identifies invalid schedule');
reason = personAccess(ctx, night, epoch('2026-10-24', '01:00:00')).reason;
check(reason.matched_rules[0].date == '2026-10-23', 'overnight explanation uses start date');
settings = { school_day: ['2026-10-24'] };
reason = personAccess(ctx, school, epoch('2026-10-24', '12:00:00')).reason;
check(reason.calendar.source == 'school_day' && reason.calendar.kind == 'school',
	'explanation identifies calendar override');
settings = {day_off: ['2026-10-23']};
const schoolNight = person('allow', [{repeat: 'school', start: '22:00:00', end: '02:00:00'}]);
reason = personAccess(ctx, schoolNight, epoch('2026-10-24', '01:00:00')).reason;
check(!reason.online && length(reason.matched_rules) == 0, 'school-night match respects starting-date day-off override');
settings = {school_day: ['2026-10-23']};
reason = personAccess(ctx, schoolNight, epoch('2026-10-24', '01:00:00')).reason;
check(reason.online && reason.matched_rules[0].calendar.source == 'school_day' &&
	reason.calendar.source == 'weekend', 'overnight explanation distinguishes starting and current calendar dates');
settings = {};
reason = personAccess(ctx, legacy, epoch('2026-10-20', '22:00:00')).reason;
check(reason.legacy && reason.cutoff == 1320 && !reason.online, 'legacy explanation includes cutoff');

invalid([{...weekly, start: '19:30'}], 'strict HH:mm:ss');
invalid([{...weekly, end: '24:00:00'}], '24:00 must use explicit all day');
invalid([{...weekly, end: weekly.start}], 'equal times rejected');
invalid([{...weekly, days: []}], 'empty weekdays rejected');
invalid([{...weekly, days: [0]}], 'invalid weekday');
invalid([{repeat: 'once', date: '2026-02-30', start: '01:00:00', end: '02:00:00'}], 'invalid calendar date');
invalid([{...weekly, all_day: 'true'}], 'boolean validation');
invalid([{...weekly, repeat: 'hourly'}], 'unsupported repeat');
invalid({}, 'array validation');
let tooMany = [];
for (let i = 0; i < 65; i++)
	push(tooMany, weekly);
invalid(tooMany, 'window count bound');

if (getenv('TZ') == 'CET-1CEST,M3.5.0,M10.5.0/3') {
	let rejected = false;
	try { localInstant('2026-03-29T02:30:00'); }
	catch (_) { rejected = true; }
	check(rejected, 'inspection rejects nonexistent DST local time');
	check(localInstant('2026-10-25T02:10:01') == epoch('2026-10-25', '02:10:01', 1),
		'ambiguous inspection uses first occurrence');
	invalid([{...rangeWindow, start_date: '2026-03-29', end_date: '2026-03-29',
		start: '02:30:00', end: '03:15:00'}], 'nonexistent range local time rejected');
	const spring = person('allow', [{repeat: 'daily', start: '02:30:00', end: '03:15:00'}]);
	check(nextTransition(ctx, spring, epoch('2026-03-29', '01:59:59')) ==
		epoch('2026-03-29', '03:00:00'), 'spring jump over nonexistent start');
	const autumn = person('allow', [{repeat: 'daily', start: '02:10:01', end: '02:20:03'}]);
	check(nextTransition(ctx, autumn, epoch('2026-10-25', '02:20:03', 1)) ==
		epoch('2026-10-25', '02:10:01', 0), 'fall repeated start');
	check(nextTransition(ctx, autumn, epoch('2026-10-25', '02:10:01', 0)) ==
		epoch('2026-10-25', '02:20:03', 0), 'fall repeated end');
}

print('PASS ', checks, ' schedule checks\n');
