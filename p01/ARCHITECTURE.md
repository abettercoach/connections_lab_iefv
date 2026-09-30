# P01 Structure

A poem-driven piece: the fixed sky over Ponce, Puerto Rico appears on a black
disk, falls off it into a pile, and the visitor drags each star back to where
it belongs while a poem unfolds in the page margins.

Play it at `piece.html`. There is also a standalone debug page,
`interaction-pile-test.html`, used throughout development to test physics
changes in isolation from the story/audio/poem system - see "The debug page"
below.

## Fixed sky

- Place: Ponce, Puerto Rico (`18° N`, `66° 37′ W`)
- Moment: June 2, 2019, 10:00 p.m. Atlantic Standard Time (== June 3, 2019,
  02:00 UTC)
- The sky snapshot and each star's on-disk target position are computed once,
  from `stars.json` (a catalog of right ascension/declination/magnitude/
  temperature records), and never change after that. Only stars above the
  horizon at that exact moment are included.
- Target positions are stored relative to the disk's own center/radius, so
  resizing the window rescales the whole sky without changing where any star
  belongs.

## Files and responsibilities

| File | Owns | Does not own |
| --- | --- | --- |
| `poem.js` | The poem's text and its cues, as plain data (`POEM_BEATS`) | Rendering, timing, DOM |
| `story.js` | Which beat the visitor is currently on, and moving forward/backward through beats | Drawing, audio, what a cue *does* |
| `margins.js` | Rendering the current beat's lines into the page margin | Story progression, cue effects |
| `scene-director.js` | Translating a cue name into real calls against the disk, pile, and audio | Poem text, beat sequencing |
| `disk-entrance.js` | The disk's two-stage entrance/exit animation (CSS class toggles only) | Star physics, story sequencing |
| `pile.js` | The WebGPU fall/pile/drag-to-place simulation and renderer | Story, audio, when things are allowed to happen |
| `audio.js` | Loading xeno-canto recordings and playing them (ambient + placement) | Deciding *when* to play, or whether a placement is correct |
| `piece.js` | Wiring the above together: startup sequencing, click/keyboard input | Any rendering, physics, or audio logic of its own |

Each file's own header comment explains its concerns in more depth; this
table is only the map between them.

## How a cue flows through the system

`piece.js` boots everything, then the visitor drives the rest by clicking (or
pressing an arrow key) to move through `POEM_BEATS`:

1. `story.js`'s `advanceStory()`/`retreatStory()` move `storyState.beatIndex`
   forward or back by one.
2. `margins.js`'s `renderMarginText()` shows the new beat's lines.
3. For each cue name on that beat (e.g. `'reveal-disk'`), `piece.js` calls
   `scene-director.js`'s `applyCue()` (moving forward) or `undoCue()` (moving
   back). `undoCue()` is a parallel `switch` to `applyCue()`, run in reverse
   cue order when leaving a beat, so backward navigation fully reverses
   whatever the forward cue did (disk shown/hidden, audio started/stopped,
   etc.) rather than only changing the displayed text.
4. `applyCue()`/`undoCue()` are the only place that calls into
   `disk-entrance.js`, `pile.js`, or `audio.js` - `story.js`, `poem.js`, and
   `margins.js` never do.

The cue vocabulary (see `poem.js`'s header comment for the authoritative
list): `'fade-audio-in'`, `'reveal-disk'`, `'shatter'`, `'begin-interaction'`.

The opening beat's cue is a special case: browsers block `audio.play()`
until the visitor's first interaction with the page, so `piece.js` defers
applying it until the first `pointerdown`/`keydown`, rather than at load.

## The pile simulation (`pile.js` / `interaction-pile.wgsl`)

A WebGPU compute shader steps every star's position each frame (gravity,
floor/wall collision, pairwise overlap resolution via a spatial grid); a
render pipeline in the same `.wgsl` file draws them as soft-edged glowing
points. Concerns inside `pile.js` are kept in the order data flows through
them each frame:

- **Physics bridge** - GPU buffer layout, step encoding, and the one place JS
  writes a dragged particle's position into the sim.
- **Placement** - what "correct" means for a drop, hit-testing, and the
  pick/drag/drop state machine. Knows nothing about WebGPU or drawing.
- **Animation/rendering (2D overlay)** - the breathing target/drag
  indicators. Reads placement state, never writes it.

A star's identity (its target position, brightness, and temperature) is kept
entirely on the JS side and only ever read by the shader for rendering -
physics has no notion of "this particle is a star."

### Notable per-star rendering details

- **Brightness** drives each star's rendered size and glow, matching how a
  faint star should look barely-there and a bright one prominent.
- **Temperature** (`stars.json`'s `K`/Kelvin field, normalized 0-1 by
  `starTemperatureFraction()`) tints each star along a
  warm/neutral/cool gradient (`starColorForTemperature()` in the shader) -
  an aesthetic approximation, not a real blackbody-radiation model.
