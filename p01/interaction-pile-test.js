// Interaction spike (WebGPU): fall + pile, then pick a settled star and
// drag it back to where it belongs. See ARCHITECTURE.md for the plan this
// prototype is testing. Deliberately kept apart from compute-pile-test.js
// (the falling/piling reference) so that file stays untouched.
//
// Concerns are kept in separate sections below, in the order that data
// flows through them each frame:
//   - Physics bridge: GPU buffer layout, step encoding, and the one place
//     JS writes a dragged particle's position into the sim (no other
//     interaction code touches GPU buffers directly).
//   - Placement: what "correct" means for a drop, hit-testing, and the
//     pick/drag/drop state machine. Knows nothing about WebGPU or drawing.
//   - Animation/rendering (2D overlay): the pulsing target rings. Reads
//     placement state, never writes it.
//   - Sound: picks and plays a random xeno-canto recording. Called only
//     from placement's "correct drop" transition.

const PARTICLE_FLOATS = 14; // pos.xy, vel.xy, radius, settled, restTimer, brightness, stepStartPos.xy, picked, placed, targetPos.xy
const PARAMS_FLOATS = 17;
const WORKGROUP_SIZE = 64;
const FIXED_DT = 1 / 120;
const MAX_STEPS_PER_FRAME = 8;
// One averaged correction pass can't fully untangle a dense pile in one go;
// running several per fixed step lets overlaps relax out instead of
// compounding into a collapsed, overlapping mass. See interaction-pile.wgsl.
const SOLVER_ITERATIONS = 12;
const PARTICLE_RADIUS = 1.5;
const CELL_SIZE = PARTICLE_RADIUS * 2 * 2.2;
const MAX_SUBSTEPS_PER_STEP = 8;
const MAX_TRAVEL_PER_SUBSTEP = PARTICLE_RADIUS;
const UNIFORM_BUFFER_ALIGNMENT = 256;
const SUBSTEP_PARAM_SLOT_COUNT = MAX_SUBSTEPS_PER_STEP * (MAX_SUBSTEPS_PER_STEP + 1) / 2;
const GRAVITY = 1600;
// Settled, not a debug control here - see ARCHITECTURE.md's compute-shader
// experiment log for how this value (and the physics it tunes) was found.
const PARTICLE_FRICTION = 1.2;
const FLOOR_FRICTION = 0.86;
const WALL_DAMPING = 0.3;
// Used as an exponent (1 - (1-brightness)^boost), not a multiplier - see
// fragmentMain() in interaction-pile.wgsl. At 1.0 it's a no-op: the sky
// renders at true brightness, and only the automatic sparse->full curve for
// placed stars (placedBrightnessExponent()) provides any boost. Turn this
// up only to manually test extra boost on top of that curve.
const DEFAULT_BRIGHTNESS_BOOST = 1;
// The real fixed sky snapshot this prototype tests against (see
// ARCHITECTURE.md's "Fixed Sky" section). Stars below the horizon at this
// moment are excluded entirely, same as the final piece would.
const OBSERVER_LAT_DEG = 18;
const OBSERVER_LON_DEG = -(66 + 37 / 60);
// June 2, 2019, 10:00 p.m. Atlantic Standard Time == June 3, 2019, 02:00 UTC.
const OBSERVER_INSTANT = new Date('2019-06-03T02:00:00Z');
// Where the projected sky disk sits on screen, and how large.
const DISK_RADIUS_FRACTION = 0.28; // of min(canvas.width, canvas.height)
const DISK_CENTER_Y_FRACTION = 0.32; // of canvas.height, from the top
// How close (in pixels) a drop must land to a star's true position to count
// as correctly placed, and how close a click/tap must land to a settled
// star's center to pick it up.
const PLACEMENT_TOLERANCE_PX = 14;
const PICK_TOLERANCE_PX = 10;

const canvas = document.querySelector('#pile-canvas');
const diskCanvas = document.querySelector('#disk-canvas');
const diskCtx = diskCanvas.getContext('2d');
const overlayCanvas = document.querySelector('#overlay-canvas');
const overlayCtx = overlayCanvas.getContext('2d');
const statusLabel = document.querySelector('#status');
const placementStatusLabel = document.querySelector('#placement-status');
const releaseButton = document.querySelector('#release');
const resetButton = document.querySelector('#reset');
const brightnessInput = document.querySelector('#brightness-boost');
const brightnessLabel = document.querySelector('#brightness-label');

let device = null;
let context = null;
let presentationFormat = null;

let shaderModule = null;
let computeBindGroupLayout = null;
let renderBindGroupLayout = null;
let resetGridPipeline = null;
let buildGridPipeline = null;
let integratePipeline = null;
let resolvePipeline = null;
let renderPipeline = null;

let particlesA = null;
let particlesB = null;
let particleReadbackBuffer = null;
let paramsBuffer = null;
let substepParamsBuffer = null;
let gridHeadBuffer = null;
let gridNextBuffer = null;

