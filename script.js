"use strict";

/* =========================================================
   CANVAS / VIEW  (fixed virtual width, height follows screen)
   ========================================================= */
const cvx = document.getElementById("canvas");
const ctx = cvx.getContext("2d");
const startBtn = document.getElementById("startButton");

const VIRTUAL_W = 720;                 // game units across the screen width
const view = { w: VIRTUAL_W, h: 1280, scale: 1, dpr: 1 };

function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const cssW = window.innerWidth, cssH = window.innerHeight;
    cvx.width = Math.round(cssW * dpr);       // physical pixels = sharp
    cvx.height = Math.round(cssH * dpr);
    view.dpr = dpr;
    view.scale = cssW / VIRTUAL_W;
    view.w = VIRTUAL_W;
    view.h = cssH / view.scale;
    ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, 0, 0);
    ctx.imageSmoothingEnabled = true;         // reset by canvas resize, so set here
    ctx.imageSmoothingQuality = "high";
}
window.addEventListener("resize", resize);
window.addEventListener("orientationchange", () => setTimeout(resize, 100));
if (window.visualViewport) window.visualViewport.addEventListener("resize", resize);
resize();

/* =========================================================
   ASSET LOADER
   Add files to ASSET_MANIFEST. Missing files get a magenta
   placeholder so the game never crashes.
   ========================================================= */
const ASSET_MANIFEST = {
    background: "assets/background.png",
    player: "assets/player.png",
    wall: "assets/wall.png",
};

const Assets = {
    images: {},
    loaded: {},
    load(manifest) {
        const jobs = Object.entries(manifest).map(([key, src]) => new Promise(resolve => {
            const img = new Image();
            img.onload = async () => {
                try { if (img.decode) await img.decode(); } catch (e) {}
                this.images[key] = img;
                this.loaded[key] = true;
                resolve();
            };
            img.onerror = () => {
                console.warn("Asset failed to load:", key, src);
                this.images[key] = this.placeholder();
                this.loaded[key] = false;
                resolve();
            };
            img.src = src;
        }));
        return Promise.all(jobs);
    },
    placeholder() {
        const c = document.createElement("canvas");
        c.width = c.height = 64;
        const g = c.getContext("2d");
        g.fillStyle = "#f0f"; g.fillRect(0, 0, 64, 64);
        g.fillStyle = "#000"; g.fillRect(0, 0, 32, 32); g.fillRect(32, 32, 32, 32);
        return c;
    },
    get(key) { return this.images[key] || this.placeholder(); },
    has(key) { return !!this.loaded[key]; },
};

const SOUND_MANIFEST = {
    music:  "background.mp3",
};

const Sound = {
    ctx: null, master: null, musicGain: null, musicSrc: null, sfx: null, noiseBuf: null,
    raw: {}, buffers: {}, muted: false, last: {},

    async load(manifest) {                 // fetch files (decoded later, after the first tap)
        await Promise.all(Object.entries(manifest).map(async ([key, src]) => {
            try {
                const res = await fetch(src);
                if (!res.ok) throw new Error(res.status);
                this.raw[key] = await res.arrayBuffer();
            } catch (e) { console.warn("Sound not loaded:", key, src); }
        }));
    },

    unlock() {                             // call from a tap/click handler (browsers require it)
        if (!this.ctx) {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return Promise.resolve();
            this.ctx = new AC();
            this.master = this.ctx.createGain(); this.master.connect(this.ctx.destination);
            this.musicGain = this.ctx.createGain(); this.musicGain.connect(this.master);
            this.sfx = this.ctx.createGain(); this.sfx.gain.value = 0.8; this.sfx.connect(this.master);
            const n = this.ctx.sampleRate, nb = this.ctx.createBuffer(1, n, n), d = nb.getChannelData(0);
            for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;      // 1s of white noise for whooshes / thumps
            this.noiseBuf = nb;
        }
        return Promise.resolve(this.ctx.resume && this.ctx.resume()).then(() => this.decodeAll());
    },

    async decodeAll() {
        await Promise.all(Object.keys(this.raw).map(async key => {
            if (this.buffers[key]) return;
            try {
                this.buffers[key] = await new Promise((res, rej) => this.ctx.decodeAudioData(this.raw[key].slice(0), res, rej));
            } catch (e) { console.warn("Sound decode failed:", key); }
        }));
    },

    play(name, { volume = 1, rate = 1 } = {}) {
        if (!this.ctx || this.muted) return;
        const buf = this.buffers[name];
        if (buf) {                                         // a file override exists -> play it
            const src = this.ctx.createBufferSource(), g = this.ctx.createGain();
            src.buffer = buf; src.playbackRate.value = rate; g.gain.value = volume;
            src.connect(g); g.connect(this.master);
            src.start(0);
            return;
        }
        const fn = this.synth[name];                       // otherwise use the built-in synthesised effect
        if (!fn) return;
        const now = this.ctx.currentTime;
        if (now - (this.last[name] || 0) < 0.04) return;   // avoid machine-gunning the same sound
        this.last[name] = now;
        fn.call(this, volume, rate);
    },

    // --- tiny synth ---
    tone({ f0, f1 = f0, dur = 0.15, type = "sine", vol = 0.3, delay = 0, attack = 0.004, curve = null }) {
        const c = this.ctx, t = c.currentTime + delay, v = Math.max(vol, 0.001);
        const osc = c.createOscillator(), g = c.createGain();
        osc.type = type;
        if (curve) osc.frequency.setValueCurveAtTime(Float32Array.from(curve), t, dur);
        else {
            osc.frequency.setValueAtTime(f0, t);
            if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(f1, t + dur);
        }
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(v, t + attack);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        osc.connect(g); g.connect(this.sfx);
        osc.start(t); osc.stop(t + dur + 0.03);
    },
    noise({ dur = 0.1, vol = 0.2, type = "lowpass", f0 = 1000, f1 = f0, q = 1, delay = 0 }) {
        const c = this.ctx, t = c.currentTime + delay, v = Math.max(vol, 0.001);
        const src = c.createBufferSource(), fl = c.createBiquadFilter(), g = c.createGain();
        src.buffer = this.noiseBuf;
        fl.type = type; fl.Q.value = q;
        fl.frequency.setValueAtTime(f0, t);
        if (f1 !== f0) fl.frequency.exponentialRampToValueAtTime(f1, t + dur);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(v, t + 0.005);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        src.connect(fl); fl.connect(g); g.connect(this.sfx);
        src.start(t, Math.random() * 0.4); src.stop(t + dur + 0.03);
    },
    synth: {
        // launch: airy whoosh + rising chirp (louder / higher with a stronger pull)
        shoot(v, r) {
            this.noise({ dur: 0.2, vol: 0.28 * v, type: "bandpass", f0: 500 * r, f1: 2600 * r, q: 1.2 });
            this.tone({ f0: 260 * r, f1: 620 * r, dur: 0.14, type: "triangle", vol: 0.18 * v });
        },
        // entering a bubble: soft rising bloop
        bubble() {
            this.tone({ f0: 320, f1: 760, dur: 0.14, vol: 0.28 });
            this.tone({ f0: 640, f1: 1500, dur: 0.1, vol: 0.08, delay: 0.02 });
        },
        // coin: two-note "ding" (pitch climbs with the combo through `rate`)
        coin(v, r) {
            this.tone({ f0: 988 * r, dur: 0.07, type: "square", vol: 0.1 });
            this.tone({ f0: 1319 * r, dur: 0.28, type: "square", vol: 0.1, delay: 0.07 });
        },
        // sticking to goo: wet splat
        stick() {
            this.noise({ dur: 0.18, vol: 0.35, type: "lowpass", f0: 1500, f1: 150 });
            this.tone({ f0: 200, f1: 70, dur: 0.18, vol: 0.3 });
        },
        // game over: falling wobble
        lose() {
            this.tone({ f0: 420, f1: 70, dur: 0.8, type: "sawtooth", vol: 0.16 });
            this.tone({ f0: 210, f1: 35, dur: 0.8, type: "square", vol: 0.09 });
            this.noise({ dur: 0.5, vol: 0.15, type: "lowpass", f0: 800, f1: 100, delay: 0.1 });
        },
        // wall / obstacle bounce: dull thump (volume follows impact speed)
        bounce(v) {
            this.tone({ f0: 230, f1: 80, dur: 0.13, vol: 0.4 * v });
            this.noise({ dur: 0.07, vol: 0.25 * v, type: "lowpass", f0: 900, f1: 200 });
        },
        // green bouncer: springy "boing"
        spring() {
            this.tone({ dur: 0.38, type: "triangle", vol: 0.3, curve: [260, 640, 420, 700, 520, 720, 600, 700] });
            this.tone({ f0: 520, f1: 1040, dur: 0.12, vol: 0.1 });
        },
        // power-up picked up: bright three-note arpeggio
        power() { [660, 880, 1320].forEach((f, i) => this.tone({ f0: f, dur: 0.16, type: "triangle", vol: 0.18, delay: i * 0.07 })); },
        // freeze: icy downward shimmer
        freeze() {
            this.tone({ f0: 2200, f1: 500, dur: 0.4, type: "sine", vol: 0.16 });
            this.tone({ f0: 1650, f1: 380, dur: 0.45, type: "triangle", vol: 0.1, delay: 0.03 });
            this.noise({ dur: 0.3, vol: 0.18, type: "highpass", f0: 3000, f1: 6000 });
        },
        // trajectory shower armed: two-note ping
        aim() { this.tone({ f0: 900, f1: 1500, dur: 0.12, vol: 0.2 }); this.tone({ f0: 1500, dur: 0.18, vol: 0.12, delay: 0.1 }); },
        // booster: rising zap
        boost() {
            this.tone({ f0: 180, f1: 1400, dur: 0.32, type: "sawtooth", vol: 0.14 });
            this.noise({ dur: 0.3, vol: 0.2, type: "bandpass", f0: 400, f1: 3500, q: 1.5 });
        },
    },

    music(name, volume = 0.4) {
        this.stopMusic();
        const buf = this.buffers[name];
        if (!this.ctx || !buf) return;
        const src = this.ctx.createBufferSource();
        src.buffer = buf; src.loop = true;
        this.musicGain.gain.value = volume;
        src.connect(this.musicGain); src.start(0);
        this.musicSrc = src;
    },
    stopMusic() { if (this.musicSrc) { try { this.musicSrc.stop(); } catch (e) {} this.musicSrc = null; } },
    setMuted(m) { this.muted = m; if (this.master) this.master.gain.value = m ? 0 : 1; },
};
document.addEventListener("visibilitychange", () => {      // pause audio when the tab/app is hidden
    if (!Sound.ctx) return;
    document.hidden ? Sound.ctx.suspend() : Sound.ctx.resume();
});

/* =========================================================
   STORAGE  (best score + chosen skin survive reloads)
   ========================================================= */
const Store = {
    get(k, d) { try { const v = localStorage.getItem("limitless." + k); return v === null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("limitless." + k, String(v)); } catch (e) {} },
};
let savedBest = Number(Store.get("best", 0)) || 0;
function saveBest() { if (best > savedBest) { savedBest = best; Store.set("best", best); } }
setInterval(saveBest, 2000);                                   // cheap safety net while playing
window.addEventListener("pagehide", saveBest);
document.addEventListener("visibilitychange", () => { if (document.hidden) saveBest(); });

/* =========================================================
   DRAW HELPERS
   ========================================================= */
// src = asset key or image. opts: {rotation, flipX, flipY, alpha, anchorX, anchorY}
// anchor 0..1 (default 0 = top-left, 0.5 = center)
function drawImage(src, x, y, w, h, opts = {}) {
    const img = typeof src === "string" ? Assets.get(src) : src;
    const w2 = w ?? img.width, h2 = h ?? img.height;
    const ax = opts.anchorX ?? 0, ay = opts.anchorY ?? 0;
    ctx.save();
    if (opts.alpha !== undefined) ctx.globalAlpha = opts.alpha;
    ctx.translate(x, y);
    if (opts.rotation) ctx.rotate(opts.rotation);
    ctx.scale(opts.flipX ? -1 : 1, opts.flipY ? -1 : 1);
    ctx.drawImage(img, -w2 * ax, -h2 * ay, w2, h2);
    ctx.restore();
}

// Tiles an image vertically across [x, x+w] from y to y+h
function drawTiledY(src, x, y, w, h, tileH) {
    const img = typeof src === "string" ? Assets.get(src) : src;
    const th = tileH ?? w * (img.height / img.width);
    let start = Math.floor(y / th) * th;
    for (let ty = start; ty < y + h; ty += th) ctx.drawImage(img, x, ty, w, th + 1);
}

function drawText(str, x, y, size = 30, color = "#fff", align = "left", font = "Arial", weight = "") {
    ctx.font = `${weight} ${size}px ${font}`;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = "alphabetic";
    ctx.fillText(str, x, y);
}

function drawRect(x, y, w, h, color = "#fff", filled = true, lineWidth = 2) {
    ctx.fillStyle = ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    filled ? ctx.fillRect(x, y, w, h) : ctx.strokeRect(x, y, w, h);
}

function drawCircle(x, y, r, color = "#fff", filled = true, lineWidth = 2) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    filled ? ctx.fill() : ctx.stroke();
}

function drawLine(x1, y1, x2, y2, color = "#fff", lineWidth = 2) {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
}

/* =========================================================
   MATH
   ========================================================= */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const dist = (x1, y1, x2, y2) => Math.hypot(x2 - x1, y2 - y1);

/* =========================================================
   COLLIDERS
   Rect:   {x, y, w, h}      Circle: {x, y, r}
   ========================================================= */
