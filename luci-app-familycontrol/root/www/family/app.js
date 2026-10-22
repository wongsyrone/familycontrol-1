// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

const ZERO_SESSION = '00000000000000000000000000000000';
const MAC_PATTERN = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/;
let session = sessionStorage.getItem('familycontrol-session');
let requestId = 0;
let config = {};
let candidates = [];
let calendar = { day_off: [], school_day: [] };
let savedCalendar = calendar;
let routerDate = '';
let calendarSelection = new Set();
let calendarCursor = '';
let extraPreviewRequest = 0;
let extraPreviewTimer;
let schedulePreviewRequest = 0;
const REPEAT_LABELS = {
	daily: 'Every day', weekdays: 'Monday to Friday', weekends: 'Saturday and Sunday',
	weekly: 'Selected weekdays', once: 'Once on a date', range: 'Date / date-time range',
	school: 'School days (calendar)', dayoff: 'Days off (calendar)'
};
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const $ = id => document.getElementById(id);

async function rpc(object, method, args = {}, token = session || ZERO_SESSION) {
	const response = await fetch('/ubus', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: ++requestId,
			method: 'call',
			params: [ token, object, method, args ]
		})
	});
	const body = await response.json();
	if (body.error)
		throw new Error(body.error.message || 'Request failed');
	if (!body.result || body.result[0] !== 0)
		throw new Error(body.result?.[1]?.message || 'Access denied');
	const result = body.result[1] || {};
	if (result.ok === false)
		throw new Error(result.message || 'Unable to apply changes');
	return result;
}

function setError(node, message) {
	node.textContent = message;
	node.classList.toggle('hidden', !message);
}

function showError(message, login = false) {
	const node = login ? $('login-error')
		: document.querySelector('dialog[open] .form-error') || $('error');
	setError(node, message);
	if (message && node.classList.contains('form-error'))
		node.focus();
}

function openDialog(id) {
	const dialog = $(id);
	setError(dialog.querySelector('.form-error'), '');
	dialog.showModal();
	if (id !== 'confirm-dialog') {
		const heading = dialog.querySelector('h2');
		heading.tabIndex = -1;
		heading.focus({preventScroll: true});
	}
	dialog.scrollTop = 0;
}

async function runAction(container, action) {
	if (container.getAttribute('aria-busy') === 'true') return;
	const buttons = Array.from(container.querySelectorAll('button'));
	const disabled = buttons.map(button => button.disabled);
	container.setAttribute('aria-busy', 'true');
	for (const button of buttons) button.disabled = true;
	showError('');
	try { await action(); }
	catch (error) { showError(error.message); }
	finally {
		container.removeAttribute('aria-busy');
		buttons.forEach((button, index) => { button.disabled = disabled[index]; });
	}
}

function showLogin() {
	$('app').classList.add('hidden');
	$('login').classList.remove('hidden');
}

function escapeHtml(value) {
	return String(value).replace(/[&<>"']/g, c => ({
		'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
	})[c]);
}

function clock(epoch) {
	return new Date(epoch * 1000).toLocaleTimeString([], {
		hour: '2-digit', minute: '2-digit', second: '2-digit'
	});
}

function stateText(person) {
	if (person.mode === 'schedule' || person.extra_until)
		return `${person.paused ? 'Offline' : 'Online'}${person.next_transition ? ` until ${person.next_transition_local || clock(person.next_transition)}` : ''}`;
	return person.paused ? 'Paused' : 'Online';
}

function modeLabel(person) {
	return { online: 'Allow always', paused: 'Block always', schedule: 'By schedule' }[person.mode] || 'Unknown mode';
}

function calendarReason(day) {
	if (!day) return '';
	const source = {school_day: 'school-day override', day_off: 'day-off override',
		holiday: 'holiday', weekend: 'weekend', weekday: 'weekday'}[day.source] || day.source;
	return `${day.date}: ${day.kind === 'school' ? 'school day' : 'day off'} (${source})`;
}

function reasonText(reason) {
	if (!reason) return '';
	switch (reason.code) {
	case 'disabled': return 'Family Control is disabled in configuration.';
	case 'extra': return 'Allowed by temporary extra time.';
	case 'manual_allow': return 'Allowed by the manual Allow always mode.';
	case 'manual_block': return 'Blocked by the manual Block always mode.';
	case 'invalid_schedule': return `Blocked because the automatic schedule is invalid: ${reason.error}`;
	case 'schedule': {
		if (reason.legacy) {
			const cutoff = `${String(Math.floor(reason.cutoff / 60)).padStart(2, '0')}:${String(reason.cutoff % 60).padStart(2, '0')}`;
			return `${reason.online ? 'Allowed' : 'Blocked'} by the existing half-hour schedule. ${calendarReason(reason.calendar)}. Selected slot: ${reason.slot_allowed ? 'allow' : 'block'}; night cutoff: ${cutoff}.`;
		}
		const matches = (reason.matched_rules || []).map(rule =>
			`#${rule.index} (${rule.calendar ? calendarReason(rule.calendar) : rule.date})`);
		const decision = `${reason.online ? 'Allowed' : 'Blocked'} ${matches.length ? 'inside' : 'outside'} the ${reason.policy} windows.`;
		return decision + (matches.length ? ` Matching rules: ${matches.join(', ')}.` : ' No rule matches.') +
			(reason.uses_calendar ? ` Calendar: ${calendarReason(reason.calendar)}.` : '');
	}
	default: return '';
	}
}

