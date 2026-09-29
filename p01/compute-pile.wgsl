// Compute-shader falling/piling spike.
//
// Particle state is intentionally physics-generic: position, velocity,
// radius, and a settled flag. Anything about a particle's meaning (star vs.
// future shard) lives outside this file, on the JS side, keyed by index.

struct Particle {
	pos: vec2<f32>,
	vel: vec2<f32>,
	radius: f32,
	settled: f32,
	restTimer: f32,
	_pad1: f32,
};

// All-f32 to keep the JS-side buffer a single Float32Array; integer fields
// are cast to u32 locally where needed.
struct Params {
	dt: f32,
	gravity: f32,
	width: f32,
	height: f32,
	radius: f32,
	cellSize: f32,
	gridW: f32,
	gridH: f32,
	maxPerCell: f32,
	numParticles: f32,
	floorFriction: f32,
	wallDamping: f32,
};

@group(0) @binding(0) var<storage, read> particlesRead: array<Particle>;
@group(0) @binding(1) var<storage, read_write> particlesWrite: array<Particle>;
@group(0) @binding(2) var<uniform> params: Params;
@group(0) @binding(3) var<storage, read_write> gridCount: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> gridEntries: array<u32>;

fn gridWU() -> u32 { return u32(params.gridW); }
fn gridHU() -> u32 { return u32(params.gridH); }
fn maxPerCellU() -> u32 { return u32(params.maxPerCell); }
fn numParticlesU() -> u32 { return u32(params.numParticles); }

fn cellCoordFor(pos: vec2<f32>) -> vec2<i32> {
	let cx = i32(clamp(floor(pos.x / params.cellSize), 0.0, params.gridW - 1.0));
	let cy = i32(clamp(floor(pos.y / params.cellSize), 0.0, params.gridH - 1.0));
	return vec2<i32>(cx, cy);
}

fn cellLinearIndex(cell: vec2<i32>) -> u32 {
	return u32(cell.y) * gridWU() + u32(cell.x);
}

@compute @workgroup_size(64)
fn resetGrid(@builtin(global_invocation_id) gid: vec3<u32>) {
	let index = gid.x;
	let numCells = gridWU() * gridHU();
	if (index >= numCells) { return; }
	atomicStore(&gridCount[index], 0u);
}

// Builds a bucket grid from this frame's starting positions (particlesRead),
// so the neighbor search in simulate() reads a grid that is never stale
// relative to what simulate() itself reads.
@compute @workgroup_size(64)
fn buildGrid(@builtin(global_invocation_id) gid: vec3<u32>) {
	let index = gid.x;
	if (index >= numParticlesU()) { return; }
	let p = particlesRead[index];
	// Particles still well above (or beside) the canvas can't touch anything
	// nearby yet; clamping their position into an edge cell would otherwise
	// falsely overload that cell with entries no real neighbor can reach.
	if (p.pos.y < -params.cellSize || p.pos.x < -params.cellSize
		|| p.pos.x > params.width + params.cellSize) {
		return;
	}
	let cellIdx = cellLinearIndex(cellCoordFor(p.pos));
	let slot = atomicAdd(&gridCount[cellIdx], 1u);
	if (slot < maxPerCellU()) {
		gridEntries[cellIdx * maxPerCellU() + slot] = index;
	}
}

// Applies gravity and moves each particle by its own velocity. This runs
// exactly once per fixed physics step, before any collision resolution, so
// that repeating the resolve pass below never double-integrates motion.
@compute @workgroup_size(64)
fn integrate(@builtin(global_invocation_id) gid: vec3<u32>) {
	let index = gid.x;
	if (index >= numParticlesU()) { return; }
	var p = particlesRead[index];
	p.vel.y = p.vel.y + params.gravity * params.dt;
	p.pos = p.pos + p.vel * params.dt;
	particlesWrite[index] = p;
}

