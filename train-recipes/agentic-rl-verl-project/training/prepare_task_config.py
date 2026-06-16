#!/usr/bin/env python3
"""Convert an agentic-RL task YAML into shell exports for entry scripts.

The user-facing config is intentionally a small YAML file.  For K8s sandbox
tasks it also injects the sandbox ClusterIP URL into veRL's tool config and
writes a resolved tool config under /tmp.
"""

from __future__ import annotations

import os
import shlex
import sys
from pathlib import Path

import yaml


EXPORTS = {
    ("projectDir",): "PROJ_DIR",
    ("modelPath",): "MODEL_PATH",
    ("data", "train"): "TRAIN_DATA",
    ("data", "validation"): "VAL_DATA",
    ("verl", "batchSize"): "BS",
    ("verl", "rolloutN"): "ROLLOUT_N",
    ("verl", "epochs"): "EPOCHS",
    ("verl", "quick"): "QUICK",
    ("verl", "trainGpus"): "TRAIN_GPUS",
    ("verl", "rolloutGpus"): "ROLLOUT_GPUS",
    ("verl", "projectName"): "PROJECT_NAME",
    ("verl", "promptLength"): "PROMPT_LEN",
    ("verl", "responseLength"): "RESPONSE_LEN",
    ("verl", "maxAssistantTurns"): "MAX_ASSISTANT_TURNS",
    ("verl", "maxToolResponseLength"): "MAX_TOOL_RESPONSE_LENGTH",
    ("reward", "path"): "REWARD_FUNCTION_PATH",
    ("reward", "name"): "REWARD_FUNCTION_NAME",
}


def get_nested(data: dict, path: tuple[str, ...]):
    cur = data
    for key in path:
        if not isinstance(cur, dict) or key not in cur:
            return None
        cur = cur[key]
    return cur


def shell_export(name: str, value) -> str:
    if isinstance(value, bool):
        value = "true" if value else "false"
    return f"export {name}={shlex.quote(str(value))}"


def resolved_tool_config(config: dict, task_name: str) -> str | None:
    tool = config.get("tool") or {}
    tool_config = tool.get("config")
    if not tool_config:
        return None

    sandbox_api_url = normalize_url(tool.get("sandboxApiUrl") or tool.get("apiUrl"))
    if not sandbox_api_url:
        return str(tool_config)

    src = Path(str(tool_config))
    parsed = yaml.safe_load(src.read_text())
    for item in parsed.get("tools", []):
        item.setdefault("config", {})["api_url"] = sandbox_api_url

    out_dir = Path(tool.get("resolvedConfigDir") or "/tmp/agentic-rl-verl")
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{task_name}-tool-config.yaml"
    out.write_text(yaml.safe_dump(parsed, sort_keys=False))
    return str(out)


def normalize_url(value) -> str | None:
    if not value:
        return None
    value = str(value).strip()
    if "://" not in value:
        value = f"http://{value}"
    return value


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: prepare_task_config.py <task-config.yaml>", file=sys.stderr)
        return 1

    path = Path(sys.argv[1])
    config = yaml.safe_load(path.read_text())
    task_name = str(config.get("task") or path.stem)

    print(shell_export("TASK_CONFIG", path))
    print(shell_export("TASK_NAME", task_name))

    for cfg_path, var_name in EXPORTS.items():
        value = get_nested(config, cfg_path)
        if value is not None:
            print(shell_export(var_name, value))

    tool_config = resolved_tool_config(config, task_name)
    if tool_config:
        print(shell_export("TOOL_CONFIG", tool_config))

    sandbox_api_url = normalize_url(get_nested(config, ("tool", "sandboxApiUrl")) or get_nested(config, ("tool", "apiUrl")))
    if sandbox_api_url:
        print(shell_export("SANDBOX_API_URL", sandbox_api_url))

    extra_args = config.get("extraVerlArgs")
    if extra_args:
        if not isinstance(extra_args, list):
            raise TypeError("extraVerlArgs must be a YAML list")
        print(shell_export("EXTRA_VERL_ARGS", " ".join(str(x) for x in extra_args)))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
