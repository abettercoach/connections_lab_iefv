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
	// True while the user is dragging this particle. JS writes pos directly
	// each frame (see interaction-pile-test.js); physics never moves a
	// picked particle itself, but it still collides with (and can nudge)
	// everything around it, same as a settled particle would.
	picked: f32,
	// True once correctly placed. Like settled, but permanent: a placed
	// particle never wakes back up, even from a hard nearby impact.
	placed: f32,
	// This star's correct on-disk position (its position before falling).
	// Physics never reads this; JS uses it only to judge a drop's placement.
	targetPos: vec2<f32>,
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
	// The fixed sky disk's on-screen circle. Physics never reads these
	// (falling stars pass straight through the disk's edge); fragmentMain
	// uses them only to decide a star's rendered color: white within the
	// disk, black once it has fallen outside it.
	diskCenterX: f32,
	diskCenterY: f32,
	diskRadius: f32,
	// A live multiplier on each star's brightness before it drives the
	// halo/core alpha in fragmentMain (see starSizeFor()/fragmentMain()) -
	// purely a display/testing aid for judging drag/placement feedback,
	// not a property of the star data itself. 1.0 reproduces script.js's
	// original brightness exactly.
	brightnessBoost: f32,
	// How much of the sky has been correctly rebuilt so far: placed stars
	// / total stars, 0 at the start of the interaction and 1 once every
	// star is home. Drives the "sparse -> full" brightness curve for
	// p.placed stars only (see placedBrightnessExponent()) - unplaced
	// stars ignore this entirely.
	progress: f32,
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

// Settled, picked, and placed particles are all "frozen": integrate() does
// not move them, and resolve() does not let neighbors' corrections push
// them around either - only a frozen particle's neighbors give way. What
// differs between the three is only whether (and how) a particle leaves
// this state; see isWakeable() and resolve() below.
fn isFrozen(p: Particle) -> bool {
	return p.settled > 0.5 || p.picked > 0.5 || p.placed > 0.5;
}

