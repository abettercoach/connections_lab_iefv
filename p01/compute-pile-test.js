// Compute-shader falling/piling spike (WebGPU). Falling + piling only: no
// dragging, placement, or sky data yet. See ARCHITECTURE.md for the plan
// this prototype is testing and how it is meant to extend toward "shards."

const PARTICLE_FLOATS = 8; // pos.xy, vel.xy, radius, settled, restTimer, pad
const PARAMS_FLOATS = 12;
const WORKGROUP_SIZE = 64;
const FIXED_DT = 1 / 120;
const MAX_STEPS_PER_FRAME = 8;
// One averaged correction pass can't fully untangle a dense pile in one go;
// running several per fixed step lets overlaps relax out instead of
// compounding into a collapsed, overlapping mass. See compute-pile.wgsl.
const SOLVER_ITERATIONS = 4;
const PARTICLE_RADIUS = 1.5;
const CELL_SIZE = PARTICLE_RADIUS * 2 * 2.2;
const MAX_PER_CELL = 24;
const GRAVITY = 1600;
const FLOOR_FRICTION = 0.86;
const WALL_DAMPING = 0.3;
// Stand-in for the real sky disk: a fixed circular source region particles
// start inside of, rather than scattered across the full canvas width. Real
// star positions/sizes come later; this is only shaped like the eventual
// disk so the fall/pile behavior is tested against something closer to the
// actual use case.
const DISK_RADIUS_FRACTION = 0.28; // of min(canvas.width, canvas.height)
const DISK_CENTER_Y_FRACTION = 0.32; // of canvas.height, from the top

const canvas = document.querySelector('#pile-canvas');
const statusLabel = document.querySelector('#status');
const releaseButton = document.querySelector('#release');
const resetButton = document.querySelector('#reset');
const particleCountSelect = document.querySelector('#particle-count');
const playPauseButton = document.querySelector('#play-pause');
const stepButton = document.querySelector('#step-once');
const frameSlider = document.querySelector('#frame-slider');
const frameLabel = document.querySelector('#frame-label');

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
let paramsBuffer = null;
let gridCountBuffer = null;
let gridEntriesBuffer = null;

let bindGroupEven = null; // read A, write B
let bindGroupOdd = null;  // read B, write A
let renderBindGroupA = null;
let renderBindGroupB = null;

let numParticles = 0;
let gridW = 0;
let gridH = 0;
let latestIsA = true;
let stepParityIsEven = true;
let fallingHasStarted = false;
let physicsAccumulator = 0;
let lastFrameAt = 0;
let frameCount = 0;
let fpsWindowStart = 0;
let lastFps = 0;

// Debug scrubbing: the sim is deterministic from the initial release state,
// so "scrubbing" to a step just means re-running that many fixed steps from
// scratch rather than storing a history of every frame. currentStepIndex is
// the number of fixed steps applied since release; the slider's max grows
// as Play advances it, and dragging the slider pauses Play and re-simulates
// up to the chosen step.
let initialParticleData = null;
let currentStepIndex = 0;
let maxStepSeen = 0;
let isPlaying = false;

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

	const shaderSource = await (await fetch('compute-pile.wgsl')).text();
	shaderModule = device.createShaderModule({ code: shaderSource });

	createLayoutsAndPipelines();
	resizeCanvas();
	window.addEventListener('resize', resizeCanvas);

	releaseButton.addEventListener('click', releaseParticles);
	resetButton.addEventListener('click', resetSimulation);
	playPauseButton.addEventListener('click', togglePlayPause);
	stepButton.addEventListener('click', () => scrubToStep(currentStepIndex + 1));
	frameSlider.addEventListener('input', () => {
		isPlaying = false;
		updatePlayPauseLabel();
		scrubToStep(Number(frameSlider.value));
	});

	statusLabel.textContent = 'WebGPU ready. Press Release.';
	lastFrameAt = performance.now();
	fpsWindowStart = lastFrameAt;
	requestAnimationFrame(frame);
}

