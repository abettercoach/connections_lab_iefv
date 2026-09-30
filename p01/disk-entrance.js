// Disk entrance: the two-stage animation for the sky's first appearance,
// triggered by scene-director.js's 'reveal-disk' cue. Stage 1: the settled
// stars fade in (opacity only, never scaled) against the still-dark page.
// Stage 2, once stage 1 finishes: the disk fades in (opacity only) and the
// page itself flips from night (white text on black) to day (see body/
// body.day in piece.css). Kept entirely CSS/class-driven so pile.js's own
// drawing of the disk backdrop and stars never needs to know an entrance
// animation exists.

// Kept in sync with #pile-canvas's transition-duration in piece.css - the
// point of this constant is purely to know *when* stage 1 has finished so
// stage 2 can begin after it, not to control the CSS duration itself.
const STAR_FADE_IN_MS = 1600;

let stageTwoTimeout = null;

function revealDisk() {
	const pileCanvas = document.querySelector('#pile-canvas');
	if (pileCanvas) pileCanvas.classList.add('stars-in');
	stageTwoTimeout = setTimeout(() => {
		stageTwoTimeout = null;
		document.body.classList.add('day');
		const diskCanvas = document.querySelector('#disk-canvas');
		if (diskCanvas) diskCanvas.classList.add('revealed');
	}, STAR_FADE_IN_MS);
}

// The reverse, for stepping back past the 'reveal-disk' beat (see
// scene-director.js's undoCue()). Unlike the forward entrance, this isn't
// staged - all of it reverts at once, since undoing is a correction to an
// earlier point in the story rather than part of its telling. Also cancels
// stage 2's pending timeout, in case the visitor steps back quickly enough
// that stage 1 (the star fade-in) hadn't finished yet - otherwise it would
// still fire later and undo this undo.
function hideDisk() {
	if (stageTwoTimeout) {
		clearTimeout(stageTwoTimeout);
		stageTwoTimeout = null;
	}
	document.body.classList.remove('day');
	const diskCanvas = document.querySelector('#disk-canvas');
	if (diskCanvas) diskCanvas.classList.remove('revealed');
	const pileCanvas = document.querySelector('#pile-canvas');
	if (pileCanvas) pileCanvas.classList.remove('stars-in');
}
