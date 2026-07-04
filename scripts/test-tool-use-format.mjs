#!/usr/bin/env node
import {
  extractEditCapsules,
  formatDiffLinesResult,
  formatEditTool,
  formatToolResult,
  formatToolResultContent,
  formatToolUse,
  isFormattedEditText,
  lineDiff,
} from "./tool-use-format.mjs";

function assert(condition, label) {
  if (!condition) throw new Error(label);
}

const cwd = "/Users/jaredboynton/__devlocal/llm/";
const meta = { lineNumber: 501, recordHash: "abc123", cwdPrefix: cwd };

const editInput = {
  file_path: cwd + "src/llm/providers/codex_rs_wire.py",
  old_str:
    'from __future__ import annotations\n\nfrom typing import Any, Literal\n\nCODEX_ORIGINATOR = "codex_cli_rs"\n',
  new_str:
    'from __future__ import annotations\n\nimport json\nfrom typing import Any, Literal\n\nCODEX_ORIGINATOR = "codex_cli_rs"\n',
};

const editFormatted = formatToolUse(
  { type: "tool_use", name: "Edit", input: editInput },
  meta
);

assert(isFormattedEditText(editFormatted), "edit output should start with @@tool");
assert(!editFormatted.includes("\\n"), "edit output should not contain escaped newlines");
assert(editFormatted.includes("@@file src/llm/providers/codex_rs_wire.py"), "relative path expected");
assert(editFormatted.includes("+import json"), "added line expected");
assert(editFormatted.includes("stats: +"), "stats footer expected");

const strReplaceFormatted = formatEditTool(
  "StrReplace",
  {
    file_path: "/tmp/example.py",
    old_str: "before",
    new_str: "after",
  },
  { lineNumber: 12 }
);
assert(strReplaceFormatted.includes("-before"), "StrReplace removed line");
assert(strReplaceFormatted.includes("+after"), "StrReplace added line");

const diffLinesObj = {
  success: true,
  file_path: cwd + "src/llm/providers/codex_responses_client.py",
  diffLines: [
    { type: "unchanged", content: "CODEX_ORIGINATOR = os.environ.get(" },
    { type: "unchanged", content: '    "CODEX_INTERNAL_ORIGINATOR_OVERRIDE", "codex_cli_rs"' },
    { type: "unchanged", content: ")" },
    { type: "added", content: 'CODEX_TUI_ORIGINATOR = "codex-tui"' },
    { type: "unchanged", content: 'CODEX_RESPONSES_WS_BETA = "responses_websockets=2026-02-06"' },
  ],
};

const diffLinesFormatted = formatDiffLinesResult(diffLinesObj, { ...meta, cwdPrefix: cwd });
assert(diffLinesFormatted.includes("@@tool EditResult"), "EditResult header expected");
assert(diffLinesFormatted.includes("+CODEX_TUI_ORIGINATOR"), "added diff line expected");
assert(!diffLinesFormatted.includes('"diffLines"'), "no JSON keys in diffLines output");

const toolResultFormatted = formatToolResultContent(JSON.stringify(diffLinesObj), meta);
assert(toolResultFormatted.includes("+CODEX_TUI_ORIGINATOR"), "tool result formatter handles diffLines JSON");

const toolResultPart = {
  type: "tool_result",
  tool_use_id: "tooluse_test",
  content: JSON.stringify(diffLinesObj),
};
const toolResultViaPart = formatToolResult(toolResultPart, meta);
assert(toolResultViaPart.includes("EditResult"), "tool_result part with string content should format");
assert(!toolResultViaPart.includes('"diffLines"'), "tool_result part should not leak JSON keys");

const pairs = lineDiff("alpha\nbeta\ngamma", "alpha\nBETA\ngamma");
assert(pairs.some((p) => p.type === "remove"), "lineDiff should mark removal");
assert(pairs.some((p) => p.type === "add"), "lineDiff should mark addition");

const capsules = extractEditCapsules("span-0001", editFormatted + "\n\n" + diffLinesFormatted);
assert(capsules.length >= 2, "expected edit capsules from formatted blocks");

console.log("tool-use-format tests passed");
console.log("sample edit block:\n");
console.log(editFormatted);
