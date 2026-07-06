/**
 * Cluster Info Routes
 *
 * 从 index.js 抽离（Phase 3 波7）。
 * 提供集群信息、S3 桶以及子网（含 compute subnet）查询路由。
 */

const express = require('express');
const router = express.Router();

const fs = require('fs');
const path = require('path');
const MetadataUtils = require('../utils/metadataUtils');
const CloudFormationManager = require('../utils/cloudFormationManager');

// 模块级注入依赖
let clusterManager = null;
let s3StorageManager = null;

function initialize(deps) {
  clusterManager = deps.clusterManager;
  s3StorageManager = deps.s3StorageManager;
}

// 获取集群信息API
router.get('/cluster/info', async (req, res) => {
  try {
    const activeCluster = clusterManager.getActiveCluster();
    if (!activeCluster) {
      return res.status(400).json({ success: false, error: 'No active cluster selected' });
    }

    // 统一从 cluster_info.json 获取
    const clusterInfoPath = path.join(__dirname, '../../managed_clusters_info', activeCluster, 'metadata/cluster_info.json');

    if (!fs.existsSync(clusterInfoPath)) {
      return res.status(404).json({ success: false, error: 'Cluster info not found' });
    }

    const clusterInfo = JSON.parse(fs.readFileSync(clusterInfoPath, 'utf8'));

    res.json({
      success: true,
      activeCluster,
      eksClusterName: clusterInfo.eksCluster?.name || null,
      region: clusterInfo.region || null,
      vpcId: clusterInfo.eksCluster?.vpcId || null,
      isTerraform: clusterInfo.isTerraform || false
    });
  } catch (error) {
    console.error('Error getting cluster info:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 获取S3存储桶列表（用于模型存储）
router.get('/cluster/s3-buckets', async (req, res) => {
  try {
    const activeCluster = clusterManager.getActiveCluster();
    if (!activeCluster) {
      return res.json({
        success: true,
        buckets: [],
        clusterBucket: null
      });
    }

    let clusterBucket = null;

    // 使用 s3StorageManager 获取模型存储的 S3 bucket（从 S3 CSI PV/PVC 中检测）
    try {
      const storageResult = await s3StorageManager.getStorages();

      if (storageResult.success && storageResult.storages.length > 0) {
        // 优先选择名为 's3-claim' 的存储（通常是主要的模型存储）
        let selectedStorage = storageResult.storages.find(s => s.pvcName === 's3-claim');

        // 如果没有 s3-claim，使用第一个存储
        if (!selectedStorage) {
          selectedStorage = storageResult.storages[0];
        }

        clusterBucket = {
          name: selectedStorage.bucketName,
          region: selectedStorage.region || 'us-west-2'
        };
        console.log(`Got S3 model storage bucket from s3StorageManager: ${selectedStorage.bucketName} (PVC: ${selectedStorage.pvcName})`);
      }
    } catch (error) {
      console.warn('Failed to get S3 bucket from s3StorageManager:', error.message);
    }

    const buckets = clusterBucket ? [clusterBucket] : [];

    res.json({
      success: true,
      buckets: buckets,
      clusterBucket: clusterBucket
    });
  } catch (error) {
    console.error('Error getting S3 buckets:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 获取EKS节点组创建所需的子网信息
router.get('/cluster/subnets', async (req, res) => {
  try {
    const { promisify } = require('util');
    const execAsync = promisify(require('child_process').exec);

    // 获取当前活跃集群信息
    const activeCluster = clusterManager.getActiveCluster();
    if (!activeCluster) {
      return res.status(400).json({ success: false, error: 'No active cluster selected' });
    }

    // 从metadata获取集群信息
    const clusterInfo = MetadataUtils.getClusterInfo(activeCluster);

    if (!clusterInfo) {
      return res.status(400).json({ success: false, error: 'Cluster metadata not found' });
    }

    // 从metadata获取基本信息
    const eksClusterName = clusterInfo.eksCluster.name;
    const region = clusterInfo.region;
    const vpcId = clusterInfo.eksCluster.vpcId;
    const securityGroupId = clusterInfo.eksCluster.securityGroupId;

    if (!vpcId) {
      return res.status(400).json({ success: false, error: 'VPC ID not found in metadata' });
    }

    // 获取子网信息（仍需要动态获取，因为子网信息不在metadata中）
    const subnetInfo = await CloudFormationManager.fetchSubnetInfo(vpcId, region);

    // 从metadata获取HyperPod使用的子网和Security Group
    let hyperPodSubnets = [];
    let hyperPodSecurityGroup = null;
    if (clusterInfo.hyperPodCluster) {
      const hpData = clusterInfo.hyperPodCluster;
      // 优先从 InstanceGroups[0].OverrideVpcConfig 获取子网，回退到 VpcConfig
      const overrideSubnets = hpData.InstanceGroups?.[0]?.OverrideVpcConfig?.Subnets;
      hyperPodSubnets = overrideSubnets || hpData.VpcConfig?.Subnets || [];
      hyperPodSecurityGroup = hpData.VpcConfig?.SecurityGroupIds?.[0] || null;
      console.log('Found HyperPod compute subnets:', hyperPodSubnets);
    } else {
      console.log('No HyperPod cluster found in metadata');
    }

    // 标记HyperPod使用的子网
    const markedSubnets = {
      publicSubnets: subnetInfo.publicSubnets,
      privateSubnets: subnetInfo.privateSubnets.map(subnet => ({
        ...subnet,
        isHyperPodSubnet: hyperPodSubnets.includes(subnet.subnetId)
      })),
      hyperPodSubnets: hyperPodSubnets
    };

    res.json({
      success: true,
      data: {
        eksClusterName,
        region,
        vpcId,
        securityGroupId,
        hyperPodSecurityGroup,
        ...markedSubnets
      }
    });

  } catch (error) {
    console.error('Error fetching subnets:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 轻量接口：列出可作为 compute subnet 复用的候选子网（供 Add Instance Group 下拉）。
// 返回 VPC 内所有子网，但排除三类不适合跑计算节点的：
//   1. EKS 控制面子网（cluster.resourcesVpcConfig.subnetIds）——无外网出口、职责不同
//   2. public 子网（MapPublicIpOnLaunch=true）——不应把计算节点放公网段
//   3. 无 NAT 默认路由的子网（无 0.0.0.0/0 -> nat）——节点起得来但拉不到镜像/模型
// 用 3 个独立批量调用（describe-cluster / describe-subnets / describe-route-tables），
// 不做 per-subnet 的路由表查询，避免 /subnets 的 N+1 延迟。
router.get('/cluster/compute-subnets', async (req, res) => {
  try {
    const { promisify } = require('util');
    const execAsync = promisify(require('child_process').exec);

    const activeCluster = clusterManager.getActiveCluster();
    if (!activeCluster) {
      return res.status(400).json({ success: false, error: 'No active cluster selected' });
    }

    const clusterInfo = MetadataUtils.getClusterInfo(activeCluster);
    if (!clusterInfo) {
      return res.status(400).json({ success: false, error: 'Cluster metadata not found' });
    }

    const region = clusterInfo.region;
    const vpcId = clusterInfo.eksCluster?.vpcId;
    const eksClusterName = clusterInfo.eksCluster?.name;
    if (!vpcId) {
      return res.status(400).json({ success: false, error: 'VPC ID not found in metadata' });
    }

    // 1. EKS 控制面注册的子网（要排除）。拿不到时降级为空集，仍应用 public/NAT 过滤。
    const controlPlaneSubnets = new Set();
    if (eksClusterName) {
      try {
        const { stdout } = await execAsync(
          `aws eks describe-cluster --name ${eksClusterName} --region ${region} ` +
          `--query "cluster.resourcesVpcConfig.subnetIds" --output json`
        );
        for (const id of JSON.parse(stdout || '[]')) controlPlaneSubnets.add(id);
      } catch (e) {
        console.warn(`[compute-subnets] describe-cluster failed, skip control-plane exclusion: ${e.message}`);
      }
    }

    // 2. VPC 内全部子网
    const { stdout: subnetStdout } = await execAsync(
      `aws ec2 describe-subnets --region ${region} ` +
      `--filters "Name=vpc-id,Values=${vpcId}" ` +
      `--query "Subnets[].{subnetId:SubnetId,availabilityZone:AvailabilityZone,cidrBlock:CidrBlock,name:Tags[?Key=='Name']|[0].Value,mapPublicIpOnLaunch:MapPublicIpOnLaunch}" ` +
      `--output json`
    );
    const allSubnets = JSON.parse(subnetStdout || '[]');

    // 3. VPC 内路由表 —— 用于判断每个子网是否有 0.0.0.0/0 -> NAT 的默认出口
    const { stdout: rtStdout } = await execAsync(
      `aws ec2 describe-route-tables --region ${region} ` +
      `--filters "Name=vpc-id,Values=${vpcId}" ` +
      `--query "RouteTables[].{associations:Associations[].{subnetId:SubnetId,main:Main},routes:Routes[].{dest:DestinationCidrBlock,nat:NatGatewayId}}" ` +
      `--output json`
    );
    const routeTables = JSON.parse(rtStdout || '[]');

    // subnetId -> 生效路由表（显式关联优先，否则 VPC main 路由表）
    let mainRt = null;
    const explicitRt = {};
    for (const rt of routeTables) {
      for (const assoc of (rt.associations || [])) {
        if (assoc.main) mainRt = rt;
        if (assoc.subnetId) explicitRt[assoc.subnetId] = rt;
      }
    }
    const hasNatEgress = (subnetId) => {
      const rt = explicitRt[subnetId] || mainRt;
      if (!rt) return false;
      return (rt.routes || []).some(r => r.dest === '0.0.0.0/0' && r.nat);
    };

    // 过滤：排除控制面 / public / 无 NAT 出口
    const computeSubnets = allSubnets
      .filter(s => !controlPlaneSubnets.has(s.subnetId))
      .filter(s => !s.mapPublicIpOnLaunch)
      .filter(s => hasNatEgress(s.subnetId))
      .map(s => ({
        subnetId: s.subnetId,
        availabilityZone: s.availabilityZone,
        cidrBlock: s.cidrBlock,
        name: s.name || ''
      }));
    computeSubnets.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    res.json({ success: true, data: { region, vpcId, computeSubnets } });
  } catch (error) {
    console.error('Error fetching compute subnets:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = { router, initialize };
