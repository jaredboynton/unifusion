#!/usr/bin/env python3
"""Extract the final assistant text from an `opencode run --format json` stream.

`opencode run --format json` emits newline-delimited JSON events. Assistant prose
arrives as events with type=="text" whose part carries {"type":"text","text":...}.
A run has one or more steps (each delimited by a `step_start` event): interim
narration and tool calls happen in earlier steps, and the final answer is the text
of the last step.

Capture strategy, in order of preference:
  1. All text parts at/after the last `step_start` (the final turn's answer). This
     drops interim "I'll research..." narration from earlier steps.
  2. If the final turn produced no text (e.g. it ended on a tool call or an error),
     fall back to concatenating every text part in the stream, so a report that
     landed in an earlier step is never silently lost.

`extract_error` surfaces the last stream `error` event for drop diagnostics.
`extract_task_results` surfaces orchestrator `task` tool invocations for panelist observability.

Usage:
  parse_events.py <events.ndjson>            # final text to stdout
  parse_events.py <events.ndjson> --error    # last error
  parse_events.py <events.ndjson> --tasks    # JSON array of task tool results
"""
import json
import sys


def _events(path: str):
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if not line:
            continue
        try:
            evt = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(evt, dict):
            yield evt


def _text_of(evt: dict) -> str:
    if evt.get("type") != "text":
        return ""
    part = evt.get("part") or {}
    if part.get("type") != "text":
        return ""
    text = part.get("text")
    return text if isinstance(text, str) else ""


def extract_final_text(path: str) -> str:
    events = list(_events(path))

    last_step = -1
    for i, evt in enumerate(events):
        if evt.get("type") == "step_start":
            last_step = i

    if last_step >= 0:
        final_turn = "".join(_text_of(e) for e in events[last_step:]).strip()
        if final_turn:
            return final_turn

    return "".join(_text_of(e) for e in events).strip()


def extract_error(path: str) -> str:
    """Return a compact description of the last error event, or '' if none."""
    last = ""
    for evt in _events(path):
        if evt.get("type") != "error":
            continue
        err = evt.get("error") or evt.get("part") or {}
        if isinstance(err, dict):
            code = err.get("code") or err.get("name") or "error"
            msg = err.get("message") or err.get("path") or ""
            last = f"{code}: {msg}".strip().rstrip(": ")
        else:
            last = str(err)
    return last


def _task_input(state: dict) -> dict:
    raw = state.get("input")
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def extract_task_results(path: str) -> list[dict]:
    """Return orchestrator task tool invocations with subagent, status, and output."""
    results: list[dict] = []
    for evt in _events(path):
        if evt.get("type") != "tool_use":
            continue
        part = evt.get("part") or {}
        if part.get("tool") != "task":
            continue
        state = part.get("state") or {}
        inp = _task_input(state)
        subagent = inp.get("subagent_type") or inp.get("agent") or "unknown"
        output = state.get("output")
        if output is None:
            output = ""
        elif not isinstance(output, str):
            output = json.dumps(output)
        status = state.get("status") or ""
        results.append(
            {
                "subagent": subagent,
                "description": inp.get("description") or "",
                "status": status,
                "output": output,
                "timestamp": evt.get("timestamp"),
            }
        )
    return results


def main() -> int:
    if len(sys.argv) < 2:
        print(
            "usage: parse_events.py <events.ndjson> [--error|--tasks]",
            file=sys.stderr,
        )
        return 2
    path = sys.argv[1]
    flag = sys.argv[2] if len(sys.argv) >= 3 else ""
    if flag == "--error":
        sys.stdout.write(extract_error(path))
    elif flag == "--tasks":
        sys.stdout.write(json.dumps(extract_task_results(path), indent=2))
        if not sys.stdout.isatty():
            sys.stdout.write("\n")
    else:
        sys.stdout.write(extract_final_text(path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
