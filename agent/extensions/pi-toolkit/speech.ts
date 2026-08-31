/**
 * speech.ts — LIVE streaming speech-to-text for the Pi coding agent.
 *
 * This is built around CrispASR's streaming decoder, not a
 * record-then-transcribe pipeline. While you record, the mic's raw PCM is
 * piped straight into `crispasr --stream --stream-json`, which emits JSON
 * events on stdout:
 *
 *   {"type":"partial", ...}   still-evolving text for the open utterance
 *   {"type":"final",   ...}   the utterance finished after trailing silence
 *   {"type":"silence", ...}   a silence heartbeat (used to drive the meter)
 *
 * Partials render live in the widget as you speak; each natural pause
 * auto-finalizes the current utterance and delivers it immediately
 * (append to editor, or send to chat, per /speech insert). Hitting the
 * keybind again stops the mic, finalizes whatever is in flight, and
 * returns to idle — no waiting for a full-file decode at the end.
 *
 * Requirements
 * ------------
 * 1. A microphone recorder on PATH: `sox` (recommended), `ffmpeg`, or
 *    (Linux) `arecord`. On PipeWire systems `pw-record` is preferred — it
 *    captures by node name and avoids ALSA/PipeWire device conflicts. The
 *    extension auto-detects whichever is present.
 * 2. The `crispasr` CLI (https://github.com/CrispStrobe/CrispASR) — a
 *    single C++/ggml binary that runs all three model tiers below. Use a
 *    recent build (>= mid-2026) so --stream/--stream-json are available.
 * 3. One of the three GGUF models downloaded. Everything under /speech
 *    download works as before, and the extension now auto-downloads the
 *    active tier (with live progress) the first time you record if it's
 *    missing.
 *
 * Install location
 * -----------------
 *   ~/.pi/agent/extensions/speech.ts        (global)
 *   .pi/extensions/speech.ts                (project-local)
 *
 * Commands
 * --------
 *   /speech                    show current status
 *   /speech model [tier]       show/set quality tier: big | mid | tiny
 *   /speech download [tier]    download that tier's GGUF from Hugging Face
 *   /speech stop               stop recording and deliver what remains
 *   /speech keybind [key]      show/set the record-toggle key (needs /reload)
 *   /speech cancel-keybind [key]  show/set the cancel key (needs /reload)
 *   /speech language [code]    show/set language, or "auto"
 *   /speech insert [mode]      "editor" (paste into prompt) or "send" (submit)
 *   /speech recorder [name]    "auto" | "pw-record" | "sox" | "ffmpeg" | "arecord"
 *   /speech mic [name]         select a non-default input device ("" = default)
 *   /speech mics               list the available input devices (autodetect)
 *   /speech finalize [ms]      show/set silence threshold that finalizes a
 *                              live utterance (default 900 ms)
 *   /speech step [ms]          show/set streaming partial-decode cadence
 *                              (smaller = more frequent live updates)
 *   /speech path               show the resolved model file path
 *
 * Settings persist under the "speech" key in ~/.pi/agent/settings.json,
 * following the same convention other pi voice extensions use.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, KeyId } from "@earendil-works/pi-tui";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  createWriteStream,
} from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import https from "node:https";

// ---------------------------------------------------------------------------
// Types & defaults
// ---------------------------------------------------------------------------

type ModelTier = "big" | "mid" | "tiny";
type InsertMode = "editor" | "send";
type RecorderChoice = "auto" | "sox" | "ffmpeg" | "arecord" | "pw-record";

interface SpeechSettings {
  keybind: string;
  cancelKeybind: string;
  modelTier: ModelTier;
  language: string; // "auto" or a language code, e.g. "en-US"
  crispasrPath: string; // path or bare command name for the crispasr binary
  modelsDir: string; // where GGUF files + temp recordings live
  insertMode: InsertMode;
  recorder: RecorderChoice;
  mic: string; // non-default input device name ("" = system default)
  sampleRate: number;
  finalizeOnPauseMs: number; // trailing silence that finalizes a live utterance
  streamStepMs: number; // cadence of partial ASR decodes while streaming
}

const DEFAULT_SETTINGS: SpeechSettings = {
  keybind: "ctrl+shift+v",
  cancelKeybind: "ctrl+shift+x",
  modelTier: "mid",
  language: "auto",
  crispasrPath: "crispasr",
  modelsDir: join(homedir(), ".pi", "agent", "speech-models"),
  insertMode: "editor",
  recorder: "auto",
  mic: "", // empty string selects the system default input device
  sampleRate: 16000,
  finalizeOnPauseMs: 900,
  streamStepMs: 1200,
};

interface ModelTierInfo {
  backend: string; // crispasr --backend value
  label: string;
  repo: string; // Hugging Face repo id
  file: string; // exact filename inside the repo
  approxSize: string;
}

// The three quality tiers requested — all run through the same crispasr
// binary, just with a different --backend and GGUF file. nemotron and qwen3
// have native streaming decoders; sensevoice streams via CrispASR's generic
// sliding-window path. All support --stream/--stream-json.
const MODEL_TIERS: Record<ModelTier, ModelTierInfo> = {
  big: {
    backend: "nemotron",
    label: "Nemotron 3.5 ASR Streaming 0.6B",
    repo: "handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf",
    file: "nemotron-3.5-asr-streaming-0.6b-Q4_K_M.gguf",
    approxSize: "~600MB",
  },
  mid: {
    backend: "qwen3",
    label: "Qwen3-ASR 0.6B",
    repo: "mradermacher/Qwen3-ASR-0.6B-GGUF",
    file: "Qwen3-ASR-0.6B.Q4_K_S.gguf",
    approxSize: "~400MB",
  },
  tiny: {
    backend: "sensevoice",
    label: "SenseVoice Small",
    repo: "cstr/sensevoice-small-GGUF",
    file: "sensevoice-small-q8_0.gguf",
    approxSize: "~200MB",
  },
};

const SETTINGS_FILE = join(homedir(), ".pi", "agent", "settings.json");
const WIDGET_KEY = "speech";
const STATUS_KEY = "speech";

// Amplitude glyph ramp, quietest -> loudest.
const LEVEL_GLYPHS = ["·", "•", "၊", "|", "॥", "။", "‖", "█"];
const METER_WIDTH = 24;
const METER_TICK_MS = 90;

// Progress-bar block glyphs for the model-install bar.
const BAR_GLYPHS = [" ", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"];
const BAR_WIDTH = 18;

// ---------------------------------------------------------------------------
// Small formatting helpers
// ---------------------------------------------------------------------------

function formatBytes(n: number): string {
  if (!isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i >= 2 ? 1 : 0)} ${units[i]}`;
}

function renderBar(frac: number, width = BAR_WIDTH): string {
  const full = Math.max(0, Math.min(1, frac)) * width;
  let out = "";
  for (let i = 0; i < width; i++) {
    const seg = Math.max(0, Math.min(1, full - i));
    out += BAR_GLYPHS[Math.round(seg * (BAR_GLYPHS.length - 1))];
  }
  return out;
}

// SenseVoice emits inline language-id + audio-event tags; qwen/nemotron can
// leave stray markers. Strip all bracketed/curly tags for clean output.
function cleanTranscript(text: string): string {
  return text
    .replace(/<\|[^|]*\|>/g, "") // <|en|>, <|zh|>
    .replace(/<[^>]*>/g, "") // <Speech>, <Noise>, <Event>
    .replace(/\{[^}]*\}/g, "") // {en_XX} language tags
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Settings persistence — merge under "speech", leave the rest of
// settings.json untouched.
// ---------------------------------------------------------------------------

function readJsonSafe(path: string): Record<string, unknown> {
  try {
    if (!existsSync(path)) return {};
    const raw = readFileSync(path, "utf8").trim();
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function loadSettings(): SpeechSettings {
  const root = readJsonSafe(SETTINGS_FILE);
  const stored = (root.speech as Partial<SpeechSettings>) ?? {};
  return { ...DEFAULT_SETTINGS, ...stored };
}

function saveSettings(patch: Partial<SpeechSettings>): SpeechSettings {
  const root = readJsonSafe(SETTINGS_FILE);
  const current = {
    ...DEFAULT_SETTINGS,
    ...((root.speech as Partial<SpeechSettings>) ?? {}),
  };
  const next = { ...current, ...patch };
  root.speech = next;
  mkdirSync(dirname(SETTINGS_FILE), { recursive: true });
  writeFileSync(SETTINGS_FILE, JSON.stringify(root, null, 2) + "\n", "utf8");
  return next;
}

// ---------------------------------------------------------------------------
// Recorder backend selection
// ---------------------------------------------------------------------------

interface RecorderSpec {
  name: "sox" | "ffmpeg" | "arecord" | "pw-record";
  cmd: string;
  args: string[];
}

function buildRecorderSpec(
  name: "sox" | "ffmpeg" | "arecord" | "pw-record",
  sampleRate: number,
  mic: string,
): RecorderSpec {
  const inputArg = mic.trim();
  switch (name) {
    case "sox":
      // sox: -d dumps the default device; a named device is selected with
      // --device NAME (flanked by -t when a concrete driver is needed).
      return {
        name,
        cmd: "sox",
        args: inputArg
          ? ["-q", "--device", inputArg, "-t", "raw", "-r", String(sampleRate), "-e", "signed-integer", "-b", "16", "-c", "1", "-"]
          : ["-q", "-d", "-t", "raw", "-r", String(sampleRate), "-e", "signed-integer", "-b", "16", "-c", "1", "-"],
      };
    case "ffmpeg": {
      const os = platform();
      let dev: string;
      if (os === "darwin") {
        // avfoundation takes an index or friendly name, e.g. :0 -> inputArg
        dev = inputArg || ":0";
        return {
          name,
          cmd: "ffmpeg",
          args: [
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "avfoundation",
            "-i",
            dev,
            "-ar",
            String(sampleRate),
            "-ac",
            "1",
            "-f",
            "s16le",
            "-",
          ],
        };
      }
      if (os === "win32") {
        // dshow: audio=<device name>
        dev = inputArg ? `audio=${inputArg}` : "audio=default";
        return {
          name,
          cmd: "ffmpeg",
          args: [
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "dshow",
            "-i",
            dev,
            "-ar",
            String(sampleRate),
            "-ac",
            "1",
            "-f",
            "s16le",
            "-",
          ],
        };
      }
      // Linux alsa: device name after -i, e.g. hw:1,0 or plughw:CARD
      dev = inputArg || "default";
      return {
        name,
        cmd: "ffmpeg",
        args: [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "alsa",
          "-i",
          dev,
          "-ar",
          String(sampleRate),
          "-ac",
          "1",
          "-f",
          "s16le",
          "-",
        ],
      };
    }
    case "arecord":
      return {
        name,
        cmd: "arecord",
        args: inputArg
          ? ["-q", "-D", inputArg, "-f", "S16_LE", "-r", String(sampleRate), "-c", "1", "-t", "raw", "-"]
          : ["-q", "-f", "S16_LE", "-r", String(sampleRate), "-c", "1", "-t", "raw", "-"],
      };
    case "pw-record":
      // PipeWire-native capture. --raw is REQUIRED so stdout is clean s16le
      // instead of the AU container libsndfile would otherwise wrap it in.
      // --target takes a node.name (e.g. alsa_input.usb-0c76-...), an object
      // serial, or "auto"/omission for the default source.
      return {
        name,
        cmd: "pw-record",
        args: [
          "--raw",
          "--rate",
          String(sampleRate),
          "--channels",
          "1",
          "--format",
          "s16",
          ...(inputArg ? ["--target", inputArg] : []),
          "-",
        ],
      };
  }
}

async function commandExists(pi: ExtensionAPI, cmd: string): Promise<boolean> {
  try {
    const probe = platform() === "win32" ? "where" : "which";
    const result = await pi.exec(probe, [cmd], { timeout: 4000 });
    return result.code === 0;
  } catch {
    return false;
  }
}

async function resolveRecorder(
  pi: ExtensionAPI,
  settings: SpeechSettings,
): Promise<RecorderSpec | null> {
  const candidates: Array<"sox" | "ffmpeg" | "arecord" | "pw-record"> =
    settings.recorder === "auto"
      ? platform() === "linux"
        ? ["pw-record", "sox", "arecord", "ffmpeg"]
        : ["sox", "ffmpeg"]
      : [settings.recorder as "sox" | "ffmpeg" | "arecord" | "pw-record"];

  for (const name of candidates) {
    if (await commandExists(pi, name)) return buildRecorderSpec(name, settings.sampleRate, settings.mic);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Input-device autodetection
//
// There is no unified, cross-platform way to enumerate microphones, so we
// probe whichever capture tool is available and understand its listing
// format:
//   - Linux + PipeWire: pw-dump (Audio/Source nodes) or pactl list sources
//   - Linux + ALSA:     arecord -l  -> hw:N,M (used when pw-record is absent)
//   - macOS:            ffmpeg avfoundation -list_devices true (index or name)
//   - Windows:          ffmpeg dshow -sources dshow (quoted device names)
// sox itself has no enumeration API, so we lean on the PipeWire/ALSA probes.
// ---------------------------------------------------------------------------

interface InputDevice {
  label: string; // human-readable description, e.g. "Integrated Camera"
  value: string; // value to feed /speech mic, e.g. "hw:1,0" or ":0"
}

// Probe command output is often printed to stderr and exits non-zero (e.g.
// ffmpeg listing with no input), so accept both streams and ignore the exit
// code — we only care that some text came back.
async function runProbe(pi: ExtensionAPI, cmd: string, args: string[]): Promise<string | null> {
  try {
    const r = await pi.exec(cmd, args, { timeout: 8000 });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    return out.trim() ? out : null;
  } catch {
    return null;
  }
}

function parseArecordListing(text: string): InputDevice[] {
  const out: InputDevice[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^card\s+(\d+):\s+(.+?)\s*,\s*device\s+(\d+):(.+)$/);
    if (m) {
      const [, card, cardName, device] = m;
      out.push({ label: `${cardName.trim()} (hw:${card},${device})`, value: `hw:${card},${device}` });
    }
  }
  return out;
}

function parseDshowListing(text: string): InputDevice[] {
  const out: InputDevice[] = [];
  const body =
    text.indexOf("audio devices") >= 0 ? text.slice(text.indexOf("audio devices")) : text;
  for (const line of body.split(/\r?\n/)) {
    const q = line.match(/^\s*"([^"]+)"\s*$/);
    if (q) out.push({ label: q[1], value: q[1] });
  }
  return out;
}

function parseAvfoundationListing(text: string): InputDevice[] {
  const out: InputDevice[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/\[(\d+)\]\s+(.+?)\s*$/);
    if (m) out.push({ label: `${m[2].trim()} (:${m[1]})`, value: `:${m[1]}` });
  }
  return out;
}

// PipeWire node dump (pw-dump) is a JSON array. A capture source is a Node
// whose media.class is "Audio/Source"; the target value pw-record wants is the
// node.name (object serial also works, but names survive restarts).
function parsePwDumpListing(text: string): InputDevice[] {
  const out: InputDevice[] = [];
  try {
    const arr = JSON.parse(text) as Array<{
      type?: string;
      info?: { props?: Record<string, unknown> };
    }>;
    for (const obj of arr) {
      if (obj.type !== "PipeWire:Interface:Node") continue;
      const props = obj.info?.props ?? {};
      if (props["media.class"] !== "Audio/Source") continue;
      const name = typeof props["node.name"] === "string" ? props["node.name"] : "";
      const description =
        typeof props["node.description"] === "string" ? props["node.description"] : "";
      if (!name) continue;
      out.push({ label: description ? `${description} (${name})` : name, value: name });
    }
  } catch {
    // not JSON — fall through to pactl/arecord
  }
  return out;
}

// PulseAudio/PipeWire-pulse long listing: blocks of "Source #N" with
// Name:/Description: lines. Skip .monitor pseudo-sources (output monitors).
function parsePactlSources(text: string): InputDevice[] {
  const out: InputDevice[] = [];
  const blocks = text.split(/^Source #\d+/m).slice(1);
  for (const block of blocks) {
    const name = block.match(/^\s*Name: (.+)$/m)?.[1]?.trim() ?? "";
    const description = block.match(/^\s*Description: (.+)$/m)?.[1]?.trim() ?? "";
    if (!name || name.endsWith(".monitor")) continue;
    out.push({ label: description ? `${description} (${name})` : name, value: name });
  }
  return out;
}

async function detectInputDevices(pi: ExtensionAPI): Promise<InputDevice[] | null> {
  const os = platform();
  const list: InputDevice[] = [];

  if (os === "linux") {
    if (await commandExists(pi, "pw-record")) {
      // PipeWire is in charge — pw-record wants node names, and on a
      // PipeWire system direct ALSA capture (hw:N,M) often fails because
      // PipeWire holds the device. Prefer pw-dump, fall back to pactl.
      let devices: InputDevice[] = [];
      if (await commandExists(pi, "pw-dump")) {
        const t = await runProbe(pi, "pw-dump", []);
        if (t) devices = parsePwDumpListing(t);
      }
      if (!devices.length && (await commandExists(pi, "pactl"))) {
        const t = await runProbe(pi, "pactl", ["list", "sources"]);
        if (t) devices = parsePactlSources(t);
      }
      if (devices.length) list.push(...devices);
    }
    if (!list.length && (await commandExists(pi, "arecord"))) {
      const t = await runProbe(pi, "arecord", ["-l"]);
      if (t) {
        const devices = parseArecordListing(t);
        if (devices.length) list.push(...devices);
      }
    }
    // sox has no enumeration API of its own; the PipeWire/ALSA listings
    // above are the best cross-tool source available.
  } else if (os === "win32") {
    if (await commandExists(pi, "ffmpeg")) {
      const t = await runProbe(pi, "ffmpeg", ["-hide_banner", "-sources", "dshow"]);
      if (t) {
        const devices = parseDshowListing(t);
        if (devices.length) list.push(...devices);
      }
    }
  } else if (os === "darwin") {
    if (await commandExists(pi, "ffmpeg")) {
      const t = await runProbe(pi, "ffmpeg", [
        "-hide_banner",
        "-f",
        "avfoundation",
        "-list_devices",
        "true",
        "-i",
        "",
      ]);
      if (t) {
        const devices = parseAvfoundationListing(t);
        if (devices.length) list.push(...devices);
      }
    }
  }

  return list.length ? list : null;
}

// Cached results of the last /speech mics run, used to autocomplete the mic
// device value on /speech mic <name>.
let detectedDevices: InputDevice[] = [];

// ---------------------------------------------------------------------------
// Audio level
// ---------------------------------------------------------------------------

function rmsLevel(buf: Buffer): number {
  if (buf.length < 2) return 0;
  let sumSquares = 0;
  let count = 0;
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const sample = buf.readInt16LE(i);
    sumSquares += sample * sample;
    count++;
  }
  if (count === 0) return 0;
  const rms = Math.sqrt(sumSquares / count);
  return Math.min(1, rms / 6000);
}

// ---------------------------------------------------------------------------
// Widget / status line rendering
// ---------------------------------------------------------------------------

function renderMeterLine(
  levels: number[],
  elapsedMs: number,
  state: "recording" | "transcribing",
): string {
  const bar = levels
    .map(
      (lvl) =>
        LEVEL_GLYPHS[Math.min(LEVEL_GLYPHS.length - 1, Math.floor(lvl * LEVEL_GLYPHS.length))],
    )
    .join("")
    .padEnd(METER_WIDTH, " ");
  const seconds = (elapsedMs / 1000).toFixed(1);
  const icon =
    state === "recording" ? (Math.floor(elapsedMs / 400) % 2 === 0 ? "◉" : "○") : "…";
  const label = state === "recording" ? `recording ${seconds}s` : "transcribing…";
  return `${icon} [${bar}] ${label}`;
}

function idleLine(settings: SpeechSettings): string {
  return `◎ speech idle — ${settings.keybind} to record · ${settings.cancelKeybind} to cancel`;
}

function renderDownloadLine(
  label: string,
  received: number,
  total: number,
  pct: number,
  speed: number,
): string {
  const bar = renderBar(pct / 100);
  const size = total
    ? `${Math.round(received / 1e6)}/${Math.round(total / 1e6)} MB`
    : `${formatBytes(received)} downloaded`;
  const sp = speed > 0 ? ` · ${formatBytes(speed)}/s` : "";
  return `↓ ${label} [${bar}] ${pct.toFixed(0).padStart(3)}% · ${size}${sp}`;
}

// ---------------------------------------------------------------------------
// Recording session — captures mic, exposes its stdout for piping, and
// drives the live level meter.
// ---------------------------------------------------------------------------

class RecordingSession {
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private sinceLastTick: Buffer[] = [];
  private levels: number[] = [];
  private meterTimer: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;
  active = false;

  constructor(
    private readonly spec: RecorderSpec,
    private readonly onFrame: (line: string) => void,
  ) {}

  start() {
    this.active = true;
    this.startedAt = Date.now();
    this.child = spawn(this.spec.cmd, this.spec.args, {
      stdio: ["ignore", "pipe", "pipe"] as const,
    });
    this.child.stdout.on("data", (buf: Buffer) => {
      // Level metering only — the PCM itself is piped to the transcriber.
      this.sinceLastTick.push(buf);
    });
    this.child.on("error", () => {
      this.active = false;
    });
    this.meterTimer = setInterval(() => this.tick(), METER_TICK_MS);
  }

  /** Pipe the raw PCM stream to the ASR transcriber. */
  pipeTo(target: Writable) {
    this.child?.stdout.pipe(target);
  }

  private tick() {
    const buf = Buffer.concat(this.sinceLastTick);
    this.sinceLastTick = [];
    this.levels.push(rmsLevel(buf));
    if (this.levels.length > METER_WIDTH) this.levels.shift();
    this.onFrame(renderMeterLine(this.levels, Date.now() - this.startedAt, "recording"));
  }

  /**
   * Stop capturing and resolve once the recorder has fully exited (so its
   * stdout pipe has drained into the transcriber's stdin before we end it).
   */
  async stopAndFlush(): Promise<void> {
    this.stopMeter();
    return new Promise((resolve) => {
      if (!this.child) return resolve();
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      this.child.once("close", done);
      this.child.kill(platform() === "win32" ? undefined : "SIGTERM");
      // Safety net in case the recorder ignores the signal.
      setTimeout(done, 1500);
    });
  }

  cancel() {
    this.stopMeter();
    this.child?.kill();
  }

  private stopMeter() {
    this.active = false;
    if (this.meterTimer) {
      clearInterval(this.meterTimer);
      this.meterTimer = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Streaming transcriber — a long-running `crispasr --stream --stream-json`
// child that consumes raw PCM on stdin and emits JSON events on stdout.
// ---------------------------------------------------------------------------

interface TranscriberCallbacks {
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  onFatal: (message: string) => void;
}

class StreamingTranscriber {
  private child: ChildProcessByStdio<Writable, Readable, Readable> | null = null;
  private lineBuf = "";
  private closedResolve: (() => void) | null = null;
  private closed = new Promise<void>((resolve) => (this.closedResolve = resolve));
  exitCode: number | null = null;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly settings: SpeechSettings,
    private readonly modelPath: string,
    private readonly tierInfo: ModelTierInfo,
    private readonly events: TranscriberCallbacks,
  ) {
    this.start();
  }

  private start() {
    const args: string[] = [
      "--backend",
      this.tierInfo.backend,
      "-m",
      this.modelPath,
      "--stream",
      "--stream-json",
      "--stream-step",
      String(this.settings.streamStepMs),
      "--stream-final-on-silence-ms",
      String(this.settings.finalizeOnPauseMs),
      "--language",
      this.settings.language || "auto",
      "--no-prints",
    ];
    this.child = spawn(this.settings.crispasrPath, args, {
      stdio: ["pipe", "pipe", "pipe"] as const,
    });
    this.child.stdout.on("data", (buf: Buffer) => this.parse(buf.toString("utf8")));
    this.child.stderr.on("data", () => {
      // crispasr logs go to stderr; ignore unless we later need diagnostics.
    });
    this.child.on("error", (err) => this.events.onFatal(`crispasr: ${err.message}`));
    this.child.on("close", (code) => {
      this.exitCode = code;
      if (this.closedResolve) this.closedResolve();
    });
  }

  private parse(text: string) {
    this.lineBuf += text;
    let idx: number;
    while ((idx = this.lineBuf.indexOf("\n")) >= 0) {
      const line = this.lineBuf.slice(0, idx);
      this.lineBuf = this.lineBuf.slice(idx + 1);
      if (!line.trim()) continue;
      this.handleJson(line);
    }
  }

  private handleJson(line: string) {
    let ev: {
      type: string;
      text?: string;
    };
    try {
      ev = JSON.parse(line);
    } catch {
      return; // ignore stray non-JSON noise
    }
    if (ev.type === "partial") {
      const t = cleanTranscript(ev.text ?? "");
      if (t) this.events.onPartial(t);
    } else if (ev.type === "final") {
      const t = cleanTranscript(ev.text ?? "");
      if (t) this.events.onFinal(t);
    }
    // "silence" and others are metadata only — we ignore them.
  }

  /** The writable stdin the recorder's PCM stream is piped into. */
  get streamStdin(): Writable {
    return this.child!.stdin;
  }

  /** Push captured PCM into the transcriber's stdin. */
  write(pcm: Buffer) {
    if (this.child?.stdin.writable) this.child.stdin.write(pcm);
  }

  /**
   * End the audio stream. crispasr finalizes the in-flight utterance (via a
   * final event) and exits. Resolves once the process has fully closed.
   */
  async endAndWait(): Promise<number | null> {
    try {
      this.child?.stdin.end();
    } catch {
      // already closed
    }
    await this.closed;
    return this.exitCode;
  }

  /** Hard-kill mid-capture (cancel path) — discard the in-flight utterance. */
  killHard() {
    this.child?.kill();
  }
}

// ---------------------------------------------------------------------------
// Model download (Hugging Face resolve URL, follows redirects) with
// byte-level progress reporting.
// ---------------------------------------------------------------------------

function downloadModel(
  tier: ModelTier,
  settings: SpeechSettings,
  onProgress: (received: number, total: number) => void,
): Promise<string> {
  const info = MODEL_TIERS[tier];
  const url = `https://huggingface.co/${info.repo}/resolve/main/${info.file}?download=true`;
  const dest = join(settings.modelsDir, info.file);
  mkdirSync(settings.modelsDir, { recursive: true });

  return new Promise((resolve, reject) => {
    const fetchUrl = (u: string, redirects: number) => {
      if (redirects > 5) return reject(new Error("Too many redirects"));
      https
        .get(u, (res) => {
          const status = res.statusCode ?? 0;
          if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
            res.resume();
            fetchUrl(res.headers.location, redirects + 1);
            return;
          }
          if (status !== 200) {
            reject(new Error(`Download failed: HTTP ${status}`));
            return;
          }
          const total = Number(res.headers["content-length"] ?? 0);
          let received = 0;
          const file = createWriteStream(dest);
          res.on("data", (chunk: Buffer) => {
            received += chunk.length;
            if (total) onProgress(received, total);
          });
          res.pipe(file);
          file.on("finish", () =>
            file.close(() => {
              onProgress(total || received, total || 0);
              resolve(dest);
            }),
          );
          file.on("error", reject);
        })
        .on("error", reject);
    };
    fetchUrl(url, 0);
  });
}