const Collide = {
    pointRect: (px, py, r) => px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h,
    pointCircle: (px, py, c) => (px - c.x) ** 2 + (py - c.y) ** 2 <= c.r * c.r,

    rectRect: (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y,

    circleCircle: (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2 <= (a.r + b.r) ** 2,

    circleRect(c, r) {
        const cx = clamp(c.x, r.x, r.x + r.w), cy = clamp(c.y, r.y, r.y + r.h);
        return (c.x - cx) ** 2 + (c.y - cy) ** 2 <= c.r * c.r;
    },

    // Minimum translation vector to push rect `a` out of rect `b`. null if no overlap.
    // Apply: a.x += mtv.x; a.y += mtv.y
    resolveRectRect(a, b) {
        if (!Collide.rectRect(a, b)) return null;
        const left = b.x - (a.x + a.w);          // push left  (negative)
        const right = b.x + b.w - a.x;           // push right (positive)
        const up = b.y - (a.y + a.h);            // push up    (negative)
        const down = b.y + b.h - a.y;            // push down  (positive)
        const px = Math.abs(left) < right ? left : right;
        const py = Math.abs(up) < down ? up : down;
        return Math.abs(px) < Math.abs(py) ? { x: px, y: 0 } : { x: 0, y: py };
    },

    // Push circle out of rect. Returns {x, y, nx, ny} or null.
    resolveCircleRect(c, r) {
        const cx = clamp(c.x, r.x, r.x + r.w), cy = clamp(c.y, r.y, r.y + r.h);
        let dx = c.x - cx, dy = c.y - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 > c.r * c.r) return null;
        if (d2 === 0) return { x: 0, y: -c.r, nx: 0, ny: -1 };   // centre inside rect
        const d = Math.sqrt(d2), pen = c.r - d;
        return { x: (dx / d) * pen, y: (dy / d) * pen, nx: dx / d, ny: dy / d };
    },
};

/* =========================================================
   RAYS
   Direction (dx, dy) is normalised internally.
   Each returns {t, x, y, nx, ny} or null (t = distance).
   ========================================================= */
const Ray = {
    rect(ox, oy, dx, dy, r, maxDist = Infinity) {
        const len = Math.hypot(dx, dy); if (!len) return null;
        dx /= len; dy /= len;
        let tmin = 0, tmax = maxDist, nx = 0, ny = 0;
        // X slab
        if (dx === 0) { if (ox < r.x || ox > r.x + r.w) return null; }
        else {
            let t1 = (r.x - ox) / dx, t2 = (r.x + r.w - ox) / dx, n = -1;
            if (t1 > t2) { [t1, t2] = [t2, t1]; n = 1; }
            if (t1 > tmin) { tmin = t1; nx = n; ny = 0; }
            tmax = Math.min(tmax, t2);
            if (tmin > tmax) return null;
        }
        // Y slab
        if (dy === 0) { if (oy < r.y || oy > r.y + r.h) return null; }
        else {
            let t1 = (r.y - oy) / dy, t2 = (r.y + r.h - oy) / dy, n = -1;
            if (t1 > t2) { [t1, t2] = [t2, t1]; n = 1; }
            if (t1 > tmin) { tmin = t1; nx = 0; ny = n; }
            tmax = Math.min(tmax, t2);
            if (tmin > tmax) return null;
        }
        if (tmin > maxDist) return null;
        return { t: tmin, x: ox + dx * tmin, y: oy + dy * tmin, nx, ny };
    },

    circle(ox, oy, dx, dy, c, maxDist = Infinity) {
        const len = Math.hypot(dx, dy); if (!len) return null;
        dx /= len; dy /= len;
        const fx = ox - c.x, fy = oy - c.y;
        const b = fx * dx + fy * dy, cc = fx * fx + fy * fy - c.r * c.r;
        const disc = b * b - cc;
        if (disc < 0) return null;
        let t = -b - Math.sqrt(disc);
        if (t < 0) t = -b + Math.sqrt(disc);
        if (t < 0 || t > maxDist) return null;
        const x = ox + dx * t, y = oy + dy * t;
        return { t, x, y, nx: (x - c.x) / c.r, ny: (y - c.y) / c.r };
    },

    segment(ox, oy, dx, dy, x1, y1, x2, y2, maxDist = Infinity) {
        const len = Math.hypot(dx, dy); if (!len) return null;
        dx /= len; dy /= len;
        const sx = x2 - x1, sy = y2 - y1;
        const denom = dx * sy - dy * sx;
        if (Math.abs(denom) < 1e-9) return null;
        const t = ((x1 - ox) * sy - (y1 - oy) * sx) / denom;
        const u = ((x1 - ox) * dy - (y1 - oy) * dx) / denom;
        if (t < 0 || t > maxDist || u < 0 || u > 1) return null;
        let nx = -sy, ny = sx; const nl = Math.hypot(nx, ny); nx /= nl; ny /= nl;
        if (nx * dx + ny * dy > 0) { nx = -nx; ny = -ny; }
        return { t, x: ox + dx * t, y: oy + dy * t, nx, ny };
    },

    // Nearest hit against a mixed list of rects and circles. Adds .collider to the result.
    cast(ox, oy, dx, dy, colliders, maxDist = Infinity) {
        let best = null;
        for (const c of colliders) {
            let h = null;
            if (c.pts) {                                        // convex polygon -> test each edge
                for (let i = 0; i < c.pts.length; i++) {
                    const a = c.pts[i], b = c.pts[(i + 1) % c.pts.length];
                    const e = Ray.segment(ox, oy, dx, dy, a.x, a.y, b.x, b.y, maxDist);
                    if (e && (!h || e.t < h.t)) h = e;
                }
            } else {
                h = (c.r !== undefined)
                    ? Ray.circle(ox, oy, dx, dy, c, maxDist)
                    : Ray.rect(ox, oy, dx, dy, c, maxDist);
            }
            if (h && (!best || h.t < best.t)) { best = h; best.collider = c; }
        }
        return best;
    },

    // Is the straight line between two points free of colliders?
    lineOfSight(x1, y1, x2, y2, colliders) {
        return !Ray.cast(x1, y1, x2 - x1, y2 - y1, colliders, dist(x1, y1, x2, y2));
    },
};

/* =========================================================
   TRAJECTORY CALCULATOR  (y points DOWN, gravity is positive)
   ========================================================= */
const Trajectory = {
    pointAt: (x, y, vx, vy, g, t) => ({ x: x + vx * t, y: y + vy * t + 0.5 * g * t * t }),

    // Sampled arc, stopping at the first collider hit (if colliders given).
    // Returns { points: [{x,y,t}], hit }
    predict(x, y, vx, vy, g, { step = 0.03, maxTime = 3, colliders = null } = {}) {
        const points = [{ x, y, t: 0 }];
        let hit = null, prev = points[0];
        for (let t = step; t <= maxTime; t += step) {
            const p = Trajectory.pointAt(x, y, vx, vy, g, t);
            if (colliders) {
                const h = Ray.cast(prev.x, prev.y, p.x - prev.x, p.y - prev.y, colliders, dist(prev.x, prev.y, p.x, p.y));
                if (h) { hit = h; points.push({ x: h.x, y: h.y, t }); break; }
            }
            p.t = t; points.push(p); prev = p;
        }
        return { points, hit };
    },

    timeToApex: (vy, g) => (vy < 0 ? -vy / g : 0),
    apexHeight: (vy, g) => (vy < 0 ? (vy * vy) / (2 * g) : 0),          // height gained above start
    apex(x, y, vx, vy, g) {
        const t = Trajectory.timeToApex(vy, g);
        return { t, ...Trajectory.pointAt(x, y, vx, vy, g, t) };
    },

    // Time when the arc reaches world-y `targetY` while falling (null if never)
    timeToY(y, vy, g, targetY) {
        const a = 0.5 * g, b = vy, c = y - targetY;
        const d = b * b - 4 * a * c;
        if (d < 0) return null;
        const t = (-b + Math.sqrt(d)) / (2 * a);
        return t >= 0 ? t : null;
    },

    // Velocity needed to go from (x,y) to (tx,ty) with a given launch speed.
    // Returns { low, high } = { vx, vy, angle } or null if out of reach.
    solveLaunch(x, y, tx, ty, speed, g) {
        const dx = tx - x, h = -(ty - y), ax = Math.abs(dx), sgn = dx < 0 ? -1 : 1;
        if (ax < 1e-6) return null;
        const a = (g * ax * ax) / (2 * speed * speed);
        const disc = ax * ax - 4 * a * (h + a);
        if (disc < 0) return null;
        const make = u => {
            const ang = Math.atan(u);
            return { vx: sgn * speed * Math.cos(ang), vy: -speed * Math.sin(ang), angle: ang };
        };
        const u1 = (ax - Math.sqrt(disc)) / (2 * a), u2 = (ax + Math.sqrt(disc)) / (2 * a);
        return { low: make(u1), high: make(u2) };
    },

    // Slingshot: drag from (sx,sy) to (cx,cy) -> launch velocity in the opposite direction
    fromDrag(sx, sy, cx, cy, power = 5, maxSpeed = 1100) {
        let vx = (sx - cx) * power, vy = (sy - cy) * power;
        const s = Math.hypot(vx, vy);
        if (s > maxSpeed) { vx *= maxSpeed / s; vy *= maxSpeed / s; }
        return { vx, vy };
    },
};

/* =========================================================
   INPUT  (pointer events, coordinates in virtual units)
   ========================================================= */
const Input = {
    down: false, x: 0, y: 0, startX: 0, startY: 0, released: false,
    _set(e) { this.x = e.clientX / view.scale; this.y = e.clientY / view.scale; },
};
cvx.addEventListener("pointerdown", e => {
    e.preventDefault();
    Input._set(e);
    if (running && state === "play" && tryUsePowerupAt(Input.x, Input.y)) return;   // tapped a power-up icon
    cvx.setPointerCapture(e.pointerId);
    Input.startX = Input.x; Input.startY = Input.y; Input.down = true;
});
cvx.addEventListener("pointermove", e => { e.preventDefault(); Input._set(e); });
const endPointer = e => { Input._set(e); if (Input.down) Input.released = true; Input.down = false; };
cvx.addEventListener("pointerup", endPointer);
cvx.addEventListener("pointercancel", endPointer);
cvx.addEventListener("contextmenu", e => e.preventDefault());
document.addEventListener("touchmove", e => { if (!(e.target.closest && e.target.closest(".scrollable"))) e.preventDefault(); }, { passive: false });

/* =========================================================
   GAME  (aim from a bubble / wall pad, boosters, coins)
   ========================================================= */
const GRAVITY = 2200;
const WALL_W = 64;
const PLAYER_R = 28;
const BUBBLE_R = PLAYER_R * 1.05;          // bubbles are 5% bigger than the player
const BOOSTER_R = 30, COIN_R = 14;
const BOOST_SPEED = 2100;                  // booster launches you along your last aim direction
const COIN_POINTS = 50;
const POWER = 6.5, MAX_SPEED = 1600, MAX_PULL = MAX_SPEED / POWER;   // stronger shots (same drag length as before)
const MIN_PULL = 16;                       // ignore tiny drags / taps
const AIM_BALLS = 4;
const CAM_SMOOTH = 5;                      // higher = snappier camera
const WALL_BOUNCE = 2 / 3;                 // walls & obstacles: mirrored direction, 2/3 of the speed
const BOUNCER_GAIN = 1.25;                 // green bouncers: speed multiplier on impact ...
const BOUNCER_MIN = 1000, BOUNCER_MAX = 2000;   // ... but never weaker / stronger than this
const OBSTACLE_START = 50, OBSTACLE_FULL = 500, OBSTACLE_MAX_CHANCE = 0.45;   // heights (score units) where air obstacles fade in
const OBSTACLE_STICKY_CHANCE = 0.4;        // share of obstacles carrying sticky goo
const BOUNCER_CHANCE = 0.15;               // green bouncer on a side wall (per generated bubble)
const CENTER_SPREAD = 170;                 // bubbles stay within this distance of the screen middle
const BOOSTER_CHANCE = 0.6;                // chance of a booster per generated bubble (max one each)
const BOOSTER_MIN_DY = 300;                // a new booster must be at least this far above the previous booster
const SPAWN_CLEAR_BUBBLE = 120;            // boosters keep at least this distance (centre to centre) from every bubble
const SPAWN_CLEAR_BOOSTER = 170;           // ... and from every other booster
const POWERUP_CHANCE = 0.12, POWERUP_MIN_DY = 1200, POWERUP_R = 28;   // rare pickups: chance per bubble, min vertical gap between two, pickup radius
const POWER_SLOTS = 3, SLOT_R = 44, SLOT_GAP = 20, SLOT_ROW = 108;       // inventory icons along the bottom of the screen
const SHOWER_BALLS = 20;                   // trajectory shower: balls along the predicted path (bounces included)
const POWER_DEFS = { freeze: { color: "#6fe6ff" }, aim: { color: "#ffa51f" } };
const COIN_CHANCE = 0.3;                   // per generated bubble
const TRAIL_MIN = 650, TRAIL_FULL = 1900, TRAIL_LIFE = 0.5;   // speed trail: appears above TRAIL_MIN, full strength at TRAIL_FULL (units/s)
const BUBBLE_GAP_MIN = 270, BUBBLE_GAP_MAX = 370;  // vertical distance between bubbles (bigger = fewer bubbles)
const STICKY_PAD_CHANCE = 0.2;
const BOUNCER_UP_ANGLE = 35 * Math.PI / 180;       // green pads: hits shallower than this (vs. the pad surface) fling you straight up
const COLOR_STICKY = "#27c6ff", COLOR_BOUNCE = "#2dff6e", COLOR_BOOST = "#ff10f0", COLOR_COIN = "#ffe600", COLOR_BUBBLE = "#bfe9ff";
const camera = { y: 0 };

let player, bubbles, boosters, coins, pads, walls, fx, obstacles;
let trail = [];                            // recent player positions while flying fast
let powerups = [], slots = [], lastPowerupY = 0;   // world pickups / inventory (max POWER_SLOTS) / last spawn height
let lastBoosterY = Infinity;                // world y of the most recently spawned booster
let genY, lastBubble, originY, bestCamTarget, maxHeight, bonus, coinsCollected, best = Number(Store.get("best", 0)) || 0, gameTime = 0;
let lastCoinT = -99, coinCombo = 0;

const rand = (a, b) => a + Math.random() * (b - a);
const score = () => maxHeight + bonus;
const canLaunch = () => player.stuck || !!player.bubble || player.frozen;     // frozen = stopped mid-air by the freeze power-up
const strengthColor = (s, a = 1) => `hsla(${Math.round(120 * (1 - s))}, 100%, 60%, ${a})`;   // green > yellow > red

function segClosest(ax, ay, bx, by, cx, cy) {            // closest point on segment AB to point C
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 ? clamp(((cx - ax) * dx + (cy - ay) * dy) / l2, 0, 1) : 0;
    return { x: ax + dx * t, y: ay + dy * t };
}

/* ---------- obstacles & collision helpers ---------- */
// circle vs convex polygon (pts in order). Returns {x, y, nx, ny} push-out + surface normal, or null.
function resolveCirclePoly(c, pts) {
    let best = Infinity, bx = 0, by = 0, pos = 0, neg = 0;
    for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        const q = segClosest(a.x, a.y, b.x, b.y, c.x, c.y);
        const d2 = (c.x - q.x) ** 2 + (c.y - q.y) ** 2;
        if (d2 < best) { best = d2; bx = q.x; by = q.y; }
        const cr = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
        if (cr > 0) pos++; else neg++;
    }
    const inside = pos === 0 || neg === 0, d = Math.sqrt(best);
    let nx, ny, push;
    if (inside) {                                           // centre swallowed: push out through the nearest edge
        if (d < 1e-6) { nx = 0; ny = -1; } else { nx = (bx - c.x) / d; ny = (by - c.y) / d; }
        push = d + c.r;
    } else {
        if (d >= c.r) return null;
        nx = (c.x - bx) / d; ny = (c.y - by) / d;
        push = c.r - d;
    }
    return { x: nx * push, y: ny * push, nx, ny };
}

function resolveCircleCircle(c, o) {
    const dx = c.x - o.x, dy = c.y - o.y, d = Math.hypot(dx, dy), rr = c.r + o.r;
    if (d >= rr) return null;
    const nx = d < 1e-6 ? 0 : dx / d, ny = d < 1e-6 ? -1 : dy / d, pen = rr - d;
    return { x: nx * pen, y: ny * pen, nx, ny };
}

