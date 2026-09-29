# P01 Structure Draft

This is a working outline for discussion. It does not change the running sketch.

## Fixed Sky

- Place: Ponce, Puerto Rico (`18° N`, `66° 37′ W`)
- Moment: June 2, 2019, 10:00 p.m. Atlantic Standard Time
- UTC equivalent: June 3, 2019, 02:00 UTC
- The sky snapshot and its target positions do not change after they are created.

The sky model owns catalog parsing, astronomy, and target positions. It does not
own how stars fall, how a user drags them, or how the story unfolds. Target
positions should be stored relative to the disk so resizing the canvas does not
change where a star belongs.

## Responsibilities

| Concern | Owns | Does not own |
| --- | --- | --- |
| Story | Poem, sequence of scenes, cues to reveal or begin an event | Drawing or star coordinates |
| Sky data | Catalog loading, coordinate parsing, fixed Ponce snapshot | Animation or interaction state |
| Placement | Tokens, destinations, drag state, correct-placement checks | How tokens look or move |
| Animation | Disk entrance, falling motion, target pulses | Catalog data or story text |
| Rendering | Drawing the current scene, disk, stars, tokens, and targets | Deciding story progression or placement correctness |
| Audio | Loading recordings and playing a random recording on placement | Deciding whether a token is correctly placed |

The visual form of a falling piece is intentionally undecided. A token can
eventually be drawn as a dust-like star or as a larger shard without changing
the sky snapshot or placement rules.

## Function Shapes

These are signatures only, not implementations. Names and boundaries are open
for revision.

### Entry and Story

```js
function setup() {}
function draw() {}
function createInitialStoryState() {}
function advanceStory(storyState, event) {}
```

`setup()` prepares data and state; `draw()` delegates rendering. Story events
can reveal the disk, reveal stars, show poem lines, or begin the fall.

### Data and Sky

```js
async function loadStarCatalog(url) {}
function parseStarCatalog(records) {}
function createSkySnapshot(stars, observer, instant) {}
function projectStarToDisk(star, observer, instant) {}
```

`createSkySnapshot()` runs once for the fixed place and moment. It returns
stable star identities, magnitudes, and positions relative to the disk.

### Placement and Interaction

```js
function createPlacementState(skySnapshot) {}
function beginStarDrag(pointer, placementState) {}
function moveStarDrag(pointer, interactionState) {}
function finishStarDrag(pointer, interactionState, placementState) {}
function isStarAtItsTarget(star, placementState) {}
```

The placement model records which stars are in the sky, falling, in the pile,
being dragged, or placed. Interaction changes that state; it does not calculate
astronomical positions.

### Animation and Rendering

```js
function updateFallAnimation(tokens, elapsedMilliseconds) {}
function updateTargetPulse(target, elapsedMilliseconds) {}
function drawDisk(sceneState) {}
function drawSky(snapshot, sceneState) {}
function drawFallingTokens(tokens) {}
function drawPlacementTargets(placementState, elapsedMilliseconds) {}
```

Animation updates visual motion. Rendering reads the current state and draws
it; neither layer decides the next story event.

### Audio

```js
async function loadRecordings(url) {}
function playRandomPlacementRecording(recordings) {}
```

The placement flow requests a sound after a star is placed. Audio selection
and playback stay outside the placement rules.

## Open Questions

- Does the falling token remain a dot, or become a shard carrying its star?
- Should poetry and scene cues be represented as ordered data, or as explicit
  story-state transitions?
- How should these responsibilities map to files while keeping p5's current
  global `setup()` / `draw()` entry points straightforward?

## Experiment Log: Matter.js Falling Pile (retired)

Prototyped in `interaction-test.js` / `.html` / `.css`, uncommitted, on `main`.
This experiment is now closed; its findings carry forward, but its code is not
the basis for the next attempt.

### What we were testing

Whether a 2D physics engine (Matter.js 0.20.0, loaded via CDN alongside p5)
could drive falling, colliding, pile-forming stars, with drag-to-place
interaction layered on top, while keeping placement/target logic separate
from physics state.

### What worked

