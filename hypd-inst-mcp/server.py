#!/usr/bin/env python3
"""
HyperPod InstantStart MCP Server
"""

from mcp.server import FastMCP
import httpx
import json
import os
import subprocess

import asyncio

mcp = FastMCP(
    name="hyperpod-manager",
    instructions="HyperPod InstantStart 集群管理工具，提供集群创建、推理部署、训练作业等功能"
)

BASE_URL = os.environ.get("HYPD_INST_API_BASE_URL", "http://127.0.0.1:3099").rstrip("/")
AUTH_CONFIG_PATH = os.environ.get("HYPD_INST_AUTH_CONFIG_PATH", "/app/config/auth.json")


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


def api_client(**kwargs) -> httpx.AsyncClient:
    return httpx.AsyncClient(headers=_auth_headers(), **kwargs)

# ============ 通用工具 ============

@mcp.tool()
async def wait_seconds(seconds: int) -> str:
    """等待指定秒数（用于轮询间隔）

    Args:
        seconds: 等待秒数（最大 300）
    """
    seconds = min(seconds, 300)
    await asyncio.sleep(seconds)
    return json.dumps({"success": True, "message": f"Waited {seconds} seconds"})

# ============ 集群管理工具 ============

@mcp.tool()
async def cluster_get_status() -> str:
    """获取当前集群 EKS 节点运行状态，包括节点 Ready 状态、GPU 使用量等实时信息"""
    async with api_client() as client:
        response = await client.get(f"{BASE_URL}/api/cluster-status")
        response.raise_for_status()
        return json.dumps(response.json(), indent=2, ensure_ascii=False)

@mcp.tool()
async def cluster_create_eks(clusterTag: str = None, region: str = None, vpcCidr: str = None) -> str:
    """创建新的 EKS 集群（需要 8-12 分钟）
    
    Args:
        clusterTag: 集群标签（可选，默认自动生成如 hypd-0303）
        region: AWS 区域（可选，默认使用当前配置的区域）
        vpcCidr: VPC CIDR 块（可选，默认自动生成）
    """
    try:
        if not region:
            async with api_client() as client:
                region_resp = await client.get(f"{BASE_URL}/api/aws/current-region")
                if region_resp.status_code == 200:
                    region = region_resp.json().get("region")
        
        if not region:
            return json.dumps({"success": False, "error": "Cannot determine AWS region. Please specify region parameter."}, indent=2, ensure_ascii=False)
        
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
                return json.dumps({
                    "success": True,
                    "message": f"✅ EKS cluster creation started",
                    "clusterTag": clusterTag,
                    "region": region,
                    "estimatedTime": "8-12 minutes",
                    "tip": "Use 'cluster_get_eks_creation_status' to monitor progress, then 'cluster_switch' to switch to the new cluster"
                }, indent=2, ensure_ascii=False)
            else:
                return json.dumps(result, indent=2, ensure_ascii=False)
                
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, indent=2, ensure_ascii=False)

@mcp.tool()
async def cluster_create_eks_with_cidr(
    clusterTag: str,
    region: str,
    vpcCidr: str,
    publicSubnet1Cidr: str,
    publicSubnet2Cidr: str,
    eksPrivateSubnet1Cidr: str,
    eksPrivateSubnet2Cidr: str,
    hyperPodPrivateSubnetCidr: str
) -> str:
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
                return json.dumps({
                    "success": True,
                    "message": "✅ EKS cluster creation started with custom CIDR",
                    "clusterTag": clusterTag,
                    "region": region,
                    "cidrConfig": cidrConfig,
                    "estimatedTime": "8-12 minutes",
                    "tip": "Use 'cluster_get_eks_creation_status' to monitor progress"
                }, indent=2, ensure_ascii=False)
            else:
                return json.dumps(result, indent=2, ensure_ascii=False)

    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, indent=2, ensure_ascii=False)

@mcp.tool()
async def cluster_list_all() -> str:
    """列出所有已管理的集群"""
    async with api_client() as client:
        response = await client.get(f"{BASE_URL}/api/multi-cluster/list")
        response.raise_for_status()
        return json.dumps(response.json(), indent=2, ensure_ascii=False)

@mcp.tool()
async def cluster_get_instance_groups() -> str:
    """获取当前集群的所有实例组（EKS 节点组 + HyperPod 实例组），包括 CurrentCount=0 的实例组"""
    async with api_client() as client:
        response = await client.get(f"{BASE_URL}/api/cluster/nodegroups")
        response.raise_for_status()
        return json.dumps(response.json(), indent=2, ensure_ascii=False)