let bindGroupEven = null; // read A, write B
let bindGroupOdd = null;  // read B, write A
let renderBindGroupA = null;
let renderBindGroupB = null;

let numParticles = 0;
let gridW = 0;
let gridH = 0;
let latestIsA = true;
let stepParityIsEven = true;
let isFalling = false;
let physicsAccumulator = 0;
let lastFrameAt = 0;
let frameCount = 0;
let fpsWindowStart = 0;
let lastFps = 0;
let lastSubstepCount = 1;
let totalStepsSinceRelease = 0;
let brightnessBoost = DEFAULT_BRIGHTNESS_BOOST;
// Real stars above the horizon at OBSERVER_INSTANT, projected to disk-relative
// coordinates once at load time (see loadSkyStars()). Fixed for the session:
// resizing the window rescales the disk, it does not reproject the sky.
let skyStars = null;
// This session's disk placement in screen pixels. Recomputed on resize;
// releaseParticles() and placement hit-testing both read it from here so
// there is exactly one source of truth for "where the disk is".
let diskCenterX = 0;
let diskCenterY = 0;
let diskRadius = 0;

function readyStatusText() {
	return skyStars
		? `WebGPU ready. ${skyStars.length} stars above the horizon. Press Release.`
		: 'WebGPU ready. Press Release.';
}


async function main() {
	if (!navigator.gpu) {
		statusLabel.textContent = 'WebGPU is not supported in this browser.';
		releaseButton.disabled = true;
		return;
	}

	const adapter = await navigator.gpu.requestAdapter();
	if (!adapter) {
		statusLabel.textContent = 'No WebGPU adapter available.';
		releaseButton.disabled = true;
		return;
	}
	device = await adapter.requestDevice();
	context = canvas.getContext('webgpu');
	presentationFormat = navigator.gpu.getPreferredCanvasFormat();
	brightnessInput.value = String(DEFAULT_BRIGHTNESS_BOOST);
	brightnessLabel.textContent = `${DEFAULT_BRIGHTNESS_BOOST.toFixed(1)}`;

	const shaderSource = await (await fetch('interaction-pile.wgsl')).text();
	shaderModule = device.createShaderModule({ code: shaderSource });

	createLayoutsAndPipelines();
	resizeCanvas();
	window.addEventListener('resize', resizeCanvas);

	releaseButton.disabled = true;
	statusLabel.textContent = 'Loading sky catalog…';
	skyStars = await loadSkyStars('stars.json');
	layOutStarsOnDisk();
	statusLabel.textContent = readyStatusText();
	releaseButton.disabled = false;

	// Fetched once, up front, so the first successful placement's sound
	// isn't delayed behind a network request for the recording index.
	loadXenoCantoRecordings().catch((error) => {
		console.error('Failed to load xeno-canto recordings.', error);
	});

	releaseButton.addEventListener('click', releaseParticles);
	resetButton.addEventListener('click', resetSimulation);
	brightnessInput.addEventListener('input', () => {
		brightnessBoost = Number(brightnessInput.value);
		brightnessLabel.textContent = `${brightnessBoost.toFixed(1)}`;
		writeParams();
	});

	attachPointerHandlers();

	statusLabel.textContent = readyStatusText();
	lastFrameAt = performance.now();
	fpsWindowStart = lastFrameAt;
	requestAnimationFrame(frame);
}

function createLayoutsAndPipelines() {
	computeBindGroupLayout = device.createBindGroupLayout({
		entries: [
			{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
			{ binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
			{
				binding: 2,
				visibility: GPUShaderStage.COMPUTE,
				buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: PARAMS_FLOATS * 4 }
			},
			{ binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
			{ binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }
		]
	});
	renderBindGroupLayout = device.createBindGroupLayout({
		entries: [
			{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
			{
				binding: 1,
				// Both stages: vertexMain positions/sizes each star, and
				// fragmentMain now also reads renderParams.brightnessBoost
				// for the brightness slider (see interaction-pile.wgsl).
				visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
				buffer: { type: 'uniform' }
			}
		]
	});

	const computePipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [computeBindGroupLayout] });
	resetGridPipeline = device.createComputePipeline({
		layout: computePipelineLayout,
		compute: { module: shaderModule, entryPoint: 'resetGrid' }
	});
	buildGridPipeline = device.createComputePipeline({
		layout: computePipelineLayout,
		compute: { module: shaderModule, entryPoint: 'buildGrid' }
	});
	integratePipeline = device.createComputePipeline({
		layout: computePipelineLayout,
		compute: { module: shaderModule, entryPoint: 'integrate' }
	});
	resolvePipeline = device.createComputePipeline({
		layout: computePipelineLayout,
		compute: { module: shaderModule, entryPoint: 'resolve' }
	});

	const renderPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [renderBindGroupLayout] });
	renderPipeline = device.createRenderPipeline({
		layout: renderPipelineLayout,
		vertex: { module: shaderModule, entryPoint: 'vertexMain' },
		fragment: {
			module: shaderModule,
			entryPoint: 'fragmentMain',
			targets: [{
				format: presentationFormat,
				// The canvas is configured with alphaMode: 'premultiplied'
				// (so the disk backdrop shows through outside each star's
				// quad); fragmentMain outputs premultiplied color to match,
				// so this blend uses 'one' (not 'src-alpha') for color -
				// the alpha multiplication already happened in the shader.
				blend: {
					color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
					alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }
				}
			}]
		},
		primitive: { topology: 'triangle-list' }
	});
}

