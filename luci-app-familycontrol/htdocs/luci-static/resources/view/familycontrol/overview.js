// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';
'require dom';
'require rpc';
'require ui';
'require view';
'require poll';
/* global poll */

const callStatus = rpc.declare({
	object: 'familycontrol',
	method: 'status',
	expect: {}
});

const callSetMode = rpc.declare({
	object: 'familycontrol',
	method: 'set_mode',
	params: [ 'person', 'mode' ],
	expect: {}
});
const callCancelExtra = rpc.declare({
	object: 'familycontrol', method: 'cancel_extra', params: [ 'person' ], expect: {}
});

function styles() {
	return E('style', {}, `
		.fc-shell { max-width: 52rem; margin: 0 auto; }
		.fc-heading { margin-bottom: 1.25rem; }
		.fc-heading h2 { margin-bottom: .35rem; }
		.fc-grid { display: grid; gap: .85rem; }
		.fc-card {
			display: grid;
			grid-template-columns: minmax(0, 1fr) auto;
			align-items: center;
			gap: 1rem;
			padding: 1.1rem;
			border: 1px solid var(--border-color-medium, #d8d8d8);
			border-radius: .85rem;
			background: var(--background-color-high, #fff);
			box-shadow: 0 1px 3px rgba(0, 0, 0, .06);
		}
		.fc-card h3 { margin: 0 0 .3rem; font-size: 1.15rem; }
		.fc-meta { margin: 0; color: var(--text-color-secondary, #666); }
		.fc-state { font-weight: 600; }
		.fc-state-paused { color: #b42318; }
		.fc-state-online { color: #18794e; }
		.fc-actions { display:flex; flex-wrap:wrap; gap:.5rem; }
		.fc-action[aria-pressed="true"] { outline:2px solid currentColor; outline-offset:2px; }
		.fc-action {
			min-width: 7.5rem;
			min-height: 3rem;
			border-radius: .65rem;
			font-size: 1rem;
			font-weight: 600;
		}
		.fc-empty {
			padding: 2rem 1rem;
			text-align: center;
			border: 1px dashed var(--border-color-medium, #bbb);
			border-radius: .85rem;
		}
		@media (max-width: 480px) {
			.fc-card { grid-template-columns: 1fr; }
			.fc-action { width: 100%; }
		}
	`);
}

function calendarReason(day) {
	if (!day) return '';
	const sources = { school_day: _('school-day override'), day_off: _('day-off override'),
		holiday: _('holiday'), weekend: _('weekend'), weekday: _('weekday') };
	return _('%s: %s (%s)').format(day.date, day.kind === 'school' ? _('school day') : _('day off'),
		sources[day.source] || day.source);
}

function reasonText(reason) {
	if (!reason) return '';
	switch (reason.code) {
	case 'disabled': return _('Family Control is disabled in configuration.');
	case 'extra': return _('Allowed by temporary extra time.');
	case 'manual_allow': return _('Allowed by the manual Allow always mode.');
	case 'manual_block': return _('Blocked by the manual Block always mode.');
	case 'invalid_schedule': return _('Blocked because the automatic schedule is invalid: %s').format(reason.error);
	case 'schedule': {
		const state = reason.online ? _('Allowed') : _('Blocked');
		if (reason.legacy)
			return _('%s by the existing half-hour schedule. %s. Selected slot: %s; night cutoff: %s.').format(
				state, calendarReason(reason.calendar), reason.slot_allowed ? _('allow') : _('block'),
				String(Math.floor(reason.cutoff / 60)).padStart(2, '0') + ':' + String(reason.cutoff % 60).padStart(2, '0'));
		const matched = reason.matched_rules || [];
		const winners = matched.filter(rule => (reason.winning_rules || []).includes(rule.index));
		const labels = winners.map(rule =>
			'#' + rule.index + ' (' + (rule.calendar ? calendarReason(rule.calendar) : rule.date) + ')');
		return (winners.length
			? _('%s by deciding rules %s at priority %s.').format(state, labels.join(', '), reason.priority)
			: _('%s by default; no rule matches.').format(state)) +
			(reason.conflict ? _(' Allow/block conflict at this priority: block wins.') : '') +
			(matched.length ? _(' Matching rules: %s.').format(matched.map(rule => '#' + rule.index).join(', ')) : '') +
			(reason.uses_calendar ? _(' Calendar: %s.').format(calendarReason(reason.calendar)) : '');
	}
	default: return '';
	}
}

