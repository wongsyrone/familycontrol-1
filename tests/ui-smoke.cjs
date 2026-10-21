// SPDX-License-Identifier: GPL-3.0-or-later
// Requires an existing Playwright development installation; no router dependency.
/* global __dirname, process, console, sessionStorage, document, innerWidth */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..', 'luci-app-familycontrol');
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
const component = fs.readFileSync(path.join(root,
	'htdocs/luci-static/resources/view/familycontrol/overview.js'), 'utf8');
const harness = `
<!doctype html><html><body><script>
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
		let reply;
		if (method === 'status') reply = state;
		else if (method === 'devices') reply = { ok: true, devices: [] };
		else if (rejectNext) {
			rejectNext = false;
			reply = { ok: false, message: 'Synthetic firewall failure' };
		}
		else if (method === 'save_schedule') {
			savedSchedule = args;
			Object.assign(state.people[0], {
				schedule_format: args.format, schedule_policy: args.policy,
				windows: args.windows || []
			});
			reply = { ok: true };
		}
		else {
			state.people[0].paused = method === 'set_paused' ? args.paused : args.mode === 'paused';
			state.people[0].mode = state.people[0].paused ? 'paused' : 'online';
			reply = { ok: true };
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
		const page = await browser.newPage();
		const errors = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.addInitScript(() => sessionStorage.setItem('familycontrol-session', 'synthetic-session'));
		const base = `http://127.0.0.1:${server.address().port}`;
		await page.goto(base + '/family/');
		await page.getByRole('button', { name: 'Pause', exact: true }).click();
		await page.locator('#people .paused').waitFor();
		await page.getByRole('button', { name: 'Online', exact: true }).click();
		await page.locator('#people .online').waitFor();
		await page.getByRole('button', {name: 'Alice', exact: true}).click();
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
		assert.deepEqual(savedSchedule.windows[0], {repeat: 'weekly', days: [5], date: '',
			start: '22:00:01', end: '02:00:03', all_day: false});
		await page.getByRole('button', {name: 'Alice', exact: true}).click();
		assert.equal(await page.locator('.window-end').inputValue(), '02:00:03');
		await page.getByRole('button', {name: 'Add time window', exact: true}).click();
		const once = page.locator('.time-window').last();
		await once.locator('.window-repeat').selectOption('once');
		await once.locator('.window-date').fill('2026-12-25');
		await once.locator('.window-all-day').check();
		await page.getByRole('button', {name: 'Save schedule', exact: true}).click();
		await page.locator('#schedule-dialog').waitFor({state: 'hidden'});
		assert.equal(savedSchedule.windows[1].date, '2026-12-25');
		assert.equal(savedSchedule.windows[1].all_day, true);
		state.people[0].schedule_format = 'legacy';
		await page.reload();
		await page.getByRole('button', {name: 'Alice', exact: true}).click();
		assert.equal(await page.locator('#schedule-format').inputValue(), 'legacy');
		await page.getByRole('button', {name: 'Save schedule', exact: true}).click();
		await page.locator('#schedule-dialog').waitFor({state: 'hidden'});
		assert.equal(savedSchedule.format, 'legacy');
		assert.equal(savedSchedule.windows, undefined);
		rejectNext = true;
		await page.getByRole('button', { name: 'Pause', exact: true }).click();
		await page.getByText('Synthetic firewall failure', { exact: true }).waitFor();
		assert.equal(await page.locator('#people .online').count(), 1);
		state.enforcement = { ok: false, message: 'Rules missing' };
		await page.reload();
		await page.getByText('Rules missing', { exact: true }).waitFor();
		await page.getByText('Not applied', { exact: true }).waitFor();
		await page.setViewportSize({ width: 390, height: 844 });
		assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
		state.enforcement = { ok: true };
		await page.goto(base + '/luci-component/');
		await page.locator('.fc-action').click();
		await page.locator('.fc-state-paused').waitFor();
		rejectNext = true;
		await page.locator('.fc-action').click();
		await page.getByText('Synthetic firewall failure', { exact: true }).waitFor();
		assert.equal(await page.locator('.fc-state-paused').count(), 1);
		state.enforcement = { ok: false, message: 'Rules missing' };
		state.people = [];
		await page.reload();
		await page.getByText('Rules missing', { exact: true }).waitFor();
		await page.getByText('No people yet', { exact: true }).waitFor();
		assert.deepEqual(errors, []);
		console.log('PASS standalone and LuCI: actions, seconds/overnight/once/all-day editing, legacy preservation, errors and mobile layout');
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
