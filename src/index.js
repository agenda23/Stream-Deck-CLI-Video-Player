#!/usr/bin/env node

"use strict";

const fs = require("fs");
const { spawn, spawnSync } = require("child_process");
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");
const sharp = require("sharp");
const { listStreamDecks, openStreamDeck } = require("@elgato-stream-deck/node");

const KEY_WIDTH = 72;
const KEY_HEIGHT = 72;
const COLUMNS = 5;
const ROWS = 3;
const KEY_COUNT = COLUMNS * ROWS;
const CANVAS_WIDTH = KEY_WIDTH * COLUMNS;
const CANVAS_HEIGHT = KEY_HEIGHT * ROWS;
const JPEG_SOI_MARKER = Buffer.from([0xff, 0xd8]);
const JPEG_EOI_MARKER = Buffer.from([0xff, 0xd9]);

function ensureSupportedNodeVersion() {
  const major = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (Number.isNaN(major)) {
    return;
  }
  if (major >= 22) {
    throw new Error(
      `Node.js ${process.versions.node} is not recommended for node-hid stability. Use Node.js 20.x.`
    );
  }
}

function isWslEnvironment() {
  if (process.platform !== "linux") {
    return false;
  }
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) {
    return true;
  }
  try {
    const procVersion = fs.readFileSync("/proc/version", "utf8");
    return /microsoft/i.test(procVersion);
  } catch (_) {
    return false;
  }
}

function parseArgs() {
  return yargs(hideBin(process.argv))
    .option("path", {
      alias: "p",
      type: "string",
      demandOption: true,
      description: "Path to input video file"
    })
    .option("fps", {
      alias: "f",
      type: "number",
      default: 10,
      description: "Playback fps"
    })
    .option("brightness", {
      alias: "b",
      type: "number",
      default: 70,
      description: "Deck brightness (0-100)"
    })
    .option("dry-run", {
      type: "boolean",
      default: false,
      description: "Run decode/slice pipeline without writing to Stream Deck"
    })
    .option("allow-wsl-hid", {
      type: "boolean",
      default: false,
      description: "Allow HID access on WSL (may crash depending on environment)"
    })
    .option("pixel-format", {
      type: "string",
      choices: ["rgb", "bgr"],
      default: "rgb",
      description: "Pixel format to send to Stream Deck"
    })
    .check((argv) => {
      if (!Number.isFinite(argv.fps) || argv.fps <= 0) {
        throw new Error("--fps must be a positive number");
      }
      if (!Number.isFinite(argv.brightness) || argv.brightness < 0 || argv.brightness > 100) {
        throw new Error("--brightness must be between 0 and 100");
      }
      return true;
    })
    .strict()
    .help()
    .parseSync();
}

function ensureFfmpegInstalled() {
  const result = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  if (result.error || result.status !== 0) {
    throw new Error("FFmpeg is not available in PATH");
  }
}

