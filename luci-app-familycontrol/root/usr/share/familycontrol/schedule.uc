// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

export const DEFAULT_SCHEDULE = '000000000000111111111111111111111111111111110000';
const DATE_PATTERN = /^(20[2-9][0-9]|2100)-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])$/;
const TIME_PATTERN = /^([01][0-9]|2[0-3]):([0-5][0-9]):([0-5][0-9])$/;

function dateKey(spec) {
	return sprintf('%04d-%02d-%02d', spec.year, spec.mon, spec.mday);
}

function at(spec, seconds, isdst) {
	return timelocal({ year: spec.year, mon: spec.mon, mday: spec.mday,
		hour: int(seconds / 3600), min: int(seconds / 60) % 60, sec: seconds % 60, isdst });
}

function day(spec, offset) {
	return localtime(timelocal({ year: spec.year, mon: spec.mon, mday: spec.mday + offset,
		hour: 12, min: 0, sec: 0, isdst: -1 }));
}

function dateSpec(value) {
	const parts = split(value, '-');
	return { year: +parts[0], mon: +parts[1], mday: +parts[2] };
}

export function validDate(value) {
	return type(value) == 'string' && !!match(value, DATE_PATTERN) &&
		dateKey(localtime(at(dateSpec(value), 43200, -1))) == value;
};

function seconds(value) {
	const parts = split(value, ':');
	return +parts[0] * 3600 + +parts[1] * 60 + +parts[2];
}

function instant(spec, value) {
	let found = null;
	for (let isdst in [-1, 0, 1]) {
		const epoch = at(spec, seconds(value), isdst), local = localtime(epoch);
		if (dateKey(local) == dateKey(spec) &&
		    local.hour * 3600 + local.min * 60 + local.sec == seconds(value) &&
		    (found == null || epoch < found))
			found = epoch;
	}
	if (found == null)
		die('Date and time do not exist in the router timezone');
	return found;
}

export function localInstant(value) {
	const parts = type(value) == 'string' ? split(value, 'T') : [];
	if (length(parts) != 2 || !validDate(parts[0]) || !match(parts[1], TIME_PATTERN))
		die('Use a valid router-local date and time: YYYY-MM-DDTHH:mm:ss');
	return instant(dateSpec(parts[0]), parts[1]);
};

function rangeBounds(window) {
	const startSpec = dateSpec(window.start_date), endSpec = dateSpec(window.end_date);
	if (window.all_day)
		return [at(startSpec, 0, -1), at(day(endSpec, 1), 0, -1)];
	return [instant(startSpec, window.start), instant(endSpec, window.end)];
}

export function validateWindows(windows) {
	if (type(windows) != 'array' || length(windows) > 64)
		die('Use a list of at most 64 time windows');
	return map(windows, window => {
		if (type(window) != 'object' ||
		    index(['daily', 'weekdays', 'weekends', 'weekly', 'once', 'school', 'dayoff', 'range'], window.repeat) < 0)
			die('Invalid time window repeat');
		if (window.all_day != null && type(window.all_day) != 'bool')
			die('All day must be a boolean');
		let result = { repeat: window.repeat, all_day: !!window.all_day };
		if (result.all_day) {
			result.start = '00:00:00';
			result.end = '00:00:00';
		}
		else {
			if (type(window.start) != 'string' || !match(window.start, TIME_PATTERN) ||
			    type(window.end) != 'string' || !match(window.end, TIME_PATTERN))
				die('Times must use HH:mm:ss from 00:00:00 to 23:59:59');
			if (window.start == window.end && window.repeat != 'range')
				die('Start and end must differ; use All day for a full day');
			result.start = window.start;
			result.end = window.end;
		}
		if (result.repeat == 'weekly') {
			if (type(window.days) != 'array' || !length(window.days) || length(window.days) > 7)
				die('Choose at least one weekday');
			let seen = {};
			for (let value in window.days) {
				if (type(value) != 'int' || value < 1 || value > 7 || seen[value])
					die('Weekdays must be unique integers from 1 to 7');
				seen[value] = true;
			}
			result.days = sort(window.days);
		}
		if (result.repeat == 'once') {
			if (!validDate(window.date))
				die('One-time windows need a valid YYYY-MM-DD date');
			result.date = window.date;
		}
		if (result.repeat == 'range') {
			if (!validDate(window.start_date) || !validDate(window.end_date) ||
			    window.end_date < window.start_date)
				die('Choose a valid start and end date in chronological order');
			result.start_date = window.start_date;
			result.end_date = window.end_date;
			const bounds = rangeBounds(result);
			if (bounds[1] <= bounds[0])
				die('The range must end after it starts');
		}
		return result;
	});
};

