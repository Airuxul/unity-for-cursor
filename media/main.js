// @ts-check
(function () {
	'use strict';

	const vscode = acquireVsCodeApi();

	const entriesEl = document.getElementById('entries');
	const clearBtn = document.getElementById('clear-btn');
	const autoScrollBtn = document.getElementById('autoscroll-btn');
	const filterButtons = {
		error: document.getElementById('filter-error'),
		warning: document.getElementById('filter-warning'),
		info: document.getElementById('filter-info'),
	};

	let maxEntries = 5000;
	/** @type {Array<{id:number, level:string, node:HTMLElement}>} */
	const rendered = [];
	const counts = { error: 0, warning: 0, info: 0 };
	let autoScroll = true;

	function updateCounts() {
		filterButtons.error.querySelector('.count').textContent = String(counts.error);
		filterButtons.warning.querySelector('.count').textContent = String(counts.warning);
		filterButtons.info.querySelector('.count').textContent = String(counts.info);
	}

	function buildEntryNode(entry) {
		const div = document.createElement('div');
		div.className = 'entry level-' + entry.level;
		div.setAttribute('data-entry-id', String(entry.id));

		const links = (entry.links || []).slice().sort((a, b) => a.start - b.start);
		let cursor = 0;
		const text = entry.text;

		for (const link of links) {
			if (link.start > cursor) {
				div.appendChild(document.createTextNode(text.slice(cursor, link.start)));
			}
			const span = document.createElement('span');
			span.className = 'log-link';
			span.setAttribute('data-file', link.file);
			span.setAttribute('data-line', String(link.line));
			span.textContent = text.slice(link.start, link.end);
			div.appendChild(span);
			cursor = link.end;
		}
		if (cursor < text.length) {
			div.appendChild(document.createTextNode(text.slice(cursor)));
		}

		return div;
	}

	function pruneToLimit() {
		while (rendered.length > maxEntries) {
			const old = rendered.shift();
			if (old) {
				counts[old.level] = Math.max(0, counts[old.level] - 1);
				old.node.remove();
			}
		}
	}

	function appendEntries(entries) {
		if (!entries || entries.length === 0) {
			return;
		}
		const fragment = document.createDocumentFragment();
		for (const entry of entries) {
			const node = buildEntryNode(entry);
			fragment.appendChild(node);
			rendered.push({ id: entry.id, level: entry.level, node });
			counts[entry.level] = (counts[entry.level] || 0) + 1;
		}
		entriesEl.appendChild(fragment);
		pruneToLimit();
		updateCounts();
		maybeScroll();
	}

	function updateEntry(id, appendText) {
		const item = rendered.find((r) => r.id === id);
		if (!item) {
			return;
		}
		item.node.appendChild(document.createTextNode('\n' + appendText));
		maybeScroll();
	}

	function clearAll() {
		entriesEl.innerHTML = '';
		rendered.length = 0;
		counts.error = 0;
		counts.warning = 0;
		counts.info = 0;
		updateCounts();
	}

	function maybeScroll() {
		if (autoScroll) {
			entriesEl.scrollTop = entriesEl.scrollHeight;
		}
	}

	function setAutoScroll(value) {
		autoScroll = value;
		autoScrollBtn.classList.toggle('active', autoScroll);
		autoScrollBtn.textContent = autoScroll ? '▶ 自动滚动' : '⏸ 已暂停';
		if (autoScroll) {
			maybeScroll();
		}
	}

	entriesEl.addEventListener('click', (event) => {
		const target = /** @type {HTMLElement} */ (event.target);
		const link = target.closest('.log-link');
		if (!link) {
			return;
		}
		const file = link.getAttribute('data-file');
		const line = Number(link.getAttribute('data-line'));
		vscode.postMessage({ type: 'openLocation', file, line });
	});

	entriesEl.addEventListener('scroll', () => {
		const distanceFromBottom = entriesEl.scrollHeight - entriesEl.scrollTop - entriesEl.clientHeight;
		if (distanceFromBottom > 30 && autoScroll) {
			setAutoScroll(false);
		}
	});

	clearBtn.addEventListener('click', () => {
		clearAll();
		vscode.postMessage({ type: 'clear' });
	});

	autoScrollBtn.addEventListener('click', () => {
		setAutoScroll(!autoScroll);
	});

	for (const level of Object.keys(filterButtons)) {
		filterButtons[level].addEventListener('click', () => {
			const btn = filterButtons[level];
			const isActive = btn.classList.toggle('active');
			entriesEl.classList.toggle('hide-' + level, !isActive);
		});
	}

	window.addEventListener('message', (event) => {
		const message = event.data;
		switch (message.type) {
			case 'init':
				maxEntries = message.maxEntries || maxEntries;
				clearAll();
				appendEntries(message.entries);
				break;
			case 'append':
				appendEntries(message.entries);
				break;
			case 'updateEntry':
				updateEntry(message.id, message.appendText);
				break;
		}
	});

	vscode.postMessage({ type: 'ready' });
})();
