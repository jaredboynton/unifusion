#!/usr/bin/env node
// compact-full-transcript.mjs — summarize a session transcript into a schema-constrained
// structured brief. Vendored from patchpress for the Unifusion skill's session-context step.
//
// Usage:
//   node compact-full-transcript.mjs --provider gemini --transcript <path> --out-dir <dir> [--no-live-output]
//   node compact-full-transcript.mjs --provider gemini --input <transcript.jsonl> --out-dir <dir>
//
// Transcript source (one of):
//   --input <path>           explicit transcript file (highest precedence)
//   --transcript <path>      explicit transcript path; UNIFUSION_TRANSCRIPT is its env equivalent
//   --session current|<id>   Claude Code: locate via CLAUDE_CODE_SESSION_ID + the projects dir; exits 3 if none
//
// See AGENTS.md for how summarize_session.sh wires this into the Unifusion panel.
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { arch, homedir, platform, release } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  evaluateHandoffDensity,
  DEFAULT_DENSITY_THRESHOLDS,
  buildLiteralReaskFeedback,
  buildTruncationReaskFeedback,
} from "./handoff-density.mjs";
import { buildPromptAdaptations, modelTraits } from "./prompt-adaptation.mjs";
import { rendererTranscriptGuide } from "./renderer-prompt-guides.mjs";
import {
  compactFormattedEdit,
  extractEditCapsules,
  formatToolResult,
  formatToolResultContent,
  formatToolUse,
  isFormattedEditText,
} from "./tool-use-format.mjs";

// Load .env relative to the script directory
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "../.env");
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, "utf8");
  for (const line of envContent.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.substring(0, eqIdx).trim();
    let val = trimmed.substring(eqIdx + 1).trim();
    // Strip quotes
    if ((val.startsWith("'") && val.endsWith("'")) || (val.startsWith('"') && val.endsWith('"'))) {
      val = val.substring(1, val.length - 1);
    }
    // Simple interpolation for self-references
    if (val.startsWith("$")) {
      const refKey = val.slice(1);
      if (process.env[refKey]) {
        val = process.env[refKey];
      }
    }
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}

function argValue(name, fallback = undefined) {
  const idx = process.argv.indexOf(name);
  return idx === -1 ? fallback : process.argv[idx + 1];
}

// Real-tokenizer count for the codex default-model switch. Loads js-tiktoken
// lazily (only codex default runs reach here) and memoizes the encoder. gpt-5.x
// is not in js-tiktoken's model map, so encodingForModel falls back to the
// o200k_base encoding it shares. Any tokenizer failure degrades to the char/4
// estimate with a stderr warning rather than failing the compaction.
let _compactEncoder;
async function countRenderedTokens(text, model) {
  try {
    if (!_compactEncoder) {
      const tk = await import("js-tiktoken");
      try {
        _compactEncoder = tk.encodingForModel(model);
      } catch {
        _compactEncoder = tk.getEncoding("o200k_base");
      }
    }
    return _compactEncoder.encode(text).length;
  } catch (error) {
    process.stderr.write(
      "[codex model-switch] tokenizer unavailable, using char/4 estimate: " +
        error.message +
        "\n"
    );
    return Math.ceil(text.length / 4);
  }
}

const PROVIDER_REGISTRY = {
  codex:  { family: "codex",  defaultModel: () => process.env.CODEX_COMPACT_MODEL || "gpt-5.4", resolveModel: (renderedTokens) => renderedTokens < CODEX_MODEL_TOKEN_THRESHOLD ? "gpt-5.4-mini" : "gpt-5.4" },
  gemini: { family: "gemini", resolveKey: () => process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || "", endpoint: () => (process.env.GEMINI_API_BASE_URL || "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "") + "/models/" + encodeURIComponent(MODEL) + ":streamGenerateContent?alt=sse", defaultModel: () => process.env.GEMINI_COMPACT_MODEL || "gemini-3.5-flash", missingKeyMsg: "Missing GEMINI_API_KEY or GOOGLE_API_KEY for --provider gemini" },
  xai:    { family: "chat",   resolveKey: () => process.env.XAI_API_KEY || "", endpoint: () => (process.env.XAI_API_BASE_URL || "https://api.x.ai/v1").replace(/\/$/, "") + "/chat/completions", defaultModel: () => process.env.XAI_COMPACT_MODEL || "grok-4.20-0309-non-reasoning", missingKeyMsg: "Missing XAI_API_KEY for --provider xai" },
  mantle: { family: "chat",   resolveKey: () => process.env.MANTLE_API_KEY || process.env.BEDROCK_MANTLE_API_KEY || process.env.AWS_BEARER_TOKEN_BEDROCK || "", endpoint: () => process.env.MANTLE_CHAT_COMPLETIONS_URL || "https://bedrock-mantle.us-west-2.api.aws/openai/v1/chat/completions", defaultModel: () => process.env.MANTLE_COMPACT_MODEL || "xai.grok-4.3", missingKeyMsg: "Missing MANTLE_API_KEY, BEDROCK_MANTLE_API_KEY, or AWS_BEARER_TOKEN_BEDROCK for --provider mantle" },
};

function normalizeProvider(value) {
  const provider = String(value || "codex").toLowerCase();
  if (Object.prototype.hasOwnProperty.call(PROVIDER_REGISTRY, provider)) {
    return provider;
  }
  throw new Error("Unsupported provider: " + value + " (expected " + Object.keys(PROVIDER_REGISTRY).join(", ") + ")");
}

const PROVIDER = normalizeProvider(
  argValue("--provider", process.env.COMPACT_PROVIDER || process.env.COMPACT_MODEL_PROVIDER || "codex")
);
const CODEX_RESPONSES_URL =
  process.env.CODEX_RESPONSES_URL || "https://chatgpt.com/backend-api/codex/responses";
const AUTH_PATH = process.env.CODEX_AUTH_JSON || join(homedir(), ".codex", "auth.json");
const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), ".codex");
const CODEX_INSTALLATION_ID_PATH =
  process.env.CODEX_INSTALLATION_ID_PATH || join(CODEX_HOME, "installation_id");
const CODEX_ORIGINATOR = process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE || "codex_cli_rs";
const CODEX_CLIENT_VERSION = process.env.CODEX_CLIENT_VERSION || resolveCodexClientVersion();
const CODEX_USER_AGENT = process.env.CODEX_USER_AGENT || buildCodexUserAgent();

function resolveTranscriptFromSession(sessionArg) {
  const cfg = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const projroot = join(cfg, "projects");
  const sid =
    sessionArg && sessionArg !== "current" ? sessionArg : process.env.CLAUDE_CODE_SESSION_ID || "";
  if (sid) {
    try {
      for (const ent of readdirSync(projroot, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const cand = join(projroot, ent.name, sid + ".jsonl");
        if (existsSync(cand)) return cand;
      }
    } catch {}
  }
  return "";
}

// Transcript source precedence: --input > --transcript / UNIFUSION_TRANSCRIPT > --session (Claude only).
const sessionArg = argValue("--session", "");
let resolvedInput =
  argValue("--input", "") || argValue("--transcript", "") || process.env.UNIFUSION_TRANSCRIPT || "";
if (!resolvedInput && sessionArg) {
  resolvedInput = resolveTranscriptFromSession(sessionArg);
}
if (!resolvedInput) {
  console.error(
    "[compact] no transcript source: pass --input <path>, --transcript <path>, UNIFUSION_TRANSCRIPT=<path>, " +
      "or --session current (Claude Code; CLAUDE_CODE_SESSION_ID=" +
      (process.env.CLAUDE_CODE_SESSION_ID || "unset") +
      ")"
  );
  process.exit(3);
}
const inputPath = resolve(resolvedInput);
let MODEL =
  argValue("--model") ||
  process.env.COMPACT_MODEL ||
  PROVIDER_REGISTRY[PROVIDER].defaultModel();
// When codex runs on its default model (no explicit override), MODEL is
// re-resolved after the transcript is rendered: gpt-5.5 when the rendered
// transcript fits its 272k-token input window, else gpt-5.4. See the
// post-render block in main() and PROVIDER_REGISTRY.codex.resolveModel.
const MODEL_EXPLICIT = Boolean(
  argValue("--model") || process.env.COMPACT_MODEL || process.env.CODEX_COMPACT_MODEL
);
const CODEX_MODEL_TOKEN_THRESHOLD = Number.parseInt(
  process.env.CODEX_MODEL_TOKEN_THRESHOLD || "272000",
  10
);
const SERVICE_TIER = process.env.CODEX_COMPACT_SERVICE_TIER || "priority";
const REASONING_EFFORT = process.env.CODEX_COMPACT_REASONING_EFFORT || "low";
// Flash-Lite defaults to minimal thinking. With the schema-shape duplication removed
// from the prompt, the continuation anchor (current work + next step) always rendered
// into the handoff, and the capsule floor at 30, minimal thinking + reask-until-pass
// holds 100 deterministic and 10/10 judge at ~4-6s on onto -- an ~8x speedup over the
// low-thinking lane (~31s) with no semantic-quality loss. minimal collapses below the
// 50-capsule floor (~25-32 caps), which is why the floor is 30, not 50; low thinking
// remains available (GEMINI_COMPACT_THINKING_LEVEL=low) when maximum evidence density
// (57+ caps, deterministic 100 at the 50 floor) is wanted.
const GEMINI_THINKING_LEVEL =
  process.env.GEMINI_COMPACT_THINKING_LEVEL ||
  (MODEL.includes("flash-lite") ? "minimal" : "none");
const GEMINI_MAX_OUTPUT_TOKENS = Number.parseInt(
  process.env.GEMINI_COMPACT_MAX_OUTPUT_TOKENS || "65536",
  10
);

function intArg(name, fallback) {
  const raw = argValue(name);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("Expected " + name + " to be a non-negative integer");
  }
  return parsed;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}

function resolveCodexInstallationId() {
  try {
    const existing = readFileSync(CODEX_INSTALLATION_ID_PATH, "utf8").trim();
    if (isUuid(existing)) return existing.toLowerCase();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const installationId = randomUUID();
  mkdirSync(dirname(CODEX_INSTALLATION_ID_PATH), { recursive: true });
  writeFileSync(CODEX_INSTALLATION_ID_PATH, installationId, { mode: 0o644 });
  return installationId;
}

function commandOutput(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function parseVersion(value) {
  return String(value || "").match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0] || "";
}

function resolveCodexClientVersion() {
  const cliVersion = parseVersion(commandOutput("codex", ["--version"]));
  if (cliVersion) return cliVersion;
  try {
    const cached = JSON.parse(readFileSync(join(CODEX_HOME, "version.json"), "utf8"));
    const cachedVersion = parseVersion(cached.latest_version);
    if (cachedVersion) return cachedVersion;
  } catch {
    // Fall through to a syntactically valid development version.
  }
  return "0.0.0";
}

function codexArchitecture() {
  const value = arch();
  if (value === "x64") return "x86_64";
  return value || "unknown";
}

function codexOsDescription() {
  if (platform() === "darwin") {
    const macVersion = commandOutput("sw_vers", ["-productVersion"]);
    return "Mac OS " + (macVersion || release());
  }
  return platform() + " " + release();
}

function buildCodexUserAgent() {
  const reqwestVersion = process.env.CODEX_REQWEST_VERSION || "0.12.28";
  return (
    CODEX_ORIGINATOR +
    "/" +
    CODEX_CLIENT_VERSION +
    " (" +
    codexOsDescription() +
    "; " +
    codexArchitecture() +
    ") reqwest/" +
    reqwestVersion
  );
}

const preserveTailCount = intArg("--preserve-tail", 16);
const dryRun = process.argv.includes("--dry-run");
const liveOutput = !process.argv.includes("--no-live-output");
const dumpPromptPath = argValue("--dump-prompt", "");
const rendererStatsReportPath = argValue("--renderer-stats-report", "");
const rendererStatsRenderers = argValue("--renderer-stats-renderers", "stripped,sentinel,jsonl")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
for (const renderer of rendererStatsRenderers) {
  if (renderer !== "stripped" && renderer !== "sentinel" && renderer !== "jsonl" && renderer !== "onto") {
    throw new Error("Expected --renderer-stats-renderers entries to be stripped, sentinel, jsonl, or onto");
  }
}
const temperatureRaw = argValue("--temperature", process.env.COMPACT_TEMPERATURE || "");
let TEMPERATURE = temperatureRaw === "" ? null : Number.parseFloat(temperatureRaw);
if (temperatureRaw !== "" && !Number.isFinite(TEMPERATURE)) {
  throw new Error("Expected --temperature to be a finite number");
}
// Default temperature 0.4 for Grok 4.3 (mantle), Grok 4.20 (xai), and Gemini
// Flash-Lite when not set explicitly.
if (
  TEMPERATURE === null &&
  (MODEL.includes("grok-4.3") || MODEL.includes("grok-4.20") || MODEL.includes("flash-lite"))
) {
  TEMPERATURE = 0.4;
}
// Reasoning effort for the OpenAI-compatible chat-completions providers (xai/mantle).
// Empty means omit the field and use the server default. Codex uses its own reasoning plumbing.
const CHAT_REASONING_EFFORT = argValue("--reasoning-effort", process.env.COMPACT_REASONING_EFFORT || "");
// Density-gated validate-and-reask loop (docs/prompt-adaptation/design.md). Off by
// default (--max-reasks 0); when >0, a structurally-valid but thin handoff is
// re-requested with corrective feedback up to N times, keeping the densest attempt.
// --reask-until-pass loops until the density gate clears (cap: --max-reasks, default 10).
// gemini flash-lite auto-enables until-pass on every renderer; opt out with
// --no-reask-until-pass or COMPACT_REASK_UNTIL_PASS=0.
const REASK_UNTIL_PASS_EXPLICIT =
  process.argv.includes("--reask-until-pass") || process.env.COMPACT_REASK_UNTIL_PASS === "1";
const REASK_UNTIL_PASS_DISABLED =
  process.argv.includes("--no-reask-until-pass") || process.env.COMPACT_REASK_UNTIL_PASS === "0";
const FLASH_LITE_MODEL = MODEL.includes("flash-lite");
const REASK_UNTIL_PASS =
  !REASK_UNTIL_PASS_DISABLED && (REASK_UNTIL_PASS_EXPLICIT || FLASH_LITE_MODEL);
const REASK_UNTIL_PASS_SOURCE = REASK_UNTIL_PASS
  ? REASK_UNTIL_PASS_EXPLICIT
    ? process.argv.includes("--reask-until-pass")
      ? "flag"
      : "env"
    : FLASH_LITE_MODEL
      ? "flash-lite-default"
      : null
  : null;
const MAX_REASKS = intArg(
  "--max-reasks",
  Number.parseInt(process.env.COMPACT_MAX_REASKS || (REASK_UNTIL_PASS ? "10" : "0"), 10) || 0,
);
// Dynamic per-provider/model prompt-mutation system (docs/prompt-adaptation/provider-prompting.md).
// Off by default; when on, model-specific completeness augmentations are appended to the prompt.
// Auto-enabled for non-codex models when --reask-until-pass is set (including flash-lite default).
const _promptTraits = modelTraits({ provider: PROVIDER, model: MODEL });
const ADAPT_PROMPT =
  process.argv.includes("--adapt-prompt") ||
  process.env.COMPACT_ADAPT_PROMPT === "1" ||
  (REASK_UNTIL_PASS && !_promptTraits.isStrong);
const DENSITY_THRESHOLDS = {
  minEvidenceCapsules: intArg("--min-evidence-capsules", DEFAULT_DENSITY_THRESHOLDS.minEvidenceCapsules),
  minCitedLines: intArg("--min-cited-lines", DEFAULT_DENSITY_THRESHOLDS.minCitedLines),
  minPromises: intArg("--min-promises", DEFAULT_DENSITY_THRESHOLDS.minPromises),
};
// Required-literal targeting for the reask loop. When --fixture (or COMPACT_FIXTURE)
// points at a scorer fixture JSON, its required_literals must all survive into the
// rehydrated handoff; an attempt that drops one is re-requested with the missing
// literals named, even if the density gate already passed. The scorer is the source
// of truth, so the loop reads the same list and checks the same rehydrated text.
// Benchmark-only knob: production never sets it, so requiredLiterals stays empty and
// the literal gate is inert.
const FIXTURE_PATH = argValue("--fixture", process.env.COMPACT_FIXTURE || "");
const customSummaryInstructions = argValue("--summary-instructions", "");
const compactAndPrompt = argValue("--compact-and", "");
const fromOutputPath = argValue("--from-output", "");
const userMessageCollapseAt = intArg("--user-message-collapse-at", 2400);
const userMessageHeadChars = intArg("--user-message-head-chars", 900);
const userMessageTailChars = intArg("--user-message-tail-chars", 900);
const handoffUserMessageLimit = intArg("--handoff-user-message-limit", 64);
const handoffUserMessageTokenBudget = intArg("--handoff-user-message-token-budget", 8000);
const handoffUserMessageLineLimit = intArg("--handoff-user-message-line-limit", 300);
const transcriptRenderer = argValue(
  "--transcript-renderer",
  process.env.COMPACT_TRANSCRIPT_RENDERER || "stripped"
);
if (transcriptRenderer !== "stripped" && transcriptRenderer !== "sentinel" && transcriptRenderer !== "jsonl" && transcriptRenderer !== "onto") {
  throw new Error("Expected --transcript-renderer to be stripped, sentinel, jsonl, or onto");
}
const toolOutputCompressAfter =
  argValue("--tool-output-compress-after") === undefined
    ? intArg("--sentinel-tool-output-keep-recent", 64)
    : intArg("--tool-output-compress-after", 64);
const toolOutputCompressMinChars =
  argValue("--tool-output-compress-min-chars") === undefined
    ? intArg("--sentinel-old-tool-output-collapse-at", 2400)
    : intArg("--tool-output-compress-min-chars", 2400);
const toolOutputCompressHeadChars =
  argValue("--tool-output-compress-head-chars") === undefined
    ? intArg("--sentinel-old-tool-output-head-chars", 900)
    : intArg("--tool-output-compress-head-chars", 900);
const toolOutputCompressTailChars =
  argValue("--tool-output-compress-tail-chars") === undefined
    ? intArg("--sentinel-old-tool-output-tail-chars", 500)
    : intArg("--tool-output-compress-tail-chars", 500);
// Old tool-output compression strategy. "headtail" keeps a fixed head+tail window
// (the original blind heuristic); "dspc" selects content by importance using the
// DSPC two-stage pipeline (arXiv:2509.13723): coarse TF-IDF sentence filtering,
// then a multi-signal score. The two model-derived signals in the paper
// (last-layer attention, cross-model loss) are realized as deterministic lexical
// proxies here because this renderer/compression path makes zero model calls;
// the positional Gaussian (eq. 9) is computed exactly. "mask" is full observation
// masking (arXiv:2508.21433): drop the old tool-output body entirely, keeping only
// a metadata placeholder (the body stays recoverable via the sha markers).
const toolOutputCompressStrategy = argValue(
  "--tool-output-compress-strategy",
  process.env.COMPACT_TOOL_OUTPUT_STRATEGY || "headtail"
);
if (!["headtail", "dspc", "mask"].includes(toolOutputCompressStrategy)) {
  throw new Error("Expected --tool-output-compress-strategy to be headtail, dspc, or mask");
}
const toolUseCompressAfter =
  argValue("--tool-use-compress-after") === undefined
    ? toolOutputCompressAfter
    : intArg("--tool-use-compress-after", toolOutputCompressAfter);
const toolUseCompressMinChars = intArg("--tool-use-compress-min-chars", 800);
const toolUseCompressHeadChars = intArg("--tool-use-compress-head-chars", 400);
const toolUseCompressTailChars = intArg("--tool-use-compress-tail-chars", 200);
const transcriptCwdPrefix = argValue(
  "--transcript-cwd-prefix",
  process.env.COMPACT_TRANSCRIPT_CWD_PREFIX || ""
);
function floatArg(name, fallback) {
  const raw = argValue(name);
  if (raw === undefined) return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error("Expected " + name + " to be a finite number");
  }
  return parsed;
}
// DSPC hyperparameters. Defaults follow the paper's best configuration
// (Stage-1 ratio rho=0.7; beta weights 0.6/0.3/0.1 for salience/informativeness/position).
const dspcStage1Ratio = floatArg("--dspc-stage1-ratio", 0.7);
const dspcBetaAttn = floatArg("--dspc-beta-attn", 0.6);
const dspcBetaLoss = floatArg("--dspc-beta-loss", 0.3);
const dspcBetaPos = floatArg("--dspc-beta-pos", 0.1);
const dspcPosLambda = floatArg("--dspc-pos-lambda", 1.0);
const dspcPosSigmaFrac = floatArg("--dspc-pos-sigma-frac", 0.25);
const startedAt = new Date();
const defaultOutDir = join(
  "runs",
  "compact-" + startedAt.toISOString().replace(/[:.]/g, "-")
);
const outDir = resolve(argValue("--out-dir", defaultOutDir));
const HANDOFF_USER_MESSAGE_LEDGER_VERSION = "1";
const HANDOFF_STATE_SCHEMA = "handoff-state.v1";
const HANDOFF_MANIFEST_SCHEMA = "handoff-manifest.v1";
const HANDOFF_POINTER_SCHEMA = "handoff-pointer.v1";
const LOCAL_VALIDATION_SCHEMA = "summary-local-validation.v1";
const COMPATIBILITY_ARRAY_KEYS = [
  "primary_request_and_intent",
  "key_technical_concepts",
  "files_and_code_sections",
  "errors_and_fixes",
  "problem_solving",
  "pending_tasks",
];

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function loadChatgptAuth() {
  const raw = await readFile(AUTH_PATH, "utf8");
  const auth = JSON.parse(raw);
  if (auth.auth_mode !== "chatgpt") {
    throw new Error("Expected ChatGPT auth in " + AUTH_PATH + "; got auth_mode=" + auth.auth_mode);
  }
  const tokens = auth.tokens;
  const accessToken = tokens?.access_token;
  const accountId = tokens?.account_id || tokens?.id_token?.chatgpt_account_id;
  if (!accessToken) throw new Error("Missing tokens.access_token in " + AUTH_PATH);
  if (!accountId) throw new Error("Missing ChatGPT account id in " + AUTH_PATH);
  return { accessToken, accountId };
}

function parseJsonl(raw) {
  const records = [];
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    try {
      records.push(JSON.parse(line));
    } catch (error) {
      throw new Error("Invalid JSONL at logical record " + (records.length + 1) + ": " + error.message);
    }
  }
  return records;
}

