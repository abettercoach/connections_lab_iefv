let star_coords;
let brightest_magnitude;
let star_glows = [];
let pointer_ripples = [];
let last_pointer_x = null;
let last_pointer_y = null;
let pointer_travel_since_ripple = 0;

const RIPPLE_SPACING = 42;
const RIPPLE_SPEED = 320;
const RIPPLE_WIDTH = 8;
const RIPPLE_INTENSITY = 0.36;
const MAX_ACTIVE_RIPPLES = 15;

async function setup() {
    createCanvas(windowWidth, windowHeight);
    star_coords = await fetch_data();
}

function draw() {
    background(255);
    if (!star_coords) return;

    let observer = observerCoords();
    let localSiderealTime = siderealTime(observerTime(), observer.lon);
    let centerX = width / 2;
    let centerY = height / 2;
    let diskRadius = min(width, height) * 0.44;
    let currentMillis = millis();

    pointer_ripples = pointer_ripples.filter(ripple =>
        currentMillis - ripple.startedAt < (2 * diskRadius / RIPPLE_SPEED) * 1000 + 600
    );

    noStroke();
    fill(4, 7, 16);
    circle(centerX, centerY, diskRadius * 2);

    drawingContext.save();
    drawingContext.beginPath();
    drawingContext.arc(centerX, centerY, diskRadius, 0, TWO_PI);
    drawingContext.clip();
    draw_stars(observer, localSiderealTime, centerX, centerY, diskRadius, currentMillis);
    drawingContext.restore();

    noFill();
    stroke(115, 139, 174, 190);
    strokeWeight(1.25);
    circle(centerX, centerY, diskRadius * 2);

}

function windowResized() {
    resizeCanvas(windowWidth, windowHeight);
}

function mouseMoved() {
    emitRipplesAlongPointer();
}

function mouseDragged() {
    emitRipplesAlongPointer();
}

function emitRipplesAlongPointer() {
    if (last_pointer_x === null) {
        last_pointer_x = mouseX;
        last_pointer_y = mouseY;
        return;
    }

    let segmentX = last_pointer_x;
    let segmentY = last_pointer_y;
    let remainingX = mouseX - segmentX;
    let remainingY = mouseY - segmentY;
    let remainingDistance = Math.hypot(remainingX, remainingY);

    while (pointer_travel_since_ripple + remainingDistance >= RIPPLE_SPACING) {
        let distanceToRipple = RIPPLE_SPACING - pointer_travel_since_ripple;
        let fraction = distanceToRipple / remainingDistance;
        segmentX += remainingX * fraction;
        segmentY += remainingY * fraction;
        emitPointerRipple(segmentX, segmentY);

        remainingX = mouseX - segmentX;
        remainingY = mouseY - segmentY;
        remainingDistance = Math.hypot(remainingX, remainingY);
        pointer_travel_since_ripple = 0;
    }

    pointer_travel_since_ripple += remainingDistance;
    last_pointer_x = mouseX;
    last_pointer_y = mouseY;
}

function emitPointerRipple(x, y) {
    let centerX = width / 2;
    let centerY = height / 2;
    let diskRadius = min(width, height) * 0.44;

    if (dist(x, y, centerX, centerY) > diskRadius) return;

    pointer_ripples.push({ x, y, startedAt: millis() });
    if (pointer_ripples.length > MAX_ACTIVE_RIPPLES) pointer_ripples.shift();
}

function draw_stars(observer, localSiderealTime, centerX, centerY, diskRadius, currentMillis) {
    for (let index = 0; index < star_coords.length; index++) {
        draw_star(star_coords[index], observer, localSiderealTime, centerX, centerY, diskRadius, index, currentMillis);
    }
}

function draw_star(coord, observer, localSiderealTime, centerX, centerY, diskRadius, index, currentMillis) {
    let horizontal = horizontalCoordsFor(coord, observer, localSiderealTime);
    let point = skyPositionFor(horizontal.altitude, horizontal.azimuth, centerX, centerY, diskRadius);
    let targetGlow = horizontal.altitude < 0
        ? 0
        : rippleBrightnessAt(point.x, point.y, currentMillis);
    let glow = smoothStarGlow(star_glows[index] || 0, targetGlow, deltaTime);
    star_glows[index] = glow;
    if (horizontal.altitude < 0) return;

    let magnitudeIntensity = starDisplayIntensity(coord.magnitude);
    let starSize = 1.1 + magnitudeIntensity * 0.9;

    noStroke();
    fill(255, 1 + magnitudeIntensity * 9);
    circle(point.x, point.y, starSize * 2.2);

    if (glow > 0.001) {
        fill(255, glow * 45);
        circle(point.x, point.y, starSize * 4);
        fill(255, glow * 100);
        circle(point.x, point.y, starSize * 1.8);
    }

    fill(255, min(255, 18 + magnitudeIntensity * 237 + glow * 180));
    circle(point.x, point.y, starSize);
}

function smoothStarGlow(current, target, elapsedMilliseconds) {
    let timeConstant = target > current ? 5 : 420;
    let amount = 1 - Math.exp(-elapsedMilliseconds / timeConstant);

    return current + (target - current) * amount;
}

