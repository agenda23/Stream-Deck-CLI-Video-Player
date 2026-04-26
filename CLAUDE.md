# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Node.js CLI application that treats the 15 LCD keys of an Elgato Stream Deck MK.2 as a single 360×216 px display and plays video files on it in real time.

## Prerequisites

- Node.js v16+
- FFmpeg on system PATH
- Elgato Stream Deck MK.2 connected via USB

## Key Dependencies

- `@elgato-stream-deck/node` — HID device control
- `sharp` — frame resize, crop, and buffer conversion
- `yargs` — CLI argument parsing
- `child_process` (built-in) — FFmpeg subprocess

## CLI Interface

```
node index.js --path <video> [--fps <n>] [--brightness <n>]
```

| Argument | Alias | Default | Notes |
|---|---|---|---|
| `--path` | `-p` | required | Path to video file |
| `--fps` | `-f` | 10 | Recommended range 7–15; ≥20 risks USB stuttering |
| `--brightness` | `-b` | 70 | Backlight intensity 0–100 |

## Architecture

### Display Layout

Stream Deck MK.2 has 5 columns × 3 rows of 72×72 px keys → composite canvas of **360×216 px**.

Key index mapping: row-major order, top-left = key 0, bottom-right = key 14.

### Data Flow

1. **Init**: validate args → open HID device → set brightness
2. **Decode**: spawn FFmpeg with `scale=360:216,fps=N` and `-f mjpeg` piped to stdout
3. **Frame extraction**: parse MJPEG stream from stdout by scanning for SOI (`0xFFD8`) / EOI (`0xFFD9`) byte markers
4. **Slice & send**: use `sharp` to `extract` 15 non-overlapping 72×72 tiles; send all in parallel with `Promise.all`
5. **Cleanup**: on exit (video end or SIGINT) call `setBrightness(0)` / `clearPanel()`

### Performance Notes

- Keep FFmpeg and Node stream directly connected in memory — avoid writing frames to disk.
- USB bandwidth caps practical FPS at ~15 for smooth playback.
- Future bezel compensation would require scaling the source larger and skipping inter-key pixels (not yet implemented).