// Reads only from particlesRead (this pass's start-of-pass snapshot) and
// writes only to particlesWrite, so concurrent invocations never race on the
// same particle's data mid-update.
//
// A single averaged (Jacobi-style) correction pass isn't enough to untangle
// a dense pile: with many particles resting on each other, one pass only
// partially separates overlaps, and the leftover overlap compounds frame
// over frame until particles collapse into an overlapping mass instead of
// stacking into a mound. So this pass is deliberately *not* combined with
// integrate - the driver calls it several times per fixed step (rebuilding
// the neighbor grid each time, since positions shift), letting overlaps
// relax out over those iterations, the same way a position-based-dynamics
// solver would. Each individual call still only ever nudges positions a
// fraction of the way (averaged by contact count) so no single iteration
// can overshoot or reintroduce jitter; iterating is what actually converges.
@compute @workgroup_size(64)
fn resolve(@builtin(global_invocation_id) gid: vec3<u32>) {
	let index = gid.x;
	if (index >= numParticlesU()) { return; }
	var p = particlesRead[index];

	let velAfterGravity = p.vel;
	let predictedPos = p.pos;
	let cell = cellCoordFor(predictedPos);

	var totalCorrection = vec2<f32>(0.0, 0.0);
	var totalVelDelta = vec2<f32>(0.0, 0.0);
	var contactCount = 0.0;
	var touchingSupport = false;

	for (var dy = -1; dy <= 1; dy = dy + 1) {
		for (var dx = -1; dx <= 1; dx = dx + 1) {
			let nx = cell.x + dx;
			let ny = cell.y + dy;
			if (nx < 0 || ny < 0 || nx >= i32(gridWU()) || ny >= i32(gridHU())) { continue; }
			let cellIdx = cellLinearIndex(vec2<i32>(nx, ny));
			let count = min(atomicLoad(&gridCount[cellIdx]), maxPerCellU());
			for (var i: u32 = 0u; i < count; i = i + 1u) {
				let otherIndex = gridEntries[cellIdx * maxPerCellU() + i];
				if (otherIndex == index) { continue; }
				let other = particlesRead[otherIndex];
				let delta = predictedPos - other.pos;
				let dist = length(delta);
				let minDist = p.radius + other.radius;
				if (dist > 0.0001 && dist < minDist) {
					let overlap = minDist - dist;
					let normal = delta / dist;
					// Each side corrects only itself by half the overlap; the
					// other particle's own invocation applies its own half,
					// so together they separate fully without a data race.
					totalCorrection = totalCorrection + normal * (overlap * 0.5);
					// A steep, mostly-downward normal means the other
					// particle is roughly beneath this one, i.e. genuine
					// support; a shallow/glancing angle should not count.
					if (normal.y < -0.55) { touchingSupport = true; }
					let velAlongNormal = dot(velAfterGravity, normal);
					if (velAlongNormal < 0.0) {
						totalVelDelta = totalVelDelta - normal * velAlongNormal * 0.4;
					}
					contactCount = contactCount + 1.0;
				}
			}
		}
	}

	if (contactCount > 0.0) {
		let averaging = 1.0 / contactCount;
		p.pos = predictedPos + totalCorrection * averaging;
		p.vel = velAfterGravity + totalVelDelta * averaging;
	} else {
		p.pos = predictedPos;
	}

	let floorY = params.height - p.radius;
	if (p.pos.y > floorY) {
		p.pos.y = floorY;
		p.vel.y = 0.0;
		p.vel.x = p.vel.x * params.floorFriction;
		touchingSupport = true;
	}
	if (p.pos.x < p.radius) {
		p.pos.x = p.radius;
		p.vel.x = p.vel.x * -params.wallDamping;
	}
	if (p.pos.x > params.width - p.radius) {
		p.pos.x = params.width - p.radius;
		p.vel.x = p.vel.x * -params.wallDamping;
	}

	// restTimer gives "settled" hysteresis: a particle must stay slow and
	// supported for a short stretch of time, not just one lucky frame,
	// before it is marked settled.
	let speed = length(p.vel);
	let isResting = speed < 8.0 && touchingSupport;
	var restTimer = particlesRead[index].restTimer;
	if (isResting) {
		restTimer = min(restTimer + params.dt, 1.0);
	} else {
		restTimer = 0.0;
	}
	p.restTimer = restTimer;
	p.settled = select(0.0, 1.0, restTimer > 0.12);

	particlesWrite[index] = p;
}

struct VertexOut {
	@builtin(position) position: vec4<f32>,
	@location(0) localCoord: vec2<f32>,
	@location(1) settled: f32,
};

@group(0) @binding(0) var<storage, read> particlesForRender: array<Particle>;
@group(0) @binding(1) var<uniform> renderParams: Params;

@vertex
fn vertexMain(
	@builtin(vertex_index) vertexIndex: u32,
	@builtin(instance_index) instanceIndex: u32
) -> VertexOut {
	var corners = array<vec2<f32>, 6>(
		vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
		vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0)
	);
	let corner = corners[vertexIndex];
	let p = particlesForRender[instanceIndex];
	let worldPos = p.pos + corner * p.radius * 1.4;
	let ndcX = (worldPos.x / renderParams.width) * 2.0 - 1.0;
	let ndcY = 1.0 - (worldPos.y / renderParams.height) * 2.0;

	var out: VertexOut;
	out.position = vec4<f32>(ndcX, ndcY, 0.0, 1.0);
	out.localCoord = corner;
	out.settled = p.settled;
	return out;
}

@fragment
fn fragmentMain(in: VertexOut) -> @location(0) vec4<f32> {
	let dist = length(in.localCoord);
	if (dist > 1.0 / 1.4) { discard; }
	return vec4<f32>(0.98, 0.97, 0.93, 1.0);
}
