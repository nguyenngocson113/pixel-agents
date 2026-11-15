#!/usr/bin/env node
/**
 * Crayon Kingdom: an external asset pack drawn by code.
 *
 * Writes, next to this file:
 *   assets/furniture/<ID>/{manifest.json, *.png}   the furniture (see docs/external-assets.md)
 *   layout.json                                    a layout using it (Settings -> Import Layout)
 *   characters.json                                a cast for it (Characters -> Load config)
 *
 * Every sprite is pixel art at the office's own scale (16 px tiles) made to look
 * like a crayon drawing: flat pastel fills broken by diagonal hatch strokes, and a
 * charcoal outline wherever two shapes meet. Deterministic: the same script always
 * writes the same bytes.
 *
 *   node asset-packs/crayon-kingdom/generate.mjs [--preview <file.png>]
 *
 * --preview also writes a rough picture of the layout (flat floor, no characters).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PNG } from 'pngjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TILE = 16;

// ── Colour ──────────────────────────────────────────────────────────────────

/** The office's own Colorize maths for a flat floor tile (office/colorize.ts). */
const FLOOR_LUMINANCE = 167 / 255; // floor_0.png, the flat pattern
function floorHex({ h, s, b }) {
  const l = Math.max(0, Math.min(1, FLOOR_LUMINANCE + b / 200));
  const c = (1 - Math.abs(2 * l - 1)) * (s / 100);
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, bl] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ][Math.floor(hp) % 6];
  const m = l - c / 2;
  return (
    '#' +
    [r, g, bl]
      .map((v) =>
        Math.round((v + m) * 255)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}

const FLOOR_COLORS = {
  grass: { h: 98, s: 48, b: 13, c: 0 },
  sky: { h: 204, s: 78, b: 44, c: 0 },
  bridge: { h: 28, s: 42, b: -6, c: -55 },
};

const INKS = ['#3f3b3a', '#4a4543', '#353130'];
const mat = (base, light, dark, slope = 1) => ({ base, light, dark, slope });
const M = {
  stone: mat('#f0dcb8', '#f9eed8', '#d9bd90'),
  hut: mat('#ead0a4', '#f6e6c8', '#cfae7c', -1),
  roof: mat('#d9a273', '#ecc39d', '#bd8253', -1),
  purple: mat('#a77bd8', '#c9abec', '#8a5cc2'),
  yellow: mat('#f4c63a', '#fbe07f', '#d9a21c'),
  wood: mat('#b98356', '#d3a57c', '#99683f'),
  woodTop: mat('#d9ab7b', '#ebc9a2', '#bb8a5c', -1),
  door: mat('#8a5a3a', '#a57450', '#6d4327'),
  leaf: mat('#6fbf5f', '#9bdb89', '#4c9f44'),
  hill: mat('#8fcf74', '#b2e39a', '#74b95b', -1),
  water: mat('#86c3ee', '#b9dff9', '#62abe3'),
  rock: mat('#d9cdb8', '#eee6d8', '#b7a88f'),
  glass: mat('#5b5552', '#77706c', '#45403e'),
  screenOff: mat('#8b8791', '#a29eaa', '#75717b'),
  cloud: mat('#ffffff', '#ffffff', '#e6f2fc'),
  metal: mat('#cfc8c0', '#e6e1db', '#aaa29a'),
};
const BLADE = '#4c9f44';

/** A repeatable 0..1 value for a pixel. */
function noise(x, y, seed) {
  let n = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 2147483647)) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

/** A crayon fill: the base colour, a lighter stroke every fourth diagonal, a few darker and lighter specks. */
function crayon(x, y, m, seed) {
  const r = noise(x, y, seed);
  const d = (((x + m.slope * y) % 4) + 4) % 4;
  if (d === 0) return r < 0.7 ? m.light : m.base;
  if (r < 0.1) return m.dark;
  if (r > 0.95) return m.light;
  return m.base;
}
const ink = (x, y) => INKS[Math.floor(noise(x, y, 7) * INKS.length)];