function createLayoutsAndPipelines() {
	computeBindGroupLayout = device.createBindGroupLayout({
		entries: [
			{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
			{ binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
			{ binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
			{ binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
			{ binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }
		]
	});
	renderBindGroupLayout = device.createBindGroupLayout({
		entries: [
			{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
			{ binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }
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
			targets: [{ format: presentationFormat }]
		},
		primitive: { topology: 'triangle-list' }
	});
}

function resizeCanvas() {
	const dpr = 1; // kept simple for this spike; not accounting for device pixel ratio yet.
	canvas.width = Math.max(1, Math.floor(window.innerWidth * dpr));
	canvas.height = Math.max(1, Math.floor(window.innerHeight * dpr));
	context.configure({ device, format: presentationFormat, alphaMode: 'opaque' });

	gridW = Math.max(1, Math.ceil(canvas.width / CELL_SIZE));
	gridH = Math.max(1, Math.ceil(canvas.height / CELL_SIZE));
	createGridBuffers();
	writeParams();
	rebuildBindGroups();
}

function createGridBuffers() {
	const numCells = gridW * gridH;
	gridCountBuffer = device.createBuffer({
		size: numCells * 4,
		usage: GPUBufferUsage.STORAGE
	});
	gridEntriesBuffer = device.createBuffer({
		size: numCells * MAX_PER_CELL * 4,
		usage: GPUBufferUsage.STORAGE
	});
}

function writeParams() {
	if (!paramsBuffer) {
		paramsBuffer = device.createBuffer({
			size: PARAMS_FLOATS * 4,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
		});
	}
	const params = new Float32Array([
		FIXED_DT, GRAVITY, canvas.width, canvas.height,
		PARTICLE_RADIUS, CELL_SIZE, gridW, gridH,
		MAX_PER_CELL, numParticles, FLOOR_FRICTION, WALL_DAMPING
	]);
	device.queue.writeBuffer(paramsBuffer, 0, params);
}

function createParticleBuffers(count) {
	const size = count * PARTICLE_FLOATS * 4;
	particlesA = device.createBuffer({
		size,
		usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
	});
	particlesB = device.createBuffer({
		size,
		usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
	});
}

function rebuildBindGroups() {
	if (!particlesA || !particlesB || !gridCountBuffer || !gridEntriesBuffer || !paramsBuffer) return;
	bindGroupEven = device.createBindGroup({
		layout: computeBindGroupLayout,
		entries: [
			{ binding: 0, resource: { buffer: particlesA } },
			{ binding: 1, resource: { buffer: particlesB } },
			{ binding: 2, resource: { buffer: paramsBuffer } },
			{ binding: 3, resource: { buffer: gridCountBuffer } },
			{ binding: 4, resource: { buffer: gridEntriesBuffer } }
		]
	});
	bindGroupOdd = device.createBindGroup({
		layout: computeBindGroupLayout,
		entries: [
			{ binding: 0, resource: { buffer: particlesB } },
			{ binding: 1, resource: { buffer: particlesA } },
			{ binding: 2, resource: { buffer: paramsBuffer } },
			{ binding: 3, resource: { buffer: gridCountBuffer } },
			{ binding: 4, resource: { buffer: gridEntriesBuffer } }
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

// Builds the initial particle state on the CPU. `identities` (id + visual
// radius, currently trivial) is kept separate from the physics data on
// purpose: a future "shard" variant would only need to change identities'
// shape and the render path, not this simulation data layout.
//
// Particles are scattered uniformly inside a fixed circular "disk" region
// (a stand-in for the real sky disk) rather than across the full canvas
// width, so the fall/pile behavior can be judged against the actual source
// shape instead of an artificial full-width curtain.
//
// initialParticleData is kept around (not discarded) so the frame slider can
// deterministically re-simulate to any earlier step for scrubbing, without
// needing to record a snapshot of every frame.
function releaseParticles() {
	if (fallingHasStarted) return;
	numParticles = Number(particleCountSelect.value);
	particleCountSelect.disabled = true;
	createParticleBuffers(numParticles);
	writeParams();
	rebuildBindGroups();

	const diskRadius = Math.min(canvas.width, canvas.height) * DISK_RADIUS_FRACTION;
	const diskCenterX = canvas.width / 2;
	const diskCenterY = canvas.height * DISK_CENTER_Y_FRACTION;

	const data = new Float32Array(numParticles * PARTICLE_FLOATS);
	for (let i = 0; i < numParticles; i++) {
		const offset = i * PARTICLE_FLOATS;
		// Uniform disk sampling: sqrt(random) counteracts the bias that would
		// otherwise cluster points near the center.
		const r = diskRadius * Math.sqrt(Math.random());
		const theta = Math.random() * Math.PI * 2;
		data[offset + 0] = diskCenterX + Math.cos(theta) * r;
		data[offset + 1] = diskCenterY + Math.sin(theta) * r;
		data[offset + 2] = 0;
		data[offset + 3] = 0;
		data[offset + 4] = PARTICLE_RADIUS;
		data[offset + 5] = 0;
		data[offset + 6] = 0;
		data[offset + 7] = 0;
	}
	initialParticleData = data;
	device.queue.writeBuffer(particlesA, 0, data);
	device.queue.writeBuffer(particlesB, 0, data);

	latestIsA = true;
	stepParityIsEven = true;
	physicsAccumulator = 0;
	currentStepIndex = 0;
	maxStepSeen = 0;
	fallingHasStarted = true;
	isPlaying = true;
	releaseButton.disabled = true;
	updatePlayPauseLabel();
	updateFrameSlider();
}

function resetSimulation() {
	fallingHasStarted = false;
	isPlaying = false;
	physicsAccumulator = 0;
	numParticles = 0;
	particlesA = null;
	particlesB = null;
	initialParticleData = null;
	currentStepIndex = 0;
	maxStepSeen = 0;
	releaseButton.disabled = false;
	particleCountSelect.disabled = false;
	statusLabel.textContent = 'WebGPU ready. Press Release.';
	updatePlayPauseLabel();
	updateFrameSlider();
}

function togglePlayPause() {
	if (!fallingHasStarted) return;
	isPlaying = !isPlaying;
	if (isPlaying) physicsAccumulator = 0; // resume cleanly, no big catch-up jump
	updatePlayPauseLabel();
}

function updatePlayPauseLabel() {
	playPauseButton.textContent = isPlaying ? 'Pause' : 'Play';
}

function updateFrameSlider() {
	frameSlider.max = String(maxStepSeen);
	frameSlider.value = String(currentStepIndex);
	frameLabel.textContent = `step ${currentStepIndex} / ${maxStepSeen}`;
}

// Encodes exactly one fixed-timestep physics step (gravity/move, then
// several collision-resolution iterations) into the given command encoder.
function encodeStep(encoder) {
	const numCells = gridW * gridH;
	const gridWorkgroups = Math.ceil(numCells / WORKGROUP_SIZE);
	const particleWorkgroups = Math.ceil(numParticles / WORKGROUP_SIZE);

	const integratePass = encoder.beginComputePass();
	integratePass.setBindGroup(0, stepParityIsEven ? bindGroupEven : bindGroupOdd);
	integratePass.setPipeline(integratePipeline);
	integratePass.dispatchWorkgroups(particleWorkgroups);
	integratePass.end();
	stepParityIsEven = !stepParityIsEven;
	latestIsA = !latestIsA;

	for (let iter = 0; iter < SOLVER_ITERATIONS; iter++) {
		const resolvePass = encoder.beginComputePass();
		resolvePass.setBindGroup(0, stepParityIsEven ? bindGroupEven : bindGroupOdd);
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

// Re-simulates deterministically from the release state up to targetStep,
// then leaves the sim paused there. This is how the frame slider "scrubs"
// backward and forward without recording per-frame snapshots.
function scrubToStep(targetStep) {
	if (!fallingHasStarted || !initialParticleData) return;
	const clamped = Math.max(0, targetStep);
	maxStepSeen = Math.max(maxStepSeen, clamped);

	device.queue.writeBuffer(particlesA, 0, initialParticleData);
	device.queue.writeBuffer(particlesB, 0, initialParticleData);
	latestIsA = true;
	stepParityIsEven = true;

	const encoder = device.createCommandEncoder();
	for (let i = 0; i < clamped; i++) encodeStep(encoder);
	device.queue.submit([encoder.finish()]);

	currentStepIndex = clamped;
	updateFrameSlider();
}

function frame(now) {
	const elapsedSeconds = Math.min(0.25, (now - lastFrameAt) / 1000);
	lastFrameAt = now;
	if (fallingHasStarted && isPlaying) physicsAccumulator += elapsedSeconds;

	const encoder = device.createCommandEncoder();
	let steps = 0;
	if (fallingHasStarted && isPlaying) {
		while (physicsAccumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
			encodeStep(encoder);
			physicsAccumulator -= FIXED_DT;
			currentStepIndex++;
			steps++;
		}
		if (steps > 0) {
			maxStepSeen = Math.max(maxStepSeen, currentStepIndex);
			updateFrameSlider();
		}
	}

	const renderPass = encoder.beginRenderPass({
		colorAttachments: [{
			view: context.getCurrentTexture().createView(),
			clearValue: { r: 0.047, g: 0.055, b: 0.075, a: 1 },
			loadOp: 'clear',
			storeOp: 'store'
		}]
	});
	if (fallingHasStarted && numParticles > 0) {
		renderPass.setPipeline(renderPipeline);
		renderPass.setBindGroup(0, latestIsA ? renderBindGroupA : renderBindGroupB);
		renderPass.draw(6, numParticles);
	}
	renderPass.end();

	device.queue.submit([encoder.finish()]);

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
	statusLabel.textContent = fallingHasStarted
		? `${numParticles.toLocaleString()} particles · ${lastFps || '…'} fps${isPlaying ? '' : ' · paused'}`
		: 'WebGPU ready. Press Release.';
}

main();
