/**
 * Instance Group 工具函数
 *
 * 统一处理 describe-cluster 返回的 InstanceGroup 到 update-cluster 所需格式的转换。
 * 使用白名单方式，只保留 update-cluster API 允许的字段。
 */

const { instanceTypes: efaOnlyInstanceTypes = [] } = require('../../config/efa-only-instance-types.json');

const EFA_ONLY_INSTANCE_TYPES = new Set(efaOnlyInstanceTypes);

const ALLOWED_INSTANCE_GROUP_FIELDS = [
  'InstanceCount', 'InstanceGroupName', 'InstanceType', 'LifeCycleConfig',
  'ExecutionRole', 'ThreadsPerCore', 'InstanceStorageConfigs',
  'OnStartDeepHealthChecks', 'TrainingPlanArn', 'OverrideVpcConfig',
  'ScheduledUpdateConfig', 'ImageId', 'CapacityRequirements',
  // 更新已有 IG 时必须保留其 NetworkInterface desired configuration。
  // 修改该字段不会原地转换运行节点的 ENI，实际生效仍需重建节点和 customer ENI。
  'NetworkInterface'
];

/**
 * 将 describe-cluster 返回的 InstanceGroup 清理为 update-cluster 接受的格式
 * - 使用白名单过滤字段
 * - 将 TargetCount 映射为 InstanceCount
 */
function cleanInstanceGroupForUpdate(instanceGroup) {
  const cleaned = {};

  ALLOWED_INSTANCE_GROUP_FIELDS.forEach(field => {
    if (field === 'InstanceCount') {
      // describe-cluster 返回 TargetCount，update-cluster 需要 InstanceCount
      cleaned.InstanceCount = instanceGroup.TargetCount;
    } else if (instanceGroup.hasOwnProperty(field)) {
      cleaned[field] = instanceGroup[field];
    }
  });

  return cleaned;
}

function isEfaOnlySupportedInstanceType(instanceType) {
  return typeof instanceType === 'string' && EFA_ONLY_INSTANCE_TYPES.has(instanceType);
}

module.exports = {
  cleanInstanceGroupForUpdate,
  isEfaOnlySupportedInstanceType,
  ALLOWED_INSTANCE_GROUP_FIELDS
};