// ── Drawing ─────────────────────────────────────────────────────────────────

class Sheet {
  constructor(w, h, seed) {
    this.w = w;
    this.h = h;
    this.seed = seed;
    this.px = new Array(w * h).fill(null);
    this.reg = new Int16Array(w * h);
  }
  inside(x, y) {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }
  /** One pixel of a shape. Shapes with different regions get an outline between them. */
  dot(x, y, m, region) {
    if (!this.inside(x, y)) return;
    this.px[y * this.w + x] = crayon(x, y, m, this.seed + region);
    this.reg[y * this.w + x] = region;
  }
  /** A pixel that belongs to no shape (a background, a detail drawn over a fill). */
  put(x, y, color) {
    if (this.inside(x, y)) this.px[y * this.w + x] = color;
  }
  ink(x, y) {
    this.put(x, y, ink(x, y));
  }
  /** A detail in the fill's own darker or lighter tone, only over that region. */
  tone(x, y, color, region) {
    if (this.inside(x, y) && this.reg[y * this.w + x] === region) this.put(x, y, color);
  }
  rect(x0, y0, x1, y1, m, region) {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.dot(x, y, m, region);
  }
  ellipse(cx, cy, rx, ry, m, region, maxY = Infinity) {
    for (let y = Math.floor(cy - ry); y <= Math.min(maxY, Math.ceil(cy + ry)); y++) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) this.dot(x, y, m, region);
      }
    }
  }
  /** Charcoal on every shape's rim: against nothing, and against a shape drawn before it. */
  outline() {
    const edge = [];
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const r = this.reg[y * this.w + x];
        if (!r) continue;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const nx = x + dx;
          const ny = y + dy;
          const nr = this.inside(nx, ny) ? this.reg[ny * this.w + nx] : 0;
          if (nr < r) {
            edge.push([x, y]);
            break;
          }
        }
      }
    }
    for (const [x, y] of edge) this.ink(x, y);
    return this;
  }
  png() {
    const out = new PNG({ width: this.w, height: this.h });
    this.px.forEach((color, i) => {
      if (!color) return;
      out.data[i * 4] = parseInt(color.slice(1, 3), 16);
      out.data[i * 4 + 1] = parseInt(color.slice(3, 5), 16);
      out.data[i * 4 + 2] = parseInt(color.slice(5, 7), 16);
      out.data[i * 4 + 3] = 255;
    });
    return PNG.sync.write(out);
  }
}

/** The water's fill: it repeats every tile, so any two water sprites meet without a seam. */
function water(s, x, y) {
  s.put(x, y, crayon(x & 15, y & 15, M.water, 3));
  const tx = x & 15;
  const ty = y & 15;
  const wave = (ox, oy) =>
    (ty === oy && (tx === ox + 1 || tx === ox + 2)) ||
    (ty === oy + 1 && (tx === ox || tx === ox + 3));
  if (wave(2, 3) || wave(10, 10)) s.put(x, y, '#e2f2fd');
}

// ── Sprites ─────────────────────────────────────────────────────────────────

function castle(team) {
  const s = new Sheet(48, 64, 11);
  // the keep, its parapet and merlons
  s.rect(13, 27, 34, 61, M.stone, 1);
  s.rect(10, 20, 37, 26, M.stone, 1);
  for (const x of [10, 17, 25, 32]) s.rect(x, 14, x + 5, 19, M.stone, 1);
  // the side turret
  s.rect(35, 40, 43, 61, M.stone, 2);
  s.rect(34, 35, 44, 39, M.stone, 2);
  for (const x of [34, 38, 42]) s.rect(x, 31, x + 2, 34, M.stone, 2);
  // flag
  s.rect(25, 3, 34, 9, M[team], 3);
  // door, windows
  s.rect(20, 52, 27, 61, M.door, 4);
  s.rect(21, 51, 26, 51, M.door, 4);
  s.rect(22, 50, 25, 50, M.door, 4);
  s.rect(17, 33, 19, 37, M.glass, 5);
  s.rect(28, 33, 30, 37, M.glass, 5);
  s.rect(38, 45, 40, 49, M.glass, 5);
  s.outline();
  for (let y = 3; y <= 13; y++) s.ink(24, y);
  // brick strokes
  for (let y = 22; y < 60; y += 5) {
    for (let x = 11; x < 44; x++) {
      if (noise(x >> 2, y, 5) < 0.45) {
        s.tone(x, y, M.stone.dark, 1);
        s.tone(x, y, M.stone.dark, 2);
      }
    }
  }
  return s;
}

