const fs = require('fs');
const { execSync, execAsync: exec } = require('./exec');
const { isAwsRegion, isSafeBucketName } = require('./validateInput');

// 工作机的默认 S3 bucket 信息。cli-min/pre-requisites/eks-hypd-workspace.yaml 在开发机上把
// `{"bucketName": ...}` 写到 ~/workspace/s3/CURRENT_BUCKET_INFO，start-prod.sh 再把
// ~/workspace/s3 只读挂到容器的 /s3-workspace-metadata。s3StorageManager.getStorageDefaults()
// 读的是同一个文件。
const WORKSPACE_BUCKET_INFO_PATH = '/s3-workspace-metadata/CURRENT_BUCKET_INFO';

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
  getCurrentS3Bucket,
  getWorkspaceBucketInfo,
  WORKSPACE_BUCKET_INFO_PATH,
  getInstanceEfaCount,
  getInstanceTypeInfo
};

/**
 * 读取工作机默认 S3 bucket 名（来源见 WORKSPACE_BUCKET_INFO_PATH 的注释）。
 *
 * 找不到或内容不对时直接抛错并写明路径：调用方（创建 MLflow tracking server）需要一个
 * 确定的 artifact store，退化成空字符串只会让 AWS 那边报一个看不出原因的参数错误。
 *
 * @param {string} [infoPath] 测试用；默认读容器内挂载点
 * @returns {string} bucket 名
 */
function getCurrentS3Bucket(infoPath = WORKSPACE_BUCKET_INFO_PATH) {
  return getWorkspaceBucketInfo(infoPath).bucketName;
}

/**
 * 读取工作机默认 S3 bucket 的名字和所在 region。
 *
 * region 来自同一个文件的 `awsRegion`（工作机模板写入的是 `${AWS::Region}`，即工作机栈所在
 * region）。它不一定等于被管理集群的 region：面板可以管理别的 region 的集群，此时 S3 挂载的
 * `region` 选项、MLflow 的 artifact store 都必须看 bucket 自己的 region，不能套用集群 region。
 * 字段缺失或格式不对时返回 `awsRegion: null`，由调用方决定怎么处理，不在这里猜。
 *
 * @param {string} [infoPath] 测试用；默认读容器内挂载点
 * @returns {{ bucketName: string, awsRegion: (string|null) }}
 */
function getWorkspaceBucketInfo(infoPath = WORKSPACE_BUCKET_INFO_PATH) {
  let raw;
  try {
    raw = fs.readFileSync(infoPath, 'utf8');
  } catch (error) {
    throw new Error(
      `Default S3 bucket unknown: cannot read ${infoPath} (${error.code || error.message}). ` +
      'It is written by the workspace CloudFormation template and mounted by start-prod.sh.'
    );
  }
  let info;
  try {
    info = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Default S3 bucket unknown: ${infoPath} is not valid JSON (${error.message})`);
  }
  const bucketName = typeof info?.bucketName === 'string' ? info.bucketName.trim() : '';
  if (!bucketName) {
    throw new Error(`Default S3 bucket unknown: ${infoPath} has no "bucketName"`);
  }
  // 调用方会把它拼进 shell 命令；按 S3 bucket 命名规则校验，非法值不往下传。
  if (!isSafeBucketName(bucketName)) {
    throw new Error(`Default S3 bucket name in ${infoPath} is not a valid S3 bucket name: ${JSON.stringify(bucketName)}`);
  }
  const awsRegion = isAwsRegion(info.awsRegion) ? info.awsRegion : null;
  return { bucketName, awsRegion };
}

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
    // 惰性 require 防止与 regionResolver 的加载顺序问题(后者只在函数内部 require 本模块)
    const { getEffectiveRegion } = require('./regionResolver');
    const r = region || getEffectiveRegion();
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
    // 失败结果不进缓存：缓存只按实例类型做 key、在进程内永久有效，一次失败（网络抖动、
    // 或在另一个集群的 region 查询失败）会让这个类型此后一直显示为全零。
    return { vCPUs: 0, memoryGiB: 0, gpuCount: 0, gpuMemoryMiB: 0, efaSupported: false, efaInterfaces: 0 };
  }
}

async function getInstanceEfaCount(instanceType, region) {
  const info = await getInstanceTypeInfo(instanceType, region);
  return info.efaInterfaces;
}