function resizeCanvas() {
	const dpr = 1; // kept simple for this spike; not accounting for device pixel ratio yet.
	canvas.width = Math.max(1, Math.floor(window.innerWidth * dpr));
	canvas.height = Math.max(1, Math.floor(window.innerHeight * dpr));
	diskCanvas.width = canvas.width;
	diskCanvas.height = canvas.height;
	overlayCanvas.width = canvas.width;
	overlayCanvas.height = canvas.height;
	// Transparent clear: the page background and #disk-canvas behind this
	// canvas do the actual "white outside / dark disk" coloring; this
	// canvas only ever contributes the star quads themselves.
	context.configure({ device, format: presentationFormat, alphaMode: 'premultiplied' });

	diskRadius = Math.min(canvas.width, canvas.height) * DISK_RADIUS_FRACTION;
	diskCenterX = canvas.width / 2;
	diskCenterY = canvas.height * DISK_CENTER_Y_FRACTION;
	drawDiskBackdrop();

	gridW = Math.max(1, Math.ceil(canvas.width / CELL_SIZE));
	gridH = Math.max(1, Math.ceil(canvas.height / CELL_SIZE));
	createGridBuffers();
	writeParams();
	rebuildBindGroups();
}

// Static backdrop: one dark filled circle marking the fixed sky disk. Drawn
// once per resize (not per animation frame) since it never itself moves or
// animates - only the stars on top of it do.
function drawDiskBackdrop() {
	diskCtx.clearRect(0, 0, diskCanvas.width, diskCanvas.height);
	diskCtx.beginPath();
	diskCtx.arc(diskCenterX, diskCenterY, diskRadius, 0, Math.PI * 2);
	diskCtx.fillStyle = '#0c0e13';
	diskCtx.fill();
}

function createGridBuffers() {
	const numCells = gridW * gridH;
	gridHeadBuffer = device.createBuffer({
		size: numCells * 4,
		usage: GPUBufferUsage.STORAGE
	});
	gridNextBuffer = numParticles > 0
		? device.createBuffer({
			size: numParticles * Uint32Array.BYTES_PER_ELEMENT,
			usage: GPUBufferUsage.STORAGE
		})
		: null;
}

function writeParams() {
	if (!paramsBuffer) {
		paramsBuffer = device.createBuffer({
			size: PARAMS_FLOATS * 4,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
		});
	}
	if (!substepParamsBuffer) {
		substepParamsBuffer = device.createBuffer({
			size: SUBSTEP_PARAM_SLOT_COUNT * UNIFORM_BUFFER_ALIGNMENT,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
		});
	}

	const makeParams = (dt) => new Float32Array([
		dt, GRAVITY, canvas.width, canvas.height,
		PARTICLE_RADIUS, CELL_SIZE, gridW, gridH,
		PARTICLE_FRICTION, numParticles, FLOOR_FRICTION, WALL_DAMPING,
		diskCenterX, diskCenterY, diskRadius, brightnessBoost,
		currentPlacementProgress()
	]);
	device.queue.writeBuffer(paramsBuffer, 0, makeParams(FIXED_DT));

	const alignedParams = new Float32Array(
		SUBSTEP_PARAM_SLOT_COUNT * UNIFORM_BUFFER_ALIGNMENT / Float32Array.BYTES_PER_ELEMENT
	);
	for (let substeps = 1; substeps <= MAX_SUBSTEPS_PER_STEP; substeps++) {
		const firstSlot = substeps * (substeps - 1) / 2;
		const params = makeParams(FIXED_DT / substeps);
		for (let substepIndex = 0; substepIndex < substeps; substepIndex++) {
			const slot = firstSlot + substepIndex;
			alignedParams.set(
				params,
				slot * UNIFORM_BUFFER_ALIGNMENT / Float32Array.BYTES_PER_ELEMENT
			);
		}
	}
	device.queue.writeBuffer(substepParamsBuffer, 0, alignedParams);
}

function createParticleBuffers(count) {
	const size = count * PARTICLE_FLOATS * 4;
	particlesA = device.createBuffer({
		size,
		usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
	});
	particlesB = device.createBuffer({
		size,
		usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
	});
	gridNextBuffer = device.createBuffer({
		size: count * Uint32Array.BYTES_PER_ELEMENT,
		usage: GPUBufferUsage.STORAGE
	});
	particleReadbackBuffer = device.createBuffer({
		size,
		usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
	});
}

