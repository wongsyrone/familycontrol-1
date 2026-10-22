// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

(() => {
	let language = 'en', messages = {};
	try {
		language = globalThis.localStorage.getItem('familycontrol-language') ||
			(globalThis.navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en');
	}
	catch (_) {}
	const api = {
		language,
		t: (key, ...args) => {
			let index = 0;
			return String(messages[key] || key).replace(/%[sd]/g,
				token => index < args.length ? String(args[index++]) : token);
		},
		localize: root => {
			if (api.language !== 'zh-CN') return;
			const walker = document.createTreeWalker(root, globalThis.NodeFilter.SHOW_TEXT);
			let node;
			while ((node = walker.nextNode())) {
				if (node.parentElement?.closest('script,style,[data-user-text]')) continue;
				const value = node.textContent.trim();
				const translated = messages[value.replace(/\s+/g, ' ')];
				if (translated) node.textContent = node.textContent.replace(value, translated);
			}
			for (const element of root.querySelectorAll('[title],[placeholder],[aria-label]'))
				if (!element.closest('[data-user-text]'))
				for (const name of ['title', 'placeholder', 'aria-label']) {
					const value = element.getAttribute(name);
					if (messages[value]) element.setAttribute(name, messages[value]);
				}
		},
		setLanguage: value => {
			if (!['en', 'zh-CN'].includes(value)) return;
			try { globalThis.localStorage.setItem('familycontrol-language', value); }
			catch (_) {}
			globalThis.location.reload();
		}
	};
	api.ready = language === 'zh-CN' ? fetch(`messages.zh-CN.json?${Date.now()}`)
		.then(response => {
			if (!response.ok) throw new Error('Translations unavailable');
			return response.json();
		}).then(value => { messages = value; })
		.catch(() => { api.language = 'en'; }) : Promise.resolve();
	globalThis.FamilyControlI18n = api;
})();