function tower(team) {
  const s = new Sheet(32, 64, 23);
  s.rect(10, 31, 21, 61, M.stone, 1);
  for (let y = 11; y <= 31; y++) {
    const half = ((y - 11) / 20) * 10.5;
    for (let x = Math.round(15.5 - half); x <= Math.round(15.5 + half); x++) s.dot(x, y, M.roof, 2);
  }
  for (let y = 2; y <= 8; y++) {
    for (let x = 16; x <= 16 + 9 - Math.abs(y - 5) * 3; x++) s.dot(x, y, M[team], 3);
  }
  s.rect(13, 53, 18, 61, M.door, 4);
  s.rect(14, 52, 17, 52, M.door, 4);
  s.rect(14, 38, 17, 43, M.glass, 5);
  s.outline();
  for (let y = 2; y <= 10; y++) s.ink(15, y);
  for (let y = 16; y < 31; y += 4) for (let x = 0; x < 32; x++) s.tone(x, y, M.roof.dark, 2);
  for (let y = 36; y < 60; y += 5) {
    for (let x = 11; x < 21; x++) if (noise(x >> 1, y, 5) < 0.4) s.tone(x, y, M.stone.dark, 1);
  }
  return s;
}

function hut() {
  const s = new Sheet(32, 32, 31);
  s.ellipse(15.5, 30, 11.5, 17, M.hut, 1, 30);
  s.rect(13, 22, 18, 30, M.door, 2);
  s.rect(14, 21, 17, 21, M.door, 2);
  s.outline();
  for (const y of [18, 23]) {
    for (let x = 0; x < 32; x++) if (noise(x >> 1, y, 9) < 0.6) s.tone(x, y, M.hut.dark, 1);
  }
  return s;
}

function tree() {
  const s = new Sheet(32, 48, 41);
  s.rect(9, 27, 12, 44, M.wood, 1);
  s.ellipse(11, 18, 9.5, 10, M.leaf, 2);
  s.rect(21, 35, 23, 45, M.wood, 3);
  s.ellipse(22, 28, 8, 8.5, M.leaf, 4);
  return s.outline();
}

function rock() {
  const s = new Sheet(16, 16, 51);
  s.ellipse(7.5, 10, 6.5, 4.5, M.rock, 1);
  s.ellipse(12.5, 12.5, 2.5, 2, M.rock, 2);
  return s.outline();
}

function stump() {
  const s = new Sheet(16, 16, 61);
  s.rect(3, 8, 12, 13, M.wood, 1);
  s.rect(4, 14, 11, 14, M.wood, 1);
  s.ellipse(7.5, 7, 5, 3, M.woodTop, 2);
  s.outline();
  s.put(7, 7, M.woodTop.dark);
  s.put(8, 7, M.woodTop.dark);
  s.put(6, 6, M.woodTop.dark);
  s.put(9, 8, M.woodTop.dark);
  return s;
}

function table() {
  const s = new Sheet(32, 32, 71);
  s.rect(2, 26, 5, 31, M.wood, 1);
  s.rect(26, 26, 29, 31, M.wood, 1);
  s.rect(0, 12, 31, 25, M.woodTop, 2);
  s.rect(1, 11, 30, 11, M.woodTop, 2);
  s.outline();
  for (const y of [16, 21]) {
    for (let x = 2; x < 30; x++) if (noise(x >> 2, y, 4) < 0.8) s.put(x, y, M.woodTop.dark);
  }
  return s;
}

