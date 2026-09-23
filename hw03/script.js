function onLoad() {
    getData(playBunch);
}

function getData(f) {
    fetch('xeno_canto.json')
    .then(response => response.json())
    .then(data => f(data));
}

function playBunch(data) {
    let n = 10;
    for (let i = 0; i < n; i++) {
        playRandom(data);
    }
}

function playRandom(data) {
    let i = Math.floor(Math.random() * data.numRecordings);
    let recording = data.recordings[i];
    console.log(i);
    play(recording);
}

async function play(recording) {

    const audioCtx = new AudioContext();
    const url = recording.file;
    
    const audio = new Audio(url);
    audio.loop = true;

    // const source = audioCtx.createMediaElementSource(audio);
    // source.connect(audioCtx.destination);
    
    // Source - https://stackoverflow.com/a/68594674
    // Posted by Pranavan, modified by community. See post 'Timeline' for change history
    // Retrieved 2026-09-21, License - CC BY-SA 4.0
    audio.addEventListener("canplaythrough", () => {
        audio.play().catch(e => {
            window.addEventListener('click', () => {
                audio.play()
            }, { once: true })
        })
    });
}

window.addEventListener('load', onLoad);