- **`starsAlwaysLight`** is a page-level (not per-star) uniform flag: `1.0`
  in `pile.js` keeps a fallen star white forever, since the real piece's page
  background stays black for the whole experience; `0.0` in
  `interaction-pile-test.js` preserves that page's original behavior (white
  within the disk, black once fallen, against its own white page).
- A star being dragged or freshly placed is temporarily boosted to full
  brightness as placement feedback (see `highlightedBrightness()`), easing
  back down to its true brightness as more of the sky is rebuilt.

### A WGSL struct-alignment pitfall worth remembering

WGSL pads a struct's size up to a multiple of its largest member's alignment
- the `Particle` struct's `vec2<f32>` fields force 8-byte alignment, so its
real size is always a multiple of 8 bytes even if you don't ask for that.
Adding one lone `f32` field to a struct that was already a clean multiple of
8 bytes pushes its *padded* size up further than the field itself accounts
for - if the JS-side buffer's per-particle stride (`PARTICLE_FLOATS`) isn't
updated to match that padded size exactly, every particle after the first
gets read from the wrong offset (this happened once; the fix was an explicit
`_pad0: f32` field in the struct and bumping `PARTICLE_FLOATS` to match, so
the WGSL struct's true size and the JS stride can never silently drift apart
again).

## Audio (`audio.js`)

Two independent uses share this file, since both are fundamentally "pick some
recordings from `xeno_canto.json` and play them," but they're kept as
separate function pairs since their playback rules differ:

- **Placement sound** - a single random recording, played once, on a correct
  drop. Triggered via `pile.js`'s `setOnStarPlaced(callback)` hook (wired up
  in `piece.js`), so `pile.js` never has to know xeno-canto exists.
- **Ambient soundscape** - several random recordings, looped and layered
  together, eased in (`fadeInAmbientSoundscape()`) when the disk first
  appears and faded out (`fadeOutAmbientSoundscape()`, not a hard cut) the
  moment the sky shatters.

Both draw only from `nighttimeRecordings()` - recordings xeno-canto logged
with a local clock time before 6:00 a.m. or at/after 6:00 p.m. (a plain
hour cutoff, not a real sunrise/sunset calculation; a recording with a
missing or unparseable time is dropped rather than guessed at).

## The debug page

`interaction-pile-test.html`/`.css`/`.js` is a standalone page, independent of
the poem/story/audio system, used to test pile physics changes safely without
touching the real piece. It has its own toggle-button UI (fall/reset) instead
of story-driven cues, and keeps the sky disk's *original* look (white stars
within the disk, black dust once fallen, against a plain white page) rather
than the real piece's permanently-dark page. Its astronomy math (RA/Dec
parsing, sidereal time, alt-az projection) is duplicated from `pile.js` rather
than shared, since the two files are meant to be able to change independently
of each other.

## Retired experiments

Two earlier prototypes were tried and abandoned before the current WebGPU
compute-shader pile; their code has been removed; their lessons are recorded
here so they aren't relearned by accident.

### Matter.js 2D physics (retired)

A 2D rigid-body physics engine (Matter.js), driving falling/colliding/piling
stars with drag-to-place layered on top.

**What worked and carried forward:** keeping a star's identity (target
position, brightness) independent of its physics body; gating who's allowed
to move a star by an explicit state (`in-sky` / `falling` / `pile` /
`dragging` / `placed`); dragging by setting position directly under the
pointer (kinematic control) rather than injecting velocity/force; running the
physics loop on a fixed-step accumulator that never silently drops leftover
time; explicitly re-activating anything resting on a star that gets picked
back up (a real contact/support check, not "moved recently"); zeroing a
released star's velocity/force/torque before re-enabling gravity, to avoid
flinging it from residual drag state.

**What didn't work:** assigning rest positions geometrically (grid
cells/columns) read as "arranged," not "piled" - a pile's shape has to emerge
from collision. Solver tuning (`restitution`, `friction`, iteration count)
reduced but never eliminated a springy, rigid-ball settling artifact - it
never read as sand. Performance was the real blocker: Matter.js is
CPU-only/single-threaded, and the fixed sky's several-thousand above-horizon
stars, all colliding, was too slow. A hybrid of ~500 real physics bodies plus
non-colliding free-falling "dust" solved the frame-rate problem but was
rejected on visual grounds - the two populations read as visibly different
materials with a legible seam between them, since real collisions produce
natural irregular resting angles that uniform non-colliding dust can't
reproduce.

**Standing conclusion:** the identity/state-separation pattern was worth
keeping; 2D CPU rigid-body physics at thousands-of-bodies scale was not the
right tool.

### WebGPU fall/pile-only spike (retired)

Before drag-and-place existed, an earlier WebGPU prototype
(`compute-pile-test.js`/`.html`/`.css`, `compute-pile.wgsl`) proved that
thousands of uniform particles falling and piling under a compute shader,
with real pairwise collision via a spatial grid, look organic and run at
frame rate - all particles through the same update, at the same fidelity, in
parallel, directly avoiding the earlier "two visibly different materials"
seam. Once that held up, drag/placement mechanics were layered on directly
into what's now `interaction-pile-test.js`, and this fall-only spike was
superseded and removed.