function scheduleSummary(person) {
	if (person.schedule_format !== 'windows')
		return 'School-day schedule (30-minute slots)';
	const windows = person.windows || [];
	if (!windows.length)
		return person.schedule_policy === 'block' ? 'Schedule allows internet all the time' : 'Schedule blocks internet all the time';
	const summaries = windows.slice(0, 2).map(window => {
		if (window.repeat === 'range')
			return window.all_day ? `${window.start_date}–${window.end_date} (all days included)`
				: `${window.start_date} ${window.start}–${window.end_date} ${window.end}`;
		const repeat = window.repeat === 'weekly'
			? (window.days || []).map(day => WEEKDAYS[day - 1]).join(', ')
			: window.repeat === 'once' ? window.date : REPEAT_LABELS[window.repeat];
		return `${repeat}: ${window.all_day ? 'all day' : `${window.start}–${window.end}${window.end < window.start ? ' (next day)' : ''}`}`;
	});
	return `${person.schedule_policy === 'block' ? 'Block during' : 'Allow only during'} ${summaries.join('; ')}${windows.length > 2 ? `; +${windows.length - 2} more` : ''}`;
}

async function load() {
	const [status, discovered] = await Promise.all([
		rpc('familycontrol', 'status'),
		rpc('familycontrol', 'devices')
	]);
	candidates = discovered.devices || [];
	savedCalendar = status.calendar || { day_off: [], school_day: [] };
	calendar = savedCalendar;
	routerDate = status.router_now_local?.slice(0, 10) || new Date().toISOString().slice(0, 10);
	$('router-clock').textContent = status.router_now_local
		? `Router time: ${status.router_now_local} (${status.router_timezone || 'local'})` : '';
	config = {};
	for (const person of status.people || []) {
		config[person.id] = {
			'.name': person.id,
			'.type': 'person',
			name: person.name,
			paused: person.paused ? '1' : '0',
			mode: person.mode,
			extra_until: person.extra_until,
			extra_until_local: person.extra_until_local,
			schedule_format: person.schedule_format,
			schedule_policy: person.schedule_policy,
			windows: person.windows || [],
			school_schedule: person.school_schedule,
			dayoff_schedule: person.dayoff_schedule,
			school_night_cutoff: person.school_night_cutoff,
			dayoff_night_cutoff: person.dayoff_night_cutoff
		};
		for (const device of person.devices || [])
			config[device.id] = {
				'.name': device.id,
				'.type': 'device',
				name: device.name,
				mac: device.mac,
				person: person.id,
				connected: device.connected
			};
	}
	render(status.people || [], status.enforcement?.ok);
	setError($('error'), !status.enforcement?.ok
		? status.enforcement?.message || 'Device restrictions are not applied'
		: status.enabled === false ? 'Family Control is disabled' : '');
}

function render(people, applied) {
	const devices = Object.values(config).filter(s => s['.type'] === 'device');
	$('people').innerHTML = people.length ? people.map(person => {
		const owned = devices.filter(device => device.person === person.id);
		return `<article class="card">
			<div class="row">
				<div>
					<h2>${escapeHtml(person.name)}</h2>
					<span class="mode-label">Mode: ${escapeHtml(modeLabel(person))}</span>
					<p class="meta"><span class="${applied ? person.paused ? 'paused' : 'online' : ''}">${escapeHtml(applied ? stateText(person) : 'Not applied')}</span>
					· ${owned.length} ${owned.length === 1 ? 'device' : 'devices'}</p>
				</div>
				<div class="actions">
					<button class="secondary" data-action="mode" data-mode="online" aria-pressed="${person.mode === 'online' && !person.extra_until}" data-id="${person.id}">Allow always</button>
					<button class="secondary" data-action="mode" data-mode="paused" aria-pressed="${person.mode === 'paused' && !person.extra_until}" data-id="${person.id}">Block always</button>
					<button class="secondary" data-action="mode" data-mode="schedule" aria-pressed="${person.mode === 'schedule' && !person.extra_until}" data-id="${person.id}">Use schedule</button>
					${person.mode !== 'online' ? `<details><summary>Extra time</summary>
						<button type="button" data-action="extra" data-minutes="15" data-id="${person.id}">Add 15 minutes</button>
						<button type="button" data-action="extra" data-minutes="30" data-id="${person.id}">Add 30 minutes</button>
						<button type="button" data-action="extra" data-minutes="60" data-id="${person.id}">Add 1 hour</button>
						<button type="button" data-action="custom-extra" data-id="${person.id}">Custom duration</button>
					</details>` : ''}
				</div>
			</div>
			<p class="access-reason meta">${escapeHtml((!applied ? 'Configured decision: ' : '') + reasonText(person.reason))}</p>
			<p class="schedule-summary"><strong>${person.mode === 'schedule' && !person.extra_until && person.reason?.code !== 'disabled' ? 'Schedule' : 'Saved schedule (not active)'}:</strong> ${escapeHtml(scheduleSummary(person))}</p>
			${person.extra_until ? `<p class="meta">Extra time overrides this mode until ${escapeHtml(person.extra_until_local || clock(person.extra_until))} (router time).</p>` : ''}
			<button class="secondary" data-action="schedule" data-id="${person.id}">Edit schedule</button>
			${owned.map(device => `<div class="card">
				<strong>${escapeHtml(device.name || device.mac)}</strong>
				<div class="meta">${escapeHtml(device.mac)} ·
					<span class="connection ${device.connected ? 'connected' : 'disconnected'}">
						<span class="status-dot"></span>${device.connected == null ? 'Detection unavailable' : device.connected ? 'Recently detected' : 'Not recently detected'}
					</span>
				</div>
				<div class="actions">
					<button class="secondary" data-action="edit-device" data-id="${device['.name']}">Edit</button>
					<button class="danger" data-action="delete-device" data-id="${device['.name']}">Remove</button>
				</div>
			</div>`).join('')}
			<div class="actions">
				<button class="secondary" data-action="add-device" data-id="${person.id}">Add device</button>
				<button class="secondary" data-action="edit-person" data-id="${person.id}">Rename</button>
				<button class="danger" data-action="delete-person" data-id="${person.id}">Delete</button>
			</div>
		</article>`;
	}).join('') : '<div class="card empty">No people yet. Add someone to get started.</div>';
}

