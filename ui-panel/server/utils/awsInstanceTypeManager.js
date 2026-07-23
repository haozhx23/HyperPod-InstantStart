const { execSync } = require('child_process');
const MetadataUtils = require('./metadataUtils');
const { getEffectiveRegion } = require('./regionResolver');

/**
 * AWS Instance Type Manager
 * 管理 AWS GPU 实例类型的查询、缓存和按子网/AZ 筛选
 */
class AWSInstanceTypeManager {

  // 默认支持的 GPU 实例系列
  static DEFAULT_GPU_FAMILIES = ['g5', 'g6', 'g6e', 'p4', 'p5', 'p5e', 'p5en', 'p6'];

  // 实例系列排序顺序
  static FAMILY_ORDER = ['g5', 'g6', 'g6e', 'p4', 'p5', 'p5e', 'p5en', 'p6'];

  /**
   * 获取缓存的实例类型
   * @param {string} clusterName - 集群名称
   * @returns {Object} { success, data?, error?, needsRefresh? }
   */
  static getCachedInstanceTypes(clusterName) {
    if (!clusterName) {
      return { success: false, error: 'No active cluster configured' };
    }

    const cachedData = MetadataUtils.getInstanceTypesCache(clusterName);

    if (cachedData && !cachedData.error) {
      console.log(`Returning cached instance types for cluster: ${clusterName} (last updated: ${cachedData.lastUpdated})`);
      return {
        success: true,
        data: {
          region: cachedData.region,
          instanceTypes: cachedData.instanceTypes,
          lastUpdated: cachedData.lastUpdated,
          cached: true
        }
      };
    }

    if (cachedData && cachedData.error) {
      return {
        success: false,
        error: `Instance types cache has error: ${cachedData.error}`,
        lastUpdated: cachedData.lastUpdated,
        needsRefresh: true
      };
    }

    return {
      success: false,
      error: 'Instance types not cached yet. Please click refresh to fetch from AWS.',
      needsRefresh: true
    };
  }

  /**
   * 从 AWS 刷新实例类型并更新缓存
   * @param {string} clusterName - 集群名称
   * @param {string[]} families - 要查询的实例系列
   * @returns {Object} { success, data?, error? }
   */
  static async refreshInstanceTypes(clusterName, families = null) {
    if (!clusterName) {
      return { success: false, error: 'No active cluster configured' };
    }

    const currentRegion = getEffectiveRegion(clusterName);
    const familyFilter = families && families.length > 0 ? families : this.DEFAULT_GPU_FAMILIES;

    console.log(`Refreshing instance types for cluster: ${clusterName}, region: ${currentRegion}`);

    const instanceTypes = [];
    const errors = [];

    for (const family of familyFilter) {
      try {
        const types = await this._fetchInstanceTypesByFamily(family, currentRegion);
        instanceTypes.push(...types);
        console.log(`Found ${types.length} ${family} instance types`);
      } catch (error) {
        const errorMsg = `Failed to fetch ${family} instance types: ${error.message}`;
        console.error(errorMsg);
        errors.push(errorMsg);
      }
    }

    // 准备缓存数据
    const cacheData = {
      region: currentRegion,
      lastUpdated: new Date().toISOString(),
      instanceTypes: instanceTypes,
      error: errors.length > 0 ? errors.join('; ') : null,
      familiesRequested: this.DEFAULT_GPU_FAMILIES,
      totalFound: instanceTypes.length
    };

    // 保存缓存
    const saved = MetadataUtils.saveInstanceTypesCache(clusterName, cacheData);

    if (!saved) {
      return { success: false, error: 'Failed to save instance types to cache' };
    }

    if (instanceTypes.length > 0) {
      console.log(`Successfully refreshed ${instanceTypes.length} instance types for cluster: ${clusterName}`);
      return {
        success: true,
        data: {
          region: currentRegion,
          instanceTypes: instanceTypes,
          lastUpdated: cacheData.lastUpdated,
          totalFound: instanceTypes.length,
          errors: errors.length > 0 ? errors : null
        }
      };
    } else {
      const errorMessage = errors.length > 0 ? errors.join('; ') : 'No GPU instance types found in this region';
      return {
        success: false,
        error: errorMessage,
        region: currentRegion
      };
    }
  }