@mcp.tool()
async def cluster_switch(clusterTag: str) -> str:
    """切换当前操作的集群
    
    Args:
        clusterTag: 目标集群标签
    """
    async with api_client() as client:
        response = await client.post(f"{BASE_URL}/api/multi-cluster/switch", json={"clusterTag": clusterTag})
        response.raise_for_status()
        return json.dumps(response.json(), indent=2, ensure_ascii=False)

@mcp.tool()
async def cluster_nodegroup_scale(name: str, minSize: int, maxSize: int, desiredSize: int) -> str:
    """扩缩容 EKS 节点组
    
    Args:
        name: 节点组名称
        minSize: 最小节点数
        maxSize: 最大节点数
        desiredSize: 期望节点数
    """
    async with api_client(timeout=120) as client:
        response = await client.put(
            f"{BASE_URL}/api/cluster/nodegroups/{name}/scale",
            json={"minSize": minSize, "maxSize": maxSize, "desiredSize": desiredSize}
        )
        response.raise_for_status()
        return json.dumps(response.json(), indent=2, ensure_ascii=False)

@mcp.tool()
async def cluster_nodegroup_delete(nodeGroupName: str) -> str:
    """删除 EKS 节点组
    
    Args:
        nodeGroupName: 节点组名称
    """
    async with api_client(timeout=300) as client:
        response = await client.delete(f"{BASE_URL}/api/cluster/nodegroup/{nodeGroupName}")
        response.raise_for_status()
        return json.dumps(response.json(), indent=2, ensure_ascii=False)

@mcp.tool()
async def cluster_get_eks_creation_status() -> str:
    """获取正在创建的 EKS 集群状态（CloudFormation stack 状态）"""
    async with api_client() as client:
        response = await client.get(f"{BASE_URL}/api/cluster/creating-clusters")
        response.raise_for_status()
        data = response.json()
        clusters = data.get("clusters", {})
        if not clusters:
            return json.dumps({"success": True, "message": "No EKS clusters currently being created", "clusters": {}}, indent=2, ensure_ascii=False)
        return json.dumps({"success": True, "clusters": clusters}, indent=2, ensure_ascii=False)

@mcp.tool()
async def cluster_configure_dependencies() -> str:
    """为当前活跃的 EKS 集群安装和配置依赖（如 GPU 插件、存储驱动等）。
    EKS 集群创建完成并切换到该集群后，需要先配置依赖才能创建 HyperPod 集群。
    """
    try:
        async with api_client(timeout=600) as client:
            response = await client.post(f"{BASE_URL}/api/cluster/configure-dependencies")
            response.raise_for_status()
            result = response.json()
            if result.get("success"):
                return json.dumps({
                    "success": True,
                    "message": "✅ Dependency configuration started",
                    "clusterTag": result.get("clusterTag"),
                    "tip": "Use 'cluster_get_dependency_status' to monitor progress. Once completed, you can create a HyperPod cluster."
                }, indent=2, ensure_ascii=False)
            return json.dumps(result, indent=2, ensure_ascii=False)
    except httpx.HTTPStatusError as e:
        body = e.response.json() if e.response.headers.get("content-type", "").startswith("application/json") else {}
        return json.dumps({"success": False, "error": body.get("error", str(e))}, indent=2, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, indent=2, ensure_ascii=False)

@mcp.tool()
async def cluster_get_dependency_status(clusterTag: str = None) -> str:
    """获取集群依赖配置状态
    
    Args:
        clusterTag: 集群标签（可选，默认使用当前活跃集群）
    """
    try:
        if not clusterTag:
            async with api_client() as client:
                status_resp = await client.get(f"{BASE_URL}/api/cluster-status")
                if status_resp.status_code == 200:
                    data = status_resp.json()
                    clusterTag = data.get("clusterTag") or data.get("activeCluster")
        if not clusterTag:
            return json.dumps({"success": False, "error": "No active cluster found. Please specify clusterTag."}, indent=2, ensure_ascii=False)
        
        async with api_client() as client:
            response = await client.get(f"{BASE_URL}/api/cluster/{clusterTag}/dependencies/status")
            response.raise_for_status()
            return json.dumps(response.json(), indent=2, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, indent=2, ensure_ascii=False)

