// Margins: renders the current beat's poem lines into the page margins.
// Reads story state; never advances it, never knows what a cue means.

function renderMarginText(beat) {
	const container = document.querySelector('#margin-text');
	if (!container) return;
	container.replaceChildren();
	if (!beat) return;
	for (const line of beat.lines) {
		const p = document.createElement('p');
		p.textContent = line;
		container.appendChild(p);
	}
}

function clearMarginText() {
	renderMarginText(null);
}
