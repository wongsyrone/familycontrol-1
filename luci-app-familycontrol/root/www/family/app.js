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
let loadRequest = 0, refreshTimer, lastStatus, lastRefresh = 0, statusTrusted = false;
let discoveryWarning = '';
const dirtyStates = new Map();
let pendingDiscard;
const t = (key, ...args) => globalThis.FamilyControlI18n.t(key, ...args);
const localize = root => globalThis.FamilyControlI18n.localize(root);
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
	node.textContent = message ? t(message) : '';
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
	localize(dialog);
	if (['person-dialog', 'device-dialog', 'schedule-dialog', 'calendar-dialog'].includes(id))
		dirtyStates.set(dialog, formSignature(dialog));
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
		return t('%s%s', person.paused ? t('Blocked') : t('Allowed'),
			person.next_transition ? t(' until %s', person.next_transition_local || clock(person.next_transition)) : '');
	return person.paused ? t('Blocked') : t('Allowed');
}

function modeLabel(person) {
	return t({ online: 'Allow always', paused: 'Block always', schedule: 'By schedule' }[person.mode] || 'Unknown mode');
}

function calendarReason(day) {
	if (!day) return '';
	const source = t({school_day: 'school-day override', day_off: 'day-off override',
		holiday: 'holiday', weekend: 'weekend', weekday: 'weekday'}[day.source] || day.source);
	return t('%s: %s (%s)', day.date, day.kind === 'school' ? t('school day') : t('day off'), source);
}

function reasonText(reason) {
	if (!reason) return '';
	switch (reason.code) {
	case 'disabled': return t('Family Control is disabled in configuration.');
	case 'extra': return t('Allowed by temporary extra time.');
	case 'manual_allow': return t('Allowed by the manual Allow always mode.');
	case 'manual_block': return t('Blocked by the manual Block always mode.');
	case 'invalid_schedule': return t('Blocked because the automatic schedule is invalid: %s', t(reason.error));
	case 'schedule': {
		if (reason.legacy) {
			const cutoff = `${String(Math.floor(reason.cutoff / 60)).padStart(2, '0')}:${String(reason.cutoff % 60).padStart(2, '0')}`;
			return t('%s by the existing half-hour schedule. %s. Selected slot: %s; night cutoff: %s.',
				reason.online ? t('Allowed') : t('Blocked'), calendarReason(reason.calendar),
				reason.slot_allowed ? t('allow') : t('block'), cutoff);
		}
		const matched = reason.matched_rules || [];
		const winners = matched.filter(rule => (reason.winning_rules || []).includes(rule.index));
		const labels = winners.map(rule => `#${rule.index}${rule.name ? ' ' + rule.name : ''} (${rule.calendar ? calendarReason(rule.calendar) : rule.date})`);
		const state = reason.online ? t('Allowed') : t('Blocked');
		return (winners.length ? t('%s by deciding rules %s at priority %s.', state, labels.join(', '), reason.priority)
			: t('%s by default; no rule matches.', state)) +
			(reason.conflict ? t(' Allow/block conflict at this priority: block wins.') : '') +
			(matched.length ? t(' Matching rules: %s.', matched.map(rule => '#' + rule.index).join(', ')) : '') +
			(reason.uses_calendar ? t(' Calendar: %s.', calendarReason(reason.calendar)) : '');
	}
	default: return '';
	}
}

function scheduleSummary(person) {
	if (person.schedule_format !== 'windows')
		return t('School-day schedule (30-minute slots)');
	const windows = person.windows || [];
	const fallback = person.schedule_policy === 'block' ? 'allow' : 'block';
	if (!windows.length)
		return t('No rules; default: %s internet', t(fallback));
	const summaries = windows.slice(0, 2).map(window => {
		const action = (window.enabled === false ? t('Disabled: ') : '') +
			(window.name ? window.name + ' · ' : '') +
			t('%s (priority %s)', t(window.action || person.schedule_policy), window.priority || 0);
		if (window.repeat === 'range')
			return `${action}: ` + (window.all_day ? t('%s–%s (all days included)', window.start_date, window.end_date)
				: `${window.start_date} ${window.start}–${window.end_date} ${window.end}`);
		const repeat = window.repeat === 'weekly'
			? (window.days || []).map(day => t(WEEKDAYS[day - 1])).join(', ')
			: window.repeat === 'once' ? window.date : t(REPEAT_LABELS[window.repeat]);
		return `${action}, ${repeat}: ${window.all_day ? t('all day') : `${window.start}–${window.end}${window.end < window.start ? t(' (next day)') : ''}`}`;
	});
	return t('Default: %s. %s%s', t(fallback), summaries.join('; '),
		windows.length > 2 ? t('; +%s more', windows.length - 2) : '');
}