- **Separation held up.** Star identity (`id`, `target`, `magnitude`) stayed
  independent of the physics body; a star's `state` (`in-sky` / `falling` /
  `pile` / `dragging` / `placed`) cleanly gated which system (physics vs.
  placement) was allowed to move it. This is the pattern worth keeping.
- **Kinematic dragging.** Making the grabbed body `static` (or, later, a
  velocity-driven kinematic move rather than a spring constraint) and setting
  its position directly under the pointer avoided injecting artificial
  velocity/acceleration into the grabbed star. Position-driven dragging, not
  force-driven dragging, is the right model for "the star should only ever
  move exactly where the mouse is."
- **Physics loop must not silently drop time.** An early version capped the
  physics accumulator and discarded leftover elapsed time once it hit a max
  step count; under real frame rates this made gravity look artificially
  slow/floaty. Fix: accumulate real elapsed time and spend it in fixed steps
  without throwing the remainder away.
- **Support-based wake logic.** When a star is picked up out of the pile,
  anything resting on it needs to be explicitly un-slept/reactivated, or it
  will hang in the air with nothing under it. This has to be a real
  contact/support check (touching another body or the floor), not merely
  "moved recently," or falling stars can be marked settled while still
  mid-air.
- **Zero-velocity release.** On an incorrect drop, explicitly zeroing a body's
  velocity, angular velocity, force, and torque before re-enabling gravity is
  necessary — otherwise residual state from the drag can fling the star.

### What did not work / had to be abandoned

- **Constructed pile shapes look artificial.** Assigning stars to grid
  cells/columns as their rest destination reads as "arranged," not "piled."
  Any approach where a token's resting position is computed geometrically
  (rather than emerging from collision) will likely read the same way.
- **Solver tuning could not fully remove jiggle.** Multiple rounds of
  adjusting `restitution`, `friction`, `frictionStatic`, `slop`, and solver
  iteration counts reduced but did not eliminate a springy "sticky bouncy
  ball" settling artifact. Matter's own guidance (increase iterations, zero
  restitution everywhere including static boundaries, rely on sleeping) helped
  but the material never read as sand/salt — it read as small rigid balls
  settling with some elasticity, which is a solver quality inherent to a
  general 2D rigid-body engine at this contact density, not a mistunable bug.
- **Performance is the hard blocker.** Matter.js is CPU-only, single-threaded,
  and its collision/solver cost is combinatorial in the number of touching
  bodies. The full catalog for the fixed Ponce sky is on the order of several
  thousand above-horizon stars; running all of them as colliding circles at
  once was too slow to be usable.
- **Hybrid "physics stars + non-colliding dust" was rejected on visual
  grounds**, not performance grounds — it did solve the frame-rate problem
  (only ~500 bodies in Matter, the rest as simple non-colliding free-fall
  particles that settle against a height map), but the two populations read
  as visibly different materials next to each other: an obvious, distracting
  seam rather than one convincing pile. Concretely: real collisions produce
  natural-looking irregular resting angles and inter-particle gaps; the
  non-colliding dust settled too uniformly/predictably by comparison, and the
  boundary between the two was legible to the eye. This is worth remembering
  if a future approach again considers mixing simulation fidelities within a
  single visible pile — the two materials need to be visually
  indistinguishable, or the split shouldn't run through the middle of one
  contiguous pile.

### Standing decision

Matter.js is out. The instinct that a small physics-ish library should own
falling/settling/collision, while p5 (or another renderer) owns drawing and
story/placement stays separate, remains correct — it is specifically 2D
rigid-body CPU physics at thousands-of-bodies scale that does not fit here.

## Plan: Compute-Shader Approach (next experiment)

Goal: thousands of tiny falling/piling particles, uniform simulation fidelity
across all of them (no visible seam), running on the GPU, with the same
identity/state separation that worked before (a particle's astronomical
identity and target stay outside the simulation).

### Why a compute shader instead of Matter.js

- All particles run through the *same* update, at the same fidelity, in
  parallel — this directly avoids the "two visibly different materials" seam
  from the hybrid attempt.
