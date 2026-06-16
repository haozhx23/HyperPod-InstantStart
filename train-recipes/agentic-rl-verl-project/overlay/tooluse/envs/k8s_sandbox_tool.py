"""Cluster sandbox tools for veRL.

These tools implement the same BaseTool lifecycle as the local Docker tools,
but delegate sandbox creation and command execution to the in-cluster
agentic-rl-sandbox ClusterIP service.
"""

from __future__ import annotations

import json
import os
from typing import Any, Optional
from uuid import uuid4

import requests
from verl.tools.base_tool import BaseTool
from verl.tools.schemas import OpenAIFunctionToolSchema, ToolResponse


SANDBOX_API_URL = os.environ.get("SANDBOX_API_URL", "http://agentic-rl-sandbox.default.svc.cluster.local:8080")


class _RemoteSandboxTool(BaseTool):
    default_image = "ubuntu:22.04"
    default_timeout = 120
    workdir = "/workspace"

    def __init__(self, config: dict, tool_schema: OpenAIFunctionToolSchema):
        super().__init__(config, tool_schema)
        self._instances: dict[str, dict[str, Any]] = {}
        self.api_url = config.get("api_url") or SANDBOX_API_URL
        self.image = config.get("image", self.default_image)
        self.timeout = config.get("timeout", self.default_timeout)
        self.setup_timeout = config.get("setup_timeout", 300)
        self.max_output_len = config.get("max_output_len", 8000)

    def _create_payload(self, instance_id: str, create_kwargs: dict[str, Any]) -> dict[str, Any]:
        return {
            "session_id": instance_id,
            "image": self.image,
            "workdir": "/workspace",
            "setup_commands": [],
        }

    async def create(self, instance_id: Optional[str] = None, create_kwargs: dict = None, **kwargs) -> tuple[str, ToolResponse]:
        instance_id = instance_id or str(uuid4())
        create_kwargs = create_kwargs or {}
        payload = self._create_payload(instance_id, create_kwargs)

        try:
            response = requests.post(f"{self.api_url}/sessions", json=payload, timeout=self.setup_timeout + 30)
            response.raise_for_status()
            data = response.json()
            self._instances[instance_id] = {
                "pod": data.get("pod"),
                "workdir": payload.get("runtime_workdir", self.workdir),
            }
            return instance_id, ToolResponse(text=f"Sandbox ready: {data.get('pod')}")
        except Exception as exc:
            self._instances[instance_id] = {"pod": None, "workdir": self.workdir}
            return instance_id, ToolResponse(text=f"Sandbox setup failed: {exc}")

    async def execute(self, instance_id: str, parameters: dict[str, Any], **kwargs) -> tuple[ToolResponse, float, dict]:
        info = self._instances.get(instance_id)
        if not info or not info.get("pod"):
            return ToolResponse(text="No sandbox available"), 0.0, {}

        command = parameters.get("command", "")
        if not command:
            return ToolResponse(text="No command provided"), 0.0, {}

        try:
            response = requests.post(
                f"{self.api_url}/sessions/{instance_id}/exec",
                json={"command": command, "timeout_seconds": self.timeout, "workdir": info.get("workdir", self.workdir)},
                timeout=self.timeout + 30,
            )
            response.raise_for_status()
            data = response.json()
            output = data.get("output") or "(no output)"
            if len(output) > self.max_output_len:
                half = self.max_output_len // 2
                output = output[:half] + "\n...(truncated)...\n" + output[-half:]
            exit_code = data.get("exit_code", 0)
            text = f"Exit code: {exit_code}\n{output}" if exit_code else output
        except Exception as exc:
            text = f"Execution error: {exc}"

        return ToolResponse(text=text), 0.0, {}

    async def calc_reward(self, instance_id: str, **kwargs) -> float:
        return 0.0

    async def release(self, instance_id: str, **kwargs) -> None:
        self._instances.pop(instance_id, None)
        try:
            requests.delete(f"{self.api_url}/sessions/{instance_id}", timeout=30)
        except Exception:
            pass


class K8sTerminalSandboxTool(_RemoteSandboxTool):
    default_image = "ubuntu:22.04"
    default_timeout = 60
    workdir = "/workspace"


class K8sDevOpsSandboxTool(_RemoteSandboxTool):
    default_image = "ubuntu:22.04"
    default_timeout = 120
    workdir = "/workspace"

    def _create_payload(self, instance_id: str, create_kwargs: dict[str, Any]) -> dict[str, Any]:
        devops_instance = create_kwargs.get("devops_instance", {})
        image = devops_instance.get("docker_image") or self.image
        setup_commands = []
        if devops_instance.get("run_command"):
            setup_commands.append(devops_instance["run_command"])
        return {
            "session_id": instance_id,
            "image": image,
            "workdir": "/workspace",
            "runtime_workdir": "/workspace",
            "setup_commands": setup_commands,
            "labels": {"agentic-rl/task": "devops"},
        }


class K8sSWESandboxTool(_RemoteSandboxTool):
    default_image = "python:3.12-slim"
    default_timeout = 120
    workdir = "/workspace/repo"

    def _create_payload(self, instance_id: str, create_kwargs: dict[str, Any]) -> dict[str, Any]:
        swe_instance = create_kwargs.get("swe_instance", {})
        repo = swe_instance.get("repo", "")
        base_commit = swe_instance.get("base_commit", "")
        setup_commands = [
            "apt-get update -qq && apt-get install -y -qq git ca-certificates >/dev/null 2>&1 || true",
        ]
        if repo and base_commit:
            setup_commands.append(
                "rm -rf /workspace/repo && "
                f"git clone --depth=50 https://github.com/{repo}.git /workspace/repo && "
                f"cd /workspace/repo && git checkout {base_commit} && "
                "python -m pip install -e . >/dev/null 2>&1 || true"
            )
        return {
            "session_id": instance_id,
            "image": self.image,
            "workdir": "/workspace",
            "runtime_workdir": "/workspace/repo",
            "setup_commands": setup_commands,
            "labels": {"agentic-rl/task": "swe"},
        }

    async def calc_reward(self, instance_id: str, **kwargs) -> float:
        info = self._instances.get(instance_id) or {}
        fail_to_pass = kwargs.get("fail_to_pass") or info.get("fail_to_pass")
        if isinstance(fail_to_pass, str):
            try:
                fail_to_pass = json.loads(fail_to_pass)
            except Exception:
                fail_to_pass = []
        if not fail_to_pass:
            return 0.0
        tests = " ".join(fail_to_pass)
        response, _, _ = await self.execute(instance_id, {"command": f"python -m pytest {tests} --tb=no -q"})
        text = response.text or ""
        return 1.0 if "failed" not in text and "passed" in text else 0.0