@mcp.tool()
async def hyperpod_create(
    hyperPodTag: str,
    AcceleratedInstanceType: str,
    AcceleratedInstanceCount: int,
    availabilityZone: str,
    AcceleratedEBSVolumeSize: int = 500,
    AcceleratedTrainingPlanArn: str = "",
    computeSubnetId: str = ""
) -> str:
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
                return json.dumps({
                    "success": True,
                    "message": "✅ HyperPod cluster creation started",
                    "stackName": result.get("stackName"),
                    "tip": "Use 'hyperpod_get_creation_status' to monitor progress"
                }, indent=2, ensure_ascii=False)
            return json.dumps(result, indent=2, ensure_ascii=False)
    except httpx.HTTPStatusError as e:
        body = e.response.json() if e.response.headers.get("content-type", "").startswith("application/json") else {}
        return json.dumps({"success": False, "error": body.get("error", str(e))}, indent=2, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, indent=2, ensure_ascii=False)

@mcp.tool()
async def hyperpod_get_creation_status(clusterTag: str = None) -> str:
    """获取 HyperPod 集群创建状态
    
    Args:
        clusterTag: 集群标签（可选，默认使用当前活跃集群）
    """
    try:
        if not clusterTag:
            async with api_client() as client:
                status_resp = await client.get(f"{BASE_URL}/api/cluster-status")
                if status_resp.status_code == 200:
                    data = status_resp.json()
                    clusterTag = data.get("clusterTag") or data.get("activeCluster")
        if not clusterTag:
            return json.dumps({"success": False, "error": "No active cluster found"}, indent=2, ensure_ascii=False)
        
        async with api_client() as client:
            response = await client.get(f"{BASE_URL}/api/cluster/hyperpod-creation-status/{clusterTag}")
            response.raise_for_status()
            result = response.json()
            status = result.get("status")
            if not status:
                return json.dumps({"success": True, "message": "No HyperPod cluster currently being created", "clusterTag": clusterTag}, indent=2, ensure_ascii=False)
            return json.dumps({"success": True, "clusterTag": clusterTag, "status": status}, indent=2, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, indent=2, ensure_ascii=False)

@mcp.tool()
async def cluster_get_available_instances() -> str:
    """获取当前集群可用的实例类型列表（用于创建 HyperPod 或节点组时选择实例类型）"""
    async with api_client() as client:
        response = await client.get(f"{BASE_URL}/api/cluster/cluster-available-instance")
        response.raise_for_status()
        return json.dumps(response.json(), indent=2, ensure_ascii=False)

@mcp.tool()
async def cluster_get_availability_zones() -> str:
    """获取当前集群可用的可用区列表"""
    try:
        async with api_client() as client:
            # 获取当前活跃集群的 region(active-region 优先返回活跃集群 region,无集群时回退主机)
            region_resp = await client.get(f"{BASE_URL}/api/aws/active-region")
            region_resp.raise_for_status()
            region = region_resp.json().get("region")
            if not region:
                return json.dumps({"success": False, "error": "Cannot determine region"}, indent=2, ensure_ascii=False)
            response = await client.get(f"{BASE_URL}/api/cluster/availability-zones", params={"region": region})
            response.raise_for_status()
            return json.dumps(response.json(), indent=2, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, indent=2, ensure_ascii=False)

@mcp.tool()
async def karpenter_install() -> str:
    """安装 HyperPod Karpenter（无需参数，使用当前活跃集群）"""
    try:
        async with api_client(timeout=60) as client:
            response = await client.post(f"{BASE_URL}/api/cluster/karpenter/install", json={})
            response.raise_for_status()
            result = response.json()
            if result.get("success"):
                return json.dumps({
                    "success": True,
                    "message": "✅ Karpenter installation started",
                    "clusterTag": result.get("clusterTag"),
                    "tip": "Use 'karpenter_get_status' to check installation progress"
                }, indent=2, ensure_ascii=False)
            return json.dumps(result, indent=2, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, indent=2, ensure_ascii=False)

@mcp.tool()
async def karpenter_get_status() -> str:
    """获取 Karpenter 安装和运行状态"""
    try:
        async with api_client(timeout=30) as client:
            response = await client.get(f"{BASE_URL}/api/cluster/karpenter/status")
            response.raise_for_status()
            return json.dumps(response.json(), indent=2, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, indent=2, ensure_ascii=False)

@mcp.tool()
async def hyperpod_get_advanced_features() -> str:
    """获取 HyperPod 集群的高级功能配置状态（Tiered Storage、Inference Operator、Training Operator）
    
    返回的 tieredStorage 包含 irsa 字段，表示 IRSA（IAM Role + ServiceAccount）的安装状态。
    """
    async with api_client(timeout=30) as client:
        response = await client.get(f"{BASE_URL}/api/cluster/hyperpod/advanced-features")
        response.raise_for_status()
        return json.dumps(response.json(), indent=2, ensure_ascii=False)

