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