async function mutateAndReload(method, args) {
	const result = await rpc('familycontrol', method, args);
	try { await load(); }
	catch (_) { setError($('error'), 'Change saved, but status could not be refreshed. Reload this page.'); }
	return result;
}

$('login-form').addEventListener('submit', async event => {
	event.preventDefault();
	showError('', true);
	try {
		const result = await rpc('session', 'login', {
			username: $('username').value,
			password: $('password').value
		}, ZERO_SESSION);
		session = result.ubus_rpc_session;
		sessionStorage.setItem('familycontrol-session', session);
		$('login').classList.add('hidden');
		$('app').classList.remove('hidden');
		await load();
	}
	catch (error) {
		showError(error.message, true);
	}
});

$('logout').addEventListener('click', async () => {
	try { await rpc('session', 'destroy', {}); } catch (_) {}
	sessionStorage.removeItem('familycontrol-session');
	session = null;
	showLogin();
});

$('add-person').addEventListener('click', () => {
	$('person-title').textContent = 'Add person';
	$('person-id').value = '';
	$('person-name').value = '';
	openDialog('person-dialog');
});

function renderExceptions() {
	const labels = { day_off: 'Day off', school_day: 'School day' };
	const rows = [ 'day_off', 'school_day' ].flatMap(kind =>
		(calendar[kind] || []).map(date => ({ kind, date })))
		.sort((a, b) => a.date.localeCompare(b.date));
	$('calendar-exceptions').innerHTML = rows.length ? rows.map(row =>
		`<div class="row card"><span><strong>${escapeHtml(row.date)}</strong><br><span class="meta">${labels[row.kind]}</span></span>
		<button type="button" class="danger" data-remove-date="${escapeHtml(row.date)}" data-kind="${row.kind}">Remove</button></div>`
	).join('') : '<p class="meta">No school-specific exceptions.</p>';
	const changed = new Set([...savedCalendar.day_off || [], ...savedCalendar.school_day || [],
		...calendar.day_off, ...calendar.school_day].filter(date =>
		(calendar.day_off.includes(date) ? 'day_off' : calendar.school_day.includes(date) ? 'school_day' : '') !==
		((savedCalendar.day_off || []).includes(date) ? 'day_off' : (savedCalendar.school_day || []).includes(date) ? 'school_day' : '')));
	$('calendar-dirty').textContent = changed.size ? `${changed.size} date change${changed.size === 1 ? '' : 's'} not saved yet.` : 'No unsaved date changes.';
	renderCalendarMonth();
}

function civilDate(value) {
	if (!/^(20[2-9][0-9]|2100)-[0-9]{2}-[0-9]{2}$/.test(value || '')) return null;
	const date = new Date(value + 'T00:00:00Z');
	return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}

function shiftedDate(value, offset) {
	const date = civilDate(value);
	date.setUTCDate(date.getUTCDate() + offset);
	return date.toISOString().slice(0, 10);
}

function renderCalendarMonth() {
	const first = civilDate($('calendar-month').value + '-01');
	if (!first) return;
	const year = first.getUTCFullYear(), month = first.getUTCMonth();
	$('calendar-month-label').textContent = first.toLocaleDateString('en', {year: 'numeric', month: 'long', timeZone: 'UTC'});
	const count = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
	const offset = (first.getUTCDay() + 6) % 7;
	let cells = [];
	for (let index = 0; index < Math.ceil((count + offset) / 7) * 7; index++) {
		const number = index - offset + 1;
		if (number < 1 || number > count) { cells.push('<td></td>'); continue; }
		const key = `${$('calendar-month').value}-${String(number).padStart(2, '0')}`;
		const day = new Date(key + 'T00:00:00Z').getUTCDay();
		const override = calendar.school_day.includes(key) ? 'school_day' : calendar.day_off.includes(key) ? 'day_off' : '';
		const off = override ? override === 'day_off' : day === 0 || day === 6 || (calendar.holiday || []).includes(key);
		const label = `${key}, ${off ? 'day off' : 'school day'} (${override ? 'override' : 'default'})`;
		cells.push(`<td><button type="button" data-calendar-date="${key}" class="${off ? 'day-off' : ''} ${override ? 'override' : ''}"
			tabindex="${key === calendarCursor ? '0' : '-1'}" aria-label="${label}" aria-pressed="${calendarSelection.has(key)}">${number}</button></td>`);
	}
	$('calendar-grid').innerHTML = Array.from({length: cells.length / 7}, (_, row) =>
		`<tr>${cells.slice(row * 7, row * 7 + 7).join('')}</tr>`).join('');
	$('calendar-selection').textContent = `${calendarSelection.size} dates selected. Changes apply only after Save calendar.`;
	$('calendar-prev').disabled = $('calendar-month').value === '2020-01';
	$('calendar-next').disabled = $('calendar-month').value === '2100-12';
}

