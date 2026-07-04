import { createHash } from "node:crypto";

export const DEFAULT_CONTEXT_LINES = 3;
export const SMALL_EDIT_CHAR_THRESHOLD = 400;
export const WRITE_HEAD_LINES = 40;
export const WRITE_TAIL_LINES = 10;

export function sha256Text(text) {
  return createHash("sha256").update(String(text || "")).digest("hex");
}

export function normalizePath(filePath, cwdPrefix) {
  const raw = String(filePath || "").trim();
  if (!raw) return { display: "(unknown)", absolute: raw };
  if (cwdPrefix && raw.startsWith(cwdPrefix)) {
    const relative = raw.slice(cwdPrefix.length).replace(/^\/+/, "");
    return { display: relative || raw, absolute: raw };
  }
  return { display: raw, absolute: raw };
}

export function normalizeEditInput(input) {
  if (!input || typeof input !== "object") {
    return { filePath: "", oldText: "", newText: "", edits: null };
  }
  const filePath = input.file_path || input.path || input.filePath || "";
  const oldText = input.old_str ?? input.old_string ?? input.oldString ?? "";
  const newText = input.new_str ?? input.new_string ?? input.newString ?? "";
  const edits = Array.isArray(input.edits)
    ? input.edits.map((edit) => ({
        oldText: edit.old_str ?? edit.old_string ?? edit.oldString ?? "",
        newText: edit.new_str ?? edit.new_string ?? edit.newString ?? "",
      }))
    : null;
  return { filePath, oldText: String(oldText), newText: String(newText), edits };
}