  /**
   * 按子网获取可用的实例类型
   * @param {string} clusterName - 集群名称
   * @param {string} subnetId - 子网 ID
   * @returns {Object} { success, data?, error? }
   */
  static async getInstanceTypesBySubnet(clusterName, subnetId) {
    if (!clusterName) {
      return { success: false, error: 'No active cluster configured' };
    }

    if (!subnetId) {
      return { success: false, error: 'subnetId is required' };
    }

    console.log(`Fetching instance types for subnet: ${subnetId}, cluster: ${clusterName}`);

    // 获取子网的可用区
    const availabilityZone = this._getSubnetAvailabilityZone(subnetId);

    if (!availabilityZone) {
      return { success: false, error: `Subnet ${subnetId} not found or invalid` };
    }

    console.log(`Subnet ${subnetId} is in availability zone: ${availabilityZone}`);

    const currentRegion = getEffectiveRegion(clusterName);

    try {
      const instanceTypes = await this._fetchInstanceTypesByAZ(availabilityZone, currentRegion, subnetId);

      // 保存到缓存
      const cacheData = {
        subnetId: subnetId,
        availabilityZone: availabilityZone,
        region: currentRegion,
        lastUpdated: new Date().toISOString(),
        instanceTypes: instanceTypes,
        error: null,
        familiesRequested: this.DEFAULT_GPU_FAMILIES,
        totalFound: instanceTypes.length
      };

      const saved = MetadataUtils.saveSubnetInstanceTypesCache(clusterName, subnetId, cacheData);

      if (instanceTypes.length > 0) {
        console.log(`Successfully fetched ${instanceTypes.length} instance types for subnet: ${subnetId}`);
        return {
          success: true,
          data: {
            subnetId: subnetId,
            availabilityZone: availabilityZone,
            region: currentRegion,
            instanceTypes: instanceTypes,
            lastUpdated: cacheData.lastUpdated,
            totalFound: instanceTypes.length,
            cached: saved
          }
        };
      } else {
        return {
          success: false,
          error: `No GPU instance types found in subnet ${subnetId} (${availabilityZone})`,
          subnetId: subnetId,
          availabilityZone: availabilityZone,
          region: currentRegion
        };
      }
    } catch (error) {
      console.error(`Error fetching instance types for subnet ${subnetId}:`, error.message);
      return {
        success: false,
        error: error.message,
        subnetId: subnetId,
        availabilityZone: availabilityZone
      };
    }
  }

  /**
   * 按 AZ 获取可用的实例类型
   * @param {string} availabilityZone - 可用区
   * @param {string} region - AWS 区域
   * @returns {Object} { success, data?, error? }
   */
  static async getInstanceTypesByAZ(availabilityZone, region = null) {
    const currentRegion = region || getEffectiveRegion();

    try {
      const instanceTypes = await this._fetchInstanceTypesByAZ(availabilityZone, currentRegion);

      return {
        success: true,
        data: {
          availabilityZone: availabilityZone,
          region: currentRegion,
          instanceTypes: instanceTypes,
          totalFound: instanceTypes.length
        }
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        availabilityZone: availabilityZone,
        region: currentRegion
      };
    }
  }

  // ==================== Private Methods ====================

  /**
   * 获取子网的可用区
   * @private
   */
  static _getSubnetAvailabilityZone(subnetId) {
    try {
      const cmd = `aws ec2 describe-subnets --subnet-ids ${subnetId} --query "Subnets[0].AvailabilityZone" --output text`;
      const az = execSync(cmd, { encoding: 'utf8', timeout: 10000 }).trim();
      return az && az !== 'None' ? az : null;
    } catch (error) {
      console.error(`Error getting subnet AZ: ${error.message}`);
      return null;
    }
  }

  /**
   * 按实例系列获取实例类型
   * @private
   */
  static async _fetchInstanceTypesByFamily(family, region) {
    // 特殊处理 p6 家族的命名格式
    const filterPattern = family === 'p6' ? 'p6-b200.*' : `${family}.*`;

    const cmd = `aws ec2 describe-instance-types --region ${region} --filters "Name=instance-type,Values=${filterPattern}" --query "InstanceTypes[?GpuInfo.Gpus].{InstanceType:InstanceType,VCpuInfo:VCpuInfo,MemoryInfo:MemoryInfo,GpuInfo:GpuInfo}" --output json`;

    console.log(`Fetching ${family} instance types from region ${region}`);

    const output = execSync(cmd, { encoding: 'utf8', timeout: 15000 });
    const awsInstanceTypes = JSON.parse(output);

    return this._transformInstanceTypes(awsInstanceTypes, family);
  }