- Thousands of small circular particles falling under gravity with simple
  local collision response is a textbook GPU particle-simulation problem:
  data-parallel, no need for a general rigid-body solver (no rotation,
  torque, or arbitrary shapes — stars are simple particles).

### Technology choice to make first

p5.js 2.3.x has WebGL2-based support for `createFramebuffer()` and, in newer
builds, experimental shader-based compute via `createFilterShader()` /
frame-buffer ping-ponging (fragment-shader compute, not true `GLSL` compute
shaders — WebGL2 has no compute shader stage). True compute shaders
(`GL_COMPUTE_SHADER`) require WebGPU, not WebGL. Before writing any shader
code we need to decide:

1. **WebGPU** (real compute shaders, `wgsl`, `GPUComputePipeline`) — best
   performance and the "actual" compute-shader approach, but browser support
   and p5 integration are both immature; would likely mean stepping outside
   p5 for the simulation layer and only using p5 (or plain canvas/WebGL) to
   draw the result.
2. **WebGL2 fragment-shader-as-compute** (store particle state in textures,
   update via a fragment shader each frame, read back via
   `p5.Framebuffer`) — more broadly supported today, works inside p5's
   existing WebGL renderer, but is more awkward to write and debug than a
   real compute shader.

This choice should be made deliberately, with a quick feasibility check of
current browser/p5 support, before committing to an implementation.

### Proposed shape of the simulation (engine-agnostic)

- **Particle state buffer(s):** position (x, y), velocity (x, y), radius,
  "settled" flag — packed into a texture or GPU buffer, one texel/element per
  star, indexed by the same `id` used in the sky snapshot.
- **Per-step update (runs identically for every particle):**
  - integrate gravity into velocity, velocity into position;
  - resolve collisions/support only against nearby particles (a coarse
    spatial grid encoded as a second texture, or a fixed neighbor radius
    check) and against the floor/walls;
  - on tiny residual motion with support, mark settled (a data flag, not a
    remove-from-world step — everything always stays in the buffer since GPU
    buffers don't support arbitrary insertion/removal well).
- **CPU/JS side keeps:** star identity, target position, `state` (`in-sky`,
  `falling`, `pile`, `dragging`, `placed`) exactly as before — the GPU only
  ever sees "is this particle currently simulated," not astronomy or
  placement rules.
- **Dragging:** the currently-held particle's position is written directly
  into the buffer from the pointer each frame (a targeted single-element
  write), the same "kinematic control, not force," lesson carried over from
  the Matter experiment.
- **Read-back:** we need the position of at least the dragged/hit-tested
  particle on the CPU every frame (for `starAtPointer` and placement checks).
  Full read-back of thousands of particles every frame can be a bottleneck in
  WebGL2 (`readPixels` is slow); this needs an explicit strategy — e.g. only
  read back a bounded pointer-proximity region, or maintain hit-testing
  entirely on GPU via a picking pass.

### Suggested first steps, in order

1. Decide WebGPU vs. WebGL2-texture-compute (quick spike/feasibility check,
   not full implementation) — output: a short recommendation before writing
   the simulation.
2. Build an isolated prototype (new file(s), same pattern as
   `interaction-test.*`) that only proves falling + piling of thousands of
   uniform particles look organic and run at frame rate — no drag, no
   placement, no astronomy yet.
3. Layer picking/dragging back in once the pile itself looks right.
4. Reconnect to the real sky snapshot, target positions, and placement rules
   last, exactly as this retired experiment did.
5. Start a new git branch for this attempt, keeping the Matter.js prototype's
   commit history (if any) or this document as the reference for what not to
   repeat.

### Open questions before implementation starts

- WebGPU or WebGL2 fragment-shader compute — acceptable to prototype in
  WebGPU even though its browser support is narrower than WebGL2's?
- Do we need real per-particle collision (particles push each other) for the
  "organic pile" look, or can a cheaper per-particle-vs-heightfield approach
  (each particle only checks the local pile surface height, updated from the
  simulation itself rather than approximated) reach the same visual result at
  far lower complexity than full pairwise collision?
- What is the realistic upper bound on particle count we actually need
  (exact catalog size for the fixed Ponce snapshot), so performance targets
  are concrete rather than "as many as possible"?