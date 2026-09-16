const text = document.querySelector("#text");
const body = document.body;

const spaceNeeded = 100;
const minScale = 0.15;

let need = "space";
let space = 0;
let impatience = 0;
let approachTimer;
let pauseTimer;
let needsMet = false;

function needs(newNeed) {
    need = newNeed;
    text.textContent = `i need ${need}`;
}

function move() {
    const scale = 1 - (space / spaceNeeded) * (1 - minScale);
    text.style.transform = `scale(${scale})`;
}

function withdraw() {
    space += 10;
    space = Math.min(space, spaceNeeded);
    move();
}

function confront() {
    space -= 15;
    space = Math.max(0, Math.min(space, spaceNeeded));
    move();

    text.classList.remove("flash");

    requestAnimationFrame(() => {
        text.classList.add("flash");
    });
}

function approach(delay = 100) {
    approachTimer = setTimeout(() => {
        impatience = Math.max(impatience - 0.5, 0);
        space = Math.max(space - 0.3, 0);

        move();

        if (space === 0 && impatience === 0) {
            release();
        } else if (need === "time") {
            approach();
        }
    }, delay);
}

function freeze() {
    clearTimeout(approachTimer);
    clearTimeout(pauseTimer);

    impatience += 34;

    if (impatience >= 100) {
        impatience = 0;
        needs("space");
        return;
    }

    pauseTimer = setTimeout(() => approach(0), 2500);
}

function release() {
    needsMet = true;
    clearTimeout(approachTimer);
    clearTimeout(pauseTimer);
    body.classList.add("complete");

    setTimeout(() => {
        needs("you");
    }, 2000);
}


function react(event) {
    if (event.key === " ") {
        withdraw();
    } else {
        confront();
    }

    if (space === spaceNeeded) {
        needs("time");
        pauseTimer = setTimeout(() => approach(0), 2750);
    }
}

function handleKeydown(event) {
    if (needsMet) return;

    if (need === "time") {
        freeze();
    } else {
        react(event);
    }
}

function setup() {
    needs("space");
    document.addEventListener("keydown", handleKeydown);
}

setup();