/** A laptop seen from behind the typist: a dark screen when off, a page of scribbles when on. */
function laptop(frame) {
  const s = new Sheet(16, 32, 81);
  s.rect(2, 5, 13, 14, M.screenOff, 1);
  s.rect(1, 15, 14, 19, M.metal, 2);
  s.outline();
  for (let x = 3; x <= 12; x += 2) s.put(x, 17, M.metal.dark);
  if (frame === null) return s;
  const lines = [
    [7, '#a77bd8', 6],
    [9, '#f4c63a', 8],
    [11, '#6fbf5f', 5],
    [12, '#86c3ee', 7],
  ];
  for (let y = 6; y <= 13; y++) for (let x = 3; x <= 12; x++) s.put(x, y, '#fdf8ec');
  lines.forEach(([y, color, len], i) => {
    const shown = Math.max(2, (len + frame * 2 + i) % 9);
    for (let x = 4; x < 4 + shown; x++) s.put(x, y, color);
  });
  return s;
}

/** A piece of the far hills: a green band whose ridge rolls between tiles, with fence posts on it. */
function hill(variant) {
  const s = new Sheet(16, 32, 91);
  const top = (x) =>
    16 - Math.round(5 + 3 * Math.cos((2 * Math.PI * (x + variant * 16 + 0.5)) / 32));
  for (let x = 0; x < 16; x++) {
    const foot = 24 + Math.round(1.5 * Math.sin((2 * Math.PI * (x + variant * 16)) / 16));
    for (let y = top(x); y <= foot; y++) s.dot(x, y, M.hill, 1);
  }
  for (let x = 0; x < 16; x++) {
    const from = Math.min(top(x), top(Math.max(0, x - 1)) + 1);
    for (let y = from; y <= top(x); y++) s.ink(x, y);
    if (x % 4 === 2) {
      s.ink(x, top(x) - 1);
      s.ink(x, top(x) - 2);
    }
  }
  return s;
}

/** A river tile; a bank on the sides named, drawn as a wobbling charcoal line. */
function river({ left = false, right = false, top = false }) {
  const s = new Sheet(16, 16, 3);
  const wobble = [0, 0, 1, 1, 1, 0, 0, 0, -1, -1, 0, 0, 1, 0, 0, 0];
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const l = left ? 2 + wobble[y] : -1;
      const r = right ? 13 - wobble[(y + 5) & 15] : 16;
      const t = top ? 1 : -1;
      if (x < l || x > r || y < t) continue;
      if (x === l || x === r || y === t) s.ink(x, y);
      else water(s, x, y);
    }
  }
  return s;
}

function boat(team) {
  const s = new Sheet(32, 32, 101);
  for (let y = 16; y < 32; y++) for (let x = 0; x < 32; x++) water(s, x, y);
  s.rect(10, 3, 21, 14, M[team], 2);
  for (let y = 19; y <= 26; y++) {
    const inset = Math.max(0, y - 21);
    s.rect(3 + inset, y, 28 - inset, y, M.wood, 1);
  }
  s.outline();
  for (let y = 1; y <= 19; y++) s.ink(16, y);
  for (let x = 6; x < 26; x++) if (noise(x >> 1, 22, 6) < 0.7) s.tone(x, 22, M.wood.dark, 1);
  return s;
}

function banner(team) {
  const s = new Sheet(16, 32, 111);
  s.ellipse(7.5, 28.5, 4, 2, M.rock, 1);
  s.rect(8, 4, 14, 11, M[team], 2);
  s.outline();
  for (let y = 3; y <= 27; y++) s.ink(7, y);
  return s;
}

/** A cloud is where the sky's crayon left the paper white: no outline. */
function cloud() {
  const s = new Sheet(32, 16, 141);
  s.ellipse(9, 10, 7.5, 4, M.cloud, 1);
  s.ellipse(18, 8, 8.5, 6, M.cloud, 1);
  s.ellipse(25, 11, 5.5, 3.5, M.cloud, 1);
  return s;
}