function ensureFileExists(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Video file does not exist: ${filePath}`);
  }
}

function formatDeckOpenError(error, devicePath) {
  const raw = error && error.message ? error.message : String(error);
  const lower = raw.toLowerCase();
  const isOpenFailure =
    lower.includes("cannot open device with path") ||
    lower.includes("eacces") ||
    lower.includes("permission denied") ||
    lower.includes("busy");

  if (!isOpenFailure) {
    return `Unable to open Stream Deck: ${raw}`;
  }

  const lines = [
    `Unable to open Stream Deck device (${devicePath}).`,
    "Possible causes:",
    "1) Permission issue on /dev/hidraw* (add udev rule and re-login, or run with sudo for quick test).",
    "2) Device is already in use by another process.",
    "3) In WSL, USB device is not attached/exposed correctly to Linux."
  ];

  return lines.join("\n");
}

function extractFramesFromBuffer(buffer) {
  const frames = [];
  let cursor = 0;

  while (cursor < buffer.length) {
    const soiIndex = buffer.indexOf(JPEG_SOI_MARKER, cursor);
    if (soiIndex === -1) {
      return { frames, remaining: Buffer.alloc(0) };
    }

    const eoiIndex = buffer.indexOf(JPEG_EOI_MARKER, soiIndex + JPEG_SOI_MARKER.length);
    if (eoiIndex === -1) {
      return { frames, remaining: buffer.subarray(soiIndex) };
    }

    const frameEnd = eoiIndex + JPEG_EOI_MARKER.length;
    frames.push(buffer.subarray(soiIndex, frameEnd));
    cursor = frameEnd;
  }

  return { frames, remaining: Buffer.alloc(0) };
}

function keyToCropArea(keyIndex) {
  const col = keyIndex % COLUMNS;
  const row = Math.floor(keyIndex / COLUMNS);

  return {
    left: col * KEY_WIDTH,
    top: row * KEY_HEIGHT,
    width: KEY_WIDTH,
    height: KEY_HEIGHT
  };
}

async function renderFrameToDeck(deck, jpegBuffer, pixelFormat) {
  const { data, info } = await sharp(jpegBuffer)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (info.width !== CANVAS_WIDTH || info.height !== CANVAS_HEIGHT || info.channels !== 3) {
    throw new Error(
      `Unexpected frame format: ${info.width}x${info.height} channels=${info.channels} (expected ${CANVAS_WIDTH}x${CANVAS_HEIGHT} channels=3)`
    );
  }

  // Prefer single panel write to avoid many HID writes per frame on Windows.
  await deck.fillPanelBuffer(data, { format: pixelFormat });
}

async function runDryPlayback(ffmpegStdout) {
  let accumBuffer = Buffer.alloc(0);
  let frameCount = 0;
  ffmpegStdout.on("data", (chunk) => {
    accumBuffer = Buffer.concat([accumBuffer, chunk]);
    const { frames, remaining } = extractFramesFromBuffer(accumBuffer);
    accumBuffer = remaining;
    frameCount += frames.length;
    if (frameCount > 0 && frameCount % 100 === 0) {
      console.log(`[dry-run] decoded frames: ${frameCount}`);
    }
  });
}

async function main() {
  ensureSupportedNodeVersion();
  const args = parseArgs();
  ensureFileExists(args.path);
  ensureFfmpegInstalled();

  process.on("uncaughtException", (error) => {
    console.error(`[fatal] uncaughtException: ${error && error.stack ? error.stack : error}`);
  });
  process.on("unhandledRejection", (reason) => {
    console.error(`[fatal] unhandledRejection: ${reason}`);
  });
  process.on("exit", (code) => {
    console.error(`[process] exit code: ${code}`);
  });

  if (!args.dryRun && isWslEnvironment() && !args.allowWslHid) {
    throw new Error(
      "WSL environment detected. HID access via node-hid can crash on some setups.\n" +
        "Use --dry-run to validate the pipeline, or run on native Linux/Windows.\n" +
        "If you still want to try in WSL, add --allow-wsl-hid."
    );
  }

  let deck;
  let ffmpeg;
  let hasExited = false;
  let shuttingDown = false;
  let accumBuffer = Buffer.alloc(0);
  let isRendering = false;
  let pendingFrames = [];
  let selectedDevicePath = "/dev/hidraw*";
  let renderedFrameCount = 0;
  let decodedFrameCount = 0;
  let ffmpegCompleted = false;
  let ffmpegExitCode = 0;

  const finalize = async (exitCode = 0, message = "") => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    if (message) {
      if (exitCode === 0) {
        console.log(message);
      } else {
        console.error(message);
      }
    }

    if (ffmpeg && !hasExited) {
      ffmpeg.kill();
    }

    if (deck) {
      try {
        await deck.clearPanel();
      } catch (_) {
        // ignore cleanup errors
      }
      try {
        deck.close();
      } catch (_) {
        // ignore cleanup errors
      }
    }

    process.exit(exitCode);
  };

  const pumpFrames = async () => {
    if (!ffmpeg) {
      return;
    }
    if (isRendering) {
      return;
    }
    if (pendingFrames.length === 0) {
      return;
    }

    isRendering = true;
    const frame = pendingFrames.shift();
    const nextFrameNo = renderedFrameCount + 1;
    if (nextFrameNo <= 3) {
      console.log(`[render] start frame: ${nextFrameNo}`);
    }

    try {
      await renderFrameToDeck(deck, frame, args.pixelFormat);
      renderedFrameCount += 1;
      if (renderedFrameCount <= 5 || renderedFrameCount % 30 === 0) {
        console.log(`[render] frames sent: ${renderedFrameCount}`);
      }
    } catch (error) {
      await finalize(1, `Frame render failed: ${error.message}`);
      return;
    } finally {
      isRendering = false;
    }

    if (pendingFrames.length > 0) {
      setImmediate(() => {
        void pumpFrames();
      });
    } else if (ffmpegCompleted) {
      await finalize(ffmpegExitCode === 0 ? 0 : 1, ffmpegExitCode === 0 ? "Playback finished" : `ffmpeg exited with code ${ffmpegExitCode}`);
    }
  };

  process.on("SIGINT", () => {
    void finalize(0, "Stopped by SIGINT");
  });
  process.on("SIGTERM", () => {
    void finalize(0, "Stopped by SIGTERM");
  });

  if (!args.dryRun) {
    try {
      const devices = await listStreamDecks();
      if (devices.length === 0) {
        throw new Error("No Stream Deck devices are connected");
      }

      selectedDevicePath = devices[0].path;
      deck = await openStreamDeck(selectedDevicePath);
      deck.on("error", (error) => {
        void finalize(1, `Stream Deck device error: ${error.message}`);
      });
      await deck.setBrightness(args.brightness);
    } catch (error) {
      await finalize(1, formatDeckOpenError(error, selectedDevicePath));
      return;
    }
  }

  ffmpeg = spawn("ffmpeg", [
    "-re",
    "-i",
    args.path,
    "-vf",
    `fps=${args.fps},scale=${CANVAS_WIDTH}:${CANVAS_HEIGHT}:flags=lanczos`,
    "-f",
    "image2pipe",
    "-vcodec",
    "mjpeg",
    "-q:v",
    "3",
    "pipe:1"
  ]);

  if (args.dryRun) {
    await runDryPlayback(ffmpeg.stdout);
  }

  ffmpeg.stdout.on("data", (chunk) => {
    if (args.dryRun) {
      return;
    }

    accumBuffer = Buffer.concat([accumBuffer, chunk]);
    const { frames, remaining } = extractFramesFromBuffer(accumBuffer);
    accumBuffer = remaining;

    if (frames.length > 0) {
      decodedFrameCount += frames.length;
      if (decodedFrameCount <= 5 || decodedFrameCount % 60 === 0) {
        console.log(`[decode] frames ready: ${decodedFrameCount}`);
      }
      // Keep queue short for low-latency rendering and avoid unbounded memory growth.
      pendingFrames = pendingFrames.concat(frames).slice(-2);
      void pumpFrames();
    }
  });

  ffmpeg.stderr.on("data", (chunk) => {
    const message = chunk.toString().trim();
    if (message.length > 0) {
      console.error(`[ffmpeg] ${message}`);
    }
  });

  ffmpeg.on("error", async (error) => {
    await finalize(1, `Failed to start ffmpeg: ${error.message}`);
  });

  ffmpeg.on("close", async (code) => {
    hasExited = true;
    ffmpegCompleted = true;
    ffmpegExitCode = Number.isInteger(code) ? code : 1;
    if (args.dryRun) {
      await finalize(ffmpegExitCode === 0 ? 0 : 1, ffmpegExitCode === 0 ? "Playback finished" : `ffmpeg exited with code ${ffmpegExitCode}`);
      return;
    }

    if (!isRendering && pendingFrames.length === 0) {
      await finalize(ffmpegExitCode === 0 ? 0 : 1, ffmpegExitCode === 0 ? "Playback finished" : `ffmpeg exited with code ${ffmpegExitCode}`);
    }
  });
}

void main();