function rebuildBindGroups() {
	if (!particlesA || !particlesB || !gridHeadBuffer || !gridNextBuffer
		|| !paramsBuffer || !substepParamsBuffer) return;
	bindGroupEven = device.createBindGroup({
		layout: computeBindGroupLayout,
		entries: [
			{ binding: 0, resource: { buffer: particlesA } },
			{ binding: 1, resource: { buffer: particlesB } },
			{
				binding: 2,
				resource: { buffer: substepParamsBuffer, offset: 0, size: PARAMS_FLOATS * 4 }
			},
			{ binding: 3, resource: { buffer: gridHeadBuffer } },
			{ binding: 4, resource: { buffer: gridNextBuffer } }
		]
	});
	bindGroupOdd = device.createBindGroup({
		layout: computeBindGroupLayout,
		entries: [
			{ binding: 0, resource: { buffer: particlesB } },
			{ binding: 1, resource: { buffer: particlesA } },
			{
				binding: 2,
				resource: { buffer: substepParamsBuffer, offset: 0, size: PARAMS_FLOATS * 4 }
			},
			{ binding: 3, resource: { buffer: gridHeadBuffer } },
			{ binding: 4, resource: { buffer: gridNextBuffer } }
		]
	});
	renderBindGroupA = device.createBindGroup({
		layout: renderBindGroupLayout,
		entries: [
			{ binding: 0, resource: { buffer: particlesA } },
			{ binding: 1, resource: { buffer: paramsBuffer } }
		]
	});
	renderBindGroupB = device.createBindGroup({
		layout: renderBindGroupLayout,
		entries: [
			{ binding: 0, resource: { buffer: particlesB } },
			{ binding: 1, resource: { buffer: paramsBuffer } }
		]
	});
}

// --- Real sky data (RA/Dec catalog -> disk-relative alt-az projection) ---
//
// This mirrors script.js's astronomy math for a fixed observer/instant
// (duplicated here rather than shared, since this file is a disposable
// physics prototype; see ARCHITECTURE.md for the eventual shared module).

async function loadSkyStars(url) {
	const records = await (await fetch(url)).json();
	const observer = { lat: degToRad(OBSERVER_LAT_DEG), lon: degToRad(OBSERVER_LON_DEG) };
	const localSiderealTime = siderealTimeRad(OBSERVER_INSTANT, observer.lon);
	const magnitudes = records.map((record) => Number(record.V));
	const brightestMagnitude = Math.min(...magnitudes);

	const stars = [];
	for (let i = 0; i < records.length; i++) {
		const ra = rightAscensionRad(records[i]);
		const dec = declinationRad(records[i]);
		const horizontal = horizontalCoordsFor(ra, dec, observer, localSiderealTime);
		if (horizontal.altitude < 0) continue; // below the horizon at this moment
		stars.push({
			altitude: horizontal.altitude,
			azimuth: horizontal.azimuth,
			brightness: starBrightness(magnitudes[i], brightestMagnitude)
		});
	}
	return stars;
}

// Disk-relative unit offset (before scaling by the on-screen disk radius),
// with altitude === pi/2 (zenith) at the center and the horizon at the rim.
function diskOffsetFor(altitude, azimuth) {
	const radialFraction = 1 - clamp(altitude / (Math.PI / 2), 0, 1);
	return { x: radialFraction * Math.sin(azimuth), y: -radialFraction * Math.cos(azimuth) };
}

function starBrightness(magnitude, brightestMagnitude) {
	const relativeFlux = Math.pow(10, -0.4 * (magnitude - brightestMagnitude));
	const exposure = 10000;
	return Math.log1p(exposure * relativeFlux) / Math.log1p(exposure);
}

function rightAscensionRad(record) {
	const matches = record.RA.match(/(\d+)h\s*(\d+)m\s*([\d.]+)s/);
	const hours = Number(matches[1]) + Number(matches[2]) / 60 + Number(matches[3]) / 3600;
	return degToRad(hours * 15); // 15 degrees per hour of right ascension
}

function declinationRad(record) {
	const matches = record.Dec.match(/([+-]?)(\d+)°\s*(\d+)′\s*(\d+)″/);
	let degrees = Number(matches[2]) + Number(matches[3]) / 60 + Number(matches[4]) / 3600;
	if (matches[1] === '-') degrees *= -1;
	return degToRad(degrees);
}

function horizontalCoordsFor(ra, dec, observer, localSiderealTime) {
	const hourAngle = mod(localSiderealTime - ra, Math.PI * 2);
	const sinAltitude = Math.sin(dec) * Math.sin(observer.lat) + Math.cos(dec) * Math.cos(observer.lat) * Math.cos(hourAngle);
	const altitude = Math.asin(clamp(sinAltitude, -1, 1));
	const cosAzimuth = (Math.sin(dec) - Math.sin(altitude) * Math.sin(observer.lat)) / (Math.cos(altitude) * Math.cos(observer.lat));
	let azimuth = Math.acos(clamp(cosAzimuth, -1, 1));
	if (Math.sin(hourAngle) > 0) azimuth = Math.PI * 2 - azimuth;
	return { altitude, azimuth };
}

