// SPDX-License-Identifier: GPL-3.0-or-later
// Requires an existing Playwright development installation; no router dependency.
/* global __dirname, process, console, sessionStorage, document, innerWidth, setTimeout */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { URL } = require('node:url');
const { chromium } = require('playwright');

const root = process.env.FAMILYCONTROL_ROOT || path.resolve(__dirname, '..', 'luci-app-familycontrol');
const person = () => ({
	id: 'alice', name: 'Alice', paused: false, mode: 'online', extra_until: 0,
	reason: {code: 'manual_allow', online: true},
	school_schedule: '1'.repeat(48), dayoff_schedule: '1'.repeat(48),
	school_night_cutoff: 1320, dayoff_night_cutoff: 1320,
	schedule_format: 'windows', schedule_policy: 'allow',
	windows: [{repeat: 'weekly', days: [1, 2, 3, 4, 5], start: '19:30:00', end: '20:15:30'}],
	devices: [{ id: 'phone', name: 'Phone', mac: '02:00:00:00:00:02', connected: true }]
});
let state = { ok: true, enabled: true, people: [person()], calendar: {},
	router_now_local: '2026-10-23 18:00:00', router_timezone: 'Asia/Shanghai',
	router_now: Date.parse('2026-10-23T18:00:00+08:00') / 1000,
	enforcement: { ok: true } };
let rejectNext = false;
let savedSchedule;
let previewFixture;
let calls = [];
let delayNext = 0;
let failStatus = false, failDevices = false;
const routerLocal = epoch => new Date((epoch + 8 * 3600) * 1000).toISOString().slice(0, 19).replace('T', ' ');
const candidates = [
	{mac: '02:00:00:00:00:03', hostname: 'Static tablet', ip: '192.0.2.3', sources: ['static']},
	{mac: '02:00:00:00:00:04', hostname: 'Dynamic tablet', ip: '192.0.2.4', sources: ['lease']}
];
const component = fs.readFileSync(path.join(root,
	'htdocs/luci-static/resources/view/familycontrol/overview.js'), 'utf8');
const chinese = JSON.parse(fs.readFileSync(path.join(root, 'root/www/family/messages.zh-CN.json'), 'utf8'));
const harness = `
<!doctype html><html><head><meta charset="utf-8"></head><body><script>
String.prototype.format = function(...args) { let i=0; return this.replace(/%[ds]/g,()=>args[i++]); };
window._ = value => location.search.includes('lang=zh') ? (${JSON.stringify(chinese)})[value] || value : value;
window.N_ = (count, one, many) => window._(count===1 ? one : many);
window.poll = { add: fn => { window.pollRefresh = fn; } };
window.E = (tag, attrs, children) => {
 const element = document.createElement(tag);
 for (const [key,value] of Object.entries(attrs || {})) {
  if (key === 'click') element.addEventListener('click',value);
  else if (value != null) element.setAttribute(key,value);
 }
 for (const child of [children].flat(Infinity)) {
  if (child != null) element.append(child instanceof Node ? child : String(child));
 }
 return element;
};
window.dom = { content: (target, content) => target.replaceChildren(content) };
window.ui = {
 createHandlerFn: (ctx, fn) => (...args) => fn.apply(ctx,args),
 addNotification: (title,node) => {
  const notice = document.createElement('aside'); notice.append(node); document.body.append(notice);
 }
};
window.rpc = { declare: spec => async (...values) => {
 const args = Object.fromEntries((spec.params || []).map((key,i)=>[key,values[i]]));
 const response = await fetch('/ubus',{method:'POST',body:JSON.stringify({params:['session','familycontrol',spec.method,args]})});
 return (await response.json()).result[1];
}};
window.view = { extend: value => value };
const controller = (function() { ${component} })();
window.testController = controller;
controller.load().then(data=>document.body.append(controller.render(data)));
</script></body></html>`;