function applyCalendarDates(dates) {
	if (!dates.length) return showError('Select at least one date.');
	const kind = $('exception-kind').value;
	const next = {
		...calendar,
		day_off: calendar.day_off.filter(date => !dates.includes(date)),
		school_day: calendar.school_day.filter(date => !dates.includes(date))
	};
	if (kind !== 'default') next[kind] = [...new Set([...next[kind], ...dates])].sort();
	if (next.day_off.length > 100 || next.school_day.length > 100)
		return showError('Each label supports at most 100 date overrides. No changes were applied.');
	calendar = next;
	calendarSelection.clear();
	showError('');
	renderExceptions();
}

function openCalendar() {
	calendar = {
		...savedCalendar,
		day_off: [ ...(savedCalendar.day_off || []) ],
		school_day: [ ...(savedCalendar.school_day || []) ]
	};
	calendarSelection = new Set();
	calendarCursor = routerDate;
	$('calendar-month').value = routerDate.slice(0, 7);
	$('exception-date').value = routerDate;
	$('exception-end').value = routerDate;
	const users = Object.values(config).filter(person => person['.type'] === 'person' &&
		(person.schedule_format === 'legacy' || person.windows.some(window => ['school', 'dayoff'].includes(window.repeat))));
	$('calendar-usage').textContent = users.length
		? `Used by: ${users.map(person => `${person.name}${person.mode === 'schedule' ? '' : ' (saved, inactive)'}`).join(', ')}. Saving these shared labels affects all linked schedules.`
		: 'No saved schedule currently uses these labels. Choose School days or Days off in a schedule to use them.';
	renderExceptions();
	openDialog('calendar-dialog');
}

$('open-calendar').addEventListener('click', openCalendar);

$('add-exception').addEventListener('click', () => {
	const start = $('exception-date').value, end = $('exception-end').value || start;
	if (!civilDate(start) || !civilDate(end) || end < start)
		return showError('Choose valid first and last dates in chronological order.');
	const count = (civilDate(end) - civilDate(start)) / 86400000 + 1;
	if (count > 366) return showError('Apply at most 366 dates at a time.');
	applyCalendarDates(Array.from({length: count}, (_, day) => shiftedDate(start, day)));
});

$('apply-selected').addEventListener('click', () => applyCalendarDates([...calendarSelection]));
$('clear-selected').addEventListener('click', () => { calendarSelection.clear(); renderCalendarMonth(); });
$('calendar-month').addEventListener('change', () => {
	if (!civilDate($('calendar-month').value + '-01')) return showError('Choose a month from 2020 to 2100.');
	showError('');
	calendarCursor = $('calendar-month').value + '-01';
	renderCalendarMonth();
});
function moveCalendarMonth(offset, day = 1) {
	const date = civilDate($('calendar-month').value + '-01');
	if (!date) return showError('Choose a valid month.');
	date.setUTCMonth(date.getUTCMonth() + offset);
	date.setUTCDate(Math.min(day, new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()));
	const key = date.toISOString().slice(0, 10);
	if (!civilDate(key)) return;
	calendarCursor = key;
	$('calendar-month').value = key.slice(0, 7);
	renderCalendarMonth();
}
$('calendar-prev').addEventListener('click', () => moveCalendarMonth(-1));
$('calendar-next').addEventListener('click', () => moveCalendarMonth(1));
$('calendar-grid').addEventListener('click', event => {
	const button = event.target.closest('[data-calendar-date]');
	if (!button) return;
	calendarCursor = button.dataset.calendarDate;
	if (calendarSelection.has(calendarCursor)) calendarSelection.delete(calendarCursor);
	else calendarSelection.add(calendarCursor);
	renderCalendarMonth();
	$('calendar-grid').querySelector(`[data-calendar-date="${calendarCursor}"]`).focus({preventScroll: true});
});
$('calendar-grid').addEventListener('keydown', event => {
	const button = event.target.closest('[data-calendar-date]');
	if (!button) return;
	const offsets = {ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7};
	let next;
	if (event.key in offsets) next = shiftedDate(button.dataset.calendarDate, offsets[event.key]);
	else if (event.key === 'Home' || event.key === 'End') {
		const day = (civilDate(button.dataset.calendarDate).getUTCDay() + 6) % 7;
		next = shiftedDate(button.dataset.calendarDate, event.key === 'Home' ? -day : 6 - day);
	}
	else if (event.key === 'PageUp' || event.key === 'PageDown') {
		moveCalendarMonth((event.key === 'PageUp' ? -1 : 1) * (event.shiftKey ? 12 : 1),
			+button.dataset.calendarDate.slice(8));
		next = calendarCursor;
	}
	else return;
	if (!civilDate(next)) return;
	event.preventDefault();
	calendarCursor = next;
	$('calendar-month').value = next.slice(0, 7);
	renderCalendarMonth();
	$('calendar-grid').querySelector(`[data-calendar-date="${next}"]`).focus({preventScroll: true});
});
$('calendar-exceptions').addEventListener('click', event => {
	const button = event.target.closest('button[data-remove-date]');
	if (!button) return;
	calendar[button.dataset.kind] = calendar[button.dataset.kind]
		.filter(date => date !== button.dataset.removeDate);
	renderExceptions();
});