function tuft(variant) {
  const s = new Sheet(16, 16, 121);
  const blades = variant
    ? [
        [3, 12, -1, 3],
        [6, 12, 0, 4],
        [9, 12, 1, 3],
        [12, 9, 0, 2],
      ]
    : [
        [5, 11, -1, 3],
        [8, 11, 0, 4],
        [11, 11, 1, 3],
      ];
  for (const [x, y, lean, len] of blades) {
    for (let i = 0; i < len; i++) s.put(x + (i === len - 1 ? lean : 0), y - i, BLADE);
  }
  return s;
}

function flowers() {
  const s = new Sheet(16, 16, 131);
  for (const [x, y, color] of [
    [4, 8, '#f29bb5'],
    [9, 6, '#f4c63a'],
    [12, 10, '#c9abec'],
  ]) {
    s.put(x, y + 3, BLADE);
    s.put(x, y + 2, BLADE);
    s.put(x, y + 1, BLADE);
    for (const [dx, dy] of [
      [0, 0],
      [-1, 0],
      [1, 0],
      [0, -1],
    ]) {
      s.put(x + dx, y + dy, color);
    }
    s.put(x, y, '#fdf8ec');
  }
  return s;
}

// ── Catalog ─────────────────────────────────────────────────────────────────

/** One furniture folder: its manifest fields and the sheets it draws from. */
function single(id, name, category, sheet, fw, fh, backgroundTiles, extra = {}) {
  return {
    id,
    files: { [`${id}.png`]: sheet },
    footprint: { [id]: { w: sheet.w, h: sheet.h, fw, fh, backgroundTiles } },
    manifest: {
      id,
      name,
      category,
      type: 'asset',
      canPlaceOnWalls: false,
      canPlaceOnSurfaces: false,
      backgroundTiles,
      width: sheet.w,
      height: sheet.h,
      footprintW: fw,
      footprintH: fh,
      ...extra,
    },
  };
}

function laptopItem() {
  const off = laptop(null);
  const on = [0, 1, 2].map(laptop);
  const size = { width: 16, height: 32, footprintW: 1, footprintH: 2 };
  const footprint = { w: 16, h: 32, fw: 1, fh: 2, backgroundTiles: 1 };
  return {
    id: 'CK_LAPTOP',
    files: {
      'CK_LAPTOP_FRONT_OFF.png': off,
      ...Object.fromEntries(on.map((s, i) => [`CK_LAPTOP_FRONT_ON_${i + 1}.png`, s])),
    },
    footprint: { CK_LAPTOP_FRONT_OFF: footprint },
    manifest: {
      id: 'CK_LAPTOP',
      name: 'Crayon Laptop',
      category: 'electronics',
      type: 'group',
      groupType: 'state',
      canPlaceOnWalls: false,
      canPlaceOnSurfaces: true,
      backgroundTiles: 1,
      members: [
        {
          type: 'group',
          groupType: 'animation',
          state: 'on',
          orientation: 'front',
          members: on.map((_, i) => ({
            type: 'asset',
            id: `CK_LAPTOP_FRONT_ON_${i + 1}`,
            file: `CK_LAPTOP_FRONT_ON_${i + 1}.png`,
            ...size,
            frame: i,
          })),
        },
        {
          type: 'asset',
          id: 'CK_LAPTOP_FRONT_OFF',
          file: 'CK_LAPTOP_FRONT_OFF.png',
          ...size,
          orientation: 'front',
          state: 'off',
        },
      ],
    },
  };
}

const RIVER = [
  ['CK_WATER', 'River', {}],
  ['CK_WATER_L', 'River (left bank)', { left: true }],
  ['CK_WATER_R', 'River (right bank)', { right: true }],
  ['CK_WATER_T', 'River (far end)', { top: true }],
  ['CK_WATER_TL', 'River (far end, left bank)', { top: true, left: true }],
  ['CK_WATER_TR', 'River (far end, right bank)', { top: true, right: true }],
];