// one entry point for walls / pads (rects) and obstacles (circle / rhombus)
function hitSolid(circ, c) {
    if (c.kind === "circle") return resolveCircleCircle(circ, c);
    if (c.kind === "rhombus") return resolveCirclePoly(circ, c.pts);
    return Collide.resolveCircleRect(circ, c);
}

// obstacles only grab the ball on the part of the rim that carries goo
function inStickyZone(c, x = player.x, y = player.y) {
    if (!c.kind) return true;                               // wall pads are sticky all over
    const a = Math.atan2(y - c.y, x - c.x);
    return Math.abs(Math.atan2(Math.sin(a - c.sa), Math.cos(a - c.sa))) <= c.sh;
}

// Mirror the velocity around the surface normal and keep WALL_BOUNCE (2/3) of the speed.
// Green bouncers instead boost the speed.
function bounceOff(c, r, vn) {
    const sp = Math.hypot(player.vx, player.vy);
    let rx = player.vx - 2 * vn * r.nx, ry = player.vy - 2 * vn * r.ny, k = WALL_BOUNCE;
    const hx = player.x - r.nx * PLAYER_R, hy = player.y - r.ny * PLAYER_R;      // contact point
    if (c.bounce) {
        const out = clamp(sp * BOUNCER_GAIN, BOUNCER_MIN, BOUNCER_MAX);
        // Shallow hit (ball skimming along the pad) -> fling it straight up.
        // Steeper hit -> boosted mirror bounce.
        const shallow = Math.abs(r.nx) > 0.7 && (sp < 1 || Math.abs(vn) / sp < Math.sin(BOUNCER_UP_ANGLE));
        if (shallow) { rx = r.nx * 0.1; ry = -1; }            // tiny nudge off the wall so it clears the pad
        else if (sp < 1) { rx = r.nx; ry = r.ny; }
        const rs = Math.hypot(rx, ry) || 1;
        k = out / rs;
        c.cv = 14;                                           // kick the squash spring
        fxRing(hx, hy, 10, 54, 0.35, "rgba(45,255,110,0.9)");
        fxSparks(hx, hy, 12, COLOR_BOUNCE, 320);
        Sound.play("spring");
    } else {
        if (sp > 300) fxSparks(hx, hy, 5, neonAt(colorProgress), 160);
        Sound.play("bounce", { volume: clamp(sp / 900, 0.25, 1) });
    }
    player.vx = rx * k; player.vy = ry * k;
}

const padFree = (left, y, h) =>                              // no other wall pad on that side within [y, y+h]?
    pads.every(p => ((p.x < VIRTUAL_W / 2) !== left) || p.y + p.h + 14 < y || y + h + 14 < p.y);
const freeOfObstacles = (x, y, rad) => obstacles.every(o => dist(x, y, o.x, o.y) > o.br + rad + 4);

// Floating circle / rhombus beside the path between two bubbles (never across it)
function trySpawnObstacle(prev, b, dx, dy, px, py) {
    const circle = Math.random() < 0.5;
    const o = circle ? { kind: "circle", r: rand(30, 52) } : { kind: "rhombus", hw: rand(34, 56), hh: rand(46, 72) };
    o.br = circle ? o.r : Math.max(o.hw, o.hh);               // bounding radius
    const s0 = Math.random() < 0.5 ? -1 : 1;
    for (const s of [s0, -s0]) {
        const t = rand(0.4, 0.6), off = s * (o.br + PLAYER_R + rand(40, 80));
        const x = clamp(prev.bx + dx * t + px * off, WALL_W + 24 + o.br + 6, VIRTUAL_W - WALL_W - 24 - o.br - 6);
        const y = prev.by + dy * t + py * off;
        const q = segClosest(prev.bx, prev.by, b.bx, b.by, x, y);
        if (dist(q.x, q.y, x, y) < o.br + PLAYER_R + 10) continue;              // keep the path itself open
        if (dist(x, y, prev.bx, prev.by) < o.br + BUBBLE_R + 25) continue;
        if (dist(x, y, b.bx, b.by) < o.br + BUBBLE_R + 25) continue;
        if (!freeOfObstacles(x, y, o.br + 60)) continue;
        o.x = x; o.y = y; o.c = 0; o.cv = 0; o.ph = Math.random() * 6.283;
        if (!circle) o.pts = [{ x, y: y - o.hh }, { x: x + o.hw, y }, { x, y: y + o.hh }, { x: x - o.hw, y }];
        o.sticky = Math.random() < OBSTACLE_STICKY_CHANCE;
        if (o.sticky) {                                       // goo patch roughly faces the path
            o.sa = Math.atan2(q.y - y, q.x - x) + rand(-0.6, 0.6);
            o.sh = rand(0.7, 1.0);                            // half-width of the patch (radians)
        }
        obstacles.push(o);
        return;
    }
}

/* ---------- effects ---------- */
function fxRing(x, y, r0, r1, life, color) { fx.push({ type: "ring", x, y, r0, r1, life, t: 0, color }); }
function fxSparks(x, y, n, color, speed) {
    for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, s = rand(0.3, 1) * speed;
        fx.push({ type: "spark", x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rand(0.4, 0.8), t: 0, color });
    }
}
function fxText(x, y, text, color) { fx.push({ type: "text", x, y, text, life: 0.9, t: 0, color }); }

// Break a disc (or just its shell) into bits of the same colour that fall down
function fxDisintegrate(x, y, r, color, n, shell = false) {
    for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const d = shell ? r * rand(0.85, 1) : r * Math.sqrt(Math.random());
        fx.push({
            type: "bit", x: x + Math.cos(a) * d, y: y + Math.sin(a) * d,
            vx: Math.cos(a) * rand(10, 70) + rand(-30, 30), vy: Math.sin(a) * rand(10, 70) - rand(0, 60),
            size: rand(1.5, 3.5), life: rand(0.7, 1.4), t: 0, color,
        });
    }
}

/* ---------- world ---------- */
function addBubble(x, y) {
    const b = { bx: x, by: y, cx: x, cy: y, r: BUBBLE_R, ph: Math.random() * 6.283, w: 0, wv: 0, ang: 0 };
    bubbles.push(b);
    return b;
}

function resetGame() {
    originY = 960;
    walls = [
        { x: 0, y: -1e7, w: WALL_W, h: 2e7, sticky: false },
        { x: VIRTUAL_W - WALL_W, y: -1e7, w: WALL_W, h: 2e7, sticky: false },
    ];
    pads = []; bubbles = []; boosters = []; coins = []; fx = []; obstacles = []; trail = []; powerups = []; slots = [];
    maxHeight = 0; bonus = 0; coinsCollected = 0; gameTime = 0; coinCombo = 0;
    player = {
        x: VIRTUAL_W / 2, y: originY, vx: 0, vy: 0, stuck: false, stuckPad: null, bubble: null, noStick: 0, frozen: false,
        ox: 0, oy: 0, ovx: 0, ovy: 0,                 // spring offset inside a bubble
        pull: 0, pullV: 0, pdx: 0, pdy: 1,            // stretched "tail" while aiming (spring)
        aimX: 0, aimY: -1,                            // last launch direction (used by boosters)
        stickBase: 0,                                 // angle from the ball to the surface it is stuck to
        rot: 0, spin: 0, tilt: 0,                     // skin: roll angle / spin speed / ufo tilt
        eyeX: 0, eyeY: -0.4, blink: 1, blinkT: 2,     // skin: smoothed eye look direction + blink
    };
    player.bubble = addBubble(VIRTUAL_W / 2, originY);
    genY = originY; lastBubble = player.bubble; lastBoosterY = originY; lastPowerupY = originY;
    camera.y = player.y - view.h * 0.6;
    bestCamTarget = camera.y;
    hudReset();
    generate();
}

function generate() {
    const MID = VIRTUAL_W / 2, EDGE = WALL_W + 40;
    while (genY > camera.y - 900) {
        const prev = lastBubble;
        const ny = genY - rand(BUBBLE_GAP_MIN, BUBBLE_GAP_MAX);
        // random walk that is gently pulled toward the middle
        const nx = clamp(prev.bx + rand(-150, 150) + (MID - prev.bx) * 0.25, MID - CENTER_SPREAD, MID + CENTER_SPREAD);
        const b = addBubble(nx, ny);

        // perpendicular to the line prev -> new bubble
        const dx = nx - prev.bx, dy = ny - prev.by, len = Math.hypot(dx, dy);
        const px = -dy / len, py = dx / len;
        const sign = Math.random() < 0.5 ? -1 : 1;

        // air obstacles fade in as you climb
        const hgt = (originY - ny) / 10;
        if (Math.random() < clamp((hgt - OBSTACLE_START) / (OBSTACLE_FULL - OBSTACLE_START), 0, 1) * OBSTACLE_MAX_CHANCE)
            trySpawnObstacle(prev, b, dx, dy, px, py);

        // at most one booster per bubble, spaced out vertically and kept clear of everything already placed
        if (Math.random() < BOOSTER_CHANCE) {
            for (let tries = 0; tries < 8; tries++) {
                const t = rand(0.25, 0.75), off = (tries % 2 ? -sign : sign) * rand(60, 120);
                const bxp = clamp(prev.bx + dx * t + px * off, EDGE, VIRTUAL_W - EDGE), byp = prev.by + dy * t + py * off;
                if (lastBoosterY - byp < BOOSTER_MIN_DY) continue;                                   // too close vertically to the last booster
                if (!freeOfObstacles(bxp, byp, BOOSTER_R + PLAYER_R)) continue;
                if (bubbles.some(q => dist(q.bx, q.by, bxp, byp) < SPAWN_CLEAR_BUBBLE)) continue;   // spawn radius vs bubbles
                if (boosters.some(o => dist(o.x, o.y, bxp, byp) < SPAWN_CLEAR_BOOSTER)) continue;   // spawn radius vs boosters
                boosters.push({ x: bxp, y: byp, ph: Math.random() * 6.283 });
                lastBoosterY = byp;
                break;
            }
        }
        if (Math.random() < COIN_CHANCE) {             // 1-2 coins on the other side
            const n = 1 + Math.floor(Math.random() * 2);
            for (let k = 1; k <= n; k++) {
                const t = 0.2 + 0.6 * k / (n + 1), off = -sign * rand(30, 80);
                const cxp = clamp(prev.bx + dx * t + px * off, EDGE, VIRTUAL_W - EDGE), cyp = prev.by + dy * t + py * off;
                if (freeOfObstacles(cxp, cyp, COIN_R + PLAYER_R) && boosters.every(o => dist(o.x, o.y, cxp, cyp) > BOOSTER_R + COIN_R + 12))
                    coins.push({ x: cxp, y: cyp, ph: Math.random() * 6.283 });
            }
        }
        if (Math.random() < POWERUP_CHANCE && lastPowerupY - ny >= POWERUP_MIN_DY) {   // rare power-up pickup
            for (let tries = 0; tries < 8; tries++) {
                const t = rand(0.3, 0.7), off = (tries % 2 ? -sign : sign) * rand(45, 100);
                const xp = clamp(prev.bx + dx * t + px * off, EDGE, VIRTUAL_W - EDGE), yp = prev.by + dy * t + py * off;
                if (!freeOfObstacles(xp, yp, POWERUP_R + PLAYER_R)) continue;
                if (bubbles.some(q => dist(q.bx, q.by, xp, yp) < SPAWN_CLEAR_BUBBLE)) continue;
                if (boosters.some(o => dist(o.x, o.y, xp, yp) < SPAWN_CLEAR_BUBBLE)) continue;
                if (coins.some(c => dist(c.x, c.y, xp, yp) < POWERUP_R + COIN_R + 14)) continue;
                powerups.push({ x: xp, y: yp, type: Math.random() < 0.5 ? "freeze" : "aim", ph: Math.random() * 6.283 });
                lastPowerupY = yp;
                break;
            }
        }
        if (Math.random() < STICKY_PAD_CHANCE) {       // sticky pad on a side wall
            const left = Math.random() < 0.5, py0 = ny - rand(20, 120);
            if (padFree(left, py0, 160))
                pads.push({ x: left ? WALL_W : VIRTUAL_W - WALL_W - 24, y: py0, w: 24, h: 160, sticky: true, c: 0, cv: 0 });
        }
        if (Math.random() < BOUNCER_CHANCE) {          // small green bouncer on a side wall
            const left = Math.random() < 0.5, by0 = ny + rand(-60, 60);
            if (padFree(left, by0, 64))
                pads.push({ x: left ? WALL_W : VIRTUAL_W - WALL_W - 22, y: by0, w: 22, h: 64, sticky: false, bounce: true, c: 0, cv: 0 });
        }
        genY = ny; lastBubble = b;
    }
    const cut = camera.y + view.h + 300;
    bubbles = bubbles.filter(b => b === player.bubble || b.by < cut);
    boosters = boosters.filter(o => o.y < cut);
    coins = coins.filter(c => c.y < cut);
    powerups = powerups.filter(o => o.y < cut);
    pads = pads.filter(p => p === player.stuckPad || p.y < cut);
    obstacles = obstacles.filter(o => o === player.stuckPad || o.y < cut);
}

// unit launch direction: live while dragging, otherwise the last one
function currentAim() {
    if (Input.down && canLaunch()) {
        const dx = Input.startX - Input.x, dy = Input.startY - Input.y, d = Math.hypot(dx, dy);
        if (d > MIN_PULL) return { x: dx / d, y: dy / d };
    }
    return { x: player.aimX, y: player.aimY };
}

function popBubble(b) {
    bubbles.splice(bubbles.indexOf(b), 1);
    fxDisintegrate(b.cx, b.cy, b.r, COLOR_BUBBLE, 44, true);
}

function captureBubble(b, p, vx, vy) {
    player.bubble = b;
    player.ox = p.x - b.cx; player.oy = p.y - b.cy;
    player.ovx = vx * 0.12; player.ovy = vy * 0.12;       // leftover momentum -> bouncy settle
    const sp = Math.hypot(vx, vy);
    b.ang = Math.atan2(vy, vx);
    b.wv = -sp * 0.0045;                                   // squash along the entry direction, then wobble
    player.vx = player.vy = 0;
    fxRing(b.cx, b.cy, b.r * 0.6, b.r * 1.8, 0.4, "rgba(255,255,255,0.8)");
    Sound.play("bubble");
}