$('calendar-form').addEventListener('submit', async event => {
	event.preventDefault();
	await runAction($('calendar-form'), async () => {
		await mutateAndReload('save_calendar', {
			day_off: calendar.day_off,
			school_day: calendar.school_day
		});
		$('calendar-dialog').close();
	});
});

document.querySelectorAll('.cancel').forEach(button =>
	button.addEventListener('click', () => button.closest('dialog').close()));
document.querySelectorAll('dialog').forEach(dialog =>
	dialog.addEventListener('cancel', event => {
		if (dialog.querySelector('form[aria-busy="true"]')) event.preventDefault();
	}));

$('person-form').addEventListener('submit', async event => {
	event.preventDefault();
	const id = $('person-id').value;
	await runAction($('person-form'), async () => {
		await mutateAndReload('save_person', {
			person: id,
			name: $('person-name').value
		});
		$('person-dialog').close();
	});
});

$('device-form').addEventListener('submit', async event => {
	event.preventDefault();
	const choice = $('device-choice').value;
	const mac = (choice === 'manual' ? $('device-mac').value : choice).trim().toUpperCase();
	if (!MAC_PATTERN.test(mac)) {
		showError('Enter a valid MAC address.');
		return;
	}
	const id = $('device-id').value;
	await runAction($('device-form'), async () => {
		await mutateAndReload('save_device', {
			device: id,
			name: $('device-name').value,
			mac,
			person: $('device-person').value
		});
		$('device-dialog').close();
	});
});

function populateDeviceChoices(currentMac = '') {
	const select = $('device-choice');
	const normalizedCurrent = currentMac.toUpperCase();
	const available = candidates.filter(device =>
		!device.assigned_person || device.mac === normalizedCurrent);

	select.innerHTML = [
		'<option value="">Choose a known device…</option>',
		...available.map(device => {
			const label = [
				device.hostname || 'Unknown device',
				(device.addresses || [device.ip]).filter(Boolean).join(', '),
				device.mac,
				(device.sources || []).map(source => ({
					static: 'Static DHCP', lease: 'DHCP lease', saved: 'Saved device', neighbor: 'Neighbour'
				})[source]).filter(Boolean).join(' / ')
			].filter(Boolean).join(' · ');
			return `<option value="${escapeHtml(device.mac)}">${escapeHtml(label)}</option>`;
		}),
		'<option value="manual">Enter a MAC address manually…</option>'
	].join('');

	if (normalizedCurrent && !available.some(device => device.mac === normalizedCurrent)) {
		select.insertAdjacentHTML('beforeend',
			`<option value="${escapeHtml(normalizedCurrent)}">${escapeHtml(normalizedCurrent)} · saved device</option>`);
	}

	select.value = normalizedCurrent || '';
	$('manual-mac-fields').classList.add('hidden');
}

function populateDeviceOwners(personId) {
	$('device-person').innerHTML = Object.values(config)
		.filter(section => section['.type'] === 'person')
		.map(person => `<option value="${escapeHtml(person['.name'])}">${escapeHtml(person.name)}</option>`).join('');
	$('device-person').value = personId;
	$('device-owner-help').textContent = 'Moving this device applies the selected person’s controls immediately after saving.';
}

