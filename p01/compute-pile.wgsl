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
	// Rendered opacity only (0-1), e.g. a star's magnitude. Physics never
	// reads this; it exists purely for fragmentMain.
	brightness: f32,
	// Position at the very start of this fixed step, before gravity/movement
	// or any resolve iteration touched it. Carried unchanged through every
	// resolve iteration so velocity can be derived, once per step, from the
	// step's real net displacement (see resolve() below) instead of being
	// guessed from contact-normal angles.
	stepStartPos: vec2<f32>,
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
	particleFriction: f32,
	numParticles: f32,
	floorFriction: f32,
	wallDamping: f32,
};

@group(0) @binding(0) var<storage, read> particlesRead: array<Particle>;
@group(0) @binding(1) var<storage, read_write> particlesWrite: array<Particle>;
@group(0) @binding(2) var<uniform> params: Params;
@group(0) @binding(3) var<storage, read_write> gridHead: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> gridNext: array<u32>;

// A sleeping (settled) particle only wakes back up when an active neighbor
// overlaps it by more than this fraction of its radius - i.e. a real
// impact/avalanche, not the shallow steady-state overlap of something
// merely resting its weight on it.
const WAKE_OVERLAP_FRACTION: f32 = 0.5;

fn gridWU() -> u32 { return u32(params.gridW); }
fn gridHU() -> u32 { return u32(params.gridH); }
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
	atomicStore(&gridHead[index], 0xffffffffu);
}

// Builds an uncapped linked list for each cell. Every in-bounds particle
// atomically links itself into exactly one cell, so dense cells do not silently
// drop entries when they exceed a preset bucket capacity.
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
	let previousHead = atomicExchange(&gridHead[cellIdx], index);
	gridNext[index] = previousHead;
}

// Applies gravity and moves each particle by its own velocity. This runs
// exactly once per fixed physics step, before any collision resolution, so
// that repeating the resolve pass below never double-integrates motion.
//
// A settled particle is asleep: it is skipped here entirely (no gravity, no
// motion) so it can act as a stable, immovable base for the pile instead of
// being nudged downhill by residual solver error every single step, which
// is what made piles slowly flatten over time. resolve() is what wakes a
// sleeping particle back up if something hits it hard enough.
//
// Also snapshots stepStartPos (this particle's position before gravity/
// movement) so resolve() can derive the step's true velocity from real net
// displacement once all its iterations are done.
@compute @workgroup_size(64)
fn integrate(@builtin(global_invocation_id) gid: vec3<u32>) {
	let index = gid.x;
	if (index >= numParticlesU()) { return; }
	var p = particlesRead[index];
	p.stepStartPos = p.pos;
	if (p.settled < 0.5) {
		p.vel.y = p.vel.y + params.gravity * params.dt;
		p.pos = p.pos + p.vel * params.dt;
	}
	particlesWrite[index] = p;
}

