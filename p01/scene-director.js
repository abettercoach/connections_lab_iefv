// Scene director: the one place that knows both "story" (abstract cues) and
// "everything else" (disk entrance animation, the pile simulation/renderer,
// audio). Translates a cue name into real calls against those systems.
// Nothing else in story.js/poem.js/margins.js talks to the disk, the pile,
// or audio directly - this file is deliberately the only bridge, so those
// concerns can keep changing shape independently without touching story.

function createInitialSceneState() {
	return {
		diskRevealed: false,
		starsRevealed: false,
		// Loaded once at startup by piece.js (see loadRecordings() in
		// audio.js) and stashed here so applyCue() has them on hand without
		// needing to know how/when they were fetched.
		recordings: []
	};
}

function applyCue(cue, sceneState) {
	switch (cue) {
		case 'fade-audio-in':
			fadeInAmbientSoundscape(sceneState.recordings, 5, 2000);
			break;
		case 'reveal-disk':
			revealDisk();
			revealPileStars();
			sceneState.diskRevealed = true;
			sceneState.starsRevealed = true;
			break;
		case 'shatter':
			shatterPile();
			fadeOutAmbientSoundscape(2000);
			break;
		case 'begin-interaction':
			// Dragging is already possible the moment stars are settled in
			// the pile (see pile.js's isFalling gate) - reserved here in
			// case a future first-time hint or similar needs a hook.
			break;
		default:
			console.warn(`Unknown story cue: ${cue}`);
	}
	return sceneState;
}

