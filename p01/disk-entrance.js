// Disk entrance: a single, simple animation for the sky disk's first
// appearance (and, together with it, whatever stars are already settled on
// it - see scene-director.js's 'reveal-disk' cue), driven purely by CSS (a
// class toggle on the shared #sky wrapper), so it stays completely
// decoupled from pile.js's own drawing of the disk backdrop and stars
// (neither of which ever needs to know whether an entrance animation is
// playing). Called once, by scene-director.js's applyCue() on the
// 'reveal-disk' cue.

function revealDisk() {
	const sky = document.querySelector('#sky');
	if (!sky) return;
	sky.classList.add('revealed');
}
