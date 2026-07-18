// @ts-check
(function () {
	'use strict';

	const vscode = acquireVsCodeApi();

	const masterListEl = document.getElementById('master-list');
	const sizerEl = document.getElementById('master-sizer');
	const viewportEl = document.getElementById('master-viewport');
	const clearBtn = document.getElementById('clear-btn');
	const autoScrollBtn = document.getElementById('autoscroll-btn');
	const searchInput = document.getElementById('search-input');
	const filterButtons = {
		error: document.getElementById('filter-error'),
		warning: document.getElementById('filter-warning'),
		info: document.getElementById('filter-info'),
	};
	const detailEmptyEl = document.getElementById('detail-empty');
	const detailContentEl = document.getElementById('detail-content');
	const detailIconEl = document.getElementById('detail-icon');
	const detailTimeEl = document.getElementById('detail-time');
	const detailTextEl = document.getElementById('detail-text');

	const LEVEL_LABELS = { error: 'Error', warning: 'Warning', info: 'Info' };
	const ROW_HEIGHT = 20;
	const BUFFER = 8;
	const SEARCH_DEBOUNCE_MS = 150;

	let maxEntries = 5000;

	// Fixed-capacity ring buffer holding EntryRecords oldest -> newest: ring[(head+i) % ring.length]
	// for i in [0, count). Overwriting ring[head] and advancing head is O(1) eviction per append —
	// unlike a plain array with .shift(), which is O(n) (memmoves the remaining ~5000 elements) on
	// every single entry evicted, turning steady-state appends into O(n) work under a write burst.
	let ring = new Array(maxEntries);
	let ringHead = 0;
	let ringCount = 0;
	/** @type {Map<number, Object>} */
	const byId = new Map();
	/** @type {number[]} ids currently passing level-filter AND search */
	let visibleIds = [];
	/** @type {number|null} */
	let selectedId = null;
	const filters = { error: true, warning: true, info: true };
	let searchQueryLower = '';
	let searchDebounceTimer = null;
	const counts = { error: 0, warning: 0, info: 0 };

	function forEachEntry(fn) {
		for (let i = 0; i < ringCount; i++) {
			fn(ring[(ringHead + i) % ring.length]);
		}
	}

	function pushEntry(rec) {
		if (ringCount < ring.length) {
			ring[(ringHead + ringCount) % ring.length] = rec;
			ringCount++;
			return undefined;
		}
		const evicted = ring[ringHead];
		ring[ringHead] = rec;
		ringHead = (ringHead + 1) % ring.length;
		return evicted;
	}
	let autoScroll = true;

	// --- row pool (virtualized rendering) ---
	/** @type {Array<{root:HTMLElement, icon:HTMLElement, time:HTMLElement, summary:HTMLElement}>} */
	const rowPool = [];
	let renderStart = -1;
	let renderEnd = -1;
	let scrollScheduled = false;

	function formatTime(timestamp) {
		const date = new Date(timestamp);
		const pad = (n, len) => String(n).padStart(len || 2, '0');
		return (
			pad(date.getHours()) +
			':' +
			pad(date.getMinutes()) +
			':' +
			pad(date.getSeconds()) +
			'.' +
			pad(date.getMilliseconds(), 3)
		);
	}

	function firstLine(text) {
		const idx = text.indexOf('\n');
		return idx === -1 ? text : text.slice(0, idx);
	}

	function updateCounts() {
		filterButtons.error.querySelector('.count').textContent = String(counts.error);
		filterButtons.warning.querySelector('.count').textContent = String(counts.warning);
		filterButtons.info.querySelector('.count').textContent = String(counts.info);
	}

	function makeRecord(entry) {
		return {
			id: entry.id,
			level: entry.level,
			text: entry.text,
			receivedAt: entry.receivedAt,
			links: entry.links || [],
			searchHay: entry.text.toLowerCase(),
			summary: firstLine(entry.text),
		};
	}

	function recomputeVisible() {
		const q = searchQueryLower;
		visibleIds = [];
		forEachEntry((rec) => {
			if (filters[rec.level] && (q === '' || rec.searchHay.includes(q))) {
				visibleIds.push(rec.id);
			}
		});
		sizerEl.style.height = visibleIds.length * ROW_HEIGHT + 'px';
		renderStart = -1;
		renderEnd = -1;
		renderVisible();
	}

	function ensurePoolSize() {
		const viewportHeight = masterListEl.clientHeight || 1;
		const needed = Math.ceil(viewportHeight / ROW_HEIGHT) + 2 * BUFFER + 4;
		while (rowPool.length < needed) {
			const root = document.createElement('div');
			root.className = 'master-row';
			const icon = document.createElement('span');
			icon.className = 'row-icon';
			const time = document.createElement('span');
			time.className = 'row-time';
			const summary = document.createElement('span');
			summary.className = 'row-summary';
			root.appendChild(icon);
			root.appendChild(time);
			root.appendChild(summary);
			root.style.display = 'none';
			viewportEl.appendChild(root);
			rowPool.push({ root, icon, time, summary });
		}
	}

	function renderVisible() {
		ensurePoolSize();

		const scrollTop = masterListEl.scrollTop;
		const viewportHeight = masterListEl.clientHeight;
		const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
		const lastVisible = Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT);
		const start = Math.max(0, firstVisible - BUFFER);
		const end = Math.min(visibleIds.length, lastVisible + BUFFER);

		if (start === renderStart && end === renderEnd) {
			return;
		}
		renderStart = start;
		renderEnd = end;

		const count = end - start;
		for (let i = 0; i < rowPool.length; i++) {
			const slot = rowPool[i];
			if (i >= count) {
				slot.root.style.display = 'none';
				continue;
			}
			const id = visibleIds[start + i];
			const rec = byId.get(id);
			if (!rec) {
				slot.root.style.display = 'none';
				continue;
			}
			slot.root.style.display = '';
			slot.root.style.top = (start + i) * ROW_HEIGHT + 'px';
			slot.root.className = 'master-row level-' + rec.level + (id === selectedId ? ' selected' : '');
			slot.root.setAttribute('data-entry-id', String(id));
			slot.icon.textContent = LEVEL_LABELS[rec.level] || '';
			slot.time.textContent = formatTime(rec.receivedAt);
			slot.summary.textContent = rec.summary;
		}
	}

	function scheduleRenderOnScroll() {
		if (scrollScheduled) {
			return;
		}
		scrollScheduled = true;
		requestAnimationFrame(() => {
			scrollScheduled = false;
			renderVisible();
		});
	}

	function buildDetailTextNode(rec) {
		const container = document.createDocumentFragment();
		const links = rec.links.slice().sort((a, b) => a.start - b.start);
		let cursor = 0;
		const text = rec.text;

		for (const link of links) {
			if (link.start > cursor) {
				container.appendChild(document.createTextNode(text.slice(cursor, link.start)));
			}
			const linkSpan = document.createElement('span');
			linkSpan.className = 'log-link';
			linkSpan.setAttribute('data-file', link.file);
			linkSpan.setAttribute('data-line', String(link.line));
			linkSpan.textContent = text.slice(link.start, link.end);
			container.appendChild(linkSpan);
			cursor = link.end;
		}
		if (cursor < text.length) {
			container.appendChild(document.createTextNode(text.slice(cursor)));
		}

		return container;
	}

	function renderDetailPane(rec) {
		if (!rec) {
			detailEmptyEl.hidden = false;
			detailContentEl.hidden = true;
			return;
		}
		detailEmptyEl.hidden = true;
		detailContentEl.hidden = false;
		detailContentEl.className = 'level-' + rec.level;
		detailIconEl.textContent = LEVEL_LABELS[rec.level] || '';
		detailTimeEl.textContent = formatTime(rec.receivedAt);
		detailTextEl.textContent = '';
		detailTextEl.appendChild(buildDetailTextNode(rec));
	}

	function selectEntry(id) {
		selectedId = id;
		renderDetailPane(byId.get(id) || null);
		renderStart = -1;
		renderEnd = -1;
		renderVisible();
	}

	function appendEntries(entries) {
		if (!entries || entries.length === 0) {
			return;
		}
		for (const entry of entries) {
			const rec = makeRecord(entry);
			const evicted = pushEntry(rec);
			byId.set(rec.id, rec);
			counts[rec.level] = (counts[rec.level] || 0) + 1;
			if (evicted) {
				byId.delete(evicted.id);
				counts[evicted.level] = Math.max(0, counts[evicted.level] - 1);
				if (evicted.id === selectedId) {
					selectedId = null;
					renderDetailPane(null);
				}
			}
		}

		updateCounts();
		recomputeVisible();
		maybeScroll();
	}

	function updateEntry(id, appendText) {
		const rec = byId.get(id);
		if (!rec) {
			return;
		}
		rec.text += '\n' + appendText;
		rec.searchHay += '\n' + appendText.toLowerCase();
		if (id === selectedId) {
			renderDetailPane(rec);
		}
	}

	function clearAll() {
		ring = new Array(maxEntries);
		ringHead = 0;
		ringCount = 0;
		byId.clear();
		visibleIds = [];
		selectedId = null;
		counts.error = 0;
		counts.warning = 0;
		counts.info = 0;
		updateCounts();
		sizerEl.style.height = '0px';
		renderStart = -1;
		renderEnd = -1;
		renderVisible();
		renderDetailPane(null);
	}

	function maybeScroll() {
		if (autoScroll) {
			masterListEl.scrollTop = visibleIds.length * ROW_HEIGHT;
			renderVisible();
		}
	}

	function setAutoScroll(value) {
		autoScroll = value;
		autoScrollBtn.classList.toggle('active', autoScroll);
		autoScrollBtn.textContent = autoScroll ? '▶ Auto-scroll' : '⏸ Paused';
		if (autoScroll) {
			maybeScroll();
		}
	}

	viewportEl.addEventListener('click', (event) => {
		const target = /** @type {HTMLElement} */ (event.target);
		const link = target.closest('.log-link');
		if (link) {
			const file = link.getAttribute('data-file');
			const line = Number(link.getAttribute('data-line'));
			vscode.postMessage({ type: 'openLocation', file, line });
			return;
		}
		const row = target.closest('.master-row');
		if (row) {
			const id = Number(row.getAttribute('data-entry-id'));
			selectEntry(id);
		}
	});

	detailTextEl.addEventListener('click', (event) => {
		const target = /** @type {HTMLElement} */ (event.target);
		const link = target.closest('.log-link');
		if (!link) {
			return;
		}
		const file = link.getAttribute('data-file');
		const line = Number(link.getAttribute('data-line'));
		vscode.postMessage({ type: 'openLocation', file, line });
	});

	masterListEl.addEventListener('scroll', () => {
		const distanceFromBottom = visibleIds.length * ROW_HEIGHT - masterListEl.scrollTop - masterListEl.clientHeight;
		if (distanceFromBottom > ROW_HEIGHT && autoScroll) {
			setAutoScroll(false);
		}
		scheduleRenderOnScroll();
	});

	if (typeof ResizeObserver !== 'undefined') {
		new ResizeObserver(() => scheduleRenderOnScroll()).observe(masterListEl);
	}

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
			filters[level] = btn.classList.toggle('active');
			recomputeVisible();
		});
	}

	searchInput.addEventListener('input', () => {
		if (searchDebounceTimer) {
			clearTimeout(searchDebounceTimer);
		}
		const value = searchInput.value;
		searchDebounceTimer = setTimeout(() => {
			searchQueryLower = value.toLowerCase();
			recomputeVisible();
		}, SEARCH_DEBOUNCE_MS);
	});

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