// Sidereal time formula duplicated verbatim (renamed locals only) from
// script.js's siderealTime(), so both projections agree on this fixed sky.
function siderealTimeRad(time, longitudeRad) {
	let year = time.getUTCFullYear();
	let month = time.getUTCMonth() + 1;
	const day = time.getUTCDate();
	const hour = time.getUTCHours();
	const minute = time.getUTCMinutes();
	const second = time.getUTCSeconds();
	const millisecond = time.getUTCMilliseconds();

	if (month <= 2) {
		year--;
		month += 12;
	}

	const century = Math.floor(year / 100);
	const correction = 2 - century + Math.floor(century / 4);
	const julianDate = correction + Math.floor(365.25 * year) + Math.floor(30.6001 * (month + 1)) - 730550.5
		+ day + (hour + minute / 60 + second / 3600 + millisecond / 3600000) / 24;
	const julianCenturies = julianDate / 36525;

	let siderealDegrees = 280.46061837 + 360.98564736629 * julianDate + 0.000387933 * julianCenturies ** 2 - julianCenturies ** 3 / 38710000;
	siderealDegrees = ((siderealDegrees % 360) + 360) % 360;

	let siderealRadians = degToRad(siderealDegrees) + longitudeRad;
	return mod(siderealRadians, Math.PI * 2);
}

function degToRad(degrees) {
	return (degrees * Math.PI) / 180;
}

function clamp(value, min, max) {
	return Math.min(max, Math.max(min, value));
}

function mod(value, modulus) {
	return ((value % modulus) + modulus) % modulus;
}

// --- Placement: pick/drag/drop state and correctness -----------------------
//
// Knows what "correct" means for a drop and tracks the pick/drag/drop state
// machine. Knows nothing about WebGPU buffers (see the physics bridge
// functions below, which are the only things that touch GPU buffers) and
// nothing about drawing (see the overlay section further down).

let placement = null;

function initPlacement(count, targets) {
	placement = {
		count,
		targets, // Float32Array, [x0, y0, x1, y1, ...] - each star's true home
		placedCount: 0,
		dragIndex: -1, // particle index currently held, or -1 if none
		dragX: 0,
		dragY: 0,
		pickPending: false // guards overlapping hit-test readbacks
	};
	updatePlacementStatus();
}

function updatePlacementStatus() {
	placementStatusLabel.textContent = placement
		? `${placement.placedCount} / ${placement.count} placed`
		: '';
}

// How much of the sky has been correctly rebuilt so far (0 at the start of
// the interaction, 1 once every star is home). Read by writeParams() each
// frame - see interaction-pile.wgsl's placedBrightnessExponent().
function currentPlacementProgress() {
	return placement && placement.count > 0 ? placement.placedCount / placement.count : 0;
}

function isWithinPlacementTolerance(dropX, dropY, index) {
	const targetX = placement.targets[index * 2];
	const targetY = placement.targets[index * 2 + 1];
	return Math.hypot(dropX - targetX, dropY - targetY) <= PLACEMENT_TOLERANCE_PX;
}

// --- Physics bridge: the only functions that touch GPU particle buffers ---
//
// A held particle isn't simulated normally (see isFrozen() in
// interaction-pile.wgsl) - JS drives it directly by partial-writing just the
// few floats that changed into whichever buffer the next physics pass will
// read (see the latestIsA invariant documented in frame()/encodeSubstep()).
// This keeps every direct GPU write behind these few functions, so the
// placement/animation code above and below never needs to know a buffer
// layout exists.

function currentAuthoritativeBuffer() {
	return latestIsA ? particlesA : particlesB;
}

// Async hit-test: reads back current positions once (only ever on
// pointerdown, never every frame) to find the nearest settled, not-yet-
// placed star within PICK_TOLERANCE_PX of the click. A frame or two of
// latency before a drag visually "starts" was judged an acceptable
// trade-off for not needing continuous readback.
async function tryPickStarAt(x, y) {
	if (!isFalling || !placement || placement.dragIndex >= 0 || placement.pickPending) return;
	placement.pickPending = true;
	try {
		const source = currentAuthoritativeBuffer();
		const byteLength = numParticles * PARTICLE_FLOATS * Float32Array.BYTES_PER_ELEMENT;
		const encoder = device.createCommandEncoder();
		encoder.copyBufferToBuffer(source, 0, particleReadbackBuffer, 0, byteLength);
		device.queue.submit([encoder.finish()]);
		await particleReadbackBuffer.mapAsync(GPUMapMode.READ);
		const data = new Float32Array(particleReadbackBuffer.getMappedRange().slice(0));
		particleReadbackBuffer.unmap();

		let bestIndex = -1;
		let bestDistSq = PICK_TOLERANCE_PX * PICK_TOLERANCE_PX;
		for (let i = 0; i < numParticles; i++) {
			const offset = i * PARTICLE_FLOATS;
			const settled = data[offset + 5];
			const placedFlag = data[offset + 11];
			if (settled < 0.5 || placedFlag > 0.5) continue;
			const dx = data[offset] - x;
			const dy = data[offset + 1] - y;
			const distSq = dx * dx + dy * dy;
			if (distSq < bestDistSq) {
				bestDistSq = distSq;
				bestIndex = i;
			}
		}
		if (bestIndex >= 0 && placement.dragIndex < 0) beginDrag(bestIndex, x, y);
	} finally {
		placement.pickPending = false;
	}
}