function logicalJsonlLines(raw) {
  return raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

function previewRecord(line) {
  try {
    const record = JSON.parse(line);
    const pieces = [];
    if (record.type) pieces.push("type=" + record.type);
    if (record.uuid) pieces.push("uuid=" + record.uuid);
    if (record.message?.role) pieces.push("role=" + record.message.role);
    const text =
      typeof record.content === "string"
        ? record.content
        : typeof record.message?.content === "string"
          ? record.message.content
          : Array.isArray(record.message?.content)
            ? record.message.content
                .map((part) => (typeof part?.text === "string" ? part.text : ""))
                .join(" ")
            : "";
    if (text) pieces.push("text=" + text.replace(/\s+/g, " ").slice(0, 160));
    return pieces.join(" | ");
  } catch {
    return line.replace(/\s+/g, " ").slice(0, 160);
  }
}

function toolFormatMeta(entry) {
  return {
    lineNumber: entry?.lineNumber ?? null,
    recordHash: entry?.hash ?? null,
    cwdPrefix: transcriptCwdPrefix || null,
  };
}

function renderPartForPrompt(part, meta = {}) {
  if (!part || typeof part !== "object") return "";
  if (part.type === "tool_use") return formatToolUse(part, meta);
  if (part.type === "tool_result") return formatToolResult(part, meta);
  if (typeof part.text === "string") return part.text;
  if (typeof part.content === "string") return part.content;
  return "";
}

// Codex rollout records nest text under .payload (response_item / event_msg), not the Claude
// shape. Extract user/assistant/tool text so a Codex transcript is both citable and renderable.
function codexPayloadText(record) {
  const p = record?.payload;
  if (!p || typeof p !== "object") return "";
  if (typeof p.message === "string" && p.message.length > 0) return p.message;
  if (typeof p.text === "string" && p.text.length > 0) return p.text;
  if (Array.isArray(p.content)) {
    const t = p.content.map((c) => (typeof c?.text === "string" ? c.text : "")).filter(Boolean).join("\n");
    if (t.length > 0) return t;
  }
  const ok = p.result?.Ok?.content;
  if (Array.isArray(ok)) {
    const t = ok
      .map((c) => (typeof c === "string" ? c : typeof c?.text === "string" ? c.text : ""))
      .filter(Boolean)
      .join("\n");
    if (t.length > 0) return t;
  }
  if (typeof p.output === "string" && p.output.length > 0) return p.output;
  return "";
}

// Devin CLI transcripts are ATIF JSON (one document with a steps[] array), not JSONL. Convert each
// step into a native Claude-shaped record so the citability, span, hash, and role machinery below all
// work unchanged. Returns null for non-ATIF input, so Claude/Codex JSONL falls through untouched.
function atifToClaudeJsonl(raw) {
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  const sv = typeof doc.schema_version === "string" ? doc.schema_version : "";
  if (!sv.toUpperCase().startsWith("ATIF") || !Array.isArray(doc.steps)) return null;
  const roleOf = { user: "user", human: "user", agent: "assistant", assistant: "assistant", model: "assistant", system: "system", tool: "tool" };
  const lines = [];
  for (const step of doc.steps) {
    if (!step || typeof step !== "object") continue;
    const role = roleOf[step.source] || "assistant";
    const content = [];
    if (typeof step.message === "string" && step.message.length > 0) {
      content.push({ type: "text", text: step.message });
    }
    if (Array.isArray(step.tool_calls)) {
      for (const tc of step.tool_calls) {
        content.push({ type: "tool_use", name: tc?.function_name || tc?.name || "tool", input: tc?.arguments ?? null });
      }
    }
    const results = step?.observation?.results;
    if (Array.isArray(results)) {
      for (const r of results) {
        const c = typeof r?.content === "string" ? r.content : r?.content != null ? JSON.stringify(r.content) : "";
        if (c.length > 0) content.push({ type: "tool_result", tool_use_id: r?.source_call_id || null, content: c });
      }
    }
    if (content.length === 0) continue;
    lines.push(JSON.stringify({ type: role, uuid: "atif-" + (step.step_id ?? lines.length), message: { role, content } }));
  }
  return lines.length > 0 ? lines.join("\n") + "\n" : null;
}

function recordTextForPrompt(record, entry = null) {
  const meta = toolFormatMeta(entry);
  const content = record?.message?.content ?? record?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const rendered = content.map((part) => renderPartForPrompt(part, meta)).filter(Boolean).join("\n\n");
    if (rendered.length > 0) return rendered;
  }
  if (typeof record?.lastPrompt === "string" && record.lastPrompt.length > 0) return record.lastPrompt;
  if (typeof record?.aiTitle === "string" && record.aiTitle.length > 0) return record.aiTitle;
  if (typeof record?.summary === "string" && record.summary.length > 0) return record.summary;
  const cx = codexPayloadText(record);
  if (cx) return cx;
  return "";
}

function isToolOutputRecord(record) {
  const content = record?.message?.content ?? record?.content;
  if (record?.toolUseResult || record?.sourceToolAssistantUUID) return true;
  if (!Array.isArray(content)) return false;
  return content.some((part) => part?.type === "tool_result" || part?.tool_use_id);
}

function isToolUseRecord(record) {
  const content = record?.message?.content;
  return Array.isArray(content) && content.some((part) => part?.type === "tool_use");
}

function compactOldToolUseBody(body, entry) {
  if (!isFormattedEditText(body)) return { body, compressed: false };
  return compactFormattedEdit(body, entry, {
    minChars: toolUseCompressMinChars,
    headChars: toolUseCompressHeadChars,
    tailChars: toolUseCompressTailChars,
  });
}

function escapeSentinelBody(text) {
  return String(text || "").replace(/^(@@(?:RECORD|END_RECORD)\b)/gm, " $1");
}

function compactOldToolOutputBody(body, entry) {
  const text = String(body || "");
  if (text.length <= toolOutputCompressMinChars) return { body: text, compressed: false };
  const head = text.slice(0, toolOutputCompressHeadChars).replace(/\n$/, "");
  const tail = text
    .slice(Math.max(text.length - toolOutputCompressTailChars, toolOutputCompressHeadChars))
    .replace(/^\n/, "")
    .replace(/\n$/, "");
  const omitted = Math.max(text.length - head.length - tail.length, 0);
  return {
    body: [
      head,
      "",
      "[tool output compressed: original_chars=" +
        text.length +
        " omitted_chars=" +
        omitted +
        " line=" +
        entry.lineNumber +
        " body_sha256=" +
        sha256Text(text) +
        " record_sha256=" +
        entry.hash +
        "]",
      "",
      tail,
    ].join("\n"),
    compressed: true,
    originalChars: text.length,
    omittedChars: omitted,
  };
}

function dspcSplitSentences(text) {
  const segments = [];
  for (const rawLine of String(text).split(/\n/)) {
    if (rawLine.trim() === "") continue;
    const parts = /[.!?]\s/.test(rawLine) ? rawLine.split(/(?<=[.!?])\s+/) : [rawLine];
    for (const part of parts) {
      if (part.trim() !== "") segments.push(part);
    }
  }
  return segments;
}

function dspcTokenize(text) {
  return String(text).toLowerCase().match(/[a-z0-9_]+/g) || [];
}

function dspcMax(values) {
  let max = 0;
  for (const value of values) if (value > max) max = value;
  return max;
}

// DSPC (arXiv:2509.13723) deterministic realization. Stage 1 is the paper's
// TF-IDF semantic-sentence filter (eq. 1-5). Stage 2 ranks survivors by a
// multi-signal score (eq. 10): attention contribution and cross-model loss are
// approximated by lexical TF-IDF salience and IDF informativeness (Rho-1
// intuition) because this path makes no model calls, while positional importance
// (eq. 9) is computed exactly. The exact body stays recoverable downstream via
// the body_sha256/record_sha256 in the marker, so the prompt-side loss is safe.
function compactOldToolOutputBodyDSPC(body, entry) {
  const text = String(body || "");
  if (text.length <= toolOutputCompressMinChars) return { body: text, compressed: false };
  const budget = Math.max(toolOutputCompressHeadChars + toolOutputCompressTailChars, 1);

  const segments = dspcSplitSentences(text);
  const N = segments.length;
  if (N <= 1) return compactOldToolOutputBody(body, entry);
  const segTokens = segments.map(dspcTokenize);

  const df = new Map();
  for (const toks of segTokens) {
    for (const term of new Set(toks)) df.set(term, (df.get(term) || 0) + 1);
  }
  // Plain inverse document frequency (paper eq. 1: TF * log(N/DF)). No smoothing:
  // a term in every segment scores 0 (uninformative), so repeated boilerplate is
  // down-weighted instead of dominating via raw term frequency.
  const idf = (term) => Math.log(N / (df.get(term) || 1));

  const globalTf = new Map();
  for (const toks of segTokens) {
    for (const term of toks) globalTf.set(term, (globalTf.get(term) || 0) + 1);
  }
  const globalScore = new Map();
  for (const [term, tf] of globalTf) globalScore.set(term, tf * idf(term));
  const queryTerms = new Set(
    [...globalScore.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, Math.min(12, globalScore.size))
      .map(([term]) => term)
  );

  const stage1Score = segTokens.map((toks) => {
    if (toks.length === 0) return 0;
    let score = 0;
    for (const term of toks) if (queryTerms.has(term)) score += idf(term);
    return score / Math.sqrt(toks.length);
  });
  const keepStage1 = Math.max(1, Math.floor(dspcStage1Ratio * N));
  const stage1Idx = segments
    .map((_, i) => i)
    .sort((a, b) => stage1Score[b] - stage1Score[a] || a - b)
    .slice(0, keepStage1);

  const sigma = Math.max(dspcPosSigmaFrac * N, 1);
  const rawAttn = [];
  const rawLoss = [];
  const rawPos = [];
  for (let i = 0; i < N; i += 1) {
    const toks = segTokens[i];
    const denom = toks.length || 1;
    let salience = 0;
    let informativeness = 0;
    for (const term of toks) {
      salience += globalScore.get(term) || 0;
      informativeness += idf(term);
    }
    rawAttn.push(salience / denom);
    rawLoss.push(informativeness / denom);
    rawPos.push(1 + dspcPosLambda * Math.exp(-(((i - N / 2) ** 2) / (2 * sigma * sigma))));
  }
  const normalize = (arr) => {
    const max = dspcMax(arr);
    return max > 0 ? arr.map((x) => x / max) : arr.map(() => 0);
  };
  const nAttn = normalize(rawAttn);
  const nLoss = normalize(rawLoss);
  const alpha = segments.map(
    (_, i) => dspcBetaAttn * nAttn[i] + dspcBetaLoss * nLoss[i] + dspcBetaPos * rawPos[i]
  );

  const ranked = stage1Idx.slice().sort((a, b) => alpha[b] - alpha[a] || a - b);
  const selected = new Set();
  let used = 0;
  for (const i of ranked) {
    const cost = segments[i].length + 1;
    if (selected.size > 0 && used + cost > budget) continue;
    selected.add(i);
    used += cost;
    if (used >= budget) break;
  }

  const keptOrdered = [...selected].sort((a, b) => a - b);
  const pieces = [];
  let prev = -1;
  for (const i of keptOrdered) {
    if (prev !== -1 && i > prev + 1) pieces.push("[...]");
    pieces.push(segments[i]);
    prev = i;
  }
  if (keptOrdered.length && keptOrdered[0] > 0) pieces.unshift("[...]");
  if (keptOrdered.length && keptOrdered[keptOrdered.length - 1] < N - 1) pieces.push("[...]");
  const kept = pieces.join("\n");
  const omitted = Math.max(text.length - kept.length, 0);
  const marker =
    "[tool output compressed: strategy=dspc original_chars=" +
    text.length +
    " omitted_chars=" +
    omitted +
    " line=" +
    entry.lineNumber +
    " body_sha256=" +
    sha256Text(text) +
    " record_sha256=" +
    entry.hash +
    " stage1_kept=" +
    keepStage1 +
    "/" +
    N +
    " stage2_kept=" +
    keptOrdered.length +
    "]";
  return {
    body: [marker, "", kept].join("\n"),
    compressed: true,
    originalChars: text.length,
    omittedChars: omitted,
  };
}

// Observation masking (JetBrains "The Complexity Trap", arXiv:2508.21433): drop the
// entire old tool-output body, keeping only a metadata placeholder. The exact body
// stays recoverable downstream via body_sha256/record_sha256, same as headtail/dspc.
function maskOldToolOutputBody(body, entry) {
  const text = String(body || "");
  if (text.length <= toolOutputCompressMinChars) return { body: text, compressed: false };
  const lines = text.split("\n").length;
  const marker =
    "[tool output masked: strategy=mask original_chars=" +
    text.length +
    " original_lines=" +
    lines +
    " omitted_chars=" +
    text.length +
    " line=" +
    entry.lineNumber +
    " body_sha256=" +
    sha256Text(text) +
    " record_sha256=" +
    entry.hash +
    "]";
  return { body: marker, compressed: true, originalChars: text.length, omittedChars: text.length };
}

function compactToolOutputBody(body, entry) {
  if (toolOutputCompressStrategy === "mask") return maskOldToolOutputBody(body, entry);
  if (toolOutputCompressStrategy === "dspc") return compactOldToolOutputBodyDSPC(body, entry);
  return compactOldToolOutputBody(body, entry);
}

function escapeOntoBody(text) {
  return String(text || "").replace(/^(\d{6}\|)/gm, " $1");
}

function ontoMetaField(value) {
  return String(value == null ? "" : value).replace(/\s+/g, "_").replace(/\|/g, "/");
}

// ONTO-inspired schema-once row-major renderer (arXiv:2604.17512). Per-record
// metadata keys (line|type|role|ts|chars) are declared once in the @@ONTO header;
// each record is one pipe-delimited value row (empty fields render as ONTO null)
// followed by its free-text body. Row-major (not the paper's column-major field
// lines) preserves the per-record line anchor the scorer/rehydrator depend on.
// Drops per-record key= repetition used by sentinel and stripped. A record starts
// at ^\d{6}\|; body lines that would collide are space-escaped.
function renderOntoRecord(entry, context) {
  const linePadded = String(entry.lineNumber).padStart(6, "0");
  let record;
  try {
    record = JSON.parse(entry.raw);
  } catch {
    const body = escapeOntoBody(entry.raw);
    return linePadded + "|unparsed|||" + body.length + "\n" + body;
  }
  const type = ontoMetaField(record.type || "unknown");
  const role = record.message?.role ? ontoMetaField(record.message.role) : "";
  const ts = record.timestamp ? ontoMetaField(record.timestamp) : "";
  let body = recordTextForPrompt(record, entry).trim() || entry.preview || "[no textual content extracted]";
  const oldToolOutput =
    isToolOutputRecord(record) &&
    toolOutputCompressAfter > 0 &&
    entry.lineNumber <= context.recordCount - toolOutputCompressAfter;
  if (oldToolOutput) {
    const compacted = compactToolOutputBody(body, entry);
    if (compacted.compressed) {
      context.stats.compressedToolOutputRecords += 1;
      context.stats.originalToolOutputChars += compacted.originalChars;
      context.stats.omittedToolOutputChars += compacted.omittedChars;
    }
    body = compacted.body;
  }
  const oldToolUse =
    isToolUseRecord(record) &&
    toolUseCompressAfter > 0 &&
    entry.lineNumber <= context.recordCount - toolUseCompressAfter;
  if (oldToolUse) {
    const compacted = compactOldToolUseBody(body, entry);
    if (compacted.compressed) {
      context.stats.compressedToolUseRecords = (context.stats.compressedToolUseRecords || 0) + 1;
      context.stats.originalToolUseChars = (context.stats.originalToolUseChars || 0) + compacted.originalChars;
      context.stats.omittedToolUseChars = (context.stats.omittedToolUseChars || 0) + compacted.omittedChars;
    }
    body = compacted.body;
  }
  body = escapeOntoBody(body);
  if (oldToolOutput) context.stats.renderedToolOutputChars += body.length;
  return [linePadded, type, role, ts, String(body.length)].join("|") + "\n" + body;
}

function ontoHeader(recordCount) {
  return "@@ONTO Transcript[" + recordCount + "] fields=line|type|role|ts|chars";
}