fn coincidentPairNormal(index: u32, otherIndex: u32) -> vec2<f32> {
	let lowIndex = min(index, otherIndex);
	let highIndex = max(index, otherIndex);
	let pairHash = lowIndex * 1664525u + highIndex * 1013904223u;
	let angle = f32(pairHash % 4096u) * (6.28318530718 / 4096.0);
	let direction = vec2<f32>(cos(angle), sin(angle));
	return select(-direction, direction, index < otherIndex);
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
// solver would.
//
// Velocity is never set from a contact-normal angle guess ("steep downward
// normal = support, so damp velocity"). That guess can't tell a particle
// resting on the ground apart from a particle that merely has neighbors on
// all sides while an entire solid cluster falls together - both look like
// "supported from below" to a per-contact angle check, which stalled dense
// falling clusters (their interior never accelerated). Instead, position is
// corrected by overlaps only, and velocity is derived at the end from how
// far the particle actually net-moved this step (pos - stepStartPos) / dt.
// A particle that is genuinely blocked doesn't move, so this naturally
// yields near-zero velocity for it; a particle inside a cluster that is
// truly falling keeps moving down each iteration, so its derived velocity
// stays a true falling velocity, regardless of how many neighbors surround
// it.
@compute @workgroup_size(64)
fn resolve(@builtin(global_invocation_id) gid: vec3<u32>) {
	let index = gid.x;
	if (index >= numParticlesU()) { return; }
	var p = particlesRead[index];

	let predictedPos = p.pos;
	let cell = cellCoordFor(predictedPos);
	let selfAsleep = p.settled > 0.5;

	var totalCorrection = vec2<f32>(0.0, 0.0);
	var totalFrictionCorrection = vec2<f32>(0.0, 0.0);
	var contactCount = 0.0;
	var forcedWake = false;

	for (var dy = -1; dy <= 1; dy = dy + 1) {
		for (var dx = -1; dx <= 1; dx = dx + 1) {
			let nx = cell.x + dx;
			let ny = cell.y + dy;
			if (nx < 0 || ny < 0 || nx >= i32(gridWU()) || ny >= i32(gridHU())) { continue; }
			let cellIdx = cellLinearIndex(vec2<i32>(nx, ny));
			var otherIndex = atomicLoad(&gridHead[cellIdx]);
			while (otherIndex != 0xffffffffu) {
				if (otherIndex != index) {
					let other = particlesRead[otherIndex];
					let delta = predictedPos - other.pos;
					let dist = length(delta);
					let minDist = p.radius + other.radius;
					if (dist < minDist) {
						let overlap = minDist - dist;
						let otherAsleep = other.settled > 0.5;

						if (selfAsleep) {
							// A sleeping particle only reconsiders its rest if an
							// active neighbor hits it hard enough (see
							// WAKE_OVERLAP_FRACTION); otherwise it stays frozen
							// and contributes no correction this pass, letting
							// it act as a stable base instead of being nudged by
							// every neighbor's residual solver error. Contact is
							// still counted so the resting check below doesn't
							// mistake this stillness for having lost support.
							if (!otherAsleep && overlap > p.radius * WAKE_OVERLAP_FRACTION) {
								forcedWake = true;
							}
							contactCount = contactCount + 1.0;
						} else {
							var normal = coincidentPairNormal(index, otherIndex);
							if (dist > 0.0001) {
								normal = delta / dist;
							}
							// A sleeping neighbor won't apply its own share back
							// (it is frozen), so this particle must absorb the
							// full overlap against it instead of the usual half;
							// against an awake neighbor, both sides still split
							// it evenly so they separate fully without a race.
							let shareFactor = select(0.5, 1.0, otherAsleep);
							let normalCorrection = normal * (overlap * shareFactor);
							totalCorrection = totalCorrection + normalCorrection;

							// Coulomb-style positional friction: reduce this
							// pair's relative tangential travel, bounded by mu
							// times the normal correction, using the same share
							// split as the normal correction above.
							let selfDisplacement = p.pos - p.stepStartPos;
							let otherDisplacement = other.pos - other.stepStartPos;
							let relativeDisplacement = selfDisplacement - otherDisplacement;
							let tangentialDisplacement = relativeDisplacement
								- normal * dot(relativeDisplacement, normal);
							let tangentialDistance = length(tangentialDisplacement);
							if (tangentialDistance > 0.0001) {
								let frictionDistance = min(
									tangentialDistance * shareFactor,
									params.particleFriction * overlap * shareFactor
								);
								totalFrictionCorrection = totalFrictionCorrection
									- tangentialDisplacement / tangentialDistance * frictionDistance;
							}
							contactCount = contactCount + 1.0;
						}
					}
				}
				otherIndex = gridNext[otherIndex];
			}
		}
	}

	if (contactCount > 0.0 && !selfAsleep) {
		let averaging = 1.0 / contactCount;
		p.pos = predictedPos
			+ (totalCorrection + totalFrictionCorrection) * averaging;
	} else {
		p.pos = predictedPos;
	}

	p.vel = (p.pos - p.stepStartPos) / params.dt;

	var touchingFloor = false;
	let floorY = params.height - p.radius;
	if (p.pos.y > floorY) {
		p.pos.y = floorY;
		p.vel.y = 0.0;
		p.vel.x = p.vel.x * params.floorFriction;
		touchingFloor = true;
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
	// touching something for a short stretch of time, not just one lucky
	// frame, before it is marked settled.
	let speed = length(p.vel);
	let isResting = speed < 8.0 && (touchingFloor || contactCount > 0.0);
	var restTimer = particlesRead[index].restTimer;
	if (isResting) {
		restTimer = min(restTimer + params.dt, 1.0);
	} else {
		restTimer = 0.0;
	}
	p.restTimer = restTimer;
	p.settled = select(0.0, 1.0, restTimer > 0.12);

	// A hard hit overrides the resting check above: force this particle
	// back into the active set (from the next iteration/step onward),
	// regardless of how "resting" it still looks this pass, since it was
	// frozen and so hasn't actually moved to reflect the impact yet.
	if (forcedWake) {
		p.settled = 0.0;
		p.restTimer = 0.0;
	}

	particlesWrite[index] = p;
}

struct VertexOut {
	@builtin(position) position: vec4<f32>,
	@location(0) localCoord: vec2<f32>,
	@location(1) settled: f32,
	@location(2) brightness: f32,
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
	out.brightness = p.brightness;
	return out;
}

@fragment
fn fragmentMain(in: VertexOut) -> @location(0) vec4<f32> {
	let dist = length(in.localCoord);
	if (dist > 1.0 / 1.4) { discard; }
	return vec4<f32>(0.98, 0.97, 0.93, in.brightness);
}