function update(dt) {
    gameTime += dt;
    player.noStick = Math.max(0, player.noStick - dt);
    const px = player.x, py = player.y;

    // Bubble idle float + wobble spring
    for (const b of bubbles) {
        b.cx = b.bx + Math.sin(gameTime * 0.9 + b.ph) * 4;
        b.cy = b.by + Math.sin(gameTime * 1.3 + b.ph) * 6;
        b.wv += (-180 * b.w - 7 * b.wv) * dt;
        b.w += b.wv * dt;
    }

    // Launch
    if (Input.released) {
        const pull = dist(Input.startX, Input.startY, Input.x, Input.y);
        if (canLaunch() && pull > MIN_PULL) {
            const v = Trajectory.fromDrag(Input.startX, Input.startY, Input.x, Input.y, POWER, MAX_SPEED);
            const sp = Math.hypot(v.vx, v.vy);
            player.vx = v.vx; player.vy = v.vy;
            player.aimX = v.vx / sp; player.aimY = v.vy / sp;
            if (player.bubble) { popBubble(player.bubble); player.bubble = null; }
            player.stuck = false; player.stuckPad = null; player.frozen = false;
            player.noStick = 0.12;
            const s = clamp(pull / MAX_PULL, 0, 1);
            Sound.play("shoot", { volume: 0.5 + 0.5 * s, rate: 0.9 + 0.2 * s });
            slots = slots.filter(sl => !sl.active);        // an armed trajectory shower is used up by the shot
        }
        Input.released = false;
    }

    // Stretch ("drag a part of the player back") - underdamped spring so it snaps back with a bounce
    let pullTarget = 0;
    if (Input.down && canLaunch()) {
        const pull = dist(Input.startX, Input.startY, Input.x, Input.y);
        if (pull > MIN_PULL) {
            pullTarget = clamp(pull / MAX_PULL, 0, 1);
            player.pdx = (Input.x - Input.startX) / pull;       // tail trails toward the finger
            player.pdy = (Input.y - Input.startY) / pull;
        }
    }
    player.pullV += (-420 * (player.pull - pullTarget) - 20 * player.pullV) * dt;
    player.pull += player.pullV * dt;

    if (player.bubble) {
        // Inside a bubble: spring toward its centre
        const b = player.bubble;
        player.ovx += (-260 * player.ox - 14 * player.ovx) * dt;
        player.ovy += (-260 * player.oy - 14 * player.ovy) * dt;
        player.ox += player.ovx * dt; player.oy += player.ovy * dt;
        player.x = b.cx + player.ox; player.y = b.cy + player.oy;
    } else if (!player.stuck && !player.frozen) {
        // Free flight
        player.vy += GRAVITY * dt;
        player.x += player.vx * dt;
        player.y += player.vy * dt;

        const circ = { x: 0, y: 0, r: PLAYER_R };
        for (const c of walls.concat(pads, obstacles)) {
            circ.x = player.x; circ.y = player.y;
            const r = hitSolid(circ, c);
            if (!r) continue;
            player.x += r.x; player.y += r.y;
            if (c.sticky && player.noStick <= 0 && inStickyZone(c)) {   // grab on
                player.stuck = true; player.stuckPad = c; player.vx = player.vy = 0;
                player.stickBase = Math.atan2(-r.ny, -r.nx);            // towards the surface
                fxRing(player.x, player.y, PLAYER_R, PLAYER_R * 2, 0.3, "rgba(39,198,255,0.8)");
                Sound.play("stick");
                break;
            }
            const vn = player.vx * r.nx + player.vy * r.ny;        // bounce off everything that isn't goo
            if (vn < 0) bounceOff(c, r, vn);
        }

        if (!player.stuck) {
            // Boosters: push along the last aim direction
            for (let i = boosters.length - 1; i >= 0; i--) {
                const o = boosters[i];
                const q = segClosest(px, py, player.x, player.y, o.x, o.y);
                if (dist(q.x, q.y, o.x, o.y) <= PLAYER_R + BOOSTER_R) {
                    player.vx = player.aimX * BOOST_SPEED;
                    player.vy = player.aimY * BOOST_SPEED;
                    fxRing(o.x, o.y, BOOSTER_R, BOOSTER_R * 3, 0.45, "rgba(255,16,240,0.9)");
                    fxSparks(o.x, o.y, 14, COLOR_BOOST, 360);
                    Sound.play("boost");
                    boosters.splice(i, 1);
                }
            }
            // Bubbles: capture when the player's centre passes inside (swept, so fast shots can't tunnel)
            for (const b of bubbles) {
                const q = segClosest(px, py, player.x, player.y, b.cx, b.cy);
                if (dist(q.x, q.y, b.cx, b.cy) <= b.r) { captureBubble(b, q, player.vx, player.vy); break; }
            }
        }
    }

    // Sticky pads curve toward the ball (fully when stuck, a little as it approaches).
    // Green bouncers / obstacles share the same spring (bouncers use it for their squash).
    for (const p of pads.concat(obstacles)) {
        let tgt = 0;
        if (player.stuck && p === player.stuckPad) tgt = 1;
        else if (!p.bounce && !p.kind && !player.bubble && !player.stuck) {
            const dx = Math.max(p.x - player.x, 0, player.x - (p.x + p.w));
            const dy = Math.max(p.y - player.y, 0, player.y - (p.y + p.h));
            tgt = clamp(1 - Math.hypot(dx, dy) / 120, 0, 1) * 0.5;
        }
        p.cv += (-220 * (p.c - tgt) - 12 * p.cv) * dt;         // underdamped -> bouncy wrap
        p.c += p.cv * dt;
    }

    // Coins
    for (let i = coins.length - 1; i >= 0; i--) {
        const c = coins[i];
        const q = segClosest(px, py, player.x, player.y, c.x, c.y);
        if (dist(q.x, q.y, c.x, c.y) <= PLAYER_R + COIN_R) {
            bonus += COIN_POINTS; coinsCollected++;
            fxText(c.x, c.y - 10, "+" + COIN_POINTS, COLOR_COIN);
            fxDisintegrate(c.x, c.y, COIN_R, COLOR_COIN, 30);
            coinCombo = (gameTime - lastCoinT < 1.5) ? Math.min(coinCombo + 1, 8) : 0;
            lastCoinT = gameTime;
            Sound.play("coin", { rate: 1 + coinCombo * 0.06 });
            coins.splice(i, 1);
        }
    }

    // Power-up pickups (only while there is a free slot)
    for (let i = powerups.length - 1; i >= 0; i--) {
        const o = powerups[i];
        const q = segClosest(px, py, player.x, player.y, o.x, o.y);
        if (dist(q.x, q.y, o.x, o.y) > PLAYER_R + POWERUP_R || slots.length >= POWER_SLOTS) continue;
        slots.push({ type: o.type, active: false, pop: 1, shake: 0 });
        const col = POWER_DEFS[o.type].color;
        fxRing(o.x, o.y, POWERUP_R, POWERUP_R * 3, 0.45, col);
        fxSparks(o.x, o.y, 16, col, 340);
        fxText(o.x, o.y - 10, o.type === "freeze" ? "FREEZE" : "TRAJECTORY", col);
        Sound.play("power");
        powerups.splice(i, 1);
    }
    for (const sl of slots) { sl.pop *= 0.9; sl.shake *= 0.88; }

    // Effects
    for (let i = fx.length - 1; i >= 0; i--) {
        const f = fx[i]; f.t += dt;
        if (f.type === "spark") { f.vy += 500 * dt; f.x += f.vx * dt; f.y += f.vy * dt; }
        else if (f.type === "bit") { f.vy += 1300 * dt; f.vx *= 1 - 1.5 * dt; f.x += f.vx * dt; f.y += f.vy * dt; }
        if (f.t >= f.life) fx.splice(i, 1);
    }

    // Speed trail: only while flying fast; strength follows the speed
    for (let i = trail.length - 1; i >= 0; i--) { trail[i].t += dt; if (trail[i].t >= TRAIL_LIFE) trail.splice(i, 1); }
    if (!player.bubble && !player.stuck) {
        const sp = Math.hypot(player.vx, player.vy);
        if (sp > TRAIL_MIN) trail.push({ x: player.x, y: player.y, t: 0, s: clamp((sp - TRAIL_MIN) / (TRAIL_FULL - TRAIL_MIN), 0, 1) });
    }

    updateSkin(dt);

    // Smooth camera (frame-rate independent), slight look-ahead in travel direction
    const playerTarget = player.y - view.h * 0.6;
    bestCamTarget = Math.min(bestCamTarget, playerTarget);
    let target = Math.min(playerTarget, bestCamTarget + view.h * 0.3);   // limits how far it follows a fall
    target += clamp(player.vy * 0.08, -90, 60);
    camera.y += (target - camera.y) * (1 - Math.exp(-CAM_SMOOTH * dt));

    generate();

    maxHeight = Math.max(maxHeight, Math.floor((originY - player.y) / 10));
    best = Math.max(best, score());
    if (!player.bubble && !player.stuck && !player.frozen && player.y > camera.y + view.h + 200) {
        gameOver();
    }
}

/* =========================================================
   VISUALS: topographic neon walls, starfield, glowing sticky objects
   ========================================================= */
const COLOR_ROUTE = 600;                 // height at which the wall lines reach bright yellow
let colorProgress = 0;                   // 0..1, smoothed

// Neon-only gradient (starts white, ends bright yellow)
const NEON_STOPS = [
    [255, 255, 255],   // white
    [0, 240, 255],     // neon cyan
    [31, 81, 255],     // neon blue
    [191, 0, 255],     // neon purple
    [255, 16, 240],    // neon pink
    [255, 106, 0],     // neon orange
    [255, 255, 0],     // bright yellow
];
function neonAt(q) {
    q = clamp(q, 0, 1) * (NEON_STOPS.length - 1);
    const i = Math.min(Math.floor(q), NEON_STOPS.length - 2), f = q - i;
    const a = NEON_STOPS[i], b = NEON_STOPS[i + 1];
    return `rgb(${Math.round(lerp(a[0], b[0], f))},${Math.round(lerp(a[1], b[1], f))},${Math.round(lerp(a[2], b[2], f))})`;
}
const NEON_BUCKETS = 32;
const NEON_CACHE = Array.from({ length: NEON_BUCKETS + 1 }, (_, i) => neonAt(i / NEON_BUCKETS));