const ITEMS = [
  single('CK_CASTLE_PURPLE', 'Castle (purple flag)', 'decor', castle('purple'), 3, 4, 3),
  single('CK_CASTLE_YELLOW', 'Castle (yellow flag)', 'decor', castle('yellow'), 3, 4, 3),
  single('CK_TOWER_PURPLE', 'Tower (purple flag)', 'decor', tower('purple'), 2, 4, 3),
  single('CK_TOWER_YELLOW', 'Tower (yellow flag)', 'decor', tower('yellow'), 2, 4, 3),
  single('CK_HUT', 'Hut', 'decor', hut(), 2, 2, 1),
  single('CK_TREE', 'Trees', 'decor', tree(), 2, 3, 2),
  single('CK_ROCK', 'Rock', 'decor', rock(), 1, 1, 0),
  single('CK_BANNER_PURPLE', 'Banner (purple)', 'decor', banner('purple'), 1, 2, 1),
  single('CK_BANNER_YELLOW', 'Banner (yellow)', 'decor', banner('yellow'), 1, 2, 1),
  single('CK_BOAT_PURPLE', 'Boat (purple sail)', 'decor', boat('purple'), 2, 2, 1),
  single('CK_BOAT_YELLOW', 'Boat (yellow sail)', 'decor', boat('yellow'), 2, 2, 1),
  single('CK_TUFT', 'Grass', 'decor', tuft(0), 1, 1, 1),
  single('CK_TUFT_2', 'Grass (wide)', 'decor', tuft(1), 1, 1, 1),
  single('CK_FLOWERS', 'Flowers', 'decor', flowers(), 1, 1, 1),
  single('CK_CLOUD', 'Cloud', 'decor', cloud(), 2, 1, 1),
  single('CK_HILL_A', 'Far hill (falling)', 'misc', hill(0), 1, 2, 1),
  single('CK_HILL_B', 'Far hill (rising)', 'misc', hill(1), 1, 2, 1),
  ...RIVER.map(([id, name, banks]) => single(id, name, 'misc', river(banks), 1, 1, 0)),
  single('CK_STUMP', 'Tree stump', 'chairs', stump(), 1, 1, 0),
  single('CK_TABLE', 'Picnic table', 'desks', table(), 2, 2, 1),
  laptopItem(),
];

// ── Layout ──────────────────────────────────────────────────────────────────

const COLS = 26;
const ROWS = 16;
const SKY_ROWS = 3; // rows no one can reach: the far hills below them are a closed line
const HILL_ROW = 2; // the hills' top tile; their blocking tile is the row below
const RIVER_COLS = [11, 12, 13, 14];
const BRIDGE_ROWS = [9, 10];
const FLOOR_FLAT = 1;
const FLOOR_PLANKS = 6;