function personCard(view, person, applied) {
	const count = person.devices.length;
	const stateClass = !applied ? 'fc-state-unknown' : person.paused ? 'fc-state-paused' : 'fc-state-online';
	const stateText = !applied ? _('Not applied') : person.paused ? _('Blocked') : _('Allowed');
	const modes = [
		[ 'online', _('Allow always') ],
		[ 'paused', _('Block always') ],
		[ 'schedule', _('Use schedule') ]
	];
	const modeText = { online: _('Allow always'), paused: _('Block always'), schedule: _('By schedule') };

	return E('article', { 'class': 'fc-card' }, [
		E('div', {}, [
			E('h3', {}, person.name),
			E('p', { 'class': 'fc-meta' }, _('Mode: %s').format(modeText[person.mode] || _('Unknown'))),
			person.extra_until ? E('p', { 'class': 'fc-meta' },
				_('Extra time is active. Use schedule ends this override.')) : null,
			E('p', { 'class': 'fc-meta' }, [
				E('span', { 'class': `fc-state ${stateClass}` }, stateText),
				' · ',
				N_(count, '%d device', '%d devices').format(count)
			]),
			E('p', { 'class': 'fc-meta fc-reason' }, (!applied ? _('Configured decision: ') : '') + reasonText(person.reason)),
			person.next_transition_local ? E('p', { 'class': 'fc-meta' },
				_('Next change (router time): %s').format(person.next_transition_local)) : null
		]),
		E('div', { 'class': 'fc-actions' }, modes.map(([ mode, label ]) => E('button', {
			'class': 'btn cbi-button-action fc-action',
			'data-mode': mode,
			'data-person': person.id,
			'aria-pressed': '' + (person.mode === mode && !person.extra_until),
			'click': ui.createHandlerFn(view, event => view.setMode(person, mode, event.currentTarget.closest('.fc-actions')))
		}, label)).concat(person.extra_until ? [E('button', {
			'class': 'btn cbi-button-action', 'click': ui.createHandlerFn(view, event =>
				view.setMode(person, 'cancel_extra', event.currentTarget.closest('.fc-actions')))
		}, _('End extra time'))] : []))
	]);
}

return view.extend({
	load: function() {
		return callStatus().then(data => {
			if (!data.ok) throw new Error(data.message || _('Unable to load family controls.'));
			return data;
		});
	},

	setMode: function(person, mode, controls) {
		if (controls.getAttribute('aria-busy') === 'true')
			return Promise.resolve();
		controls.setAttribute('aria-busy', 'true');
		this.refreshRevision = (this.refreshRevision || 0) + 1;
		const buttons = controls.querySelectorAll('button');
		for (const button of buttons) button.disabled = true;
		return (mode === 'cancel_extra' ? callCancelExtra(person.id) : callSetMode(person.id, mode)).then(result => {
			if (!result.ok)
				throw new Error(result.message || _('Unable to update access'));

			const messages = {
				online: _('%s: internet is always allowed until the mode changes.'),
				paused: _('%s: internet is always blocked until the mode changes.'),
				schedule: _('%s: automatic schedule control restored.'),
				cancel_extra: _('%s: extra time ended; original mode restored.')
			};
			ui.addNotification(null, E('p', {}, messages[mode].format(person.name)));

			return this.refresh();
		}).catch(error => {
			ui.addNotification(_('Access change failed'), E('p', {}, error.message), 'error');
		}).finally(() => {
			controls.removeAttribute('aria-busy');
			for (const button of buttons) button.disabled = false;
		});
	},

	refresh: function() {
		const revision = this.refreshRevision = (this.refreshRevision || 0) + 1;
		return this.load().then(data => {
			if (revision !== this.refreshRevision) return;
			const focused = document.activeElement?.dataset.mode;
			const person = document.activeElement?.dataset.person;
			dom.content(document.querySelector('.fc-content'), this.people(data));
			if (focused) Array.from(document.querySelectorAll('.fc-action')).find(button =>
				button.dataset.mode === focused && button.dataset.person === person)?.focus({preventScroll: true});
		}).catch(error => {
			if (revision !== this.refreshRevision) return;
			const state = document.querySelector('.fc-refreshed');
			if (state) state.textContent = _('State unconfirmed: %s').format(error.message);
			for (const node of document.querySelectorAll('.fc-state')) {
				node.textContent = _('State unconfirmed');
				node.className = 'fc-state fc-state-unknown';
			}
			this.refreshDue = Date.now() + 5000;
		});
	},

	people: function(data) {
		if (!data.ok)
			return E('div', { 'class': 'alert-message error' },
				data.message || _('Unable to load family controls.'));

		const next = data.people.map(person => person.next_transition).filter(value => value > (data.router_now || Date.now() / 1000));
		this.refreshDue = Date.now() + (next.length ? Math.min(30, Math.max(.25,
			Math.min(...next) - (data.router_now || Date.now() / 1000) + .25)) : 30) * 1000;
		const content = !data.people.length
			? E('div', { 'class': 'fc-empty' }, [
				E('h3', {}, _('No people yet')),
				E('p', {}, _('Add a person and assign their devices in the Family Control app.')),
				E('a', {
					'class': 'btn cbi-button-action',
					'href': '/family/'
				}, _('Add people'))
			])
			: E('div', { 'class': 'fc-grid' },
				data.people.map(person => personCard(this, person, data.enforcement?.ok)));

		return E('div', {}, [
			E('p', { 'class': 'fc-refreshed', 'role': 'status' },
				_('Last successful update: %s').format(data.router_now_local || '')),
			!data.enforcement?.ok ? E('div', { 'class': 'alert-message error' },
				data.enforcement?.message || _('Device restrictions are not applied.')) : null,
			data.enabled === false ? E('div', { 'class': 'alert-message warning' },
				_('Family Control is disabled.')) : null,
			content,
			data.people.length ? E('p', {}, E('a', { 'href': '/family/' },
				_('Manage people, devices and schedules'))) : null
		]);
	},

	render: function(data) {
		poll.add(() => Date.now() >= this.refreshDue && !document.querySelector('.fc-actions[aria-busy="true"]')
			? this.refresh() : Promise.resolve(), 1);
		return E('div', { 'class': 'fc-shell' }, [
			styles(),
			E('div', { 'class': 'fc-heading' }, [
				E('h2', {}, _('Family Control')),
				E('p', {}, _('Allow always and Block always override schedules until you change the mode. Use schedule restores automatic control.'))
			]),
			E('div', { 'class': 'fc-content' }, this.people(data))
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