// --- value noise (for contour field) ---
function hash2(x, y) {
    let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function valueNoise(x, y) {
    const ix = Math.floor(x), iy = Math.floor(y);
    let fx = x - ix, fy = y - iy;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    const a = hash2(ix, iy), b = hash2(ix + 1, iy), c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
    return lerp(lerp(a, b, fx), lerp(c, d, fx), fy);
}
function terrain(x, y, t) {              // drifts slowly over time -> animated contours
    return 0.6 * valueNoise(x * 0.011 + t * 0.05, y * 0.011 - t * 0.07)
         + 0.4 * valueNoise(x * 0.026 - t * 0.08, y * 0.026 + t * 0.04);
}

// Marching-squares edge pairs. Edges: 0 top, 1 right, 2 bottom, 3 left
const MS_CASES = [
    [], [[3, 0]], [[0, 1]], [[3, 1]], [[1, 2]], [[3, 0], [1, 2]], [[0, 2]], [[3, 2]],
    [[2, 3]], [[0, 2]], [[0, 1], [2, 3]], [[1, 2]], [[3, 1]], [[0, 1]], [[3, 0]], [],
];

function drawWalls(T) {
    const cell = 8, LS = 0.07, L0 = 0.18;
    const buckets = new Array(NEON_BUCKETS + 1).fill(null);
    const y0 = Math.floor(camera.y / cell) - 1;
    const rows = Math.ceil(view.h / cell) + 3;

    for (const w of walls) {
        // dark blue base, lighter toward the playfield
        const inner = w.x === 0 ? w.x + w.w : w.x;
        const outer = w.x === 0 ? w.x : w.x + w.w;
        const g = ctx.createLinearGradient(outer, 0, inner, 0);
        g.addColorStop(0, "#040b24"); g.addColorStop(1, "#0d2366");
        ctx.fillStyle = g;
        ctx.fillRect(w.x, camera.y, w.w, view.h);

        // sample the terrain field on a world-aligned grid (stable while scrolling)
        const cols = Math.round(w.w / cell), stride = cols + 1;
        const vals = new Float32Array(stride * (rows + 1));
        for (let j = 0; j <= rows; j++)
            for (let i = 0; i <= cols; i++)
                vals[j * stride + i] = terrain(w.x + i * cell, (y0 + j) * cell, T);

        for (let j = 0; j < rows; j++) {
            const yt = (y0 + j) * cell, yb = yt + cell;
            for (let i = 0; i < cols; i++) {
                const xl = w.x + i * cell, xr = xl + cell;
                const a = vals[j * stride + i], b = vals[j * stride + i + 1];
                const c = vals[(j + 1) * stride + i + 1], d = vals[(j + 1) * stride + i];
                const mn = Math.min(a, b, c, d), mx = Math.max(a, b, c, d);
                const k0 = Math.ceil((mn - L0) / LS), k1 = Math.floor((mx - L0) / LS);
                for (let k = k0; k <= k1; k++) {
                    const th = L0 + k * LS;
                    const idx = (a > th ? 1 : 0) | (b > th ? 2 : 0) | (c > th ? 4 : 0) | (d > th ? 8 : 0);
                    for (const [e1, e2] of MS_CASES[idx]) {
                        const p1 = edgePoint(e1, th, a, b, c, d, xl, xr, yt, yb);
                        const p2 = edgePoint(e2, th, a, b, c, d, xl, xr, yt, yb);
                        const ym = (p1[1] + p2[1]) / 2;
                        const q = clamp(colorProgress + 0.07 * Math.sin(T * 1.4 + ym * 0.006), 0, 1);
                        const bi = Math.round(q * NEON_BUCKETS);
                        const path = buckets[bi] || (buckets[bi] = new Path2D());
                        path.moveTo(p1[0], p1[1]); path.lineTo(p2[0], p2[1]);
                    }
                }
            }
        }
    }

    strokeContours(buckets, T);

    // glowing inner edge in the current neon colour
    const k = view.dpr * view.scale;
    const edgeCol = neonAt(clamp(colorProgress + 0.05 * Math.sin(T * 1.4), 0, 1));
    ctx.save();
    ctx.shadowColor = edgeCol; ctx.shadowBlur = 12 * k;
    for (const w of walls) {
        const ex = w.x === 0 ? w.x + w.w : w.x;
        drawLine(ex, camera.y, ex, camera.y + view.h, edgeCol, 3);
    }
    ctx.restore();
}

// strokes the neon contour buckets (shared by walls and obstacles -> identical pattern)
function strokeContours(buckets, T) {
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    const pulse = 0.85 + 0.15 * Math.sin(T * 2);
    for (let i = 0; i <= NEON_BUCKETS; i++) {
        if (!buckets[i]) continue;
        ctx.strokeStyle = NEON_CACHE[i];
        ctx.globalAlpha = 0.18 * pulse; ctx.lineWidth = 5; ctx.stroke(buckets[i]);   // soft glow pass
        ctx.globalAlpha = pulse; ctx.lineWidth = 1.6; ctx.stroke(buckets[i]);        // crisp line
    }
    ctx.globalAlpha = 1;
}

// Same terrain field / levels / cell size as drawWalls, for an arbitrary world-space box
function contourInto(buckets, T, bx, by, bw, bh) {
    const cell = 8, LS = 0.07, L0 = 0.18;
    const i0 = Math.floor(bx / cell), j0 = Math.floor(by / cell);
    const cols = Math.ceil(bw / cell) + 2, rows = Math.ceil(bh / cell) + 2, stride = cols + 1;
    const vals = new Float32Array(stride * (rows + 1));
    for (let j = 0; j <= rows; j++)
        for (let i = 0; i <= cols; i++)
            vals[j * stride + i] = terrain((i0 + i) * cell, (j0 + j) * cell, T);
    for (let j = 0; j < rows; j++) {
        const yt = (j0 + j) * cell, yb = yt + cell;
        for (let i = 0; i < cols; i++) {
            const xl = (i0 + i) * cell, xr = xl + cell;
            const a = vals[j * stride + i], b = vals[j * stride + i + 1];
            const c = vals[(j + 1) * stride + i + 1], d = vals[(j + 1) * stride + i];
            const mn = Math.min(a, b, c, d), mx = Math.max(a, b, c, d);
            const k0 = Math.ceil((mn - L0) / LS), k1 = Math.floor((mx - L0) / LS);
            for (let k = k0; k <= k1; k++) {
                const th = L0 + k * LS;
                const idx = (a > th ? 1 : 0) | (b > th ? 2 : 0) | (c > th ? 4 : 0) | (d > th ? 8 : 0);
                for (const [e1, e2] of MS_CASES[idx]) {
                    const p1 = edgePoint(e1, th, a, b, c, d, xl, xr, yt, yb);
                    const p2 = edgePoint(e2, th, a, b, c, d, xl, xr, yt, yb);
                    const ym = (p1[1] + p2[1]) / 2;
                    const q = clamp(colorProgress + 0.07 * Math.sin(T * 1.4 + ym * 0.006), 0, 1);
                    const bi = Math.round(q * NEON_BUCKETS);
                    const path = buckets[bi] || (buckets[bi] = new Path2D());
                    path.moveTo(p1[0], p1[1]); path.lineTo(p2[0], p2[1]);
                }
            }
        }
    }
}

function edgePoint(e, th, a, b, c, d, xl, xr, yt, yb) {
    switch (e) {
        case 0: return [xl + (xr - xl) * (th - a) / (b - a), yt];
        case 1: return [xr, yt + (yb - yt) * (th - b) / (c - b)];
        case 2: return [xl + (xr - xl) * (th - d) / (c - d), yb];
        default: return [xl, yt + (yb - yt) * (th - a) / (d - a)];
    }
}

// --- starfield: stars fall at random speeds, sway, twinkle, and respawn at random x ---
const STAR_COLORS = ["#ffffff", "#bfe6ff", "#fff6c2", "#c9b8ff"];
const stars = [];
[{ n: 55, r: 0.8, par: 0.04, fall: [5, 18] }, { n: 35, r: 1.3, par: 0.10, fall: [14, 42] }, { n: 16, r: 2.0, par: 0.20, fall: [30, 85] }]
    .forEach(L => {
        for (let i = 0; i < L.n; i++) stars.push({
            id: stars.length, y: Math.random(),
            r: L.r * (0.7 + Math.random() * 0.6), par: L.par,
            dr: L.fall[0] + Math.random() * (L.fall[1] - L.fall[0]),     // own fall speed
            sa: Math.random() * 10, sw: 0.3 + Math.random() * 0.9,        // sideways sway
            ph: Math.random() * 6.283, tw: 1 + Math.random() * 2.5,
            c: STAR_COLORS[Math.floor(Math.random() * STAR_COLORS.length)],
        });
    });
const shootingStars = [];
let nextShoot = 2, lastBgT = 0;

function drawBackground(T) {
    const dt = clamp(T - lastBgT, 0, 0.1); lastBgT = T;
    const g = ctx.createLinearGradient(0, 0, 0, view.h);
    g.addColorStop(0, "#010207"); g.addColorStop(1, "#040a1f");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, view.w, view.h);

    for (const s of stars) {
        const raw = s.y * view.h + T * s.dr - camera.y * s.par;
        const cycle = Math.floor(raw / view.h);
        const yy = raw - cycle * view.h;
        const xx = hash2(cycle, s.id) * view.w + Math.sin(T * s.sw + s.ph) * s.sa;   // new random x each fall
        const tw = 0.5 + 0.5 * Math.sin(T * s.tw + s.ph);
        if (s.r > 1.6) { ctx.globalAlpha = 0.12 * tw; drawCircle(xx, yy, s.r * 3.5, s.c); }
        ctx.globalAlpha = 0.25 + 0.75 * tw;
        drawCircle(xx, yy, s.r, s.c);
    }

    // occasional shooting star
    nextShoot -= dt;
    if (nextShoot <= 0) {
        const dir = Math.random() < 0.5 ? -1 : 1;
        shootingStars.push({ x: Math.random() * view.w, y: -20, vx: dir * (120 + Math.random() * 260), vy: 380 + Math.random() * 380, t: 0, life: 1.2 });
        nextShoot = 2.5 + Math.random() * 4.5;
    }
    for (let i = shootingStars.length - 1; i >= 0; i--) {
        const s = shootingStars[i];
        s.t += dt; s.x += s.vx * dt; s.y += s.vy * dt;
        const sp = Math.hypot(s.vx, s.vy), tx = s.x - (s.vx / sp) * 70, ty = s.y - (s.vy / sp) * 70;
        const lg = ctx.createLinearGradient(tx, ty, s.x, s.y);
        lg.addColorStop(0, "rgba(255,255,255,0)"); lg.addColorStop(1, "rgba(255,255,255,0.85)");
        ctx.globalAlpha = 1 - s.t / s.life;
        drawLine(tx, ty, s.x, s.y, lg, 2);
        if (s.t >= s.life || s.y > view.h + 80) shootingStars.splice(i, 1);
    }
    ctx.globalAlpha = 1;
}

// --- sticky pad: glowing capsule that curves toward / wraps around the ball ---
function drawPad(p, T) {
    if (p.bounce) { drawBouncer(p, T); return; }
    const k = view.dpr * view.scale;
    const pulse = 0.5 + 0.5 * Math.sin(T * 3 + p.x * 0.02 + p.y * 0.013);
    const dir = p.x < VIRTUAL_W / 2 ? 1 : -1;
    const cx = p.x + p.w / 2, r = p.w / 2, y0 = p.y + r, y1 = p.y + p.h - r;
    const cover = clamp(p.c, -0.3, 1.35);
    const ctrlX = cx + dir * cover * 44, ctrlY = clamp(player.y, y0, y1);
    ctx.save();
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath(); ctx.moveTo(cx, y0); ctx.quadraticCurveTo(ctrlX, ctrlY, cx, y1);
    ctx.strokeStyle = COLOR_STICKY; ctx.shadowColor = COLOR_STICKY; ctx.lineWidth = p.w;
    for (let i = 0; i < 2; i++) { ctx.shadowBlur = (14 + 16 * pulse) * k * (i ? 0.5 : 1); ctx.stroke(); }
    ctx.shadowBlur = 0;
    ctx.strokeStyle = `rgba(255,255,255,${0.3 + 0.2 * pulse})`; ctx.lineWidth = p.w - 10; ctx.stroke();
    ctx.restore();
}

// --- sticky cradle that wraps over the ball while it is stuck ---
function drawCradle(T) {
    const p = player.stuckPad;
    if (!player.stuck || !p) return;
    const k = view.dpr * view.scale;
    const base = player.stickBase;                                      // direction from ball to what it sticks to
    const half = lerp(0.5, 1.9, clamp(p.c, 0, 1.25));                   // opens up as the pad wraps around
    ctx.save();
    ctx.lineCap = "round";
    ctx.beginPath(); ctx.arc(player.x, player.y, PLAYER_R + 3, base - half, base + half);
    ctx.strokeStyle = COLOR_STICKY; ctx.shadowColor = COLOR_STICKY; ctx.shadowBlur = 12 * k; ctx.lineWidth = 11; ctx.stroke();
    ctx.shadowBlur = 0; ctx.strokeStyle = "rgba(255,255,255,0.35)"; ctx.lineWidth = 4; ctx.stroke();
    ctx.restore();
}

// --- air obstacle: wall-style contour pattern clipped to a circle / rhombus, optional sticky goo patch ---
function obstaclePath(o) {
    ctx.beginPath();
    if (o.kind === "circle") { ctx.arc(o.x, o.y, o.r, 0, Math.PI * 2); return; }
    o.pts.forEach((q, i) => i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y));
    ctx.closePath();
}

function drawObstacle(o, T) {
    if (o.y + o.br < camera.y - 20 || o.y - o.br > camera.y + view.h + 20) return;
    const k = view.dpr * view.scale;

    ctx.save();                                           // body + contour lines (clipped to the shape)
    obstaclePath(o); ctx.clip();
    const g = ctx.createRadialGradient(o.x, o.y, 0, o.x, o.y, o.br);
    g.addColorStop(0, "#040b24"); g.addColorStop(1, "#0d2366");
    ctx.fillStyle = g; ctx.fillRect(o.x - o.br, o.y - o.br, o.br * 2, o.br * 2);
    const buckets = new Array(NEON_BUCKETS + 1).fill(null);
    contourInto(buckets, T, o.x - o.br, o.y - o.br, o.br * 2, o.br * 2);
    strokeContours(buckets, T);
    ctx.restore();

    const edgeCol = neonAt(clamp(colorProgress + 0.05 * Math.sin(T * 1.4), 0, 1));
    ctx.save();                                           // glowing rim in the current neon colour
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    ctx.shadowColor = edgeCol; ctx.shadowBlur = 12 * k;
    obstaclePath(o); ctx.strokeStyle = edgeCol; ctx.lineWidth = 3; ctx.stroke();
    ctx.restore();

    if (o.sticky) {                                       // goo patch only on part of the rim
        const pulse = 0.5 + 0.5 * Math.sin(T * 3 + o.ph);
        ctx.save();
        ctx.beginPath(); ctx.moveTo(o.x, o.y);
        ctx.arc(o.x, o.y, o.br * 3, o.sa - o.sh, o.sa + o.sh); ctx.closePath(); ctx.clip();
        ctx.lineJoin = "round"; ctx.lineCap = "round";
        obstaclePath(o);
        ctx.strokeStyle = COLOR_STICKY; ctx.shadowColor = COLOR_STICKY; ctx.lineWidth = 12;
        for (let i = 0; i < 2; i++) { ctx.shadowBlur = (14 + 16 * pulse) * k * (i ? 0.5 : 1); ctx.stroke(); }
        ctx.shadowBlur = 0;
        ctx.strokeStyle = `rgba(255,255,255,${0.3 + 0.2 * pulse})`; ctx.lineWidth = 5; ctx.stroke();
        ctx.restore();
    }
}

// --- green bouncer: small glowing capsule on a side wall that bulges when hit ---
function drawBouncer(p, T) {
    const k = view.dpr * view.scale;
    const pulse = 0.5 + 0.5 * Math.sin(T * 4 + p.y * 0.02);
    const dir = p.x < VIRTUAL_W / 2 ? 1 : -1;             // +1 = faces right (left wall)
    const wTot = p.w + clamp(p.c, -0.25, 1.1) * 16;       // squash / bulge from the spring
    const cx = dir > 0 ? p.x + wTot / 2 : p.x + p.w - wTot / 2;
    const y0 = p.y + p.w / 2, y1 = p.y + p.h - p.w / 2;
    ctx.save();
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath(); ctx.moveTo(cx, y0); ctx.lineTo(cx, y1);
    ctx.strokeStyle = COLOR_BOUNCE; ctx.shadowColor = COLOR_BOUNCE; ctx.lineWidth = wTot;
    for (let i = 0; i < 2; i++) { ctx.shadowBlur = (12 + 14 * pulse) * k * (i ? 0.5 : 1); ctx.stroke(); }
    ctx.shadowBlur = 0;
    ctx.strokeStyle = `rgba(255,255,255,${0.3 + 0.2 * pulse})`; ctx.lineWidth = Math.max(2, wTot - 10); ctx.stroke();
    ctx.translate(cx, (y0 + y1) / 2);                     // chevrons point away from the wall
    if (dir < 0) ctx.scale(-1, 1);
    ctx.lineWidth = 3; ctx.strokeStyle = "#eafff0";
    [-18, 0, 18].forEach((oy, i) => {
        ctx.globalAlpha = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(T * 7 - i * 1.4));
        ctx.beginPath(); ctx.moveTo(-3, oy - 6); ctx.lineTo(3, oy); ctx.lineTo(-3, oy + 6); ctx.stroke();
    });
    ctx.restore();
}

/* ---------- drawing: bubbles, boosters, coins, player, fx, HUD ---------- */
function drawBubble(b, T) {
    const k = view.dpr * view.scale;
    const breathe = b === player.bubble ? 0 : 0.03 * Math.sin(T * 2 + b.ph);
    const w = clamp(b.w + breathe, -0.35, 0.35);
    ctx.save();
    ctx.translate(b.cx, b.cy);
    ctx.rotate(b.ang);
    ctx.scale(1 + w, 1 / (1 + w));                       // area-preserving squash & stretch
    const g = ctx.createRadialGradient(0, 0, b.r * 0.2, 0, 0, b.r);
    g.addColorStop(0, "rgba(140,200,255,0.03)");
    g.addColorStop(0.75, "rgba(140,210,255,0.09)");
    g.addColorStop(1, "rgba(170,230,255,0.28)");
    ctx.beginPath(); ctx.arc(0, 0, b.r, 0, Math.PI * 2);
    ctx.fillStyle = g; ctx.fill();
    ctx.shadowColor = "rgba(120,200,255,0.8)"; ctx.shadowBlur = 10 * k;
    ctx.lineWidth = 1.5; ctx.strokeStyle = "rgba(190,235,255,0.5)"; ctx.stroke();
    ctx.restore();
    ctx.beginPath();
    ctx.ellipse(b.cx - b.r * 0.38, b.cy - b.r * 0.42, b.r * 0.18, b.r * 0.1, -0.7, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.45)"; ctx.fill();
}

function drawBooster(o, T, aim) {
    const k = view.dpr * view.scale;
    const pulse = 0.5 + 0.5 * Math.sin(T * 4 + o.ph);
    ctx.save();
    ctx.translate(o.x, o.y);
    ctx.shadowColor = COLOR_BOOST; ctx.shadowBlur = (14 + 10 * pulse) * k;
    ctx.beginPath(); ctx.arc(0, 0, BOOSTER_R * (0.95 + 0.05 * pulse), 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,16,240,0.18)"; ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = COLOR_BOOST; ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.rotate(Math.atan2(aim.y, aim.x));                // chevrons show the direction you'd be boosted
    ctx.lineWidth = 3.5; ctx.lineCap = "round"; ctx.lineJoin = "round";
    [-9, 5].forEach((ox, i) => {
        ctx.globalAlpha = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(T * 6 - i * 1.6 + o.ph));
        ctx.strokeStyle = "#fff";
        ctx.beginPath(); ctx.moveTo(ox - 6, -10); ctx.lineTo(ox + 4, 0); ctx.lineTo(ox - 6, 10); ctx.stroke();
    });
    ctx.restore();
}