export function scheduleSettings(person) {
	if (person.schedule_windows == null)
		return { legacy: true, policy: 'allow', windows: [] };
	try {
		if (person.schedule_policy != 'allow' && person.schedule_policy != 'block')
			die('Schedule policy must be allow or block');
		return { legacy: false, policy: person.schedule_policy,
			windows: validateWindows(json(person.schedule_windows)) };
	}
	catch (error) {
		return { legacy: false, policy: 'allow', windows: [], error: error.message || '' + error };
	}
};

function contains(value, needle) {
	return type(value) == 'array' ? index(value, needle) >= 0 : value == needle;
}

function calendarDay(settings, spec) {
	const key = dateKey(spec);
	const source = contains(settings.school_day, key) ? 'school_day'
		: contains(settings.day_off, key) ? 'day_off'
		: contains(settings.holiday, key) ? 'holiday'
		: spec.wday == 6 || spec.wday == 7 ? 'weekend' : 'weekday';
	return { date: key, source, kind: source == 'school_day' || source == 'weekday' ? 'school' : 'dayoff' };
}

function dayOff(settings, spec) {
	return calendarDay(settings, spec).kind == 'dayoff';
}

function repeats(settings, window, spec) {
	switch (window.repeat) {
	case 'daily': return true;
	case 'weekdays': return spec.wday <= 5;
	case 'weekends': return spec.wday >= 6;
	case 'weekly': return index(window.days, spec.wday) >= 0;
	case 'once': return window.date == dateKey(spec);
	case 'school': return !dayOff(settings, spec);
	case 'dayoff': return dayOff(settings, spec);
	}
	return false;
}

function matchedDay(settings, window, spec, epoch) {
	if (window.repeat == 'range') {
		const bounds = rangeBounds(window);
		return epoch >= bounds[0] && epoch < bounds[1] ? dateSpec(window.start_date) : null;
	}
	if (window.all_day)
		return repeats(settings, window, spec) ? spec : null;
	const current = spec.hour * 3600 + spec.min * 60 + spec.sec;
	const start = seconds(window.start), end = seconds(window.end);
	if (end > start)
		return current >= start && current < end && repeats(settings, window, spec) ? spec : null;
	if (current >= start && repeats(settings, window, spec))
		return spec;
	const previous = day(spec, -1);
	return current < end && repeats(settings, window, previous) ? previous : null;
}

function scheduled(settings, person, schedule, epoch) {
	if (schedule.error)
		return { code: 'invalid_schedule', online: false, error: schedule.error };
	const spec = localtime(epoch);
	const current = spec.hour * 3600 + spec.min * 60 + spec.sec;
	const calendar = calendarDay(settings, spec);
	if (schedule.legacy) {
		const bits = (dayOff(settings, spec) ? person.dayoff_schedule : person.school_schedule) || DEFAULT_SCHEDULE;
		const cutoff = +(dayOff(settings, day(spec, 1))
			? (person.dayoff_night_cutoff || 1320) : (person.school_night_cutoff || 1320));
		const slotAllowed = substr(bits, int(current / 1800), 1) == '1';
		return { code: 'schedule', legacy: true, calendar, cutoff, slot_allowed: slotAllowed,
			online: slotAllowed && current < cutoff * 60 };
	}
	let matched = [];
	for (let i = 0; i < length(schedule.windows); i++) {
		const window = schedule.windows[i], startDay = matchedDay(settings, window, spec, epoch);
		if (startDay)
			push(matched, { index: i + 1, repeat: window.repeat, date: dateKey(startDay),
				calendar: window.repeat == 'school' || window.repeat == 'dayoff'
					? calendarDay(settings, startDay) : null });
	}
	return { code: 'schedule', legacy: false, policy: schedule.policy, calendar, matched_rules: matched,
		uses_calendar: length(filter(schedule.windows, window => window.repeat == 'school' || window.repeat == 'dayoff')) > 0,
		online: schedule.policy == 'allow' ? length(matched) > 0 : length(matched) == 0 };
}