function beginDrag(index, x, y) {
	placement.dragIndex = index;
	placement.dragX = x;
	placement.dragY = y;
	const buffer = currentAuthoritativeBuffer();
	// picked=1: from the next integrate() pass onward this particle is
	// frozen for physics and JS positions it directly (see below).
	device.queue.writeBuffer(buffer, (index * PARTICLE_FLOATS + 10) * 4, new Float32Array([1]));
	writeDraggedParticlePosition();
}

function updateDrag(x, y) {
	if (!placement || placement.dragIndex < 0) return;
	placement.dragX = x;
	placement.dragY = y;
}

// Called once per animation frame (see frame()), before that frame's
// physics steps are encoded, so a held particle never lags a frame behind
// the pointer. A no-op whenever nothing is being dragged.
function writeDraggedParticlePosition() {
	if (!placement || placement.dragIndex < 0) return;
	const buffer = currentAuthoritativeBuffer();
	const offset = placement.dragIndex * PARTICLE_FLOATS * 4;
	device.queue.writeBuffer(buffer, offset, new Float32Array([placement.dragX, placement.dragY, 0, 0]));
}

function endDrag(x, y) {
	if (!placement || placement.dragIndex < 0) return;
	const index = placement.dragIndex;
	const buffer = currentAuthoritativeBuffer();
	const posOffset = index * PARTICLE_FLOATS * 4;
	const restOffset = (index * PARTICLE_FLOATS + 5) * 4; // settled, restTimer
	const flagsOffset = (index * PARTICLE_FLOATS + 10) * 4; // picked, placed

	if (isWithinPlacementTolerance(x, y, index)) {
		// Correct: snap exactly to its true position, freeze there for good,
		// and celebrate with a sound. placed=1 keeps it frozen permanently -
		// see isFrozen()/isWakeable() in interaction-pile.wgsl.
		const targetX = placement.targets[index * 2];
		const targetY = placement.targets[index * 2 + 1];
		device.queue.writeBuffer(buffer, posOffset, new Float32Array([targetX, targetY, 0, 0]));
		device.queue.writeBuffer(buffer, flagsOffset, new Float32Array([0, 1])); // picked=0, placed=1
		placement.placedCount++;
		writeParams(); // refresh progress so placedBrightnessExponent() sees it
		playRandomBirdsong();
	} else {
		// Wrong spot: release it back into falling physics from right here.
		// settled/restTimer must be explicitly cleared too - they were left
		// untouched (still true) throughout the drag by the wgsl guard that
		// skips the resting hysteresis while picked, so simply clearing
		// picked would otherwise leave it looking "already settled" again.
		device.queue.writeBuffer(buffer, posOffset, new Float32Array([x, y, 0, 0]));
		device.queue.writeBuffer(buffer, restOffset, new Float32Array([0, 0])); // settled=0, restTimer=0
		device.queue.writeBuffer(buffer, flagsOffset, new Float32Array([0, 0])); // picked=0, placed=0
	}

	placement.dragIndex = -1;
	updatePlacementStatus();
}

function pointerCanvasPos(event) {
	const rect = canvas.getBoundingClientRect();
	return {
		x: (event.clientX - rect.left) * (canvas.width / rect.width),
		y: (event.clientY - rect.top) * (canvas.height / rect.height)
	};
}

function attachPointerHandlers() {
	canvas.addEventListener('pointerdown', (event) => {
		if (!isFalling) return;
		const pos = pointerCanvasPos(event);
		tryPickStarAt(pos.x, pos.y).catch((error) => {
			console.error('Star pick readback failed.', error);
		});
	});
	window.addEventListener('pointermove', (event) => {
		if (!placement || placement.dragIndex < 0) return;
		const pos = pointerCanvasPos(event);
		updateDrag(pos.x, pos.y);
	});
	window.addEventListener('pointerup', (event) => {
		if (!placement || placement.dragIndex < 0) return;
		const pos = pointerCanvasPos(event);
		endDrag(pos.x, pos.y);
	});
	window.addEventListener('pointercancel', () => {
		// An interrupted gesture is treated as a drop right where it was
		// left - the same "wrong spot falls" rule applies, nothing special.
		if (!placement || placement.dragIndex < 0) return;
		endDrag(placement.dragX, placement.dragY);
	});
}

// --- Animation: the pulsing "this is where it goes" indicator --------------
//
// Purely visual, drawn on a 2D overlay canvas layered on top of the WebGPU
// canvas (see interaction-pile-test.css). Reads placement state; never
// writes it, and never touches GPU buffers.

