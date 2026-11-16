#!/usr/bin/env python3
"""
HyperPod InstantStart MCP Server
"""

from mcp.server import FastMCP
from mcp.types import CallToolResult, TextContent, ToolAnnotations
from pydantic import BaseModel, ConfigDict, Field, model_validator
from functools import wraps
from typing import Annotated, Any, Literal
import inspect
import httpx
import json
import os

import asyncio

class HyperPodMCP(FastMCP):
    """拒绝未定义的顶层参数，避免 SDK 忽略拼写错误或未接通的参数。"""
    async def list_tools(self):
        tools = await super().list_tools()
        return [tool.model_copy(update={
            "inputSchema": {**tool.inputSchema, "additionalProperties": False}
        }) for tool in tools]

    async def call_tool(self, name: str, arguments: dict[str, Any]):
        tool = next((tool for tool in await self.list_tools() if tool.name == name), None)
        if tool:
            unexpected = set(arguments) - set(tool.inputSchema.get("properties", {}))
            if unexpected:
                result = {"success": False, "error": f"Unexpected arguments: {', '.join(sorted(unexpected))}"}
                return CallToolResult(
                    content=[TextContent(type="text", text=json.dumps(result, ensure_ascii=False))],
                    structuredContent=result,
                    isError=True,
                )
        return await super().call_tool(name, arguments)


mcp = HyperPodMCP(
    name="hyperpod-manager",
    instructions="HyperPod InstantStart 管理工具，提供集群管理、模型下载、推理部署和 Kubernetes Job 查询。操作默认针对面板当前活跃集群。"
)

BASE_URL = os.environ.get("HYPD_INST_API_BASE_URL", "http://127.0.0.1:3099").rstrip("/")
AUTH_CONFIG_PATH = os.environ.get("HYPD_INST_AUTH_CONFIG_PATH", "/app/config/auth.json")

NonNegativeInt = Annotated[int, Field(ge=0, strict=True)]
InstanceCount = Annotated[int, Field(ge=0, le=10000, strict=True)]
VolumeSize = Annotated[int, Field(ge=1, le=65536, strict=True)]
PortNumber = Annotated[int, Field(ge=1, le=65535, strict=True)]
AutoResource = Annotated[int, Field(ge=-1, strict=True)]


class ToolResult(BaseModel):
    """工具的共同结果字段；后端返回的其他字段原样保留。"""
    model_config = ConfigDict(extra="allow")
    success: bool


