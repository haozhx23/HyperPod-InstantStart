/**
 * Instance Group 工具函数
 *
 * 统一处理 describe-cluster 返回的 InstanceGroup 到 update-cluster 所需格式的转换。
 * 使用白名单方式，只保留 update-cluster API 允许的字段。
 */

const ALLOWED_INSTANCE_GROUP_FIELDS = [
  'InstanceCount', 'InstanceGroupName', 'InstanceType', 'LifeCycleConfig',
  'ExecutionRole', 'ThreadsPerCore', 'InstanceStorageConfigs',
  'OnStartDeepHealthChecks', 'TrainingPlanArn', 'OverrideVpcConfig',
  'ScheduledUpdateConfig', 'ImageId', 'CapacityRequirements',
  // NetworkInterface (efa-only) 在创建时定死、不可变。必须保留，否则每次 update-cluster
  // 重发存量组时会丢掉其网卡配置，导致 efa-only 组在不相关更新时被 AWS 拒绝/重置。
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

module.exports = { cleanInstanceGroupForUpdate, ALLOWED_INSTANCE_GROUP_FIELDS };