// Only a merely-settled particle (piled, but not being dragged and not yet
// correctly placed) can be jarred back into falling by a hard impact. A
// picked particle is controlled by JS, not physics; a placed particle is
// meant to stay put once correctly positioned.
fn isWakeable(p: Particle) -> bool {
	return p.settled > 0.5 && p.picked < 0.5 && p.placed < 0.5;
}

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
// A frozen particle (settled, picked, or placed - see isFrozen()) is
// skipped here entirely (no gravity, no motion): a settled/placed particle
// acts as a stable, immovable base for the pile instead of being nudged
// downhill by residual solver error every single step; a picked particle's
// position is instead being written directly by JS each frame, tracking
// the pointer, and must not be overwritten by gravity while held.
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
	if (!isFrozen(p)) {
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
	let selfFrozen = isFrozen(p);
	let selfWakeable = isWakeable(p);

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
						let otherFrozen = isFrozen(other);

						if (selfFrozen) {
							// A frozen particle only reconsiders its rest if it
							// is wakeable (merely settled, not picked/placed)
							// and an active neighbor hits it hard enough (see
							// WAKE_OVERLAP_FRACTION); otherwise it contributes no
							// correction this pass, letting it act as a stable
							// base instead of being nudged by every neighbor's
							// residual solver error. Contact is still counted
							// so the resting check below doesn't mistake this
							// stillness for having lost support.
							if (selfWakeable && !otherFrozen && overlap > p.radius * WAKE_OVERLAP_FRACTION) {
								forcedWake = true;
							}
							contactCount = contactCount + 1.0;
						} else {
							var normal = coincidentPairNormal(index, otherIndex);
							if (dist > 0.0001) {
								normal = delta / dist;
							}
							// A frozen neighbor won't apply its own share back
							// (it doesn't move), so this particle must absorb
							// the full overlap against it instead of the usual
							// half; against an unfrozen neighbor, both sides
							// still split it evenly so they separate fully
							// without a race.
							let shareFactor = select(0.5, 1.0, otherFrozen);
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

	if (contactCount > 0.0 && !selfFrozen) {
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
	// frame, before it is marked settled. Skipped while picked or placed,
	// so holding a dragged particle still doesn't quietly flip it settled
	// (it would then need to be explicitly un-settled to fall again) - it
	// naturally recomputes from real motion the moment picked goes false.
	if (p.picked < 0.5 && p.placed < 0.5) {
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
	}

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
	// In pixels, relative to this star's own center - not normalized -
	// so fragmentMain can compare distances directly against starSize
	// below (matches script.js's draw_star(), which sizes its layered
	// circles in real pixels too).
	@location(0) localCoord: vec2<f32>,
	@location(1) settled: f32,
	@location(2) brightness: f32,
	// 1.0 while this star's own position is within the disk, 0.0 once it
	// has fallen outside it. Computed per-vertex from the same worldPos
	// used to place the quad, so it is exact at the star's center
	// regardless of how the quad's corners straddle the disk's edge.
	@location(3) insideDisk: f32,
	@location(4) starSize: f32,
	// Passed through so fragmentMain can gate the sparse->full progress
	// curve to correctly-placed stars only (see placedBrightnessExponent()).
	@location(5) placed: f32,
};

@group(0) @binding(0) var<storage, read> particlesForRender: array<Particle>;
@group(0) @binding(1) var<uniform> renderParams: Params;

// Mirrors script.js's draw_star(): starSize grows gently with brightness
// (a barely-visible star and the brightest star in the sky differ in size,
// not just alpha).
fn starSizeFor(brightness: f32) -> f32 {
	return 1.1 + brightness * 0.9;
}

// A straight multiply-then-clamp runs out of headroom fast: most stars'
// brightness is log-compressed and small, so x*boost saturates at 1.0
// only for stars that were already fairly bright, leaving dim stars dim
// no matter how high the exponent goes. Using it as an exponent instead
// (screen-blend style) keeps pushing dim stars towards 1.0 as it grows,
// without a hard ceiling on the brightness value itself.
fn boostedBrightnessFor(brightness: f32, exponent: f32) -> f32 {
	return 1.0 - pow(1.0 - brightness, exponent);
}

// A star that has just been dropped into its correct spot needs to read
// unmistakably - "yes, that's it" - regardless of how faint its true
// magnitude is, especially while only a handful of stars are placed and
// there is nothing else nearby to compare it against. As more of the sky
// is rebuilt, that same star eases back down to its true brightness, so
// the finished sky reads as the real, unevenly-lit night sky rather than
// a field of uniformly bright dots. Stars that were never picked up (the
// original, untouched disk view before Release) are not "placed" and
// always render at their true brightness - this curve is deliberately
// scoped to the placement feedback loop, not the whole sky.
const SPARSE_PLACED_BOOST: f32 = 14.0;
fn placedBrightnessExponent(placed: f32) -> f32 {
	let progressExponent = mix(SPARSE_PLACED_BOOST, 1.0, renderParams.progress);
	// The brightness slider stays available as a manual multiplier on top
	// of this automatic curve, for testing - see interaction-pile-test.js.
	return select(1.0, progressExponent, placed > 0.5) * renderParams.brightnessBoost;
}

// Once boostedBrightness saturates near 1.0, alpha has nowhere left to
// go - a pixel can't get more opaque than opaque. script.js's own glow
// reads as "brighter" past that point by widening the halo, not by
// trying to make already-white pixels whiter, so the extra brightness
// the boost adds (beyond the star's own unboosted brightness) grows the
// halo's radius instead. At exponent == 1 this is exactly zero, so the
// unboosted look is unchanged.
const HALO_GROWTH: f32 = 3.0;
fn haloRadiusMulFor(brightness: f32, exponent: f32) -> f32 {
	let extraGlow = boostedBrightnessFor(brightness, exponent) - brightness;
	return 1.1 + extraGlow * HALO_GROWTH;
}

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
	let starSize = starSizeFor(p.brightness);
	let brightnessExponent = placedBrightnessExponent(p.placed);
	let haloRadiusMul = haloRadiusMulFor(p.brightness, brightnessExponent);
	let quadHalfSize = starSize * haloRadiusMul + 1.5;
	let worldPos = p.pos + corner * quadHalfSize;
	let ndcX = (worldPos.x / renderParams.width) * 2.0 - 1.0;
	let ndcY = 1.0 - (worldPos.y / renderParams.height) * 2.0;

	let diskCenter = vec2<f32>(renderParams.diskCenterX, renderParams.diskCenterY);
	let distFromDiskCenter = length(p.pos - diskCenter);

	var out: VertexOut;
	out.position = vec4<f32>(ndcX, ndcY, 0.0, 1.0);
	out.localCoord = corner * quadHalfSize;
	out.settled = p.settled;
	out.brightness = p.brightness;
	out.insideDisk = select(0.0, 1.0, distFromDiskCenter <= renderParams.diskRadius);
	out.starSize = starSize;
	out.placed = p.placed;
	return out;
}

// A true radial falloff (Gaussian-ish, via smoothstep on distance/radius) -
// full alpha at the center, tapering continuously out to zero at radius,
// rather than a flat disk with only its rim feathered. That distinction
// matters once the halo is allowed to grow large (see haloRadiusMulFor):
// a flat disk with a thin feathered edge reads as a hard-edged ring once
// it's big enough for the eye to see the "plateau" in the middle, whereas
// a true gradient always looks like a glow.
fn radialGlowAlpha(distance: f32, radius: f32) -> f32 {
	return 1.0 - smoothstep(0.0, radius, distance);
}

fn softCircleAlpha(distance: f32, radius: f32, featherPx: f32) -> f32 {
	return 1.0 - smoothstep(radius - featherPx, radius, distance);
}

@fragment
fn fragmentMain(in: VertexOut) -> @location(0) vec4<f32> {
	let dist = length(in.localCoord);
	let feather = 1.0;
	let brightnessExponent = placedBrightnessExponent(in.placed);
	let boostedBrightness = boostedBrightnessFor(in.brightness, brightnessExponent);
	let haloRadiusMul = haloRadiusMulFor(in.brightness, brightnessExponent);

	// Brightness only matters as an in-sky glow (script.js's layered
	// halo + core circles, reproduced here): a dim star sits faint against
	// the night sky, same as the original piece. Once fallen outside the
	// disk, it is dust rather than a point of starlight, and reads clearly
	// against the page background only if fully opaque - so brightness no
	// longer modulates opacity out there, it is simply a solid dot.
	let haloAlpha = radialGlowAlpha(dist, in.starSize * haloRadiusMul) * (1.0 + boostedBrightness * 9.0) / 255.0;
	let coreAlpha = softCircleAlpha(dist, in.starSize * 0.5, feather)
		* min(1.0, (18.0 + boostedBrightness * 237.0) / 255.0);
	let insideDiskAlpha = max(haloAlpha, coreAlpha);
	// Dust (fallen, unplaced stars) always reads as a solid, slightly
	// larger dot regardless of brightness or progress - it's meant to look
	// unmistakably like a pile of dark matter, not a faint point of light.
	let outsideDiskAlpha = softCircleAlpha(dist, in.starSize * 0.9, feather);
	let alpha = mix(outsideDiskAlpha, insideDiskAlpha, in.insideDisk);
	if (alpha <= 0.0) { discard; }

	// White within the disk (a real star, seen against the night sky);
	// black once fallen outside it (dust, no longer "lit" by the sky it
	// belongs to). Output premultiplied (color * alpha): the canvas is
	// configured with alphaMode: 'premultiplied' (see interaction-pile-test.js)
	// so the disk backdrop canvas underneath shows through correctly.
	let color = mix(vec3<f32>(0.0, 0.0, 0.0), vec3<f32>(0.98, 0.97, 0.93), in.insideDisk);
	return vec4<f32>(color * alpha, alpha);
}

