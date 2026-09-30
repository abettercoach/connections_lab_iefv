// Poem data only - no rendering, no timing, no DOM. Each beat is one step of
// the click-to-advance story (see story.js): its lines are what appears in
// the margins, and its cues are the abstract scene events that fire when the
// visitor advances onto it (see scene-director.js for what a cue actually
// does).
//
// Cue vocabulary (kept intentionally small and named for *what happens*,
// not *how*):
//   'fade-audio-in'      - the ambient soundscape starts, easing up from
//                          silence (not an instant start)
//   'reveal-disk'        - the black sky disk animates onto the page, and
//                          the fixed Ponce sky's stars appear on it, settled,
//                          at the same moment (see scene-director.js)
//   'shatter'            - the stars fall off the disk into the pile; the
//                          ambient soundscape fades out (not a hard cut)
//   'begin-interaction'  - dragging/placing becomes possible

const POEM_BEATS = [
	{
		lines: [
			'June 2, 2019',
			'It was dark in PR when',
			'I came out to my parents as Iris'
		],
		cues: ['fade-audio-in']
	},
	{
		lines: [
			'these were the stars over my childhood home,',
			'that night my spouse and I travelled',
			'from our home in New York to my parents\' in Minnesota,',
			'to tell them we were queer and we were married.'
		],
		cues: ['reveal-disk']
	},
	{
		// Two stanzas shown together as one beat.
		lines: [
			'It took me years to accept that they',
			'came out to us the same night too, as bigots',
			'',
			'heaven fell atop a felled home',
			'and the song that put my child self to sleep',
			'turned awful silent'
		],
		cues: ['shatter']
	},
	{
		// Four stanzas shown together as one beat - the poem keeps going
		// in the margins while the visitor is free to drag stars.
		lines: [
			'we flew at night',
			'from East to Midwest',
			'but the stars in my heart',
			'have always twinkled above',
			'Ponce',
			'',
			'the spirit of Boriké is coolest',
			'between sunset and sunrise',
			'after the coquí calls',
			'before the gallo sings',
			'',
			'can you help me pick up',
			'the night sky?',
			'',
			'can you help me recall',
			'the music of my dreams?'
		],
		cues: ['begin-interaction']
	}
];