async function load() {
	const generation = ++loadRequest;
	try {
	const [status, discovered] = await Promise.all([
		rpc('familycontrol', 'status'),
		rpc('familycontrol', 'devices').catch(error => ({warning: error.message}))
	]);
	if (generation !== loadRequest) return;
	if (discovered.devices) candidates = discovered.devices;
	discoveryWarning = discovered.warning ? t('Device discovery unavailable: %s', discovered.warning) : '';
	lastStatus = status;
	lastRefresh = globalThis.performance.now();
	statusTrusted = true;
	savedCalendar = status.calendar || { day_off: [], school_day: [] };
	calendar = savedCalendar;
	routerDate = status.router_now_local?.slice(0, 10) || new Date().toISOString().slice(0, 10);
	$('router-clock').textContent = status.router_now_local
		? t('Router time: %s (%s)', status.router_now_local, status.router_timezone || t('local')) : '';
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
	renderRuntime(status.runtime || {});
	updateFreshness();
	queueRefresh();
	setError($('error'), !status.enforcement?.ok
		? status.enforcement?.message || 'Device restrictions are not applied'
		: status.enabled === false ? 'Family Control is disabled' : '');
	}
	catch (error) {
		if (generation === loadRequest) {
			statusTrusted = false;
			updateFreshness(error.message);
			queueRefresh(5000);
		}
		throw error;
	}
}

function routerNow() {
	if (!lastStatus?.router_now) return Date.now() / 1000;
	return lastStatus.router_now +
		(lastRefresh ? (globalThis.performance.now() - lastRefresh) / 1000 : 0);
}

function updateFreshness(error = '') {
	const age = lastRefresh ? Math.floor((globalThis.performance.now() - lastRefresh) / 1000) : 0;
	const stale = !statusTrusted || age > 65;
	$('refresh-state').classList.toggle('stale', stale);
	$('refresh-message').textContent = stale
		? t('State unconfirmed. Last successful update: %s. %s', lastStatus?.router_now_local || t('Never'), error)
		: t('Last successful update: %s (%s seconds ago). %s', lastStatus.router_now_local || '', age, discoveryWarning);
	for (const node of document.querySelectorAll('.person-state')) {
		if (stale || (+node.dataset.transition && +node.dataset.transition <= routerNow())) {
			node.textContent = t('State unconfirmed');
			node.classList.remove('online', 'paused');
		}
	}
	if (stale)
		for (const node of document.querySelectorAll('.access-reason:not([data-stale])')) {
			node.textContent = t('Last known decision: %s', node.textContent);
			node.dataset.stale = 'true';
		}
	for (const node of document.querySelectorAll('[data-countdown]')) {
		const remaining = Math.max(0, Math.ceil(+node.dataset.countdown - routerNow()));
		const duration = [Math.floor(remaining / 3600), Math.floor(remaining / 60) % 60, remaining % 60]
			.map(value => String(value).padStart(2, '0')).join(':');
		node.textContent = remaining ? t('Estimated remaining: %s', duration) : t('Deadline reached; awaiting refresh');
	}
}

function queueRefresh(delay) {
	globalThis.clearTimeout(refreshTimer);
	if (!session) return;
	if (delay == null) {
		const transitions = (lastStatus?.people || []).map(person => person.next_transition).filter(value => value > routerNow());
		delay = transitions.length ? Math.min(30000, Math.max(250, (Math.min(...transitions) - routerNow()) * 1000 + 250)) : 30000;
	}
	refreshTimer = globalThis.setTimeout(() => {
		if (!session) return;
		if (document.querySelector('dialog[open]')) return queueRefresh(1000);
		load().catch(() => {});
	}, delay);
}

