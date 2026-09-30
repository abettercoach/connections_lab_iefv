// Audio: loading xeno-canto recordings and playing them. Two independent
// uses share this one file since both are "pick some recordings and play
// them" - but they're kept as separate function pairs below since their
// playback rules differ (one-shot vs. looped-and-layered, and who is
// allowed to stop what):
//   - placement sound: a single random recording, played once, on a
//     correct drop (triggered via pile.js's setOnStarPlaced() hook, called
//     from piece.js - see endDrag() in pile.js).
//   - ambient soundscape: several random recordings, looped and layered
//     together, eased in when the visitor comes out (see poem.js's
//     'fade-audio-in' cue) and faded out (not a hard cut) the moment the
//     sky shatters (see scene-director.js's applyCue()).
// Neither function here decides *when* it's called - that's story/scene
// concerns; this file only knows how to load and play xeno-canto files.

let xenoCantoRecordings = null;

// Master volume ceiling for all playback below (ambient and placement
// alike) - 0.7 rather than each Audio's natural 1.0, turned down 30% from
// xeno-canto's original recording levels.
const MASTER_VOLUME = 0.7;

async function loadRecordings(url) {
	const data = await (await fetch(url)).json();
	xenoCantoRecordings = Array.isArray(data.recordings) ? data.recordings : [];
	return xenoCantoRecordings;
}

// Keeps only recordings logged with a local time before 6:00 a.m. or at/after
// 6:00 p.m. - a plain clock-hour cutoff, not a real sunrise/sunset
// calculation (xeno-canto's "time" field is the recordist's local clock
// time, not tied to that location's actual day length). A recording with
// no time, or one xeno-canto couldn't parse (e.g. "?"), is dropped rather
// than guessed at.
const NIGHT_START_HOUR = 18;
const NIGHT_END_HOUR = 6;
function isNighttimeRecording(recording) {
	const match = /^(\d{1,2}):(\d{2})$/.exec(recording.time || '');
	if (!match) return false;
	const hour = Number(match[1]);
	return hour >= NIGHT_START_HOUR || hour < NIGHT_END_HOUR;
}

function nighttimeRecordings(recordings) {
	return recordings.filter(isNighttimeRecording);
}

function randomDistinctRecordings(recordings, count) {
	const pool = recordings.slice();
	const picked = [];
	while (picked.length < count && pool.length > 0) {
		const index = Math.floor(Math.random() * pool.length);
		picked.push(pool.splice(index, 1)[0]);
	}
	return picked;
}

// --- Placement sound: one recording, one shot -----------------------------

let placementAudio = null;

async function playRandomPlacementRecording(recordings) {
	if (!recordings || recordings.length === 0) return;
	const recording = recordings[Math.floor(Math.random() * recordings.length)];
	if (!placementAudio) placementAudio = new Audio();
	placementAudio.src = recording.file;
	placementAudio.volume = MASTER_VOLUME;
	try {
		await placementAudio.play();
	} catch (error) {
		console.error('Placement sound failed to play.', error);
	}
}

// --- Ambient soundscape: several recordings, looped and layered ----------

let ambientAudioElements = [];
let fadeHandle = null;

function cancelAmbientFade() {
	if (fadeHandle) {
		clearInterval(fadeHandle);
		fadeHandle = null;
	}
}

// Ramps every current layer's volume linearly from startVolume to
// endVolume over durationMs, calling onComplete once the ramp finishes (or
// immediately if there's nothing to fade). Shared by the fade-in and
// fade-out entry points below so "ease volume from A to B" only has one
// implementation.
function fadeAmbientVolume(startVolume, endVolume, durationMs, onComplete) {
	cancelAmbientFade();
	const layers = ambientAudioElements;
	if (layers.length === 0) {
		onComplete?.(layers);
		return;
	}
	for (const audio of layers) audio.volume = startVolume;
	const startedAt = performance.now();
	fadeHandle = setInterval(() => {
		const progress = Math.min(1, (performance.now() - startedAt) / durationMs);
		const volume = startVolume + (endVolume - startVolume) * progress;
		for (const audio of layers) audio.volume = volume;
		if (progress >= 1) {
			cancelAmbientFade();
			onComplete?.(layers);
		}
	}, 50);
}

function startAmbientSoundscape(recordings, count) {
	stopAmbientSoundscape();
	if (!recordings || recordings.length === 0) return;
	const chosen = randomDistinctRecordings(recordings, count);
	ambientAudioElements = chosen.map((recording) => {
		const audio = new Audio(recording.file);
		audio.loop = true;
		audio.volume = MASTER_VOLUME;
		audio.play().catch((error) => {
			console.error('Ambient soundscape layer failed to play.', error);
		});
		return audio;
	});
}

// Starts the soundscape silent, then eases it up to full volume - used for
// the disk's first appearance instead of the instant-on startAmbientSoundscape().
function fadeInAmbientSoundscape(recordings, count, durationMs) {
	stopAmbientSoundscape();
	if (!recordings || recordings.length === 0) return;
	const chosen = randomDistinctRecordings(recordings, count);
	ambientAudioElements = chosen.map((recording) => {
		const audio = new Audio(recording.file);
		audio.loop = true;
		audio.volume = 0;
		audio.play().catch((error) => {
			console.error('Ambient soundscape layer failed to play.', error);
		});
		return audio;
	});
	fadeAmbientVolume(0, MASTER_VOLUME, durationMs, () => {});
}

function stopAmbientSoundscape() {
	// A hard cut: every layer stops at once, no fade. Used when a fade isn't
	// wanted (e.g. cleanup, or restarting the soundscape from scratch - see
	// startAmbientSoundscape()/fadeInAmbientSoundscape() above, which both
	// call this before laying down new layers). Also cancels any fade
	// already in progress so it can't keep adjusting a set of layers this
	// call is meant to silence right away.
	cancelAmbientFade();
	for (const audio of ambientAudioElements) {
		audio.pause();
		audio.currentTime = 0;
	}
	ambientAudioElements = [];
}

function fadeOutAmbientSoundscape(durationMs) {
	const layers = ambientAudioElements;
	fadeAmbientVolume(MASTER_VOLUME, 0, durationMs, () => {
		for (const audio of layers) {
			audio.pause();
			audio.currentTime = 0;
		}
		ambientAudioElements = [];
	});
}