/** Download a tier (if missing) with live progress delivered via `report`. */
async function ensureModel(
  tier: ModelTier,
  settings: SpeechSettings,
  report: (line: string) => void,
): Promise<string> {
  const info = MODEL_TIERS[tier];
  const dest = join(settings.modelsDir, info.file);
  if (existsSync(dest)) return dest;

  let last = 0;
  let lastT = 0;
  let speed = 0;
  let finalBytes = 0;
  report(`preparing download of ${info.label}…`);
  const downloadedTo = await downloadModel(tier, settings, (rcvd, total) => {
    finalBytes = rcvd;
    const now = Date.now();
    if (lastT) {
      const dt = (now - lastT) / 1000;
      if (dt > 0) speed = (rcvd - last) / dt;
    }
    last = rcvd;
    lastT = now;
    const pct = total ? (rcvd / total) * 100 : 100;
    report(renderDownloadLine(info.label, rcvd, total, pct, speed));
  });
  report(`ready: ${info.label} (${formatBytes(finalBytes)})`);
  return downloadedTo;
}

// ---------------------------------------------------------------------------
// Command handling
// ---------------------------------------------------------------------------

const SUBCOMMANDS = [
  "status",
  "model",
  "download",
  "stop",
  "keybind",
  "cancel-keybind",
  "language",
  "insert",
  "recorder",
  "mic",
  "mics",
  "finalize",
  "step",
  "path",
];

