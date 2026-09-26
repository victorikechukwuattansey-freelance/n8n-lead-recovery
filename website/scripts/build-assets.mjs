'use strict';

// One-time build script: rasterize site SVGs to PNG assets.
// Runs under Node; requires `npm install` (sharp devDependency).
// The deployed site has no runtime deps — this is build-time only.

import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const jobs = [
  {
    out: 'public/favicon-32.png',
    src: 'public/favicon.svg',
    width: 32,
    height: 32,
  },
  {
    out: 'public/apple-touch-icon.png',
    src: 'public/assets/logo-mark.svg',
    width: 180,
    height: 180,
    padding: 20,
    background: '#FAFAFB',
  },
  {
    out: 'public/og-image.png',
    src: 'assets/og-image.svg',
    width: 1200,
    height: 630,
  },
];

for (const job of jobs) {
  const svg = await readFile(resolve(root, job.src));
  const outPath = resolve(root, job.out);

  if (job.padding) {
    const inner = await sharp(svg)
      .resize(job.width - job.padding * 2, job.height - job.padding * 2, { fit: 'contain' })
      .png()
      .toBuffer();
    await sharp({
      create: { width: job.width, height: job.height, channels: 4, background: job.background },
    })
      .composite([{ input: inner, left: job.padding, top: job.padding }])
      .png()
      .toFile(outPath);
  } else {
    await sharp(svg)
      .resize(job.width, job.height, { fit: 'fill' })
      .png()
      .toFile(outPath);
  }

  const { size } = await stat(outPath);
  console.log(`wrote ${job.out} (${size} bytes)`);
}