function buildLayout() {
  const tiles = [];
  const tileColors = [];
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const bridge = RIVER_COLS.includes(col) && BRIDGE_ROWS.includes(row);
      tiles.push(bridge ? FLOOR_PLANKS : FLOOR_FLAT);
      tileColors.push(
        bridge ? FLOOR_COLORS.bridge : row < SKY_ROWS ? FLOOR_COLORS.sky : FLOOR_COLORS.grass,
      );
    }
  }

  const furniture = [];
  const add = (type, col, row) =>
    furniture.push({ uid: `ck-${furniture.length + 1}`, type, col, row });
  /** The same item on both banks, the right bank's in the other kingdom's colour. */
  const both = (type, col, row, width) => {
    add(type.replace('{team}', 'PURPLE'), col, row);
    add(type.replace('{team}', 'YELLOW'), COLS - col - width, row);
  };

  for (let col = 0; col < COLS; col++) {
    if (RIVER_COLS.includes(col)) continue;
    const falling = col < RIVER_COLS[0] ? col % 2 === 0 : col % 2 === 1;
    add(falling === col < RIVER_COLS[0] ? 'CK_HILL_A' : 'CK_HILL_B', col, HILL_ROW);
  }
  for (let row = SKY_ROWS; row < ROWS; row++) {
    if (BRIDGE_ROWS.includes(row)) continue;
    const top = row === SKY_ROWS ? 'T' : '';
    RIVER_COLS.forEach((col, i) => {
      const side = i === 0 ? 'L' : i === RIVER_COLS.length - 1 ? 'R' : '';
      // the boats bring their own water for the tile their hull is on
      const boatHull = (row === 6 || row === 13) && (col === 12 || col === 13);
      if (!boatHull) add(top + side ? `CK_WATER_${top}${side}` : 'CK_WATER', col, row);
    });
  }
  for (const [col, row] of [
    [8, 0],
    [12, 1],
    [17, 0],
    [21, 1],
  ]) {
    add('CK_CLOUD', col, row);
  }
  add('CK_BOAT_PURPLE', 12, 5);
  add('CK_BOAT_YELLOW', 12, 12);

  both('CK_CASTLE_{team}', 1, 1, 3);
  both('CK_TOWER_{team}', 5, 1, 2);
  both('CK_HUT', 8, 3, 2);
  both('CK_BANNER_{team}', 10, 7, 1);
  both('CK_TREE', 0, 9, 2);
  both('CK_TREE', 8, 12, 2);
  both('CK_ROCK', 0, 6, 1);
  both('CK_ROCK', 7, 15, 1);

  // workstations: a table, a laptop for each of its two stumps
  for (const [col, row] of [
    [2, 6],
    [6, 6],
    [4, 11],
  ]) {
    both('CK_TABLE', col, row, 2);
    for (const dc of [0, 1]) {
      both('CK_LAPTOP_FRONT_OFF', col + dc, row, 1);
      both('CK_STUMP', col + dc, row + 2, 1);
    }
  }
  // a spare stump by each fire-less camp, for whoever is resting
  both('CK_STUMP', 9, 5, 1);

  // grass and flowers on tiles nothing else stands on
  const used = new Set();
  for (const item of furniture) {
    const f = FOOTPRINTS[item.type];
    for (let dr = 0; dr < f.fh; dr++) {
      for (let dc = 0; dc < f.fw; dc++) used.add(`${item.col + dc},${item.row + dr}`);
    }
  }
  for (let row = SKY_ROWS + 1; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      if (used.has(`${col},${row}`) || RIVER_COLS.includes(col)) continue;
      const r = noise(col, row, 77);
      if (r < 0.2) add(r < 0.04 ? 'CK_FLOWERS' : r < 0.12 ? 'CK_TUFT' : 'CK_TUFT_2', col, row);
    }
  }

  return { version: 1, cols: COLS, rows: ROWS, layoutRevision: 1, tiles, tileColors, furniture };
}

// ── Cast ────────────────────────────────────────────────────────────────────

const tint = (h, s, b, c = 0) => ({ h, s, b, c, colorize: true });
const LILAC = tint(272, 52, 14);
const SUN = tint(46, 82, 12);
const CAST = [
  {
    name: 'Lilac',
    body: 'bust',
    eyeShape: 'lashes',
    utop: 'basic',
    under: 'basic',
    hair: 'long_bangs',
    top: 'long_sleeved_shirt',
    pants: 'skirt',
    shoes: 'boots',
    shades: 'glasses',
    colors: { hair: tint(24, 48, -30), top: LILAC, pants: tint(260, 20, -40) },
  },
  {
    name: 'Plum',
    body: 'flat',
    eyeShape: 'plain',
    under: 'basic',
    hair: 'mop',
    top: 'turtleneck',
    pants: 'jeans',
    shoes: 'sneakers',
    colors: { hair: tint(20, 30, -55), top: LILAC, pants: tint(215, 35, 5) },
  },
  {
    name: 'Mauve',
    body: 'bust',
    eyeShape: 'plain',
    utop: 'basic',
    under: 'basic',
    hair: 'high_ponytail',
    full: 'dress',
    colors: { hair: tint(335, 45, 18), full: LILAC },
  },
  {
    name: 'Honey',
    body: 'bust',
    eyeShape: 'lashes',
    utop: 'basic',
    under: 'basic',
    hair: 'bob',
    top: 'long_sleeved_shirt',
    pants: 'shorts',
    shoes: 'boots',
    colors: { hair: tint(30, 70, -5), top: SUN, pants: tint(28, 35, -25) },
  },
  {
    name: 'Amber',
    body: 'flat',
    eyeShape: 'plain',
    under: 'basic',
    hair: 'spiky',
    top: 'tshirt',
    pants: 'jeans',
    shoes: 'boots',
    colors: { hair: tint(18, 55, -40), top: SUN, pants: tint(215, 35, 5) },
  },
  {
    name: 'Saffron',
    body: 'flat',
    eyeShape: 'plain',
    under: 'basic',
    hair: 'side_swept',
    top: 'tshirt',
    jacket: 'bomber',
    pants: 'low_cut_jeans',
    shoes: 'sneakers',
    shades: 'glasses',
    colors: { hair: tint(9, 5, -70, -70), top: tint(40, 10, 80, 60), jacket: SUN },
  },
].map((profile, i) => ({ id: `crayon-${i + 1}`, v: 35, ...profile }));

