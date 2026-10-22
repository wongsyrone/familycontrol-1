// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

import { readfile, writefile, mkdir, chmod, rename } from 'fs';

export const RUNTIME_FILE = '/var/run/familycontrol/runtime.json';

export function runtimeState() {
	try {
		const state = json(readfile(RUNTIME_FILE) || '{}');
		if (type(state) != 'object') return {};
		state.events = slice(filter(type(state.events) == 'array' ? state.events : [],
			event => type(event) == 'object' && type(event.at) == 'int'), -100);
		for (let key in ['last_success', 'last_tick', 'last_attempt', 'last_prepared'])
			if (state[key] != null && type(state[key]) != 'int') state[key] = 0;
		if (state.last_error && (type(state.last_error) != 'object' || type(state.last_error.at) != 'int'))
			state.last_error = null;
		return state;
	}
	catch (_) { return {}; }
};

export function recordRuntime(now, result, decisions, action, prepareOnly, clockChanged) {
	// Diagnostic failure must never change access control or its rollback result.
	try {
		let state = runtimeState();
		let events = type(state.events) == 'array' ? state.events : [];
		function event(code, details) {
			push(events, { at: now, code, ...details });
		}
		if (clockChanged)
			event('clock_changed', {});
		if (action != 'tick')
			event('action', { action, subject: result.person || result.device || '', ok: result.ok, mode: result.mode || '' });
		if (result.ok) {
			if (prepareOnly)
				state.last_prepared = now;
			else {
				state.last_success = now;
				if (action == 'tick') state.last_tick = now;
				const previous = type(state.decisions) == 'object' ? state.decisions : {};
				for (let person, decision in decisions)
					if (sprintf('%J', previous[person]) != sprintf('%J', decision))
						event('access_changed', { person, ...decision });
				state.decisions = decisions;
			}
		}
		else {
			const message = result.message || result.code || 'Enforcement failed';
			if (state.last_result?.ok != false || state.last_result?.message != message)
				event('error', { message, rollback_ok: result.rollback_ok });
			state.last_error = { at: now, message, rollback_ok: result.rollback_ok };
		}
		state.last_attempt = now;
		state.last_result = { ok: result.ok, message: result.message || '' };
		state.events = slice(events, -100);
		mkdir('/var/run/familycontrol', 0700);
		if (!chmod('/var/run/familycontrol', 0700) ||
		    writefile(RUNTIME_FILE + '.tmp', sprintf('%J', state)) == null ||
		    !chmod(RUNTIME_FILE + '.tmp', 0600) || !rename(RUNTIME_FILE + '.tmp', RUNTIME_FILE))
			return false;
		return true;
	}
	catch (_) { return false; }
};