const server = http.createServer(async (request, response) => {
	const pathname = request.url.split('?')[0];
	if (request.method === 'POST') {
		let body = '';
		for await (const chunk of request) body += chunk;
		const params = JSON.parse(body).params;
		const method = params[2], args = params[3] || {};
		calls.push({ method, args });
		let reply;
		if (method === 'login' && params[1] === 'session')
			reply = {ubus_rpc_session: 'synthetic-session'};
		else if (method === 'status') reply = failStatus ? {ok: false, message: 'Synthetic status failure'} : state;
		else if (method === 'devices') reply = failDevices ? {ok: false, message: 'Synthetic discovery failure'} : { ok: true, devices: candidates };
		else if (method === 'preview_schedule' && !rejectNext) {
			const online = args.windows[0]?.action !== 'block';
			const inspected = args.at_epoch || Date.parse((args.at_local || state.router_now_local.replace(' ', 'T')) + '+08:00') / 1000;
			const end = Date.parse('2026-10-25T20:15:30+08:00') / 1000;
			reply = {ok: true, inspected, inspected_local: routerLocal(inspected),
				online, reason: {code: 'schedule', policy: args.policy || 'allow', online,
					priority: args.windows[0]?.priority || 0, winning_rules: [1],
					matched_rules: [{index: 1, date: '2026-10-23'}]},
				next_transition_local: '2026-10-25 20:15:30', preview_end_local: '2026-10-30 19:30:00',
				segments: [
					{start: inspected, end, start_local: routerLocal(inspected), end_local: '2026-10-25 20:15:30', online},
					{start: end, end: inspected + 7 * 86400, start_local: '2026-10-25 20:15:30',
						end_local: routerLocal(inspected + 7 * 86400), online: !online}
				], truncated: true, diagnostics: {warnings: []},
				timeline_days: Array.from({length: 8}, (_, day) => {
					const start = Math.floor((inspected + 8 * 3600) / 86400) * 86400 - 8 * 3600 + day * 86400;
					return {date: routerLocal(start).slice(0, 10), start, end: start + 86400};
				})};
			if (previewFixture) Object.assign(reply, previewFixture);
		}
		else if (method === 'preview_extra' || method === 'add_extra') {
			const from = state.people[0].extra_until || Date.parse('2026-10-23T18:00:00+08:00') / 1000;
			const until = args.until_local ? Date.parse(args.until_local + '+08:00') / 1000 : from + args.minutes * 60;
			const local = value => new Date((value + 8 * 3600) * 1000).toISOString().slice(0, 19).replace('T', ' ');
			reply = {ok: true, from, from_local: local(from), extra_until: until, extra_until_local: local(until)};
			if (method === 'add_extra')
				Object.assign(state.people[0], {extra_until: until, extra_until_local: local(until),
					paused: false, reason: {code: 'extra', online: true}});
		}
		else if (method === 'set_extra_until') {
			const until = Date.parse(args.until_local + '+08:00') / 1000;
			Object.assign(state.people[0], {extra_until: until, extra_until_local: args.until_local.replace('T', ' '),
				paused: false, reason: {code: 'extra', online: true}});
			reply = {ok: true, extra_until: until, extra_until_local: args.until_local.replace('T', ' ')};
		}
		else if (method === 'cancel_extra') {
			state.people[0].extra_until = 0;
			state.people[0].paused = state.people[0].mode === 'paused';
			state.people[0].reason = {code: state.people[0].paused ? 'manual_block' : 'manual_allow', online: !state.people[0].paused};
			reply = {ok: true, resume_mode: state.people[0].mode};
		}
		else if (rejectNext) {
			rejectNext = false;
			reply = { ok: false, message: 'Synthetic firewall failure' };
		}
		else if (method === 'save_schedule') {
			savedSchedule = args;
			if (args.windows?.some(window => window.repeat === 'weekly' && !window.days.length))
				reply = {ok: false, message: 'Choose at least one weekday'};
			else {
				Object.assign(state.people[0], {
					schedule_format: args.format, schedule_policy: args.policy,
					windows: args.windows || []
				});
				if (args.activate) Object.assign(state.people[0], {mode: 'schedule', extra_until: 0});
				reply = { ok: true };
			}
		}
		else if (method === 'save_person') {
			if (args.person)
				state.people.find(person => person.id === args.person).name = args.name;
			else state.people.push({...person(), id: 'bob', name: args.name, devices: []});
			reply = {ok: true};
		}
		else if (method === 'save_device') {
			for (const person of state.people)
				person.devices = person.devices.filter(device => device.id !== args.device);
			state.people.find(person => person.id === args.person).devices.push({
				id: args.device || 'tablet', name: args.name, mac: args.mac, connected: false
			});
			reply = {ok: true};
		}
		else if (method === 'delete_device') {
			for (const person of state.people)
				person.devices = person.devices.filter(device => device.id !== args.device);
			reply = {ok: true};
		}
		else if (method === 'delete_person') {
			state.people = state.people.filter(person => person.id !== args.person);
			reply = {ok: true};
		}
		else if (method === 'save_calendar') {
			state.calendar = args;
			reply = {ok: true};
		}
		else {
			state.people[0].paused = method === 'set_paused' ? args.paused : args.mode === 'paused';
			state.people[0].mode = method === 'set_mode' ? args.mode : state.people[0].paused ? 'paused' : 'online';
			state.people[0].reason = {code: state.people[0].mode === 'online' ? 'manual_allow'
				: state.people[0].mode === 'paused' ? 'manual_block' : 'schedule',
			online: !state.people[0].paused, policy: 'allow', matched_rules: []};
			reply = { ok: true };
		}
		if (delayNext && method !== 'status' && method !== 'devices') {
			const delay = delayNext;
			delayNext = 0;
			await new Promise(resolve => setTimeout(resolve, delay));
		}
		response.setHeader('Content-Type', 'application/json');
		response.end(JSON.stringify({ result: [0, reply] }));
		return;
	}
	if (pathname === '/luci-component/') {
		response.setHeader('Content-Type', 'text/html');
		response.end(harness);
		return;
	}
	const file = ['app.js', 'i18n.js', 'messages.zh-CN.json'].find(file => pathname === '/family/' + file) || 'index.html';
	response.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.json') ? 'application/json' : 'text/html');
	response.end(fs.readFileSync(path.join(root, 'root/www/family', file)));
});

