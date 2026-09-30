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
			// Dragging owns the page's pointer events from here on - stop
			// the advance layer from intercepting clicks meant for stars.
			enableStoryAdvance(false);
			break;
		default:
			console.warn(`Unknown story cue: ${cue}`);
	}
	return sceneState;
}

// The inverse of applyCue(): undoes one cue's effects, for stepping
// backward past the beat that introduced it (see story.js's
// retreatStory() and piece.js's handleRetreat()). Cues are undone in the
// reverse order applyCue() would apply them for the same beat.
function undoCue(cue, sceneState) {
	switch (cue) {
		case 'fade-audio-in':
			stopAmbientSoundscape();
			break;
		case 'reveal-disk':
			hideDisk();
			resetPile();
			sceneState.diskRevealed = false;
			sceneState.starsRevealed = false;
			break;
		case 'shatter':
			resetPile();
			fadeInAmbientSoundscape(sceneState.recordings, 5, 400);
			break;
		case 'begin-interaction':
			enableStoryAdvance(true);
			break;
		default:
			console.warn(`Unknown story cue: ${cue}`);
	}
	return sceneState;
}

function enableStoryAdvance(enabled) {
	const advanceLayer = document.querySelector('#story-advance');
	if (advanceLayer) advanceLayer.style.pointerEvents = enabled ? 'auto' : 'none';
}