function renderSlots(id, value) {
	$(id).innerHTML = Array.from({ length: 48 }, (_, slot) => {
		const minutes = slot * 30;
		const label = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${minutes % 60 ? '30' : '00'}`;
		return `<button type="button" class="slot ${value[slot] === '1' ? 'selected' : ''}" data-slot="${slot}">${label}</button>`;
	}).join('');
}

function cutoffOptions() {
	return Array.from({ length: 49 }, (_, slot) => {
		const minutes = slot * 30;
		const label = minutes === 1440 ? '24:00' :
			`${String(Math.floor(minutes / 60)).padStart(2, '0')}:${minutes % 60 ? '30' : '00'}`;
		return `<option value="${minutes}">${label}</option>`;
	}).join('');
}

function openSchedule(id) {
	const person = config[id];
	$('schedule-person').value = id;
	$('schedule-title').textContent = `${person.name} schedule`;
	$('schedule-mode').textContent = `Current mode: ${modeLabel(person)}${person.extra_until ? ' (temporarily overridden by extra time)' : ''}`;
	renderSlots('school-slots', person.school_schedule);
	renderSlots('dayoff-slots', person.dayoff_schedule);
	$('school-cutoff').innerHTML = cutoffOptions();
	$('dayoff-cutoff').innerHTML = cutoffOptions();
	$('school-cutoff').value = person.school_night_cutoff;
	$('dayoff-cutoff').value = person.dayoff_night_cutoff;
	const legacy = person.schedule_format !== 'windows';
	$('schedule-format').innerHTML = (legacy ? '<option value="legacy">Existing school-day schedule</option>' : '') +
		'<option value="windows">Dates and times</option>';
	$('schedule-format').value = legacy ? 'legacy' : 'windows';
	$('schedule-policy').value = person.schedule_policy || 'allow';
	$('time-windows').replaceChildren();
	for (const window of legacy
		? [{ repeat: 'daily', start: '06:00:00', end: '22:00:00' }]
		: person.windows)
		addTimeWindow(window);
	updateScheduleFormat();
	$('schedule-preview-time').value = '';
	invalidateSchedulePreview(false);
	openDialog('schedule-dialog');
}

function updateScheduleFormat() {
	invalidateSchedulePreview();
	const legacy = $('schedule-format').value === 'legacy';
	$('legacy-schedule').classList.toggle('hidden', !legacy);
	$('window-schedule').classList.toggle('hidden', legacy);
	for (const input of $('window-schedule').querySelectorAll('input,select,button'))
		input.disabled = legacy;
	if (!legacy)
		for (const row of $('time-windows').children)
			updateTimeWindow(row);
	$('schedule-policy-help').textContent = $('schedule-policy').value === 'allow'
		? 'Outside these windows internet is blocked. No windows means blocked all the time.'
		: 'Outside these windows internet is allowed. No windows means allowed all the time.';
}

function updateTimeWindow(row) {
	const repeat = row.querySelector('.window-repeat').value;
	const allDay = row.querySelector('.window-all-day').checked;
	const range = repeat === 'range';
	row.querySelector('.window-days').classList.toggle('hidden', repeat !== 'weekly');
	row.querySelector('.window-date-label').classList.toggle('hidden', repeat !== 'once');
	row.querySelector('.window-date').disabled = repeat !== 'once';
	row.querySelector('.window-range-dates').classList.toggle('hidden', !range);
	for (const input of row.querySelectorAll('.window-range-dates input'))
		input.disabled = !range;
	row.querySelector('.window-calendar-link').classList.toggle('hidden', !['school', 'dayoff'].includes(repeat));
	row.querySelector('.window-time-inputs').classList.toggle('hidden', allDay);
	for (const input of row.querySelectorAll('input[type="time"]'))
		input.disabled = allDay;
}

function addTimeWindow(window = {}) {
	if ($('time-windows').children.length >= 64)
		return showError('Use at most 64 time windows');
	const row = document.createElement('fieldset');
	row.className = 'time-window';
	const options = Object.entries(REPEAT_LABELS);
	row.innerHTML = `<legend>Schedule rule</legend>
		<label>Type / repeat<select class="window-repeat">${options.map(([value, label]) =>
			`<option value="${value}">${label}</option>`).join('')}</select></label>
		<div class="window-days">${WEEKDAYS.map((label, day) =>
			`<label class="check-label"><input type="checkbox" value="${day + 1}">${label}</label>`).join('')}</div>
		<label class="window-date-label">Date<input class="window-date" type="date" min="2020-01-01" max="2100-12-31" required></label>
		<div class="window-range-dates window-times">
			<label>First date<input class="window-first-date" type="date" min="2020-01-01" max="2100-12-31" required></label>
			<label>Last date<input class="window-last-date" type="date" min="2020-01-01" max="2100-12-31" required></label>
		</div>
		<p class="window-calendar-link meta">This rule uses the shared School / day-off dates. A date override changes which days match this rule, not the action of other rules.</p>
		<label class="check-label"><input class="window-all-day" type="checkbox">All day</label>
		<div class="window-times window-time-inputs">
			<label>Start<input class="window-start" type="time" step="1" required></label>
			<label>End<input class="window-end" type="time" step="1" required></label>
		</div>
		<div class="actions"><button class="remove-window secondary" type="button">Remove window</button></div>`;
	row.querySelector('.window-repeat').value = window.repeat || 'daily';
	row.querySelector('.window-date').value = window.date || '';
	row.querySelector('.window-first-date').value = window.start_date || routerDate;
	row.querySelector('.window-last-date').value = window.end_date || routerDate;
	row.querySelector('.window-start').value = window.start || '19:30:00';
	row.querySelector('.window-end').value = window.end || '20:15:30';
	row.querySelector('.window-all-day').checked = !!window.all_day;
	for (const input of row.querySelectorAll('.window-days input'))
		input.checked = (window.days || []).includes(+input.value);
	row.addEventListener('change', () => updateTimeWindow(row));
	row.querySelector('.remove-window').addEventListener('click', () => {
		row.remove();
		numberTimeWindows();
		invalidateSchedulePreview();
	});
	$('time-windows').append(row);
	numberTimeWindows();
	invalidateSchedulePreview();
	updateTimeWindow(row);
}

function numberTimeWindows() {
	Array.from($('time-windows').children).forEach((row, index) => {
		row.querySelector('legend').textContent = `Rule #${index + 1}`;
	});
}