function renderStrippedRecord(entry) {
  let record;
  try {
    record = JSON.parse(entry.raw);
  } catch {
    return (
      '<record line="' +
      String(entry.lineNumber).padStart(6, "0") +
      '" kind="unparsed">\n' +
      entry.raw +
      "\n</record>"
    );
  }
  const attrs = [
    'line="' + String(entry.lineNumber).padStart(6, "0") + '"',
    'type="' + String(record.type || "unknown").replace(/"/g, "'") + '"',
  ];
  if (record.message?.role) attrs.push('role="' + String(record.message.role).replace(/"/g, "'") + '"');
  if (record.timestamp) attrs.push('timestamp="' + String(record.timestamp).replace(/"/g, "'") + '"');
  const text = recordTextForPrompt(record, entry).trim();
  const body = text || entry.preview || "[no textual content extracted]";
  return "<record " + attrs.join(" ") + ">\n" + body + "\n</record>";
}

function renderSentinelRecord(entry, context) {
  let record;
  try {
    record = JSON.parse(entry.raw);
  } catch {
    const line = String(entry.lineNumber).padStart(6, "0");
    return "@@RECORD line=" + line + " kind=unparsed sha256=" + entry.hash + "\n" + entry.raw + "\n@@END_RECORD line=" + line;
  }
  const fields = [
    "line=" + String(entry.lineNumber).padStart(6, "0"),
    "type=" + String(record.type || "unknown").replace(/\s+/g, "_"),
  ];
  if (record.message?.role) fields.push("role=" + String(record.message.role).replace(/\s+/g, "_"));
  if (record.timestamp) fields.push("ts=" + String(record.timestamp).replace(/\s+/g, "_"));
  let body = recordTextForPrompt(record, entry).trim() || entry.preview || "[no textual content extracted]";
  const oldToolOutput =
    isToolOutputRecord(record) && toolOutputCompressAfter > 0 && entry.lineNumber <= context.recordCount - toolOutputCompressAfter;
  if (oldToolOutput) {
    const compacted = compactToolOutputBody(body, entry);
    if (compacted.compressed) {
      context.stats.compressedToolOutputRecords += 1;
      context.stats.originalToolOutputChars += compacted.originalChars;
      context.stats.omittedToolOutputChars += compacted.omittedChars;
    }
    body = compacted.body;
  }
  const oldToolUse =
    isToolUseRecord(record) &&
    toolUseCompressAfter > 0 &&
    entry.lineNumber <= context.recordCount - toolUseCompressAfter;
  if (oldToolUse) {
    const compacted = compactOldToolUseBody(body, entry);
    if (compacted.compressed) {
      context.stats.compressedToolUseRecords = (context.stats.compressedToolUseRecords || 0) + 1;
      context.stats.originalToolUseChars = (context.stats.originalToolUseChars || 0) + compacted.originalChars;
      context.stats.omittedToolUseChars = (context.stats.omittedToolUseChars || 0) + compacted.omittedChars;
    }
    body = compacted.body;
  }
  body = escapeSentinelBody(body);
  if (oldToolOutput) context.stats.renderedToolOutputChars += body.length;
  fields.push("chars=" + body.length);
  return "@@RECORD " + fields.join(" ") + "\n" + body + "\n@@END_RECORD line=" + String(entry.lineNumber).padStart(6, "0");
}

function buildRecordArtifacts(transcript, renderer = transcriptRenderer) {
  const lines = logicalJsonlLines(transcript);
  const renderStats = {
    compressedToolOutputRecords: 0,
    originalToolOutputChars: 0,
    renderedToolOutputChars: 0,
    omittedToolOutputChars: 0,
    compressedToolUseRecords: 0,
    originalToolUseChars: 0,
    omittedToolUseChars: 0,
  };
  const entries = lines.map((line, idx) => {
    let searchableText = line;
    try {
      const record = JSON.parse(line);
      const parts = [];
      if (typeof record.content === "string") parts.push(record.content);
      if (typeof record.message?.content === "string") parts.push(record.message.content);
      if (Array.isArray(record.message?.content)) {
        for (const part of record.message.content) {
          if (typeof part?.text === "string") parts.push(part.text);
          if (typeof part?.content === "string") parts.push(part.content);
        }
      }
      if (parts.length > 0) searchableText = parts.join("\n");
    } catch {}
    return {
      lineNumber: idx + 1,
      raw: line,
      hash: createHash("sha256").update(line).digest("hex"),
      preview: previewRecord(line),
      searchableText,
    };
  });
  const wrappedBody =
    entries
      .map((entry) => {
        const line = String(entry.lineNumber).padStart(6, "0");
        if (renderer === "stripped") return renderStrippedRecord(entry);
        if (renderer === "sentinel") {
          return renderSentinelRecord(entry, { recordCount: entries.length, stats: renderStats });
        }
        if (renderer === "onto") {
          return renderOntoRecord(entry, { recordCount: entries.length, stats: renderStats });
        }
        return '<record line="' + line + '">' + entry.raw + "</record>";
      })
      .join("\n") + "\n";
  const wrappedTranscript =
    renderer === "onto" ? ontoHeader(entries.length) + "\n" + wrappedBody : wrappedBody;
  const tsv =
    "line\thash\tpreview\n" +
    entries
      .map((entry) => {
        return [
          String(entry.lineNumber),
          entry.hash,
          entry.preview.replace(/[\t\r\n]/g, " "),
        ].join("\t");
      })
      .join("\n") +
    "\n";
  return { entries, wrappedTranscript, tsv, renderStats };
}

function byteLength(text) {
  return Buffer.byteLength(String(text || ""));
}

function tableEscape(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function addAggregate(map, key, values) {
  const existing =
    map.get(key) || {
      key,
      records: 0,
      blocks: 0,
      rawBytes: 0,
      rawChars: 0,
      promptChars: 0,
      renderedChars: 0,
      renderedBytes: 0,
      maxRenderedChars: 0,
      maxLine: null,
    };
  existing.records += values.records || 0;
  existing.blocks += values.blocks || 0;
  existing.rawBytes += values.rawBytes || 0;
  existing.rawChars += values.rawChars || 0;
  existing.promptChars += values.promptChars || 0;
  existing.renderedChars += values.renderedChars || 0;
  existing.renderedBytes += values.renderedBytes || 0;
  if ((values.renderedChars || 0) > existing.maxRenderedChars) {
    existing.maxRenderedChars = values.renderedChars || 0;
    existing.maxLine = values.line || null;
  }
  map.set(key, existing);
}

function sortedAggregates(map, limit = Infinity) {
  return [...map.values()]
    .sort((a, b) => b.renderedBytes - a.renderedBytes || b.promptChars - a.promptChars || b.records - a.records)
    .slice(0, limit);
}

function markdownTable(headers, rows) {
  const lines = [];
  lines.push("| " + headers.join(" | ") + " |");
  lines.push("|" + headers.map(() => "---").join("|") + "|");
  for (const row of rows) {
    lines.push("| " + row.map(tableEscape).join(" | ") + " |");
  }
  return lines.join("\n");
}

function recordBlockParts(record) {
  const content = record?.message?.content ?? record?.content;
  if (typeof content === "string") {
    return [{ type: "string_content", raw: content, prompt: content }];
  }
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return { type: "string_part", raw: part, prompt: part };
      if (!part || typeof part !== "object") return { type: "empty_part", raw: "", prompt: "" };
      return {
        type: part.type || (part.tool_use_id ? "tool_result" : "object_part"),
        raw: JSON.stringify(part),
        prompt: renderPartForPrompt(part),
      };
    });
  }
  if (record?.attachment && typeof record.attachment === "object") {
    return [
      {
        type: "attachment:" + String(record.attachment.type || "unknown"),
        raw: JSON.stringify(record.attachment),
        prompt: "",
      },
    ];
  }
  if (typeof record?.content === "string") {
    return [{ type: "top_level_content", raw: record.content, prompt: record.content }];
  }
  return [];
}

function recordKind(record) {
  if (!record || typeof record !== "object") return "unparsed";
  if (record.isCompactSummary) return "compact_summary";
  if (record.type === "attachment") return "attachment";
  if (record.type === "file-history-snapshot") return "file_history_snapshot";
  if (record.toolUseResult || record.sourceToolAssistantUUID || isToolOutputRecord(record)) return "tool_output";
  const content = record.message?.content;
  if (Array.isArray(content) && content.some((part) => part?.type === "tool_use")) return "tool_use";
  if (record.message?.role === "user") return "user_message";
  if (record.message?.role === "assistant") return "assistant_message";
  if (record.type === "system") return "system";
  if (["last-prompt", "mode", "permission-mode", "ai-title", "queue-operation"].includes(record.type)) {
    return "metadata";
  }
  return record.type || "unknown";
}

function renderEntryForStats(entry, renderer, context) {
  const line = String(entry.lineNumber).padStart(6, "0");
  if (renderer === "stripped") return renderStrippedRecord(entry);
  if (renderer === "sentinel") return renderSentinelRecord(entry, context);
  if (renderer === "onto") return renderOntoRecord(entry, context);
  return '<record line="' + line + '">' + entry.raw + "</record>";
}

function rendererStatsForTranscript(transcript, renderer) {
  const artifacts = buildRecordArtifacts(transcript, renderer);
  const byRecordType = new Map();
  const byRole = new Map();
  const byKind = new Map();
  const byBlockType = new Map();
  const byRecordBlock = new Map();
  const topRendered = [];
  const topRaw = [];
  const topOmitted = [];
  const lines = logicalJsonlLines(transcript);
  const entries = artifacts.entries;
  const renderStats = {
    compressedToolOutputRecords: 0,
    originalToolOutputChars: 0,
    renderedToolOutputChars: 0,
    omittedToolOutputChars: 0,
    compressedToolUseRecords: 0,
    originalToolUseChars: 0,
    omittedToolUseChars: 0,
  };
  for (const entry of entries) {
    let record = null;
    let parsed = true;
    try {
      record = JSON.parse(entry.raw);
    } catch {
      parsed = false;
    }
    const context = { recordCount: entries.length, stats: renderStats };
    const rendered = renderEntryForStats(entry, renderer, context);
    const parts = parsed ? recordBlockParts(record) : [];
    const promptChars = parsed ? recordTextForPrompt(record).length : 0;
    const type = parsed ? record.type || "unknown" : "unparsed";
    const role = parsed ? record.message?.role || "(none)" : "(unparsed)";
    const kind = parsed ? recordKind(record) : "unparsed";
    const values = {
      records: 1,
      rawBytes: byteLength(entry.raw),
      rawChars: entry.raw.length,
      promptChars,
      renderedChars: rendered.length,
      renderedBytes: byteLength(rendered),
      line: entry.lineNumber,
    };
    addAggregate(byRecordType, type, values);
    addAggregate(byRole, role, values);
    addAggregate(byKind, kind, values);
    if (parts.length === 0) {
      addAggregate(byBlockType, "(no content block)", {
        records: 1,
        blocks: 1,
        rawChars: 0,
        promptChars: 0,
        renderedChars: 0,
        line: entry.lineNumber,
      });
      addAggregate(byRecordBlock, type + " / (no content block)", {
        records: 1,
        blocks: 1,
        rawChars: 0,
        promptChars: 0,
        renderedChars: 0,
        line: entry.lineNumber,
      });
    } else {
      const seenBlockTypes = new Set();
      for (const part of parts) {
        const blockValues = {
          blocks: 1,
          rawChars: String(part.raw || "").length,
          promptChars: String(part.prompt || "").length,
          renderedChars: String(part.prompt || "").length,
          line: entry.lineNumber,
        };
        addAggregate(byBlockType, part.type, blockValues);
        addAggregate(byRecordBlock, type + " / " + part.type, blockValues);
        seenBlockTypes.add(part.type);
      }
      for (const blockType of seenBlockTypes) {
        const aggregate = byBlockType.get(blockType);
        aggregate.records += 1;
      }
    }
    topRendered.push({
      line: entry.lineNumber,
      type,
      role,
      kind,
      renderedBytes: byteLength(rendered),
      rawBytes: byteLength(entry.raw),
      hash: entry.hash.slice(0, 12),
      preview: entry.preview,
    });
    topRaw.push({
      line: entry.lineNumber,
      type,
      role,
      kind,
      renderedBytes: byteLength(rendered),
      rawBytes: byteLength(entry.raw),
      hash: entry.hash.slice(0, 12),
      preview: entry.preview,
    });
    if ((renderer === "sentinel" || renderer === "onto") && parsed && isToolOutputRecord(record)) {
      const body = recordTextForPrompt(record).trim() || entry.preview || "[no textual content extracted]";
      const oldToolOutput =
        toolOutputCompressAfter > 0 && entry.lineNumber <= entries.length - toolOutputCompressAfter;
      const compacted = oldToolOutput ? compactToolOutputBody(body, entry) : { compressed: false };
      if (compacted.compressed) {
        topOmitted.push({
          line: entry.lineNumber,
          type,
          role,
          kind,
          omittedChars: compacted.omittedChars,
          originalChars: compacted.originalChars,
          hash: entry.hash.slice(0, 12),
          preview: entry.preview,
        });
      }
    }
  }
  return {
    renderer,
    recordCount: lines.length,
    rawTranscriptBytes: byteLength(transcript),
    rawTranscriptChars: transcript.length,
    wrappedTranscriptBytes: byteLength(artifacts.wrappedTranscript),
    wrappedTranscriptChars: artifacts.wrappedTranscript.length,
    wrappedTranscriptEstimatedTokens: Math.ceil(artifacts.wrappedTranscript.length / 4),
    renderStats: renderer === "sentinel" ? artifacts.renderStats : renderStats,
    byRecordType,
    byRole,
    byKind,
    byBlockType,
    byRecordBlock,
    topRendered: topRendered.sort((a, b) => b.renderedBytes - a.renderedBytes).slice(0, 15),
    topRaw: topRaw.sort((a, b) => b.rawBytes - a.rawBytes).slice(0, 15),
    topOmitted: topOmitted.sort((a, b) => b.omittedChars - a.omittedChars).slice(0, 15),
  };
}

function renderRendererStatsMarkdown({ inputPath, transcript, renderers, generatedAt }) {
  const sha256 = sha256Text(transcript);
  const reports = renderers.map((renderer) => rendererStatsForTranscript(transcript, renderer));
  const preferred = reports.find((report) => report.renderer === "sentinel") || reports[0];
  const lines = [];
  lines.push("# Renderer Stats Report");
  lines.push("");
  lines.push("Suggested path: `docs/renderer-stats-report.md`.");
  lines.push("");
  lines.push("Generated: `" + generatedAt.toISOString() + "`.");
  lines.push("");
  lines.push("## Source");
  lines.push("");
  lines.push(
    markdownTable(
      ["Field", "Value"],
      [
        ["Input", inputPath],
        ["Transcript SHA256", sha256],
        ["Raw bytes", byteLength(transcript).toLocaleString()],
        ["Logical records", String(logicalJsonlLines(transcript).length)],
        ["char/4 token estimate", String(Math.ceil(transcript.length / 4).toLocaleString())],
      ]
    )
  );
  lines.push("");
  lines.push("## Renderer Comparison");
  lines.push("");
  lines.push(
    markdownTable(
      ["Renderer", "Records", "Wrapped bytes", "Wrapped char/4 tokens", "Compressed records", "Omitted chars", "Omitted char/4 tokens"],
      reports.map((report) => [
        report.renderer,
        report.recordCount.toLocaleString(),
        report.wrappedTranscriptBytes.toLocaleString(),
        report.wrappedTranscriptEstimatedTokens.toLocaleString(),
        (report.renderStats.compressedToolOutputRecords || 0).toLocaleString(),
        (report.renderStats.omittedToolOutputChars || 0).toLocaleString(),
        Math.ceil((report.renderStats.omittedToolOutputChars || 0) / 4).toLocaleString(),
      ])
    )
  );
  lines.push("");
  lines.push("## Record Types");
  lines.push("");
  lines.push("Renderer used for detailed tables: `" + preferred.renderer + "`.");
  lines.push("");
  lines.push(
    markdownTable(
      ["Type", "Records", "Raw bytes", "Prompt chars", "Rendered bytes", "Max rendered line"],
      sortedAggregates(preferred.byRecordType).map((item) => [
        item.key,
        item.records.toLocaleString(),
        item.rawBytes.toLocaleString(),
        item.promptChars.toLocaleString(),
        item.renderedBytes.toLocaleString(),
        item.maxLine || "",
      ])
    )
  );
  lines.push("");
  lines.push("## Roles");
  lines.push("");
  lines.push(
    markdownTable(
      ["Role", "Records", "Raw bytes", "Prompt chars", "Rendered bytes", "Max rendered line"],
      sortedAggregates(preferred.byRole).map((item) => [
        item.key,
        item.records.toLocaleString(),
        item.rawBytes.toLocaleString(),
        item.promptChars.toLocaleString(),
        item.renderedBytes.toLocaleString(),
        item.maxLine || "",
      ])
    )
  );
  lines.push("");
  lines.push("## Derived Record Kinds");
  lines.push("");
  lines.push(
    markdownTable(
      ["Kind", "Records", "Raw bytes", "Prompt chars", "Rendered bytes", "Max rendered line"],
      sortedAggregates(preferred.byKind).map((item) => [
        item.key,
        item.records.toLocaleString(),
        item.rawBytes.toLocaleString(),
        item.promptChars.toLocaleString(),
        item.renderedBytes.toLocaleString(),
        item.maxLine || "",
      ])
    )
  );
  lines.push("");
  lines.push("## Content Block Types");
  lines.push("");
  lines.push(
    markdownTable(
      ["Block type", "Records containing", "Blocks", "Raw chars", "Prompt-visible chars", "Max line"],
      sortedAggregates(preferred.byBlockType).map((item) => [
        item.key,
        item.records.toLocaleString(),
        item.blocks.toLocaleString(),
        item.rawChars.toLocaleString(),
        item.promptChars.toLocaleString(),
        item.maxLine || "",
      ])
    )
  );
  lines.push("");
  lines.push("## Record Type x Block Type");
  lines.push("");
  lines.push(
    markdownTable(
      ["Record / block", "Blocks", "Raw chars", "Prompt-visible chars", "Max line"],
      sortedAggregates(preferred.byRecordBlock, 30).map((item) => [
        item.key,
        item.blocks.toLocaleString(),
        item.rawChars.toLocaleString(),
        item.promptChars.toLocaleString(),
        item.maxLine || "",
      ])
    )
  );
  lines.push("");
  lines.push("## Sentinel Compression");
  lines.push("");
  const sentinel = reports.find((report) => report.renderer === "sentinel");
  if (sentinel) {
    lines.push(
      markdownTable(
        ["Metric", "Value"],
        [
          ["Compressed tool-output records", sentinel.renderStats.compressedToolOutputRecords.toLocaleString()],
          ["Original compressed body chars", sentinel.renderStats.originalToolOutputChars.toLocaleString()],
          ["Rendered compressed body chars", sentinel.renderStats.renderedToolOutputChars.toLocaleString()],
          ["Omitted chars", sentinel.renderStats.omittedToolOutputChars.toLocaleString()],
          ["Omitted char/4 tokens", Math.ceil(sentinel.renderStats.omittedToolOutputChars / 4).toLocaleString()],
        ]
      )
    );
    lines.push("");
    lines.push("### Largest Omitted Tool Outputs");
    lines.push("");
    lines.push(
      markdownTable(
        ["Line", "Type", "Role", "Omitted chars", "Original chars", "Hash", "Preview"],
        sentinel.topOmitted.map((item) => [
          item.line,
          item.type,
          item.role,
          item.omittedChars.toLocaleString(),
          item.originalChars.toLocaleString(),
          item.hash,
          item.preview.slice(0, 140),
        ])
      )
    );
  } else {
    lines.push("Sentinel renderer was not included in this report.");
  }
  lines.push("");
  lines.push("## Largest Rendered Records");
  lines.push("");
  lines.push(
    markdownTable(
      ["Line", "Type", "Role", "Kind", "Rendered bytes", "Raw bytes", "Hash", "Preview"],
      preferred.topRendered.map((item) => [
        item.line,
        item.type,
        item.role,
        item.kind,
        item.renderedBytes.toLocaleString(),
        item.rawBytes.toLocaleString(),
        item.hash,
        item.preview.slice(0, 140),
      ])
    )
  );
  lines.push("");
  lines.push("## Largest Raw Records");
  lines.push("");
  lines.push(
    markdownTable(
      ["Line", "Type", "Role", "Kind", "Raw bytes", "Rendered bytes", "Hash", "Preview"],
      preferred.topRaw.map((item) => [
        item.line,
        item.type,
        item.role,
        item.kind,
        item.rawBytes.toLocaleString(),
        item.renderedBytes.toLocaleString(),
        item.hash,
        item.preview.slice(0, 140),
      ])
    )
  );
  lines.push("");
  lines.push("## Notes");
  lines.push("");
  lines.push("- `Prompt-visible chars` uses the same local text extraction path as the renderer.");
  lines.push("- `thinking` blocks in this transcript are mostly empty prompt-visible text with raw signature metadata.");
  lines.push("- `char/4` token counts are estimates, not provider tokenizer measurements.");
  lines.push("- This report is generated locally and does not call any model provider.");
  lines.push("");
  return lines.join("\n");
}

function countUserMessages(records) {
  let count = 0;
  for (const record of records) {
    if (isRealUserMessageRecord(record)) count += 1;
  }
  return count;
}

function isRealUserMessageRecord(record) {
  if (!record || typeof record !== "object") return false;
  if (record.isMeta || record.isCompactSummary || record.isVisibleInTranscriptOnly) return false;
  if (record.toolUseResult || record.sourceToolAssistantUUID) return false;
  if (record.type !== "user" && record.message?.role !== "user") return false;
  const content = record.message?.content;
  if (Array.isArray(content)) {
    if (content.some((part) => part?.type === "tool_result" || part?.tool_use_id)) return false;
  }
  return extractUserMessageText(record).trim().length > 0;
}

function extractUserMessageText(record) {
  const content = record?.message?.content ?? record?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "tool_result" || part.tool_use_id) continue;
    if (typeof part.text === "string") parts.push(part.text);
    else if (typeof part.content === "string" && part.type !== "tool_result") parts.push(part.content);
  }
  return parts.join("\n");
}

function extractUserMessages(records, lineHashArtifacts) {
  const messages = [];
  records.forEach((record, idx) => {
    if (!isRealUserMessageRecord(record)) return;
    const text = extractUserMessageText(record);
    const line = idx + 1;
    messages.push({
      line,
      uuid: record.uuid || null,
      originalUuid: record.originalUuid || null,
      parentUuid: record.parentUuid || null,
      timestamp: record.timestamp || null,
      source: "current",
      sha256: createHash("sha256").update(text).digest("hex"),
      record_sha256: lineHash(lineHashArtifacts, line) || null,
      char_count: text.length,
      text,
    });
  });
  return messages;
}

function recordTextContent(record) {
  const content = record?.message?.content ?? record?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if (typeof part.text === "string") return part.text;
      if (typeof part.content === "string") return part.content;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function nullableInt(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function unescapeXmlAttr(value) {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function parseXmlAttrs(rawAttrs) {
  const attrs = {};
  const attrRe = /([A-Za-z0-9_:-]+)="([^"]*)"/g;
  let match;
  while ((match = attrRe.exec(rawAttrs))) {
    attrs[match[1]] = unescapeXmlAttr(match[2]);
  }
  return attrs;
}

function carriedMessageFromUserIntentEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const text = typeof event.text === "string" ? event.text : "";
  if (!text.trim()) return null;
  const source = event.source && typeof event.source === "object" ? event.source : {};
  const line = nullableInt(source.line) ?? nullableInt(source.original_line) ?? 1;
  return {
    source: "carried",
    line,
    original_line: nullableInt(source.original_line) ?? line,
    uuid: source.uuid || null,
    originalUuid: source.original_uuid || null,
    parentUuid: null,
    timestamp: source.timestamp || null,
    sha256: event.text_sha256 || event.message_sha256 || sha256Text(text),
    record_sha256: source.record_sha256 || null,
    source_transcript_sha256: source.source_transcript_sha256 || null,
    char_count: nullableInt(event.char_count) ?? text.length,
    text,
    rendered_text: typeof event.rendered_text === "string" ? event.rendered_text : null,
    user_intent_event_id: event.id || null,
  };
}

function readCarriedHandoffState(record) {
  const path = record?.handoff?.state_path;
  if (typeof path !== "string" || path.trim().length === 0) return null;
  try {
    const state = JSON.parse(readFileSync(path, "utf8"));
    return state && typeof state === "object" && !Array.isArray(state) ? state : null;
  } catch {
    return null;
  }
}

function extractTypedCarriedHandoffUserMessages(record) {
  if (!record?.isCompactSummary) return null;
  const embeddedEvents = record.handoff?.user_intent_events;
  const events = Array.isArray(embeddedEvents)
    ? embeddedEvents
    : readCarriedHandoffState(record)?.user_intent_events;
  if (!Array.isArray(events)) return null;
  return events.map(carriedMessageFromUserIntentEvent).filter(Boolean);
}

function extractLegacyCarriedHandoffUserMessages(record, recordIndex) {
  const messages = [];
  const text = recordTextContent(record);
  if (!text.includes("<user-message-ledger")) return messages;
  const ledgerRe = /<user-message-ledger\b[^>]*>([\s\S]*?)<\/user-message-ledger>/g;
  let ledgerMatch;
  while ((ledgerMatch = ledgerRe.exec(text))) {
    const ledgerBody = ledgerMatch[1];
    const messageRe = /<user-message\b([^>]*)>\n?([\s\S]*?)\n?<\/user-message>/g;
    let messageMatch;
    while ((messageMatch = messageRe.exec(ledgerBody))) {
      const attrs = parseXmlAttrs(messageMatch[1]);
      const renderedText = messageMatch[2].trim();
      const line = nullableInt(attrs.line) ?? nullableInt(attrs.original_line) ?? recordIndex + 1;
      messages.push({
        source: "carried",
        line,
        original_line: nullableInt(attrs.original_line) ?? line,
        uuid: attrs.uuid || null,
        originalUuid: attrs.original_uuid || null,
        parentUuid: null,
        timestamp: attrs.timestamp || null,
        sha256:
          attrs.sha256 ||
          attrs.text_sha256 ||
          createHash("sha256").update(renderedText).digest("hex"),
        record_sha256: attrs.record_sha256 || null,
        source_transcript_sha256: attrs.source_transcript_sha256 || null,
        char_count: nullableInt(attrs.chars) ?? renderedText.length,
        text: renderedText,
        rendered_text: renderedText,
      });
    }
  }
  return messages;
}

function extractCarriedHandoffUserMessages(records) {
  const messages = [];
  for (const [recordIndex, record] of records.entries()) {
    const typedMessages = extractTypedCarriedHandoffUserMessages(record);
    if (typedMessages) {
      messages.push(...typedMessages);
      continue;
    }
    if (!record?.isCompactSummary) continue;
    messages.push(...extractLegacyCarriedHandoffUserMessages(record, recordIndex));
  }
  return messages;
}

function pickBaseMetadata(records) {
  const first = records.find((record) => record && typeof record === "object") || {};
  return {
    userType: first.userType,
    cwd: first.cwd,
    sessionId: first.sessionId,
    version: first.version,
    gitBranch: first.gitBranch,
    entrypoint: first.entrypoint,
    slug: first.slug,
  };
}

function compactBaseMetadata(metadata) {
  const base = {};
  for (const [key, value] of Object.entries(metadata || {})) {
    if (value !== undefined) base[key] = value;
  }
  return base;
}

function extractLastUserUuid(records) {
  for (let idx = records.length - 1; idx >= 0; idx -= 1) {
    const record = records[idx];
    if (record?.type === "user" && typeof record.uuid === "string") return record.uuid;
  }
  return null;
}

function safeUuid() {
  return randomUUID();
}

function createSummarySchema(recordCount = 0, options = {}) {
  const includeLineBounds = options.includeLineBounds !== false;
  const includeCompatibilityFields = options.includeCompatibilityFields === true;
  const stringArray = {
    type: "array",
    items: { type: "string" },
  };
  const lineNumber = {
    type: "integer",
    description:
      "One-based logical JSONL record number for the cited record, read from the transcript framing described in the prompt.",
  };
  if (includeLineBounds) {
    lineNumber.minimum = 1;
    lineNumber.maximum = recordCount || 1000000000;
  }
  const sourceSpan = {
    type: "object",
    additionalProperties: false,
    required: ["start_line", "end_line"],
    properties: {
      start_line: lineNumber,
      end_line: lineNumber,
    },
  };
  const schema = {
    type: "object",
    additionalProperties: false,
    required: [
      "summary_blocks",
      "rules_and_invariants",
      "plans_and_task_state",
      "current_work",
      "optional_next_step",
      "promises_made",
      "source_integrity",
    ],
    properties: {
      summary_blocks: {
        type: "array",
        minItems: 1,
        description:
          "One thematic section per distinct domain of the session. Be exhaustive: emit a separate block for every domain touched (current state, current user intent and constraints, each active artifact area, transport/capture, endpoints/payloads, model registry, tooling/skills, decisions, and pending work). Many focused blocks beat a few broad ones; do not merge unrelated domains into a single block. This handoff outlives the transcript, so a domain you omit is lost.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["section", "format", "body", "source_spans"],
          properties: {
            section: { type: "string" },
            format: {
              type: "string",
              enum: ["paragraph", "bullet"],
            },
            body: {
              type: "string",
              description:
                "Rendered summary content for this block. Bullet bodies must be a single item without a leading bullet marker.",
            },
            source_spans: {
              type: "array",
              minItems: 1,
              description:
                "Cite MULTIPLE narrow record ranges that support this block -- one fact per span. Prefer several 1-3 record citations over one wide span; every verbatim path, protocol string, RPC/service name, command, or version number named in the body needs its own span. A block with a single span almost always collapsed several facts.",
              items: sourceSpan,
            },
          },
        },
      },
      rules_and_invariants: {
        type: "array",
        description:
          "Durable live instructions and constraints that should govern future work after compaction. Include explicit user/system/project rules, safety/security constraints, validation gates, durable preferences, and accepted decisions that still constrain what the next agent may do. Exclude ordinary completed tasks, transient exploration notes, historical user messages, rejected ideas, and old instructions that were later superseded or removed.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["rule", "status", "source_spans"],
          properties: {
            rule: { type: "string" },
            status: {
              type: "string",
              enum: ["current", "superseded", "removed"],
              description:
                "Only current rules should be treated as live instructions after compaction. Use superseded or removed when later transcript state invalidates the rule.",
            },
            source_spans: {
              type: "array",
              minItems: 1,
              items: sourceSpan,
            },
          },
        },
      },
      plans_and_task_state: {
        type: "array",
        description:
          "Work-state ledger for the task, not a rule list. Include active or pending tasks, completed milestones that matter for continuation, benchmark state, open artifacts, open questions, blockers, and concrete next actions. Order active and pending work by priority. Exclude durable behavioral constraints that belong in rules_and_invariants and explicit assistant commitments that belong in promises_made.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["item", "status", "source_spans"],
          properties: {
            item: { type: "string" },
            status: {
              type: "string",
              enum: ["done", "active", "pending", "blocked", "superseded"],
            },
            source_spans: {
              type: "array",
              minItems: 1,
              items: sourceSpan,
            },
          },
        },
      },
      promises_made: {
        type: "array",
        description:
          "Explicit assistant commitments to the user that should survive compaction. Include promises such as 'I will run X', 'I will send Y', 'I will update/commit/push Z', or equivalent accepted commitments where the user will reasonably expect follow-through or proof. Scan the WHOLE transcript for these commitments and include every one with a source_span -- this array is commonly under-populated, so re-check it before finalizing rather than leaving it empty when commitments exist. Do not infer promises from a user request alone. Exclude ordinary plans, inferred next steps, and completed work unless its promised proof/status must remain visible.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["promise", "status", "source_spans"],
          properties: {
            promise: { type: "string" },
            status: {
              type: "string",
              enum: ["done", "active", "pending", "blocked", "superseded", "removed"],
            },
            source_spans: {
              type: "array",
              minItems: 1,
              items: sourceSpan,
            },
          },
        },
      },
      current_work: {
        type: "string",
        description:
          "What is actively in progress at the END of the transcript (not an earlier abandoned branch), in one or two concrete sentences: the specific task, the file or command in flight, and the immediate blocker or open decision. Name exact paths/commands/identifiers.",
      },
      optional_next_step: {
        type: "string",
        description:
          "The single most actionable next step a fresh agent should take, stated as a concrete action grounded in the latest transcript state -- ideally the exact next command, file to edit, or check to run, and why. Do not leave empty and do not restate the goal abstractly; if work is complete, say what verification or follow-up remains.",
      },
      source_integrity: {
        type: "object",
        additionalProperties: false,
        required: [
          "transcript_sha256",
          "transcript_lines_seen",
          "verbatim_span_grounded",
          "limitations",
        ],
        properties: {
          transcript_sha256: { type: "string" },
          transcript_lines_seen: { type: "integer" },
          verbatim_span_grounded: { type: "boolean" },
          limitations: { type: "string" },
        },
      },
    },
  };
  if (includeCompatibilityFields) {
    schema.required.push(...COMPATIBILITY_ARRAY_KEYS, "source_lines_used");
    schema.properties.primary_request_and_intent = stringArray;
    schema.properties.key_technical_concepts = stringArray;
    schema.properties.files_and_code_sections = {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "why_it_matters", "details"],
        properties: {
          path: { type: "string" },
          why_it_matters: { type: "string" },
          details: { type: "string" },
        },
      },
    };
    schema.properties.errors_and_fixes = stringArray;
    schema.properties.problem_solving = stringArray;
    schema.properties.pending_tasks = stringArray;
    schema.properties.source_lines_used = {
      type: "array",
      items: lineNumber,
    };
  }
  return schema;
}