@mcp.tool()
async def hyperpod_update_advanced_features(
    tieredStorage: dict = None,
    inferenceOperator: dict = None,
    trainingOperator: dict = None
) -> str:
    """更新 HyperPod 集群的高级功能配置（开启/关闭 Tiered Storage、Inference Operator、Training Operator）
    
    Args:
        tieredStorage: Tiered Storage 配置，如 {"enabled": true, "configMode": "default"} 或 {"enabled": true, "configMode": "custom", "percentage": 80}，设为 {"enabled": false} 关闭。启用时自动安装 IRSA（IAM Role + ServiceAccount），禁用时自动卸载。
        inferenceOperator: Inference Operator 配置，如 {"enabled": true} 或 {"enabled": false}
        trainingOperator: Training Operator 配置，如 {"enabled": true} 或 {"enabled": false}
    """
    try:
        payload = {}
        if tieredStorage is not None:
            payload["tieredStorage"] = tieredStorage
        if inferenceOperator is not None:
            payload["inferenceOperator"] = inferenceOperator
        if trainingOperator is not None:
            payload["trainingOperator"] = trainingOperator
        
        if not payload:
            return json.dumps({"success": False, "error": "At least one feature must be specified"}, indent=2, ensure_ascii=False)
        
        async with api_client(timeout=120) as client:
            response = await client.post(f"{BASE_URL}/api/cluster/hyperpod/advanced-features", json=payload)
            response.raise_for_status()
            return json.dumps(response.json(), indent=2, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, indent=2, ensure_ascii=False)

# ============ S3 存储管理工具 ============

@mcp.tool()
async def s3_storage_get_defaults() -> str:
    """获取 S3 存储挂载的默认配置（claim 名称、S3 桶名称、区域）"""
    try:
        async with api_client() as client:
            response = await client.get(f"{BASE_URL}/api/s3-storage-defaults")
            response.raise_for_status()
            return json.dumps(response.json(), indent=2, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, indent=2, ensure_ascii=False)

@mcp.tool()
async def s3_storage_create(name: str = None, bucketName: str = None, region: str = None) -> str:
    """创建 S3 存储挂载（PV + PVC）

    Args:
        name: PVC claim 名称（可选，默认 s3-claim）
        bucketName: S3 桶名称（可选，默认使用系统检测的桶）
        region: AWS 区域（可选，默认使用系统检测的区域）
    """
    try:
        # 获取默认值填充未提供的参数
        async with api_client() as client:
            defaults_resp = await client.get(f"{BASE_URL}/api/s3-storage-defaults")
            defaults_resp.raise_for_status()
            defaults = defaults_resp.json().get("defaults", {})

        payload = {
            "name": name or defaults.get("name", "s3-claim"),
            "bucketName": bucketName or defaults.get("bucketName", ""),
            "region": region or defaults.get("region", ""),
        }

        if not payload["bucketName"]:
            return json.dumps({"success": False, "error": "No S3 bucket name provided and no default detected. Please specify bucketName."}, indent=2, ensure_ascii=False)

        async with api_client(timeout=60) as client:
            response = await client.post(f"{BASE_URL}/api/s3-storages", json=payload)
            response.raise_for_status()
            result = response.json()
            if result.get("success"):
                return json.dumps({
                    "success": True,
                    "message": f"✅ S3 storage '{payload['name']}' created successfully",
                    "name": payload["name"],
                    "bucketName": payload["bucketName"],
                    "region": payload["region"],
                    "pvcName": result.get("pvcName"),
                    "pvName": result.get("pvName")
                }, indent=2, ensure_ascii=False)
            return json.dumps(result, indent=2, ensure_ascii=False)
    except httpx.HTTPStatusError as e:
        body = e.response.json() if e.response.headers.get("content-type", "").startswith("application/json") else {}
        return json.dumps({"success": False, "error": body.get("error", str(e))}, indent=2, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, indent=2, ensure_ascii=False)

@mcp.tool()
async def s3_storage_list_contents(storage: str = None) -> str:
    """列出 S3 存储桶中的文件和文件夹（模型文件等）
    
    Args:
        storage: PVC 存储名称（可选，默认使用 s3-claim）
    """
    async with api_client() as client:
        params = {"storage": storage} if storage else {}
        response = await client.get(f"{BASE_URL}/api/s3-storage", params=params)
        response.raise_for_status()
        return json.dumps(response.json(), indent=2, ensure_ascii=False)

# ============ 模型下载工具 ============

