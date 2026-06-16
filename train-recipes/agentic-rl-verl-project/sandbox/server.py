#!/usr/bin/env python3
"""Kubernetes-backed sandbox manager for agentic veRL rollouts.

The training Ray pods call this service over ClusterIP.  The service owns the
privilege to create sandbox pods and exec commands in them, keeping Docker and
Kubernetes credentials out of the GPU training pods.
"""

from __future__ import annotations

import os
import time
from typing import Any

from fastapi import FastAPI, HTTPException
from kubernetes import client, config
from kubernetes.client.rest import ApiException
from kubernetes.stream import stream
from pydantic import BaseModel, Field


NAMESPACE = os.environ.get("POD_NAMESPACE") or os.environ.get("NAMESPACE", "default")
DEFAULT_IMAGE = os.environ.get("SANDBOX_IMAGE_DEFAULT", "ubuntu:22.04")
POD_TIMEOUT_SECONDS = int(os.environ.get("SANDBOX_POD_TIMEOUT_SECONDS", "180"))
CPU_REQUEST = os.environ.get("SANDBOX_CPU_REQUEST", "500m")
MEMORY_REQUEST = os.environ.get("SANDBOX_MEMORY_REQUEST", "1Gi")

try:
    config.load_incluster_config()
except config.ConfigException:
    config.load_kube_config()

core = client.CoreV1Api()
app = FastAPI(title="agentic-rl-sandbox-manager")


class CreateRequest(BaseModel):
    session_id: str
    image: str | None = None
    workdir: str = "/workspace"
    setup_commands: list[str] = Field(default_factory=list)
    env: dict[str, str] = Field(default_factory=dict)
    labels: dict[str, str] = Field(default_factory=dict)


class ExecRequest(BaseModel):
    command: str
    workdir: str = "/workspace"
    timeout_seconds: int = 120


def _pod_name(session_id: str) -> str:
    cleaned = "".join(c if c.isalnum() or c == "-" else "-" for c in session_id.lower())
    return f"arl-sandbox-{cleaned[:48]}".strip("-")


def _wait_ready(name: str, timeout_seconds: int = POD_TIMEOUT_SECONDS) -> None:
    deadline = time.time() + timeout_seconds
    last_phase = ""
    while time.time() < deadline:
        pod = core.read_namespaced_pod(name=name, namespace=NAMESPACE)
        last_phase = pod.status.phase or ""
        conditions = pod.status.conditions or []
        if any(c.type == "Ready" and c.status == "True" for c in conditions):
            return
        if last_phase in {"Failed", "Succeeded"}:
            raise RuntimeError(f"pod finished before becoming ready: {last_phase}")
        time.sleep(2)
    raise TimeoutError(f"pod {name} did not become ready, last phase={last_phase}")


def _exec(name: str, command: str, timeout_seconds: int, workdir: str) -> tuple[str, int]:
    marker = "__AGENTIC_RL_EXIT_CODE__:"
    wrapped = (
        f"cd {workdir} 2>/dev/null || cd /; "
        f"timeout {timeout_seconds} bash -lc {command!r}; "
        f"code=$?; printf '\\n{marker}%s\\n' \"$code\""
    )
    output = stream(
        core.connect_get_namespaced_pod_exec,
        name,
        NAMESPACE,
        command=["bash", "-lc", wrapped],
        stderr=True,
        stdin=False,
        stdout=True,
        tty=False,
        _preload_content=True,
    )
    output = output or ""
    if marker in output:
        body, _, tail = output.rpartition(marker)
        try:
            return body.rstrip("\n"), int(tail.strip().splitlines()[0])
        except Exception:
            return output, 0
    return output, 0


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok", "namespace": NAMESPACE}


@app.post("/sessions")
def create_session(req: CreateRequest) -> dict[str, Any]:
    name = _pod_name(req.session_id)
    image = req.image or DEFAULT_IMAGE
    labels = {
        "app.kubernetes.io/name": "agentic-rl-sandbox",
        "agentic-rl/session": name,
        **req.labels,
    }

    env = [client.V1EnvVar(name=k, value=v) for k, v in req.env.items()]
    pod = client.V1Pod(
        metadata=client.V1ObjectMeta(name=name, labels=labels),
        spec=client.V1PodSpec(
            restart_policy="Never",
            termination_grace_period_seconds=5,
            containers=[
                client.V1Container(
                    name="sandbox",
                    image=image,
                    image_pull_policy=os.environ.get("SANDBOX_IMAGE_PULL_POLICY", "IfNotPresent"),
                    command=["bash", "-lc", "mkdir -p /workspace && sleep infinity"],
                    working_dir="/workspace",
                    env=env,
                    resources=client.V1ResourceRequirements(
                        requests={"cpu": CPU_REQUEST, "memory": MEMORY_REQUEST},
                    ),
                )
            ],
        ),
    )

    try:
        core.create_namespaced_pod(namespace=NAMESPACE, body=pod)
    except ApiException as exc:
        if exc.status != 409:
            raise HTTPException(status_code=500, detail=exc.reason) from exc

    try:
        _wait_ready(name)
        for command in req.setup_commands:
            _exec(name, command, POD_TIMEOUT_SECONDS, req.workdir)
    except Exception as exc:
        try:
            core.delete_namespaced_pod(name=name, namespace=NAMESPACE)
        except Exception:
            pass
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return {"session_id": req.session_id, "pod": name, "workdir": req.workdir, "image": image}


@app.post("/sessions/{session_id}/exec")
def exec_session(session_id: str, req: ExecRequest) -> dict[str, Any]:
    name = _pod_name(session_id)
    try:
        output, exit_code = _exec(name, req.command, req.timeout_seconds, req.workdir)
    except ApiException as exc:
        raise HTTPException(status_code=404, detail=f"sandbox pod not found: {name}") from exc
    return {"output": output, "exit_code": exit_code}


@app.delete("/sessions/{session_id}")
def delete_session(session_id: str) -> dict[str, str]:
    name = _pod_name(session_id)
    try:
        core.delete_namespaced_pod(name=name, namespace=NAMESPACE)
    except ApiException as exc:
        if exc.status != 404:
            raise HTTPException(status_code=500, detail=exc.reason) from exc
    return {"status": "deleted", "pod": name}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
