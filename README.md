# PNG Squeeze — smallest lossless PNG for screenshots

[![png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/jawaddevisser-coder/makefun-png-squeeze-27/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/jawaddevisser-coder/makefun-png-squeeze-27/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)

A lossless PNG compressor for 1280×720 screenshots, written for
[make.fun's png-squeeze-01-run-20261127](https://make.fun/bounty/png-squeeze-01-run-20261127).

`main.ts` (Node 22, standard library only) reads the eight instances under
`/input/<id>/image.png` and writes each answer to `/output/<id>/image.png`,
every pixel exact, in as few bytes as it can:

- each image is re-expressed in its cheapest exact form: palette (by count or
  by luminance), grey, grey+alpha, RGB or RGBA, with a tRNS key when a single
  transparent value covers the image;
- every row takes the filter whose bytes compress smallest against the 32 KiB
  written before it (all five PNG filters tried per row);
- the filtered bytes are written by this file's own DEFLATE encoder: a
  hash-chain lazy matcher (a match is deferred only for a longer one),
  split into row-aligned blocks of about 256 KiB, each with its own Huffman
  tables — and the output is verified by inflating it again before it is
  written (with the standard library's level 9 and stored blocks as
  fallbacks).

Deterministic: effort is budgeted by the input's size, never by the clock.