@mcp.tool()
async def model_download_enhanced(
    modelId: str,
    s3Storage: str = None,
    cpu: str = "4",
    memory: str = "16",
    hfToken: str = None
) -> str:
    """从 HuggingFace 下载模型到集群存储
    
    Args:
        modelId: HuggingFace 模型 ID，如 Qwen/Qwen2.5-7B-Instruct
        s3Storage: S3 存储桶名称（可选，默认使用集群默认存储桶）
        cpu: CPU 核心数（默认 4）
        memory: 内存大小 GB（默认 16）
        hfToken: HuggingFace Token（可选，用于私有模型）
    """
    try:
        # 如果没有指定 s3Storage，尝试获取默认存储桶
        if not s3Storage:
            async with api_client() as client:
                storage_resp = await client.get(f"{BASE_URL}/api/s3-storages")
                if storage_resp.status_code == 200:
                    storages = storage_resp.json().get("storages", [])
                    if storages:
                        s3Storage = storages[0].get("name", "")
        
        if not s3Storage:
            return json.dumps({
                "success": False,
                "error": "No S3 storage available. Please specify s3Storage parameter."
            }, indent=2, ensure_ascii=False)
        
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
                k8s_job_name = f"model-download-job-{job_name}" if job_name else ""
                return json.dumps({
                    "success": True,
                    "message": f"✅ Model download started for {modelId}",
                    "jobName": k8s_job_name,
                    "s3Storage": s3Storage,
                    "resources": {
                        "cpu": f"{cpu} cores",
                        "memory": f"{memory}GB"
                    },
                    "tip": f"Monitor: job_get_status {k8s_job_name}" if k8s_job_name else "Check: job_list_all"
                }, indent=2, ensure_ascii=False)
            else:
                return json.dumps({
                    "success": False,
                    "error": result.get("error", "Unknown error")
                }, indent=2, ensure_ascii=False)
                
    except httpx.HTTPError as e:
        return json.dumps({
            "success": False,
            "error": f"HTTP Error: {str(e)}"
        }, indent=2, ensure_ascii=False)
    except Exception as e:
        return json.dumps({
            "success": False,
            "error": f"Error: {str(e)}"
        }, indent=2, ensure_ascii=False)

@mcp.tool()
async def job_get_status(jobName: str) -> str:
    """查询 Kubernetes Job 的状态（用于监控模型下载等任务）
    
    Args:
        jobName: Job 名称，如 model-download-qwen-qwen2-5-7b-instruct
    
    Returns:
        Job 状态信息，包括运行状态、成功/失败数量、完成时间等
    """
    try:
        # 执行 kubectl 命令获取 Job 状态
        result = subprocess.run(
            ["kubectl", "get", "job", jobName, "-o", "json"],
            capture_output=True,
            text=True,
            timeout=30
        )
        
        if result.returncode != 0:
            return json.dumps({
                "success": False,
                "error": f"Job not found or error: {result.stderr}"
            }, indent=2, ensure_ascii=False)
        
        # 解析 Job 状态
        job_data = json.loads(result.stdout)
        status = job_data.get("status", {})
        metadata = job_data.get("metadata", {})
        
        # 判断任务状态
        succeeded = status.get("succeeded", 0)
        failed = status.get("failed", 0)
        active = status.get("active", 0)
        
        if succeeded > 0:
            overall_status = "✅ Completed Successfully"
        elif failed > 0:
            overall_status = "❌ Failed"
        elif active > 0:
            overall_status = "🔄 Running"
        else:
            overall_status = "⏳ Pending"
        
        return json.dumps({
            "success": True,
            "jobName": jobName,
            "overallStatus": overall_status,
            "details": {
                "active": active,
                "succeeded": succeeded,
                "failed": failed,
                "completionTime": status.get("completionTime"),
                "startTime": status.get("startTime"),
                "creationTime": metadata.get("creationTimestamp")
            },
            "conditions": status.get("conditions", [])
        }, indent=2, ensure_ascii=False)
        
    except subprocess.TimeoutExpired:
        return json.dumps({
            "success": False,
            "error": "Command timeout"
        }, indent=2, ensure_ascii=False)
    except Exception as e:
        return json.dumps({
            "success": False,
            "error": str(e)
        }, indent=2, ensure_ascii=False)

