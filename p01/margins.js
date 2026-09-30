// Margins: renders the current beat's poem lines into the page margins.
// Reads story state; never advances it, never knows what a cue means.
// A blank line (empty string) is treated as a stanza break: it renders as
// a plain spacer rather than an empty paragraph, since an empty <p> alone
// doesn't read as a visible gap.

function renderMarginText(beat) {
	const container = document.querySelector('#margin-text');
	if (!container) return;
	container.replaceChildren();
	if (!beat) return;
	for (const line of beat.lines) {
		if (line.trim() === '') {
			const spacer = document.createElement('div');
			spacer.className = 'margin-gap';
			container.appendChild(spacer);
			continue;
		}
		const p = document.createElement('p');
		p.textContent = line;
		container.appendChild(p);
	}
}

function clearMarginText() {
	renderMarginText(null);
}