interface StreamActions {
  stop: () => Promise<void>;
  cancel: () => void;
}

async function handleCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  getSettings: () => SpeechSettings,
  setSettings: (s: SpeechSettings) => void,
  actions: StreamActions,
  argsRaw: string,
) {
  const [sub, ...rest] = argsRaw.trim().split(/\s+/).filter(Boolean);
  const arg = rest.join(" ");
  const settings = getSettings();

  switch (sub) {
    case undefined:
    case "status": {
      const tier = MODEL_TIERS[settings.modelTier];
      const have = existsSync(join(settings.modelsDir, tier.file))
        ? "downloaded"
        : "NOT downloaded";
      ctx.ui.notify(
        `${tier.label} (${settings.modelTier}, ${have}) · backend=${tier.backend} · ` +
          `keybind=${settings.keybind} · cancel=${settings.cancelKeybind} · ` +
          `lang=${settings.language} · insert=${settings.insertMode} · recorder=${settings.recorder} · ` +
          `mic=${settings.mic || "default"} · finalize=${settings.finalizeOnPauseMs}ms · step=${settings.streamStepMs}ms`,
        "info",
      );
      break;
    }
    case "model": {
      if (!arg) {
        const lines = (Object.keys(MODEL_TIERS) as ModelTier[])
          .map((t) => {
            const info = MODEL_TIERS[t];
            const mark = t === settings.modelTier ? "*" : " ";
            return `${mark} ${t}: ${info.label} (${info.approxSize})`;
          })
          .join("\n");
        ctx.ui.notify(`Model tiers:\n${lines}`, "info");
        break;
      }
      if (!(arg in MODEL_TIERS)) {
        ctx.ui.notify(`Unknown tier "${arg}" — use big, mid, or tiny.`, "error");
        break;
      }
      setSettings(saveSettings({ modelTier: arg as ModelTier }));
      ctx.ui.notify(`Model tier set to ${arg}. Run /speech download ${arg} if needed.`, "info");
      break;
    }
    case "download": {
      const tier = (arg || settings.modelTier) as ModelTier;
      if (!(tier in MODEL_TIERS)) {
        ctx.ui.notify(`Unknown tier "${arg}".`, "error");
        break;
      }
      ctx.ui.setStatus(STATUS_KEY, `Downloading ${MODEL_TIERS[tier].label}…`);
      try {
        const dest = await ensureModel(tier, settings, (line) => {
          ctx.ui.setStatus(STATUS_KEY, line);
          if (widgetCtxRef) widgetCtxRef.ui.setWidget(WIDGET_KEY, [line]);
        });
        ctx.ui.setStatus(STATUS_KEY, undefined);
        ctx.ui.notify(`Downloaded to ${dest}`, "info");
      } catch (err) {
        ctx.ui.setStatus(STATUS_KEY, undefined);
        ctx.ui.notify(`Download failed: ${(err as Error).message}`, "error");
      }
      break;
    }
    case "stop": {
      await actions.stop();
      break;
    }
    case "keybind": {
      if (!arg) {
        ctx.ui.notify(`Current keybind: ${settings.keybind}`, "info");
        break;
      }
      setSettings(saveSettings({ keybind: arg }));
      ctx.ui.notify(`Keybind set to ${arg}. Run /reload for it to take effect.`, "info");
      break;
    }
    case "cancel-keybind": {
      if (!arg) {
        ctx.ui.notify(`Current cancel keybind: ${settings.cancelKeybind}`, "info");
        break;
      }
      setSettings(saveSettings({ cancelKeybind: arg }));
      ctx.ui.notify(`Cancel keybind set to ${arg}. Run /reload for it to take effect.`, "info");
      break;
    }
    case "language": {
      if (!arg) {
        ctx.ui.notify(`Current language: ${settings.language}`, "info");
        break;
      }
      setSettings(saveSettings({ language: arg }));
      ctx.ui.notify(`Language set to ${arg}.`, "info");
      break;
    }
    case "insert": {
      if (arg !== "editor" && arg !== "send") {
        ctx.ui.notify(`Current insert mode: ${settings.insertMode} (use "editor" or "send")`, "info");
        break;
      }
      setSettings(saveSettings({ insertMode: arg }));
      ctx.ui.notify(`Insert mode set to ${arg}. Finals deliver live as you pause.`, "info");
      break;
    }
    case "recorder": {
      const valid: RecorderChoice[] = ["auto", "pw-record", "sox", "ffmpeg", "arecord"];
      if (!valid.includes(arg as RecorderChoice)) {
        ctx.ui.notify(`Current recorder: ${settings.recorder} (use ${valid.join("|")})`, "info");
        break;
      }
      setSettings(saveSettings({ recorder: arg as RecorderChoice }));
      ctx.ui.notify(`Recorder preference set to ${arg}.`, "info");
      break;
    }
    case "mic": {
      if (!arg) {
        ctx.ui.notify(
          `Current input device: ${settings.mic || "system default"}. ` +
            `Run /speech mics to list available devices; set one with /speech mic <name> ` +
            `(or /speech mic "" for the default).`,
          "info",
        );
        break;
      }
      // Cache the current value so /speech mic autocompletion can stay useful
      // even before the first /speech mics (we may have a value already set).
      if (!detectedDevices.length && arg) {
        detectedDevices = [{ label: arg, value: arg }];
      }
      setSettings(saveSettings({ mic: arg }));
      ctx.ui.notify(`Input device set to "${arg}". Run /reload for it to take effect.`, "info");
      break;
    }
    case "mics": {
      ctx.ui.notify("Probing audio inputs…", "info");
      const devices = await detectInputDevices(pi);
      if (!devices) {
        ctx.ui.notify(
          "Could not enumerate input devices. Check `pw-dump` (PipeWire), " +
            "`pactl list sources` (PulseAudio), `arecord -l` (ALSA) on Linux, " +
            "or `ffmpeg -sources dshow` (Windows) / `ffmpeg -f avfoundation " +
            "-list_devices true -i \"\"` (macOS).",
          "warning",
        );
        break;
      }
      detectedDevices = devices;
      const lines = devices.map((d, i) => `${i + 1}. ${d.value}  —  ${d.label}`).join("\n");
      ctx.ui.notify(`Available inputs:\n${lines}\n\nSet one with /speech mic <value>.`, "info");
      break;
    }
    case "finalize": {
      if (!arg) {
        ctx.ui.notify(
          `Current finalize-on-pause: ${settings.finalizeOnPauseMs}ms (e.g. 900 finalizes ~0.9s after you stop speaking)`,
          "info",
        );
        break;
      }
      const ms = Number(arg);
      if (!isFinite(ms) || ms < 0) {
        ctx.ui.notify(`"${arg}" isn't a valid millisecond value.`, "error");
        break;
      }
      setSettings(saveSettings({ finalizeOnPauseMs: ms }));
      ctx.ui.notify(`Finalize-on-pause set to ${ms}ms (next recording starts with it).`, "info");
      break;
    }
    case "step": {
      if (!arg) {
        ctx.ui.notify(`Current streaming step: ${settings.streamStepMs}ms per partial decode`, "info");
        break;
      }
      const ms = Number(arg);
      if (!isFinite(ms) || ms < 1) {
        ctx.ui.notify(`"${arg}" isn't a valid millisecond value.`, "error");
        break;
      }
      setSettings(saveSettings({ streamStepMs: ms }));
      ctx.ui.notify(`Streaming step set to ${ms}ms (next recording starts with it).`, "info");
      break;
    }
    case "path": {
      const tier = MODEL_TIERS[settings.modelTier];
      ctx.ui.notify(join(settings.modelsDir, tier.file), "info");
      break;
    }
    default:
      ctx.ui.notify(`Unknown subcommand "${sub}". Try: ${SUBCOMMANDS.join(", ")}`, "warning");
  }
}