@mcp.tool()
async def job_list_all() -> str:
    """列出所有 Kubernetes Jobs（包括模型下载任务）
    
    Returns:
        所有 Job 的列表，包括名称、状态、创建时间等
    """
    try:
        # 执行 kubectl 命令获取所有 Jobs
        result = subprocess.run(
            ["kubectl", "get", "jobs", "-o", "json"],
            capture_output=True,
            text=True,
            timeout=30
        )
        
        if result.returncode != 0:
            return json.dumps({
                "success": False,
                "error": f"Failed to list jobs: {result.stderr}"
            }, indent=2, ensure_ascii=False)
        
        # 解析 Jobs 列表
        jobs_data = json.loads(result.stdout)
        jobs = []
        
        for item in jobs_data.get("items", []):
            metadata = item.get("metadata", {})
            status = item.get("status", {})
            
            # 判断状态
            succeeded = status.get("succeeded", 0)
            failed = status.get("failed", 0)
            active = status.get("active", 0)
            
            if succeeded > 0:
                job_status = "✅ Completed"
            elif failed > 0:
                job_status = "❌ Failed"
            elif active > 0:
                job_status = "🔄 Running"
            else:
                job_status = "⏳ Pending"
            
            jobs.append({
                "name": metadata.get("name"),
                "namespace": metadata.get("namespace", "default"),
                "status": job_status,
                "creationTime": metadata.get("creationTimestamp"),
                "completionTime": status.get("completionTime"),
                "active": active,
                "succeeded": succeeded,
                "failed": failed
            })
        
        return json.dumps({
            "success": True,
            "jobs": jobs,
            "total": len(jobs)
        }, indent=2, ensure_ascii=False)
        
    except subprocess.TimeoutExpired:
        return json.dumps({
            "success": False,
            "error": "Command timeout"
        }, indent=2, ensure_ascii=False)
    except Exception as e:
        return json.dumps({
            "success": False,
            "error": str(e)
        }, indent=2, ensure_ascii=False)

# ============ 推理调用工具 ============

@mcp.tool()
async def inference_deploy_container(
    deploymentCommand: str,
    gpuCount: int,
    dockerImage: str = "vllm/vllm-openai:latest",
    deploymentName: str = "",
    replicas: int = 1,
    instanceTypes: str = "",
    serviceType: str = "clusterip",
    port: int = 8000,
    huggingFaceToken: str = "",
    gpuMemory: int = -1,
    cpuRequest: int = -1,
    memoryRequest: int = -1
) -> str:
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
                return json.dumps({
                    "success": True,
                    "message": f"✅ Deployment '{result.get('deploymentTag')}' created successfully",
                    "deploymentTag": result.get("deploymentTag"),
                    "deploymentType": result.get("deploymentType"),
                    "accessType": result.get("accessType"),
                    "tip": "Use 'inference_list_services' to check service status"
                }, indent=2, ensure_ascii=False)
            return json.dumps(result, indent=2, ensure_ascii=False)
    except httpx.HTTPStatusError as e:
        body = e.response.json() if e.response.headers.get("content-type", "").startswith("application/json") else {}
        return json.dumps({"success": False, "error": body.get("error", str(e))}, indent=2, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, indent=2, ensure_ascii=False)

@mcp.tool()
async def inference_list_services() -> str:
    """列出所有推理服务（包括内部 ClusterIP 和外部 LoadBalancer）"""
    try:
        async with api_client() as client:
            response = await client.get(f"{BASE_URL}/api/v2/app-status")
            response.raise_for_status()
            data = response.json()
            
            services = data.get("rawServices", data.get("services", []))
            
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
            
            return json.dumps({
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
            }, indent=2, ensure_ascii=False)
            
    except Exception as e:
        return json.dumps({
            "success": False,
            "error": str(e)
        }, indent=2, ensure_ascii=False)

@mcp.tool()
async def inference_list_public_services() -> str:
    """列出可公开访问的推理服务（仅 LoadBalancer 类型）"""
    try:
        async with api_client() as client:
            response = await client.get(f"{BASE_URL}/api/v2/app-status")
            response.raise_for_status()
            data = response.json()
            
            services = data.get("rawServices", data.get("services", []))
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
            
            return json.dumps({
                "success": True,
                "services": public_services,
                "total": len(public_services)
            }, indent=2, ensure_ascii=False)
            
    except Exception as e:
        return json.dumps({
            "success": False,
            "error": str(e)
        }, indent=2, ensure_ascii=False)

