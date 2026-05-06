const { execSync } = require('child_process');
const { promisify } = require('util');
const exec = promisify(require('child_process').exec);

// 模块级缓存
let _cachedAccountId = null;
let _cachedRegion = null;

function getCurrentAccountId() {
  if (_cachedAccountId) return _cachedAccountId;
  
  const command = 'aws sts get-caller-identity --query Account --output text';
  _cachedAccountId = execSync(command, { encoding: 'utf8' }).trim();
  console.log(`Account ID cached: ${_cachedAccountId}`);
  return _cachedAccountId;
}

function getCurrentRegion() {
  if (_cachedRegion) return _cachedRegion;

  // 1. 环境变量优先（容器/EKS 场景常用）
  const envRegion = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
  if (envRegion) {
    _cachedRegion = envRegion.trim();
    console.log(`Region from env: ${_cachedRegion}`);
    return _cachedRegion;
  }

  // 2. aws configure get region
  try {
    const region = execSync('aws configure get region', { encoding: 'utf8', timeout: 5000 }).trim();
    if (region) {
      _cachedRegion = region;
      console.log(`Region from aws configure: ${_cachedRegion}`);
      return _cachedRegion;
    }
  } catch (e) {
    // aws configure 可能未配置，继续尝试下一个来源
  }

  // 3. EC2 IMDS（实例元数据）
  try {
    const az = execSync(
      'curl -s --max-time 2 http://169.254.169.254/latest/meta-data/placement/availability-zone',
      { encoding: 'utf8', timeout: 5000 }
    ).trim();
    if (az) {
      const region = az.replace(/[a-z]$/, '');
      _cachedRegion = region;
      console.log(`Region from IMDS: ${_cachedRegion}`);
      return _cachedRegion;
    }
  } catch (e) {
    // IMDS 不可用
  }

  throw new Error('AWS region not configured. Set AWS_REGION env var or run "aws configure set region <region>".');
}

async function describeHyperPodCluster(clusterName, region) {
  const command = `aws sagemaker describe-cluster --cluster-name ${clusterName} --region ${region} --output json`;
  const result = await exec(command);
  return JSON.parse(result.stdout);
}

/**
 * 获取 Subnet 的 Availability Zone 信息
 * @param {string[]} subnetIds - Subnet ID 数组
 * @param {string} region - AWS 区域
 * @returns {Object} { subnetId: az } 的映射
 */
async function getSubnetAZs(subnetIds, region) {
  if (!subnetIds || subnetIds.length === 0) return {};
  
  try {
    const command = `aws ec2 describe-subnets --subnet-ids ${subnetIds.join(' ')} --region ${region} --query 'Subnets[*].[SubnetId,AvailabilityZone]' --output json`;
    const result = await exec(command);
    const data = JSON.parse(result.stdout);
    
    // 转换为 { subnetId: az } 的映射
    const azMap = {};
    data.forEach(([subnetId, az]) => {
      azMap[subnetId] = az;
    });
    return azMap;
  } catch (error) {
    console.error('Error getting subnet AZs:', error);
    return {};
  }
}

/**
 * 通过 ENI 获取 Security Groups
 * @param {string[]} eniIds - ENI ID 数组
 * @param {string} region - AWS 区域
 * @returns {string[]} Security Group ID 数组
 */
async function getSecurityGroupsFromENIs(eniIds, region) {
  if (!eniIds || eniIds.length === 0) return [];
  
  try {
    const command = `aws ec2 describe-network-interfaces --network-interface-ids ${eniIds.join(' ')} --region ${region} --query 'NetworkInterfaces[0].Groups[*].GroupId' --output json`;
    const result = await exec(command);
    return JSON.parse(result.stdout) || [];
  } catch (error) {
    console.error('Error getting security groups from ENIs:', error);
    return [];
  }
}