function drawOverlay(now) {
	overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
	if (!placement || placement.dragIndex < 0) return;
	const index = placement.dragIndex;
	const targetX = placement.targets[index * 2];
	const targetY = placement.targets[index * 2 + 1];
	drawPulseRings(targetX, targetY, now);
}

function drawPulseRings(x, y, now) {
	const periodMs = 1200;
	const ringCount = 3;
	const maxRadiusPx = 26;
	for (let i = 0; i < ringCount; i++) {
		const phase = mod(now + (i * periodMs) / ringCount, periodMs) / periodMs;
		const radius = 4 + phase * maxRadiusPx;
		const alpha = (1 - phase) * 0.6;
		overlayCtx.beginPath();
		overlayCtx.arc(x, y, radius, 0, Math.PI * 2);
		overlayCtx.strokeStyle = `rgba(241, 238, 231, ${alpha.toFixed(3)})`;
		overlayCtx.lineWidth = 1.5;
		overlayCtx.stroke();
	}
	// A small steady dot marks the exact target, so it's precise - not just
	// "somewhere inside the pulse".
	overlayCtx.beginPath();
	overlayCtx.arc(x, y, 2, 0, Math.PI * 2);
	overlayCtx.fillStyle = 'rgba(241, 238, 231, 0.9)';
	overlayCtx.fill();
}

// --- Sound: a random xeno-canto recording on correct placement -------------

let xenoCantoRecordings = null;
let placementAudio = null;

async function loadXenoCantoRecordings() {
	const data = await (await fetch('xeno_canto.json')).json();
	xenoCantoRecordings = Array.isArray(data.recordings) ? data.recordings : [];
}

async function playRandomBirdsong() {
	if (!xenoCantoRecordings || xenoCantoRecordings.length === 0) return;
	const recording = xenoCantoRecordings[Math.floor(Math.random() * xenoCantoRecordings.length)];
	if (!placementAudio) placementAudio = new Audio();
	placementAudio.src = recording.file;
	try {
		await placementAudio.play();
	} catch (error) {
		console.error('Placement sound failed to play.', error);
	}
}

// Builds one particle buffer snapshot from skyStars: each star's disk
// position (its "true" spot - literally where it starts, since the resting
// arrangement below is real above-horizon positions) both as this buffer's
// initial pos and as targetPos, which placement compares every drop
// against. startSettled controls whether the star begins frozen on the
// disk (see layOutStarsOnDisk()) or free to fall under gravity from the
// next frame (see releaseParticles()).
function buildParticleData(startSettled) {
	const data = new Float32Array(numParticles * PARTICLE_FLOATS);
	const targets = new Float32Array(numParticles * 2);
	for (let i = 0; i < numParticles; i++) {
		const offset = i * PARTICLE_FLOATS;
		const star = skyStars[i];
		const diskOffset = diskOffsetFor(star.altitude, star.azimuth);
		const x = diskCenterX + diskOffset.x * diskRadius;
		const y = diskCenterY + diskOffset.y * diskRadius;
		data[offset + 0] = x;
		data[offset + 1] = y;
		data[offset + 2] = 0;
		data[offset + 3] = 0;
		data[offset + 4] = PARTICLE_RADIUS;
		data[offset + 5] = startSettled ? 1 : 0;
		data[offset + 6] = 0;
		data[offset + 7] = star.brightness;
		data[offset + 8] = x; // stepStartPos, overwritten each step by integrate()
		data[offset + 9] = y;
		data[offset + 10] = 0; // picked
		data[offset + 11] = 0; // placed
		data[offset + 12] = x; // targetPos, physics never reads this
		data[offset + 13] = y;
		targets[i * 2] = x;
		targets[i * 2 + 1] = y;
	}
	return { data, targets };
}

// Lays the whole sky out on the disk, frozen in place (settled=1, so
// integrate()/resolve() in interaction-pile.wgsl leave them exactly where
// they are - see isFrozen()). This is the resting state both at first load
// and after Reset; releaseParticles() below is the only thing that lets
// them fall from here.
function layOutStarsOnDisk() {
	if (!skyStars) return;
	numParticles = skyStars.length;
	if (!particlesA) {
		createParticleBuffers(numParticles);
		writeParams();
		rebuildBindGroups();
	}

	const { data, targets } = buildParticleData(true);
	device.queue.writeBuffer(particlesA, 0, data);
	device.queue.writeBuffer(particlesB, 0, data);

	latestIsA = true;
	stepParityIsEven = true;
	physicsAccumulator = 0;
	lastSubstepCount = 1;
	totalStepsSinceRelease = 0;
	isFalling = false;
	releaseButton.disabled = false;
	initPlacement(numParticles, targets);
	writeParams(); // reset progress to 0 for the new/reset layout
}

// Lets every star fall: same positions as the resting disk arrangement,
// but no longer frozen, so gravity takes over from the very next physics
// step. This is the only thing Release does - it does not otherwise change
// targets or placement progress.
function releaseParticles() {
	if (isFalling || !skyStars || numParticles === 0) return;
	const { data } = buildParticleData(false);
	device.queue.writeBuffer(particlesA, 0, data);
	device.queue.writeBuffer(particlesB, 0, data);

	latestIsA = true;
	stepParityIsEven = true;
	physicsAccumulator = 0;
	lastSubstepCount = 1;
	totalStepsSinceRelease = 0;
	isFalling = true;
	releaseButton.disabled = true;
}