function splitLines(text) {
  return String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

function trimCommonPrefixSuffix(oldLines, newLines) {
  let start = 0;
  while (
    start < oldLines.length &&
    start < newLines.length &&
    oldLines[start] === newLines[start]
  ) {
    start += 1;
  }
  let oldEnd = oldLines.length - 1;
  let newEnd = newLines.length - 1;
  while (
    oldEnd >= start &&
    newEnd >= start &&
    oldLines[oldEnd] === newLines[newEnd]
  ) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  return {
    prefix: oldLines.slice(0, start),
    oldMiddle: oldLines.slice(start, oldEnd + 1),
    newMiddle: newLines.slice(start, newEnd + 1),
    suffix: oldLines.slice(oldEnd + 1),
  };
}

function lcsPairs(oldLines, newLines) {
  const m = oldLines.length;
  const n = newLines.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i][j] =
        oldLines[i] === newLines[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      pairs.push({ type: "same", oldIndex: i, newIndex: j, line: oldLines[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      pairs.push({ type: "remove", oldIndex: i, line: oldLines[i] });
      i += 1;
    } else {
      pairs.push({ type: "add", newIndex: j, line: newLines[j] });
      j += 1;
    }
  }
  while (i < m) {
    pairs.push({ type: "remove", oldIndex: i, line: oldLines[i] });
    i += 1;
  }
  while (j < n) {
    pairs.push({ type: "add", newIndex: j, line: newLines[j] });
    j += 1;
  }
  return pairs;
}

function collapseUnchangedRuns(pairs, contextLines) {
  const out = [];
  let unchangedRun = [];
  const flushUnchanged = () => {
    if (unchangedRun.length === 0) return;
    if (unchangedRun.length <= contextLines * 2) {
      for (const item of unchangedRun) out.push({ type: "context", line: item.line });
    } else {
      for (const item of unchangedRun.slice(0, contextLines)) {
        out.push({ type: "context", line: item.line });
      }
      out.push({
        type: "elide",
        count: unchangedRun.length - contextLines * 2,
      });
      for (const item of unchangedRun.slice(-contextLines)) {
        out.push({ type: "context", line: item.line });
      }
    }
    unchangedRun = [];
  };
  for (const pair of pairs) {
    if (pair.type === "same") {
      unchangedRun.push(pair);
      continue;
    }
    flushUnchanged();
    out.push(pair);
  }
  flushUnchanged();
  return out;
}

export function lineDiff(oldText, newText, options = {}) {
  const contextLines = options.contextLines ?? DEFAULT_CONTEXT_LINES;
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const trimmed = trimCommonPrefixSuffix(oldLines, newLines);
  const pairs = [];
  for (const line of trimmed.prefix) pairs.push({ type: "context", line });
  pairs.push(...collapseUnchangedRuns(lcsPairs(trimmed.oldMiddle, trimmed.newMiddle), contextLines));
  for (const line of trimmed.suffix) pairs.push({ type: "context", line });
  return pairs;
}

function renderDiffPairs(pairs, filePath) {
  const lines = [];
  if (filePath) {
    lines.push("--- a/" + filePath);
    lines.push("+++ b/" + filePath);
  }
  let added = 0;
  let removed = 0;
  for (const pair of pairs) {
    if (pair.type === "context") lines.push(" " + pair.line);
    else if (pair.type === "remove") {
      lines.push("-" + pair.line);
      removed += 1;
    } else if (pair.type === "add") {
      lines.push("+" + pair.line);
      added += 1;
    } else if (pair.type === "elide") {
      lines.push("[... " + pair.count + " unchanged lines ...]");
    }
  }
  return { body: lines.join("\n"), added, removed };
}

function toolHeader(name, meta) {
  const parts = ["@@tool " + (name || "unknown")];
  if (meta?.lineNumber != null) parts.push("line=" + String(meta.lineNumber).padStart(6, "0"));
  if (meta?.recordHash) parts.push("sha256=" + meta.recordHash);
  return parts.join(" ");
}

function statsFooter({ added, removed, inputSha256 }) {
  const bits = ["stats: +" + added + " -" + removed + " lines"];
  if (inputSha256) bits.push("input_sha256=" + inputSha256);
  return bits.join(" | ");
}

export function formatEditDiff(oldText, newText, filePath, meta = {}, options = {}) {
  const paths = normalizePath(filePath, meta.cwdPrefix);
  const inputSha256 = sha256Text(JSON.stringify({ filePath, oldText, newText }));
  const combined = oldText.length + newText.length;
  const lines = [toolHeader(meta.toolName || "Edit", meta), "@@file " + paths.display];
  if (paths.absolute && paths.absolute !== paths.display) {
    lines.push("@@file_abs " + paths.absolute);
  }
  let added = 0;
  let removed = 0;
  if (combined <= (options.smallEditThreshold ?? SMALL_EDIT_CHAR_THRESHOLD)) {
    for (const line of splitLines(oldText)) {
      lines.push("-" + line);
      removed += 1;
    }
    for (const line of splitLines(newText)) {
      lines.push("+" + line);
      added += 1;
    }
  } else {
    const rendered = renderDiffPairs(
      lineDiff(oldText, newText, { contextLines: options.contextLines ?? DEFAULT_CONTEXT_LINES }),
      paths.display
    );
    lines.push(rendered.body);
    added = rendered.added;
    removed = rendered.removed;
  }
  lines.push(statsFooter({ added, removed, inputSha256 }));
  return lines.join("\n");
}

export function formatEditTool(name, input, meta = {}, options = {}) {
  const normalized = normalizeEditInput(input);
  if (normalized.edits?.length) {
    return normalized.edits
      .map((edit, idx) =>
        formatEditDiff(edit.oldText, edit.newText, normalized.filePath, {
          ...meta,
          toolName: name + "[" + idx + "]",
        }, options)
      )
      .join("\n\n");
  }
  return formatEditDiff(normalized.oldText, normalized.newText, normalized.filePath, {
    ...meta,
    toolName: name,
  }, options);
}

export function formatWriteTool(input, meta = {}, options = {}) {
  const filePath = input?.file_path || input?.path || input?.filePath || "";
  const contents = String(input?.contents ?? input?.content ?? "");
  const paths = normalizePath(filePath, meta.cwdPrefix);
  const inputSha256 = sha256Text(JSON.stringify({ filePath, contents }));
  const lines = [toolHeader(meta.toolName || "Write", meta), "@@file " + paths.display];
  if (paths.absolute && paths.absolute !== paths.display) {
    lines.push("@@file_abs " + paths.absolute);
  }
  const contentLines = splitLines(contents);
  const headLimit = options.writeHeadLines ?? WRITE_HEAD_LINES;
  const tailLimit = options.writeTailLines ?? WRITE_TAIL_LINES;
  if (contentLines.length <= headLimit + tailLimit) {
    lines.push("```");
    lines.push(contents.replace(/\n$/, ""));
    lines.push("```");
  } else {
    const head = contentLines.slice(0, headLimit).join("\n");
    const tail = contentLines.slice(-tailLimit).join("\n");
    const omitted = Math.max(contentLines.length - headLimit - tailLimit, 0);
    lines.push("```");
    lines.push(head);
    lines.push("[... " + omitted + " lines omitted ...]");
    lines.push(tail);
    lines.push("```");
  }
  lines.push("stats: lines=" + contentLines.length + " | input_sha256=" + inputSha256);
  return lines.join("\n");
}

export function formatApplyPatch(input, meta = {}) {
  const patch = String(input?.patch ?? input?.input ?? "");
  const inputSha256 = sha256Text(patch);
  const lines = [toolHeader(meta.toolName || "apply_patch", meta), "```diff", patch.replace(/\n$/, ""), "```"];
  lines.push("stats: input_sha256=" + inputSha256);
  return lines.join("\n");
}

export function formatDiffLinesResult(obj, meta = {}, options = {}) {
  const filePath = obj?.file_path || obj?.path || "";
  const diffLines = Array.isArray(obj?.diffLines) ? obj.diffLines : [];
  const paths = normalizePath(filePath, meta.cwdPrefix);
  const lines = [toolHeader(meta.toolName || "EditResult", meta), "@@file " + paths.display];
  if (paths.absolute && paths.absolute !== paths.display) {
    lines.push("@@file_abs " + paths.absolute);
  }
  lines.push("--- a/" + paths.display);
  lines.push("+++ b/" + paths.display);
  let added = 0;
  let removed = 0;
  let unchangedRun = [];
  const contextLines = options.contextLines ?? DEFAULT_CONTEXT_LINES;
  const flushUnchanged = () => {
    if (unchangedRun.length === 0) return;
    if (unchangedRun.length <= contextLines * 2) {
      for (const item of unchangedRun) lines.push(" " + item.content);
    } else {
      for (const item of unchangedRun.slice(0, contextLines)) lines.push(" " + item.content);
      lines.push("[... " + (unchangedRun.length - contextLines * 2) + " unchanged lines ...]");
      for (const item of unchangedRun.slice(-contextLines)) lines.push(" " + item.content);
    }
    unchangedRun = [];
  };
  for (const item of diffLines) {
    const type = item?.type || "unchanged";
    const content = String(item?.content ?? "");
    if (type === "unchanged") {
      unchangedRun.push({ content });
      continue;
    }
    flushUnchanged();
    if (type === "removed") {
      lines.push("-" + content);
      removed += 1;
    } else if (type === "added") {
      lines.push("+" + content);
      added += 1;
    } else {
      lines.push(" " + content);
    }
  }
  flushUnchanged();
  const inputSha256 = sha256Text(JSON.stringify(obj));
  lines.push(statsFooter({ added, removed, inputSha256 }));
  return lines.join("\n");
}

function tryParseJsonObject(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

const EDIT_TOOL_NAMES = new Set(["Edit", "StrReplace", "MultiEdit", "NotebookEdit"]);

export function formatToolUse(part, meta = {}, options = {}) {
  const name = part?.name || "unknown";
  const input = part?.input ?? {};
  if (EDIT_TOOL_NAMES.has(name)) return formatEditTool(name, input, meta, options);
  if (name === "Write") return formatWriteTool(input, meta, options);
  if (name === "apply_patch") return formatApplyPatch(input, meta);
  const inputSha256 = sha256Text(JSON.stringify(input));
  const lines = [toolHeader(name, meta), JSON.stringify(input, null, 2), "stats: input_sha256=" + inputSha256];
  return lines.join("\n");
}

export function formatToolResultContent(content, meta = {}, options = {}) {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((item) =>
              typeof item === "string"
                ? item
                : typeof item?.text === "string"
                  ? item.text
                  : typeof item?.content === "string"
                    ? item.content
                    : ""
            )
            .filter(Boolean)
            .join("\n")
        : "";
  const parsed = tryParseJsonObject(text);
  if (parsed && Array.isArray(parsed.diffLines) && (parsed.file_path || parsed.path)) {
    return formatDiffLinesResult(parsed, { ...meta, toolName: "EditResult" }, options);
  }
  return text;
}

export function formatToolResult(part, meta = {}, options = {}) {
  const formatted = formatToolResultContent(part?.content, meta, options);
  if (!formatted) return "[tool_result]";
  return "[tool_result]\n" + formatted;
}

export function extractEditCapsules(spanId, extractedText) {
  const capsules = [];
  const blocks = String(extractedText || "").split(/\n(?=@@tool )/);
  for (const block of blocks) {
    if (!block.startsWith("@@tool ")) continue;
    const header = block.match(/^@@tool (\S+)/);
    const file = block.match(/^@@file ([^\n]+)/m);
    const fileAbs = block.match(/^@@file_abs ([^\n]+)/m);
    const stats = block.match(/stats: \+(\d+) -(\d+) lines(?: \| input_sha256=([0-9a-f]{64}))?/);
    if (!header || !file || !stats) continue;
    const diffStart = block.indexOf("\n--- a/");
    const diffEnd = block.indexOf("\nstats:");
    const diffBody =
      diffStart !== -1 && diffEnd !== -1 ? block.slice(diffStart + 1, diffEnd).trim() : block.trim();
    capsules.push({
      id: spanId + "-edit-" + String(capsules.length + 1).padStart(3, "0"),
      source_span_id: spanId,
      tool_name: header[1].trim(),
      file_path: file[1].trim(),
      file_path_abs: fileAbs?.[1]?.trim() || file[1].trim(),
      lines_added: Number.parseInt(stats[1], 10) || 0,
      lines_removed: Number.parseInt(stats[2], 10) || 0,
      diff_sha256: sha256Text(diffBody),
      input_sha256: stats[3] || null,
    });
  }
  return capsules;
}

export function isFormattedEditText(text) {
  return String(text || "").trimStart().startsWith("@@tool ");
}

export function compactFormattedEdit(text, entry, options = {}) {
  const body = String(text || "");
  const minChars = options.minChars ?? 800;
  if (body.length <= minChars) return { body, compressed: false };
  const aggressiveContext = options.aggressiveContextLines ?? 1;
  const fileMatch = body.match(/^@@tool[^\n]*\n@@file ([^\n]+)\n([\s\S]*)$/m);
  if (!fileMatch) {
    return {
      body:
        body.slice(0, options.headChars ?? 400) +
        "\n\n[edit compressed: original_chars=" +
        body.length +
        " omitted_chars=" +
        Math.max(body.length - (options.headChars ?? 400), 0) +
        " line=" +
        entry.lineNumber +
        " body_sha256=" +
        sha256Text(body) +
        " record_sha256=" +
        entry.hash +
        "]\n",
      compressed: true,
      originalChars: body.length,
      omittedChars: Math.max(body.length - (options.headChars ?? 400), 0),
    };
  }
  const oldNew = body.match(/(-[^\n]+\n)(\+[^\n]+\n)+/);
  if (oldNew) {
    return { body, compressed: false };
  }
  const recompressed = body.replace(
    /\[\.\.\. (\d+) unchanged lines \.\.\.\]/g,
    (_, count) => "[... " + count + " unchanged lines (compressed) ...]"
  );
  if (recompressed.length >= body.length) {
    const head = body.slice(0, options.headChars ?? 400);
    const tail = body.slice(Math.max(body.length - (options.tailChars ?? 200), options.headChars ?? 400));
    const omitted = Math.max(body.length - head.length - tail.length, 0);
    return {
      body: [
        head,
        "",
        "[edit compressed: original_chars=" +
          body.length +
          " omitted_chars=" +
          omitted +
          " line=" +
          entry.lineNumber +
          " body_sha256=" +
          sha256Text(body) +
          " record_sha256=" +
          entry.hash +
          "]",
        "",
        tail,
      ].join("\n"),
      compressed: true,
      originalChars: body.length,
      omittedChars: omitted,
    };
  }
  return {
    body: recompressed,
    compressed: recompressed.length < body.length,
    originalChars: body.length,
    omittedChars: Math.max(body.length - recompressed.length, 0),
  };
}