  /**
   * 按可用区获取实例类型
   * @private
   */
  static async _fetchInstanceTypesByAZ(availabilityZone, region, subnetId = null) {
    console.log(`Optimized fetch: Getting all GPU instances available in ${availabilityZone}`);

    // Step 1: 获取该 AZ 所有可用的 GPU 实例类型
    const azCmd = `aws ec2 describe-instance-type-offerings --location-type availability-zone --filters "Name=location,Values=${availabilityZone}" --query "InstanceTypeOfferings[?starts_with(InstanceType, 'g5.') || starts_with(InstanceType, 'g6.') || starts_with(InstanceType, 'g6e.') || starts_with(InstanceType, 'p4.') || starts_with(InstanceType, 'p5.') || starts_with(InstanceType, 'p5e.') || starts_with(InstanceType, 'p5en.') || starts_with(InstanceType, 'p6-b200.')].InstanceType" --region ${region} --output json`;

    const azOutput = execSync(azCmd, { encoding: 'utf8', timeout: 15000 });
    const availableInstanceTypeNames = JSON.parse(azOutput);

    console.log(`Found ${availableInstanceTypeNames.length} GPU instance types available in ${availabilityZone}`);

    if (availableInstanceTypeNames.length === 0) {
      console.warn(`No GPU instance types found in ${availabilityZone}`);
      return [];
    }

    // Step 2: 获取详细信息
    console.log(`Getting detailed info for ${availableInstanceTypeNames.length} instance types...`);
    const detailsCmd = `aws ec2 describe-instance-types --region ${region} --instance-types ${availableInstanceTypeNames.join(' ')} --query "InstanceTypes[?GpuInfo.Gpus].{InstanceType:InstanceType,VCpuInfo:VCpuInfo,MemoryInfo:MemoryInfo,GpuInfo:GpuInfo}" --output json`;

    const detailsOutput = execSync(detailsCmd, { encoding: 'utf8', timeout: 25000 });
    const instanceDetails = JSON.parse(detailsOutput);

    // Step 3: 转换格式
    const instanceTypes = this._transformInstanceTypes(instanceDetails, null, availabilityZone, subnetId);

    console.log(`Successfully processed ${instanceTypes.length} GPU instance types for ${availabilityZone}`);

    // 按系列统计
    const familyCount = {};
    instanceTypes.forEach(it => familyCount[it.family] = (familyCount[it.family] || 0) + 1);
    console.log(`Instance distribution:`, Object.entries(familyCount).map(([f, c]) => `${f}:${c}`).join(', '));

    return instanceTypes;
  }

  /**
   * 转换 AWS 实例类型数据为统一格式
   * @private
   */
  static _transformInstanceTypes(awsTypes, defaultFamily = null, availabilityZone = null, subnetId = null) {
    return awsTypes
      .filter(type => type.GpuInfo && type.GpuInfo.Gpus && type.GpuInfo.Gpus.length > 0)
      .map(type => {
        const gpuInfo = type.GpuInfo.Gpus[0];
        const gpuCount = type.GpuInfo.Gpus.reduce((sum, gpu) => sum + (gpu.Count || 1), 0);
        const gpuName = gpuInfo.Name || 'GPU';

        // 确定实例系列
        const family = defaultFamily || this._detectFamily(type.InstanceType);

        const result = {
          value: type.InstanceType,
          label: type.InstanceType,
          family: family,
          vcpu: type.VCpuInfo.DefaultVCpus,
          memory: Math.round(type.MemoryInfo.SizeInMiB / 1024),
          gpu: gpuCount > 1 ? `${gpuCount}x ${gpuName}` : `1x ${gpuName}`
        };

        if (availabilityZone) result.availabilityZone = availabilityZone;
        if (subnetId) result.subnetId = subnetId;

        return result;
      })
      .sort((a, b) => {
        // 先按系列排序
        if (a.family !== b.family) {
          return this.FAMILY_ORDER.indexOf(a.family) - this.FAMILY_ORDER.indexOf(b.family);
        }
        // 同系列内按实例大小排序
        return this._getInstanceSize(a.value) - this._getInstanceSize(b.value);
      });
  }

  /**
   * 检测实例类型所属系列
   * @private
   */
  static _detectFamily(instanceType) {
    if (instanceType.startsWith('g5.')) return 'g5';
    if (instanceType.startsWith('g6e.')) return 'g6e';
    if (instanceType.startsWith('g6.')) return 'g6';
    if (instanceType.startsWith('p4.')) return 'p4';
    if (instanceType.startsWith('p5en.')) return 'p5en';
    if (instanceType.startsWith('p5e.')) return 'p5e';
    if (instanceType.startsWith('p5.')) return 'p5';
    if (instanceType.startsWith('p6-b200.')) return 'p6';
    return 'other';
  }

  /**
   * 获取实例大小数值（用于排序）
   * @private
   */
  static _getInstanceSize(instanceType) {
    const match = instanceType.match(/(\d*)xlarge/);
    return match ? (match[1] ? parseInt(match[1]) : 1) : 0;
  }
}

module.exports = AWSInstanceTypeManager;
