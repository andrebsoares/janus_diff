'use strict';
// Renders installer/icon.svg into installer/icon.ico and src/icon.png.
// Needs the "sharp" package, which is not a project dependency:
//   npm install --no-save sharp && node tools/icon/build.js
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const root = path.join(__dirname, '..', '..');
const svg = fs.readFileSync(path.join(root, 'installer', 'icon.svg'));
const SIZES = [16, 24, 32, 48, 64, 128, 256];

async function main() {
  const pngs = await Promise.all(SIZES.map((s) => sharp(svg, { density: 72 * s / 256 * 4 }).resize(s, s).png().toBuffer()));
  // ICO container with PNG-encoded entries.
  const header = Buffer.alloc(6 + 16 * SIZES.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(SIZES.length, 4);
  let offset = header.length;
  SIZES.forEach((s, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(s % 256, e);
    header.writeUInt8(s % 256, e + 1);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(pngs[i].length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += pngs[i].length;
  });
  fs.writeFileSync(path.join(root, 'installer', 'icon.ico'), Buffer.concat([header, ...pngs]));
  fs.writeFileSync(path.join(root, 'src', 'icon.png'), pngs[SIZES.indexOf(256)]);
  if (process.argv[2]) SIZES.forEach((s, i) => fs.writeFileSync(path.join(process.argv[2], `${s}.png`), pngs[i]));
}

main();