class FeatureToggle(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: Annotated[bool, Field(strict=True, description="true 开启，false 关闭")]


class TieredStorageConfig(FeatureToggle):
    configMode: Literal["default", "custom"] = "default"
    percentage: Annotated[int, Field(ge=1, le=100, strict=True)] | None = None

    @model_validator(mode="after")
    def require_custom_percentage(self):
        if self.enabled and self.configMode == "custom" and self.percentage is None:
            raise ValueError("percentage is required when enabled with configMode=custom")
        return self


def _tool(*, read_only=False, destructive=False, open_world=True):
    """统一注册工具，保留参数 schema，并返回可直接读取的结构化结果。"""
    def register(fn):
        @wraps(fn)
        async def invoke(*args, **kwargs):
            try:
                result = await fn(*args, **kwargs)
                if not isinstance(result, dict):
                    raise ValueError("Tool result must be a JSON object")
                result = dict(result)
                result.setdefault("success", not bool(result.get("error")))
                if result["success"] is False and not result.get("error"):
                    result["error"] = result.get("message") or "Operation failed"
            except httpx.HTTPStatusError as exc:
                result = _json_or_error(exc.response)
            except Exception as exc:
                result = {"success": False, "error": str(exc) or type(exc).__name__}
            result = ToolResult.model_validate(result).model_dump(mode="json")
            return CallToolResult(
                content=[TextContent(type="text", text=json.dumps(result, indent=2, ensure_ascii=False))],
                structuredContent=result,
                isError=result["success"] is False,
            )

        invoke.__signature__ = inspect.signature(fn).replace(
            return_annotation=Annotated[CallToolResult, ToolResult]
        )
        mcp.tool(annotations=ToolAnnotations(
            readOnlyHint=read_only,
            destructiveHint=destructive,
            idempotentHint=read_only,
            openWorldHint=open_world,
        ))(invoke)
        return fn
    return register


def _auth_headers() -> dict[str, str]:
    token = os.environ.get("HYPD_INST_AUTH_TOKEN")
    if token:
        return {"x-auth-token": token}

    try:
        with open(AUTH_CONFIG_PATH, encoding="utf-8") as config_file:
            auth_config = json.load(config_file)
    except (OSError, json.JSONDecodeError):
        return {}

    if auth_config.get("enabled") is False:
        return {}

    token = auth_config.get("hash")
    return {"x-auth-token": token} if token else {}


async def _check_response(response: httpx.Response):
    await response.aread()
    if not response.is_success:
        result = _json_or_error(response)
        raise httpx.HTTPStatusError(
            str(result["error"]), request=response.request, response=response
        )


def _exception_text(exc: Exception) -> str:
    return str(exc) or type(exc).__name__


def api_client(**kwargs) -> httpx.AsyncClient:
    kwargs.setdefault("timeout", 60)
    return httpx.AsyncClient(
        headers=_auth_headers(), event_hooks={"response": [_check_response]}, **kwargs
    )


async def _active_cluster_tag() -> str:
    async with api_client() as client:
        response = await client.get(f"{BASE_URL}/api/multi-cluster/list")
        data = response.json()
    if data.get("success") is False:
        raise ValueError(data.get("error") or "Cannot list managed clusters")
    cluster_tag = data.get("activeCluster")
    if not cluster_tag:
        raise ValueError("No active cluster found. Please specify clusterTag.")
    return cluster_tag

# ============ 通用工具 ============

@_tool(read_only=True, open_world=False)
async def wait_seconds(seconds: Annotated[int, Field(ge=0, le=300, strict=True)]) -> dict[str, Any]:
    """等待指定秒数（用于轮询间隔）

    Args:
        seconds: 等待秒数（0–300）
    """
    await asyncio.sleep(seconds)
    return {"success": True, "message": f"Waited {seconds} seconds"}

# ============ 集群管理工具 ============

@_tool(read_only=True)
async def cluster_get_status() -> dict[str, Any]:
    """获取当前集群 EKS 节点运行状态，包括节点 Ready 状态、GPU 使用量等实时信息"""
    async with api_client() as client:
        response = await client.get(f"{BASE_URL}/api/cluster-status")
        response.raise_for_status()
        return response.json()

@_tool()
async def cluster_create_eks(clusterTag: str | None = None, region: str | None = None, vpcCidr: str | None = None) -> dict[str, Any]:
    """创建新的 EKS 集群（需要 8-12 分钟）
    
    Args:
        clusterTag: 集群标签（可选，默认自动生成如 hypd-0303）
        region: AWS 区域（可选，默认是面板主机所在的区域；可以指定其他区域）
        vpcCidr: VPC CIDR 块（可选，默认自动生成）
    """
    try:
        if not region:
            async with api_client() as client:
                region_resp = await client.get(f"{BASE_URL}/api/aws/current-region")
                if region_resp.status_code == 200:
                    region = region_resp.json().get("region")
        
        if not region:
            return {"success": False, "error": "Cannot determine AWS region. Please specify region parameter."}
        
        if not clusterTag:
            from datetime import datetime
            clusterTag = f"hypd-{datetime.now().strftime('%m%d')}"
        
        payload = {"clusterTag": clusterTag, "awsRegion": region}
        if vpcCidr:
            payload["customVpcCidr"] = vpcCidr
        
        async with api_client(timeout=300) as client:
            response = await client.post(f"{BASE_URL}/api/cluster/create-eks", json=payload)
            response.raise_for_status()
            result = response.json()
            
            if result.get("success"):
                return {
                    "success": True,
                    "message": f"✅ EKS cluster creation started",
                    "clusterTag": clusterTag,
                    "region": region,
                    "estimatedTime": "8-12 minutes",
                    "tip": "Use 'cluster_get_eks_creation_status' to monitor progress, then 'cluster_switch' to switch to the new cluster"
                }
            else:
                return result
                
    except Exception as e:
        return {"success": False, "error": _exception_text(e)}

@_tool()
async def cluster_create_eks_with_cidr(
    clusterTag: str,
    region: str,
    vpcCidr: str,
    publicSubnet1Cidr: str,
    publicSubnet2Cidr: str,
    eksPrivateSubnet1Cidr: str,
    eksPrivateSubnet2Cidr: str,
    hyperPodPrivateSubnetCidr: str
) -> dict[str, Any]:
    """创建 EKS 集群并自定义全部 CIDR 配置（需要 8-12 分钟）

    所有 CIDR 参数均为必填。如需自动生成 CIDR，请使用 cluster_create_eks。

    Args:
        clusterTag: 集群标签，如 hypd-0303
        region: AWS 区域，如 us-west-2
        vpcCidr: VPC CIDR 块，如 10.100.0.0/16
        publicSubnet1Cidr: Public Subnet 1 CIDR，如 10.100.10.0/24
        publicSubnet2Cidr: Public Subnet 2 CIDR，如 10.100.11.0/24
        eksPrivateSubnet1Cidr: EKS Private Subnet 1 CIDR，如 10.100.7.0/24
        eksPrivateSubnet2Cidr: EKS Private Subnet 2 CIDR，如 10.100.8.0/24
        hyperPodPrivateSubnetCidr: HyperPod Private Subnet CIDR，如 10.100.32.0/20
    """
    try:
        cidrConfig = {
            "vpcCidr": vpcCidr,
            "publicSubnet1Cidr": publicSubnet1Cidr,
            "publicSubnet2Cidr": publicSubnet2Cidr,
            "eksPrivateSubnet1Cidr": eksPrivateSubnet1Cidr,
            "eksPrivateSubnet2Cidr": eksPrivateSubnet2Cidr,
            "hyperPodPrivateSubnetCidr": hyperPodPrivateSubnetCidr,
        }

        payload = {
            "clusterTag": clusterTag,
            "awsRegion": region,
            "cidrConfig": cidrConfig
        }

        async with api_client(timeout=300) as client:
            response = await client.post(f"{BASE_URL}/api/cluster/create-eks", json=payload)
            response.raise_for_status()
            result = response.json()

            if result.get("success"):
                return {
                    "success": True,
                    "message": "✅ EKS cluster creation started with custom CIDR",
                    "clusterTag": clusterTag,
                    "region": region,
                    "cidrConfig": cidrConfig,
                    "estimatedTime": "8-12 minutes",
                    "tip": "Use 'cluster_get_eks_creation_status' to monitor progress"
                }
            else:
                return result

    except Exception as e:
        return {"success": False, "error": _exception_text(e)}

@_tool(read_only=True)
async def cluster_list_all() -> dict[str, Any]:
    """列出所有已管理的集群"""
    async with api_client() as client:
        response = await client.get(f"{BASE_URL}/api/multi-cluster/list")
        response.raise_for_status()
        return response.json()

@_tool(read_only=True)
async def cluster_get_instance_groups() -> dict[str, Any]:
    """获取当前集群的所有实例组（EKS 节点组 + HyperPod 实例组），包括 CurrentCount=0 的实例组"""
    async with api_client() as client:
        response = await client.get(f"{BASE_URL}/api/cluster/nodegroups")
        response.raise_for_status()
        return response.json()

@_tool()
async def cluster_switch(clusterTag: str) -> dict[str, Any]:
    """切换当前操作的集群
    
    Args:
        clusterTag: 目标集群标签
    """
    async with api_client() as client:
        response = await client.post(f"{BASE_URL}/api/multi-cluster/switch", json={"clusterTag": clusterTag})
        response.raise_for_status()
        return response.json()

def _json_or_error(response: httpx.Response) -> dict[str, Any]:
    """返回接口的 JSON 响应体；4xx/5xx 时也保留后端给出的 error 文本，而不是只抛 HTTP 状态码。"""
    try:
        body = response.json()
    except ValueError:
        body = {"success": False, "error": f"HTTP {response.status_code}: {response.text[:500]}"}
    if not isinstance(body, dict):
        return {"success": False, "error": f"HTTP {response.status_code}: expected a JSON object"}
    if not response.is_success:
        body["success"] = False
        body["error"] = body.get("error") or body.get("message") or f"HTTP {response.status_code}"
        body["httpStatus"] = response.status_code
    return body

@_tool(read_only=True)
async def cluster_test_connection(eksClusterName: str, region: str) -> dict[str, Any]:
    """测试面板能否连接一个已有的 EKS 集群（不导入、不切换活跃集群）

    集群可以和面板主机不在同一个 AWS 区域。返回节点数；EKS API endpoint 关闭公网访问
    或限制了来源 CIDR 时，结果里的 endpointWarning 会说明。

    Args:
        eksClusterName: EKS 集群名称
        region: 集群所在的 AWS 区域（如 us-east-1），不是面板主机的区域
    """
    try:
        async with api_client(timeout=120) as client:
            response = await client.post(
                f"{BASE_URL}/api/cluster/test-connection",
                json={"eksClusterName": eksClusterName, "awsRegion": region},
            )
            return _json_or_error(response)
    except Exception as e:
        return {"success": False, "error": _exception_text(e)}

@_tool()
async def cluster_import(eksClusterName: str, region: str, hyperPodClusters: str | None = None, computeSecurityGroup: str | None = None) -> dict[str, Any]:
    """导入一个已有的 EKS（+ HyperPod）集群，集群可以和面板主机不在同一个 AWS 区域

    导入不会切换活跃集群；导入成功后用 cluster_switch(clusterTag) 切换。结果里的 warnings
    列出需要注意的问题（如 EKS API endpoint 只开私有访问）。

    Args:
        eksClusterName: EKS 集群名称（导入后即为 clusterTag）
        region: 集群所在的 AWS 区域（如 us-east-1），不是面板主机的区域
        hyperPodClusters: 关联的 HyperPod 集群名，多个用逗号分隔（可选，默认自动检测）
        computeSecurityGroup: 计算节点安全组 ID（可选，默认自动检测）
    """
    payload = {"eksClusterName": eksClusterName, "awsRegion": region}
    if hyperPodClusters:
        payload["hyperPodClusters"] = hyperPodClusters
    if computeSecurityGroup:
        payload["computeSecurityGroup"] = computeSecurityGroup
    try:
        async with api_client(timeout=600) as client:
            response = await client.post(f"{BASE_URL}/api/cluster/import", json=payload)
            return _json_or_error(response)
    except Exception as e:
        return {"success": False, "error": _exception_text(e)}


@_tool()
async def cluster_get_eks_creation_status() -> dict[str, Any]:
    """获取正在创建的 EKS 集群状态（CloudFormation stack 状态）"""
    async with api_client() as client:
        response = await client.get(f"{BASE_URL}/api/cluster/creating-clusters")
        response.raise_for_status()
        data = response.json()
        clusters = data.get("clusters", {})
        if not clusters:
            return {"success": True, "message": "No EKS clusters currently being created", "clusters": {}}
        return {"success": True, "clusters": clusters}

@_tool()
async def cluster_configure_dependencies() -> dict[str, Any]:
    """为当前活跃的 EKS 集群安装和配置依赖（如 GPU 插件、存储驱动等）。
    EKS 集群创建完成并切换到该集群后，需要先配置依赖才能创建 HyperPod 集群。
    """
    try:
        async with api_client(timeout=600) as client:
            response = await client.post(f"{BASE_URL}/api/cluster/configure-dependencies")
            response.raise_for_status()
            result = response.json()
            if result.get("success"):
                return {
                    "success": True,
                    "message": "✅ Dependency configuration started",
                    "clusterTag": result.get("clusterTag"),
                    "tip": "Use 'cluster_get_dependency_status' to monitor progress. Once completed, you can create a HyperPod cluster."
                }
            return result
    except httpx.HTTPStatusError as e:
        body = e.response.json() if e.response.headers.get("content-type", "").startswith("application/json") else {}
        return {"success": False, "error": body.get("error", _exception_text(e))}
    except Exception as e:
        return {"success": False, "error": _exception_text(e)}

@_tool(read_only=True)
async def cluster_get_dependency_status(clusterTag: str | None = None) -> dict[str, Any]:
    """获取集群依赖配置状态
    
    Args:
        clusterTag: 集群标签（可选，默认使用当前活跃集群）
    """
    try:
        if not clusterTag:
            clusterTag = await _active_cluster_tag()
        
        async with api_client() as client:
            response = await client.get(f"{BASE_URL}/api/cluster/{clusterTag}/dependencies/status")
            response.raise_for_status()
            return response.json()
    except Exception as e:
        return {"success": False, "error": _exception_text(e)}

@_tool()
async def hyperpod_create(
    hyperPodTag: str,
    AcceleratedInstanceType: str,
    AcceleratedInstanceCount: InstanceCount,
    availabilityZone: str,
    AcceleratedEBSVolumeSize: VolumeSize = 500,
    AcceleratedTrainingPlanArn: str = "",
    computeSubnetId: str = ""
) -> dict[str, Any]:
    """创建 HyperPod 集群（需要先完成 EKS 集群创建和依赖配置）
    
    Args:
        hyperPodTag: HyperPod 标签名称
        AcceleratedInstanceType: GPU 实例类型，如 ml.g5.xlarge, ml.p4d.24xlarge
        AcceleratedInstanceCount: GPU 实例数量
        availabilityZone: 可用区，如 us-west-2a
        AcceleratedEBSVolumeSize: EBS 卷大小 GB（默认 500）
        AcceleratedTrainingPlanArn: Training Plan ARN（可选）
        computeSubnetId: 计算子网 ID（可选，自动检测）
    """
    try:
        userConfig = {
            "hyperPodTag": hyperPodTag,
            "AcceleratedInstanceType": AcceleratedInstanceType,
            "AcceleratedInstanceCount": AcceleratedInstanceCount,
            "AcceleratedEBSVolumeSize": AcceleratedEBSVolumeSize,
            "availabilityZone": availabilityZone,
        }
        if AcceleratedTrainingPlanArn:
            userConfig["AcceleratedTrainingPlanArn"] = AcceleratedTrainingPlanArn
        if computeSubnetId:
            userConfig["computeSubnetId"] = computeSubnetId
        
        async with api_client(timeout=300) as client:
            response = await client.post(f"{BASE_URL}/api/cluster/create-hyperpod", json={"userConfig": userConfig})
            response.raise_for_status()
            result = response.json()
            if result.get("success"):
                return {
                    "success": True,
                    "message": "✅ HyperPod cluster creation started",
                    "stackName": result.get("stackName"),
                    "tip": "Use 'hyperpod_get_creation_status' to monitor progress"
                }
            return result
    except httpx.HTTPStatusError as e:
        body = e.response.json() if e.response.headers.get("content-type", "").startswith("application/json") else {}
        return {"success": False, "error": body.get("error", _exception_text(e))}
    except Exception as e:
        return {"success": False, "error": _exception_text(e)}

@_tool()
async def hyperpod_get_creation_status(clusterTag: str | None = None) -> dict[str, Any]:
    """获取首次创建 HyperPod 集群的 CloudFormation 状态。
    添加实例组、扩缩容后的运行状态请用 hyperpod_get_instance_group_status。
    
    Args:
        clusterTag: 集群标签（可选，默认使用当前活跃集群）
    """
    try:
        if not clusterTag:
            clusterTag = await _active_cluster_tag()
        
        async with api_client() as client:
            response = await client.get(f"{BASE_URL}/api/cluster/hyperpod-creation-status/{clusterTag}")
            response.raise_for_status()
            result = response.json()
            status = result.get("status")
            if not status:
                return {"success": True, "message": "No HyperPod cluster currently being created", "clusterTag": clusterTag}
            return {"success": True, "clusterTag": clusterTag, "status": status}
    except Exception as e:
        return {"success": False, "error": _exception_text(e)}

@_tool(read_only=True)
async def cluster_get_available_instances() -> dict[str, Any]:
    """获取当前集群可用的实例类型列表（用于创建 HyperPod 或节点组时选择实例类型）"""
    async with api_client() as client:
        response = await client.get(f"{BASE_URL}/api/cluster/cluster-available-instance")
        response.raise_for_status()
        return response.json()

@_tool(read_only=True)
async def cluster_get_availability_zones() -> dict[str, Any]:
    """获取当前集群可用的可用区列表"""
    try:
        async with api_client() as client:
            # 获取当前活跃集群的 region(active-region 优先返回活跃集群 region,无集群时回退主机)
            region_resp = await client.get(f"{BASE_URL}/api/aws/active-region")
            region_resp.raise_for_status()
            region = region_resp.json().get("region")
            if not region:
                return {"success": False, "error": "Cannot determine region"}
            response = await client.get(f"{BASE_URL}/api/cluster/availability-zones", params={"region": region})
            response.raise_for_status()
            return response.json()
    except Exception as e:
        return {"success": False, "error": _exception_text(e)}


@_tool()
async def hyperpod_karpenter_install(
    clusterTag: str | None = None,
    hyperPodClusterName: str | None = None,
) -> dict[str, Any]:
    """为 HyperPod 集群启用托管 Karpenter。

    Args:
        clusterTag: 已管理的集群标签（可选，默认当前活跃集群）
        hyperPodClusterName: HyperPod 集群名（可选，从该集群的元数据中读取）
    """
    async with api_client(timeout=300) as client:
        if not clusterTag or not hyperPodClusterName:
            response = await client.get(f"{BASE_URL}/api/multi-cluster/list")
            data = response.json()
            if data.get("success") is False:
                return data
            clusterTag = clusterTag or data.get("activeCluster")
            if not clusterTag:
                return {"success": False, "error": "No active cluster found. Please specify clusterTag."}
            if not hyperPodClusterName:
                cluster = next(
                    (c for c in data.get("clusters", []) if c.get("clusterTag") == clusterTag),
                    None,
                )
                hyperPodClusterName = (cluster or {}).get("hyperPodCluster", {}).get("ClusterName")
                if not hyperPodClusterName:
                    return {"success": False, "error": f"No HyperPod cluster found for {clusterTag}"}
        response = await client.post(
            f"{BASE_URL}/api/cluster/hyperpod-karpenter/install",
            json={"clusterTag": clusterTag, "hyperPodClusterName": hyperPodClusterName},
        )
        return response.json()


@_tool(read_only=True)
async def hyperpod_karpenter_get_status() -> dict[str, Any]:
    """获取当前活跃集群的 HyperPod 托管 Karpenter 安装状态"""
    async with api_client() as client:
        response = await client.get(f"{BASE_URL}/api/cluster/hyperpod-karpenter/status")
        result = response.json()
        if result.get("success") is False:
            return result
        return {"success": True, **result.get("data", {})}

@_tool(read_only=True)
async def hyperpod_get_advanced_features() -> dict[str, Any]:
    """获取当前活跃 HyperPod 集群的高级功能配置和安装状态"""
    async with api_client(timeout=30) as client:
        response = await client.get(f"{BASE_URL}/api/cluster/hyperpod/advanced-features")
        response.raise_for_status()
        return response.json()

@_tool(destructive=True)
async def hyperpod_update_advanced_features(
    tieredStorage: TieredStorageConfig | None = None,
    inferenceOperator: FeatureToggle | None = None,
    trainingOperator: FeatureToggle | None = None,
) -> dict[str, Any]:
    """更新当前活跃 HyperPod 集群的高级功能配置，至少指定一项功能。
    每项配置中的 enabled=true 开启功能，enabled=false 关闭功能。
    参数 schema 列出当前发行版本支持的功能及其配置字段。
    """
    try:
        payload = {}
        if tieredStorage is not None:
            payload["tieredStorage"] = tieredStorage.model_dump(exclude_none=True)
        if inferenceOperator is not None:
            payload["inferenceOperator"] = inferenceOperator.model_dump()
        if trainingOperator is not None:
            payload["trainingOperator"] = trainingOperator.model_dump()
        
        if not payload:
            return {"success": False, "error": "At least one feature must be specified"}
        
        async with api_client(timeout=120) as client:
            response = await client.post(f"{BASE_URL}/api/cluster/hyperpod/advanced-features", json=payload)
            response.raise_for_status()
            return response.json()
    except Exception as e:
        return {"success": False, "error": _exception_text(e)}

# ============ S3 存储管理工具 ============

@_tool(read_only=True)
async def s3_storage_get_defaults() -> dict[str, Any]:
    """获取 S3 存储挂载的默认配置（claim 名称、S3 桶名称、区域）"""
    try:
        async with api_client() as client:
            response = await client.get(f"{BASE_URL}/api/s3-storage-defaults")
            response.raise_for_status()
            return response.json()
    except Exception as e:
        return {"success": False, "error": _exception_text(e)}

@_tool()
async def s3_storage_create(name: str | None = None, bucketName: str | None = None, region: str | None = None) -> dict[str, Any]:
    """创建 S3 存储挂载（PV + PVC）

    Args:
        name: PVC claim 名称（可选，默认 s3-claim）
        bucketName: S3 桶名称（可选，默认使用系统检测的桶）
        region: S3 桶所在的 AWS 区域（可选；使用默认桶时默认取该桶的区域，指定其他桶时默认取集群所在区域）
    """
    try:
        # 获取默认值填充未提供的参数
        async with api_client() as client:
            defaults_resp = await client.get(f"{BASE_URL}/api/s3-storage-defaults")
            defaults_resp.raise_for_status()
            defaults = defaults_resp.json().get("defaults", {})

        # defaults.region 是默认桶自己的区域，可能和集群区域不同；换成别的桶时不能沿用它
        default_bucket = defaults.get("bucketName", "")
        uses_default_bucket = not bucketName or bucketName == default_bucket
        default_region = defaults.get("region", "") if uses_default_bucket else (defaults.get("clusterRegion") or defaults.get("region", ""))
        payload = {
            "name": name or defaults.get("name", "s3-claim"),
            "bucketName": bucketName or default_bucket,
            "region": region or default_region,
        }

        if not payload["bucketName"]:
            return {"success": False, "error": "No S3 bucket name provided and no default detected. Please specify bucketName."}

        async with api_client(timeout=60) as client:
            response = await client.post(f"{BASE_URL}/api/s3-storages", json=payload)
            response.raise_for_status()
            result = response.json()
            if result.get("success"):
                return {
                    "success": True,
                    "message": f"✅ S3 storage '{payload['name']}' created successfully",
                    "name": payload["name"],
                    "bucketName": payload["bucketName"],
                    "region": payload["region"],
                    "pvcName": result.get("pvcName"),
                    "pvName": result.get("pvName")
                }
            return result
    except httpx.HTTPStatusError as e:
        body = e.response.json() if e.response.headers.get("content-type", "").startswith("application/json") else {}
        return {"success": False, "error": body.get("error", _exception_text(e))}
    except Exception as e:
        return {"success": False, "error": _exception_text(e)}

@_tool(read_only=True)
async def s3_storage_list_contents(storage: str | None = None) -> dict[str, Any]:
    """列出 S3 存储桶中的文件和文件夹（模型文件等）
    
    Args:
        storage: PVC 存储名称（可选，默认使用 s3-claim）
    """
    async with api_client() as client:
        params = {"storage": storage} if storage else {}
        response = await client.get(f"{BASE_URL}/api/s3-storage", params=params)
        response.raise_for_status()
        return response.json()

# ============ 模型下载工具 ============

@_tool()
async def model_download_enhanced(
    modelId: str,
    s3Storage: str | None = None,
    cpu: str = "4",
    memory: str = "16",
    hfToken: str | None = None
) -> dict[str, Any]:
    """从 HuggingFace 下载模型到集群存储
    
    Args:
        modelId: HuggingFace 模型 ID，如 Qwen/Qwen2.5-7B-Instruct
        s3Storage: PVC 存储名称，如 s3-claim（可选，默认使用已挂载存储；不是 S3 桶名称）
        cpu: CPU 核心数（默认 4）
        memory: 内存大小 GB（默认 16）
        hfToken: HuggingFace Token（可选，用于私有模型）
    """
    try:
        if float(cpu) <= 0 or float(memory) <= 0:
            return {"success": False, "error": "cpu and memory must be positive numbers"}
        # 如果没有指定 s3Storage，尝试获取默认存储桶
        if not s3Storage:
            async with api_client() as client:
                storage_resp = await client.get(f"{BASE_URL}/api/s3-storages")
                if storage_resp.status_code == 200:
                    storages = storage_resp.json().get("storages", [])
                    if storages:
                        s3Storage = storages[0].get("name", "")
        
        if not s3Storage:
            return {
                "success": False,
                "error": "No S3 storage available. Please specify s3Storage parameter."
            }
        
        payload = {
            "modelId": modelId,
            "s3Storage": s3Storage,
            "resources": {
                "cpu": cpu,
                "memory": memory
            }
        }
        if hfToken:
            payload["hfToken"] = hfToken
        
        async with api_client(timeout=300) as client:
            response = await client.post(f"{BASE_URL}/api/download-model-enhanced", json=payload)
            response.raise_for_status()
            result = response.json()
            
            if result.get("success"):
                job_name = result.get("jobName", "")
                if not job_name:
                    return {"success": False, "error": "Backend did not return the Kubernetes job name"}
                return {
                    "success": True,
                    "message": f"✅ Model download started for {modelId}",
                    "jobName": job_name,
                    "s3Storage": s3Storage,
                    "resources": {
                        "cpu": f"{cpu} cores",
                        "memory": f"{memory}GB"
                    },
                    "tip": f"Monitor: job_get_status {job_name}"
                }
            else:
                return {
                    "success": False,
                    "error": result.get("error", "Unknown error")
                }
                
    except httpx.HTTPError as e:
        return {
            "success": False,
            "error": f"HTTP Error: {_exception_text(e)}"
        }
    except Exception as e:
        return {
            "success": False,
            "error": f"Error: {_exception_text(e)}"
        }

def _job_state(status: dict[str, Any]) -> tuple[str, bool]:
    conditions = {c.get("type") for c in status.get("conditions", []) if c.get("status") == "True"}
    if "Complete" in conditions or status.get("completionTime"):
        return "Succeeded", True
    if "Failed" in conditions:
        return "Failed", True
    if "FailureTarget" in conditions:
        return "Failing", False
    if status.get("active", 0) > 0:
        return "Running", False
    if status.get("failed", 0) > 0:
        return "Retrying", False
    return "Pending", False


_JOB_LABELS = {
    "Succeeded": "✅ Completed Successfully",
    "Failed": "❌ Failed",
    "Failing": "❌ Failure detected; pods terminating",
    "Running": "🔄 Running",
    "Retrying": "🔄 Retrying",
    "Pending": "⏳ Pending",
}


@_tool(read_only=True)
async def job_get_status(
    jobName: str,
    namespace: str = "default",
    clusterTag: str | None = None,
) -> dict[str, Any]:
    """查询 Kubernetes Job；只有最终 Failed 条件才表示任务失败。

    Args:
        jobName: 模型下载等任务返回的完整 Job 名称
        namespace: Job 所在的命名空间（默认 default）
        clusterTag: 集群标签（可选，默认面板当前活跃集群）
    """
    params = {"namespace": namespace}
    if clusterTag:
        params["clusterTag"] = clusterTag
    async with api_client() as client:
        response = await client.get(f"{BASE_URL}/api/k8s-jobs/{jobName}", params=params)
        result = response.json()
    if result.get("success") is False:
        return result
    job = result["job"]
    status = job.get("status", {})
    state, terminal = _job_state(status)
    return {
        "success": True,
        "clusterTag": result.get("clusterTag"),
        "jobName": jobName,
        "namespace": job.get("metadata", {}).get("namespace", namespace),
        "state": state,
        "terminal": terminal,
        "overallStatus": _JOB_LABELS[state],
        "details": {
            "active": status.get("active", 0),
            "succeeded": status.get("succeeded", 0),
            "failed": status.get("failed", 0),
            "completionTime": status.get("completionTime"),
            "startTime": status.get("startTime"),
            "creationTime": job.get("metadata", {}).get("creationTimestamp"),
        },
        "conditions": status.get("conditions", []),
    }


@_tool(read_only=True)
async def job_list_all(
    namespace: str | None = None,
    clusterTag: str | None = None,
) -> dict[str, Any]:
    """列出 Kubernetes Jobs（包括模型下载任务），默认查询所有命名空间。

    Args:
        namespace: 只查询该命名空间（可选，省略时查询全部）
        clusterTag: 集群标签（可选，默认面板当前活跃集群）
    """
    params = {"namespace": namespace} if namespace is not None else {"allNamespaces": "true"}
    if clusterTag:
        params["clusterTag"] = clusterTag
    async with api_client() as client:
        response = await client.get(f"{BASE_URL}/api/k8s-jobs", params=params)
        result = response.json()
    if result.get("success") is False:
        return result
    jobs = []
    for job in result["jobs"]:
        state, terminal = _job_state(job)
        jobs.append({**job, "state": state, "terminal": terminal, "status": _JOB_LABELS[state]})
    return {"success": True, "clusterTag": result.get("clusterTag"), "jobs": jobs, "total": len(jobs)}

# ============ 推理调用工具 ============

@_tool()
async def inference_deploy_container(
    deploymentCommand: str,
    gpuCount: NonNegativeInt,
    dockerImage: str = "vllm/vllm-openai:latest",
    deploymentName: str = "",
    replicas: NonNegativeInt = 1,
    instanceTypes: str = "",
    serviceType: Literal["clusterip", "external", "modelpool"] = "clusterip",
    port: PortNumber = 8000,
    huggingFaceToken: str = "",
    gpuMemory: AutoResource = -1,
    cpuRequest: AutoResource = -1,
    memoryRequest: AutoResource = -1
) -> dict[str, Any]:
    """部署容器化推理服务（vLLM、SGLang 等）

    Args:
        deploymentCommand: 部署命令，如 'vllm serve /s3/model --tensor-parallel-size 1'
        gpuCount: GPU 数量
        dockerImage: Docker 镜像（默认 vllm/vllm-openai:latest）
        deploymentName: 部署名称（可选，自动生成）
        replicas: 副本数（默认 1）
        instanceTypes: 调度到指定机型，逗号分隔如 'ml.g5.xlarge,ml.g5.2xlarge'（可选）
        serviceType: 服务类型，必须是以下值之一: clusterip / external / modelpool（默认 clusterip）
        port: 容器端口（默认 8000）
        huggingFaceToken: HuggingFace Token（可选，私有模型用）
        gpuMemory: GPU 显存限制（默认 -1 不限制）
        cpuRequest: CPU 请求（默认 -1 自动）
        memoryRequest: 内存请求 GB（默认 -1 自动）
    """
    try:
        payload = {
            "deploymentCommand": deploymentCommand,
            "gpuCount": gpuCount,
            "dockerImage": dockerImage,
            "replicas": replicas,
            "serviceType": serviceType,
            "port": port,
            "gpuMemory": gpuMemory,
            "cpuRequest": cpuRequest,
            "memoryRequest": memoryRequest,
        }
        if deploymentName:
            payload["deploymentName"] = deploymentName
        if instanceTypes:
            payload["instanceTypes"] = [t.strip() for t in instanceTypes.split(",")]
        if huggingFaceToken:
            payload["huggingFaceToken"] = huggingFaceToken

        async with api_client(timeout=120) as client:
            response = await client.post(f"{BASE_URL}/api/deploy/container", json=payload)
            response.raise_for_status()
            result = response.json()
            if result.get("success"):
                return {
                    "success": True,
                    "message": f"✅ Deployment '{result.get('deploymentTag')}' created successfully",
                    "deploymentTag": result.get("deploymentTag"),
                    "deploymentType": result.get("deploymentType"),
                    "accessType": result.get("accessType"),
                    "tip": "Use 'inference_list_services' to check service status"
                }
            return result
    except httpx.HTTPStatusError as e:
        body = e.response.json() if e.response.headers.get("content-type", "").startswith("application/json") else {}
        return {"success": False, "error": body.get("error", _exception_text(e))}
    except Exception as e:
        return {"success": False, "error": _exception_text(e)}

@_tool(read_only=True)
async def inference_list_services() -> dict[str, Any]:
    """列出所有推理服务（包括内部 ClusterIP 和外部 LoadBalancer）"""
    try:
        async with api_client() as client:
            services = await _inference_services(client)
            
            # 分类服务
            clusterip_services = []
            loadbalancer_services = []
            
            for service in services:
                metadata = service.get("metadata", {})
                spec = service.get("spec", {})
                status = service.get("status", {})
                
                name = metadata.get("name", "")
                namespace = metadata.get("namespace", "default")
                service_type = spec.get("type", "")
                
                # 排除系统服务
                if name == "kubernetes":
                    continue
                
                port = spec.get("ports", [{}])[0].get("port", 8000)
                
                if service_type == "ClusterIP":
                    cluster_ip = spec.get("clusterIP", "")
                    clusterip_services.append({
                        "name": name,
                        "namespace": namespace,
                        "url": f"http://{cluster_ip}:{port}",
                        "port": port
                    })
                elif service_type == "LoadBalancer":
                    ingress = status.get("loadBalancer", {}).get("ingress", [])
                    if ingress:
                        host = ingress[0].get("hostname") or ingress[0].get("ip")
                        url = f"http://{host}:{port}"
                        status_text = "ready"
                    else:
                        url = "pending"
                        status_text = "pending"
                    
                    loadbalancer_services.append({
                        "name": name,
                        "namespace": namespace,
                        "url": url,
                        "port": port,
                        "status": status_text
                    })
            
            return {
                "success": True,
                "clusterIP": {
                    "count": len(clusterip_services),
                    "services": clusterip_services,
                    "note": "Internal access only (within cluster)"
                },
                "loadBalancer": {
                    "count": len(loadbalancer_services),
                    "services": loadbalancer_services,
                    "note": "External access available"
                },
                "total": len(clusterip_services) + len(loadbalancer_services)
            }
            
    except Exception as e:
        return {
            "success": False,
            "error": _exception_text(e)
        }

@_tool(read_only=True)
async def inference_list_public_services() -> dict[str, Any]:
    """列出可公开访问的推理服务（仅 LoadBalancer 类型）"""
    try:
        async with api_client() as client:
            services = await _inference_services(client)
            public_services = []
            
            for service in services:
                metadata = service.get("metadata", {})
                spec = service.get("spec", {})
                status = service.get("status", {})
                
                name = metadata.get("name", "")
                namespace = metadata.get("namespace", "default")
                
                if name == "kubernetes":
                    continue
                
                if spec.get("type") == "LoadBalancer":
                    port = spec.get("ports", [{}])[0].get("port", 8000)
                    ingress = status.get("loadBalancer", {}).get("ingress", [])
                    
                    if ingress:
                        host = ingress[0].get("hostname") or ingress[0].get("ip")
                        public_services.append({
                            "name": name,
                            "namespace": namespace,
                            "url": f"http://{host}:{port}",
                            "port": port,
                            "status": "ready"
                        })
                    else:
                        public_services.append({
                            "name": name,
                            "namespace": namespace,
                            "url": "pending",
                            "port": port,
                            "status": "pending"
                        })
            
            return {
                "success": True,
                "services": public_services,
                "total": len(public_services)
            }
            
    except Exception as e:
        return {
            "success": False,
            "error": _exception_text(e)
        }

async def _inference_services(client: httpx.AsyncClient) -> list[dict[str, Any]]:
    response = await client.get(f"{BASE_URL}/api/v2/app-status")
    data = response.json()
    if data.get("success") is False:
        raise ValueError(data.get("error") or "Cannot query inference services")
    services_error = (data.get("errors") or {}).get("services")
    if services_error:
        raise ValueError(f"Cannot query inference services: {services_error}")
    return data.get("rawServices", data.get("services", []))


async def _proxy_model_request(
    client: httpx.AsyncClient,
    service: dict[str, Any],
    namespace: str,
    local_port: int,
    path: str,
    method: str,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    spec = service.get("spec", {})
    ports = spec.get("ports") or []
    if not ports or not ports[0].get("port"):
        raise ValueError("Service has no port")
    port = ports[0]["port"]
    request = {"method": method}
    if payload is not None:
        request["payload"] = payload
    if spec.get("type") == "LoadBalancer":
        ingress = service.get("status", {}).get("loadBalancer", {}).get("ingress", [])
        host = (ingress[0].get("hostname") or ingress[0].get("ip")) if ingress else None
        if not host:
            raise ValueError("LoadBalancer has no external endpoint (pending)")
        request["url"] = f"http://{host}:{port}{path}"
        endpoint = "/api/proxy-request"
    elif spec.get("type") == "ClusterIP":
        request["url"] = f"http://localhost:{local_port}{path}"
        request["portForward"] = {
            "enabled": True,
            "serviceName": service["metadata"]["name"],
            "namespace": namespace,
            "servicePort": port,
            "localPort": local_port,
        }
        endpoint = "/api/proxy-request-portforward"
    else:
        raise ValueError(f"Unsupported service type: {spec.get('type')}")
    response = await client.post(f"{BASE_URL}{endpoint}", json=request)
    return response.json()


@_tool()
async def inference_call_model(
    service_name: str,
    prompt: str,
    namespace: str = "default",
    max_tokens: Annotated[int, Field(ge=1, strict=True)] = 512,
    temperature: Annotated[float, Field(ge=0)] = 0.7,
    local_port: PortNumber = 2020,
    model: str | None = None,
) -> dict[str, Any]:
    """调用 OpenAI 兼容的推理服务，支持 LoadBalancer 和 ClusterIP。

    Args:
        service_name: 服务名称（从 inference_list_services 获取）
        prompt: 输入提示词
        namespace: 命名空间（默认 default）
        max_tokens: 最大生成 token 数（默认 512，必须为正整数）
        temperature: 温度参数（默认 0.7，不能为负数）
        local_port: Port-forward 本地端口（默认 2020，仅 ClusterIP 使用）
        model: 模型 ID（可选，省略时从 /v1/models 获取第一个模型 ID）
    """
    if model is not None and not model.strip():
        return {"success": False, "error": "model must be a non-empty model ID"}
    async with api_client(timeout=120) as client:
        services = await _inference_services(client)
        target = next((svc for svc in services if
            svc.get("metadata", {}).get("name") == service_name and
            svc.get("metadata", {}).get("namespace", "default") == namespace), None)
        if target is None:
            return {"success": False, "error": f"Service {service_name} not found in namespace {namespace}"}
        if model is None:
            models = await _proxy_model_request(client, target, namespace, local_port, "/v1/models", "GET")
            if not models.get("success"):
                return {"success": False, "error": models.get("error") or "Cannot query model IDs", "details": models}
            model_list = models.get("data", {}).get("data", [])
            model = model_list[0].get("id") if model_list else None
            if not isinstance(model, str) or not model.strip():
                return {"success": False, "error": "Service returned no model ID. Please specify model."}
        result = await _proxy_model_request(
            client, target, namespace, local_port, "/v1/chat/completions", "POST",
            {"model": model, "messages": [{"role": "user", "content": prompt}],
             "max_tokens": max_tokens, "temperature": temperature},
        )
    if not result.get("success"):
        return {"success": False, "error": result.get("error") or "Model request failed", "details": result}
    data = result.get("data", {})
    choices = data.get("choices", [])
    if not choices:
        return {"success": False, "error": "Model returned no choices", "details": data}
    return {
        "success": True,
        "response": choices[0].get("message", {}).get("content", ""),
        "usage": data.get("usage", {}),
        "model": data.get("model", model),
        "serviceType": target["spec"]["type"],
    }

# ============ HyperPod 节点操作工具 ============

async def _hyperpod_node_action(action: str, nodeId: str) -> dict:
    """内部辅助：调用 HyperPod 节点操作 API"""
    async with api_client(timeout=60) as client:
        response = await client.post(
            f"{BASE_URL}/api/cluster/hyperpod/node/{action}",
            json={"nodeId": nodeId}
        )
        result = _json_or_error(response)
        if result.get("success"):
            return {"success": True, "message": result.get("message"), "nodeId": nodeId, "apiResponse": result.get("apiResponse")}
        return {**result, "success": False, "error": result.get("error") or result.get("message") or f"Failed to {action} node"}

@_tool(destructive=True)
async def hyperpod_node_reboot(nodeId: str) -> dict[str, Any]:
    """重启 HyperPod 集群中的指定节点
    
    Args:
        nodeId: 节点 ID（格式：hyperpod-i-xxxxxxxxx 或 i-xxxxxxxxx）
    """
    try:
        return await _hyperpod_node_action("reboot", nodeId)
    except Exception as e:
        return {"success": False, "error": _exception_text(e)}

@_tool(destructive=True)
async def hyperpod_node_replace(nodeId: str) -> dict[str, Any]:
    """替换 HyperPod 集群中的指定节点（终止并用新实例替换）
    
    Args:
        nodeId: 节点 ID（格式：hyperpod-i-xxxxxxxxx 或 i-xxxxxxxxx）
    
    Warning:
        ⚠️ 替换节点会永久删除所有实例卷数据，请确保已备份重要数据
    """
    try:
        result = await _hyperpod_node_action("replace", nodeId)
        if result.get("success"):
            result["warning"] = "⚠️ All instance volumes will be permanently deleted"
        return result
    except Exception as e:
        return {"success": False, "error": _exception_text(e)}

@_tool(destructive=True)
async def hyperpod_node_delete(nodeId: str) -> dict[str, Any]:
    """删除 HyperPod 集群中的指定节点
    
    Args:
        nodeId: 节点 ID（格式：hyperpod-i-xxxxxxxxx 或 i-xxxxxxxxx）
    
    Warning:
        ⚠️ 删除节点会永久移除该节点及其所有数据，此操作不可逆
    """
    try:
        result = await _hyperpod_node_action("delete", nodeId)
        if result.get("success"):
            result["warning"] = "⚠️ Node permanently deleted"
        return result
    except Exception as e:
        return {"success": False, "error": _exception_text(e)}

@_tool()
async def hyperpod_add_instance_group(
    instanceGroupName: str,
    instanceType: str,
    instanceCount: InstanceCount,
    availabilityZone: str,
    volumeSize: VolumeSize = 500,
    trainingPlanArn: str = "",
    isSpot: bool = False,
    efaOnly: bool = False,
    newSubnet: bool = False,
    computeSubnetId: str | None = None,
    subnetId: str | None = None,
) -> dict[str, Any]:
    """向现有 HyperPod 集群添加新的实例组

    Args:
        instanceGroupName: 实例组名称
        instanceType: 实例类型，如 ml.g5.xlarge, ml.p4d.24xlarge
        instanceCount: 实例数量
        availabilityZone: 可用区，如 us-east-1c
        volumeSize: EBS 卷大小 GB（默认 500）
        trainingPlanArn: Training Plan ARN（可选，用于预留容量）
        isSpot: 是否使用 Spot 实例（默认 false）
        efaOnly: 是否让新节点使用 EFA-only 网络接口（默认 false）。
                 仅多网卡 EFA 机型支持（如 p4d/p5/p5en/p6/g6e.24xlarge+/g7e.24xlarge+），
                 不支持的机型会被后端校验拒绝。
        newSubnet: 是否为该实例组新建一个独立 subnet（默认 false）。开启后创建
                 hp-compute-{yymmdd}-{az}-{hash} 而非共用按 AZ 共享的 subnet，
                 用于避免 IP 耗尽。该 subnet 与实例组生命周期解耦：删除实例组时
                 不会自动清理，需用户自行维护。可在后续添加实例组时通过
                 computeSubnetId 或 subnetId 复用该 subnet。
        computeSubnetId: 已有计算子网 ID（可选，传入后不自动选择或创建子网）
        subnetId: computeSubnetId 的别名；两者同时提供时必须一致
    """
    try:
        if computeSubnetId is not None and not computeSubnetId.strip():
            return {"success": False, "error": "computeSubnetId must not be empty"}
        if subnetId is not None and not subnetId.strip():
            return {"success": False, "error": "subnetId must not be empty"}
        if computeSubnetId and subnetId and computeSubnetId != subnetId:
            return {"success": False, "error": "computeSubnetId and subnetId must match"}
        selected_subnet = computeSubnetId or subnetId
        if selected_subnet and newSubnet:
            return {"success": False, "error": "An existing subnet cannot be combined with newSubnet=true"}
        userConfig = {
            "instanceGroupName": instanceGroupName,
            "instanceType": instanceType,
            "instanceCount": instanceCount,
            "availabilityZone": availabilityZone,
            "volumeSize": volumeSize,
            "isSpot": isSpot,
        }
        if trainingPlanArn:
            userConfig["trainingPlanArn"] = trainingPlanArn
        if efaOnly:
            userConfig["efaOnly"] = True
        if newSubnet:
            userConfig["newSubnet"] = True
        if selected_subnet:
            userConfig["subnetId"] = selected_subnet

        async with api_client(timeout=300) as client:
            response = await client.post(f"{BASE_URL}/api/cluster/hyperpod/add-instance-group", json={"userConfig": userConfig})
            response.raise_for_status()
            result = response.json()
            if result.get("success"):
                return {
                    "success": True,
                    "message": f"✅ Instance group '{instanceGroupName}' addition initiated",
                    "instanceType": instanceType,
                    "instanceCount": instanceCount,
                    "availabilityZone": availabilityZone,
                    "isSpot": isSpot,
                    "tip": f"Use hyperpod_get_instance_group_status(name='{instanceGroupName}') to monitor progress"
                }
            return result
    except httpx.HTTPStatusError as e:
        body = e.response.json() if e.response.headers.get("content-type", "").startswith("application/json") else {}
        return {"success": False, "error": body.get("error", _exception_text(e))}
    except Exception as e:
        return {"success": False, "error": _exception_text(e)}


@_tool(read_only=True)
async def hyperpod_get_instance_group_status(
    name: str | None = None,
    clusterTag: str | None = None,
) -> dict[str, Any]:
    """查询添加或扩缩容实例组后的运行状态，返回当前数量、目标数量、ready 和 failed。

    Args:
        name: 实例组名称（可选，省略时查询所有实例组）
        clusterTag: 集群标签（可选，默认当前活跃集群）
    """
    params = {}
    if name is not None:
        params["name"] = name
    if clusterTag is not None:
        params["clusterTag"] = clusterTag
    async with api_client() as client:
        response = await client.get(
            f"{BASE_URL}/api/cluster/hyperpod/instance-group-status", params=params
        )
        result = response.json()
    if result.get("success") is False:
        return result
    groups = result.get("instanceGroups", [])
    result["failed"] = result.get("clusterStatus") == "Failed" or any(
        g.get("status") == "Failed" for g in groups
    )
    result["ready"] = (
        result.get("clusterStatus") == "InService" and bool(groups) and
        all(g.get("currentCount") is not None and g.get("targetCount") is not None and
            g["currentCount"] == g["targetCount"] and g.get("status") in (None, "InService")
            for g in groups)
    )
    return result


@_tool(destructive=True)
async def hyperpod_scale_instance_group(name: str, targetCount: InstanceCount) -> dict[str, Any]:
    """扩缩容 HyperPod 实例组

    Args:
        name: 实例组名称
        targetCount: 目标实例数量
    """
    try:
        async with api_client(timeout=120) as client:
            response = await client.put(f"{BASE_URL}/api/cluster/hyperpod/instances/{name}/scale", json={"targetCount": targetCount})
            response.raise_for_status()
            result = response.json()
            if result.get("success"):
                return {
                    "success": True,
                    "message": f"✅ Instance group '{name}' scaling to {targetCount} initiated",
                    "tip": f"Use hyperpod_get_instance_group_status(name='{name}') to monitor progress",
                }
            return result
    except httpx.HTTPStatusError as e:
        body = e.response.json() if e.response.headers.get("content-type", "").startswith("application/json") else {}
        return {"success": False, "error": body.get("error", _exception_text(e))}
    except Exception as e:
        return {"success": False, "error": _exception_text(e)}

@_tool(destructive=True)
async def hyperpod_delete_instance_group(instanceGroupName: str) -> dict[str, Any]:
    """删除 HyperPod 集群中的指定实例组

    Args:
        instanceGroupName: 要删除的实例组名称

    Warning:
        ⚠️ 删除实例组会永久移除该组所有节点及数据，此操作不可逆
    """
    try:
        async with api_client(timeout=120) as client:
            response = await client.post(f"{BASE_URL}/api/cluster/hyperpod/delete-instance-group", json={"instanceGroupName": instanceGroupName})
            response.raise_for_status()
            result = response.json()
            if result.get("success"):
                return {"success": True, "message": f"✅ Instance group '{instanceGroupName}' deletion initiated", "warning": "⚠️ All nodes and data in this group will be permanently removed"}
            return result
    except httpx.HTTPStatusError as e:
        body = e.response.json() if e.response.headers.get("content-type", "").startswith("application/json") else {}
        return {"success": False, "error": body.get("error", _exception_text(e))}
    except Exception as e:
        return {"success": False, "error": _exception_text(e)}

@_tool(destructive=True)
async def hyperpod_update_software(clusterArn: str) -> dict[str, Any]:
    """更新 HyperPod 集群软件

    Args:
        clusterArn: HyperPod 集群 ARN
    """
    try:
        async with api_client(timeout=120) as client:
            response = await client.post(f"{BASE_URL}/api/cluster/hyperpod/update-software", json={"clusterArn": clusterArn})
            response.raise_for_status()
            result = response.json()
            if result.get("success"):
                return {"success": True, "message": "✅ HyperPod software update initiated"}
            return result
    except httpx.HTTPStatusError as e:
        body = e.response.json() if e.response.headers.get("content-type", "").startswith("application/json") else {}
        return {"success": False, "error": body.get("error", _exception_text(e))}
    except Exception as e:
        return {"success": False, "error": _exception_text(e)}

if __name__ == "__main__":
    mcp.run(transport="stdio")