function createProviderSummarySchema(recordCount = 0) {
  return createSummarySchema(recordCount, {
    includeCompatibilityFields: false,
    includeLineBounds: true,
  });
}

function createLocalValidationSpec() {
  return {
    schema: LOCAL_VALIDATION_SCHEMA,
    anchored_arrays: ["summary_blocks", "rules_and_invariants", "plans_and_task_state", "promises_made"],
    derived_fields: ["source_lines_used", "source_hashes_used", ...COMPATIBILITY_ARRAY_KEYS],
    evidence_validation: ["source_spans", "line_bounds", "hashes", "capsules"],
  };
}

function rendererEvidenceInstructions(renderer) {
  return rendererTranscriptGuide(renderer);
}

function buildFullTranscriptPrompt({ wrappedTranscript, stats, reaskFeedback, adaptationLines }) {
  const customInstructionsBlock = customSummaryInstructions.trim()
    ? [
        "",
        "Custom summarization instructions:",
        customSummaryInstructions.trim(),
      ]
    : [];
  const compactAndBlock = compactAndPrompt.trim()
    ? [
        "",
        "Queued follow-up prompt after compaction:",
        compactAndPrompt.trim(),
        "Optimize the summary so that this queued follow-up can run immediately after compaction without reopening the full transcript.",
      ]
    : [];
  return [
    "You are a compaction model for Claude Code session transcripts.",
    "Your job is to produce a fresh summarized starting point for continued work after compaction.",
    "Optimize for the very next follow-up prompt, including any queued follow-up supplied with this request.",
    "Treat this as a continuation handoff, not a retrospective summary.",
    "Preserve the active working set and compress older material aggressively.",
    "",
    "Critical shape requirement:",
    "- Do not omit late-session state.",
    "- Treat later user messages as more important than earlier abandoned plans.",
    "- If older context and late-session state conflict, prefer the corrected late-session state and explain only the delta that still matters.",
    "",
    "Return strict JSON only. The JSON must match the provided schema.",
    ...customInstructionsBlock,
    ...compactAndBlock,
    "",
    "Evidence span format:",
    ...rendererEvidenceInstructions(stats.transcriptRenderer),
    "- summary_blocks is the primary structured output. It must be ordered exactly as the continuation summary should read.",
    "- Every summary_blocks item must include one or more source_spans pointing to the exact supporting record ranges.",
    "- The authoritative source record is the cited source_spans plus harness rehydration, not long verbatim body text.",
    "- Do not copy large verbatim transcript excerpts into the JSON response. The harness will extract exact record content itself from the selected source spans.",
    "- Do not emit verbatim code/config/command blocks in summary_blocks. Summarize them and cite the exact source spans; the harness preserves verbatim evidence separately.",
    "- Bullet bodies must be a single item and must not include a leading bullet marker.",
    "- Only records with extractable content are shown and numbered. Cite only line numbers present in the transcript below.",
    "- source_integrity.verbatim_span_grounded must be true.",
    "",
    "Compaction requirements:",
    "- The harness will render the final markdown summary from summary_blocks and separately emit a rehydrated evidence view from source_spans.",
    "- Prioritize continuation utility over historical exhaustiveness.",
    "- Organize content around: task overview, current state, important discoveries, next steps, and context to preserve.",
    "- Think in two bands: active context and archived context. Active context is what the next agent needs immediately; archived context is only older material needed to avoid repeated mistakes or lost commitments.",
    "- Keep abandoned branches brief unless they still constrain current work, explain a bug, or explain why a later correction matters.",
    "- Preserve failed approaches only when they prevent repeated work or explain a current constraint.",
    "- Prefer durable state over chronology: capture decisions, invariants, open tasks, exact artifacts, open questions, and unresolved blockers before narrating what happened.",
    "- Prefer block-style handoff sections over a play-by-play timeline.",
    "- A fresh agent should know the current objective, active artifacts, user preferences, domain-specific context, constraints, blockers, and next command or check.",
    "- Preserve explicit user instructions, constraints, file paths, commands, errors, pending work, and security-relevant instructions. Preserve security-relevant user constraints verbatim.",
    "- Classify continuation state into three distinct buckets:",
    "  - rules_and_invariants: live instructions or constraints that should govern future behavior. Include explicit user/system/project rules, safety/security constraints, validation gates, durable preferences, and accepted decisions that still constrain future work. Do not include completed tasks, one-off observations, generic errors, old user wording preserved only for history, or abandoned ideas.",
    "  - plans_and_task_state: work ledger, not behavior policy. Include active/pending/done task state, benchmark status, open artifacts, blockers, open questions, and concrete next actions. Do not include durable rules or assistant promises unless the work item itself also needs tracking.",
    "  - promises_made: explicit assistant commitments to the user. Include promised deliverables, checks, reports, commits, pushes, or follow-up actions where the user would expect proof or completion. Do not infer promises from a user request alone, and do not list ordinary internal next steps as promises.",
    "- If the same transcript event has multiple roles, split it only when each role matters: a user constraint belongs in rules_and_invariants; the task progress belongs in plans_and_task_state; the assistant's explicit commitment belongs in promises_made.",
    "- If a later user message removes or supersedes an earlier rule, mark that rule status as removed or superseded. Do not present removed or superseded rules as live instructions.",
    "- Keep removed or superseded rules only when they prevent drift or explain why a tempting older instruction is no longer live.",
    "- Preserve exact symbols, command names, endpoint paths, file names, hook names, setting names, and error text when they matter.",
    "- Do not pin irrelevant literal wording or incidental implementation details unless they are part of a contract or a current task.",
    "- Do not output a user-message inventory. The harness extracts user-authored messages deterministically from the transcript.",
    "- Do not output compatibility inventories such as source_lines_used, primary_request_and_intent, key_technical_concepts, files_and_code_sections, errors_and_fixes, problem_solving, or pending_tasks unless the active provider schema explicitly asks for them. The harness derives those local fields from anchored sections.",
    "- current_work and optional_next_step must reflect the end of the transcript, not an earlier branch of work.",
    "- If the transcript includes an assistant mistake later corrected by the user, summarize the corrected state and mention the correction if it changes what should happen next.",
    "- The first summary_blocks items should establish, in order: current state, current user intent/constraints, active files/artifacts, unresolved work/next step. Put older background later.",
    "- When there is too much material, drop redundant intermediate exploration before dropping the final task state.",
    "- Echo the transcript sha256 exactly in source_integrity.transcript_sha256.",
    "- Echo the number of transcript records shown below in source_integrity.transcript_lines_seen.",
    "",
    "Transcript metadata:",
    "- path: " + stats.inputPath,
    "- sha256: " + stats.sha256,
    "- bytes: " + stats.bytes,
    "- transcript records shown (citable): " + stats.records,
    "- prompt transcript renderer: " + stats.transcriptRenderer,
    "- approximate char_div_4 tokens: " + stats.approxTokens,
    "- observed user record count estimate: " + stats.userRecords,
    "",
    "<transcript>",
    wrappedTranscript,
    "</transcript>",
    ...(adaptationLines && adaptationLines.length
      ? ["", "=== MODEL-SPECIFIC COMPLETENESS REQUIREMENTS ===", ...adaptationLines]
      : []),
    ...(reaskFeedback && reaskFeedback.trim()
      ? ["", "=== CORRECTION REQUIRED (your previous attempt was incomplete) ===", reaskFeedback.trim()]
      : []),
  ].join("\n");
}

function buildSharedPromptMarkdown() {
  const prompt = buildFullTranscriptPrompt({
    wrappedTranscript: "{{WRAPPED_TRANSCRIPT_JSONL}}",
    stats: {
      inputPath: "{{INPUT_PATH}}",
      sha256: "{{TRANSCRIPT_SHA256}}",
      bytes: "{{TRANSCRIPT_BYTES}}",
      records: "{{TRANSCRIPT_RECORDS}}",
      transcriptRenderer: "{{TRANSCRIPT_RENDERER}}",
      approxTokens: "{{APPROX_CHAR_DIV_4_TOKENS}}",
      userRecords: "{{USER_RECORD_COUNT}}",
    },
  });
  return [
    "# Shared Compaction Prompt",
    "",
    "This file is generated from `buildFullTranscriptPrompt()` in `scripts/compact-full-transcript.mjs`.",
    "Run `node scripts/compact-full-transcript.mjs --print-shared-prompt-markdown` to regenerate it.",
    "",
    "Placeholders represent per-run transcript metadata or the wrapped JSONL transcript payload.",
    "",
    "```text",
    prompt,
    "```",
    "",
  ].join("\n");
}

function buildCodexRequestBody(promptText, stats) {
  const sessionId = randomUUID();
  const threadId = randomUUID();
  const windowId = `${threadId}:0`;
  const installationId = resolveCodexInstallationId();
  const request = {
    ids: { sessionId, threadId, windowId, installationId },
    body: {
      model: MODEL,
      instructions:
        "You are a transcript compaction engine. Output only strict JSON matching the requested schema.",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: promptText }],
        },
      ],
      tools: [],
      tool_choice: "auto",
      parallel_tool_calls: false,
      reasoning: { effort: REASONING_EFFORT },
      store: false,
      stream: true,
      include: ["reasoning.encrypted_content"],
      service_tier: SERVICE_TIER,
      prompt_cache_key: "unifusion-full-" + stats.sha256.slice(0, 32),
      text: {
        format: {
          type: "json_schema",
          strict: true,
          name: "claude_full_transcript_compaction",
          schema: createProviderSummarySchema(stats.records),
        },
      },
      client_metadata: {
        "x-codex-installation-id": installationId,
        "x-codex-window-id": windowId,
        session_id: sessionId,
        thread_id: threadId,
        codex_harness: "unifusion",
        request_kind: "full_transcript_compaction",
        transcript_sha256: stats.sha256,
        transcript_records: String(stats.records),
      },
    },
  };
  return request;
}

function geminiThinkingConfig(model, requestedLevel) {
  const requested = String(requestedLevel || "none").trim().toLowerCase();
  const normalizedModel = String(model || "").toLowerCase();
  const isOff = requested === "none" || requested === "off" || requested === "disabled";
  if (!isOff) return { thinkingLevel: requested };

  // Gemini 3.x Flash/Flash-Lite use thinkingLevel and only support "minimal"
  // as the closest setting to off.
  if (
    normalizedModel.includes("3.") ||
    normalizedModel === "gemini-flash-latest" ||
    normalizedModel === "gemini-flash-lite-latest"
  ) {
    return { thinkingLevel: "minimal" };
  }

  // Older non-thinking Flash lines do not need a thinkingConfig.
  return null;
}

function buildGeminiRequestBody(promptText, stats) {
  const generationConfig = {
    responseMimeType: "application/json",
    responseJsonSchema: createProviderSummarySchema(stats.records),
  };
  const thinkingConfig = geminiThinkingConfig(MODEL, GEMINI_THINKING_LEVEL);
  if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;
  if (TEMPERATURE !== null) generationConfig.temperature = TEMPERATURE;
  if (Number.isFinite(GEMINI_MAX_OUTPUT_TOKENS) && GEMINI_MAX_OUTPUT_TOKENS > 0) {
    generationConfig.maxOutputTokens = GEMINI_MAX_OUTPUT_TOKENS;
  }
  return {
    body: {
      systemInstruction: {
        parts: [
          {
            text: "You are a transcript compaction engine. Output only strict JSON matching the requested schema.",
          },
        ],
      },
      contents: [
        {
          role: "user",
          parts: [{ text: promptText }],
        },
      ],
      generationConfig,
    },
  };
}

function buildChatCompletionsRequestBody(promptText, stats) {
  const schema = createProviderSummarySchema(stats.records);
  const request = {
    body: {
      model: MODEL,
      messages: [
        {
          role: "system",
          content:
            "You are a transcript compaction engine. Output only strict JSON matching the requested schema.",
        },
        {
          role: "user",
          content: promptText,
        },
      ],
      stream: true,
      stream_options: {
        include_usage: true,
      },
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "claude_full_transcript_compaction",
          description: "Produce an evidence-grounded Claude Code transcript continuation handoff.",
          strict: true,
          schema,
        },
      },
      metadata: {
        codex_harness: "unifusion",
        request_kind: "full_transcript_compaction",
        transcript_sha256: stats.sha256,
        transcript_records: String(stats.records),
      },
    },
  };
  if (TEMPERATURE !== null) {
    request.body.temperature = TEMPERATURE;
  }
  if (CHAT_REASONING_EFFORT) {
    request.body.reasoning_effort = CHAT_REASONING_EFFORT;
  }
  return request;
}

function buildRequestBody(promptText, stats) {
  const family = PROVIDER_REGISTRY[PROVIDER].family;
  if (family === "gemini") return buildGeminiRequestBody(promptText, stats);
  if (family === "chat") return buildChatCompletionsRequestBody(promptText, stats);
  return buildCodexRequestBody(promptText, stats);
}

function providerEndpoint() {
  const reg = PROVIDER_REGISTRY[PROVIDER];
  if (reg.endpoint) return reg.endpoint();
  return CODEX_RESPONSES_URL;
}

function redactCodexRequestForLog(request, stats) {
  return {
    url: CODEX_RESPONSES_URL,
    method: "POST",
    headers: {
      Authorization: "Bearer <redacted>",
      "ChatGPT-Account-Id": "<redacted>",
      originator: CODEX_ORIGINATOR,
      "User-Agent": CODEX_USER_AGENT,
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      "session-id": request.ids.sessionId,
      "thread-id": request.ids.threadId,
      "x-client-request-id": request.ids.threadId,
      "x-codex-installation-id": request.ids.installationId,
      "x-codex-window-id": request.ids.windowId,
    },
    body: {
      ...request.body,
      input: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                "<full transcript omitted from redacted request; see before transcript artifact> " +
                JSON.stringify({
                  inputPath: stats.inputPath,
                  sha256: stats.sha256,
                  bytes: stats.bytes,
                  records: stats.records,
                  approxTokens: stats.approxTokens,
                }),
            },
          ],
        },
      ],
    },
  };
}

function redactGeminiRequestForLog(request, stats) {
  return {
    url: providerEndpoint(),
    method: "POST",
    headers: {
      "x-goog-api-key": "<redacted>",
      Accept: "text/event-stream",
      "Content-Type": "application/json",
    },
    body: {
      ...request.body,
      contents: [
        {
          role: "user",
          parts: [
            {
              text:
                "<full transcript omitted from redacted request; see before transcript artifact> " +
                JSON.stringify({
                  inputPath: stats.inputPath,
                  sha256: stats.sha256,
                  bytes: stats.bytes,
                  records: stats.records,
                  approxTokens: stats.approxTokens,
                }),
            },
          ],
        },
      ],
    },
  };
}

function redactChatCompletionsRequestForLog(request, stats) {
  return {
    url: providerEndpoint(),
    method: "POST",
    headers: {
      Authorization: "Bearer <redacted>",
      Accept: "text/event-stream",
      "Content-Type": "application/json",
    },
    body: {
      ...request.body,
      messages: request.body.messages.map((message) =>
        message.role === "user"
          ? {
              ...message,
              content:
                "<full transcript omitted from redacted request; see before transcript artifact> " +
                JSON.stringify({
                  inputPath: stats.inputPath,
                  sha256: stats.sha256,
                  bytes: stats.bytes,
                  records: stats.records,
                  approxTokens: stats.approxTokens,
                }),
            }
          : message
      ),
    },
  };
}

function redactRequestForLog(request, stats) {
  const family = PROVIDER_REGISTRY[PROVIDER].family;
  if (family === "gemini") return redactGeminiRequestForLog(request, stats);
  if (family === "chat") return redactChatCompletionsRequestForLog(request, stats);
  return redactCodexRequestForLog(request, stats);
}

function parseSse(raw) {
  const events = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    let eventName = null;
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) continue;
    const data = dataLines.join("\n");
    if (data === "[DONE]") {
      events.push({ type: "done_sentinel", event: eventName });
      continue;
    }
    try {
      const parsed = JSON.parse(data);
      if (eventName && parsed && typeof parsed === "object" && !parsed.event) parsed.event = eventName;
      events.push(parsed);
    } catch {
      events.push({ type: "unparsed", event: eventName, data });
    }
  }
  return events;
}

function collectOutputText(events) {
  let deltaText = "";
  let doneText = "";
  let completedText = "";
  for (const event of events) {
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      deltaText += event.delta;
    }
    if (event.type === "response.output_text.done" && typeof event.text === "string") {
      doneText += event.text;
    }
    if (event.type === "response.output_item.done") {
      const item = event.item;
      if (item?.type === "message" && Array.isArray(item.content)) {
        for (const part of item.content) {
          if (part.type === "output_text" && typeof part.text === "string") doneText += part.text;
        }
      }
    }
    if (event.type === "response.completed") {
      const output = event.response?.output;
      if (Array.isArray(output)) {
        for (const item of output) {
          if (item?.type !== "message" || !Array.isArray(item.content)) continue;
          for (const part of item.content) {
            if (part.type === "output_text" && typeof part.text === "string") {
              completedText += part.text;
            }
          }
        }
      }
    }
  }
  return (deltaText || doneText || completedText).trim();
}

function collectGeminiOutputText(events) {
  let text = "";
  for (const event of events) {
    text += geminiDeltaText(event);
  }
  return text.trim();
}

function geminiDeltaText(event) {
  if (!event || typeof event !== "object") return "";
  let text = "";
  for (const candidate of event.candidates || []) {
    for (const part of candidate.content?.parts || []) {
      if (typeof part.text === "string") text += part.text;
    }
  }
  return text;
}

function codexDeltaText(event) {
  return event?.type === "response.output_text.delta" && typeof event.delta === "string"
    ? event.delta
    : "";
}

function chatCompletionsDeltaText(event) {
  let text = "";
  for (const choice of event?.choices || []) {
    const delta = choice.delta?.content;
    if (typeof delta === "string") text += delta;
    else if (Array.isArray(delta)) {
      for (const part of delta) {
        if (typeof part?.text === "string") text += part.text;
      }
    }
  }
  return text;
}

function collectChatCompletionsOutputText(events) {
  let text = "";
  for (const event of events) text += chatCompletionsDeltaText(event);
  return text.trim();
}

function streamAdapter() {
  const family = PROVIDER_REGISTRY[PROVIDER].family;
  if (family === "gemini") {
    return {
      deltaText: geminiDeltaText,
      collectOutputText: collectGeminiOutputText,
      isCompleted: (event) =>
        (event?.candidates || []).some((candidate) => typeof candidate.finishReason === "string"),
      isFailure: (event) => Boolean(event?.error),
      failureError: (event) => event?.error || event,
      usage: (events) => [...events].reverse().find((event) => event?.usageMetadata)?.usageMetadata ?? null,
      responseId: () => null,
    };
  }
  if (family === "chat") {
    return {
      deltaText: chatCompletionsDeltaText,
      collectOutputText: collectChatCompletionsOutputText,
      isCompleted: (event) =>
        event?.type === "done_sentinel" ||
        (event?.choices || []).some((choice) => typeof choice.finish_reason === "string"),
      isFailure: (event) => Boolean(event?.error),
      failureError: (event) => event?.error || event,
      usage: (events) => [...events].reverse().find((event) => event?.usage)?.usage ?? null,
      responseId: (events) => events.find((event) => typeof event?.id === "string")?.id ?? null,
    };
  }
  return {
    deltaText: codexDeltaText,
    collectOutputText: collectOutputText,
    isCompleted: (event) => event?.type === "response.completed",
    isFailure: (event) => event?.type === "response.failed" || event?.type === "error",
    failureError: (event) => event?.response?.error || event?.error || event,
    usage: (events) =>
      events.find((event) => event.type === "response.completed")?.response?.usage ?? null,
    responseId: (events) =>
      events.find((event) => event.type === "response.completed")?.response?.id ?? null,
  };
}