function access(settings, person, schedule, epoch) {
	const mode = index(['online', 'paused', 'schedule'], person.mode) >= 0
		? person.mode : person.paused == '1' ? 'paused' : 'online';
	const extraUntil = +(person.extra_until || 0);
	const reason = extraUntil > epoch ? { code: 'extra', online: true }
		: mode == 'schedule' ? scheduled(settings, person, schedule, epoch)
		: { code: mode == 'online' ? 'manual_allow' : 'manual_block', online: mode == 'online' };
	return { mode, online: reason.online, reason,
		extra_until: extraUntil > epoch ? extraUntil : 0 };
}

export function personAccess(ctx, person, epoch) {
	return access(ctx.get_all('familycontrol', 'main') || {}, person, scheduleSettings(person), epoch);
};

export function nextTransition(ctx, person, epoch) {
	const settings = ctx.get_all('familycontrol', 'main') || {};
	const schedule = scheduleSettings(person);
	const current = access(settings, person, schedule, epoch);
	const extraUntil = +(person.extra_until || 0);
	if (current.mode != 'schedule')
		return current.mode == 'paused' && extraUntil > epoch ? extraUntil : 0;
	let candidates = {}, dates = {};
	function add(value) {
		if (value > epoch)
			candidates[value] = value;
	}
	function addDays(spec) {
		// A full week plus adjacent days covers weekly and overnight boundaries.
		for (let i = -1; i <= 8; i++) {
			const value = day(spec, i);
			dates[dateKey(value)] = value;
		}
	}
	function boundary(spec, value) {
		// Include both occurrences of a repeated local time at a DST fallback.
		for (let isdst in [-1, 0, 1])
			add(at(spec, value, isdst));
	}
	addDays(localtime(epoch));
	if (extraUntil > epoch) {
		add(extraUntil);
		addDays(localtime(extraUntil));
	}
	for (let window in schedule.windows) {
		if (window.repeat == 'once')
			addDays(dateSpec(window.date));
		if (window.repeat == 'range')
			for (let value in rangeBounds(window)) {
				add(value);
				addDays(localtime(value));
			}
	}
	for (let kind in ['school_day', 'day_off', 'holiday']) {
		const values = settings[kind];
		for (let value in (type(values) == 'array' ? values : values ? [values] : []))
			if (validDate(value))
				addDays(dateSpec(value));
	}
	for (let _, spec in dates) {
		boundary(spec, 0);
		boundary(spec, 86400);
		if (schedule.legacy) {
			for (let value = 1800; value < 86400; value += 1800)
				boundary(spec, value);
		}
		else {
			for (let window in schedule.windows) {
				if (!repeats(settings, window, spec))
					continue;
				const start = seconds(window.start), end = seconds(window.end);
				boundary(spec, start);
				boundary(end <= start ? day(spec, 1) : spec, end);
			}
			// A spring-forward jump can cross a nonexistent start or end time.
			if (localtime(at(spec, 0, -1)).isdst != localtime(at(spec, 86400, -1)).isdst)
				for (let value = 0; value < 86400; value += 1800)
					boundary(spec, value);
		}
	}
	for (let value in sort(values(candidates), (a, b) => a - b))
		if (access(settings, person, schedule, value).online != current.online)
			return value;
	return 0;
};
