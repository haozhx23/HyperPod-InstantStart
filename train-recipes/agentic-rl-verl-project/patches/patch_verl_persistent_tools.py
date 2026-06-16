#!/usr/bin/env python3
"""Patch veRL ToolAgentLoop to keep BaseTool instances for a full rollout.

Upstream veRL creates/releases BaseTool instances around every tool call, which
breaks stateful code/shell sandboxes.  This patch changes only BaseTool
lifecycle handling; FunctionTool remains stateless.
"""

from __future__ import annotations

import pathlib
import sys


def main() -> int:
    verl_root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "/workspace/verl")
    target = verl_root / "verl/experimental/agent_loop/tool_agent_loop.py"
    if not target.exists():
        print(f"ERROR: {target} not found", file=sys.stderr)
        return 1

    text = target.read_text()
    marker = "agentic-rl persistent BaseTool lifecycle patch"
    if marker in text:
        print("veRL ToolAgentLoop is already patched")
        return 0

    old_loop = """        # State machine loop
        state = AgentState.PENDING
        while state != AgentState.TERMINATED:
            if state == AgentState.PENDING:
                state = await self._handle_pending_state(agent_data, sampling_params)
            elif state == AgentState.GENERATING:
                state = await self._handle_generating_state(agent_data, sampling_params)
            elif state == AgentState.PROCESSING_TOOLS:
                state = await self._handle_processing_tools_state(agent_data)
            else:
                logger.error(f"Invalid state: {state}")
                state = AgentState.TERMINATED
"""
    new_loop = """        # State machine loop
        # agentic-rl persistent BaseTool lifecycle patch: release stateful tools once per rollout.
        state = AgentState.PENDING
        try:
            while state != AgentState.TERMINATED:
                if state == AgentState.PENDING:
                    state = await self._handle_pending_state(agent_data, sampling_params)
                elif state == AgentState.GENERATING:
                    state = await self._handle_generating_state(agent_data, sampling_params)
                elif state == AgentState.PROCESSING_TOOLS:
                    state = await self._handle_processing_tools_state(agent_data)
                else:
                    logger.error(f"Invalid state: {state}")
                    state = AgentState.TERMINATED
        finally:
            await self._release_tool_instances(agent_data)
"""

    old_base_tool = """            else:
                # BaseTool subclass
                kwargs = tools_kwargs.get(tool_name, {})
                instance_id, _ = await tool.create(create_kwargs=kwargs.get("create_kwargs", {}))
                tool_execution_response, tool_reward, res = await tool.execute(
                    instance_id, tool_args, agent_data=agent_data
                )
        except Exception as e:
            logger.warning(f"Error executing tool '{tool_name}': {e}")
            return ToolResponse(text=f"Error executing tool '{tool_name}': {e}"), 0.0, {}
        finally:
            # Only BaseTool instances need release (function tools never set instance_id).
            if tool and instance_id and not isinstance(tool, FunctionTool):
                await tool.release(instance_id)
"""
    new_base_tool = """            else:
                # BaseTool subclass.  Cache one instance per tool per rollout so filesystem/process
                # state survives across multiple assistant turns.
                kwargs = tools_kwargs.get(tool_name, {})
                tool_instances = agent_data.extra_fields.setdefault("_tool_instances", {})
                if tool_name in tool_instances:
                    instance_id = tool_instances[tool_name]
                else:
                    instance_id, _ = await tool.create(create_kwargs=kwargs.get("create_kwargs", {}))
                    tool_instances[tool_name] = instance_id
                tool_execution_response, tool_reward, res = await tool.execute(
                    instance_id, tool_args, agent_data=agent_data
                )
        except Exception as e:
            logger.warning(f"Error executing tool '{tool_name}': {e}")
            return ToolResponse(text=f"Error executing tool '{tool_name}': {e}"), 0.0, {}
"""

    release_method = '''    async def _release_tool_instances(self, agent_data: AgentData) -> None:
        """Release cached BaseTool instances at rollout end."""
        tool_instances = agent_data.extra_fields.pop("_tool_instances", {})
        active_tools = getattr(agent_data, "_active_tools", self.tools)
        for tool_name, instance_id in list(tool_instances.items()):
            tool = active_tools.get(tool_name)
            if tool and not isinstance(tool, FunctionTool):
                try:
                    await tool.release(instance_id)
                except Exception as e:
                    logger.warning(f"Error releasing tool '{tool_name}' instance '{instance_id}': {e}")

'''

    if old_loop not in text:
        print("ERROR: could not locate ToolAgentLoop state-machine block", file=sys.stderr)
        return 1
    if old_base_tool not in text:
        print("ERROR: could not locate BaseTool create/execute/release block", file=sys.stderr)
        return 1

    text = text.replace(old_loop, new_loop)
    text = text.replace(old_base_tool, new_base_tool)
    text = text.replace("    async def _call_tool(\n", release_method + "    async def _call_tool(\n")
    target.write_text(text)
    print(f"patched {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