function renderRuntime(runtime) {
	const labels = {save_person: 'Save person', delete_person: 'Delete person', save_device: 'Save device',
		delete_device: 'Remove device', set_mode: 'Change mode', set_paused: 'Change mode', save_schedule: 'Save schedule',
		save_calendar: 'Save calendar', add_extra: 'Add extra time', set_extra_until: 'Set deadline', cancel_extra: 'End extra time'};
	const events = (runtime.events || []).slice().reverse().map(event => {
		const person = config[event.person || event.subject]?.name || event.person || event.subject || '';
		const detail = event.code === 'action' ? t(labels[event.action] || event.action) + (event.ok ? '' : ' · ' + t('Failed'))
			: event.code === 'access_changed' ? t('Access decision changed: %s', event.online ? t('Allowed') : t('Blocked'))
			: event.code === 'clock_changed' ? t('Clock correction detected')
			: t('Enforcement error: %s', event.message || '');
		return `<li>${escapeHtml(event.at_local || String(event.at))} · <span data-user-text>${escapeHtml(person)}</span> ${escapeHtml(detail)}</li>`;
	});
	$('runtime-content').innerHTML = `<p>${escapeHtml(t('Last successful enforcement check: %s', runtime.last_success_local || t('Not recorded')))}</p>
		<p>${escapeHtml(t('Latest result: %s', runtime.last_result ? runtime.last_result.ok ? t('Success') : t('Failed') : t('Not recorded')))}</p>
		${runtime.last_error ? `<p class="meta">${escapeHtml(t('Last error: %s — %s', runtime.last_error.at_local || '', runtime.last_error.message))}</p>` : ''}
		<p class="meta">${escapeHtml(t('Only the latest 100 memory events are kept. Reboot clears them.'))}</p>
		<ol class="runtime-events">${events.join('') || `<li>${escapeHtml(t('No events recorded'))}</li>`}</ol>`;
}

$('refresh-now').addEventListener('click', () => load().catch(() => {}));

