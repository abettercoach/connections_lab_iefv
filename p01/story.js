// Story: owns only *which beat the visitor is on*. It knows nothing about
// drawing, DOM, canvases, or audio - it hands out beat data (from poem.js)
// and advances on request; everything else (margins.js, scene-director.js)
// reads this state but never mutates it directly.

function createInitialStoryState() {
	return { beatIndex: 0 };
}

function currentBeat(storyState) {
	return POEM_BEATS[storyState.beatIndex] ?? null;
}

function advanceStory(storyState) {
	if (isStoryComplete(storyState)) return storyState;
	return { beatIndex: storyState.beatIndex + 1 };
}

function isStoryComplete(storyState) {
	return storyState.beatIndex >= POEM_BEATS.length;
}