function parseSseBlock(block) {
  const lines = block.split(/\r?\n/);
  let eventName = null;
  const dataLines = [];
  for (const line of lines) {
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return null;
  const data = dataLines.join("\n");
  if (data === "[DONE]") return { type: "done_sentinel", event: eventName };
  try {
    const parsed = JSON.parse(data);
    if (eventName && parsed && typeof parsed === "object" && !parsed.event) parsed.event = eventName;
    return parsed;
  } catch {
    return { type: "unparsed", event: eventName, data };
  }
}

function writeAndClose(stream) {
  return new Promise((resolve, reject) => {
    stream.end(() => resolve());
    stream.on("error", reject);
  });
}

async function streamResponseBody(response, paths, adapter = streamAdapter()) {
  if (!response.body) {
    const raw = await response.text();
    await writeFile(paths.rawResponsePath, raw);
    const events = parseSse(raw);
    const outputText = adapter.collectOutputText(events);
    await writeFile(paths.eventsPath, stringifyEventsJsonl(events));
    await writeFile(paths.modelOutputPath, outputText + "\n");
    return { raw, events, outputText };
  }

  const rawStream = createWriteStream(paths.rawResponsePath);
  const eventsStream = createWriteStream(paths.eventsPath);
  const outputStream = createWriteStream(paths.modelOutputPath);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let raw = "";
  let buffer = "";
  let outputText = "";
  let deltaEvents = 0;
  let lastProgressAt = Date.now();
  let lastLiveWriteAt = 0;
  let liveWritePromise = Promise.resolve();

  function writeLiveSnapshot(status, force = false) {
    if (!paths.snapshotPath || !paths.livePath) return;
    const now = Date.now();
    if (!force && now - lastLiveWriteAt < 1000) return;
    lastLiveWriteAt = now;
    const snapshot = {
      status,
      events: events.length,
      delta_events: deltaEvents,
      output_chars: outputText.length,
      output_tail: outputText.slice(-4000),
      updated_at: new Date().toISOString(),
    };
    const live = [
      "# Compaction Stream",
      "",
      "- status: " + snapshot.status,
      "- events: " + snapshot.events,
      "- delta events: " + snapshot.delta_events,
      "- output chars: " + snapshot.output_chars,
      "",
      "## Partial JSON Tail",
      "",
      "```json",
      snapshot.output_tail,
      "```",
      "",
    ].join("\n");
    liveWritePromise = Promise.all([
      writeFile(paths.snapshotPath, JSON.stringify(snapshot, null, 2) + "\n"),
      writeFile(paths.livePath, live),
    ]).catch(() => {});
  }

  function consumeBlock(block) {
    const event = parseSseBlock(block);
    if (!event) return;
    events.push(event);
    eventsStream.write(JSON.stringify(event) + "\n");
    const delta = adapter.deltaText(event);
    if (delta) {
      deltaEvents += 1;
      outputText += delta;
      outputStream.write(delta);
      if (liveOutput) process.stderr.write(delta);
      writeLiveSnapshot("streaming");
    }
    if (adapter.isCompleted(event)) {
      process.stderr.write(
        "\n[compact-stream] response.completed events=" +
          events.length +
          " delta_events=" +
          deltaEvents +
          "\n"
      );
      writeLiveSnapshot("completed", true);
    }
    const now = Date.now();
    if (now - lastProgressAt > 15000) {
      lastProgressAt = now;
      process.stderr.write(
        "\n[compact-stream] events=" +
          events.length +
          " delta_events=" +
          deltaEvents +
          " output_chars=" +
          outputText.length +
          "\n"
      );
      writeLiveSnapshot("streaming", true);
    }
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    raw += chunk;
    rawStream.write(chunk);
    buffer += chunk;

    while (true) {
      const match = buffer.match(/\r?\n\r?\n/);
      if (!match || match.index === undefined) break;
      const block = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      consumeBlock(block);
    }
  }

  const tail = decoder.decode();
  if (tail) {
    raw += tail;
    rawStream.write(tail);
    buffer += tail;
  }
  if (buffer.trim().length > 0) consumeBlock(buffer);

  await Promise.all([writeAndClose(rawStream), writeAndClose(eventsStream), writeAndClose(outputStream)]);
  writeLiveSnapshot("done", true);
  await liveWritePromise;
  if (liveOutput && outputText.length > 0) process.stderr.write("\n");
  return { raw, events, outputText: outputText.trim() };
}

function validateSummary(value, lineHashArtifacts) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "result is not an object";
  const requiredStrings = ["current_work", "optional_next_step"];
  for (const key of requiredStrings) {
    if (typeof value[key] !== "string" || value[key].trim().length === 0) return key + " missing";
  }
  const requiredArrays = [
    "summary_blocks",
    "rules_and_invariants",
    "plans_and_task_state",
    "primary_request_and_intent",
    "key_technical_concepts",
    "files_and_code_sections",
    "errors_and_fixes",
    "problem_solving",
    "pending_tasks",
    "promises_made",
    "source_lines_used",
  ];
  for (const key of requiredArrays) {
    if (!Array.isArray(value[key])) return key + " is not an array";
  }
  if (!value.source_integrity || typeof value.source_integrity !== "object") {
    return "source_integrity missing";
  }
  if (typeof value.source_integrity.transcript_sha256 !== "string") {
    return "source_integrity.transcript_sha256 missing";
  }
  if (typeof value.source_integrity.transcript_lines_seen !== "number") {
    return "source_integrity.transcript_lines_seen missing";
  }
  if (value.source_integrity.verbatim_span_grounded !== true) {
    return "source_integrity.verbatim_span_grounded is not true";
  }
  if (typeof value.source_integrity.limitations !== "string") {
    return "source_integrity.limitations missing";
  }
  if (value.summary_blocks.length === 0) return "summary_blocks is empty";
  const maxLine = lineHashArtifacts.entries.length;
  const validateSourceSpans = (label, sourceSpans) => {
    if (!Array.isArray(sourceSpans) || sourceSpans.length === 0) {
      return label + ".source_spans missing";
    }
    for (const [spanIdx, span] of sourceSpans.entries()) {
      if (!span || typeof span !== "object" || Array.isArray(span)) {
        return label + ".source_spans[" + spanIdx + "] is not an object";
      }
      for (const key of ["start_line", "end_line"]) {
        const line = span[key];
        if (!Number.isInteger(line)) {
          return label + ".source_spans[" + spanIdx + "]." + key + " is not an integer";
        }
        if (line < 1 || line > maxLine) {
          return label + ".source_spans[" + spanIdx + "]." + key + " out of range: " + line;
        }
      }
      if (span.start_line > span.end_line) {
        return label + ".source_spans[" + spanIdx + "] start_line is after end_line";
      }
    }
    return null;
  };
  for (const [idx, item] of value.summary_blocks.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return "summary_blocks[" + idx + "] is not an object";
    }
    if (typeof item.section !== "string" || item.section.trim().length === 0) {
      return "summary_blocks[" + idx + "].section missing";
    }
    if (!["paragraph", "bullet"].includes(item.format)) {
      return "summary_blocks[" + idx + "].format invalid";
    }
    if (typeof item.body !== "string") {
      return "summary_blocks[" + idx + "].body missing";
    }
    if (item.body.trim().length === 0) {
      return "summary_blocks[" + idx + "].body missing";
    }
    if (item.format === "bullet") {
      if (/^\s*[-*]\s+/.test(item.body)) {
        return "summary_blocks[" + idx + "].body must not include a leading bullet marker";
      }
      if (item.body.includes("\n")) {
        return "summary_blocks[" + idx + "].body must be a single bullet item";
      }
    }
    const sourceSpanError = validateSourceSpans("summary_blocks[" + idx + "]", item.source_spans);
    if (sourceSpanError) return sourceSpanError;
  }
  for (const [idx, item] of value.rules_and_invariants.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return "rules_and_invariants[" + idx + "] is not an object";
    }
    if (typeof item.rule !== "string" || item.rule.trim().length === 0) {
      return "rules_and_invariants[" + idx + "].rule missing";
    }
    if (!["current", "superseded", "removed"].includes(item.status)) {
      return "rules_and_invariants[" + idx + "].status invalid";
    }
    const sourceSpanError = validateSourceSpans("rules_and_invariants[" + idx + "]", item.source_spans);
    if (sourceSpanError) return sourceSpanError;
  }
  for (const [idx, item] of value.plans_and_task_state.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return "plans_and_task_state[" + idx + "] is not an object";
    }
    if (typeof item.item !== "string" || item.item.trim().length === 0) {
      return "plans_and_task_state[" + idx + "].item missing";
    }
    if (!["done", "active", "pending", "blocked", "superseded"].includes(item.status)) {
      return "plans_and_task_state[" + idx + "].status invalid";
    }
    const sourceSpanError = validateSourceSpans("plans_and_task_state[" + idx + "]", item.source_spans);
    if (sourceSpanError) return sourceSpanError;
  }
  for (const [idx, item] of value.promises_made.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return "promises_made[" + idx + "] is not an object";
    }
    if (typeof item.promise !== "string" || item.promise.trim().length === 0) {
      return "promises_made[" + idx + "].promise missing";
    }
    if (!["done", "active", "pending", "blocked", "superseded", "removed"].includes(item.status)) {
      return "promises_made[" + idx + "].status invalid";
    }
    const sourceSpanError = validateSourceSpans("promises_made[" + idx + "]", item.source_spans);
    if (sourceSpanError) return sourceSpanError;
  }
  for (const line of value.source_lines_used) {
    if (!Number.isInteger(line)) return "source_lines_used contains non-integer line: " + line;
    if (line < 1 || line > maxLine) return "source_lines_used contains out-of-range line: " + line;
  }
  return null;
}

// Coerce summary blocks that cannot pass local validation as-is into a
// paragraph: code_block format is not accepted, and a "bullet" body with a
// leading marker or an embedded newline is not a single bullet item. Strict
// provider schemas cannot enforce these string-content rules, so the model can
// legitimately return such a block; coercing here keeps one malformed block
// from aborting the whole run. Idempotent: re-running finds nothing to relax.
function relaxSummaryBlockFormats(summary) {
  let bulletFormatRelaxed = 0;
  let codeBlockDowngraded = 0;
  for (const item of summary.summary_blocks || []) {
    if (item?.format === "code_block") {
      item.format = "paragraph";
      if (typeof item.body !== "string" || item.body.trim().length === 0) {
        item.body = "Verbatim source material is preserved in the cited source spans.";
      }
      delete item.language;
      codeBlockDowngraded += 1;
    }
    if (item?.format !== "bullet" || typeof item.body !== "string") continue;
    if (/^\s*[-*]\s+/.test(item.body) || item.body.includes("\n")) {
      item.format = "paragraph";
      bulletFormatRelaxed += 1;
    }
  }
  return { bulletFormatRelaxed, codeBlockDowngraded };
}

function normalizeLegacySummary(summary) {
  let ruleStatusDefaulted = 0;
  let promisesMadeDefaulted = 0;
  for (const item of summary.rules_and_invariants || []) {
    if (typeof item.status !== "string") {
      item.status = "current";
      ruleStatusDefaulted += 1;
    }
  }
  const { bulletFormatRelaxed, codeBlockDowngraded } = relaxSummaryBlockFormats(summary);
  if (!Array.isArray(summary.promises_made)) {
    summary.promises_made = [];
    promisesMadeDefaulted = 1;
  }
  return { ruleStatusDefaulted, promisesMadeDefaulted, bulletFormatRelaxed, codeBlockDowngraded };
}

function compactText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function pushUniqueText(list, value, max = 12) {
  const text = compactText(value);
  if (!text || list.includes(text)) return;
  if (list.length < max) list.push(text);
}

function anchoredTextItems(summary) {
  const items = [];
  for (const item of summary.rules_and_invariants || []) {
    if (Array.isArray(item.source_spans)) items.push(item.rule);
  }
  for (const item of summary.plans_and_task_state || []) {
    if (Array.isArray(item.source_spans)) items.push(item.item);
  }
  for (const item of summary.promises_made || []) {
    if (Array.isArray(item.source_spans)) items.push(item.promise);
  }
  for (const item of summary.summary_blocks || []) {
    if (Array.isArray(item.source_spans)) items.push(item.body);
  }
  return items.map(compactText).filter(Boolean);
}

function deriveKeyConcepts(texts) {
  const concepts = [];
  const stop = new Set([
    "the",
    "and",
    "for",
    "with",
    "from",
    "that",
    "this",
    "into",
    "after",
    "current",
    "summary",
    "state",
  ]);
  for (const text of texts) {
    const inline = text.match(/`([^`\n]{2,80})`/g) || [];
    for (const value of inline) pushUniqueText(concepts, value.slice(1, -1), 16);
    const tokens = text.match(/\b[A-Za-z][A-Za-z0-9_.:/-]{2,}\b/g) || [];
    for (const token of tokens) {
      const normalized = token.toLowerCase();
      if (stop.has(normalized)) continue;
      if (!/[A-Z0-9_./:-]/.test(token) && token.length < 10) continue;
      pushUniqueText(concepts, token, 16);
    }
  }
  return concepts;
}

function deriveFileSections(texts) {
  const sections = [];
  const seen = new Set();
  const pathPattern = /(?:^|[\s("'`])((?:\/[A-Za-z0-9._~+@:%-]+)+|(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.@:%+-]+)(?=$|[\s)"'`,;:])/g;
  for (const text of texts) {
    let match;
    while ((match = pathPattern.exec(text)) !== null) {
      const path = match[1];
      if (seen.has(path)) continue;
      seen.add(path);
      sections.push({
        path,
        why_it_matters: "Referenced by anchored compaction state.",
        details: text.slice(0, 240),
      });
      if (sections.length >= 20) return sections;
    }
  }
  return sections;
}

function deriveCompatibilityFields(summary) {
  const texts = anchoredTextItems(summary);
  const activePlans = (summary.plans_and_task_state || []).filter((item) =>
    ["active", "pending", "blocked"].includes(item.status)
  );

  const primary = [];
  pushUniqueText(primary, summary.current_work, 8);
  for (const item of activePlans) pushUniqueText(primary, item.item, 8);
  pushUniqueText(primary, summary.optional_next_step, 8);

  const pending = [];
  for (const item of activePlans) pushUniqueText(pending, item.item, 12);
  pushUniqueText(pending, summary.optional_next_step, 12);

  const errorPattern = /\b(error|failed|failure|bug|fix|fixed|blocked|exception|regression|root cause)\b/i;
  const solvingPattern = /\b(decision|because|root cause|discovered|verified|implemented|active|pending|blocked|next)\b/i;
  const errors = [];
  const solving = [];
  for (const text of texts) {
    if (errorPattern.test(text)) pushUniqueText(errors, text, 12);
    if (solvingPattern.test(text)) pushUniqueText(solving, text, 12);
  }
  for (const item of summary.plans_and_task_state || []) pushUniqueText(solving, item.item, 12);

  return {
    primary_request_and_intent: primary,
    key_technical_concepts: deriveKeyConcepts(texts),
    files_and_code_sections: deriveFileSections(texts),
    errors_and_fixes: errors,
    problem_solving: solving,
    pending_tasks: pending,
  };
}

function normalizeDerivedSummaryFields(summary) {
  // Relax non-conforming block formats before validation. This runs on every
  // response (fresh provider output and reloaded output alike), so a single
  // multi-line bullet no longer aborts a fresh run with a hard validation fail.
  const { bulletFormatRelaxed, codeBlockDowngraded } = relaxSummaryBlockFormats(summary);
  const compatibilityArraysDefaulted = [];
  const derived = deriveCompatibilityFields(summary);
  for (const key of COMPATIBILITY_ARRAY_KEYS) {
    if (!Array.isArray(summary[key])) compatibilityArraysDefaulted.push(key);
    summary[key] = derived[key];
  }
  summary.source_lines_used = collectSourceLines(summary);
  return {
    compatibilityArraysDefaulted,
    sourceLinesDerived: summary.source_lines_used.length,
    bulletFormatRelaxed,
    codeBlockDowngraded,
  };
}

function collectSourceLines(summary) {
  const lines = new Set();
  for (const item of allAnchoredItems(summary)) {
    for (const span of item.source_spans || []) {
      lines.add(span.start_line);
      lines.add(span.end_line);
    }
  }
  return [...lines].sort((a, b) => a - b);
}

function lineHash(lineHashArtifacts, lineNumber) {
  return lineHashArtifacts.entries[lineNumber - 1]?.hash;
}

function stableJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function extractContentPartText(part, meta = {}) {
  if (!part || typeof part !== "object") return "";
  if (part.type === "tool_use") return formatToolUse(part, meta);
  if (part.type === "tool_result") {
    const formatted = formatToolResultContent(part.content, { ...meta, toolName: "EditResult" });
    return formatted ? "[tool_result]\n" + formatted : "";
  }
  if (typeof part.text === "string") return part.text;
  if (typeof part.content === "string") return part.content;
  if (Array.isArray(part.content)) {
    const nested = part.content
      .map((nestedPart) => extractContentPartText(nestedPart, meta))
      .filter((text) => text.length > 0);
    if (nested.length > 0) return nested.join("\n\n");
  }
  if (part.input && typeof part.input === "object") return formatToolUse({ type: "tool_use", name: "unknown", input: part.input }, meta);
  return "";
}

function extractRecordText(record, meta = {}) {
  if (!record || typeof record !== "object") return "";
  if (typeof record.content === "string") return record.content;
  if (typeof record.message?.content === "string") return record.message.content;
  if (Array.isArray(record.message?.content)) {
    const texts = record.message.content
      .map((part) => extractContentPartText(part, meta))
      .filter((text) => text.length > 0);
    if (texts.length > 0) return texts.join("\n\n");
  }
  if (record.toolUseResult) {
    const formatted = formatToolResultContent(
      typeof record.toolUseResult === "string" ? record.toolUseResult : JSON.stringify(record.toolUseResult),
      { ...meta, toolName: "EditResult" }
    );
    return formatted || stableJson(record.toolUseResult);
  }
  if (record.attachment) return JSON.stringify(record.attachment, null, 2);
  if (typeof record.lastPrompt === "string" && record.lastPrompt.length > 0) return record.lastPrompt;
  if (typeof record.aiTitle === "string" && record.aiTitle.length > 0) return record.aiTitle;
  if (typeof record.summary === "string" && record.summary.length > 0) return record.summary;
  const cx = codexPayloadText(record);
  if (cx) return cx;
  return "";
}

// A record is citable only if the harness can rehydrate non-empty text from it.
// This is the single predicate that defines the model's citation space: the
// transcript shown to the model is filtered to citable records and renumbered,
// so the schema bound [1, N] structurally guarantees every cited span rehydrates.
function isCitableRecord(record) {
  return extractRecordText(record).length > 0;
}

function filterCitableTranscript(transcript) {
  const kept = logicalJsonlLines(transcript).filter((line) => isCitableRecord(JSON.parse(line)));
  return kept.length > 0 ? kept.join("\n") + "\n" : "";
}

function normalizeCodeText(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n+$/g, "");
}

function buildExtractedSpanText(slice, startLine) {
  let extractedText = "";
  const textSegments = [];
  for (const [idx, record] of slice.entries()) {
    const lineNumber = startLine + idx;
    const text = extractRecordText(record, {
      lineNumber,
      cwdPrefix: transcriptCwdPrefix || null,
    });
    if (text.length === 0) continue;
    if (textSegments.length > 0) extractedText += "\n\n";
    const start = extractedText.length;
    extractedText += text;
    const end = extractedText.length;
    textSegments.push({
      line: startLine + idx,
      record_sha256: sha256Text(JSON.stringify(record)),
      char_range: [start, end],
      extracted_text_sha256: sha256Text(text),
      char_count: text.length,
    });
  }
  return { extractedText, textSegments };
}

function sourceLineForCharRange(textSegments, charRange) {
  const start = charRange[0];
  const segment = textSegments.find(
    (candidate) => start >= candidate.char_range[0] && start <= candidate.char_range[1]
  );
  return segment?.line || null;
}

function extractCodeCapsules(spanId, extractedText, textSegments) {
  const capsules = [];
  const fencePattern = /(^|\n)(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)(\n\2)(?=\n|$)/g;
  let match;
  while ((match = fencePattern.exec(extractedText)) !== null) {
    const blockStart = match.index + match[1].length;
    const bodyStart = blockStart + match[2].length + match[3].length + 1;
    const body = match[4];
    const bodyEnd = bodyStart + body.length;
    const language = match[3].trim().split(/\s+/).filter(Boolean)[0] || "text";
    capsules.push({
      id: spanId + "-code-" + String(capsules.length + 1).padStart(3, "0"),
      source_span_id: spanId,
      source_line: sourceLineForCharRange(textSegments, [bodyStart, bodyEnd]),
      language,
      char_range: [bodyStart, bodyEnd],
      fence_char_range: [blockStart, bodyEnd + match[5].length],
      exact_text_sha256: sha256Text(body),
      normalized_code_sha256: sha256Text(normalizeCodeText(body)),
      exact_text: body,
    });
  }
  return capsules;
}

function deriveRehydrationSpans(summary, records, lineHashArtifacts) {
  const spans = [];
  let spanId = 1;
  for (const [anchoredIndex, block] of allAnchoredItems(summary).entries()) {
    for (const [spanIndex, span] of (block.source_spans || []).entries()) {
      const slice = records.slice(span.start_line - 1, span.end_line);
      const currentSpanId = "span-" + String(spanId).padStart(4, "0");
      const { extractedText, textSegments } = buildExtractedSpanText(slice, span.start_line);
      if (textSegments.length === 0) {
        throw new Error(
          "invariant violation: citable span " +
            currentSpanId +
            " (lines " +
            span.start_line +
            "-" +
            span.end_line +
            ") rehydrated to empty text; the citable-transcript filter was bypassed"
        );
      }
      const codeCapsules = extractCodeCapsules(currentSpanId, extractedText, textSegments);
      const editCapsules = extractEditCapsules(currentSpanId, extractedText);
      spans.push({
        span_id: currentSpanId,
        block_index: block.summary_block_index ?? anchoredIndex,
        anchored_index: anchoredIndex,
        span_index: spanIndex,
        section: block.section,
        format: block.format,
        authority: "raw-source",
        source_kind: "jsonl_record",
        record_range: [span.start_line, span.end_line],
        char_range: [0, extractedText.length],
        text_segments: textSegments,
        code_capsules: codeCapsules,
        edit_capsules: editCapsules,
        start_line: span.start_line,
        end_line: span.end_line,
        start_hash: lineHash(lineHashArtifacts, span.start_line),
        end_hash: lineHash(lineHashArtifacts, span.end_line),
        raw_slice_sha256: sha256Text(slice.map((record) => JSON.stringify(record)).join("\n")),
        extracted_text_sha256: sha256Text(extractedText),
        validation: "verified",
        extracted_text: extractedText,
        raw_jsonl: slice.map((record) => JSON.stringify(record)).join("\n"),
      });
      spanId += 1;
    }
  }
  return spans;
}

function renderRehydratedSummary(summary, spans) {
  const lines = [summary.summary_markdown.trim(), "", "## Rehydration Spans"];
  for (const span of spans) {
    const editCount = (span.edit_capsules || []).length;
    lines.push(
      "- " +
        span.span_id +
        " | " +
        span.section +
        " | lines " +
        span.start_line +
        "-" +
        span.end_line +
        " | chars " +
        span.char_range[0] +
        "-" +
        span.char_range[1] +
        " | code capsules " +
        (span.code_capsules || []).length +
        (editCount ? " | edit capsules " + editCount : "")
    );
    const fenceLang =
      isFormattedEditText(span.extracted_text) || /@@tool EditResult/.test(span.extracted_text) ? "diff" : "";
    lines.push("```" + fenceLang);
    lines.push(span.extracted_text.replace(/\n$/, ""));
    lines.push("```");
    for (const code of span.code_capsules || []) {
      lines.push(
        "- code " +
          code.id +
          " | " +
          code.language +
          " | chars " +
          code.char_range[0] +
          "-" +
          code.char_range[1] +
          " | exact_sha256 " +
          code.exact_text_sha256
      );
    }
    for (const edit of span.edit_capsules || []) {
      lines.push(
        "- edit " +
          edit.id +
          " | " +
          edit.file_path +
          " | +" +
          edit.lines_added +
          " -" +
          edit.lines_removed +
          " | diff_sha256 " +
          edit.diff_sha256
      );
    }
    lines.push("");
  }
  return lines.join("\n").trim() + "\n";
}

function escapeXmlAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderCollapsedUserMessage(message) {
  const text = message.text || "";
  const shouldCollapse = text.length > userMessageCollapseAt;
  const head = shouldCollapse ? text.slice(0, userMessageHeadChars) : text;
  const tail = shouldCollapse ? text.slice(Math.max(text.length - userMessageTailChars, userMessageHeadChars)) : "";
  const omitted = shouldCollapse ? Math.max(text.length - head.length - tail.length, 0) : 0;
  const lines = [
    '<user-message line="' +
      message.line +
      '" chars="' +
      message.char_count +
      '" sha256="' +
      escapeXmlAttr(message.sha256) +
      '">',
    head.replace(/\n$/, ""),
  ];
  if (shouldCollapse) {
    lines.push("");
    lines.push(
      "[... omitted " +
        omitted +
        " chars; full text in user-messages.json line " +
        message.line +
        " ...]"
    );
    lines.push("");
    lines.push(tail.replace(/^\n/, "").replace(/\n$/, ""));
  }
  lines.push("</user-message>");
  return {
    rendered: lines.join("\n"),
    collapsed: shouldCollapse,
    omitted_chars: omitted,
    rendered_chars: lines.join("\n").length,
  };
}

function handoffUserMessageIdentity(message) {
  if (message.uuid) return "uuid:" + message.uuid;
  if (message.originalUuid) return "uuid:" + message.originalUuid;
  return [
    "sha",
    message.sha256 || "",
    String(message.char_count || 0),
    message.timestamp || "",
  ].join(":");
}

function mergeHandoffUserMessages(carriedMessages, currentMessages) {
  const byKey = new Map();
  for (const message of carriedMessages) {
    byKey.set(handoffUserMessageIdentity(message), message);
  }
  for (const message of currentMessages) {
    const keys = [
      message.uuid ? "uuid:" + message.uuid : null,
      message.originalUuid ? "uuid:" + message.originalUuid : null,
      handoffUserMessageIdentity(message),
    ].filter(Boolean);
    for (const key of keys) byKey.delete(key);
    byKey.set(handoffUserMessageIdentity(message), message);
  }
  return [...byKey.values()];
}