@mcp.tool()
async def inference_call_model(
    service_name: str,
    prompt: str,
    namespace: str = "default",
    max_tokens: int = 512,
    temperature: float = 0.7,
    local_port: int = 2020
) -> str:
    """调用推理模型生成响应（支持 LoadBalancer 和 ClusterIP 服务）
    
    Args:
        service_name: 服务名称（从 inference_list_services 获取）
        prompt: 输入提示词
        namespace: 命名空间（默认 default）
        max_tokens: 最大生成 token 数（默认 512）
        temperature: 温度参数（默认 0.7）
        local_port: Port-forward 本地端口（默认 2020，仅 ClusterIP 服务需要）
    """
    try:
        async with api_client(timeout=120) as client:
            # 获取服务信息
            status_resp = await client.get(f"{BASE_URL}/api/v2/app-status")
            status_resp.raise_for_status()
            data = status_resp.json()
            services = data.get("rawServices", data.get("services", []))
            
            # 找到目标服务
            target_service = None
            for svc in services:
                if (svc.get("metadata", {}).get("name") == service_name and 
                    svc.get("metadata", {}).get("namespace") == namespace):
                    target_service = svc
                    break
            
            if not target_service:
                return json.dumps({
                    "success": False,
                    "error": f"Service {service_name} not found in namespace {namespace}"
                }, indent=2, ensure_ascii=False)
            
            service_type = target_service.get("spec", {}).get("type", "")
            service_port = target_service.get("spec", {}).get("ports", [{}])[0].get("port", 8000)
            
            # 构造请求 payload
            payload = {
                "model": "",
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": max_tokens,
                "temperature": temperature
            }
            
            # 根据服务类型选择调用方式
            if service_type == "LoadBalancer":
                # LoadBalancer: 直接调用外部地址
                ingress = target_service.get("status", {}).get("loadBalancer", {}).get("ingress", [])
                if not ingress:
                    return json.dumps({
                        "success": False,
                        "error": f"LoadBalancer service {service_name} has no external endpoint (pending)"
                    }, indent=2, ensure_ascii=False)
                
                host = ingress[0].get("hostname") or ingress[0].get("ip")
                base_url = f"http://{host}:{service_port}"
                
                proxy_resp = await client.post(
                    f"{BASE_URL}/api/proxy-request",
                    json={"url": f"{base_url}/v1/chat/completions", "payload": payload, "method": "POST"}
                )
                
            elif service_type == "ClusterIP":
                # ClusterIP: 使用 port-forward
                service_url = f"http://localhost:{local_port}/v1/chat/completions"
                
                proxy_resp = await client.post(
                    f"{BASE_URL}/api/proxy-request-portforward",
                    json={
                        "url": service_url,
                        "payload": payload,
                        "method": "POST",
                        "portForward": {
                            "enabled": True,
                            "serviceName": service_name,
                            "namespace": namespace,
                            "servicePort": service_port,
                            "localPort": local_port
                        }
                    }
                )
            else:
                return json.dumps({
                    "success": False,
                    "error": f"Unsupported service type: {service_type}"
                }, indent=2, ensure_ascii=False)
            
            result = proxy_resp.json()
            
            if result.get("success"):
                response_data = result.get("data", {})
                choices = response_data.get("choices", [])
                if choices:
                    content = choices[0].get("message", {}).get("content", "")
                    return json.dumps({
                        "success": True,
                        "response": content,
                        "usage": response_data.get("usage", {}),
                        "model": response_data.get("model", "unknown"),
                        "serviceType": service_type
                    }, indent=2, ensure_ascii=False)
            
            return json.dumps({
                "success": False,
                "error": result.get("error", "No response from model"),
                "details": result.get("data", {})
            }, indent=2, ensure_ascii=False)
                
    except Exception as e:
        return json.dumps({
            "success": False,
            "error": str(e)
        }, indent=2, ensure_ascii=False)

# ============ HyperPod 节点操作工具 ============

@mcp.tool()
async def _hyperpod_node_action(action: str, nodeId: str) -> dict:
    """内部辅助：调用 HyperPod 节点操作 API"""
    async with api_client(timeout=60) as client:
        response = await client.post(
            f"{BASE_URL}/api/cluster/hyperpod/node/{action}",
            json={"nodeId": nodeId}
        )
        result = response.json()
        if response.status_code >= 400:
            return {"success": False, "error": result.get("message", f"Failed to {action} node"), "errorCode": result.get("errorCode")}
        if result.get("success"):
            return {"success": True, "message": result.get("message"), "nodeId": nodeId, "apiResponse": result.get("apiResponse")}
        return {"success": False, "error": result.get("message", f"Failed to {action} node")}

@mcp.tool()
async def hyperpod_node_reboot(nodeId: str) -> str:
    """重启 HyperPod 集群中的指定节点
    
    Args:
        nodeId: 节点 ID（格式：hyperpod-i-xxxxxxxxx 或 i-xxxxxxxxx）
    """
    try:
        return json.dumps(await _hyperpod_node_action("reboot", nodeId), indent=2, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, indent=2, ensure_ascii=False)

@mcp.tool()
async def hyperpod_node_replace(nodeId: str) -> str:
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
        return json.dumps(result, indent=2, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, indent=2, ensure_ascii=False)