// Module-level widget context so /speech download can render into it even
// outside the session. Mutated by the entry point.
let widgetCtxRef: ExtensionContext | null = null;

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  let settings = loadSettings();
  let recorder: RecordingSession | null = null;
  let transcriber: StreamingTranscriber | null = null;
  let widgetCtx: ExtensionContext | null = null;
  let partialText = "";

  const setWidgetLines = (lines: string[]) => widgetCtx?.ui.setWidget(WIDGET_KEY, lines);
  const showIdle = () => {
    partialText = "";
    setWidgetLines([idleLine(settings)]);
  };

  /** Render the live widget: meter line + in-progress partial transcript. */
  const renderLive = (meterLine: string) => {
    const lines = [meterLine];
    if (partialText) lines.push(`  ▸ ${partialText}`);
    setWidgetLines(lines);
  };

  // Deliver a finalized utterance per the insert-mode setting.
  const deliverFinal = (text: string) => {
    if (widgetCtx) {
      if (settings.insertMode === "send") {
        pi.sendUserMessage(text);
      } else {
        widgetCtx.ui.pasteToEditor(text);
      }
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    widgetCtx = ctx;
    widgetCtxRef = ctx;
    showIdle();
  });

  pi.on("session_shutdown", async () => {
    cancelRecording();
    widgetCtxRef = null;
  });

  async function startRecording(ctx: ExtensionContext) {
    widgetCtx = ctx;
    widgetCtxRef = ctx;
    if (recorder?.active) return;

    // Resolve the recorder up front so a missing tool is caught early.
    const spec = await resolveRecorder(pi, settings);
    if (!spec) {
      ctx.ui.notify(
        "No microphone recorder found. Install pw-record (PipeWire), sox (recommended), ffmpeg, or arecord.",
        "error",
      );
      return;
    }

    // Make sure the model is present — auto-download (with live progress)
    // if it isn't, so the live pipeline never fails halfway in.
    ctx.ui.setStatus(STATUS_KEY, `Checking model ${MODEL_TIERS[settings.modelTier].label}…`);
    let modelPath: string;
    try {
      modelPath = await ensureModel(settings.modelTier, settings, (line) => {
        ctx.ui.setStatus(STATUS_KEY, line);
        setWidgetLines([line]);
      });
    } catch (err) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      showIdle();
      ctx.ui.notify(`Model unavailable: ${(err as Error).message}`, "error");
      return;
    }
    ctx.ui.setStatus(STATUS_KEY, undefined);

    // Spawn the streaming transcriber; pipe mic PCM straight into it.
    const tierInfo = MODEL_TIERS[settings.modelTier];
    const tr = new StreamingTranscriber(pi, settings, modelPath, tierInfo, {
      onPartial: (text) => {
        partialText = text;
        renderLive(renderMeterLine([], 0, "recording"));
      },
      onFinal: (text) => {
        partialText = "";
        renderLive(renderMeterLine([], 0, "recording"));
        deliverFinal(text);
      },
      onFatal: (msg) => {
        ctx.ui.notify(`Live transcription failed: ${msg}`, "error");
        teardownTranscriber();
      },
    });

    const rec = new RecordingSession(spec, (meterLine) => {
      renderLive(meterLine);
    });
    recorder = rec;
    transcriber = tr;
    rec.start();
    rec.pipeTo(tr.streamStdin);
    setWidgetLines([renderMeterLine([], 0, "recording"), `  ▸ warming up…`]);
    partialText = "";
    // Kick the meter once playback of the first frame starts.
    setTimeout(() => renderLive(renderMeterLine([], 0, "recording")), METER_TICK_MS);
  }

  function teardownTranscriber() {
    if (transcriber) {
      const t = transcriber;
      transcriber = null;
      try {
        t.killHard();
      } catch {
        /* ignore */
      }
    }
  }

  /** Stop capture, finalize the in-flight utterance, and return to idle. */
  async function stopAndTranscribe(ctx: ExtensionContext) {
    widgetCtx = ctx;
    widgetCtxRef = ctx;
    if (!recorder?.active && !transcriber) return;

    partialText = "";
    setWidgetLines([renderMeterLine([], 0, "transcribing")]);

    const rec = recorder;
    const tr = transcriber;
    recorder = null;
    transcriber = null;

    // 1) Stop the mic and let its buffered PCM drain into the transcriber.
    if (rec) await rec.stopAndFlush();
    // 2) Closing transcriber stdin makes crispasr finalize any open utterance
    //    (delivered via onFinal) and then exit cleanly.
    if (tr) await tr.endAndWait();

    // Let any last final event's UI flush.
    await new Promise((r) => setTimeout(r, 60));
    showIdle();
  }

  function cancelRecording(ctx?: ExtensionContext) {
    if (ctx) {
      widgetCtx = ctx;
      widgetCtxRef = ctx;
    }
    if (recorder?.active) {
      recorder.cancel();
      recorder = null;
    }
    teardownTranscriber();
    showIdle();
  }

  // Keybinds are user-configurable strings loaded from settings.json, so
  // they aren't literal types the compiler can check — validate the format
  // in `/speech keybind` (see keybindings.md: modifier+key) and cast here.
  pi.registerShortcut(settings.keybind as KeyId, {
    description: "Toggle live speech-to-text recording",
    handler: async (ctx) => {
      if (recorder?.active) {
        await stopAndTranscribe(ctx);
      } else {
        await startRecording(ctx);
      }
    },
  });

  pi.registerShortcut(settings.cancelKeybind as KeyId, {
    description: "Cancel an in-progress speech recording",
    handler: async (ctx) => cancelRecording(ctx),
  });

  pi.registerCommand("speech", {
    description: "Configure and control live speech-to-text",
    getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
      // /speech mic <name> — offer the devices detected by /speech mics.
      const micMatch = prefix.match(/^mic\s+(.*)$/);
      if (micMatch) {
        const rest = micMatch[1];
        const devices = detectedDevices
          .filter((d) => !rest || d.value.startsWith(rest) || d.label.startsWith(rest))
          .map((d) => ({ value: `mic ${d.value}`, label: `mic ${d.value} — ${d.label}` }));
        return devices.length ? devices : null;
      }
      const items = SUBCOMMANDS.map((s) => ({ value: s, label: s }));
      const filtered = items.filter((i) => i.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) =>
      handleCommand(
        pi,
        ctx,
        () => settings,
        (next) => {
          settings = next;
        },
        {
          stop: () => stopAndTranscribe(ctx),
          cancel: () => cancelRecording(ctx),
        },
        args,
      ),
  });
}