function render(people, applied) {
	const focused = $('people').contains(document.activeElement) ? document.activeElement : null;
	const focusKey = focused?.dataset.action ? {...focused.dataset} : null;
	const devices = Object.values(config).filter(s => s['.type'] === 'device');
	$('people').innerHTML = people.length ? people.map(person => {
		const owned = devices.filter(device => device.person === person.id);
		return `<article class="card">
			<div class="row">
				<div>
					<h2 data-user-text>${escapeHtml(person.name)}</h2>
					<span class="mode-label">${escapeHtml(t('Mode: %s', modeLabel(person)))}</span>
					<p class="meta"><span data-transition="${person.next_transition || 0}" class="person-state ${applied ? person.paused ? 'paused' : 'online' : ''}">${escapeHtml(applied ? stateText(person) : t('Not applied'))}</span>
					· ${escapeHtml(t('%s devices', owned.length))}</p>
				</div>
				<div class="actions">
					<button class="secondary" data-action="mode" data-mode="online" aria-pressed="${person.mode === 'online' && !person.extra_until}" data-id="${person.id}">Allow always</button>
					<button class="secondary" data-action="mode" data-mode="paused" aria-pressed="${person.mode === 'paused' && !person.extra_until}" data-id="${person.id}">Block always</button>
					<button class="secondary" data-action="mode" data-mode="schedule" aria-pressed="${person.mode === 'schedule' && !person.extra_until}" data-id="${person.id}">Use schedule</button>
					${person.mode !== 'online' ? `<details><summary>Extra time</summary>
						<button type="button" data-action="extra" data-minutes="15" data-id="${person.id}">Add 15 minutes</button>
						<button type="button" data-action="extra" data-minutes="30" data-id="${person.id}">Add 30 minutes</button>
						<button type="button" data-action="extra" data-minutes="60" data-id="${person.id}">Add 1 hour</button>
						<button type="button" data-action="custom-extra" data-id="${person.id}">Custom extra time</button>
					</details>` : ''}
				</div>
			</div>
			<p class="access-reason meta">${escapeHtml((!applied ? t('Configured decision: ') : '') + reasonText(person.reason))}</p>
			<p class="schedule-summary"><strong>${person.mode === 'schedule' && !person.extra_until && person.reason?.code !== 'disabled' ? 'Schedule' : 'Saved schedule (not active)'}:</strong> ${escapeHtml(scheduleSummary(person))}</p>
			${person.extra_until ? `<p class="meta">${escapeHtml(t('Extra time until %s (router time); then restore %s.', person.extra_until_local || clock(person.extra_until), modeLabel(person)))}
				<span data-countdown="${person.extra_until}"></span></p>
				<button class="secondary" data-action="cancel-extra" data-id="${person.id}">End extra time</button>` : ''}
			<button class="secondary" data-action="schedule" data-id="${person.id}">Edit schedule</button>
			${owned.map(device => `<div class="card">
				<strong data-user-text>${escapeHtml(device.name || device.mac)}</strong>
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
	localize($('people'));
	if (focusKey)
		Array.from($('people').querySelectorAll('button[data-action]')).find(button =>
			button.dataset.action === focusKey.action && button.dataset.id === focusKey.id &&
			button.dataset.mode === focusKey.mode)?.focus({preventScroll: true});
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
	$('calendar-dirty').textContent = changed.size ? t('Unsaved date changes: %s', changed.size) : t('No unsaved date changes.');
	renderCalendarMonth();
	localize($('calendar-dialog'));
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
	$('calendar-month-label').textContent = first.toLocaleDateString(globalThis.FamilyControlI18n.language, {year: 'numeric', month: 'long', timeZone: 'UTC'});
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
		const label = t('%s, %s (%s)', key, off ? t('day off') : t('school day'), override ? t('override') : t('default'));
		cells.push(`<td><button type="button" data-calendar-date="${key}" class="${off ? 'day-off' : ''} ${override ? 'override' : ''}"
			tabindex="${key === calendarCursor ? '0' : '-1'}" aria-label="${label}" aria-pressed="${calendarSelection.has(key)}">${number}</button></td>`);
	}
	$('calendar-grid').innerHTML = Array.from({length: cells.length / 7}, (_, row) =>
		`<tr>${cells.slice(row * 7, row * 7 + 7).join('')}</tr>`).join('');
	$('calendar-selection').textContent = t('%s dates selected. Changes apply only after Save calendar.', calendarSelection.size);
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
		(person.schedule_format === 'legacy' || person.windows.some(window => window.enabled !== false && ['school', 'dayoff'].includes(window.repeat))));
	$('calendar-usage').textContent = users.length
		? t('Used by: %s. Saving these shared labels affects all linked schedules.',
			users.map(person => `${person.name}${person.mode === 'schedule' ? '' : t(' (saved, inactive)')}`).join(', '))
		: t('No saved schedule currently uses these labels. Choose School days or Days off in a schedule to use them.');
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

function formSignature(dialog) {
	if (dialog.id === 'calendar-dialog')
		return JSON.stringify({day_off: calendar.day_off, school_day: calendar.school_day});
	if (dialog.id === 'schedule-dialog') return JSON.stringify(scheduleArgs());
	return JSON.stringify(Array.from(dialog.querySelectorAll('input,select,textarea'))
		.filter(input => !input.hasAttribute('data-auxiliary'))
		.map(input => [input.id, input.type === 'checkbox' ? input.checked : input.value]));
}

function isDirty(dialog) {
	return dirtyStates.has(dialog) && dirtyStates.get(dialog) !== formSignature(dialog);
}

function askToDiscard(action, message) {
	pendingDiscard = action;
	$('discard-message').textContent = message || t('Discard unsaved changes and close this editor?');
	$('discard-dialog').showModal();
	localize($('discard-dialog'));
	$('keep-editing').focus();
}

function requestClose(dialog) {
	if (dialog.querySelector('form[aria-busy="true"]')) return;
	if (isDirty(dialog)) askToDiscard(() => dialog.close());
	else dialog.close();
}

$('keep-editing').addEventListener('click', () => { pendingDiscard = null; $('discard-dialog').close(); });
$('discard-changes').addEventListener('click', () => {
	const action = pendingDiscard;
	pendingDiscard = null;
	$('discard-dialog').close();
	if (action) action();
});
$('ui-language').value = globalThis.FamilyControlI18n.language;
$('ui-language').addEventListener('change', () => {
	const value = $('ui-language').value;
	if ([...dirtyStates.keys()].some(isDirty)) {
		$('ui-language').value = globalThis.FamilyControlI18n.language;
		askToDiscard(() => {
			dirtyStates.clear();
			globalThis.FamilyControlI18n.setLanguage(value);
		}, t('Discard unsaved changes and change language?'));
	}
	else globalThis.FamilyControlI18n.setLanguage(value);
});
globalThis.addEventListener('beforeunload', event => {
	if ([...dirtyStates.keys()].some(dialog => dialog.open && isDirty(dialog))) {
		event.preventDefault();
		event.returnValue = '';
	}
});
document.querySelectorAll('.cancel').forEach(button =>
	button.addEventListener('click', () => requestClose(button.closest('dialog'))));
document.querySelectorAll('dialog').forEach(dialog =>
	dialog.addEventListener('cancel', event => {
		if (dialog.querySelector('form[aria-busy="true"]') || isDirty(dialog)) {
			event.preventDefault();
			if (!dialog.querySelector('form[aria-busy="true"]')) requestClose(dialog);
		}
	}));
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('close', () => {
	dirtyStates.delete(dialog);
	if (lastRefresh && globalThis.performance.now() - lastRefresh > 30000) queueRefresh(0);
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
				})[source]).filter(Boolean).map(label => t(label)).join(' / ')
			].filter(Boolean).join(' · ');
			return `<option value="${escapeHtml(device.mac)}">${escapeHtml(label)}</option>`;
		}),
		'<option value="manual">Enter a MAC address manually…</option>'
	].join('');

	if (normalizedCurrent && !available.some(device => device.mac === normalizedCurrent)) {
		select.insertAdjacentHTML('beforeend',
			`<option value="${escapeHtml(normalizedCurrent)}">${escapeHtml(normalizedCurrent)} · ${escapeHtml(t('Saved device'))}</option>`);
	}

	select.value = normalizedCurrent || '';
	$('manual-mac-fields').classList.add('hidden');
}

