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
const REPEAT_LABELS = {
	daily: 'Every day', weekdays: 'Monday to Friday', weekends: 'Saturday and Sunday',
	weekly: 'Selected weekdays', once: 'Once on a date',
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

function scheduleSummary(person) {
	if (person.schedule_format !== 'windows')
		return 'School-day schedule (30-minute slots)';
	const windows = person.windows || [];
	if (!windows.length)
		return person.schedule_policy === 'block' ? 'Schedule allows internet all the time' : 'Schedule blocks internet all the time';
	const summaries = windows.slice(0, 2).map(window => {
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
	config = {};
	for (const person of status.people || []) {
		config[person.id] = {
			'.name': person.id,
			'.type': 'person',
			name: person.name,
			paused: person.paused ? '1' : '0',
			mode: person.mode,
			extra_until: person.extra_until,
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
					</details>` : ''}
				</div>
			</div>
			<p class="schedule-summary"><strong>${person.mode === 'schedule' && !person.extra_until ? 'Schedule' : 'Saved schedule (not active)'}:</strong> ${escapeHtml(scheduleSummary(person))}</p>
			${person.extra_until ? `<p class="meta">Extra time overrides this mode until ${escapeHtml(clock(person.extra_until))}.</p>` : ''}
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
	await rpc('familycontrol', method, args);
	try { await load(); }
	catch (_) { setError($('error'), 'Change saved, but status could not be refreshed. Reload this page.'); }
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
}

$('open-calendar').addEventListener('click', () => {
	calendar = {
		...savedCalendar,
		day_off: [ ...(savedCalendar.day_off || []) ],
		school_day: [ ...(savedCalendar.school_day || []) ]
	};
	renderExceptions();
	openDialog('calendar-dialog');
});

$('add-exception').addEventListener('click', () => {
	const date = $('exception-date').value;
	const kind = $('exception-kind').value;
	if (!date) return showError('Choose a date.');
	for (const list of [ calendar.day_off, calendar.school_day ]) {
		const index = list.indexOf(date);
		if (index >= 0) list.splice(index, 1);
	}
	calendar[kind].push(date);
	$('exception-date').value = '';
	renderExceptions();
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
		'<option value="windows">Time windows (HH:mm:ss)</option>';
	$('schedule-format').value = legacy ? 'legacy' : 'windows';
	$('schedule-policy').value = person.schedule_policy || 'allow';
	$('time-windows').replaceChildren();
	for (const window of legacy
		? [{ repeat: 'daily', start: '06:00:00', end: '22:00:00' }]
		: person.windows)
		addTimeWindow(window);
	updateScheduleFormat();
	openDialog('schedule-dialog');
}

function updateScheduleFormat() {
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
	row.querySelector('.window-days').classList.toggle('hidden', repeat !== 'weekly');
	row.querySelector('.window-date-label').classList.toggle('hidden', repeat !== 'once');
	row.querySelector('.window-date').disabled = repeat !== 'once';
	row.querySelector('.window-times').classList.toggle('hidden', allDay);
	for (const input of row.querySelectorAll('input[type="time"]'))
		input.disabled = allDay;
}

function addTimeWindow(window = {}) {
	if ($('time-windows').children.length >= 64)
		return showError('Use at most 64 time windows');
	const row = document.createElement('fieldset');
	row.className = 'time-window';
	const options = Object.entries(REPEAT_LABELS);
	row.innerHTML = `<legend>Time window</legend>
		<label>Repeat<select class="window-repeat">${options.map(([value, label]) =>
			`<option value="${value}">${label}</option>`).join('')}</select></label>
		<div class="window-days">${WEEKDAYS.map((label, day) =>
			`<label class="check-label"><input type="checkbox" value="${day + 1}">${label}</label>`).join('')}</div>
		<label class="window-date-label">Date<input class="window-date" type="date" min="2020-01-01" max="2100-12-31" required></label>
		<label class="check-label"><input class="window-all-day" type="checkbox">All day</label>
		<div class="window-times">
			<label>Start<input class="window-start" type="time" step="1" required></label>
			<label>End<input class="window-end" type="time" step="1" required></label>
		</div>
		<div class="actions"><button class="remove-window secondary" type="button">Remove window</button></div>`;
	row.querySelector('.window-repeat').value = window.repeat || 'daily';
	row.querySelector('.window-date').value = window.date || '';
	row.querySelector('.window-start').value = window.start || '19:30:00';
	row.querySelector('.window-end').value = window.end || '20:15:30';
	row.querySelector('.window-all-day').checked = !!window.all_day;
	for (const input of row.querySelectorAll('.window-days input'))
		input.checked = (window.days || []).includes(+input.value);
	row.addEventListener('change', () => updateTimeWindow(row));
	row.querySelector('.remove-window').addEventListener('click', () => row.remove());
	$('time-windows').append(row);
	updateTimeWindow(row);
}

$('schedule-format').addEventListener('change', updateScheduleFormat);
$('schedule-policy').addEventListener('change', updateScheduleFormat);
$('add-window').addEventListener('click', () => addTimeWindow());

document.querySelectorAll('.slot-grid').forEach(grid =>
	grid.addEventListener('click', event => {
		const slot = event.target.closest('.slot');
		if (slot) slot.classList.toggle('selected');
	}));

$('schedule-form').addEventListener('submit', async event => {
	event.preventDefault();
	const bits = id => Array.from($(id).querySelectorAll('.slot'))
		.map(slot => slot.classList.contains('selected') ? '1' : '0').join('');
	await runAction($('schedule-form'), async () => {
		const args = {
			person: $('schedule-person').value,
			activate: event.submitter?.name === 'activate',
			format: $('schedule-format').value,
			school_schedule: bits('school-slots'),
			dayoff_schedule: bits('dayoff-slots'),
			school_night_cutoff: +$('school-cutoff').value,
			dayoff_night_cutoff: +$('dayoff-cutoff').value
		};
		if (args.format === 'windows') {
			const timeValue = value => value.length === 5 ? value + ':00' : value;
			args.policy = $('schedule-policy').value;
			args.windows = Array.from($('time-windows').children, row => ({
				repeat: row.querySelector('.window-repeat').value,
				days: Array.from(row.querySelectorAll('.window-days input:checked'), input => +input.value),
				date: row.querySelector('.window-date').value,
				start: timeValue(row.querySelector('.window-start').value),
				end: timeValue(row.querySelector('.window-end').value),
				all_day: row.querySelector('.window-all-day').checked
			}));
		}
		await mutateAndReload('save_schedule', args);
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

$('people').addEventListener('click', async event => {
	const button = event.target.closest('button[data-action]');
	if (!button) return;
	const { action, id } = button.dataset;
	showError('');
	try {
		if (action === 'mode')
			await runAction($('people'), () => mutateAndReload('set_mode', { person: id, mode: button.dataset.mode }));
		else if (action === 'extra')
			await runAction($('people'), () => mutateAndReload('add_extra', { person: id, minutes: +button.dataset.minutes }));
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