function handoffUserMessageBody(message) {
  if (typeof message.rendered_text === "string" && message.rendered_text.trim()) {
    return message.rendered_text.trim();
  }
  const text = message.text || "";
  if (text.length <= userMessageCollapseAt) return text.trim();
  const head = text.slice(0, userMessageHeadChars).replace(/\n$/, "");
  const tail = text
    .slice(Math.max(text.length - userMessageTailChars, userMessageHeadChars))
    .replace(/^\n/, "")
    .replace(/\n$/, "");
  const omitted = Math.max(text.length - head.length - tail.length, 0);
  return [head, "", "[... omitted " + omitted + " chars ...]", "", tail].join("\n").trim();
}

function renderHandoffUserMessage(message) {
  const attrs = {
    source: message.source || "current",
    line: message.line,
    original_line: message.original_line || message.line,
    chars: message.char_count || 0,
    sha256: message.sha256 || "",
    record_sha256: message.record_sha256 || "",
    source_transcript_sha256: message.source_transcript_sha256 || "",
    uuid: message.uuid || "",
    original_uuid: message.originalUuid || "",
    timestamp: message.timestamp || "",
  };
  const attrText = Object.entries(attrs)
    .filter(([, value]) => value !== null && value !== undefined && String(value) !== "")
    .map(([key, value]) => key + '="' + escapeXmlAttr(value) + '"')
    .join(" ");
  return "<user-message " + attrText + ">\n" + handoffUserMessageBody(message) + "\n</user-message>";
}

function handoffUserMessagePriority(message, index, total) {
  const text = message.text || "";
  const kind = inferUserIntentKind(text);
  const priority = inferUserIntentPriority(kind, text);
  const priorityRank = {
    must_keep: 0,
    high: 1,
    normal: 2,
    low: 3,
  }[priority] ?? 2;
  return {
    kind,
    priority,
    rank: priorityRank,
    recency: total - index,
  };
}

function selectHandoffUserMessages(messages) {
  const selected = [];
  let tokenEstimate = 0;
  let lineCount = 0;
  const maxMessages = handoffUserMessageLimit;
  const maxTokens = handoffUserMessageTokenBudget;
  const maxLines = handoffUserMessageLineLimit;
  const candidates = messages
    .map((message, index) => ({
      message,
      index,
      priority: handoffUserMessagePriority(message, index, messages.length),
    }))
    .sort((a, b) => a.priority.rank - b.priority.rank || b.index - a.index);

  if (maxMessages === 0) {
    return {
      selected: [],
      total: messages.length,
      omitted_older: messages.length,
      omitted_total: messages.length,
      token_estimate: 0,
      line_count: 0,
      limits: {
        count: maxMessages,
        token_budget: maxTokens,
        line_limit: maxLines,
      },
    };
  }

  for (const candidate of candidates) {
    if (selected.length >= maxMessages) {
      break;
    }
    const rendered = renderHandoffUserMessage(candidate.message);
    const renderedTokens = Math.ceil(rendered.length / 4);
    const renderedLines = rendered.split(/\r?\n/).length;
    const wouldExceedTokens = maxTokens > 0 && tokenEstimate + renderedTokens > maxTokens;
    const wouldExceedLines = maxLines > 0 && lineCount + renderedLines > maxLines;
    if (selected.length > 0 && (wouldExceedTokens || wouldExceedLines)) {
      continue;
    }
    selected.push({
      ...candidate.message,
      selection_priority: candidate.priority.priority,
      selection_kind: candidate.priority.kind,
      selection_rank: candidate.priority.rank,
      rendered,
      rendered_tokens: renderedTokens,
      rendered_lines: renderedLines,
      original_index: candidate.index,
    });
    tokenEstimate += renderedTokens;
    lineCount += renderedLines;
  }

  selected.sort((a, b) => a.original_index - b.original_index);
  const omittedTotal = Math.max(messages.length - selected.length, 0);
  return {
    selected,
    total: messages.length,
    omitted_older: omittedTotal,
    omitted_total: omittedTotal,
    token_estimate: tokenEstimate,
    line_count: lineCount,
    limits: {
      count: maxMessages,
      token_budget: maxTokens,
      line_limit: maxLines,
    },
  };
}

function renderHandoffUserMessagesSection(selection) {
  if (!selection.selected.length) return "";
  const lines = [
    "## User Messages",
    "",
    "Harness-extracted user-authored messages. These are not model summaries. They are carried forward across compactions and bounded by count, token, and line limits.",
    "",
    '<user-message-ledger version="' +
      HANDOFF_USER_MESSAGE_LEDGER_VERSION +
      '" total="' +
      selection.total +
      '" selected="' +
      selection.selected.length +
      '" omitted_older="' +
      selection.omitted_older +
      '" token_estimate="' +
      selection.token_estimate +
      '" line_count="' +
      selection.line_count +
      '" count_limit="' +
      selection.limits.count +
      '" token_budget="' +
      selection.limits.token_budget +
      '" line_limit="' +
      selection.limits.line_limit +
      '">',
  ];
  for (const message of selection.selected) lines.push(message.rendered);
  lines.push("</user-message-ledger>");
  return lines.join("\n");
}

function inferUserIntentKind(text) {
  const normalized = String(text || "").toLowerCase();
  if (/\b(do not|don't|never|must|always|required|require|preserve|keep|avoid|only)\b/.test(normalized)) {
    return "constraint";
  }
  if (/\b(secret|credential|token|key|password|safety|security|private)\b/.test(normalized)) {
    return "safety";
  }
  if (/\b(actually|correction|instead|scratch that|not that|supersede)\b/.test(normalized)) {
    return "correction";
  }
  if (/\b(prefer|preference|style|tone|format)\b/.test(normalized)) {
    return "preference";
  }
  return "request";
}

function inferUserIntentPriority(kind, text) {
  const normalized = String(text || "").toLowerCase();
  if (kind === "safety") return "must_keep";
  if (/\b(do not|don't|never|must|required|preserve|keep)\b/.test(normalized)) return "high";
  if (kind === "correction" || kind === "constraint") return "high";
  if (kind === "preference") return "normal";
  return "normal";
}

function buildUserIntentEvents(selection) {
  return selection.selected.map((message, idx) => {
    const text = message.text || "";
    const kind = inferUserIntentKind(text);
    return {
      id: "intent-" + String(idx + 1).padStart(4, "0"),
      kind,
      status: "current",
      priority: inferUserIntentPriority(kind, text),
      supersedes: [],
      source: {
        line: message.line,
        original_line: message.original_line || message.line,
        uuid: message.uuid || null,
        original_uuid: message.originalUuid || null,
        timestamp: message.timestamp || null,
        record_sha256: message.record_sha256 || null,
        source_transcript_sha256: message.source_transcript_sha256 || null,
        source: message.source || "current",
      },
      text_sha256: message.sha256 || sha256Text(text),
      message_sha256: message.sha256 || sha256Text(text),
      char_count: message.char_count || text.length,
      rendered_text: handoffUserMessageBody(message),
      text,
    };
  });
}

function buildEvidenceCapsules(rehydratedSpans) {
  return rehydratedSpans.map((span) => ({
    id: "ev-" + span.span_id.replace(/^span-/, ""),
    span_id: span.span_id,
    authority: span.authority || "raw-source",
    source_kind: span.source_kind || "jsonl_record",
    record_range: span.record_range || [span.start_line, span.end_line],
    char_range: span.char_range || [0, String(span.extracted_text || "").length],
    text_segments: (span.text_segments || []).map((segment) => ({
      line: segment.line,
      record_sha256: segment.record_sha256,
      char_range: segment.char_range,
      extracted_text_sha256: segment.extracted_text_sha256,
      char_count: segment.char_count,
    })),
    code_capsules: (span.code_capsules || []).map((code) => ({
      id: code.id,
      source_span_id: code.source_span_id,
      source_line: code.source_line,
      language: code.language,
      char_range: code.char_range,
      fence_char_range: code.fence_char_range,
      exact_text_sha256: code.exact_text_sha256,
      normalized_code_sha256: code.normalized_code_sha256,
    })),
    start_line: span.start_line,
    end_line: span.end_line,
    start_hash: span.start_hash,
    end_hash: span.end_hash,
    raw_slice_sha256: span.raw_slice_sha256,
    extracted_text_sha256: span.extracted_text_sha256,
    validation: span.validation || "verified",
    section: span.section,
    format: span.format,
    block_index: span.block_index,
    span_index: span.span_index,
  }));
}

function buildHandoffState({
  summary,
  stats,
  run,
  beforePath,
  rehydratedSpans,
  handoffUserMessageSelection,
}) {
  const evidenceCapsules = buildEvidenceCapsules(rehydratedSpans);
  return {
    schema: HANDOFF_STATE_SCHEMA,
    version: 1,
    checkpoint_id: "compact-" + stats.sha256.slice(0, 16) + "-" + run.finishedAt.replace(/[:.]/g, "-"),
    created_at: run.finishedAt,
    source_transcripts: [
      {
        original_path: stats.inputPath,
        artifact_path: beforePath,
        transcript_sha256: stats.sha256,
        records: stats.records,
        bytes: stats.bytes,
        renderer: stats.transcriptRenderer,
      },
    ],
    active_state: {
      current_objective: summary.current_work,
      next_step: summary.optional_next_step,
      open_questions: [],
      blockers: (summary.plans_and_task_state || [])
        .filter((item) => item.status === "blocked")
        .map((item) => item.item),
    },
    summary_markdown: summary.summary_markdown,
    summary_blocks: summary.summary_blocks,
    rules_and_invariants: summary.rules_and_invariants,
    plans_and_task_state: summary.plans_and_task_state,
    promises_made: summary.promises_made,
    primary_request_and_intent: summary.primary_request_and_intent,
    key_technical_concepts: summary.key_technical_concepts,
    files_and_code_sections: summary.files_and_code_sections,
    errors_and_fixes: summary.errors_and_fixes,
    problem_solving: summary.problem_solving,
    pending_tasks: summary.pending_tasks,
    user_intent_events: buildUserIntentEvents(handoffUserMessageSelection),
    evidence_capsules: evidenceCapsules,
    source_integrity: summary.source_integrity,
    artifact_manifest: "handoff-manifest.json",
    rendered_handoff: "handoff.md",
  };
}

function isIntegerRange(value) {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    Number.isInteger(value[0]) &&
    Number.isInteger(value[1]) &&
    value[0] <= value[1]
  );
}

function isSha256Hex(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function validateHandoffState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return "handoff state is not an object";
  if (state.schema !== HANDOFF_STATE_SCHEMA) return "handoff state schema invalid";
  if (!Array.isArray(state.user_intent_events)) return "handoff state user_intent_events missing";
  if (!Array.isArray(state.evidence_capsules)) return "handoff state evidence_capsules missing";
  for (const [idx, event] of state.user_intent_events.entries()) {
    const label = "handoff state user_intent_events[" + idx + "]";
    if (typeof event.id !== "string" || !event.id) return label + ".id missing";
    if (!["request", "correction", "safety", "preference", "constraint"].includes(event.kind)) {
      return label + ".kind invalid";
    }
    if (!["current", "superseded", "removed"].includes(event.status)) return label + ".status invalid";
    if (!["must_keep", "high", "normal", "low"].includes(event.priority)) {
      return label + ".priority invalid";
    }
    if (!Array.isArray(event.supersedes)) return label + ".supersedes missing";
    if (!event.source || typeof event.source !== "object") return label + ".source missing";
    if (!Number.isInteger(event.source.line) || event.source.line < 1) return label + ".source.line invalid";
    if (typeof event.source.record_sha256 !== "string" || !event.source.record_sha256) {
      return label + ".source.record_sha256 missing";
    }
    if (typeof event.text_sha256 !== "string" || !event.text_sha256) return label + ".text_sha256 missing";
    if (typeof event.text !== "string" || !event.text) return label + ".text missing";
    if (event.text_sha256 !== sha256Text(event.text)) return label + ".text_sha256 mismatch";
  }
  for (const [idx, capsule] of state.evidence_capsules.entries()) {
    const label = "handoff state evidence_capsules[" + idx + "]";
    if (typeof capsule.id !== "string" || !capsule.id) return label + ".id missing";
    if (capsule.authority !== "raw-source") return label + ".authority invalid";
    if (capsule.source_kind !== "jsonl_record") return label + ".source_kind invalid";
    if (!Array.isArray(capsule.record_range) || capsule.record_range.length !== 2) {
      return label + ".record_range invalid";
    }
    if (!isIntegerRange(capsule.char_range)) return label + ".char_range invalid";
    if (!Array.isArray(capsule.text_segments)) return label + ".text_segments missing";
    if (capsule.text_segments.length === 0) return label + ".text_segments empty";
    for (const [segmentIdx, segment] of capsule.text_segments.entries()) {
      const segmentLabel = label + ".text_segments[" + segmentIdx + "]";
      if (!Number.isInteger(segment.line) || segment.line < 1) return segmentLabel + ".line invalid";
      if (!isSha256Hex(segment.record_sha256)) return segmentLabel + ".record_sha256 invalid";
      if (!isIntegerRange(segment.char_range)) return segmentLabel + ".char_range invalid";
      if (segment.char_range[0] < capsule.char_range[0] || segment.char_range[1] > capsule.char_range[1]) {
        return segmentLabel + ".char_range outside capsule";
      }
      if (!isSha256Hex(segment.extracted_text_sha256)) {
        return segmentLabel + ".extracted_text_sha256 invalid";
      }
    }
    if (!Array.isArray(capsule.code_capsules)) return label + ".code_capsules missing";
    for (const [codeIdx, code] of capsule.code_capsules.entries()) {
      const codeLabel = label + ".code_capsules[" + codeIdx + "]";
      if (typeof code.id !== "string" || !code.id) return codeLabel + ".id missing";
      if (code.source_span_id !== capsule.span_id) return codeLabel + ".source_span_id invalid";
      if (code.source_line !== null && (!Number.isInteger(code.source_line) || code.source_line < 1)) {
        return codeLabel + ".source_line invalid";
      }
      if (typeof code.language !== "string" || !code.language) return codeLabel + ".language missing";
      if (!isIntegerRange(code.char_range)) return codeLabel + ".char_range invalid";
      if (!isIntegerRange(code.fence_char_range)) return codeLabel + ".fence_char_range invalid";
      if (code.char_range[0] < capsule.char_range[0] || code.char_range[1] > capsule.char_range[1]) {
        return codeLabel + ".char_range outside capsule";
      }
      if (!isSha256Hex(code.exact_text_sha256)) return codeLabel + ".exact_text_sha256 invalid";
      if (!isSha256Hex(code.normalized_code_sha256)) return codeLabel + ".normalized_code_sha256 invalid";
    }
    if (!isSha256Hex(capsule.raw_slice_sha256)) return label + ".raw_slice_sha256 invalid";
    if (!isSha256Hex(capsule.extracted_text_sha256)) return label + ".extracted_text_sha256 invalid";
    if (capsule.validation !== "verified") return label + ".validation invalid";
  }
  return null;
}

function markdownFenceFor(text) {
  const ticks = String(text || "").match(/`{3,}/g) || [];
  const maxTicks = ticks.reduce((max, run) => Math.max(max, run.length), 2);
  return "`".repeat(maxTicks + 1);
}

function pushFencedText(lines, text, info = "text") {
  const fence = markdownFenceFor(text);
  lines.push(fence + info);
  lines.push(String(text || "").replace(/\n$/, ""));
  lines.push(fence);
}

function pushUniqueLiteral(list, seen, value, maxLength = 180) {
  const literal = compactText(value).slice(0, maxLength).trim();
  if (literal.length < 2 || seen.has(literal)) return;
  seen.add(literal);
  list.push(literal);
}

function collectEvidenceLiterals(rehydratedSpans, pattern) {
  const values = [];
  const seen = new Set();
  for (const span of rehydratedSpans || []) {
    const text = span.extracted_text || "";
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      pushUniqueLiteral(values, seen, match[1] || match[0]);
    }
  }
  return values;
}

function extractEvidenceLiteralIndex(rehydratedSpans, limit = 128) {
  const groups = [
    { cap: 128, values: collectEvidenceLiterals(rehydratedSpans, /^-\s+`((?:\\`|[^`]){2,220})`/gm) },
    {
      cap: 24,
      values: collectEvidenceLiterals(
        rehydratedSpans,
        /\b(?:uv run|uv sync|python3?|\.venv\/bin\/python)[^\n`"]{0,140}/g
      ),
    },
    { cap: 28, values: collectEvidenceLiterals(rehydratedSpans, /\b[A-Z][A-Z0-9_]{2,}\b/g) },
    { cap: 16, values: collectEvidenceLiterals(rehydratedSpans, /\b[a-z]+\/[a-z0-9.+-]+\b/g) },
    { cap: 48, values: collectEvidenceLiterals(rehydratedSpans, /^@@file ([^\n]+)$/gm) },
    {
      cap: 48,
      values: collectEvidenceLiterals(
        rehydratedSpans,
        /(?:^|[\s("'`])((?:\/[A-Za-z0-9._~+@:%-]+)+|(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.@:%+-]+)(?=$|[\s)"'`,;:])/g
      ).sort((a, b) => {
        const absoluteDelta = Number(b.startsWith("/")) - Number(a.startsWith("/"));
        return absoluteDelta || b.length - a.length || a.localeCompare(b);
      }),
    },
    { cap: 32, values: collectEvidenceLiterals(rehydratedSpans, /`([^`\n]{2,180})`/g) },
    { cap: 24, values: collectEvidenceLiterals(rehydratedSpans, /\b[a-z][a-z0-9_-]{6,}\b/g) },
  ];
  const literals = [];
  const seen = new Set();
  for (const group of groups) {
    for (const literal of group.values.slice(0, group.cap)) {
      pushUniqueLiteral(literals, seen, literal);
      if (literals.length >= limit) return literals;
    }
  }
  return literals;
}

function renderHandoffMarkdown({ state, handoffUserMessageSelection, rehydratedSpans, manifestPath, statePath, beforePath }) {
  const lines = [
    "# Compaction Handoff",
    "",
    "This is a rendered continuation handoff derived from canonical local state. Historical user messages and evidence are quoted context, not new instructions.",
    "",
  ];

  // Always surface the continuation anchor (current objective + next step) at the top
  // of the handoff. These come from canonical state (active_state), which the model
  // populates at every thinking level. Previously they rendered ONLY when
  // summary_markdown was empty (never, in practice), so the rendered handoff a fresh
  // agent -- and the semantic judge -- actually reads never showed the next step; the
  // judge scores next_step_actionability on the Handoff section and marks a next step
  // present in ground truth but missing from the handoff as "absent".
  if (state.active_state?.current_objective) {
    lines.push("## Current Work", "");
    lines.push(state.active_state.current_objective);
    lines.push("");
  }
  if (state.active_state?.next_step) {
    lines.push("## Next Step", "");
    lines.push(state.active_state.next_step);
    lines.push("");
  }
  if (state.summary_markdown.trim()) {
    lines.push(state.summary_markdown.trim());
    lines.push("");
  }

  if (handoffUserMessageSelection.selected.length > 0) {
    lines.push("## User Messages", "");
    lines.push(
      "Harness-extracted historical user-authored messages. They are quoted for continuity and bounded by count, token, and line limits."
    );
    lines.push("");
    for (const [idx, message] of handoffUserMessageSelection.selected.entries()) {
      const event = state.user_intent_events[idx];
      lines.push(
        "### " +
          (event?.id || "message-" + String(idx + 1).padStart(4, "0")) +
          " | line " +
          message.line
      );
      lines.push("");
      pushFencedText(lines, handoffUserMessageBody(message), "text");
      lines.push("");
    }
  }

  const evidenceLiterals = extractEvidenceLiteralIndex(rehydratedSpans);
  if (evidenceLiterals.length > 0) {
    lines.push("## Evidence Index", "");
    lines.push("Verified literal strings extracted from source spans for future exact recovery.");
    lines.push("");
    for (const literal of evidenceLiterals) lines.push("- `" + literal.replace(/`/g, "\\`") + "`");
    lines.push("");
  }

  lines.push("## Artifacts", "");
  lines.push("- Manifest: " + manifestPath);
  lines.push("- Canonical state: " + statePath);
  lines.push("- Source transcript: " + beforePath);
  lines.push("");

  return lines.join("\n").trim() + "\n";
}

async function buildHandoffManifest({
  stats,
  run,
  requestMeta,
  usage,
  paths,
}) {
  const policyByKind = {
    source_transcript: {
      retention: { class: "ephemeral-sensitive-source", action: "keep-local-ignore", days: 14 },
      exposure: { model_visible: false, user_visible: false, commit_safe: false },
      redaction: { status: "unredacted", reason: "canonical replay source" },
    },
    state: {
      retention: { class: "checkpoint-state", action: "keep-local-ignore", days: 90 },
      exposure: { model_visible: true, user_visible: true, commit_safe: false },
      redaction: { status: "unredacted", reason: "canonical handoff state may include user text" },
    },
    rendered_handoff: {
      retention: { class: "handoff-view", action: "keep-local-ignore", days: 90 },
      exposure: { model_visible: true, user_visible: true, commit_safe: false },
      redaction: { status: "bounded", reason: "user messages are collapsed and evidence is indexed" },
    },
    user_messages: {
      retention: { class: "ephemeral-sensitive-source", action: "keep-local-ignore", days: 14 },
      exposure: { model_visible: false, user_visible: false, commit_safe: false },
      redaction: { status: "unredacted", reason: "deterministic full user-message sidecar" },
    },
    request_log: {
      retention: { class: "redacted-request-log", action: "keep-local-ignore", days: 30 },
      exposure: { model_visible: false, user_visible: true, commit_safe: false },
      redaction: { status: "redacted", reason: "credentials and full prompt are omitted" },
    },
    events: {
      retention: { class: "provider-output-sensitive", action: "keep-local-ignore", days: 30 },
      exposure: { model_visible: false, user_visible: false, commit_safe: false },
      redaction: { status: "unredacted", reason: "provider stream may contain model output and metadata" },
    },
    model_output: {
      retention: { class: "provider-output-sensitive", action: "keep-local-ignore", days: 30 },
      exposure: { model_visible: false, user_visible: false, commit_safe: false },
      redaction: { status: "unredacted", reason: "provider output replay source" },
    },
  };
  const defaultPolicy = {
    retention: { class: "derived-artifact", action: "keep-local-ignore", days: 90 },
    exposure: { model_visible: false, user_visible: true, commit_safe: false },
    redaction: { status: "derived", reason: "derived from source transcript and model output" },
  };
  const artifactSpecs = [
    ["source_transcript", paths.beforePath, "raw-source", true],
    ["state", paths.handoffStatePath, "validated-local", true],
    ["rendered_handoff", paths.handoffMdPath, "validated-local", false],
    ["summary", paths.summaryJsonPath, "model-derived", false],
    ["summary_markdown", paths.summaryMdPath, "model-derived", false],
    ["timeline", paths.timelineMdPath, "model-derived", false],
    ["user_messages", paths.userMessagesPath, "raw-source", true],
    ["evidence", paths.rehydratedSpansPath, "raw-source", true],
    ["rehydrated_summary", paths.rehydratedSummaryPath, "raw-source", false],
    ["line_hashes", paths.lineHashesPath, "raw-source", false],
    ["request_log", paths.requestLogPath, "local-log", true],
    ["events", paths.eventsPath, "provider-output", true],
    ["model_output", paths.modelOutputPath, "provider-output", true],
  ];
  const artifacts = [];
  for (const [kind, path, authority, sensitive] of artifactSpecs) {
    const policy = policyByKind[kind] || defaultPolicy;
    artifacts.push({
      kind,
      path: basename(path),
      absolute_path: path,
      sha256: await sha256File(path),
      authority,
      sensitive,
      retention: policy.retention,
      exposure: policy.exposure,
      redaction: policy.redaction,
    });
  }
  return {
    schema: HANDOFF_MANIFEST_SCHEMA,
    version: 1,
    checkpoint_id: "compact-" + stats.sha256.slice(0, 16) + "-" + run.finishedAt.replace(/[:.]/g, "-"),
    created_at: run.finishedAt,
    source: {
      transcript_path: paths.beforePath,
      original_input_path: stats.inputPath,
      transcript_sha256: stats.sha256,
      records: stats.records,
      bytes: stats.bytes,
      renderer: stats.transcriptRenderer,
    },
    provider: {
      provider: PROVIDER,
      model: MODEL,
      endpoint: requestMeta.endpoint,
      renderer_policy: {
        transcript_renderer: stats.transcriptRenderer,
        tool_output_compress_strategy: toolOutputCompressStrategy,
        tool_output_compress_after: toolOutputCompressAfter,
        tool_output_compress_min_chars: toolOutputCompressMinChars,
        tool_output_compress_head_chars: toolOutputCompressHeadChars,
        tool_output_compress_tail_chars: toolOutputCompressTailChars,
      },
      schema_fingerprint: sha256Text(JSON.stringify(createProviderSummarySchema(stats.records))),
      local_validation_schema: LOCAL_VALIDATION_SCHEMA,
      local_validation_fingerprint: sha256Text(JSON.stringify(createLocalValidationSpec())),
      usage: usage || null,
    },
    artifact_policy: {
      schema: "artifact-retention-policy.v1",
      default_action: "keep-local-ignore",
      commit_policy: "do not commit raw runs or sensitive artifacts; commit concise benchmark reports only",
      provider_outputs: "store local model outputs as evidence artifacts; do not treat provider state as portable",
    },
    artifacts,
    validation: {
      schema: "passed",
      artifact_hashes: "passed",
      source_integrity: "passed",
      timeline_order: "passed",
      user_intent_events: "passed",
      evidence_capsules: "passed",
    },
  };
}

function anchorStart(item) {
  let min = Infinity;
  for (const span of item.source_spans || []) {
    if (Number.isInteger(span.start_line)) min = Math.min(min, span.start_line);
  }
  return Number.isFinite(min) ? min : 1000000000;
}

function renderTimelineModelItem(item) {
  if (item.kind === "rule") return "- [" + item.status + "] " + item.rule.trim();
  if (item.kind === "plan") return "- [" + item.status + "] " + item.item.trim();
  if (item.kind === "promise") return "- [" + item.status + "] " + item.promise.trim();
  if (item.format === "bullet") return "- " + item.body.trim();
  return item.body.trim();
}

function buildTimelineUnits(summary, userMessages) {
  const units = [];
  for (const message of userMessages) {
    units.push({ kind: "user_message", line: message.line, priority: 0, message });
  }
  for (const item of timelineAnchoredItems(summary)) {
    units.push({
      kind: "model_item",
      line: anchorStart(item),
      priority: 1,
      item,
    });
  }
  units.sort((a, b) => a.line - b.line || a.priority - b.priority);
  return units;
}

function validateTimelineUnits(summary, userMessages) {
  const units = buildTimelineUnits(summary, userMessages);
  let previousLine = 0;
  for (const [idx, unit] of units.entries()) {
    if (!Number.isInteger(unit.line) || unit.line < 1) {
      return "timeline unit " + idx + " has invalid line";
    }
    if (unit.line < previousLine) {
      return "timeline units are not monotonic at index " + idx;
    }
    previousLine = unit.line;
  }
  return null;
}

function renderTimelineSummary(summary, userMessages) {
  const units = buildTimelineUnits(summary, userMessages);

  const lines = ["# Compaction Timeline", ""];
  for (const unit of units) {
    if (unit.kind === "user_message") {
      const collapsed = renderCollapsedUserMessage(unit.message);
      lines.push("## line " + String(unit.line).padStart(6, "0") + " | user");
      lines.push("");
      lines.push(collapsed.rendered);
      lines.push("");
      continue;
    }
    lines.push(
      "## line " +
        String(unit.line).padStart(6, "0") +
        " | " +
        unit.item.section
    );
    lines.push("");
    lines.push(renderTimelineModelItem(unit.item));
    lines.push("");
  }
  return lines.join("\n").trim() + "\n";
}

function renderSummaryBlocks(summary) {
  const lines = [];
  let currentSection = null;
  for (const [blockIndex, item] of summary.summary_blocks.entries()) {
    const section = item.section.trim();
    if (section !== currentSection) {
      if (lines.length > 0) lines.push("");
      lines.push("## " + section);
      currentSection = section;
    }
    if (item.format === "bullet") {
      lines.push("- " + item.body.trim());
      continue;
    }
    lines.push(item.body.trim());
  }
  const currentRules = (summary.rules_and_invariants || []).filter((item) => item.status === "current");
  if (currentRules.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("## Rules And Invariants");
    for (const item of currentRules) {
      lines.push("- " + item.rule.trim());
    }
    lines.push("");
  }
  if (Array.isArray(summary.plans_and_task_state) && summary.plans_and_task_state.length > 0) {
    if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
    lines.push("## Plans And Task State");
    for (const item of summary.plans_and_task_state) {
      lines.push("- [" + item.status + "] " + item.item.trim());
    }
    lines.push("");
  }
  if (Array.isArray(summary.promises_made) && summary.promises_made.length > 0) {
    if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
    lines.push("## Promises Made");
    for (const item of summary.promises_made) {
      lines.push("- [" + item.status + "] " + item.promise.trim());
    }
    lines.push("");
  }
  return lines.join("\n");
}

function collectSourceHashes(summary, lineHashArtifacts) {
  const hashes = new Set();
  for (const item of allAnchoredItems(summary)) {
    for (const span of item.source_spans || []) {
      hashes.add(lineHash(lineHashArtifacts, span.start_line));
      hashes.add(lineHash(lineHashArtifacts, span.end_line));
    }
  }
  return [...hashes].filter(Boolean);
}

function allAnchoredItems(summary) {
  const items = [];
  for (const item of summary.rules_and_invariants || []) {
    items.push({
      section: "Rules And Invariants",
      format: "bullet",
      source_spans: item.source_spans,
    });
  }
  for (const item of summary.plans_and_task_state || []) {
    items.push({
      section: "Plans And Task State",
      format: "bullet",
      source_spans: item.source_spans,
    });
  }
  for (const item of summary.promises_made || []) {
    items.push({
      section: "Promises Made",
      format: "bullet",
      source_spans: item.source_spans,
    });
  }
  for (const [idx, item] of (summary.summary_blocks || []).entries()) {
    items.push({ ...item, summary_block_index: idx });
  }
  return items;
}

function timelineAnchoredItems(summary) {
  const items = [];
  for (const item of summary.rules_and_invariants || []) {
    items.push({
      kind: "rule",
      section: "Rules And Invariants",
      format: "bullet",
      rule: item.rule,
      status: item.status,
      source_spans: item.source_spans,
    });
  }
  for (const item of summary.plans_and_task_state || []) {
    items.push({
      kind: "plan",
      section: "Plans And Task State",
      format: "bullet",
      item: item.item,
      status: item.status,
      source_spans: item.source_spans,
    });
  }
  for (const item of summary.promises_made || []) {
    items.push({
      kind: "promise",
      section: "Promises Made",
      format: "bullet",
      promise: item.promise,
      status: item.status,
      source_spans: item.source_spans,
    });
  }
  for (const [idx, item] of (summary.summary_blocks || []).entries()) {
    items.push({
      kind: "summary_block",
      ...item,
      summary_block_index: idx,
    });
  }
  return items;
}

function validateUserMessageArtifacts(userMessages) {
  let previousLine = 0;
  for (const [idx, message] of userMessages.entries()) {
    if (!Number.isInteger(message.line) || message.line <= 0) {
      return "userMessages[" + idx + "].line invalid";
    }
    if (message.line <= previousLine) {
      return "userMessages line order is not strictly increasing at index " + idx;
    }
    previousLine = message.line;
    if (typeof message.text !== "string" || message.text.length === 0) {
      return "userMessages[" + idx + "].text missing";
    }
    const textHash = createHash("sha256").update(message.text).digest("hex");
    if (message.sha256 !== textHash) {
      return "userMessages[" + idx + "].sha256 does not match text";
    }
    if (message.char_count !== message.text.length) {
      return "userMessages[" + idx + "].char_count does not match text length";
    }
    const collapsed = renderCollapsedUserMessage(message);
    if (message.text.length > userMessageCollapseAt && !collapsed.collapsed) {
      return "userMessages[" + idx + "] should be collapsed";
    }
    const maxCollapsedChars = userMessageHeadChars + userMessageTailChars + 600;
    if (collapsed.collapsed && collapsed.rendered_chars > maxCollapsedChars) {
      return "userMessages[" + idx + "] collapsed render exceeds max expected size";
    }
  }
  return null;
}

function validateNoRawUserMessageDumps(summary, userMessages) {
  const modelText = JSON.stringify(summary);
  for (const message of userMessages) {
    if (message.text.length <= userMessageCollapseAt) continue;
    const probe = message.text.slice(0, Math.min(userMessageHeadChars, 700)).trim();
    if (probe.length < 200) continue;
    if (modelText.includes(probe)) {
      return "model output contains raw long user-message prefix from line " + message.line;
    }
  }
  return null;
}

function cloneForTail(record) {
  return JSON.parse(JSON.stringify(record));
}

function shouldPreserveTailRecord(record) {
  if (!record || typeof record !== "object") return false;
  if (record.isCompactSummary) return false;
  return record.type === "user" || record.type === "assistant" || record.type === "system" || record.type === "attachment";
}

function buildCompactedTranscript({
  records,
  summary,
  stats,
  run,
  beforePath,
  handoffUserMessageSelection,
  handoffState,
  handoffMarkdown,
  handoffManifestPath,
  handoffStatePath,
  handoffMdPath,
}) {
  const baseMetadata = compactBaseMetadata(pickBaseMetadata(records));
  const boundaryUuid = safeUuid();
  const summaryUuid = safeUuid();
  const originalTailParent = extractLastUserUuid(records);

  const boundary = {
    parentUuid: originalTailParent,
    isSidechain: false,
    userType: baseMetadata.userType,
    cwd: baseMetadata.cwd,
    sessionId: baseMetadata.sessionId,
    version: baseMetadata.version,
    gitBranch: baseMetadata.gitBranch,
    type: "system",
    content: "Conversation compacted",
    uuid: boundaryUuid,
    timestamp: run.finishedAt,
    compactMetadata: {
      trigger: "manual",
      preTokens: stats.approxTokens,
      durationMs: run.durationMs,
      preservedSegment: "tail",
      preservedMessages: {
        requested: preserveTailCount,
        emitted: 0,
      },
      postTokens: Math.ceil(summary.summary_markdown.length / 4),
      externalCompact: true,
      compactProfile: "warp-guided-span-rehydration",
      wasSummarized: true,
      handoff: {
        schema: HANDOFF_POINTER_SCHEMA,
        manifestPath: handoffManifestPath,
        statePath: handoffStatePath,
        markdownPath: handoffMdPath,
      },
      userMessages: handoffUserMessageSelection
        ? {
            selected: handoffUserMessageSelection.selected.length,
            total: handoffUserMessageSelection.total,
            omittedOlder: handoffUserMessageSelection.omitted_older,
            tokenEstimate: handoffUserMessageSelection.token_estimate,
            lineCount: handoffUserMessageSelection.line_count,
            limits: handoffUserMessageSelection.limits,
          }
        : null,
      provider: PROVIDER,
      customSummaryInstructions: customSummaryInstructions.trim() || null,
      compactAndPrompt: compactAndPrompt.trim() || null,
      model: MODEL,
      transcriptRenderer,
      temperature: TEMPERATURE,
      serviceTier: PROVIDER_REGISTRY[PROVIDER].family === "codex" ? SERVICE_TIER : null,
      thinkingLevel: PROVIDER_REGISTRY[PROVIDER].family === "gemini" ? GEMINI_THINKING_LEVEL : null,
      thinkingConfig:
        PROVIDER_REGISTRY[PROVIDER].family === "gemini" ? geminiThinkingConfig(MODEL, GEMINI_THINKING_LEVEL) : null,
      sourceTranscriptSha256: stats.sha256,
    },
  };

  const summaryText = [
    "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.",
    "",
    "Summary:",
    handoffMarkdown.trim(),
    "",
    "Canonical handoff artifacts:",
    "- Manifest: " + handoffManifestPath,
    "- State: " + handoffStatePath,
    "- Rendered Markdown: " + handoffMdPath,
    "",
    "Full source transcript artifact:",
    beforePath,
    "",
    ...(compactAndPrompt.trim()
      ? ["Queued follow-up prompt after compaction:", compactAndPrompt.trim(), ""]
      : []),
    "Continue from the current work and optional next step captured in the summary. Treat the preserved tail records after this summary as extra local context only.",
  ].join("\n");
  boundary.compactMetadata.postTokens = Math.ceil(summaryText.length / 4);

  const summaryRecord = {
    parentUuid: boundaryUuid,
    isSidechain: false,
    userType: baseMetadata.userType,
    cwd: baseMetadata.cwd,
    sessionId: baseMetadata.sessionId,
    version: baseMetadata.version,
    gitBranch: baseMetadata.gitBranch,
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text: summaryText }],
    },
    isMeta: true,
    isCompactSummary: true,
    isVisibleInTranscriptOnly: true,
    handoff: {
      schema: HANDOFF_POINTER_SCHEMA,
      manifest_path: handoffManifestPath,
      state_path: handoffStatePath,
      markdown_path: handoffMdPath,
      user_intent_event_count: handoffState?.user_intent_events?.length || 0,
    },
    uuid: summaryUuid,
    timestamp: run.finishedAt,
  };

  const tailSource =
    preserveTailCount === 0 ? [] : records.filter(shouldPreserveTailRecord).slice(-preserveTailCount);
  const tail = [];
  let parentUuid = summaryUuid;
  for (const source of tailSource) {
    const copy = cloneForTail(source);
    copy.parentUuid = parentUuid;
    copy.uuid = safeUuid();
    copy.isExternalCompactPreservedTail = true;
    copy.originalUuid = source.uuid || null;
    copy.originalParentUuid = source.parentUuid || null;
    parentUuid = copy.uuid;
    tail.push(copy);
  }
  boundary.compactMetadata.preservedMessages.emitted = tail.length;
  return [boundary, summaryRecord, ...tail].map((record) => JSON.stringify(record)).join("\n") + "\n";
}