function rippleBrightnessAt(starX, starY, currentMillis) {
    let strongestRipple = 0;

    for (let ripple of pointer_ripples) {
        let elapsed = (currentMillis - ripple.startedAt) / 1000;
        let waveRadius = elapsed * RIPPLE_SPEED;
        let distanceToWave = Math.abs(dist(starX, starY, ripple.x, ripple.y) - waveRadius);
        let wave = Math.exp(-0.5 * (distanceToWave / RIPPLE_WIDTH) ** 2);
        let decay = Math.exp(-elapsed / 1.4);
        strongestRipple = max(strongestRipple, wave * decay);
    }

    return strongestRipple * RIPPLE_INTENSITY;
}

function starDisplayIntensity(magnitude) {
    let relativeFlux = Math.pow(10, -0.4 * (magnitude - brightest_magnitude));
    let exposure = 10000;

    return Math.log1p(exposure * relativeFlux) / Math.log1p(exposure);
}

function skyPositionFor(altitude, azimuth, centerX, centerY, diskRadius) {
    let radialDistance = diskRadius * (1 - constrain(altitude / HALF_PI, 0, 1));

    return {
        x: centerX + radialDistance * Math.sin(azimuth),
        y: centerY - radialDistance * Math.cos(azimuth)
    };
}

/* */
async function fetch_data() {
    return fetch('stars.json')
    .then(response => response.json())
    .then(data => {
        let stars = data.map(object => ({
            ...celestialCoordsFrom(object),
            magnitude: Number(object.V)
        }));
        brightest_magnitude = stars.reduce((brightest, star) => Math.min(brightest, star.magnitude), Infinity);
        star_glows = stars.map(() => 0);
        return stars;
    });
}

function celestialCoordsFrom(object) {
    let ra = rightAscension(object);
    let dec = declination(object);

    return { ra: ra, dec: dec };
}

function rightAscension(data) {
    // Capture RA hours, minutes, and seconds from strings such as "00h 05m 09.9s".
    let matches = data.RA.match(/(\d+)h\s*(\d+)m\s*([\d.]+)s/);
    let ra = {
        hours: Number(matches[1]),
        minutes: Number(matches[2]) / 60,
        seconds: Number(matches[3]) / 3600
    }

    // One hour of right ascension spans 15 degrees (360 degrees / 24 hours).
    return radians((ra.hours + ra.minutes + ra.seconds) * 15);
}

function declination(data) {
    // Capture the sign, degrees, arcminutes, and arcseconds from the declination string.
    let matches = data.Dec.match(/([+-]?)(\d+)°\s*(\d+)′\s*(\d+)″/);
    let dec = {
        angle: Number(matches[2]),
        minutes: Number(matches[3]) / 60,
        seconds: Number(matches[4]) / 3600
    }

    let declination = (dec.angle + dec.minutes + dec.seconds);
    if (matches[1] === '-') declination *= -1;
    
    return radians(declination);
}

function observerCoords() {
    return {
        lat: radians(18),
        lon: radians(-(66 + 37 / 60))
    };
}

function observerTime() {
    return new Date();
}

function horizontalCoordsFor(object, observer, localSiderealTime) {
    let hourAngle = ((localSiderealTime - object.ra) % TWO_PI + TWO_PI) % TWO_PI;
    let ha = hourAngle;
    let dec = object.dec;
    let lat = observer.lat;

    let sinAltitude = Math.sin(dec) * Math.sin(lat) + Math.cos(dec) * Math.cos(lat) * Math.cos(ha);
    let altitude = Math.asin(constrain(sinAltitude, -1, 1));
    let cosAzimuth = (Math.sin(dec) - Math.sin(altitude) * Math.sin(lat)) / (Math.cos(altitude) * Math.cos(lat));
    let azimuth = Math.acos(constrain(cosAzimuth, -1, 1));

    if (Math.sin(ha) > 0) azimuth = TWO_PI - azimuth;

    return { altitude: altitude, azimuth: azimuth };
}

function siderealTime(time, longitude) {
    // Example input: 2004-04-07T01:00:00Z. Read its UTC calendar parts, not local-time parts.
    let year = time.getUTCFullYear();
    let month = time.getUTCMonth() + 1;
    let day = time.getUTCDate();
    let hour = time.getUTCHours();
    let minute = time.getUTCMinutes();
    let second = time.getUTCSeconds();
    let millisecond = time.getUTCMilliseconds();

    // The Julian-day formula treats January and February as months 13 and 14 of the prior year.
    // For example, January 2026 becomes month 13 of 2025.
    if (month <= 2) {
        year--;
        month += 12;
    }

    let century = Math.floor(year / 100);
    let correction = 2 - century + Math.floor(century / 4);
    // Combine the calendar parts into days since J2000. The example time becomes about 1557.54 days.
    let julianDate = correction + Math.floor(365.25 * year) + Math.floor(30.6001 * (month + 1)) - 730550.5 + day + (hour + minute / 60 + second / 3600 + millisecond / 3600000) / 24;
    // Express that elapsed time in Julian centuries; the example is about 0.04264 centuries.
    let julianCenturies = julianDate / 36525;
    
    // Calculate Greenwich mean sidereal angle in degrees and wrap it into one full turn.
    let siderealDegrees = 280.46061837 + 360.98564736629 * julianDate + 0.000387933 * julianCenturies ** 2 - julianCenturies ** 3 / 38710000;
    siderealDegrees = ((siderealDegrees % 360) + 360) % 360;

    // Convert to radians and add longitude (already radians); west longitude is negative.
    let siderealRadians = radians(siderealDegrees) + longitude;
    // Wrap to [0, 2π). This local sidereal angle is compared with RA to get the hour angle.
    siderealRadians = ((siderealRadians % TWO_PI) + TWO_PI) % TWO_PI;

    return siderealRadians;
}

/* */



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