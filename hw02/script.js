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
    text.addEventListener("animationend", clearAnimation);
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
    // Illusion of distance by adjusting the text's size based on the current space value
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

let impatience = 0;

function freeze() {
    beStill();
    releaseBreath();

    shrink();

    impatience = Math.min(impatience + 34, 100);
    let patience = impatience < 100;
    let closeish = space < spaceNeeded / 2;

    if (!patience && closeish) {
        impatience = 0;
        needs("space");
    } else {
        musterCourage();
    }
}

let pendingAnimation;

function animate(className) {
    cancelAnimationFrame(pendingAnimation);

    text.classList.remove("flash", "shiver");

    pendingAnimation = requestAnimationFrame(() => {
        text.classList.add(className);
    });
}

function snap() {
    animate("flash");
}

function shrink() {
    animate("shiver");
}

function clearAnimation(event) {
    if (event.animationName === "flashRed") {
        text.classList.remove("flash");
    }

    if (event.animationName === "shiver") {
        text.classList.remove("shiver");
    }
}

let readyNextStep;
let readyNextBreath;

function beStill() {
    clearTimeout(readyNextStep);
    readyNextStep = null;
}

function releaseBreath() {
    clearTimeout(readyNextBreath);
    readyNextBreath = null;
}

function musterCourage() {
    beStill();
    releaseBreath();
    firstStep();
}

function firstStep() {
    readyNextBreath = setTimeout(takeStep, 2750);
}

function takeStep() {
    readyNextStep = setTimeout(() => {
        impatience = Math.max(impatience - 0.5, 0); //reduce impatience
        space = Math.max(space - 0.3, 0); //reduce space

        move();

        let close = space === 0;
        let patient = impatience === 0;

        if (close && patient) {
            needsMet = true;
            relax();
        } else if (need === "time") {
            takeStep();
        }
    }, 100);
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