// ── Output ──────────────────────────────────────────────────────────────────

const SHEETS = Object.fromEntries(
  ITEMS.flatMap((item) => Object.entries(item.files).map(([f, s]) => [f.replace('.png', ''), s])),
);
const FOOTPRINTS = Object.assign({}, ...ITEMS.map((item) => item.footprint));

function write() {
  const furnitureDir = path.join(HERE, 'assets', 'furniture');
  fs.rmSync(furnitureDir, { recursive: true, force: true });
  for (const item of ITEMS) {
    const dir = path.join(furnitureDir, item.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify(item.manifest, null, 2) + '\n',
    );
    for (const [file, sheet] of Object.entries(item.files)) {
      fs.writeFileSync(path.join(dir, file), sheet.png());
    }
  }
  const layout = buildLayout();
  fs.writeFileSync(path.join(HERE, 'layout.json'), JSON.stringify(layout) + '\n');
  fs.writeFileSync(path.join(HERE, 'characters.json'), JSON.stringify(CAST, null, 2) + '\n');
  return layout;
}

/** A rough picture of the layout: flat floor colours, furniture back to front. */
function preview(layout, file, scale = 3) {
  const out = new PNG({ width: COLS * TILE * scale, height: ROWS * TILE * scale });
  const plot = (x, y, color) => {
    if (x < 0 || y < 0 || x >= COLS * TILE || y >= ROWS * TILE) return;
    for (let sy = 0; sy < scale; sy++) {
      for (let sx = 0; sx < scale; sx++) {
        const i = ((y * scale + sy) * out.width + x * scale + sx) * 4;
        out.data[i] = parseInt(color.slice(1, 3), 16);
        out.data[i + 1] = parseInt(color.slice(3, 5), 16);
        out.data[i + 2] = parseInt(color.slice(5, 7), 16);
        out.data[i + 3] = 255;
      }
    }
  };
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const color = floorHex(layout.tileColors[row * COLS + col]);
      for (let y = 0; y < TILE; y++) {
        for (let x = 0; x < TILE; x++) plot(col * TILE + x, row * TILE + y, color);
      }
    }
  }
  const drawn = layout.furniture
    .map((item, order) => ({ item, order, sheet: SHEETS[item.type] }))
    .sort(
      (a, b) =>
        a.item.row * TILE + a.sheet.h - (b.item.row * TILE + b.sheet.h) || a.order - b.order,
    );
  for (const { item, sheet } of drawn) {
    sheet.px.forEach((color, i) => {
      if (color)
        plot(item.col * TILE + (i % sheet.w), item.row * TILE + Math.floor(i / sheet.w), color);
    });
  }
  fs.writeFileSync(file, PNG.sync.write(out));
}

const layout = write();
const previewAt = process.argv.indexOf('--preview');
if (previewAt > 0) preview(layout, process.argv[previewAt + 1]);
console.log(
  `Crayon Kingdom: ${ITEMS.length} furniture items, ${layout.furniture.length} placed, ${CAST.length} characters`,
);