function stringifyEventsJsonl(events) {
  return events.map((event) => JSON.stringify(event)).join("\n") + "\n";
}

async function main() {
  if (process.argv.includes("--print-shared-prompt-markdown")) {
    console.log(buildSharedPromptMarkdown());
    return;
  }

  const rawTranscript = await readFile(inputPath, "utf8");
  const transcript = atifToClaudeJsonl(rawTranscript) ?? rawTranscript;
  const allRecords = parseJsonl(transcript);
  // Filter the transcript to citable records before numbering. Every record the
  // model can cite is then guaranteed to rehydrate to non-empty text, so an
  // empty evidence capsule is unrepresentable. records, lineHashArtifacts, and
  // the wrapped transcript all derive from the same filtered set, keeping the
  // line-number-as-array-index contract internally consistent.
  const citableTranscript = filterCitableTranscript(transcript);
  const records = parseJsonl(citableTranscript);
  if (records.length === 0) {
    console.error(
      "[compact] transcript yielded no extractable text (" +
        inputPath +
        "): empty or unsupported format. Failing closed."
    );
    process.exit(3);
  }
  const lineHashArtifacts = buildRecordArtifacts(citableTranscript);
  // Codex default-model switch, keyed on rendered transcript tokens: gpt-5.4-mini
  // under CODEX_MODEL_TOKEN_THRESHOLD (272k), else gpt-5.4. Registry-scoped (only
  // codex defines resolveModel) so other providers are untouched, and skipped when
  // the model was set explicitly. Runs before any consumer of MODEL.
  const codexResolveModel = PROVIDER_REGISTRY[PROVIDER].resolveModel;
  if (codexResolveModel && !MODEL_EXPLICIT) {
    const renderedTokens = await countRenderedTokens(
      lineHashArtifacts.wrappedTranscript,
      MODEL
    );
    MODEL = codexResolveModel(renderedTokens);
    process.stderr.write(
      "[codex model-switch] rendered_tokens=" +
        renderedTokens +
        " threshold=" +
        CODEX_MODEL_TOKEN_THRESHOLD +
        " model=" +
        MODEL +
        "\n"
    );
  }
  const sha256 = createHash("sha256").update(rawTranscript).digest("hex");
  const stats = {
    inputPath,
    sha256,
    bytes: Buffer.byteLength(rawTranscript),
    records: records.length,
    totalRecords: allRecords.length,
    nonCitableRecords: allRecords.length - records.length,
    approxTokens: Math.ceil(transcript.length / 4),
    userRecords: countUserMessages(records),
    transcriptRenderer,
  };
  if (rendererStatsReportPath) {
    const reportPath = resolve(rendererStatsReportPath);
    const markdown = renderRendererStatsMarkdown({
      inputPath,
      transcript,
      renderers: rendererStatsRenderers,
      generatedAt: startedAt,
    });
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, markdown);
    console.log(JSON.stringify({ ok: true, renderer_stats_report: reportPath }, null, 2));
    return;
  }
  const promptAdaptation = buildPromptAdaptations({
    provider: PROVIDER,
    model: MODEL,
    renderer: transcriptRenderer,
  });
  let promptText = buildFullTranscriptPrompt({
    wrappedTranscript: lineHashArtifacts.wrappedTranscript,
    stats,
    adaptationLines: ADAPT_PROMPT ? promptAdaptation.lines : [],
  });
  if (dumpPromptPath) await writeFile(resolve(dumpPromptPath), promptText);
  let request = buildRequestBody(promptText, stats);
  let bodyText = JSON.stringify(request.body);
  const endpoint = providerEndpoint();
  const compressesToolOutput = transcriptRenderer === "sentinel" || transcriptRenderer === "onto";
  const requestMeta = {
    provider: PROVIDER,
    endpoint,
    model: MODEL,
    ...(ADAPT_PROMPT ? { prompt_adaptations: promptAdaptation.applied } : {}),
    reask_until_pass: REASK_UNTIL_PASS,
    ...(REASK_UNTIL_PASS ? { reask_until_pass_source: REASK_UNTIL_PASS_SOURCE } : {}),
    max_reasks: MAX_REASKS,
    provider_schema_fingerprint: sha256Text(
      JSON.stringify(createProviderSummarySchema(stats.records))
    ),
    local_validation_schema: LOCAL_VALIDATION_SCHEMA,
    local_validation_fingerprint: sha256Text(JSON.stringify(createLocalValidationSpec())),
    service_tier: PROVIDER_REGISTRY[PROVIDER].family === "codex" ? SERVICE_TIER : null,
    reasoning_effort: PROVIDER_REGISTRY[PROVIDER].family === "codex" ? REASONING_EFFORT : null,
    temperature: TEMPERATURE,
    thinking_level: PROVIDER_REGISTRY[PROVIDER].family === "gemini" ? GEMINI_THINKING_LEVEL : null,
    thinking_config:
      PROVIDER_REGISTRY[PROVIDER].family === "gemini" ? request.body.generationConfig?.thinkingConfig || null : null,
    max_output_tokens:
      PROVIDER_REGISTRY[PROVIDER].family === "gemini" && Number.isFinite(GEMINI_MAX_OUTPUT_TOKENS)
        ? GEMINI_MAX_OUTPUT_TOKENS
        : null,
    inputPath,
    outDir,
    transcript_sha256: sha256,
    transcript_bytes: stats.bytes,
    transcript_records: stats.records,
    transcript_renderer: transcriptRenderer,
    estimated_char_div_4_tokens: stats.approxTokens,
    request_body_bytes: Buffer.byteLength(bodyText),
    wrapped_transcript_bytes: Buffer.byteLength(lineHashArtifacts.wrappedTranscript),
    wrapped_transcript_estimated_tokens: Math.ceil(lineHashArtifacts.wrappedTranscript.length / 4),
    live_output: liveOutput,
    preserve_tail: preserveTailCount,
    tool_output_compress_strategy: compressesToolOutput ? toolOutputCompressStrategy : null,
    tool_output_compress_after: compressesToolOutput ? toolOutputCompressAfter : null,
    tool_output_compress_min_chars: compressesToolOutput ? toolOutputCompressMinChars : null,
    tool_output_compress_head_chars: compressesToolOutput ? toolOutputCompressHeadChars : null,
    tool_output_compress_tail_chars: compressesToolOutput ? toolOutputCompressTailChars : null,
    tool_output_compressed_records:
      compressesToolOutput ? lineHashArtifacts.renderStats.compressedToolOutputRecords : null,
    tool_output_original_chars:
      compressesToolOutput ? lineHashArtifacts.renderStats.originalToolOutputChars : null,
    tool_output_rendered_chars:
      compressesToolOutput ? lineHashArtifacts.renderStats.renderedToolOutputChars : null,
    tool_output_omitted_chars:
      compressesToolOutput ? lineHashArtifacts.renderStats.omittedToolOutputChars : null,
    tool_use_compress_after: toolUseCompressAfter,
    tool_use_compress_min_chars: toolUseCompressMinChars,
    tool_use_compressed_records: lineHashArtifacts.renderStats.compressedToolUseRecords || null,
    tool_use_original_chars: lineHashArtifacts.renderStats.originalToolUseChars || null,
    tool_use_omitted_chars: lineHashArtifacts.renderStats.omittedToolUseChars || null,
    transcript_cwd_prefix: transcriptCwdPrefix || null,
    custom_summary_instructions: customSummaryInstructions.trim() || null,
    compact_and_prompt: compactAndPrompt.trim() || null,
    from_output: fromOutputPath ? resolve(fromOutputPath) : null,
    user_message_collapse_at: userMessageCollapseAt,
    user_message_head_chars: userMessageHeadChars,
    user_message_tail_chars: userMessageTailChars,
    handoff_user_message_limit: handoffUserMessageLimit,
    handoff_user_message_token_budget: handoffUserMessageTokenBudget,
    handoff_user_message_line_limit: handoffUserMessageLineLimit,
  };

  if (dryRun) {
    console.log(JSON.stringify({ ok: true, dry_run: true, request: requestMeta }, null, 2));
    console.log(JSON.stringify(redactRequestForLog(request, stats), null, 2));
    return;
  }

  await mkdir(outDir, { recursive: true });
  const beforePath = join(outDir, "before-" + basename(inputPath));
  const requestLogPath = join(outDir, "request.redacted.json");
  const lineHashesPath = join(outDir, "line-hashes.tsv");
  const rawResponsePath = join(outDir, "response.sse");
  const eventsPath = join(outDir, "events.jsonl");
  const modelOutputPath = join(outDir, "model-output.json");
  const snapshotPath = join(outDir, "snapshot.json");
  const livePath = join(outDir, "live.md");
  const summaryJsonPath = join(outDir, "summary.json");
  const summaryMdPath = join(outDir, "summary.md");
  const timelineMdPath = join(outDir, "summary.timeline.md");
  const userMessagesPath = join(outDir, "user-messages.json");
  const rehydratedSpansPath = join(outDir, "rehydrated-spans.json");
  const rehydratedSummaryPath = join(outDir, "summary.rehydrated.md");
  const handoffStatePath = join(outDir, "handoff-state.json");
  const handoffManifestPath = join(outDir, "handoff-manifest.json");
  const handoffMdPath = join(outDir, "handoff.md");
  const afterPath = join(outDir, "after-compact.jsonl");
  const resultPath = join(outDir, "result.json");

  await copyFile(inputPath, beforePath);
  await writeFile(lineHashesPath, lineHashArtifacts.tsv);
  await writeFile(requestLogPath, JSON.stringify(redactRequestForLog(request, stats), null, 2) + "\n");

  let events = [];
  let outputText = "";
  let loadedFromOutput = false;
  let summary;
  let reaskBest = null;
  let reaskFeedback = "";
  let requiredLiterals = [];
  if (FIXTURE_PATH) {
    try {
      const fixtureJson = JSON.parse(await readFile(resolve(FIXTURE_PATH), "utf8"));
      requiredLiterals = Array.isArray(fixtureJson.required_literals) ? fixtureJson.required_literals : [];
      process.stderr.write(
        "[reask literals] fixture " + resolve(FIXTURE_PATH) + " -> " + requiredLiterals.length + " required literal(s)\n"
      );
    } catch (error) {
      process.stderr.write("[reask literals] could not load fixture " + FIXTURE_PATH + ": " + error.message + "\n");
    }
  }
  for (let reaskAttempt = 0; ; reaskAttempt++) {
   if (reaskAttempt > 0) {
     promptText = buildFullTranscriptPrompt({
       wrappedTranscript: lineHashArtifacts.wrappedTranscript,
       stats,
       reaskFeedback,
       adaptationLines: ADAPT_PROMPT ? promptAdaptation.lines : [],
     });
     request = buildRequestBody(promptText, stats);
     bodyText = JSON.stringify(request.body);
   }
  if (fromOutputPath) {
    loadedFromOutput = true;
    const sourceOutputPath = resolve(fromOutputPath);
    outputText = (await readFile(sourceOutputPath, "utf8")).trim();
    await writeFile(rawResponsePath, "");
    await writeFile(eventsPath, "");
    await writeFile(modelOutputPath, outputText + "\n");
    await writeFile(
      snapshotPath,
      JSON.stringify(
        {
          status: "loaded_from_output",
          sourceOutputPath,
          output_chars: outputText.length,
          updated_at: new Date().toISOString(),
        },
        null,
        2
      ) + "\n"
    );
    await writeFile(
      livePath,
      [
        "# Compaction Stream",
        "",
        "- status: loaded_from_output",
        "- source output: " + sourceOutputPath,
        "- output chars: " + outputText.length,
        "",
      ].join("\n")
    );
  } else {
    const _reg = PROVIDER_REGISTRY[PROVIDER];
    if (_reg.resolveKey && !_reg.resolveKey()) {
      throw new Error(_reg.missingKeyMsg);
    }
    process.stderr.write("sending full transcript request: " + JSON.stringify(requestMeta) + "\n");

    const _family = _reg.family;
    const response =
      _family === "gemini"
        ? await fetch(endpoint, {
            method: "POST",
            headers: {
              "x-goog-api-key": _reg.resolveKey(),
              Accept: "text/event-stream",
              "Content-Type": "application/json",
            },
            body: bodyText,
          })
        : _family === "chat"
          ? await fetch(endpoint, {
              method: "POST",
              headers: {
                Authorization: "Bearer " + _reg.resolveKey(),
                Accept: "text/event-stream",
                "Content-Type": "application/json",
              },
              body: bodyText,
            })
        : await (async () => {
            const auth = await loadChatgptAuth();
            return fetch(endpoint, {
              method: "POST",
              headers: {
                Authorization: "Bearer " + auth.accessToken,
                "ChatGPT-Account-Id": auth.accountId,
                originator: CODEX_ORIGINATOR,
                "User-Agent": CODEX_USER_AGENT,
                Accept: "text/event-stream",
                "Content-Type": "application/json",
                "session-id": request.ids.sessionId,
                "thread-id": request.ids.threadId,
                "x-client-request-id": request.ids.threadId,
                "x-codex-installation-id": request.ids.installationId,
                "x-codex-window-id": request.ids.windowId,
              },
              body: bodyText,
            });
          })();

    const streamed = await streamResponseBody(response, {
      rawResponsePath,
      eventsPath,
      modelOutputPath,
      snapshotPath,
      livePath,
    });
    const raw = streamed.raw;

    if (!response.ok) {
      const failure = {
        ok: false,
        status: response.status,
        statusText: response.statusText,
        requestId: response.headers.get("x-request-id") || response.headers.get("x-goog-request-id"),
        cfRay: response.headers.get("cf-ray"),
        bodyPreview: raw.slice(0, 4000),
        request: requestMeta,
        artifacts: {
          beforePath,
          lineHashesPath,
          requestLogPath,
          rawResponsePath,
        },
      };
      await writeFile(join(outDir, "failure.json"), JSON.stringify(failure, null, 2) + "\n");
      console.error(JSON.stringify(failure, null, 2));
      process.exit(1);
    }

    events = streamed.events;
    const adapter = streamAdapter();
    outputText = streamed.outputText || adapter.collectOutputText(events);
    const failedEvent = events.find((event) => adapter.isFailure(event));
    if (failedEvent) {
      const failure = {
        ok: false,
        error: adapter.failureError(failedEvent),
        request: requestMeta,
        artifacts: {
          beforePath,
          lineHashesPath,
          requestLogPath,
          rawResponsePath,
          eventsPath,
          modelOutputPath,
          snapshotPath,
          livePath,
        },
      };
      await writeFile(join(outDir, "failure.json"), JSON.stringify(failure, null, 2) + "\n");
      console.error(JSON.stringify(failure, null, 2));
      process.exit(1);
    }
  }

  try {
    summary = JSON.parse(outputText);
  } catch (error) {
    // A truncated/invalid JSON payload is recoverable when reasks remain: the usual
    // cause is the provider cutting the output mid-string (Gemini finishReason
    // MAX_TOKENS once thinking eats the output budget), and a fatal exit here would
    // discard reasks that could succeed with a terser request. Reask with corrective
    // feedback instead; only the final attempt (no reasks left) stays fatal.
    if (!loadedFromOutput && reaskAttempt < MAX_REASKS) {
      reaskFeedback = buildTruncationReaskFeedback(error.message);
      process.stderr.write(
        "reask " +
          (reaskAttempt + 1) +
          "/" +
          MAX_REASKS +
          " (output not valid JSON: " +
          error.message +
          "): re-requesting with corrective feedback\n"
      );
      continue;
    }
    const failure = {
      ok: false,
      error: "output was not JSON: " + error.message,
      outputPreview: outputText.slice(0, 4000),
      request: requestMeta,
      artifacts: {
        beforePath,
        lineHashesPath,
        requestLogPath,
        rawResponsePath,
        eventsPath,
        modelOutputPath,
        snapshotPath,
        livePath,
      },
    };
    await writeFile(join(outDir, "failure.json"), JSON.stringify(failure, null, 2) + "\n");
    console.error(JSON.stringify(failure, null, 2));
    process.exit(1);
  }

  const reaskDensity =
    loadedFromOutput || (MAX_REASKS === 0 && !REASK_UNTIL_PASS)
      ? { pass: true, score: 1, shortfalls: [], feedback: "", metrics: {} }
      : evaluateHandoffDensity(summary, DENSITY_THRESHOLDS);
  // Required-literal gate: reproduce the exact rehydrated text the scorer reads
  // (renderRehydratedSummary over derived spans) and flag any required literal that
  // did not survive. A probe failure is treated pessimistically (all literals unmet)
  // so an unrehydratable attempt cannot masquerade as literal-complete.
  let missingLiterals = [];
  if (requiredLiterals.length && !loadedFromOutput && !(MAX_REASKS === 0 && !REASK_UNTIL_PASS)) {
    try {
      // Reproduce the scorer's rehydrated text exactly. The scorer reads
      // summary.rehydrated.md, which is produced post-loop as normalize ->
      // renderSummaryBlocks (sets summary_markdown) -> renderRehydratedSummary. Run
      // that same sequence on a CLONE so the real summary is untouched for the
      // post-loop processing that keeps the chosen attempt.
      const probeSummary = JSON.parse(JSON.stringify(summary));
      normalizeDerivedSummaryFields(probeSummary);
      probeSummary.summary_markdown = renderSummaryBlocks(probeSummary);
      const probeSpans = deriveRehydrationSpans(probeSummary, records, lineHashArtifacts);
      const probeRehydrated = renderRehydratedSummary(probeSummary, probeSpans);
      missingLiterals = requiredLiterals.filter((literal) => !probeRehydrated.includes(literal));
    } catch (error) {
      missingLiterals = requiredLiterals.slice();
      process.stderr.write(
        "[reask literals] probe rehydration failed, treating literals as unmet: " + error.message + "\n"
      );
    }
  }
  const reaskPass = reaskDensity.pass && missingLiterals.length === 0;
  const bestMissing = reaskBest ? reaskBest.missingLiterals.length : Infinity;
  if (
    !reaskBest ||
    missingLiterals.length < bestMissing ||
    (missingLiterals.length === bestMissing && reaskDensity.score >= reaskBest.density.score)
  ) {
    reaskBest = { summary, outputText, events, density: reaskDensity, missingLiterals };
  }
  if (reaskPass || loadedFromOutput) break;
  if (reaskAttempt >= MAX_REASKS) break;
  reaskFeedback = [reaskDensity.feedback, buildLiteralReaskFeedback(missingLiterals)]
    .filter(Boolean)
    .join("\n\n");
  process.stderr.write(
    "reask " +
      (reaskAttempt + 1) +
      "/" +
      MAX_REASKS +
      (REASK_UNTIL_PASS ? " (until-pass)" : "") +
      " (density " +
      JSON.stringify(reaskDensity.metrics) +
      (missingLiterals.length ? ", missing_literals=" + missingLiterals.length : "") +
      "): re-requesting with corrective feedback\n"
  );
  }
  summary = reaskBest.summary;
  outputText = reaskBest.outputText;
  events = reaskBest.events;
  if (
    !loadedFromOutput &&
    REASK_UNTIL_PASS &&
    MAX_REASKS > 0 &&
    (!reaskBest.density.pass || reaskBest.missingLiterals.length > 0)
  ) {
    const failure = {
      ok: false,
      error: "handoff density/literal gate did not pass after " + MAX_REASKS + " reask(s)",
      density: reaskBest.density,
      missing_literals: reaskBest.missingLiterals,
      thresholds: DENSITY_THRESHOLDS,
      request: requestMeta,
    };
    await writeFile(join(outDir, "failure.json"), JSON.stringify(failure, null, 2) + "\n");
    console.error(JSON.stringify(failure, null, 2));
    process.exit(1);
  }
  if (!loadedFromOutput && MAX_REASKS > 0) {
    await writeFile(modelOutputPath, outputText + "\n");
  }
  const legacyModelUserMessagesDiscarded = Object.prototype.hasOwnProperty.call(
    summary,
    "all_user_messages"
  )
    ? Array.isArray(summary.all_user_messages)
      ? summary.all_user_messages.length
      : true
    : 0;
  delete summary.all_user_messages;
  const legacySummaryNormalization = loadedFromOutput
    ? normalizeLegacySummary(summary)
    : { ruleStatusDefaulted: 0, promisesMadeDefaulted: 0, bulletFormatRelaxed: 0, codeBlockDowngraded: 0 };

  // Canonicalize local-only fields before validation. Provider schemas stay
  // focused on anchored output; the harness derives compatibility fields.
  const derivedSummaryNormalization = normalizeDerivedSummaryFields(summary);

  const validationError = validateSummary(summary, lineHashArtifacts);
  if (validationError) {
    const failure = {
      ok: false,
      error: validationError,
      request: requestMeta,
      artifacts: {
        beforePath,
        lineHashesPath,
        requestLogPath,
        rawResponsePath,
        eventsPath,
        modelOutputPath,
        snapshotPath,
        livePath,
      },
      parsedPreview: summary,
    };
    await writeFile(join(outDir, "failure.json"), JSON.stringify(failure, null, 2) + "\n");
    console.error(JSON.stringify(failure, null, 2));
    process.exit(1);
  }

  const rehydratedSpans = deriveRehydrationSpans(summary, records, lineHashArtifacts);
  const userMessages = extractUserMessages(records, lineHashArtifacts);
  const carriedUserMessages = extractCarriedHandoffUserMessages(records);
  const handoffUserMessages = mergeHandoffUserMessages(carriedUserMessages, userMessages);
  const handoffUserMessageSelection = selectHandoffUserMessages(handoffUserMessages);
  const userMessageValidationError = validateUserMessageArtifacts(userMessages);
  if (userMessageValidationError) {
    const failure = {
      ok: false,
      error: userMessageValidationError,
      request: requestMeta,
      artifacts: {
        beforePath,
        lineHashesPath,
        requestLogPath,
        rawResponsePath,
        eventsPath,
        modelOutputPath,
        snapshotPath,
        livePath,
      },
    };
    await writeFile(join(outDir, "failure.json"), JSON.stringify(failure, null, 2) + "\n");
    console.error(JSON.stringify(failure, null, 2));
    process.exit(1);
  }
  const rawUserDumpValidationError = validateNoRawUserMessageDumps(summary, userMessages);
  if (rawUserDumpValidationError) {
    const failure = {
      ok: false,
      error: rawUserDumpValidationError,
      request: requestMeta,
      artifacts: {
        beforePath,
        lineHashesPath,
        requestLogPath,
        rawResponsePath,
        eventsPath,
        modelOutputPath,
        snapshotPath,
        livePath,
      },
    };
    await writeFile(join(outDir, "failure.json"), JSON.stringify(failure, null, 2) + "\n");
    console.error(JSON.stringify(failure, null, 2));
    process.exit(1);
  }
  const timelineValidationError = validateTimelineUnits(summary, userMessages);
  if (timelineValidationError) {
    const failure = {
      ok: false,
      error: timelineValidationError,
      request: requestMeta,
      artifacts: {
        beforePath,
        lineHashesPath,
        requestLogPath,
        rawResponsePath,
        eventsPath,
        modelOutputPath,
        snapshotPath,
        livePath,
      },
    };
    await writeFile(join(outDir, "failure.json"), JSON.stringify(failure, null, 2) + "\n");
    console.error(JSON.stringify(failure, null, 2));
    process.exit(1);
  }
  summary.source_hashes_used = collectSourceHashes(summary, lineHashArtifacts);
  summary.summary_markdown = renderSummaryBlocks(summary);
  const timelineMarkdown = renderTimelineSummary(summary, userMessages);
  const finishedAt = new Date();
  const run = {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
  };
  const userMessagesPayload = {
    metadata: {
      source_transcript: inputPath,
      transcript_sha256: sha256,
      transcript_records: records.length,
      current_message_count: userMessages.length,
      carried_message_count: carriedUserMessages.length,
      selected_message_count: handoffUserMessageSelection.selected.length,
      omitted_older_count: handoffUserMessageSelection.omitted_older,
      handoff_token_estimate: handoffUserMessageSelection.token_estimate,
      handoff_line_count: handoffUserMessageSelection.line_count,
      handoff_limits: handoffUserMessageSelection.limits,
      collapse_at: userMessageCollapseAt,
      head_chars: userMessageHeadChars,
      tail_chars: userMessageTailChars,
    },
    messages: handoffUserMessageSelection.selected,
    current_messages: userMessages,
    carried_messages: carriedUserMessages,
  };
  await writeFile(summaryJsonPath, JSON.stringify(summary, null, 2) + "\n");
  await writeFile(summaryMdPath, summary.summary_markdown.trim() + "\n");
  await writeFile(timelineMdPath, timelineMarkdown);
  await writeFile(userMessagesPath, JSON.stringify(userMessagesPayload, null, 2) + "\n");
  await writeFile(rehydratedSpansPath, JSON.stringify(rehydratedSpans, null, 2) + "\n");
  await writeFile(rehydratedSummaryPath, renderRehydratedSummary(summary, rehydratedSpans));

  const handoffState = buildHandoffState({
    summary,
    stats,
    run,
    beforePath,
    rehydratedSpans,
    handoffUserMessageSelection,
  });
  const handoffStateValidationError = validateHandoffState(handoffState);
  if (handoffStateValidationError) {
    const failure = {
      ok: false,
      error: handoffStateValidationError,
      request: requestMeta,
      artifacts: {
        beforePath,
        lineHashesPath,
        requestLogPath,
        rawResponsePath,
        eventsPath,
        modelOutputPath,
        snapshotPath,
        livePath,
      },
    };
    await writeFile(join(outDir, "failure.json"), JSON.stringify(failure, null, 2) + "\n");
    console.error(JSON.stringify(failure, null, 2));
    process.exit(1);
  }
  await writeFile(handoffStatePath, JSON.stringify(handoffState, null, 2) + "\n");

  const handoffMarkdown = renderHandoffMarkdown({
    state: handoffState,
    handoffUserMessageSelection,
    rehydratedSpans,
    manifestPath: handoffManifestPath,
    statePath: handoffStatePath,
    beforePath,
  });
  await writeFile(handoffMdPath, handoffMarkdown);

  const adapter = streamAdapter();
  const handoffManifest = await buildHandoffManifest({
    stats,
    run,
    requestMeta,
    usage: adapter.usage(events),
    paths: {
      beforePath,
      handoffStatePath,
      handoffMdPath,
      summaryJsonPath,
      summaryMdPath,
      timelineMdPath,
      userMessagesPath,
      rehydratedSpansPath,
      rehydratedSummaryPath,
      lineHashesPath,
      requestLogPath,
      eventsPath,
      modelOutputPath,
    },
  });
  await writeFile(handoffManifestPath, JSON.stringify(handoffManifest, null, 2) + "\n");

  await writeFile(
    snapshotPath,
    JSON.stringify(
      {
        status: "validated",
        summary,
        userMessages,
        carriedUserMessages,
        handoffUserMessages: handoffUserMessageSelection,
        handoffState,
        handoffManifest,
        rehydratedSpans,
      },
      null,
      2
    ) + "\n"
  );
  await writeFile(livePath, handoffMarkdown);
  const afterTranscript = buildCompactedTranscript({
    records,
    summary,
    stats,
    run,
    beforePath,
    handoffUserMessageSelection,
    handoffState,
    handoffMarkdown,
    handoffManifestPath,
    handoffStatePath,
    handoffMdPath,
  });
  await writeFile(afterPath, afterTranscript);

  const afterRecords = parseJsonl(afterTranscript);
  const result = {
    ok: true,
    provider: PROVIDER,
    endpoint,
    model: MODEL,
    service_tier: PROVIDER_REGISTRY[PROVIDER].family === "codex" ? SERVICE_TIER : null,
    reasoning: PROVIDER_REGISTRY[PROVIDER].family === "codex" ? request.body.reasoning : null,
    temperature: TEMPERATURE,
    thinking_level: PROVIDER_REGISTRY[PROVIDER].family === "gemini" ? GEMINI_THINKING_LEVEL : null,
    thinking_config:
      PROVIDER_REGISTRY[PROVIDER].family === "gemini" ? request.body.generationConfig?.thinkingConfig || null : null,
    request: requestMeta,
    response_id: adapter.responseId(events),
    usage: adapter.usage(events),
    loaded_from_output: loadedFromOutput,
    event_count: events.length,
    output_sha256: createHash("sha256").update(outputText).digest("hex"),
    legacy_model_user_messages_discarded: legacyModelUserMessagesDiscarded,
    legacy_rule_status_defaulted: legacySummaryNormalization.ruleStatusDefaulted,
    legacy_promises_made_defaulted: legacySummaryNormalization.promisesMadeDefaulted,
    legacy_bullet_format_relaxed:
      legacySummaryNormalization.bulletFormatRelaxed + derivedSummaryNormalization.bulletFormatRelaxed,
    legacy_code_block_downgraded:
      legacySummaryNormalization.codeBlockDowngraded + derivedSummaryNormalization.codeBlockDowngraded,
    derived_compatibility_arrays_defaulted:
      derivedSummaryNormalization.compatibilityArraysDefaulted.length,
    derived_compatibility_array_keys: derivedSummaryNormalization.compatibilityArraysDefaulted,
    derived_source_lines_used: derivedSummaryNormalization.sourceLinesDerived,
    summary_chars: summary.summary_markdown.length,
    summary_estimated_tokens: Math.ceil(summary.summary_markdown.length / 4),
    summary_block_count: summary.summary_blocks.length,
    rules_and_invariants_count: summary.rules_and_invariants.length,
    current_rules_and_invariants_count: summary.rules_and_invariants.filter(
      (item) => item.status === "current"
    ).length,
    plans_and_task_state_count: summary.plans_and_task_state.length,
    promises_made_count: summary.promises_made.length,
    user_message_count: userMessages.length,
    user_message_total_chars: userMessages.reduce((total, message) => total + message.char_count, 0),
    user_message_collapsed_count: userMessages.filter(
      (message) => message.char_count > userMessageCollapseAt
    ).length,
    user_message_max_chars: userMessages.reduce(
      (max, message) => Math.max(max, message.char_count),
      0
    ),
    carried_user_message_count: carriedUserMessages.length,
    handoff_user_message_total_count: handoffUserMessages.length,
    handoff_user_message_selected_count: handoffUserMessageSelection.selected.length,
    handoff_user_message_omitted_older_count: handoffUserMessageSelection.omitted_older,
    handoff_user_message_token_estimate: handoffUserMessageSelection.token_estimate,
    handoff_user_message_line_count: handoffUserMessageSelection.line_count,
    handoff_user_message_limits: handoffUserMessageSelection.limits,
    rehydrated_span_count: rehydratedSpans.length,
    source_line_count: summary.source_lines_used.length,
    before_estimated_tokens: stats.approxTokens,
    after_bytes: Buffer.byteLength(afterTranscript),
    after_estimated_tokens: Math.ceil(afterTranscript.length / 4),
    context_window_usage_estimate: {
      before_char_div_4_tokens: stats.approxTokens,
      after_char_div_4_tokens: Math.ceil(afterTranscript.length / 4),
      reduction_ratio:
        stats.approxTokens > 0 ? Math.ceil(afterTranscript.length / 4) / stats.approxTokens : null,
    },
    compact_profile: "warp-guided-span-rehydration",
    was_summarized: true,
    custom_summary_instructions: customSummaryInstructions.trim() || null,
    compact_and_prompt: compactAndPrompt.trim() || null,
    transcript_renderer: transcriptRenderer,
    integrity_echo_matches:
      summary.source_integrity.transcript_sha256 === sha256 &&
      summary.source_integrity.transcript_lines_seen === records.length,
    before_records: records.length,
    after_records: afterRecords.length,
    artifacts: {
      beforePath,
      afterPath,
      summaryJsonPath,
      summaryMdPath,
      timelineMdPath,
      userMessagesPath,
      rehydratedSpansPath,
      rehydratedSummaryPath,
      handoffStatePath,
      handoffManifestPath,
      handoffMdPath,
      snapshotPath,
      livePath,
      lineHashesPath,
      requestLogPath,
      rawResponsePath,
      eventsPath,
      modelOutputPath,
      resultPath,
    },
    run,
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
}

// Run the CLI only when executed directly (subprocess, redirect, launcher).
// When imported by a test, argv[1] is the test file, so main() is skipped and
// the exported internals can be unit-tested without triggering a compaction run.
const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch(async (error) => {
    try {
      await mkdir(outDir, { recursive: true });
      await writeFile(
        join(outDir, "failure.json"),
        JSON.stringify({ ok: false, error: error.stack || error.message }, null, 2) + "\n"
      );
    } catch {
      // Ignore secondary failure while reporting the primary error.
    }
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exit(1);
  });
}

export { validateSummary, normalizeDerivedSummaryFields, normalizeLegacySummary, relaxSummaryBlockFormats };
