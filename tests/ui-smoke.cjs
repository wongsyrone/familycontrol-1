// SPDX-License-Identifier: GPL-3.0-or-later
// Requires an existing Playwright development installation; no router dependency.
/* global __dirname, process, console, sessionStorage, document, innerWidth, setTimeout */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const root = process.env.FAMILYCONTROL_ROOT || path.resolve(__dirname, '..', 'luci-app-familycontrol');
const person = () => ({
	id: 'alice', name: 'Alice', paused: false, mode: 'online', extra_until: 0,
	school_schedule: '1'.repeat(48), dayoff_schedule: '1'.repeat(48),
	school_night_cutoff: 1320, dayoff_night_cutoff: 1320,
	schedule_format: 'windows', schedule_policy: 'allow',
	windows: [{repeat: 'weekly', days: [1, 2, 3, 4, 5], start: '19:30:00', end: '20:15:30'}],
	devices: [{ id: 'phone', name: 'Phone', mac: '02:00:00:00:00:02', connected: true }]
});
let state = { ok: true, enabled: true, people: [person()], calendar: {},
	enforcement: { ok: true } };
let rejectNext = false;
let savedSchedule;
let calls = [];
let delayNext = 0;
const candidates = [
	{mac: '02:00:00:00:00:03', hostname: 'Static tablet', ip: '192.0.2.3', sources: ['static']},
	{mac: '02:00:00:00:00:04', hostname: 'Dynamic tablet', ip: '192.0.2.4', sources: ['lease']}
];
const component = fs.readFileSync(path.join(root,
	'htdocs/luci-static/resources/view/familycontrol/overview.js'), 'utf8');
const harness = `
<!doctype html><html><head><meta charset="utf-8"></head><body><script>
String.prototype.format = function(...args) { let i=0; return this.replace(/%[ds]/g,()=>args[i++]); };
window._ = value => value;
window.N_ = (count, one, many) => count===1 ? one : many;
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
		if (method === 'status') reply = state;
		else if (method === 'devices') reply = { ok: true, devices: candidates };
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
	const file = pathname === '/family/app.js' ? 'app.js' : 'index.html';
	response.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : 'text/html');
	response.end(fs.readFileSync(path.join(root, 'root/www/family', file)));
});

(async () => {
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const browser = await chromium.launch({
		headless: true,
		...(process.env.FAMILYCONTROL_BROWSER ? { executablePath: process.env.FAMILYCONTROL_BROWSER } : {})
	});
	try {
		const page = await browser.newPage({viewport: {width: 1280, height: 900}});
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
		const screenshot = async name => {
			if (!process.env.FAMILYCONTROL_SCREENSHOT_DIR) return;
			fs.mkdirSync(process.env.FAMILYCONTROL_SCREENSHOT_DIR, {recursive: true});
			await page.screenshot({path: path.join(process.env.FAMILYCONTROL_SCREENSHOT_DIR, name + '.png'), fullPage: true});
		};
		await page.goto(base + '/family/');
		await page.getByRole('button', { name: 'Edit schedule', exact: true }).waitFor();
		await page.getByText('Mode: Allow always', {exact: true}).waitFor();
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
			start: '22:00:01', end: '02:00:03', all_day: false});
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
		await page.locator('#schedule-dialog .cancel').click();
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
		await page.getByRole('button', {name: 'School calendar', exact: true}).click();
		await page.locator('#exception-date').fill('2026-12-25');
		await page.getByRole('button', {name: 'Add date', exact: true}).click();
		await page.getByRole('button', {name: 'Save calendar', exact: true}).click();
		await page.locator('#calendar-dialog').waitFor({state: 'hidden'});
		assert.deepEqual(state.calendar.day_off, ['2026-12-25']);

		state.people = [person()];
		state.enforcement = { ok: false, message: 'Rules missing' };
		await page.reload();
		await page.getByText('Rules missing', { exact: true }).waitFor();
		await page.getByText('Not applied', { exact: true }).waitFor();
		await page.setViewportSize({ width: 390, height: 844 });
		assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
		state.enforcement = { ok: true };
		await page.goto(base + '/luci-component/');
		await page.locator('.fc-action[data-mode="paused"]').click();
		await page.locator('.fc-state-paused').waitFor();
		rejectNext = true;
		await page.locator('.fc-action[data-mode="online"]').click();
		await page.getByText('Synthetic firewall failure', { exact: true }).waitFor();
		assert.equal(await page.locator('.fc-state-paused').count(), 1);
		await page.locator('.fc-action[data-mode="schedule"]').click();
		await page.getByText('Mode: By schedule', {exact: true}).waitFor();
		assert.equal(state.people[0].mode, 'schedule');
		assert.equal(calls.filter(call => call.method === 'set_paused').length, 0);
		await screenshot('luci-modes-mobile');
		state.enforcement = { ok: false, message: 'Rules missing' };
		state.people = [];
		await page.reload();
		await page.getByText('Rules missing', { exact: true }).waitFor();
		await page.getByText('No people yet', { exact: true }).waitFor();
		assert.deepEqual(errors, []);
		assert.deepEqual(nativeDialogs, []);
		console.log('PASS standalone and LuCI: explicit modes/editor, seconds/overnight/once/all-day, save/activate, in-dialog errors, static devices, reassignment, named deletion/cancel/failure/busy, legacy and mobile');
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