module.exports = {
  getCurrentAccountId,
  getCurrentRegion,
  describeHyperPodCluster,
  getSubnetAZs,
  getSecurityGroupsFromENIs,
  getCurrentIdentity,
  extractRoleArn,
  getCurrentRoleArn,
  getInstanceEfaCount,
  getInstanceTypeInfo
};

/**
 * 获取当前调用者身份
 * @returns {Promise<Object>} { Account, Arn, UserId }
 */
async function getCurrentIdentity() {
  const result = await exec('aws sts get-caller-identity');
  return JSON.parse(result.stdout);
}

/**
 * 从 assumed role ARN 中提取 IAM role ARN
 * @param {string} assumedRoleArn - arn:aws:sts::account:assumed-role/role-name/session
 * @returns {string} arn:aws:iam::account:role/role-name
 */
function extractRoleArn(assumedRoleArn) {
  const match = assumedRoleArn.match(/arn:aws:sts::(\d+):assumed-role\/([^\/]+)\//);
  if (match) {
    return `arn:aws:iam::${match[1]}:role/${match[2]}`;
  }
  throw new Error(`Invalid assumed role ARN format: ${assumedRoleArn}`);
}

/**
 * 获取当前 EC2/环境的 IAM Role ARN
 * @returns {Promise<string>} IAM Role ARN
 */
async function getCurrentRoleArn() {
  const identity = await getCurrentIdentity();
  return extractRoleArn(identity.Arn);
}

// Instance type info cache: { ec2Type: { vCPUs, memoryGiB, gpuCount, gpuMemoryMiB, efaSupported, efaInterfaces } }
const _instanceInfoCache = {};

/**
 * 查询实例类型的完整硬件信息（带缓存）
 * @param {string} instanceType - 实例类型，如 ml.p5.48xlarge 或 p5.48xlarge
 * @param {string} [region] - AWS 区域，默认当前区域
 * @returns {Promise<Object>} { vCPUs, memoryGiB, gpuCount, gpuMemoryMiB, efaSupported, efaInterfaces }
 */
async function getInstanceTypeInfo(instanceType, region) {
  const ec2Type = instanceType.replace(/^ml\./, '');
  if (_instanceInfoCache[ec2Type]) return _instanceInfoCache[ec2Type];

  try {
    const r = region || getCurrentRegion();
    const { stdout } = await exec(
      `aws ec2 describe-instance-types --instance-types ${ec2Type} --query 'InstanceTypes[0].{vCPUs: VCpuInfo.DefaultVCpus, MemoryMiB: MemoryInfo.SizeInMiB, GPUs: GpuInfo.Gpus[0].Count, GPUMemMiB: GpuInfo.TotalGpuMemoryInMiB, EfaSupported: NetworkInfo.EfaSupported, EfaInterfaces: NetworkInfo.EfaInfo.MaximumEfaInterfaces}' --output json --region ${r}`
    );
    const raw = JSON.parse(stdout.trim());
    const info = {
      vCPUs: raw.vCPUs || 0,
      memoryGiB: raw.MemoryMiB ? Math.round(raw.MemoryMiB / 1024) : 0,
      gpuCount: raw.GPUs || 0,
      gpuMemoryMiB: raw.GPUMemMiB || 0,
      efaSupported: raw.EfaSupported || false,
      efaInterfaces: raw.EfaInterfaces || 0,
    };
    _instanceInfoCache[ec2Type] = info;
    return info;
  } catch (e) {
    console.warn(`Failed to query instance info for ${ec2Type}:`, e.message);
    const fallback = { vCPUs: 0, memoryGiB: 0, gpuCount: 0, gpuMemoryMiB: 0, efaSupported: false, efaInterfaces: 0 };
    _instanceInfoCache[ec2Type] = fallback;
    return fallback;
  }
}

async function getInstanceEfaCount(instanceType, region) {
  const info = await getInstanceTypeInfo(instanceType, region);
  return info.efaInterfaces;
}