function populateDeviceOwners(personId) {
	$('device-person').innerHTML = Object.values(config)
		.filter(section => section['.type'] === 'person')
		.map(person => `<option data-user-text value="${escapeHtml(person['.name'])}">${escapeHtml(person.name)}</option>`).join('');
	$('device-person').value = personId;
	$('device-owner-help').textContent = 'Moving this device applies the selected person’s controls immediately after saving.';
}

function renderSlots(id, value) {
	$(id).innerHTML = Array.from({ length: 48 }, (_, slot) => {
		const minutes = slot * 30;
		const label = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${minutes % 60 ? '30' : '00'}`;
		return `<button type="button" aria-pressed="${value[slot] === '1'}" class="slot ${value[slot] === '1' ? 'selected' : ''}" data-slot="${slot}">${label}</button>`;
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
	$('schedule-title').textContent = t('%s schedule', person.name);
	$('schedule-mode').textContent = t('Current mode: %s%s', modeLabel(person),
		person.extra_until ? t(' (temporarily overridden by extra time)') : '');
	const sources = Object.values(config).filter(section => section['.type'] === 'person' && section['.name'] !== id);
	$('copy-schedule-source').innerHTML = `<option value="">${escapeHtml(t('Choose a person'))}</option>` +
		sources.map(source => `<option data-user-text value="${source['.name']}">${escapeHtml(source.name)}</option>`).join('');
	$('copy-person-schedule').disabled = !sources.length;
	loadScheduleDraft(person);
	$('schedule-preview-time').value = '';
	invalidateSchedulePreview(false);
	openDialog('schedule-dialog');
}

function loadScheduleDraft(person) {
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
	localize($('schedule-form'));
}

$('copy-person-schedule').addEventListener('click', () => {
	const source = config[$('copy-schedule-source').value];
	if (!source) return showError('Choose a person');
	const copy = () => loadScheduleDraft(source);
	if (isDirty($('schedule-dialog')))
		askToDiscard(copy, t('Replace this unsaved draft with the selected person’s schedule?'));
	else copy();
});

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
	$('schedule-policy-help').textContent = t($('schedule-policy').value === 'allow'
		? 'No matching rule: blocked. Each rule keeps its own action when this default changes.'
		: 'No matching rule: allowed. Each rule keeps its own action when this default changes.');
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
		<label>Rule name<input class="window-name" maxlength="60" placeholder="Optional name"></label>
		<label class="check-label"><input class="window-enabled" type="checkbox" checked>Enabled</label>
		<div class="window-times">
			<label>Action<select class="window-action"><option value="allow">Allow internet</option><option value="block">Block internet</option></select></label>
			<label>Priority<input class="window-priority" type="number" min="0" max="100" step="1" list="rule-priorities" required></label>
		</div>
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
		<div class="actions"><button class="duplicate-window secondary" type="button">Duplicate rule</button>
			<button class="remove-window secondary" type="button">Remove window</button></div>`;
	row.querySelector('.window-repeat').value = window.repeat || 'daily';
	row.querySelector('.window-name').value = window.name || '';
	row.querySelector('.window-enabled').checked = window.enabled !== false;
	row.querySelector('.window-action').value = window.action || $('schedule-policy').value;
	row.querySelector('.window-priority').value = window.priority || 0;
	row.querySelector('.window-date').value = window.date || '';
	row.querySelector('.window-first-date').value = window.start_date || routerDate;
	row.querySelector('.window-last-date').value = window.end_date || routerDate;
	row.querySelector('.window-start').value = window.start || '19:30:00';
	row.querySelector('.window-end').value = window.end || '20:15:30';
	row.querySelector('.window-all-day').checked = !!window.all_day;
	for (const input of row.querySelectorAll('.window-days input'))
		input.checked = (window.days || []).includes(+input.value);
	row.addEventListener('change', () => {
		updateTimeWindow(row);
		numberTimeWindows();
	});
	row.querySelector('.duplicate-window').addEventListener('click', () => {
		const copy = readTimeWindow(row);
		if (copy.name) copy.name = Array.from(t('%s (copy)', copy.name)).slice(0, 60).join('');
		addTimeWindow(copy);
	});
	row.querySelector('.remove-window').addEventListener('click', () => {
		row.remove();
		numberTimeWindows();
		invalidateSchedulePreview();
	});
	$('time-windows').append(row);
	numberTimeWindows();
	invalidateSchedulePreview();
	updateTimeWindow(row);
	localize(row);
}

function numberTimeWindows() {
	Array.from($('time-windows').children).forEach((row, index) => {
		const enabled = row.querySelector('.window-enabled').checked;
		row.classList.toggle('rule-disabled', !enabled);
		row.querySelector('legend').textContent = t('Rule #%s%s', index + 1,
			enabled ? '' : t(' (disabled)'));
	});
}

$('schedule-format').addEventListener('change', updateScheduleFormat);
$('schedule-policy').addEventListener('change', updateScheduleFormat);
$('add-window').addEventListener('click', () => addTimeWindow());
$('add-exception-window').addEventListener('click', () => addTimeWindow({
	repeat: 'range', all_day: true, priority: 10,
	action: $('schedule-policy').value === 'allow' ? 'block' : 'allow'
}));

document.querySelectorAll('.slot-grid').forEach(grid =>
	grid.addEventListener('click', event => {
		const slot = event.target.closest('.slot');
		if (slot) {
			slot.classList.toggle('selected');
			slot.setAttribute('aria-pressed', String(slot.classList.contains('selected')));
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
		args.policy = $('schedule-policy').value;
		args.windows = Array.from($('time-windows').children, readTimeWindow);
	}
	return args;
}

function readTimeWindow(row) {
	const timeValue = value => value.length === 5 ? value + ':00' : value;
	return {
			repeat: row.querySelector('.window-repeat').value,
			name: row.querySelector('.window-name').value.trim(),
			enabled: row.querySelector('.window-enabled').checked,
			action: row.querySelector('.window-action').value,
			priority: +row.querySelector('.window-priority').value,
			days: Array.from(row.querySelectorAll('.window-days input:checked'), input => +input.value),
			date: row.querySelector('.window-date').value,
			...(row.querySelector('.window-repeat').value === 'range' ? {
				start_date: row.querySelector('.window-first-date').value,
				end_date: row.querySelector('.window-last-date').value
			} : {}),
			start: timeValue(row.querySelector('.window-start').value),
			end: timeValue(row.querySelector('.window-end').value),
			all_day: row.querySelector('.window-all-day').checked
		};
}

function invalidateSchedulePreview(notice = true) {
	schedulePreviewRequest++;
	const started = $('schedule-preview-summary').textContent;
	$('schedule-preview-summary').textContent = notice && started ? t('Draft changed. Preview again to see the updated result.') : '';
	$('schedule-preview-result').replaceChildren();
	$('preview-schedule').disabled = false;
}

$('schedule-form').addEventListener('input', () => invalidateSchedulePreview());
$('schedule-form').addEventListener('change', () => invalidateSchedulePreview());
$('schedule-dialog').addEventListener('close', () => invalidateSchedulePreview(false));
async function runSchedulePreview(atEpoch) {
	if (!$('schedule-form').reportValidity()) return;
	const request = ++schedulePreviewRequest;
	const value = $('schedule-preview-time').value;
	const at = value && value.length === 16 ? value + ':00' : value;
	$('preview-schedule').disabled = true;
	$('schedule-preview-summary').textContent = t('Calculating the automatic draft on the router…');
	$('schedule-preview-result').replaceChildren();
	showError('');
	try {
		const result = await rpc('familycontrol', 'preview_schedule', {...scheduleArgs(),
			...(atEpoch == null ? {at_local: at} : {at_local: '', at_epoch: atEpoch})});
		if (request !== schedulePreviewRequest || !$('schedule-dialog').open) return;
		if (atEpoch != null) $('schedule-preview-time').value = result.inspected_local.replace(' ', 'T');
		$('schedule-preview-summary').textContent = t('Automatic draft at %s (router time): %s. %s',
			result.inspected_local, result.online ? t('Allowed') : t('Blocked'), reasonText(result.reason));
		$('schedule-preview-result').innerHTML = `<p class="meta">${escapeHtml(result.next_transition_local
			? t('Next access change: %s (router time).', result.next_transition_local) : t('No upcoming access change found.'))}</p>
			<p class="meta">${escapeHtml(t('Next seven days, through %s (end exclusive):', result.preview_end_local))}</p>
			${renderTimeline(result)}
			${renderDiagnostics(result.diagnostics || {})}
			<ol class="preview-segments">${(result.segments || []).map(segment =>
				`<li><button class="preview-inspect" type="button" data-inspect="${segment.start}">
				<strong class="${segment.online ? 'online' : 'paused'}">${escapeHtml(segment.online ? t('Allowed') : t('Blocked'))}</strong>
				${escapeHtml(segment.start_local)} → ${escapeHtml(segment.end_local)}</button></li>`).join('')}</ol>
			${result.truncated ? `<p class="notice">${escapeHtml(t('Showing the first 32 intervals only. Later intervals are omitted. Choose a later inspection time to continue.'))}</p>` : ''}`;
	}
	catch (error) {
		if (request === schedulePreviewRequest) {
			$('schedule-preview-summary').textContent = t('Preview unavailable.');
			showError(error.message);
		}
	}
	finally {
		if (request === schedulePreviewRequest) $('preview-schedule').disabled = false;
	}
}
$('preview-schedule').addEventListener('click', () => runSchedulePreview());

function renderTimeline(result) {
	if (!(result.timeline_days || []).length) return '';
	const rows = result.timeline_days.map(day => {
		const bars = (result.segments || []).flatMap(segment => {
			const start = Math.max(segment.start, day.start), end = Math.min(segment.end, day.end);
			if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
			const left = (start - day.start) / (day.end - day.start) * 100;
			const width = (end - start) / (day.end - day.start) * 100;
			return [`<button type="button" tabindex="-1" data-inspect="${start}" data-inspect-end="${end}"
				aria-label="${escapeHtml(t('%s. Inspect this interval.', segment.online ? t('Allowed') : t('Blocked')))}"
				class="${segment.online ? 'allow' : 'block'}" style="left:${left}%;width:${width}%"></button>`];
		});
		return `<div class="timeline-row"><span>${escapeHtml(day.date)}</span><div class="timeline-track"
			role="group" aria-label="${escapeHtml(t('Access timeline for %s', day.date))}">${bars.join('')}</div></div>`;
	});
	return `<section class="timeline"><p>${escapeHtml(t('Timeline: green allows, red blocks, grey is not shown or outside the range.'))}</p>
		<p class="meta">${escapeHtml(t('Click a point to inspect it. Exact second intervals remain available below.'))}</p>${rows.join('')}</section>`;
}

function renderDiagnostics(diagnostics) {
	const windows = Array.from($('time-windows').children, readTimeWindow);
	const ruleLabel = index => '#' + index + (windows[index - 1]?.name ? ' ' + windows[index - 1].name : '');
	const warnings = (diagnostics.warnings || []).map(warning => {
		const rules = warning.rules.map(ruleLabel).join(', ');
		const message = warning.code === 'duplicate'
			? t('Rules %s have identical conditions, action and priority.', rules)
			: warning.code === 'expired' ? t('Rule %s has expired.', rules)
			: warning.code === 'conflict' ? t('Rules %s have an allow/block conflict at priority %s near %s.', rules, warning.priority, warning.at_local || '')
			: t('Rule %s matches in this preview but never decides the result.', rules);
		return `<li data-warning="${warning.code}">${escapeHtml(message)}</li>`;
	});
	return `<section class="schedule-diagnostics"><h3>${escapeHtml(t('Schedule diagnostics'))}</h3>
		<p class="meta">${escapeHtml(t('Findings apply to this preview range. They do not claim a rule will never take effect. Disabled rules are excluded.'))}</p>
		${warnings.length ? `<ul>${warnings.join('')}</ul>` : `<p>${escapeHtml(t('No warnings in this preview range.'))}</p>`}
		${diagnostics.warnings_truncated ? `<p>${escapeHtml(t('Only the first 100 warnings are shown.'))}</p>` : ''}</section>`;
}

$('schedule-preview-result').addEventListener('click', event => {
	const button = event.target.closest('[data-inspect]');
	if (!button) return;
	const start = +button.dataset.inspect, end = +button.dataset.inspectEnd;
	let at = start;
	if (Number.isFinite(end) && event.detail) {
		const bounds = button.getBoundingClientRect();
		at = Math.min(end - 1, start + Math.floor(Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) * (end - start)));
	}
	if (Number.isFinite(at)) runSchedulePreview(at);
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
	const generation = ++extraPreviewRequest, args = extraArgs();
	if (!args) {
		$('extra-preview').textContent = t($('extra-kind').value === 'deadline'
			? 'Choose a deadline in the next 24 hours.' : 'Enter a duration from 1 minute to 24 hours.');
		return;
	}
	setError($('extra-dialog').querySelector('.form-error'), '');
	$('extra-preview').textContent = t('Calculating on the router…');
	try {
		const result = await rpc('familycontrol', 'preview_extra', args);
		if (generation === extraPreviewRequest && $('extra-dialog').open)
			$('extra-preview').textContent = args.until_local
				? t('Allow until %s (router time). Original mode is preserved.', result.extra_until_local)
				: t('Add %s minutes after %s. Estimated end: %s (router time).', args.minutes, result.from_local, result.extra_until_local);
	}
	catch (error) {
		if (generation === extraPreviewRequest && $('extra-dialog').open)
			$('extra-preview').textContent = t(error.message);
	}
}

function extraArgs() {
	const person = $('extra-person').value;
	if ($('extra-kind').value === 'deadline') {
		const value = $('extra-until').value;
		return value ? {person, until_local: value.length === 16 ? value + ':00' : value} : null;
	}
	const minutes = extraDuration();
	return minutes == null ? null : {person, minutes};
}

function updateExtraKind() {
	const deadline = $('extra-kind').value === 'deadline';
	$('extra-duration-fields').classList.toggle('hidden', deadline);
	$('extra-until-label').classList.toggle('hidden', !deadline);
	$('extra-deadline-help').classList.toggle('hidden', !deadline);
	for (const id of ['extra-hours', 'extra-minutes']) $(id).disabled = deadline;
	$('extra-until').disabled = !deadline;
	$('extra-until').required = deadline;
	updateExtraPreview();
}
$('extra-kind').addEventListener('change', updateExtraKind);
for (const id of ['extra-hours', 'extra-minutes', 'extra-until'])
	$(id).addEventListener('input', () => {
		extraPreviewRequest++;
		globalThis.clearTimeout(extraPreviewTimer);
		extraPreviewTimer = globalThis.setTimeout(updateExtraPreview, 200);
	});

function showExtraResult(result) {
	setError($('notice'), result.extra_until_local
		? t('Extra time granted until %s (router time).', result.extra_until_local) : 'Extra time granted.');
}

$('extra-form').addEventListener('submit', async event => {
	event.preventDefault();
	const args = extraArgs();
	if (!args) return showError($('extra-kind').value === 'deadline'
		? 'Choose a deadline in the next 24 hours.' : 'Enter a duration from 1 minute to 24 hours.');
	await runAction($('extra-form'), async () => {
		const result = await mutateAndReload(args.until_local ? 'set_extra_until' : 'add_extra', args);
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
			$('extra-title').textContent = t('%s: custom extra time', config[id].name);
			$('extra-person').value = id;
			$('extra-hours').value = '0';
			$('extra-minutes').value = '15';
			$('extra-kind').value = 'duration';
			$('extra-until').value = '';
			openDialog('extra-dialog');
			updateExtraKind();
		}
		else if (action === 'cancel-extra')
			await runAction($('people'), async () => {
				await mutateAndReload('cancel_extra', {person: id});
				setError($('notice'), 'Extra time ended; original mode restored.');
			});
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
			$('confirm-title').textContent = action === 'delete-device' ? t('Remove %s?', item.name) : t('Delete %s?', item.name);
			$('confirm-message').textContent = action === 'delete-device'
				? t('Remove %s (%s) from %s? This device will no longer follow %s’s controls.', item.name, item.mac, person.name, person.name)
				: t(count === 1
					? 'Delete %s and %s device assignment? These devices will no longer follow this person’s controls. This cannot be undone.'
					: 'Delete %s and %s device assignments? These devices will no longer follow this person’s controls. This cannot be undone.', person.name, count);
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

globalThis.setInterval(() => { if (session) updateFreshness(); }, 1000);