function drawCoin(c, T) {
    const k = view.dpr * view.scale;
    const bob = Math.sin(T * 2.5 + c.ph) * 3;
    const sx = Math.max(0.12, Math.abs(Math.cos(T * 2.5 + c.ph * 0.5)));   // spin
    ctx.save();
    ctx.shadowColor = COLOR_COIN; ctx.shadowBlur = 10 * k;
    ctx.fillStyle = COLOR_COIN;
    ctx.beginPath(); ctx.ellipse(c.x, c.y + bob, COIN_R * sx, COIN_R, 0, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.beginPath(); ctx.ellipse(c.x, c.y + bob, COIN_R * sx * 0.5, COIN_R * 0.5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
}

// teardrop / hull path around two circles (one smooth shape, no seams)
function hullPath(x1, y1, r1, x2, y2, r2, g = ctx) {
    const d = Math.hypot(x2 - x1, y2 - y1);
    g.beginPath();
    if (d < 0.5 || d <= Math.abs(r1 - r2)) {
        const big = r1 >= r2 ? [x1, y1, r1] : [x2, y2, r2];
        g.arc(big[0], big[1], big[2], 0, Math.PI * 2);
        return;
    }
    const th = Math.atan2(y2 - y1, x2 - x1), a = Math.acos((r1 - r2) / d);
    g.arc(x1, y1, r1, th + a, th + Math.PI * 2 - a);
    g.arc(x2, y2, r2, th - a, th + a);
    g.closePath();
}

/* =========================================================
   SKINS  (all drawn in code; `g` is any 2D context so the menu can reuse them)
   ========================================================= */
const TAU = Math.PI * 2;
const SOLID_COLORS = [
    { id: "yellow", hi: "#fff3b0", mid: "#ffc21a", lo: "#ff9d00" },
    { id: "blue",   hi: "#cfe8ff", mid: "#2d8cff", lo: "#1450d8" },
    { id: "pink",   hi: "#ffd6f0", mid: "#ff4fc0", lo: "#d01a8f" },
];
// colors: has the 3-colour picker | eyes: googly eyes | fixed: art does not roll with the ball
const SKINS = [
    { id: "plain",   name: "Plain",      colors: true },
    { id: "eyes",    name: "Eyes",       colors: true, eyes: true },
    { id: "earth",   name: "Earth",      base: "#1f6fd1" },
    { id: "moon",    name: "Moon",       base: "#b8b8c4" },
    { id: "mars",    name: "Mars",       base: "#c1532e" },
    { id: "jupiter", name: "Jupiter",    base: "#d8b48a", fixed: true },
    { id: "saturn",  name: "Saturn",     base: "#e6cd8f", fixed: true },
    { id: "ufo",     name: "UFO" },
    { id: "basket",  name: "Basketball", base: "#e8731c" },
    { id: "soccer",  name: "Soccer",     base: "#f4f4f4" },
    { id: "tennis",  name: "Tennis",     base: "#c9e72c" },
    { id: "eight",   name: "8-Ball",     base: "#16161f" },
    { id: "beach",   name: "Beach",      base: "#ff5a5a" },
];
const SKIN_BY_ID = Object.fromEntries(SKINS.map(k => [k.id, k]));

function blob(g, x, y, rx, ry, rot = 0) { g.beginPath(); g.ellipse(x, y, rx, ry, rot, 0, TAU); g.fill(); }
function dot(g, x, y, r) { g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill(); }
function pent(g, cx, cy, r, rot) {
    g.beginPath();
    for (let i = 0; i < 5; i++) {
        const a = rot + i * TAU / 5, px = cx + Math.cos(a) * r, py = cy + Math.sin(a) * r;
        i ? g.lineTo(px, py) : g.moveTo(px, py);
    }
    g.closePath(); g.fill();
}
function bands(g, R, cols) {
    const h = 2 * R / cols.length;
    cols.forEach((c, i) => { g.fillStyle = c; g.fillRect(-R, -R + i * h, 2 * R, h + 1); });
}

// Art is drawn centred on (0,0), already rotated by the ball's roll (unless the skin is `fixed`)
const ART = {
    earth(g, R) {
        g.fillStyle = "#3fae4f";
        blob(g, -0.35 * R, -0.25 * R, 0.42 * R, 0.30 * R, 0.4);
        blob(g, 0.40 * R, 0.20 * R, 0.32 * R, 0.45 * R, -0.3);
        blob(g, -0.15 * R, 0.62 * R, 0.30 * R, 0.18 * R, 0.1);
        blob(g, 0.55 * R, -0.50 * R, 0.20 * R, 0.14 * R, 0);
        g.fillStyle = "rgba(255,255,255,0.45)";
        blob(g, 0.10 * R, -0.45 * R, 0.40 * R, 0.08 * R, 0.2);
        blob(g, -0.45 * R, 0.30 * R, 0.32 * R, 0.07 * R, -0.2);
    },
    moon(g, R) {
        g.fillStyle = "rgba(95,95,110,0.5)";
        dot(g, -0.30 * R, -0.30 * R, 0.22 * R); dot(g, 0.35 * R, 0.10 * R, 0.28 * R);
        dot(g, -0.10 * R, 0.45 * R, 0.16 * R); dot(g, 0.50 * R, -0.50 * R, 0.12 * R);
        dot(g, -0.58 * R, 0.20 * R, 0.10 * R);
        g.fillStyle = "rgba(255,255,255,0.18)";
        dot(g, -0.33 * R, -0.34 * R, 0.12 * R); dot(g, 0.31 * R, 0.05 * R, 0.14 * R);
    },
    mars(g, R) {
        g.fillStyle = "rgba(110,35,18,0.55)";
        blob(g, -0.30 * R, 0.10 * R, 0.50 * R, 0.25 * R, 0.3);
        blob(g, 0.40 * R, -0.20 * R, 0.30 * R, 0.20 * R, -0.4);
        blob(g, 0.10 * R, 0.55 * R, 0.35 * R, 0.18 * R, 0);
        g.fillStyle = "rgba(80,25,12,0.5)";
        dot(g, 0.45 * R, 0.35 * R, 0.10 * R); dot(g, -0.5 * R, -0.35 * R, 0.08 * R);
        g.fillStyle = "rgba(255,255,255,0.85)";
        blob(g, 0, -0.98 * R, 0.5 * R, 0.22 * R);
    },
    jupiter(g, R, o) {
        bands(g, R, ["#c99a6e", "#e6cba2", "#b5835a", "#f0ddb8", "#c08a5c", "#e2c49a", "#a97850"]);
        const ph = o.rot || 0, vis = Math.cos(ph);               // red spot drifts across as the ball "spins"
        if (vis > -0.2) { g.fillStyle = "#c4492f"; blob(g, Math.sin(ph) * 0.7 * R, 0.3 * R, 0.28 * R * Math.max(0.2, vis), 0.16 * R); }
    },
    saturn(g, R) { bands(g, R, ["#e6cd8f", "#d9bd7c", "#efdba6", "#d2b374", "#e6cd8f"]); },
    basket(g, R) {
        g.strokeStyle = "#2b1407"; g.lineWidth = R * 0.09; g.lineCap = "round";
        g.beginPath(); g.moveTo(0, -R); g.lineTo(0, R); g.moveTo(-R, 0); g.lineTo(R, 0);
        g.moveTo(-R * 0.7, -R * 0.7); g.quadraticCurveTo(-R * 0.15, 0, -R * 0.7, R * 0.7);
        g.moveTo(R * 0.7, -R * 0.7); g.quadraticCurveTo(R * 0.15, 0, R * 0.7, R * 0.7);
        g.stroke();
    },
    soccer(g, R) {
        g.fillStyle = g.strokeStyle = "#1d1d24"; g.lineWidth = R * 0.06; g.lineCap = "round";
        pent(g, 0, 0, 0.36 * R, -Math.PI / 2);
        for (let k = 0; k < 5; k++) {
            const a = -Math.PI / 2 + k * TAU / 5;
            g.beginPath(); g.moveTo(Math.cos(a) * 0.36 * R, Math.sin(a) * 0.36 * R); g.lineTo(Math.cos(a) * 0.68 * R, Math.sin(a) * 0.68 * R); g.stroke();
            const b = a + Math.PI / 5;
            pent(g, Math.cos(b) * 1.0 * R, Math.sin(b) * 1.0 * R, 0.34 * R, b);
        }
    },
    tennis(g, R) {
        g.strokeStyle = "rgba(255,255,255,0.92)"; g.lineWidth = R * 0.11; g.lineCap = "round";
        g.beginPath(); g.arc(-R * 1.45, 0, R * 1.1, -0.95, 0.95); g.stroke();
        g.beginPath(); g.arc(R * 1.45, 0, R * 1.1, Math.PI - 0.95, Math.PI + 0.95); g.stroke();
    },
    eight(g, R) {
        g.fillStyle = "#fff"; dot(g, 0, 0, 0.46 * R);
        g.fillStyle = "#111"; g.font = `bold ${R * 0.68}px Arial`; g.textAlign = "center"; g.textBaseline = "middle";
        g.fillText("8", 0, R * 0.04);
    },
    beach(g, R) {
        const cols = ["#ff4d4d", "#ffffff", "#2f7bff", "#ffd23f", "#2fd16b", "#ffffff"];
        cols.forEach((c, i) => {
            g.fillStyle = c; g.beginPath(); g.moveTo(0, 0);
            g.arc(0, 0, R * 1.6, i * Math.PI / 3, (i + 1) * Math.PI / 3); g.closePath(); g.fill();
        });
        g.fillStyle = "#fff"; dot(g, 0, 0, 0.14 * R);
    },
};

function saturnRing(g, x, y, R, back) {           // back half is drawn behind the planet, front half over it
    g.save(); g.translate(x, y); g.rotate(-0.38); g.lineCap = "butt";
    g.beginPath(); g.ellipse(0, 0, R * 1.7, R * 0.5, 0, back ? Math.PI : 0, back ? TAU : Math.PI);
    g.strokeStyle = "rgba(214,184,126,0.95)"; g.lineWidth = R * 0.3; g.stroke();
    g.strokeStyle = "rgba(120,92,50,0.55)"; g.lineWidth = R * 0.06; g.stroke();
    g.restore();
}

function drawUfo(g, x, y, R, o) {
    const T = o.T || 0, pull = clamp(o.pull || 0, -0.6, 1.2), k = o.k || 1;
    g.save();
    g.translate(x, y); g.rotate(clamp(o.tilt || 0, -0.4, 0.4)); g.scale(1 + 0.18 * pull, 1 - 0.12 * pull);
    // saucer disc
    let gr = g.createLinearGradient(0, -R * 0.3, 0, R * 0.6);
    gr.addColorStop(0, "#eef2fa"); gr.addColorStop(1, "#7f8aa3");
    g.shadowColor = "rgba(110,255,200,0.7)"; g.shadowBlur = 14 * k;
    g.beginPath(); g.ellipse(0, R * 0.15, R * 1.3, R * 0.42, 0, 0, TAU); g.fillStyle = gr; g.fill();
    g.shadowBlur = 0;
    // dome + little alien
    gr = g.createLinearGradient(0, -R * 0.7, 0, 0);
    gr.addColorStop(0, "rgba(190,250,255,0.95)"); gr.addColorStop(1, "rgba(80,190,230,0.75)");
    g.beginPath(); g.arc(0, 0, R * 0.62, Math.PI, 0); g.closePath(); g.fillStyle = gr; g.fill();
    g.fillStyle = "#7dff6a"; dot(g, 0, -R * 0.2, R * 0.2);
    g.fillStyle = "#111"; dot(g, -R * 0.08, -R * 0.22, R * 0.04); dot(g, R * 0.08, -R * 0.22, R * 0.04);
    g.strokeStyle = "rgba(255,255,255,0.55)"; g.lineWidth = 1.5;
    g.beginPath(); g.arc(0, 0, R * 0.62, Math.PI, 0); g.stroke();
    // blinking rim lights
    for (let i = 0; i < 5; i++) {
        const lx = (i - 2) * R * 0.5, ly = R * 0.15 + R * 0.42 * 0.8 * Math.sqrt(Math.max(0, 1 - (lx / (R * 1.3)) ** 2));
        g.fillStyle = `hsl(${(T * 140 + i * 72) % 360}, 100%, ${55 + 20 * Math.sin(T * 6 + i)}%)`;
        dot(g, lx, ly, R * 0.09);
    }
    g.restore();
}

function drawEyes(g, x, y, R, o) {
    const lx = o.eyeX || 0, ly = o.eyeY || 0, open = o.blink == null ? 1 : o.blink;
    const er = R * 0.27, gap = R * 0.34, cx = x + lx * R * 0.1, cy = y - R * 0.05 + ly * R * 0.08;
    for (const sgn of [-1, 1]) {
        g.save();
        g.translate(cx + sgn * gap, cy);
        g.scale(1, Math.max(0.08, open));
        g.beginPath(); g.ellipse(0, 0, er, er * 1.12, 0, 0, TAU);
        g.fillStyle = "#fff"; g.fill();
        g.lineWidth = 1.5; g.strokeStyle = "rgba(0,0,0,0.35)"; g.stroke();
        const pr = er * 0.52, px = lx * er * 0.42, py = ly * er * 0.45;
        g.fillStyle = "#111"; dot(g, px, py, pr);
        g.fillStyle = "#fff"; dot(g, px - pr * 0.3, py - pr * 0.3, pr * 0.28);
        g.restore();
    }
}

// One call draws any skin. o: {T, k, rot, pull, pdx, pdy, eyeX, eyeY, blink, tilt}
function drawBall(g, x, y, R, skinId, colorId, o = {}) {
    const sk = SKIN_BY_ID[skinId] || SKIN_BY_ID.plain;
    if (sk.id === "ufo") { drawUfo(g, x, y, R, o); return; }
    const pull = clamp(o.pull || 0, -0.6, 1.2), sl = pull * 32;                    // stretched "tail" while aiming
    const c2x = x + (o.pdx || 0) * sl, c2y = y + (o.pdy || 0) * sl;
    const r2 = Math.max(R * 0.5, R * (1 - 0.3 * pull));
    g.save();
    g.shadowBlur = 0;
    if (sk.id === "saturn") saturnRing(g, x, y, R, true);
    hullPath(x, y, R, c2x, c2y, r2, g);
    if (sk.colors) {
        const col = SOLID_COLORS.find(c => c.id === colorId) || SOLID_COLORS[0];
        const gr = g.createRadialGradient(x - R * 0.3, y - R * 0.35, 2, x, y, R * 2.4 + Math.abs(sl));
        gr.addColorStop(0, col.hi); gr.addColorStop(0.35, col.mid); gr.addColorStop(1, col.lo);
        g.fillStyle = gr; g.fill();
        g.fillStyle = "rgba(255,255,255,0.5)";
        g.beginPath(); g.ellipse(x - R * 0.33, y - R * 0.4, R * 0.22, R * 0.12, -0.7, 0, TAU); g.fill();
    } else {
        g.fillStyle = sk.base; g.fill();
        g.clip();
        g.save();
        g.translate(x, y);
        if (!sk.fixed) g.rotate(o.rot || 0);
        ART[sk.id](g, R, o);
        g.restore();
        const sg = g.createRadialGradient(x - R * 0.35, y - R * 0.4, R * 0.1, x, y, R * 1.05);
        sg.addColorStop(0, "rgba(255,255,255,0.28)"); sg.addColorStop(0.5, "rgba(255,255,255,0)"); sg.addColorStop(1, "rgba(0,0,0,0.38)");
        g.fillStyle = sg; g.beginPath(); g.arc(x, y, R, 0, TAU); g.fill();
    }
    g.restore();
    if (sk.id === "saturn") saturnRing(g, x, y, R, false);
    if (sk.eyes) drawEyes(g, x, y, R, o);
}


const EYE_RANGE = 320;                                   
function updateSkin(dt) {
    const free = !player.bubble && !player.stuck;
    player.spin += ((free ? clamp(player.vx / PLAYER_R * 0.6, -14, 14) : 0) - player.spin) * (1 - Math.exp(-6 * dt));
    player.rot += player.spin * dt;
    player.tilt += (clamp(player.vx * 0.0005, -0.4, 0.4) - player.tilt) * (1 - Math.exp(-8 * dt));
    if (Skin.id === "eyes") updateEyes(dt);
}

function updateEyes(dt) {
    let tx = null, ty = null;
    if (Input.down) { tx = Input.x; ty = Input.y + camera.y; }     
    else {
        let bd = EYE_RANGE;                                         
        const look = (x, y) => { const d = dist(player.x, player.y, x, y); if (d < bd) { bd = d; tx = x; ty = y; } };
        for (const c of coins) look(c.x, c.y);
        for (const o of boosters) look(o.x, o.y);
        if (tx === null) {                                      
            let best2 = Infinity;
            for (const b of bubbles) {
                if (b === player.bubble) continue;
                const sc = dist(player.x, player.y, b.cx, b.cy) + (b.cy < player.y - 10 ? 0 : 400);
                if (sc < best2) { best2 = sc; tx = b.cx; ty = b.cy; }
            }
        }
    }
    let gx = 0, gy = -0.4;                                       
    if (tx !== null) {
        const dx = tx - player.x, dy = ty - player.y, d = Math.hypot(dx, dy);
        if (d > 1e-3) { const m = Math.min(1, d / 60); gx = dx / d * m; gy = dy / d * m; }
    }
    const a = 1 - Math.exp(-9 * dt);                                         
    player.eyeY += (gy - player.eyeY) * a;
    player.blinkT -= dt;                                            
    if (player.blinkT < -0.16) player.blinkT = rand(2, 5);
    player.blink = player.blinkT < 0 ? 1 - Math.sin(clamp(-player.blinkT / 0.16, 0, 1) * Math.PI) : 1;
}

function drawPlayer(T) {
    if (Skin.id === "custom" && Assets.has("player")) { drawCustomPlayer(T); return; }
    drawBall(ctx, player.x, player.y, PLAYER_R, Skin.id, Skin.color, {
        T, k: view.dpr * view.scale, rot: player.rot, pull: player.pull, pdx: player.pdx, pdy: player.pdy,
        eyeX: player.eyeX, eyeY: player.eyeY, blink: player.blink, tilt: player.tilt,
    });
}

function drawCustomPlayer(T) {  
    const R = PLAYER_R;
    const pull = clamp(player.pull, -0.6, 1.2);
    const sl = pull * 32; 
    const c2x = player.x + player.pdx * sl, c2y = player.y + player.pdy * sl;
    const r2 = Math.max(R * 0.5, R * (1 - 0.3 * pull));

    ctx.save();
    ctx.shadowBlur = 0;                                    
    hullPath(player.x, player.y, R, c2x, c2y, r2);
    if (Assets.has("player")) {
        ctx.clip();
        const x0 = Math.min(player.x - R, c2x - r2), y0 = Math.min(player.y - R, c2y - r2);
        const x1 = Math.max(player.x + R, c2x + r2), y1 = Math.max(player.y + R, c2y + r2);
        ctx.drawImage(Assets.get("player"), x0, y0, x1 - x0, y1 - y0);
    } else {
        const g = ctx.createRadialGradient(player.x - R * 0.3, player.y - R * 0.35, 2, player.x, player.y, R * 2.4 + Math.abs(sl));
        g.addColorStop(0, "#fff3b0"); g.addColorStop(0.35, "#ffc21a"); g.addColorStop(1, "#ff9d00");
        ctx.fillStyle = g; ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.5)";
        ctx.beginPath(); ctx.ellipse(player.x - R * 0.33, player.y - R * 0.4, R * 0.22, R * 0.12, -0.7, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
}

const aimAssistOn = () => slots.some(s => s.active);
const powerUsable = s => s.type === "freeze" ? (!player.bubble && !player.stuck && !player.frozen) : !s.active;

function slotCenter(i) {
    const total = POWER_SLOTS * SLOT_R * 2 + (POWER_SLOTS - 1) * SLOT_GAP;
    return { x: (view.w - total) / 2 + SLOT_R + i * (SLOT_R * 2 + SLOT_GAP), y: view.h - 28 - SLOT_R };
}

function tryUsePowerupAt(x, y) {   
    for (let i = 0; i < slots.length; i++) {
        const c = slotCenter(i);
        if (dist(x, y, c.x, c.y) <= SLOT_R + 10) return usePowerup(i);
    }
    return false;
}

function usePowerup(i) {
    const s = slots[i];
    if (!s) return false;
    if (!powerUsable(s)) { s.shake = 1; return true; }  
    if (s.type === "freeze") {
        player.frozen = true; player.vx = player.vy = 0;
        slots.splice(i, 1);
        fxRing(player.x, player.y, PLAYER_R, PLAYER_R * 3.2, 0.5, "rgba(170,240,255,0.95)");
        fxSparks(player.x, player.y, 18, "#c9f4ff", 280);
        Sound.play("freeze");
    } else {
        s.active = true; s.pop = 1;
        Sound.play("aim");
    }
    return true;
}

function bounceVelocity(c, r, vx, vy, vn) {
    const sp = Math.hypot(vx, vy);
    let rx = vx - 2 * vn * r.nx, ry = vy - 2 * vn * r.ny, k = WALL_BOUNCE;
    if (c.bounce) {
        const out = clamp(sp * BOUNCER_GAIN, BOUNCER_MIN, BOUNCER_MAX);
        const shallow = Math.abs(r.nx) > 0.7 && (sp < 1 || Math.abs(vn) / sp < Math.sin(BOUNCER_UP_ANGLE));
        if (shallow) { rx = r.nx * 0.1; ry = -1; }
        else if (sp < 1) { rx = r.nx; ry = r.ny; }
        k = out / (Math.hypot(rx, ry) || 1);
    }
    return { vx: rx * k, vy: ry * k };
}


function simulateShot(x, y, vx, vy, count, spacing) {
    const balls = [], bounces = [], used = new Set();
    const solids = walls.concat(pads, obstacles);
    const sp0 = Math.hypot(vx, vy) || 1, ax = vx / sp0, ay = vy / sp0;     
    const circ = { x, y, r: PLAYER_R };
    let travelled = 0, next = PLAYER_R + 14, end = null;
    for (let step = 0; step < 420 && balls.length < count && !end; step++) {
        const ox = x, oy = y, t = (step + 1) * STEP;
        vy += GRAVITY * STEP; x += vx * STEP; y += vy * STEP;
        for (const c of solids) {
            circ.x = x; circ.y = y;
            const r = hitSolid(circ, c);
            if (!r) continue;
            x += r.x; y += r.y;
            if (c.sticky && t > 0.12 && inStickyZone(c, x, y)) { end = { x, y, type: "stick" }; break; }
            const vn = vx * r.nx + vy * r.ny;
            if (vn < 0) {
                const nv = bounceVelocity(c, r, vx, vy, vn);
                vx = nv.vx; vy = nv.vy;
                if (balls.length < count) bounces.push({ x: x - r.nx * PLAYER_R, y: y - r.ny * PLAYER_R });
            }
        }
        if (!end) {
            for (const o of boosters) {
                if (used.has(o)) continue;
                const q = segClosest(ox, oy, x, y, o.x, o.y);
                if (dist(q.x, q.y, o.x, o.y) <= PLAYER_R + BOOSTER_R) { vx = ax * BOOST_SPEED; vy = ay * BOOST_SPEED; used.add(o); }
            }
            for (const b of bubbles) {
                if (b === player.bubble) continue;
                const q = segClosest(ox, oy, x, y, b.cx, b.cy);
                if (dist(q.x, q.y, b.cx, b.cy) <= b.r) { end = { x: b.cx, y: b.cy, type: "bubble" }; break; }
            }
        }
        const seg = Math.hypot(x - ox, y - oy), before = travelled;
        travelled += seg;
        while (balls.length < count && travelled >= next) {
            const f = seg > 0 ? (next - before) / seg : 1;
            balls.push({ x: lerp(ox, x, f), y: lerp(oy, y, f) });
            next += spacing;
        }
        if (y > camera.y + view.h + 600) break;
    }
    return { balls, bounces, end };
}

function drawShower(vx, vy, s) {
    const { balls, bounces, end } = simulateShot(player.x, player.y, vx, vy, SHOWER_BALLS, lerp(30, 52, s));
    ctx.lineWidth = 2;
    for (const b of bounces) {                                             
        ctx.globalAlpha = 0.55; ctx.beginPath(); ctx.arc(b.x, b.y, 9, 0, Math.PI * 2); ctx.strokeStyle = "#fff"; ctx.stroke();
    }
    balls.forEach((p, i) => {
        const f = i / Math.max(1, SHOWER_BALLS - 1);
        ctx.globalAlpha = 1;
        drawCircle(p.x, p.y, lerp(4.4, 2.6, f), strengthColor(s, lerp(0.8, 0.25, f)));
    });
    if (end) {
        ctx.globalAlpha = 0.7; ctx.beginPath(); ctx.arc(end.x, end.y, PLAYER_R * 0.9, 0, Math.PI * 2);
        ctx.strokeStyle = end.type === "stick" ? COLOR_STICKY : COLOR_BUBBLE; ctx.lineWidth = 3; ctx.stroke();
    }
    ctx.globalAlpha = 1;
}


function drawPowerBadge(g, type, R, T, active) {
    const col = POWER_DEFS[type].color, k = view.dpr * view.scale, pulse = 0.5 + 0.5 * Math.sin(T * 4);
    g.save();
    g.shadowColor = col; g.shadowBlur = (active ? 24 + 10 * pulse : 10 + 6 * pulse) * k;
    g.beginPath(); g.arc(0, 0, R, 0, TAU);
    g.fillStyle = "rgba(8,14,40,0.78)"; g.fill();                          
    g.lineWidth = active ? 5 : 3.5; g.strokeStyle = col; g.stroke();
    g.shadowBlur = 0;
    g.lineCap = "round"; g.lineJoin = "round";
    if (type === "freeze") {                                           
        g.strokeStyle = "#eafcff"; g.lineWidth = Math.max(2, R * 0.09);
        for (let i = 0; i < 6; i++) {
            g.save(); g.rotate(i * Math.PI / 3);
            g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -R * 0.62);
            g.moveTo(-R * 0.17, -R * 0.5); g.lineTo(0, -R * 0.36); g.lineTo(R * 0.17, -R * 0.5);
            g.stroke(); g.restore();
        }
    } else {                                                       
        for (let i = 0; i < 6; i++) {
            const u = i / 5;
            g.fillStyle = `rgba(255,255,255,${1 - 0.13 * i})`;
            g.beginPath(); g.arc(-R * 0.55 + u * R * 1.1, R * 0.38 - Math.sin(u * Math.PI) * R * 0.78, R * (0.15 - 0.012 * i), 0, TAU); g.fill();
        }
    }
    g.restore();
}

function drawPowerup(o, T) {                                             
    const bob = Math.sin(T * 2.5 + o.ph) * 5;
    ctx.save();
    ctx.translate(o.x, o.y + bob);
    ctx.save(); ctx.rotate(T * 0.9);                                       
    ctx.setLineDash([7, 9]); ctx.lineWidth = 2.5; ctx.strokeStyle = POWER_DEFS[o.type].color; ctx.globalAlpha = 0.8;
    ctx.beginPath(); ctx.arc(0, 0, POWERUP_R + 11, 0, TAU); ctx.stroke();
    ctx.restore();
    drawPowerBadge(ctx, o.type, POWERUP_R, T, false);
    ctx.restore();
}

function drawPowerSlots(T) {                                               
    for (let i = 0; i < POWER_SLOTS; i++) {
        const c = slotCenter(i), s = slots[i];
        if (!s) {                                                          
            ctx.save(); ctx.beginPath(); ctx.arc(c.x, c.y, SLOT_R - 6, 0, TAU);
            ctx.setLineDash([6, 8]); ctx.lineWidth = 2; ctx.strokeStyle = "rgba(255,255,255,0.18)"; ctx.stroke(); ctx.restore();
            continue;
        }
        ctx.save();
        ctx.translate(c.x + Math.sin(T * 50) * 8 * s.shake, c.y);
        const sc = 1 + 0.3 * s.pop; ctx.scale(sc, sc);
        ctx.globalAlpha = powerUsable(s) ? 1 : 0.45;
        drawPowerBadge(ctx, s.type, SLOT_R - 4, T, s.active);
        ctx.restore();
    }
}

function drawFrozen(T) {                                                  
    if (!player.frozen) return;
    const k = view.dpr * view.scale, R = PLAYER_R + 9, pulse = 0.5 + 0.5 * Math.sin(T * 3);
    ctx.save();
    ctx.translate(player.x, player.y);
    const g = ctx.createRadialGradient(0, 0, PLAYER_R * 0.6, 0, 0, R);
    g.addColorStop(0, "rgba(200,245,255,0.05)"); g.addColorStop(1, "rgba(200,245,255,0.45)");
    ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.fillStyle = g; ctx.fill();
    ctx.shadowColor = "#6fe6ff"; ctx.shadowBlur = (12 + 8 * pulse) * k;
    ctx.lineWidth = 3; ctx.strokeStyle = "rgba(220,250,255,0.9)"; ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = "rgba(235,252,255,0.9)";
    for (let i = 0; i < 6; i++) {                                         
        ctx.save(); ctx.rotate(i * Math.PI / 3 + T * 0.3);
        ctx.beginPath(); ctx.moveTo(R - 2, 0); ctx.lineTo(R + 8, -4); ctx.lineTo(R + 16, 0); ctx.lineTo(R + 8, 4); ctx.closePath(); ctx.fill();
        ctx.restore();
    }
    ctx.restore();
    if (!Input.down) drawText("FROZEN \u2022 DRAG TO SHOOT", player.x, player.y - PLAYER_R - 34, 20, `rgba(201,244,255,${0.6 + 0.4 * pulse})`, "center", "Arial", "bold");
}


function drawTrail() {
    if (trail.length < 2) return;
    let run = [trail[0]];
    for (let i = 1; i < trail.length; i++) {
        if (trail[i - 1].t - trail[i].t > 0.05) { if (run.length > 1) drawTrailRun(run); run = []; }   // gap = separate flight
        run.push(trail[i]);
    }
    if (run.length > 1) drawTrailRun(run);
}

function drawTrailRun(pts) {                   
    const n = pts.length, L = [], Rr = [], k = view.dpr * view.scale;
    for (let i = 0; i < n; i++) {
        const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
        const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
        const p = pts[i], age = p.t / TRAIL_LIFE;
        const hw = PLAYER_R * 0.85 * (1 - age) * (0.35 + 0.65 * p.s);       // narrows with age, wider when faster
        L.push({ x: p.x - dy / d * hw, y: p.y + dx / d * hw });
        Rr.push({ x: p.x + dy / d * hw, y: p.y - dx / d * hw });
    }
    const head = pts[n - 1], tail = pts[0], hue = 190 + 150 * head.s;
    ctx.save();
    ctx.beginPath(); ctx.moveTo(L[0].x, L[0].y);
    for (let i = 1; i < n; i++) ctx.lineTo(L[i].x, L[i].y);
    for (let i = n - 1; i >= 0; i--) ctx.lineTo(Rr[i].x, Rr[i].y);
    ctx.closePath();
    const g = ctx.createLinearGradient(head.x, head.y, tail.x, tail.y);
    g.addColorStop(0, `hsla(${hue}, 100%, 65%, ${0.3 + 0.5 * head.s})`);
    g.addColorStop(1, `hsla(${hue}, 100%, 60%, 0)`);
    ctx.fillStyle = g;
    ctx.shadowColor = `hsl(${hue}, 100%, 60%)`; ctx.shadowBlur = 14 * k * head.s;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);                      
    for (let i = 1; i < n; i++) ctx.lineTo(pts[i].x, pts[i].y);
    const cg = ctx.createLinearGradient(head.x, head.y, tail.x, tail.y);
    cg.addColorStop(0, `rgba(255,255,255,${0.35 + 0.45 * head.s})`); cg.addColorStop(1, "rgba(255,255,255,0)");
    ctx.strokeStyle = cg; ctx.lineWidth = 2 + 4 * head.s; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.stroke();
    ctx.restore();
}

function drawFx() {
    for (const f of fx) {
        const p = f.t / f.life;
        if (f.type === "ring") {
            ctx.globalAlpha = (1 - p) * 0.9;
            ctx.beginPath(); ctx.arc(f.x, f.y, lerp(f.r0, f.r1, 1 - (1 - p) * (1 - p)), 0, Math.PI * 2);
            ctx.strokeStyle = f.color; ctx.lineWidth = 1 + 3 * (1 - p); ctx.stroke();
        } else if (f.type === "spark") {
            ctx.globalAlpha = 1 - p;
            drawCircle(f.x, f.y, 3 * (1 - p) + 0.5, f.color);
        } else if (f.type === "bit") {
            ctx.globalAlpha = 1 - p * p;
            drawCircle(f.x, f.y, f.size * (1 - 0.4 * p), f.color);
        } else {
            ctx.globalAlpha = 1 - p * p;
            drawText(f.text, f.x, f.y - p * 40, 26, f.color, "center");
        }
    }
    ctx.globalAlpha = 1;
}

let shownScore = 0, lastScore = 0, scorePop = 0;
function hudReset() { shownScore = 0; lastScore = 0; scorePop = 0; }

function drawHUD() {
    const k = view.dpr * view.scale, s = score();
    if (s > lastScore) scorePop = 1;
    lastScore = s;
    shownScore += (s - shownScore) * 0.2;
    if (Math.abs(s - shownScore) < 0.5) shownScore = s;
    scorePop *= 0.9;

    const cx = view.w / 2, baseY = view.h - 30 - SLOT_ROW;      // HUD sits above the power-up icon row
    drawText("BEST " + best + "   \u2022   HEIGHT " + maxHeight + "   \u2022   COINS " + coinsCollected,
        cx, baseY, 22, "rgba(255,255,255,0.75)", "center");

    ctx.save();
    ctx.translate(cx, baseY - 40);
    const sc = 1 + 0.22 * scorePop;
    ctx.scale(sc, sc);
    ctx.shadowColor = "rgba(255,230,0,0.65)"; ctx.shadowBlur = 20 * k;
    drawText(String(Math.round(shownScore)), 0, 0, 92, COLOR_COIN, "center", "Arial", "bold");
    ctx.restore();
    drawText("SCORE", cx, baseY - 40 - 92 + 6, 20, "rgba(255,230,0,0.7)", "center", "Arial", "bold");
}

function render() {
    const T = performance.now() / 1000;
    colorProgress += (clamp(maxHeight / COLOR_ROUTE, 0, 1) - colorProgress) * 0.05;

    drawBackground(T);


    ctx.save();
    ctx.translate(0, -camera.y);

    drawWalls(T);
    for (const o of obstacles) drawObstacle(o, T);
    for (const p of pads) drawPad(p, T);
    for (const c of coins) drawCoin(c, T);
    for (const o of powerups) drawPowerup(o, T);
    const aim = currentAim();
    for (const o of boosters) drawBooster(o, T, aim);
    for (const b of bubbles) if (b !== player.bubble) drawBubble(b, T);


    if (Input.down && canLaunch()) {
        const pull = dist(Input.startX, Input.startY, Input.x, Input.y);
        if (pull > MIN_PULL) {
            const s = clamp(pull / MAX_PULL, 0, 1);
            const v = Trajectory.fromDrag(Input.startX, Input.startY, Input.x, Input.y, POWER, MAX_SPEED);
            const speed = Math.hypot(v.vx, v.vy);
            const assist = aimAssistOn();  
            if (assist) drawShower(v.vx, v.vy, s);
            const { points, hit } = Trajectory.predict(player.x, player.y, v.vx, v.vy, GRAVITY, {
                colliders: walls.concat(pads, obstacles), maxTime: 1.5, step: 0.02,
            });
            const tMax = hit ? points[points.length - 1].t : Infinity;
            const t0 = (PLAYER_R + 12) / speed;         
            const gap = lerp(14, 32, s) / speed;        
            for (let i = 0; i < (assist ? 0 : AIM_BALLS); i++) {
                const t = t0 + i * gap;
                if (t > tMax) break;
                const p = Trajectory.pointAt(player.x, player.y, v.vx, v.vy, GRAVITY, t);
                drawCircle(p.x, p.y, lerp(2.2, 3.6, s), strengthColor(s, 0.55 - i * 0.08));
            }
        }
    }

    drawTrail();                                          
    drawPlayer(T);
    drawCradle(T);                                      
    drawFrozen(T);                                       
    if (player.bubble) drawBubble(player.bubble, T);     
    drawFx();

    ctx.restore();

    drawHUD();
    drawPowerSlots(T);
}


const STEP = 1 / 60;
let last = 0, acc = 0, running = false, state = "play"; 

function loop(now) {
    if (!running) return;
    acc += Math.min((now - last) / 1000, 0.1);
    last = now;
    while (acc >= STEP) { if (state === "play") update(STEP); acc -= STEP; }
    render();
    requestAnimationFrame(loop);
}


const menuEl = document.getElementById("menu");
const prevCv = document.getElementById("skinPreview");
const skinGridEl = document.getElementById("skinGrid");
const swatchesEl = document.getElementById("swatches");
const skinNameEl = document.getElementById("skinName");
const bestLineEl = document.getElementById("bestLine");
const Skin = { id: "plain", color: "yellow" };
let inMenu = false, menuSkins = SKINS, skinButtons = [], menuLast = 0;
const mp = { eyeX: 0, eyeY: -0.3, blink: 1, blinkT: 2, rot: 0 };
const menuPtr = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
document.addEventListener("pointermove", e => { menuPtr.x = e.clientX; menuPtr.y = e.clientY; });

function drawSkinOn(g, cx, cy, R, id, color, extra) {
    if (id === "custom") {
        g.save(); g.beginPath(); g.arc(cx, cy, R, 0, TAU); g.clip();
        g.drawImage(Assets.get("player"), cx - R, cy - R, R * 2, R * 2); g.restore();
        return;
    }
    drawBall(g, cx, cy, R, id, color, extra);
}

function drawThumb(entry) {
    const cv = entry.cv, dpr = Math.min(window.devicePixelRatio || 1, 3), w = 56, h = 56;
    cv.width = w * dpr; cv.height = h * dpr; cv.style.width = w + "px"; cv.style.height = h + "px";
    const g = cv.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    drawSkinOn(g, w / 2, h / 2, 14, entry.s.id, Skin.color, { T: 0.3, k: dpr, rot: 0.6, eyeX: 0.35, eyeY: 0.1, blink: 1, tilt: 0.12 });
}

function refreshMenu() {
    const cur = menuSkins.find(s => s.id === Skin.id) || menuSkins[0];
    skinNameEl.textContent = cur.name;
    swatchesEl.style.visibility = cur.colors ? "visible" : "hidden";
    for (const b of swatchesEl.children) b.classList.toggle("sel", b.dataset.id === Skin.color);
    for (const e of skinButtons) {
        e.b.classList.toggle("sel", e.s.id === Skin.id);
        if (e.s.colors) drawThumb(e);                       // colour changes only affect these
    }
    Store.set("skin", Skin.id); Store.set("color", Skin.color);
}

function initMenu() {
    menuSkins = SKINS.concat(Assets.has("player") ? [{ id: "custom", name: "Custom" }] : []);
    const sid = Store.get("skin", "plain"), sc = Store.get("color", "yellow");
    Skin.id = menuSkins.some(s => s.id === sid) ? sid : "plain";
    Skin.color = SOLID_COLORS.some(c => c.id === sc) ? sc : "yellow";
    bestLineEl.textContent = best > 0 ? "BEST " + best : "";

    SOLID_COLORS.forEach(c => {
        const b = document.createElement("button");
        b.className = "swatch"; b.dataset.id = c.id; b.style.background = c.mid; b.setAttribute("aria-label", c.id);
        b.addEventListener("click", () => { Skin.color = c.id; refreshMenu(); });
        swatchesEl.appendChild(b);
    });
    menuSkins.forEach(s => {
        const b = document.createElement("button"), cv = document.createElement("canvas"), label = document.createElement("span");
        b.className = "skin"; label.textContent = s.name;
        b.appendChild(cv); b.appendChild(label);
        const entry = { s, b, cv };
        b.addEventListener("click", () => { Skin.id = s.id; refreshMenu(); });
        skinGridEl.appendChild(b); skinButtons.push(entry); drawThumb(entry);
    });
    refreshMenu();
    inMenu = true;
    requestAnimationFrame(menuLoop);
}

function menuLoop(now) {
    if (!inMenu) return;
    const T = now / 1000, dt = clamp(T - menuLast, 0, 0.05); menuLast = T;
    drawBackground(T);                                      // same starfield as the game

    const dpr = view.dpr, w = prevCv.clientWidth, h = prevCv.clientHeight;
    if (prevCv.width !== Math.round(w * dpr)) { prevCv.width = Math.round(w * dpr); prevCv.height = Math.round(h * dpr); }
    const g = prevCv.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);

    const rc = prevCv.getBoundingClientRect();              // eyes follow the finger / mouse
    const dx = menuPtr.x - (rc.left + w / 2), dy = menuPtr.y - (rc.top + h / 2), d = Math.hypot(dx, dy) || 1, m = Math.min(1, d / 120);
    const a = 1 - Math.exp(-9 * dt);
    mp.eyeX += (dx / d * m - mp.eyeX) * a; mp.eyeY += (dy / d * m - mp.eyeY) * a;
    mp.blinkT -= dt;
    if (mp.blinkT < -0.16) mp.blinkT = rand(2, 5);
    mp.blink = mp.blinkT < 0 ? 1 - Math.sin(clamp(-mp.blinkT / 0.16, 0, 1) * Math.PI) : 1;
    mp.rot += dt * 1.4;

    drawSkinOn(g, w / 2, h / 2 + Math.sin(T * 2) * 4, w * 0.26, Skin.id, Skin.color,
        { T, k: dpr, rot: mp.rot, eyeX: mp.eyeX, eyeY: mp.eyeY, blink: mp.blink, tilt: Math.sin(T * 1.3) * 0.18 });
    requestAnimationFrame(menuLoop);
}