@mcp.tool()
async def hyperpod_node_delete(nodeId: str) -> str:
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
        return json.dumps(result, indent=2, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, indent=2, ensure_ascii=False)

@mcp.tool()
async def hyperpod_add_instance_group(
    instanceGroupName: str,
    instanceType: str,
    instanceCount: int,
    availabilityZone: str,
    volumeSize: int = 500,
    trainingPlanArn: str = "",
    isSpot: bool = False,
    efaOnly: bool = False,
    newSubnet: bool = False
) -> str:
    """向现有 HyperPod 集群添加新的实例组

    Args:
        instanceGroupName: 实例组名称
        instanceType: 实例类型，如 ml.g5.xlarge, ml.p4d.24xlarge
        instanceCount: 实例数量
        availabilityZone: 可用区，如 us-east-1c
        volumeSize: EBS 卷大小 GB（默认 500）
        trainingPlanArn: Training Plan ARN（可选，用于预留容量）
        isSpot: 是否使用 Spot 实例（默认 false）
        efaOnly: 是否使用 EFA-only 网络接口（默认 false）。创建时定死、不可变，
                 仅多网卡 EFA 机型支持（如 p4d/p5/p5en/p6/g6e.24xlarge+/g7e.24xlarge+），
                 非法机型会被 AWS 校验拒绝。
        newSubnet: 是否为该实例组新建一个独立 subnet（默认 false）。开启后创建
                 hp-compute-{yymmdd}-{az}-{hash} 而非共用按 AZ 共享的 subnet，
                 用于避免 IP 耗尽。该 subnet 与实例组生命周期解耦：删除实例组时
                 不会自动清理，需用户自行维护。可在后续添加实例组时通过
                 computeSubnetId（subnetId）复用该 subnet。
    """
    try:
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

        async with api_client(timeout=300) as client:
            response = await client.post(f"{BASE_URL}/api/cluster/hyperpod/add-instance-group", json={"userConfig": userConfig})
            response.raise_for_status()
            result = response.json()
            if result.get("success"):
                return json.dumps({
                    "success": True,
                    "message": f"✅ Instance group '{instanceGroupName}' addition initiated",
                    "instanceType": instanceType,
                    "instanceCount": instanceCount,
                    "availabilityZone": availabilityZone,
                    "isSpot": isSpot,
                    "tip": "Use 'hyperpod_get_creation_status' to monitor progress"
                }, indent=2, ensure_ascii=False)
            return json.dumps(result, indent=2, ensure_ascii=False)
    except httpx.HTTPStatusError as e:
        body = e.response.json() if e.response.headers.get("content-type", "").startswith("application/json") else {}
        return json.dumps({"success": False, "error": body.get("error", str(e))}, indent=2, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, indent=2, ensure_ascii=False)


@mcp.tool()
async def hyperpod_scale_instance_group(name: str, targetCount: int) -> str:
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
                return json.dumps({"success": True, "message": f"✅ Instance group '{name}' scaling to {targetCount} initiated"}, indent=2, ensure_ascii=False)
            return json.dumps(result, indent=2, ensure_ascii=False)
    except httpx.HTTPStatusError as e:
        body = e.response.json() if e.response.headers.get("content-type", "").startswith("application/json") else {}
        return json.dumps({"success": False, "error": body.get("error", str(e))}, indent=2, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, indent=2, ensure_ascii=False)

@mcp.tool()
async def hyperpod_delete_instance_group(instanceGroupName: str) -> str:
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
                return json.dumps({"success": True, "message": f"✅ Instance group '{instanceGroupName}' deletion initiated", "warning": "⚠️ All nodes and data in this group will be permanently removed"}, indent=2, ensure_ascii=False)
            return json.dumps(result, indent=2, ensure_ascii=False)
    except httpx.HTTPStatusError as e:
        body = e.response.json() if e.response.headers.get("content-type", "").startswith("application/json") else {}
        return json.dumps({"success": False, "error": body.get("error", str(e))}, indent=2, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, indent=2, ensure_ascii=False)

@mcp.tool()
async def hyperpod_update_software(clusterArn: str) -> str:
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
                return json.dumps({"success": True, "message": "✅ HyperPod software update initiated"}, indent=2, ensure_ascii=False)
            return json.dumps(result, indent=2, ensure_ascii=False)
    except httpx.HTTPStatusError as e:
        body = e.response.json() if e.response.headers.get("content-type", "").startswith("application/json") else {}
        return json.dumps({"success": False, "error": body.get("error", str(e))}, indent=2, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, indent=2, ensure_ascii=False)

if __name__ == "__main__":
    mcp.run(transport="stdio")