// Puts every star back on the disk, as if Release had never been pressed -
// including undoing any placements made since.
function resetSimulation() {
	layOutStarsOnDisk();
}

// Uses a free-fall travel bound to choose a substep count. Collision impulses
// can create speeds above this estimate, so this is a diagnostic improvement,
// not a replacement for swept collision detection.
function substepsForStep(stepIndex) {
	const timeAfterStep = (stepIndex + 1) * FIXED_DT;
	const estimatedSpeed = GRAVITY * timeAfterStep;
	const estimatedTravel = estimatedSpeed * FIXED_DT
		+ 0.5 * GRAVITY * FIXED_DT * FIXED_DT;
	return Math.min(
		MAX_SUBSTEPS_PER_STEP,
		Math.max(1, Math.ceil(estimatedTravel / MAX_TRAVEL_PER_SUBSTEP))
	);
}

function substepParamOffset(substeps, substepIndex) {
	const slot = substeps * (substeps - 1) / 2 + substepIndex;
	return slot * UNIFORM_BUFFER_ALIGNMENT;
}

function encodeSubstep(encoder, paramsOffset) {
	const numCells = gridW * gridH;
	const gridWorkgroups = Math.ceil(numCells / WORKGROUP_SIZE);
	const particleWorkgroups = Math.ceil(numParticles / WORKGROUP_SIZE);

	const integratePass = encoder.beginComputePass();
	integratePass.setBindGroup(
		0,
		stepParityIsEven ? bindGroupEven : bindGroupOdd,
		[paramsOffset]
	);
	integratePass.setPipeline(integratePipeline);
	integratePass.dispatchWorkgroups(particleWorkgroups);
	integratePass.end();
	stepParityIsEven = !stepParityIsEven;
	latestIsA = !latestIsA;

	for (let iter = 0; iter < SOLVER_ITERATIONS; iter++) {
		const resolvePass = encoder.beginComputePass();
		resolvePass.setBindGroup(
			0,
			stepParityIsEven ? bindGroupEven : bindGroupOdd,
			[paramsOffset]
		);
		resolvePass.setPipeline(resetGridPipeline);
		resolvePass.dispatchWorkgroups(gridWorkgroups);
		resolvePass.setPipeline(buildGridPipeline);
		resolvePass.dispatchWorkgroups(particleWorkgroups);
		resolvePass.setPipeline(resolvePipeline);
		resolvePass.dispatchWorkgroups(particleWorkgroups);
		resolvePass.end();
		stepParityIsEven = !stepParityIsEven;
		latestIsA = !latestIsA;
	}
}

function encodeStep(encoder, stepIndex) {
	const substeps = substepsForStep(stepIndex);
	lastSubstepCount = substeps;
	for (let substepIndex = 0; substepIndex < substeps; substepIndex++) {
		encodeSubstep(encoder, substepParamOffset(substeps, substepIndex));
	}
}

function frame(now) {
	const elapsedSeconds = Math.min(0.25, (now - lastFrameAt) / 1000);
	lastFrameAt = now;
	if (isFalling) physicsAccumulator += elapsedSeconds;

	// A held particle's position is driven by the pointer, not physics -
	// write it into whichever buffer integrate()/resolve() are about to
	// read this frame, before any steps are encoded, so it isn't one frame
	// stale relative to its own drag.
	writeDraggedParticlePosition();

	const encoder = device.createCommandEncoder();
	let steps = 0;
	if (isFalling) {
		while (physicsAccumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
			encodeStep(encoder, totalStepsSinceRelease);
			physicsAccumulator -= FIXED_DT;
			totalStepsSinceRelease++;
			steps++;
		}
	}

	const renderPass = encoder.beginRenderPass({
		colorAttachments: [{
			view: context.getCurrentTexture().createView(),
			clearValue: { r: 0, g: 0, b: 0, a: 0 },
			loadOp: 'clear',
			storeOp: 'store'
		}]
	});
	if (numParticles > 0) {
		renderPass.setPipeline(renderPipeline);
		renderPass.setBindGroup(0, latestIsA ? renderBindGroupA : renderBindGroupB);
		renderPass.draw(6, numParticles);
	}
	renderPass.end();

	device.queue.submit([encoder.finish()]);

	drawOverlay(now);
	updateStatus(now);
	requestAnimationFrame(frame);
}

function updateStatus(now) {
	frameCount++;
	if (now - fpsWindowStart >= 500) {
		lastFps = Math.round((frameCount * 1000) / (now - fpsWindowStart));
		frameCount = 0;
		fpsWindowStart = now;
	}
	statusLabel.textContent = numParticles > 0
		? `${numParticles.toLocaleString()} particles · ${lastFps || '…'} fps`
		: readyStatusText();
}

main();