$('schedule-format').addEventListener('change', updateScheduleFormat);
$('schedule-policy').addEventListener('change', updateScheduleFormat);
$('add-window').addEventListener('click', () => addTimeWindow());

document.querySelectorAll('.slot-grid').forEach(grid =>
	grid.addEventListener('click', event => {
		const slot = event.target.closest('.slot');
		if (slot) {
			slot.classList.toggle('selected');
			invalidateSchedulePreview();
		}
	}));

function scheduleArgs(activate = false) {
	const bits = id => Array.from($(id).querySelectorAll('.slot'))
		.map(slot => slot.classList.contains('selected') ? '1' : '0').join('');
	const args = {
		person: $('schedule-person').value, activate, format: $('schedule-format').value,
		school_schedule: bits('school-slots'), dayoff_schedule: bits('dayoff-slots'),
		school_night_cutoff: +$('school-cutoff').value, dayoff_night_cutoff: +$('dayoff-cutoff').value
	};
	if (args.format === 'windows') {
		const timeValue = value => value.length === 5 ? value + ':00' : value;
		args.policy = $('schedule-policy').value;
		args.windows = Array.from($('time-windows').children, row => ({
			repeat: row.querySelector('.window-repeat').value,
			days: Array.from(row.querySelectorAll('.window-days input:checked'), input => +input.value),
			date: row.querySelector('.window-date').value,
			...(row.querySelector('.window-repeat').value === 'range' ? {
				start_date: row.querySelector('.window-first-date').value,
				end_date: row.querySelector('.window-last-date').value
			} : {}),
			start: timeValue(row.querySelector('.window-start').value),
			end: timeValue(row.querySelector('.window-end').value),
			all_day: row.querySelector('.window-all-day').checked
		}));
	}
	return args;
}

function invalidateSchedulePreview(notice = true) {
	schedulePreviewRequest++;
	const started = $('schedule-preview-summary').textContent;
	$('schedule-preview-summary').textContent = notice && started ? 'Draft changed. Preview again to see the updated result.' : '';
	$('schedule-preview-result').replaceChildren();
	$('preview-schedule').disabled = false;
}

$('schedule-form').addEventListener('input', () => invalidateSchedulePreview());
$('schedule-form').addEventListener('change', () => invalidateSchedulePreview());
$('schedule-dialog').addEventListener('close', () => invalidateSchedulePreview(false));
$('preview-schedule').addEventListener('click', async () => {
	if (!$('schedule-form').reportValidity()) return;
	const request = ++schedulePreviewRequest;
	const value = $('schedule-preview-time').value;
	const at = value && value.length === 16 ? value + ':00' : value;
	$('preview-schedule').disabled = true;
	$('schedule-preview-summary').textContent = 'Calculating the automatic draft on the router…';
	$('schedule-preview-result').replaceChildren();
	showError('');
	try {
		const result = await rpc('familycontrol', 'preview_schedule', {...scheduleArgs(), at_local: at});
		if (request !== schedulePreviewRequest || !$('schedule-dialog').open) return;
		$('schedule-preview-summary').textContent = `Automatic draft at ${result.inspected_local} (router time): ${result.online ? 'Allowed' : 'Blocked'}. ${reasonText(result.reason)}`;
		$('schedule-preview-result').innerHTML = `<p class="meta">${escapeHtml(result.next_transition_local
			? `Next access change: ${result.next_transition_local} (router time).` : 'No upcoming access change found.')}</p>
			<p class="meta">Next seven days, through ${escapeHtml(result.preview_end_local)} (end exclusive):</p>
			<ol class="preview-segments">${(result.segments || []).map(segment =>
				`<li><strong class="${segment.online ? 'online' : 'paused'}">${segment.online ? 'Allowed' : 'Blocked'}</strong>
				${escapeHtml(segment.start_local)} → ${escapeHtml(segment.end_local)}</li>`).join('')}</ol>
			${result.truncated ? '<p class="notice">Showing the first 32 intervals only. Later intervals are omitted. Choose a later inspection time to continue.</p>' : ''}`;
	}
	catch (error) {
		if (request === schedulePreviewRequest) {
			$('schedule-preview-summary').textContent = 'Preview unavailable.';
			showError(error.message);
		}
	}
	finally {
		if (request === schedulePreviewRequest) $('preview-schedule').disabled = false;
	}
});

$('schedule-form').addEventListener('submit', async event => {
	event.preventDefault();
	await runAction($('schedule-form'), async () => {
		await mutateAndReload('save_schedule', scheduleArgs(event.submitter?.name === 'activate'));
		$('schedule-dialog').close();
	});
});

$('device-choice').addEventListener('change', () => {
	const selected = candidates.find(device => device.mac === $('device-choice').value);
	const manual = $('device-choice').value === 'manual';
	$('manual-mac-fields').classList.toggle('hidden', !manual);
	$('device-mac').required = manual;

	if (selected && !$('device-name').value)
		$('device-name').value = selected.hostname || selected.ip || '';
});

function extraDuration() {
	if ($('extra-hours').value === '' || $('extra-minutes').value === '') return null;
	const hours = +$('extra-hours').value, minutes = +$('extra-minutes').value;
	const total = hours * 60 + minutes;
	return Number.isInteger(hours) && Number.isInteger(minutes) && hours >= 0 &&
		minutes >= 0 && minutes < 60 && total >= 1 && total <= 1440 ? total : null;
}

