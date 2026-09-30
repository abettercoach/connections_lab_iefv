// Piece: the real entry point. Wires story (poem.js/story.js) to
// scene-director.js's cue dispatch, which in turn drives the disk entrance
// (disk-entrance.js), the pile simulation/renderer (pile.js), and audio
// (audio.js). This file itself only sequences startup and responds to the
// advance click - it holds no rendering, physics, or audio logic of its own.

let storyState = null;
let sceneState = null;

async function initPiece() {
	storyState = createInitialStoryState();
	sceneState = createInitialSceneState();

	// The placement sound (audio.js) is triggered from inside pile.js's own
	// drag/drop logic, so pile.js is handed a callback rather than knowing
	// about xeno-canto itself (see setOnStarPlaced() in pile.js).
	setOnStarPlaced(() => playRandomPlacementRecording(sceneState.recordings));

	const [pileReady, recordings] = await Promise.all([
		initPile(),
		loadRecordings('xeno_canto.json').catch((error) => {
			console.error('Failed to load xeno-canto recordings.', error);
			return [];
		})
	]);
	sceneState.recordings = recordings;

	if (!pileReady) {
		console.error('WebGPU unavailable - the piece cannot run.');
		return;
	}

	renderMarginText(currentBeat(storyState));
	const openingBeat = currentBeat(storyState);

	// The opening beat's cues (e.g. 'fade-audio-in') fire on arrival same as
	// any later beat's, but audio.play() is blocked by the browser until the
	// visitor's very first interaction with the page - so, uniquely for
	// this one beat, applying its cues waits for that first click/keypress
	// rather than running at load. Registered before the advance/keydown
	// handlers below so, if that same gesture also advances the story, the
	// opening beat's cues are guaranteed to apply first.
	const applyOpeningCues = () => {
		for (const cue of openingBeat.cues) applyCue(cue, sceneState);
	};
	document.addEventListener('pointerdown', applyOpeningCues, { once: true });
	document.addEventListener('keydown', applyOpeningCues, { once: true });

	// Mouse/tap always advances; arrow keys can go either way (see
	// handleKeydown()) so the visitor can revisit earlier lines.
	document.querySelector('#story-advance').addEventListener('click', handleAdvance);
	document.addEventListener('keydown', handleKeydown);
}

function handleKeydown(event) {
	if (event.key === 'ArrowRight') handleAdvance();
	else if (event.key === 'ArrowLeft') handleRetreat();
}

function handleAdvance() {
	if (isStoryComplete(storyState)) return;
	storyState = advanceStory(storyState);
	const beat = currentBeat(storyState);
	renderMarginText(beat);
	if (!beat) return;
	for (const cue of beat.cues) applyCue(cue, sceneState);
}

function handleRetreat() {
	if (storyState.beatIndex <= 0) return;
	// Undo the beat we're leaving's cues before stepping back, in reverse
	// order, then show the previous beat's (already-applied) text - see
	// scene-director.js's undoCue() and story.js's retreatStory().
	const leavingBeat = currentBeat(storyState);
	if (leavingBeat) {
		for (const cue of [...leavingBeat.cues].reverse()) undoCue(cue, sceneState);
	}
	storyState = retreatStory(storyState);
	renderMarginText(currentBeat(storyState));
}

initPiece();