function endMenu() { inMenu = false; menuEl.style.display = "none"; }

function showMenu() {
    bestLineEl.textContent = best > 0 ? "BEST " + best : "";
    menuEl.style.display = "flex";
    inMenu = true; menuLast = performance.now() / 1000;
    requestAnimationFrame(menuLoop);
}

/* =========================================================
   START
   ========================================================= */
startBtn.disabled = true;
startBtn.textContent = "Loading...";
Promise.all([Assets.load(ASSET_MANIFEST), Sound.load(SOUND_MANIFEST)]).then(() => {
    startBtn.disabled = false;
    startBtn.textContent = "Start Game";
    initMenu();
});

startBtn.addEventListener("click", async () => {
    try { await document.documentElement.requestFullscreen(); } catch (e) { console.log(e); }
    try { await screen.orientation.lock("portrait"); } catch (e) {}
    endMenu();
    Sound.unlock().then(() => Sound.music("music"));   // needs this tap to be allowed
    resize();
    resetGame();
    state = "play"; acc = 0;
    running = true;
    last = performance.now();
    requestAnimationFrame(loop);
});

/* =========================================================
   GAME OVER  (blurred game behind, score in the middle, Restart / Back)
   ========================================================= */
const overEl = document.getElementById("gameOver");
const goScoreEl = document.getElementById("goScore");
const goBestEl = document.getElementById("goBest");
const restartBtn = document.getElementById("restartButton");
const backBtn = document.getElementById("backButton");
let goAnim = 0;

function gameOver() {
    state = "over";
    const final = score();
    const isNew = final > savedBest && final > 0;           // check before saveBest() updates savedBest
    saveBest();
    Input.down = false; Input.released = false;
    Sound.play("lose");

    goBestEl.textContent = isNew ? "NEW BEST!" : "BEST " + best;
    goBestEl.classList.toggle("new", isNew);
    overEl.classList.add("show");

    const t0 = performance.now(), dur = 700;                // quick count-up
    const id = ++goAnim;
    (function tick(now) {
        if (id !== goAnim) return;
        const p = clamp((now - t0) / dur, 0, 1);
        goScoreEl.textContent = Math.round(final * (1 - (1 - p) * (1 - p)));
        if (p < 1) requestAnimationFrame(tick);
    })(t0);
}

function hideGameOver() { goAnim++; overEl.classList.remove("show"); }

restartBtn.addEventListener("click", () => {
    hideGameOver();
    resetGame();
    state = "play"; acc = 0; last = performance.now();
});

backBtn.addEventListener("click", () => {
    hideGameOver();
    running = false; state = "play";
    Sound.stopMusic();
    showMenu();
});