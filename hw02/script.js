const text = document.querySelector("#text");
const body = document.body;

let need, needsMet, space, spaceNeeded;

function setup() {
    needsMet = false;
    space = 0;
    needs("space");
    spaceNeeded = 100;

    listen();
}

function needs(newNeed) {
    need = newNeed;
    text.textContent = `i need ${need}`;
}

function listen() {
    document.addEventListener("keydown", react);
}

function react(event) {
    if (needsMet) return;

    if (need === "space") {
        if (givenSpace(event.key)) {
            withdraw();
        } else {
            confront();
        }
    } else if (need === "time") {
        freeze();
    }
}

function givenSpace(key) {
    return key === " ";
}

function withdraw() {
    space += 10; //Increase space 
    space = Math.min(space, spaceNeeded); //Keeps space from going over the max value
    move();

    let enoughSpace = space === spaceNeeded;
    if (enoughSpace) {
        needs("time");
        musterCourage();
    }
}

function move() {
    // Illusion of distance by adjusting the text's position based on the current space value
    const minScale = 0.15;
    const scale = 1 - (space / spaceNeeded) * (1 - minScale);
    text.style.transform = `scale(${scale})`;
}

function confront() {
    space -= 15;
    space = Math.max(0, Math.min(space, spaceNeeded)); //Keeps space within the range of 0 to spaceNeeded
    move();
    snap();
}

function snap() {
    text.classList.remove("flash", "shiver");

    requestAnimationFrame(() => {
        text.classList.add("flash");
    });
}

let impatience = 0;

function freeze() {
    beStill();
    releaseBreath();

    shrink();

    impatience += 34;
    let patience = impatience < 100;
    let closeish = space < spaceNeeded / 2;

    if (!patience && closeish) {
        impatience = 0;
        needs("space");
    } else {
        //If still patient or far enough, keep approaching after a pause
        musterCourage();
    }
}

function shrink() {
    text.classList.remove("shiver", "flash");

    requestAnimationFrame(() => {
        text.classList.add("shiver");
    });
}

let approachTimer;
let breathTimer;

function beStill() {
    clearTimeout(approachTimer);
    approachTimer = null;
}

function releaseBreath() {
    clearTimeout(breathTimer);
    breathTimer = null;
}

function musterCourage() {
    beStill();
    releaseBreath();
    takeBreathAnd(approach);
}

function takeBreathAnd(callback) {
    breathTimer = setTimeout(() => callback(0), 2750);
}

function approach(delay = 100) {
    approachTimer = setTimeout(() => {
        impatience = Math.max(impatience - 0.5, 0); //reduce impatience
        space = Math.max(space - 0.3, 0); //reduce space

        move();

        let close = space === 0;
        let patient = impatience === 0;

        if (close && patient) {
            needsMet = true;
            relax();
        } else if (need === "time") {
            approach();
        }
    }, delay);
}

function relax() {
    beStill();
    releaseBreath();

    body.classList.add("complete");

    setTimeout(() => {
        needs("you");
    }, 2000);
}

setup();