(async () => {
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const browser = await chromium.launch({
		headless: true,
		...(process.env.FAMILYCONTROL_BROWSER ? { executablePath: process.env.FAMILYCONTROL_BROWSER } : {})
	});
	try {
		const page = await browser.newPage({viewport: {width: 1280, height: 900}, timezoneId: 'America/Los_Angeles'});
		page.setDefaultTimeout(6000);
		const errors = [];
		const nativeDialogs = [];
		page.on('pageerror', error => errors.push(error.message));
		page.on('dialog', async dialog => {
			nativeDialogs.push(dialog.type());
			await dialog.dismiss();
		});
		await page.addInitScript(() => sessionStorage.setItem('familycontrol-session', 'synthetic-session'));
		const base = `http://127.0.0.1:${server.address().port}`;
		const loginPage = await browser.newPage();
		loginPage.on('pageerror', error => errors.push(error.message));
		await loginPage.goto(base + '/family/');
		await loginPage.locator('#login-form').waitFor();
		assert.equal(await loginPage.locator('#login-form').getAttribute('method'), 'post');
		assert.equal(await loginPage.locator('#username').getAttribute('name'), 'username');
		assert.equal(await loginPage.locator('#password').getAttribute('name'), 'password');
		assert.equal(await loginPage.locator('#username').getAttribute('autocomplete'), 'username');
		assert.equal(await loginPage.locator('#password').getAttribute('autocomplete'), 'current-password');
		assert.equal(await loginPage.locator('#username').inputValue(), '', 'no default username overrides a saved identity');
		await loginPage.locator('#username').fill('saved-synthetic-user');
		await loginPage.locator('#password').fill('synthetic-test-password');
		assert.deepEqual(await loginPage.locator('#login-form').evaluate(form =>
			Object.fromEntries(new globalThis.FormData(form))), {
			username: 'saved-synthetic-user', password: 'synthetic-test-password'
		});
		await loginPage.getByRole('button', {name: 'Sign in', exact: true}).click();
		await loginPage.getByRole('button', {name: 'Edit schedule', exact: true}).waitFor();
		assert.deepEqual(calls.find(call => call.method === 'login').args, {
			username: 'saved-synthetic-user', password: 'synthetic-test-password'
		});
		await loginPage.close();
		const screenshot = async name => {
			if (!process.env.FAMILYCONTROL_SCREENSHOT_DIR) return;
			fs.mkdirSync(process.env.FAMILYCONTROL_SCREENSHOT_DIR, {recursive: true});
			await page.screenshot({path: path.join(process.env.FAMILYCONTROL_SCREENSHOT_DIR, name + '.png'), fullPage: true});
		};
		const cancelEditor = async id => {
			await page.locator(`#${id} .cancel`).click();
			if (await page.locator('#discard-dialog').isVisible())
				await page.locator('#discard-changes').click();
			await page.locator('#' + id).waitFor({state: 'hidden'});
		};
		await page.goto(base + '/family/');
		await page.getByText('Control scope: this device (INPUT)', {exact: true}).waitFor();
		await page.getByRole('button', { name: 'Edit schedule', exact: true }).waitFor();
		await page.getByText('Mode: Allow always', {exact: true}).waitFor();
		await page.locator('.access-reason').getByText('Allowed by the manual Allow always mode.', {exact: true}).waitFor();
		await screenshot('standalone-desktop');
		await page.getByRole('button', { name: 'Block always', exact: true }).click();
		await page.locator('#people .paused').waitFor();
		await page.getByRole('button', { name: 'Allow always', exact: true }).click();
		await page.locator('#people .online').waitFor();
		await page.getByRole('button', { name: 'Use schedule', exact: true }).click();
		await page.getByText('Mode: By schedule', {exact: true}).waitFor();
		assert.equal(state.people[0].mode, 'schedule');
		await page.getByRole('button', { name: 'Allow always', exact: true }).click();
		await page.getByRole('button', {name: 'Edit schedule', exact: true}).click();
		await page.locator('#schedule-policy').selectOption('block');
		assert.equal(await page.locator('.window-action').inputValue(), 'allow',
			'changing default does not flip existing rule actions');
		await page.locator('.window-action').selectOption('block');
		assert.equal(await page.locator('.window-start').getAttribute('step'), '1');
		await page.locator('.window-start').fill('22:00:01');
		await page.locator('.window-end').fill('02:00:03');
		for (const input of await page.locator('.window-days input').all())
			await input.uncheck();
		await page.locator('.window-days input[value="5"]').check();
		await page.setViewportSize({width: 390, height: 844});
		assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
		if (process.env.FAMILYCONTROL_SCREENSHOT)
			await page.screenshot({path: process.env.FAMILYCONTROL_SCREENSHOT, fullPage: true});
		await page.getByRole('button', {name: 'Save schedule', exact: true}).click();
		await page.locator('#schedule-dialog').waitFor({state: 'hidden'});
		assert.equal(savedSchedule.policy, 'block');
		assert.equal(savedSchedule.activate, false);
		assert.equal(state.people[0].mode, 'online');
		assert.deepEqual(savedSchedule.windows[0], {repeat: 'weekly', days: [5], date: '',
			start: '22:00:01', end: '02:00:03', all_day: false, action: 'block', priority: 0, name: '', enabled: true});
		await page.getByRole('button', {name: 'Edit schedule', exact: true}).click();
		assert.equal(await page.locator('.window-end').inputValue(), '02:00:03');
		await page.getByRole('button', {name: 'Add time window', exact: true}).click();
		const once = page.locator('.time-window').last();
		await once.locator('.window-repeat').selectOption('once');
		await once.locator('.window-date').fill('2026-12-25');
		await once.locator('.window-all-day').check();
		await page.getByRole('button', {name: 'Save and use schedule', exact: true}).click();
		await page.locator('#schedule-dialog').waitFor({state: 'hidden'});
		assert.equal(savedSchedule.windows[1].date, '2026-12-25');
		assert.equal(savedSchedule.windows[1].all_day, true);
		assert.equal(savedSchedule.activate, true);
		assert.equal(state.people[0].mode, 'schedule');
		await page.getByText('Mode: By schedule', {exact: true}).waitFor();
		await page.getByRole('button', {name: 'Edit schedule', exact: true}).click();
		await page.locator('.window-repeat').first().selectOption('weekly');
		for (const input of await page.locator('.time-window').first().locator('.window-days input').all())
			await input.uncheck();
		await page.getByRole('button', {name: 'Save schedule', exact: true}).click();
		const formError = page.locator('#schedule-dialog .form-error');
		await formError.getByText('Choose at least one weekday', {exact: true}).waitFor();
		assert(await formError.evaluate(node => node === document.activeElement));
		assert.equal(await page.locator('#schedule-dialog[open]').count(), 1);
		assert.equal(await page.locator('#error').innerText(), '');
		await screenshot('schedule-error-mobile');
		await cancelEditor('schedule-dialog');
		await page.getByRole('button', {name: 'Edit schedule', exact: true}).click();
		const firstRange = page.locator('.time-window').first();
		await firstRange.locator('.window-repeat').selectOption('range');
		await firstRange.locator('.window-first-date').fill('2026-10-23');
		await firstRange.locator('.window-last-date').fill('2026-10-25');
		await firstRange.locator('.window-start').fill('19:30:00');
		await firstRange.locator('.window-end').fill('20:15:30');
		await page.locator('#schedule-preview-panel summary').click();
		await page.locator('#schedule-preview-time').fill('2026-10-23T19:30');
		const savedBeforePreview = JSON.stringify(state.people);
		const savesBeforePreview = calls.filter(call => call.method === 'save_schedule').length;
		await page.getByRole('button', {name: 'Preview next 7 days'}).click();
		await page.locator('#schedule-preview-summary').filter({hasText: 'Matching rules: #1'}).waitFor();
		assert((await page.locator('#schedule-preview-summary').innerText()).includes('2026-10-23 19:30:00'));
		assert.equal(calls.filter(call => call.method === 'preview_schedule').at(-1).args.at_local, '2026-10-23T19:30:00');
		assert.equal(calls.filter(call => call.method === 'save_schedule').length, savesBeforePreview);
		assert.equal(JSON.stringify(state.people), savedBeforePreview);
		assert.equal(await page.locator('.preview-segments li').count(), 2);
		await page.getByText('Showing the first 32 intervals only.', {exact: false}).waitFor();
		await screenshot('schedule-preview-mobile');
		delayNext = 250;
		const staleResponse = page.waitForResponse(response => response.request().postData()?.includes('"preview_schedule"'));
		await page.getByRole('button', {name: 'Preview next 7 days'}).click();
		await page.locator('#schedule-preview-time').fill('2026-10-24T08:00');
		await page.locator('#schedule-preview-summary').getByText('Draft changed. Preview again to see the updated result.').waitFor();
		await page.getByRole('button', {name: 'Preview next 7 days'}).click();
		await page.locator('#schedule-preview-summary').filter({hasText: '2026-10-24 08:00:00'}).waitFor();
		await (await staleResponse).finished();
		await page.waitForLoadState('networkidle');
		assert((await page.locator('#schedule-preview-summary').innerText()).includes('2026-10-24 08:00:00'));
		await firstRange.locator('.window-start').fill('19:30:01');
		assert.equal(await page.locator('.preview-segments li').count(), 0);
		await firstRange.locator('.window-start').fill('19:30:00');
		rejectNext = true;
		await page.getByRole('button', {name: 'Preview next 7 days'}).click();
		await page.locator('#schedule-dialog .form-error').getByText('Synthetic firewall failure', {exact: true}).waitFor();
		assert.equal(JSON.stringify(state.people), savedBeforePreview);
		assert.equal(calls.filter(call => call.method === 'save_schedule').length, savesBeforePreview);
		await screenshot('continuous-range-mobile');
		await page.getByRole('button', {name: 'Save schedule', exact: true}).click();
		await page.locator('#schedule-dialog').waitFor({state: 'hidden'});
		assert.equal(savedSchedule.windows[0].repeat, 'range');
		assert.equal(savedSchedule.windows[0].start_date, '2026-10-23');
		assert.equal(savedSchedule.windows[0].end_date, '2026-10-25');
		assert.equal(savedSchedule.windows[0].start, '19:30:00');
		await page.getByRole('button', {name: 'Edit schedule', exact: true}).click();
		await firstRange.locator('.window-all-day').check();
		assert(await firstRange.locator('.window-first-date').isVisible());
		assert(!(await firstRange.locator('.window-start').isVisible()));
		await page.getByRole('button', {name: 'Save schedule', exact: true}).click();
		await page.locator('#schedule-dialog').waitFor({state: 'hidden'});
		assert.equal(savedSchedule.windows[0].all_day, true);
		await page.getByRole('button', {name: 'Edit schedule', exact: true}).click();
		await page.getByRole('button', {name: 'Add exception', exact: true}).click();
		const exception = page.locator('.time-window').last();
		assert.equal(await exception.locator('.window-repeat').inputValue(), 'range');
		assert.equal(await exception.locator('.window-action').inputValue(), 'allow');
		assert.equal(await exception.locator('.window-priority').inputValue(), '10');
		assert(await exception.locator('.window-all-day').isChecked());
		await exception.locator('.window-priority').fill('20');
		await exception.locator('.window-first-date').fill('2026-10-23');
		await exception.locator('.window-last-date').fill('2026-10-25');
		await page.locator('#schedule-preview-time').fill('2026-10-23T19:30:01');
		previewFixture = {online: true, reason: {code: 'schedule', online: true, priority: 20,
			winning_rules: [3], matched_rules: [{index: 1, date: '2026-10-23', action: 'block', priority: 0},
				{index: 3, date: '2026-10-23', action: 'allow', priority: 20}]}};
		await page.getByRole('button', {name: 'Preview next 7 days'}).click();
		await page.locator('#schedule-preview-summary').filter({hasText: 'Allowed by deciding rules #3'}).waitFor();
		assert((await page.locator('#schedule-preview-summary').innerText()).includes('priority 20'));
		await screenshot('priority-exception-mobile');
		await exception.locator('.window-priority').fill('0');
		previewFixture = {online: false, reason: {...previewFixture.reason, online: false, priority: 0,
			winning_rules: [1], conflict: true,
			matched_rules: previewFixture.reason.matched_rules.map(rule => ({...rule, priority: 0}))}};
		await page.getByRole('button', {name: 'Preview next 7 days'}).click();
		await page.locator('#schedule-preview-summary').filter({hasText: 'Allow/block conflict at this priority: block wins.'}).waitFor();
		await exception.locator('.window-priority').fill('20');
		await page.getByRole('button', {name: 'Save and use schedule', exact: true}).click();
		await page.locator('#schedule-dialog').waitFor({state: 'hidden'});
		assert.equal(savedSchedule.windows[2].action, 'allow');
		assert.equal(savedSchedule.windows[2].priority, 20);
		await page.getByRole('button', {name: 'Edit schedule', exact: true}).click();
		assert.equal(await exception.locator('.window-priority').inputValue(), '20');
		await cancelEditor('schedule-dialog');
		state.people[0].reason = {code: 'schedule', online: true, priority: 20, winning_rules: [3],
			matched_rules: [{index: 1, date: '2026-10-23', action: 'block', priority: 0},
				{index: 3, date: '2026-10-23', action: 'allow', priority: 20}]};
		await page.reload();
		await page.locator('.access-reason').filter({hasText: 'Allowed by deciding rules #3'}).waitFor();
		assert((await page.locator('.access-reason').innerText()).includes('priority 20'));
		previewFixture = undefined;
		state.people[0].schedule_format = 'legacy';
		await page.reload();
		await page.getByRole('button', {name: 'Edit schedule', exact: true}).click();
		assert.equal(await page.locator('#schedule-format').inputValue(), 'legacy');
		await page.getByRole('button', {name: 'Save schedule', exact: true}).click();
		await page.locator('#schedule-dialog').waitFor({state: 'hidden'});
		assert.equal(savedSchedule.format, 'legacy');
		assert.equal(savedSchedule.windows, undefined);
		rejectNext = true;
		await page.getByRole('button', { name: 'Block always', exact: true }).click();
		await page.getByText('Synthetic firewall failure', { exact: true }).waitFor();
		assert.equal(await page.locator('#people .online').count(), 1);
		await page.getByText('Extra time', {exact: true}).click();
		await page.getByRole('button', {name: 'Custom extra time', exact: true}).click();
		await page.locator('#extra-hours').fill('1');
		await page.locator('#extra-minutes').fill('7');
		await page.locator('#extra-preview').filter({hasText: 'Add 67 minutes'}).waitFor();
		assert((await page.locator('#extra-preview').innerText()).includes('2026-10-23 19:07:00'));
		assert((await page.locator('#router-clock').innerText()).includes('Asia/Shanghai'));
		await page.locator('#extra-hours').fill('24');
		await page.locator('#extra-minutes').fill('1');
		await page.getByRole('button', {name: 'Add extra time', exact: true}).click();
		await page.locator('#extra-dialog .form-error').getByText('Enter a duration from 1 minute to 24 hours.').waitFor();
		assert.equal(calls.filter(call => call.method === 'add_extra').length, 0);
		await page.locator('#extra-hours').fill('1');
		await page.locator('#extra-minutes').fill('7');
		await page.locator('#extra-preview').filter({hasText: 'Add 67 minutes'}).waitFor();
		await screenshot('custom-extra-mobile');
		await page.getByRole('button', {name: 'Add extra time', exact: true}).click();
		await page.locator('#extra-dialog').waitFor({state: 'hidden'});
		assert.equal(calls.filter(call => call.method === 'add_extra').at(-1).args.minutes, 67);
		assert((await page.locator('#notice').innerText()).includes('2026-10-23 19:07:00'));
		await page.getByText('Extra time', {exact: true}).click();
		await page.getByRole('button', {name: 'Add 15 minutes', exact: true}).click();
		assert.equal(calls.filter(call => call.method === 'add_extra').at(-1).args.minutes, 15);
		await page.getByRole('button', {name: 'Add device', exact: true}).click();
		assert((await page.locator('#device-choice').innerText()).includes('Static DHCP'));
		await page.locator('#device-choice').selectOption('02:00:00:00:00:03');
		await page.locator('#device-dialog').getByRole('button', {name: 'Save', exact: true}).click();
		await page.locator('#device-dialog').waitFor({state: 'hidden'});
		await page.getByText('Static tablet', {exact: true}).waitFor();
		const tabletRemove = page.locator('[data-action="delete-device"][data-id="tablet"]');
		await tabletRemove.click();
		await page.getByRole('heading', {name: 'Remove Static tablet?', exact: true}).waitFor();
		await screenshot('delete-device-mobile');
		assert((await page.locator('#confirm-message').innerText()).includes('02:00:00:00:00:03'));
		const deleteCount = calls.filter(call => call.method === 'delete_device').length;
		await page.locator('#confirm-dialog .cancel').click();
		assert.equal(calls.filter(call => call.method === 'delete_device').length, deleteCount);
		await tabletRemove.click();
		rejectNext = true;
		await page.getByRole('button', {name: 'Remove device', exact: true}).click();
		await page.locator('#confirm-dialog .form-error').getByText('Synthetic firewall failure').waitFor();
		assert(state.people[0].devices.some(device => device.id === 'tablet'));
		delayNext = 500;
		const confirm = page.getByRole('button', {name: 'Remove device', exact: true});
		await confirm.click();
		assert(await confirm.isDisabled());
		await page.keyboard.press('Escape');
		assert.equal(await page.locator('#confirm-dialog[open]').count(), 1);
		// Even a synthetic duplicate submit cannot send a second mutation.
		await page.locator('#confirm-form').dispatchEvent('submit');
		await page.locator('#confirm-dialog').waitFor({state: 'hidden'});
		assert.equal(calls.filter(call => call.method === 'delete_device').length, deleteCount + 2);

		await page.getByRole('button', {name: 'Add person', exact: true}).click();
		await page.locator('#person-name').fill('Bob');
		await page.locator('#person-dialog').getByRole('button', {name: 'Save', exact: true}).click();
		await page.locator('#person-dialog').waitFor({state: 'hidden'});
		await page.locator('[data-action="edit-device"][data-id="phone"]').click();
		await page.locator('#device-person').selectOption('bob');
		await page.locator('#device-dialog').getByRole('button', {name: 'Save', exact: true}).click();
		await page.locator('#device-dialog').waitFor({state: 'hidden'});
		assert.equal(state.people[0].devices.length, 0);
		assert.equal(state.people[1].devices[0].id, 'phone');
		assert.equal(calls.filter(call => call.method === 'save_device').at(-1).args.person, 'bob');
		await page.locator('[data-action="delete-person"][data-id="bob"]').click();
		assert((await page.locator('#confirm-message').innerText()).includes('Bob and 1 device assignment'));
		const personDeleteCount = calls.filter(call => call.method === 'delete_person').length;
		await page.locator('#confirm-dialog .cancel').click();
		assert.equal(calls.filter(call => call.method === 'delete_person').length, personDeleteCount);
		await page.locator('[data-action="delete-person"][data-id="bob"]').click();
		await page.getByRole('button', {name: 'Delete person', exact: true}).click();
		await page.locator('#confirm-dialog').waitFor({state: 'hidden'});
		assert.equal(calls.filter(call => call.method === 'delete_person').length, personDeleteCount + 1);
		assert.equal(state.people.length, 1);
		state.people[0].schedule_format = 'windows';
		state.people[0].windows = [{repeat: 'weekly', days: [1], start: '12:00:00', end: '13:00:00'}];
		await page.reload();
		await page.getByRole('button', {name: 'School / day-off dates', exact: true}).click();
		assert((await page.locator('#calendar-usage').innerText()).includes('No saved schedule'));
		await page.locator('#calendar-month').fill('2026-12');
		await page.locator('#calendar-month').dispatchEvent('change');
		await page.locator('[data-calendar-date="2026-12-23"]').click();
		await page.getByRole('button', {name: 'Apply to selected dates', exact: true}).click();
		assert((await page.locator('#calendar-dirty').innerText()).includes('Unsaved date changes: 1'));
		await cancelEditor('calendar-dialog');
		await page.getByRole('button', {name: 'School / day-off dates', exact: true}).click();
		assert.equal(await page.locator('.calendar-grid .override').count(), 0);
		await page.getByText('Apply a date range', {exact: true}).click();
		await page.locator('#exception-date').fill('2026-12-25');
		await page.locator('#exception-end').fill('2026-12-27');
		await page.getByRole('button', {name: 'Apply date range', exact: true}).click();
		await page.locator('#calendar-month').fill('2026-12');
		await page.locator('#calendar-month').dispatchEvent('change');
		await page.locator('[data-calendar-date="2026-12-26"]').click();
		await page.locator('#exception-kind').selectOption('default');
		await page.getByRole('button', {name: 'Apply to selected dates', exact: true}).click();
		assert((await page.locator('[data-calendar-date="2026-12-26"]').getAttribute('aria-label')).includes('(default)'));
		await page.locator('[data-calendar-date="2026-12-25"]').focus();
		await page.keyboard.press('ArrowRight');
		assert(await page.locator('[data-calendar-date="2026-12-26"]').evaluate(node => node === document.activeElement));
		await page.keyboard.press('PageUp');
		assert.equal(await page.locator('#calendar-month').inputValue(), '2026-11');
		await page.locator('#calendar-next').click();
		assert.equal(await page.locator('#calendar-month').inputValue(), '2026-12');
		assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
		await screenshot('calendar-month-mobile');
		await page.locator('#exception-kind').selectOption('day_off');
		await page.locator('#exception-date').fill('2027-01-01');
		await page.locator('#exception-end').fill('2027-04-30');
		await page.getByRole('button', {name: 'Apply date range', exact: true}).click();
		await page.locator('#calendar-dialog .form-error').getByText('Each label supports at most 100 date overrides. No changes were applied.').waitFor();
		await page.getByRole('button', {name: 'Save calendar', exact: true}).click();
		await page.locator('#calendar-dialog').waitFor({state: 'hidden'});
		assert.deepEqual(state.calendar.day_off, ['2026-12-25', '2026-12-27']);
		state.people[0].windows[0].repeat = 'school';
		await page.reload();
		await page.getByRole('button', {name: 'School / day-off dates', exact: true}).click();
		assert((await page.locator('#calendar-usage').innerText()).includes('Alice'));
		await cancelEditor('calendar-dialog');

		state.people = [person()];
		state.enforcement = { ok: false, message: 'Rules missing' };
		await page.reload();
		await page.getByText('Rules missing', { exact: true }).waitFor();
		await page.getByText('Not applied', { exact: true }).waitFor();
		await page.locator('.access-reason').filter({hasText: 'Configured decision: Allowed by the manual'}).waitFor();
		await page.setViewportSize({ width: 390, height: 844 });
		assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
		state.enforcement = { ok: true };
		await page.goto(base + '/luci-component/');
		await page.locator('.fc-scope').getByText('Control scope: this device (INPUT)', {exact: true}).waitFor();
		const managementLink = page.getByRole('link', {name: 'Manage people, devices and schedules', exact: true});
		assert.equal(await managementLink.getAttribute('target'), '_blank');
		assert((await managementLink.getAttribute('rel')).split(/\s+/).includes('noopener'));
		const popupPromise = page.waitForEvent('popup');
		await managementLink.click();
		const popup = await popupPromise;
		await popup.waitForLoadState();
		assert(new URL(popup.url()).pathname === '/family/');
		assert.equal(await popup.evaluate(() => globalThis.opener), null);
		assert(new URL(page.url()).pathname === '/luci-component/');
		await popup.close();
		await page.locator('.fc-action[data-mode="paused"]').click();
		await page.locator('.fc-state-paused').waitFor();
		await page.locator('.fc-reason').getByText('Blocked by the manual Block always mode.', {exact: true}).waitFor();
		rejectNext = true;
		await page.locator('.fc-action[data-mode="online"]').click();
		await page.getByText('Synthetic firewall failure', { exact: true }).waitFor();
		assert.equal(await page.locator('.fc-state-paused').count(), 1);
		await page.locator('.fc-action[data-mode="schedule"]').click();
		await page.getByText('Mode: By schedule', {exact: true}).waitFor();
		assert.equal(state.people[0].mode, 'schedule');
		assert.equal(calls.filter(call => call.method === 'set_paused').length, 0);
		await screenshot('luci-modes-mobile');
		state.people[0].reason = {code: 'schedule', online: false, priority: 10, winning_rules: [2],
			conflict: true, matched_rules: [{index: 1, date: '2026-10-23', action: 'allow', priority: 10},
				{index: 2, name: 'Exam break', date: '2026-10-23', action: 'block', priority: 10}]};
		state.people[0].paused = true;
		await page.reload();
		await page.locator('.fc-reason').filter({hasText: 'Blocked by deciding rules #2'}).waitFor();
		await page.locator('.fc-reason').filter({hasText: '#2 Exam break'}).waitFor();
		await page.locator('.fc-reason').filter({hasText: 'Allow/block conflict at this priority: block wins.'}).waitFor();
		await screenshot('luci-priority-tie-mobile');
		state.enabled = false;
		state.people[0].reason = {code: 'disabled', online: true};
		state.people[0].paused = false;
		await page.reload();
		await page.locator('.fc-reason').getByText('Family Control is disabled in configuration.', {exact: true}).waitFor();
		await page.locator('.fc-enforcement').getByText('Family Control is disabled.', {exact: true}).waitFor();
		state.enforcement = { ok: false, message: 'Rules missing' };
		state.people = [];
		await page.reload();
		await page.getByText('Rules missing', { exact: true }).waitFor();
		await page.getByText('No people yet', { exact: true }).waitFor();
		assert.equal(await page.getByRole('link', {name: 'Add people', exact: true}).getAttribute('target'), '_blank');
		state = {...state, enabled: true, people: [person()], enforcement: {ok: true}};
		await page.goto(base + '/family/');
		await page.getByRole('button', {name: 'Edit schedule', exact: true}).click();
		await page.locator('.window-name').fill('Homework');
		await page.reload().catch(() => {});
		assert.deepEqual(nativeDialogs, ['beforeunload'], 'leaving a dirty editor requires browser confirmation');
		assert.equal(await page.locator('.window-name').inputValue(), 'Homework');
		await page.locator('#schedule-dialog .cancel').click();
		await page.locator('#discard-dialog').waitFor();
		await page.locator('#keep-editing').click();
		assert.equal(await page.locator('.window-name').inputValue(), 'Homework');
		await page.keyboard.press('Escape');
		await page.locator('#discard-dialog').waitFor();
		await page.locator('#discard-changes').click();
		await page.locator('#schedule-dialog').waitFor({state: 'hidden'});
		assert.equal(state.people[0].windows[0].name, undefined);

		await page.getByRole('button', {name: 'Edit schedule', exact: true}).click();
		await page.locator('.window-name').fill('Homework');
		await page.locator('.window-enabled').uncheck();
		await page.getByRole('button', {name: 'Duplicate rule', exact: true}).click();
		assert.equal(await page.locator('.time-window').count(), 2);
		assert.equal(await page.locator('.window-name').last().inputValue(), 'Homework (copy)');
		assert(!(await page.locator('.window-enabled').last().isChecked()));
		await page.locator('.window-enabled').last().check();
		await page.getByRole('button', {name: 'Save schedule', exact: true}).click();
		await page.locator('#schedule-dialog').waitFor({state: 'hidden'});
		assert.equal(savedSchedule.windows[0].enabled, false);
		assert.equal(savedSchedule.windows[1].name, 'Homework (copy)');

		await page.getByRole('button', {name: 'Block always', exact: true}).click();
		await page.getByText('Extra time', {exact: true}).click();
		await page.getByRole('button', {name: 'Custom extra time', exact: true}).click();
		await page.locator('#extra-kind').selectOption('deadline');
		await page.locator('#extra-until').fill('2026-10-23T20:30:01');
		await page.locator('#extra-preview').filter({hasText: 'Allow until 2026-10-23 20:30:01'}).waitFor();
		await page.getByRole('button', {name: 'Add extra time', exact: true}).click();
		await page.locator('#extra-dialog').waitFor({state: 'hidden'});
		assert.equal(calls.filter(call => call.method === 'set_extra_until').at(-1).args.until_local, '2026-10-23T20:30:01');
		assert.equal(state.people[0].mode, 'paused');
		await page.locator('[data-countdown]').filter({hasText: 'Estimated remaining'}).waitFor();
		await page.getByRole('button', {name: 'End extra time', exact: true}).click();
		await page.locator('.person-state').getByText('Blocked', {exact: true}).waitFor();
		assert.equal(state.people[0].extra_until, 0);
		assert.equal(state.people[0].mode, 'paused');
		await page.locator('.person-state').getByText('Blocked', {exact: true}).waitFor();

		state.people.push({...person(), id: 'bob', name: 'Bob', devices: [],
			windows: [{repeat: 'daily', all_day: true, action: 'allow', priority: 30, name: 'Borrowed', enabled: false}]});
		await page.reload();
		await page.locator('[data-action="schedule"][data-id="alice"]').click();
		await page.locator('#copy-schedule-source').selectOption('bob');
		const uCopiesBefore = calls.filter(call => call.method === 'save_schedule').length;
		await page.locator('#copy-person-schedule').click();
		assert.equal(await page.locator('.window-name').inputValue(), 'Borrowed');
		assert.equal(await page.locator('.window-priority').inputValue(), '30');
		assert.equal(await page.locator('#schedule-person').inputValue(), 'alice');
		assert.equal(calls.filter(call => call.method === 'save_schedule').length, uCopiesBefore);
		await page.getByRole('button', {name: 'Save schedule', exact: true}).click();
		await page.locator('#schedule-dialog').waitFor({state: 'hidden'});
		assert.equal(state.people[0].mode, 'paused', 'copy does not copy the source mode');
		assert.equal(state.people[0].windows[0].enabled, false);

		await page.locator('[data-action="schedule"][data-id="alice"]').click();
		await page.locator('.window-enabled').check();
		await page.locator('.window-priority').fill('10');
		await page.getByRole('button', {name: 'Duplicate rule', exact: true}).click();
		await page.locator('#add-exception-window').click();
		await page.locator('.window-repeat').last().selectOption('daily');
		await page.locator('.window-action').last().selectOption('block');
		await page.locator('#add-window').click();
		await page.locator('.window-repeat').last().selectOption('once');
		await page.locator('.window-date').last().fill('2026-10-20');
		await page.locator('.window-all-day').last().check();
		if (!(await page.locator('#schedule-preview-panel').evaluate(node => node.open)))
			await page.locator('#schedule-preview-panel summary').click();
		await page.locator('#schedule-preview-time').fill('2026-10-23T19:30:01');
		previewFixture = {online: false, reason: {code: 'schedule', online: false, priority: 10,
			winning_rules: [3], conflict: true, matched_rules: [
				{index: 1, name: 'Borrowed', date: '2026-10-23'}, {index: 2, name: 'Borrowed (copy)', date: '2026-10-23'},
				{index: 3, date: '2026-10-23'}]}, diagnostics: {warnings: [
				{code: 'duplicate', rules: [1, 2]}, {code: 'expired', rules: [4]},
				{code: 'conflict', rules: [1, 2, 3], priority: 10, at_local: '2026-10-23 19:30:01'},
				{code: 'shadowed_in_scope', rules: [1]}
			]}};
		await page.locator('#preview-schedule').click();
		await page.locator('[data-warning="shadowed_in_scope"]').waitFor();
		assert.equal(await page.locator('.schedule-diagnostics [data-warning]').count(), 4);
		assert((await page.locator('.schedule-diagnostics').innerText()).includes('Borrowed'));
		assert.equal(await page.locator('.timeline-row').count(), 8);
		assert(await page.locator('.timeline-track').first().getAttribute('aria-label'));
		assert(await page.locator('.timeline-track button').first().getAttribute('aria-label'));
		const uPreviewWrites = calls.filter(call => call.method === 'save_schedule').length;
		const uTimelineResponse = page.waitForResponse(response => response.request().postData()?.includes('"at_epoch"'));
		await page.locator('.timeline-track button').first().click({force: true});
		await uTimelineResponse;
		await page.locator('#schedule-preview-summary').filter({hasText: 'deciding rules'}).waitFor();
		assert(Number.isInteger(calls.filter(call => call.method === 'preview_schedule').at(-1).args.at_epoch));
		assert.equal(calls.filter(call => call.method === 'save_schedule').length, uPreviewWrites);
		await screenshot('diagnostics-timeline-mobile');
		await cancelEditor('schedule-dialog');
		previewFixture = undefined;

		state.people = [person()];
		await page.reload();
		failStatus = true;
		await page.locator('#refresh-now').click();
		await page.locator('.person-state').getByText('State unconfirmed', {exact: true}).waitFor();
		assert.equal(await page.locator('#people article').count(), 1, 'failed refresh preserves last known people');
		assert((await page.locator('#refresh-message').innerText()).includes('Last successful update'));
		failStatus = false;
		failDevices = true;
		await page.locator('#refresh-now').click();
		await page.locator('.person-state').getByText('Allowed', {exact: true}).waitFor();
		await page.locator('#refresh-message').filter({hasText: 'Device discovery unavailable'}).waitFor();
		failDevices = false;
		state.runtime = {last_success_local: '2026-10-23 18:00:00', last_result: {ok: true},
			last_error: {at: state.router_now - 60, at_local: '2026-10-23 17:59:00',
				message: 'Device restriction chains are not loaded'},
			events: [{at: state.router_now, at_local: '2026-10-23 18:00:00', code: 'clock_changed'}]};
		state.people[0].next_transition = state.router_now + 1;
		state.people[0].next_transition_local = '2026-10-23 18:00:01';
		const uManualRefresh = page.waitForResponse(response => response.request().postData()?.includes('"status"'));
		await page.locator('#refresh-now').click();
		await uManualRefresh;
		await page.waitForResponse(response => response.request().postData()?.includes('"status"'));
		state.people[0].next_transition = 0;
		await page.locator('#runtime-panel summary').click();
		await page.getByText('Clock correction detected', {exact: false}).waitFor();
		await page.locator('#runtime-content').getByText('Current restrictions are applied; the error below is historical.', {exact: true}).waitFor();
		await page.locator('#runtime-content').getByText('Last error (history): 2026-10-23 17:59:00 — Device restriction chains are not loaded', {exact: true}).waitFor();
		await screenshot('runtime-recovered-en');
		state.runtime.last_result = {ok: false};
		await page.locator('#refresh-now').click();
		await page.locator('#runtime-content').getByText('Latest result: Failed', {exact: true}).waitFor();
		assert.equal(await page.getByText('Current restrictions are applied; the error below is historical.', {exact: true}).count(), 0);
		state.runtime.last_result = {ok: true};
		state.enforcement = {ok: false, message: 'Device restriction chains are not loaded'};
		await page.locator('#refresh-now').click();
		await page.locator('#error').getByText('Device restriction chains are not loaded', {exact: true}).waitFor();
		assert.equal(await page.getByText('Current restrictions are applied; the error below is historical.', {exact: true}).count(), 0);
		state.enforcement = {ok: true};
		await page.locator('#refresh-now').click();
		await page.locator('#runtime-content').getByText('Current restrictions are applied; the error below is historical.', {exact: true}).waitFor();

		await page.goto(base + '/luci-component/');
		await page.locator('.fc-enforcement').getByText('Restriction rules verified', {exact: true}).waitFor();
		await page.locator('.fc-diagnostics summary').click();
		await page.locator('.fc-diagnostics').getByText('Last error (history): 2026-10-23 17:59:00 — Device restriction chains are not loaded', {exact: true}).waitFor();
		failStatus = true;
		await page.evaluate(() => { globalThis.testController.refreshDue = 0; });
		await page.evaluate(() => globalThis.pollRefresh());
		await page.locator('.fc-state').getByText('State unconfirmed', {exact: true}).waitFor();
		assert.equal(await page.locator('.fc-enforcement').innerText(), 'State unconfirmed');
		assert.equal(await page.locator('.fc-history-note').innerText(), 'State unconfirmed');
		assert((await page.locator('.fc-reason').innerText()).startsWith('Last known decision:'));
		failStatus = false;
		await page.evaluate(() => { globalThis.testController.refreshDue = 0; });
		await page.evaluate(() => globalThis.pollRefresh());
		await page.locator('.fc-state').getByText('Allowed', {exact: true}).waitFor();
		assert(await page.locator('.fc-diagnostics').evaluate(panel => panel.open));
		await page.locator('.fc-history-note').getByText('Current restrictions are applied; the error below is historical.', {exact: true}).waitFor();
		await page.locator('.fc-refresh').focus();
		await page.locator('.fc-refresh').click();
		assert(await page.locator('.fc-refresh').evaluate(button => button === document.activeElement));
		state.enforcement = {ok: false, message: 'Device restriction chains are not loaded'};
		await page.locator('.fc-refresh').click();
		await page.locator('.fc-enforcement').getByText('Device restrictions are not applied.', {exact: true}).waitFor();
		assert.equal(await page.locator('.fc-history-note').count(), 0);
		state.enforcement = {ok: true};
		state.people[0].mode = 'paused';
		state.people[0].extra_until = state.router_now + 3600;
		state.people[0].extra_until_local = '2026-10-23 19:00:00';
		await page.locator('.fc-refresh').click();
		await page.getByText('Extra time until 2026-10-23 19:00:00 (router time); then restore Block always.', {exact: true}).waitFor();
		await page.getByRole('button', {name: 'End extra time', exact: true}).click();
		await page.locator('.fc-state').getByText('Blocked', {exact: true}).waitFor();
		assert.equal(state.people[0].mode, 'paused');
		state.people = [person()];

		state.people[0].name = 'School day';
		await page.goto(base + '/family/');
		await page.locator('#ui-language').selectOption('zh-CN');
		await page.locator('html[lang="zh-CN"]').waitFor();
		await page.getByText('限制范围：路由器本机（INPUT）', {exact: true}).waitFor();
		await page.getByRole('button', {name: '编辑时段', exact: true}).waitFor();
		assert.equal(await page.locator('#people h2').innerText(), 'School day', 'user names are never translated');
		assert((await page.locator('#app > p.meta').last().innerText()).startsWith('“始终允许”和“始终禁止”'));
		assert.equal(await page.locator('.schedule-summary strong').first().innerText(), '已保存时段（未启用）:');
		await page.locator('#runtime-panel summary').click();
		await page.getByText('当前限制规则已生效；下方保留的是历史错误。', {exact: true}).waitFor();
		await page.getByText('最近错误（历史记录）：2026-10-23 17:59:00 — 未加载设备限制规则链', {exact: true}).waitFor();
		await screenshot('runtime-recovered-zh');
		assert.equal(await page.evaluate(() => globalThis.FamilyControlI18n.t('Name containing %s')), 'Name containing %s');
		await page.getByRole('button', {name: '编辑时段', exact: true}).click();
		await page.locator('.window-name').fill('考试周限制');
		await page.locator('.window-enabled').uncheck();
		await page.getByRole('button', {name: '复制此规则', exact: true}).click();
		assert((await page.locator('.window-name').last().inputValue()).includes('副本'));
		await screenshot('chinese-editor-mobile');
		await cancelEditor('schedule-dialog');
		await page.goto(base + '/luci-component/?lang=zh');
		await page.locator('.fc-scope').getByText('限制范围：路由器本机（INPUT）', {exact: true}).waitFor();
		await page.locator('.fc-action[data-mode="schedule"]').getByText('使用自动时段', {exact: true}).waitFor();
		await page.locator('.fc-enforcement').getByText('限制规则检查通过', {exact: true}).waitFor();
		await page.locator('.fc-diagnostics summary').click();
		await page.locator('.fc-diagnostics').getByText('最近错误（历史记录）：2026-10-23 17:59:00 — 未加载设备限制规则链', {exact: true}).waitFor();
		assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
		await screenshot('chinese-luci-mobile');
		assert.deepEqual(errors, []);
		assert.deepEqual(nativeDialogs, ['beforeunload']);
		console.log('PASS login identity fields/submission, separate management window, historical/current errors, and seven usability areas; existing regressions retained');
	}
	finally {
		await browser.close();
		server.close();
	}
})().catch(error => {
	console.error(error);
	server.close();
	process.exitCode = 1;
});
