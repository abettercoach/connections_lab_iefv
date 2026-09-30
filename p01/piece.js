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

	renderMarginText(currentBeat(storyState));

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

	document.querySelector('#story-advance').addEventListener('click', handleAdvance);
}

function handleAdvance() {
	if (isStoryComplete(storyState)) return;
	storyState = advanceStory(storyState);
	const beat = currentBeat(storyState);
	renderMarginText(beat);
	if (!beat) return;
	for (const cue of beat.cues) {
		applyCue(cue, sceneState);
		if (cue === 'begin-interaction') {
			// From here on, dragging owns the page's pointer events - stop
			// the advance layer from intercepting clicks meant for stars.
			document.querySelector('#story-advance').style.pointerEvents = 'none';
		}
	}
}

initPiece();