async function updateExtraPreview() {
	const generation = ++extraPreviewRequest, minutes = extraDuration();
	if (minutes == null) {
		$('extra-preview').textContent = 'Enter a duration from 1 minute to 24 hours.';
		return;
	}
	setError($('extra-dialog').querySelector('.form-error'), '');
	$('extra-preview').textContent = 'Calculating on the router…';
	try {
		const result = await rpc('familycontrol', 'preview_extra', {person: $('extra-person').value, minutes});
		if (generation === extraPreviewRequest && $('extra-dialog').open)
			$('extra-preview').textContent = `Add ${minutes} minutes after ${result.from_local}. Estimated end: ${result.extra_until_local} (router time).`;
	}
	catch (error) {
		if (generation === extraPreviewRequest && $('extra-dialog').open)
			$('extra-preview').textContent = error.message;
	}
}

for (const id of ['extra-hours', 'extra-minutes'])
	$(id).addEventListener('input', () => {
		extraPreviewRequest++;
		globalThis.clearTimeout(extraPreviewTimer);
		extraPreviewTimer = globalThis.setTimeout(updateExtraPreview, 200);
	});

function showExtraResult(result) {
	setError($('notice'), result.extra_until_local
		? `Extra time granted until ${result.extra_until_local} (router time).` : 'Extra time granted.');
}

$('extra-form').addEventListener('submit', async event => {
	event.preventDefault();
	const minutes = extraDuration();
	if (minutes == null) return showError('Enter a duration from 1 minute to 24 hours.');
	await runAction($('extra-form'), async () => {
		const result = await mutateAndReload('add_extra', {person: $('extra-person').value, minutes});
		showExtraResult(result);
		$('extra-dialog').close();
	});
});

$('people').addEventListener('click', async event => {
	const button = event.target.closest('button[data-action]');
	if (!button) return;
	const { action, id } = button.dataset;
	showError('');
	try {
		if (action === 'mode')
			await runAction($('people'), () => mutateAndReload('set_mode', { person: id, mode: button.dataset.mode }));
		else if (action === 'extra')
			await runAction($('people'), async () => showExtraResult(await mutateAndReload('add_extra', { person: id, minutes: +button.dataset.minutes })));
		else if (action === 'custom-extra') {
			$('extra-title').textContent = `${config[id].name}: custom extra time`;
			$('extra-person').value = id;
			$('extra-hours').value = '0';
			$('extra-minutes').value = '15';
			openDialog('extra-dialog');
			await updateExtraPreview();
		}
		else if (action === 'schedule')
			openSchedule(id);
		else if (action === 'add-device') {
			$('device-title').textContent = 'Add device';
			$('device-id').value = '';
			populateDeviceOwners(id);
			$('device-name').value = '';
			$('device-mac').value = '';
			populateDeviceChoices();
			openDialog('device-dialog');
		}
		else if (action === 'edit-device') {
			const device = config[id];
			$('device-title').textContent = 'Edit device';
			$('device-id').value = id;
			populateDeviceOwners(device.person);
			$('device-name').value = device.name || '';
			$('device-mac').value = device.mac || '';
			populateDeviceChoices(device.mac || '');
			openDialog('device-dialog');
		}
		else if (action === 'edit-person') {
			$('person-title').textContent = 'Rename person';
			$('person-id').value = id;
			$('person-name').value = config[id].name || '';
			openDialog('person-dialog');
		}
		else if (action === 'delete-device' || action === 'delete-person') {
			const item = config[id];
			const person = action === 'delete-person' ? item : config[item.person];
			const count = Object.values(config).filter(device =>
				device['.type'] === 'device' && device.person === id).length;
			$('confirm-title').textContent = action === 'delete-device' ? `Remove ${item.name}?` : `Delete ${item.name}?`;
			$('confirm-message').textContent = action === 'delete-device'
				? `Remove ${item.name} (${item.mac}) from ${person.name}? This device will no longer follow ${person.name}’s controls.`
				: `Delete ${person.name} and ${count} device assignment${count === 1 ? '' : 's'}? These devices will no longer follow this person’s controls. This cannot be undone.`;
			$('confirm-method').value = action === 'delete-device' ? 'delete_device' : 'delete_person';
			$('confirm-id').value = id;
			$('confirm-delete').textContent = action === 'delete-device' ? 'Remove device' : 'Delete person';
			openDialog('confirm-dialog');
		}
	}
	catch (error) { showError(error.message); }
});

$('confirm-form').addEventListener('submit', async event => {
	event.preventDefault();
	await runAction($('confirm-form'), async () => {
		const method = $('confirm-method').value;
		const id = $('confirm-id').value;
		await mutateAndReload(method, method === 'delete_device' ? { device: id } : { person: id });
		$('confirm-dialog').close();
	});
});

(async () => {
	if (!session) return showLogin();
	try {
		$('app').classList.remove('hidden');
		await load();
	}
	catch (_) {
		sessionStorage.removeItem('familycontrol-session');
		session = null;
		showLogin();
	}
})();

globalThis.setInterval(() => {
	if (session && !document.querySelector('dialog[open]'))
		load().catch(() => {});
}, 30000);
