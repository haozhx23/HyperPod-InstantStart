const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Compute Subnet Manager
 * 管理 EKS Node Group 使用的 compute subnet
 * 命名规则: hp-compute-{az} (如 hp-compute-us-east-2a)
 */
class ComputeSubnetManager {

  static SUBNET_PREFIX = 'hp-compute';

  /**
   * 计算 compute subnet 的 Name tag
   * - 传 instanceGroupName -> hp-compute-{instanceGroupName}-{az}（专属 subnet）
   * - 不传 -> hp-compute-{az}（按 AZ 共享，保持原行为）
   */
  static computeSubnetName(availabilityZone, instanceGroupName = null) {
    return instanceGroupName
      ? `${this.SUBNET_PREFIX}-${instanceGroupName}-${availabilityZone}`
      : `${this.SUBNET_PREFIX}-${availabilityZone}`;
  }

  /**
   * 确保指定 AZ 存在 compute subnet，不存在则创建
   * @param {string} vpcId - VPC ID
   * @param {string} availabilityZone - 可用区名称 (如 us-east-2a)
   * @param {string} region - AWS 区域
   * @param {string} clusterName - EKS 集群名称 (用于 karpenter discovery tag)
   * @param {string|null} instanceGroupName - 传入则创建该 IG 专属 subnet，否则按 AZ 共享
   * @returns {Promise<{subnetId: string, created: boolean}>}
   */
  static async ensureComputeSubnet(vpcId, availabilityZone, region, clusterName, instanceGroupName = null) {
    const subnetName = this.computeSubnetName(availabilityZone, instanceGroupName);
    console.log(`[ComputeSubnetManager] Ensuring compute subnet "${subnetName}" in AZ: ${availabilityZone}`);

    // 1. 检查是否已存在
    const existingSubnet = await this.findComputeSubnet(vpcId, availabilityZone, region, instanceGroupName);
    if (existingSubnet) {
      console.log(`[ComputeSubnetManager] Found existing compute subnet: ${existingSubnet.subnetId}`);
      return { subnetId: existingSubnet.subnetId, created: false };
    }

    // 2. 不存在则创建
    console.log(`[ComputeSubnetManager] No compute subnet found, creating new one...`);
    const newSubnet = await this.createComputeSubnet(vpcId, availabilityZone, region, clusterName, instanceGroupName);
    return { subnetId: newSubnet.subnetId, created: true };
  }

  /**
   * 查找指定 AZ 的 compute subnet
   * @param {string|null} instanceGroupName - 传入则查找专属 subnet 名，否则查找共享名
   */
  static async findComputeSubnet(vpcId, availabilityZone, region, instanceGroupName = null) {
    try {
      const subnetName = this.computeSubnetName(availabilityZone, instanceGroupName);
      const cmd = `aws ec2 describe-subnets --region ${region} \
        --filters "Name=vpc-id,Values=${vpcId}" "Name=tag:Name,Values=${subnetName}" \
        --query "Subnets[0].{SubnetId:SubnetId,CidrBlock:CidrBlock}" --output json`;

      const result = JSON.parse(execSync(cmd, { encoding: 'utf8' }));
      if (result && result.SubnetId) {
        return { subnetId: result.SubnetId, cidrBlock: result.CidrBlock };
      }
      return null;
    } catch (error) {
      console.log(`[ComputeSubnetManager] No existing compute subnet found: ${error.message}`);
      return null;
    }
  }

  /**
   * 创建 compute subnet
   * @param {string|null} instanceGroupName - 传入则创建该 IG 专属 subnet（命名 + dedicated tag）
   */
  static async createComputeSubnet(vpcId, availabilityZone, region, clusterName, instanceGroupName = null) {
    // 1. 获取可用的 CIDR
    const cidr = await this.getAvailableCidr(vpcId, region);
    console.log(`[ComputeSubnetManager] Using CIDR: ${cidr}`);

    // 2. 获取 AZ ID
    const azId = await this.getAzId(availabilityZone, region);

    // 3. 获取 NAT Gateway
    const natGwId = await this.getNatGateway(vpcId, region);

    // 4. 创建子网
    const subnetName = this.computeSubnetName(availabilityZone, instanceGroupName);
    // 专属 subnet 额外打 dedicated tag，便于删除 IG 时精确识别该删哪个 subnet
    const dedicatedTag = instanceGroupName
      ? `,{Key=hyperpod:dedicated-ig,Value=${instanceGroupName}}`
      : '';
    const createSubnetCmd = `aws ec2 create-subnet --region ${region} \
      --vpc-id ${vpcId} \
      --cidr-block ${cidr} \
      --availability-zone-id ${azId} \
      --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=${subnetName}},{Key=karpenter.sh/discovery,Value=${clusterName}}${dedicatedTag}]' \
      --query 'Subnet.SubnetId' --output text`;

    const subnetId = execSync(createSubnetCmd, { encoding: 'utf8' }).trim();
    console.log(`[ComputeSubnetManager] Created subnet: ${subnetId}`);

    // 5. 创建路由表
    const rtName = `${subnetName}-rt`;
    const createRtCmd = `aws ec2 create-route-table --region ${region} \
      --vpc-id ${vpcId} \
      --tag-specifications 'ResourceType=route-table,Tags=[{Key=Name,Value=${rtName}}]' \
      --query 'RouteTable.RouteTableId' --output text`;

    const routeTableId = execSync(createRtCmd, { encoding: 'utf8' }).trim();
    console.log(`[ComputeSubnetManager] Created route table: ${routeTableId}`);

    // 6. 关联路由表到子网
    execSync(`aws ec2 associate-route-table --region ${region} \
      --route-table-id ${routeTableId} --subnet-id ${subnetId}`, { encoding: 'utf8' });

    // 7. 添加默认路由到 NAT Gateway
    execSync(`aws ec2 create-route --region ${region} \
      --route-table-id ${routeTableId} \
      --destination-cidr-block 0.0.0.0/0 \
      --nat-gateway-id ${natGwId}`, { encoding: 'utf8' });
    console.log(`[ComputeSubnetManager] Added NAT Gateway route`);

    // 8. 配置 S3 VPC Endpoint
    await this.configureS3Endpoint(vpcId, routeTableId, region);

    return { subnetId, cidrBlock: cidr, routeTableId };
  }

  /**
   * 获取可用的 CIDR (/20)
   */
  static async getAvailableCidr(vpcId, region) {
    // 读取配置文件
    const config = this.loadCidrConfig();
    const TARGET_PREFIX = config.prefixLength;
    const cidrRange = config.cidrRange;

    // 获取 VPC CIDR
    const vpcCmd = `aws ec2 describe-vpcs --region ${region} --vpc-ids ${vpcId} \
      --query "Vpcs[0].CidrBlockAssociationSet[?CidrBlockState.State=='associated'].CidrBlock" --output text`;
    const vpcCidrs = execSync(vpcCmd, { encoding: 'utf8' }).trim().split(/\s+/);

    // 获取已存在的子网 CIDR
    const subnetCmd = `aws ec2 describe-subnets --region ${region} \
      --filters "Name=vpc-id,Values=${vpcId}" \
      --query "Subnets[*].CidrBlock" --output text`;
    const existingCidrs = execSync(subnetCmd, { encoding: 'utf8' }).trim().split(/\s+/).filter(c => c);

    const subnetSize = Math.pow(2, 32 - TARGET_PREFIX);

    // 如果指定了 cidrRange，只在该范围内搜索
    if (cidrRange) {
      const [rangeIp, rangePrefix] = cidrRange.split('/');
      const rangeStart = this.ipToInt(rangeIp);
      const rangeSize = Math.pow(2, 32 - parseInt(rangePrefix));
      const totalSlots = rangeSize / subnetSize;

      for (let i = 0; i < totalSlots; i++) {
        const candidateStart = rangeStart + i * subnetSize;
        const candidateCidr = `${this.intToIp(candidateStart)}/${TARGET_PREFIX}`;
        if (!this.cidrOverlaps(candidateCidr, existingCidrs)) {
          console.log(`[ComputeSubnetManager] Found CIDR ${candidateCidr} within configured range ${cidrRange}`);
          return candidateCidr;
        }
      }
      throw new Error(`No available /${TARGET_PREFIX} CIDR block found within configured range ${cidrRange}`);
    }

    // 无 cidrRange 约束，使用原逻辑：在 VPC CIDR 内搜索
    const sorted = vpcCidrs
      .map(c => { const [ip, p] = c.split('/'); return { cidr: c, base: this.ipToInt(ip), prefix: parseInt(p) }; })
      .filter(v => v.prefix <= TARGET_PREFIX)
      .sort((a, b) => a.prefix - b.prefix);

    if (sorted.length === 0) {
      throw new Error(`No VPC CIDR large enough to fit a /${TARGET_PREFIX} subnet (available: ${vpcCidrs.join(', ')})`);
    }

    for (const vpc of sorted) {
      const vpcSize = Math.pow(2, 32 - vpc.prefix);
      const totalSlots = vpcSize / subnetSize;
      for (let i = 1; i < totalSlots; i++) {
        const subnetStart = vpc.base + i * subnetSize;
        const subnetCidr = `${this.intToIp(subnetStart)}/${TARGET_PREFIX}`;
        if (!this.cidrOverlaps(subnetCidr, existingCidrs)) {
          return subnetCidr;
        }
      }
    }

    throw new Error(`No available /${TARGET_PREFIX} CIDR block found in VPC`);
  }

  /**
   * 读取 compute-subnet-cidr-config.json
   */
  static loadCidrConfig() {
    try {
      const configPath = path.join(__dirname, '../../config/compute-subnet-cidr-config.json');
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return {
        cidrRange: raw.computeSubnet?.cidrRange || null,
        prefixLength: raw.computeSubnet?.prefixLength || 20
      };
    } catch {
      return { cidrRange: null, prefixLength: 20 };
    }
  }

  /**
   * 获取 AZ ID
   */
  static async getAzId(availabilityZone, region) {
    const cmd = `aws ec2 describe-availability-zones --region ${region} \
      --query "AvailabilityZones[?ZoneName=='${availabilityZone}'].ZoneId" --output text`;
    const azId = execSync(cmd, { encoding: 'utf8' }).trim();
    if (!azId) {
      throw new Error(`Invalid availability zone: ${availabilityZone}`);
    }
    return azId;
  }

  /**
   * 获取 NAT Gateway
   */
  static async getNatGateway(vpcId, region) {
    const cmd = `aws ec2 describe-nat-gateways --region ${region} \
      --filter "Name=vpc-id,Values=${vpcId}" "Name=state,Values=available" \
      --query "NatGateways[0].NatGatewayId" --output text`;
    const natGwId = execSync(cmd, { encoding: 'utf8' }).trim();
    if (!natGwId || natGwId === 'None') {
      throw new Error(`No available NAT Gateway found in VPC: ${vpcId}`);
    }
    return natGwId;
  }

  /**
   * 配置 S3 VPC Endpoint
   */
  static async configureS3Endpoint(vpcId, routeTableId, region) {
    try {
      // 检查是否已存在
      const checkCmd = `aws ec2 describe-vpc-endpoints --region ${region} \
        --filters "Name=vpc-id,Values=${vpcId}" "Name=service-name,Values=com.amazonaws.${region}.s3" \
        --query "VpcEndpoints[0].VpcEndpointId" --output text`;
      const existingEndpoint = execSync(checkCmd, { encoding: 'utf8' }).trim();

      if (existingEndpoint && existingEndpoint !== 'None') {
        // 添加路由表到现有 endpoint
        execSync(`aws ec2 modify-vpc-endpoint --region ${region} \
          --vpc-endpoint-id ${existingEndpoint} \
          --add-route-table-ids ${routeTableId}`, { encoding: 'utf8', stdio: 'pipe' });
        console.log(`[ComputeSubnetManager] Added route table to existing S3 endpoint`);
      } else {
        // 创建新的 endpoint
        execSync(`aws ec2 create-vpc-endpoint --region ${region} \
          --vpc-id ${vpcId} \
          --service-name com.amazonaws.${region}.s3 \
          --route-table-ids ${routeTableId}`, { encoding: 'utf8' });
        console.log(`[ComputeSubnetManager] Created new S3 VPC endpoint`);
      }
    } catch (error) {
      console.log(`[ComputeSubnetManager] S3 endpoint config warning: ${error.message}`);
    }
  }

  static sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 等待 subnet 上的 ENI 排空（删 IG 后节点异步终止，ENI 残留时无法删 subnet）
   * @returns {Promise<boolean>} true=已排空, false=超时仍有 ENI
   */
  static async waitForSubnetEnisDrained(subnetId, region, { timeoutMs = 600000, intervalMs = 15000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const cmd = `aws ec2 describe-network-interfaces --region ${region} \
          --filters "Name=subnet-id,Values=${subnetId}" \
          --query "length(NetworkInterfaces)" --output text`;
        const count = parseInt(execSync(cmd, { encoding: 'utf8' }).trim(), 10);
        if (!count || count === 0) {
          return true;
        }
        console.log(`[ComputeSubnetManager] Subnet ${subnetId} still has ${count} ENI(s), waiting...`);
      } catch (error) {
        console.log(`[ComputeSubnetManager] ENI check failed (will retry): ${error.message}`);
      }
      await this.sleep(intervalMs);
    }
    return false;
  }

  /**
   * 删除某个 IG 的专属 compute subnet 及其配套资源（route table、S3 endpoint 关联）。
   * Best-effort：失败只记日志，不抛错。绝不删共享 subnet（无 dedicated tag 的一律跳过）。
   * @param {string} subnetId
   * @param {string} region
   */
  static async deleteDedicatedSubnet(subnetId, region) {
    try {
      // 安全校验：必须带 hyperpod:dedicated-ig tag，否则视为共享/外部 subnet，拒绝删除
      const tagCmd = `aws ec2 describe-subnets --region ${region} --subnet-ids ${subnetId} \
        --query "Subnets[0].Tags[?Key=='hyperpod:dedicated-ig'].Value | [0]" --output text`;
      const dedicatedTag = execSync(tagCmd, { encoding: 'utf8' }).trim();
      if (!dedicatedTag || dedicatedTag === 'None') {
        console.log(`[ComputeSubnetManager] Subnet ${subnetId} is not a dedicated subnet (no dedicated tag), skip deletion`);
        return { deleted: false, reason: 'not-dedicated' };
      }

      // 等待 ENI 排空
      const drained = await this.waitForSubnetEnisDrained(subnetId, region);
      if (!drained) {
        console.log(`[ComputeSubnetManager] Subnet ${subnetId} still has ENIs after timeout, leaving it (manual cleanup needed)`);
        return { deleted: false, reason: 'enis-remain' };
      }

      // 找到关联到该 subnet 的 route table
      const rtCmd = `aws ec2 describe-route-tables --region ${region} \
        --filters "Name=association.subnet-id,Values=${subnetId}" \
        --query "RouteTables[0].{RtId:RouteTableId,Assoc:Associations[?SubnetId=='${subnetId}'].RouteTableAssociationId | [0]}" \
        --output json`;
      let rtId = null, assocId = null;
      try {
        const rt = JSON.parse(execSync(rtCmd, { encoding: 'utf8' }));
        if (rt) { rtId = rt.RtId; assocId = rt.Assoc; }
      } catch { /* 无关联 RT，跳过 */ }

      if (rtId) {
        // 从 S3 VPC Endpoint 移除该 RT 关联（否则删 RT 可能受阻）
        try {
          const epCmd = `aws ec2 describe-vpc-endpoints --region ${region} \
            --filters "Name=route-table-id,Values=${rtId}" \
            --query "VpcEndpoints[0].VpcEndpointId" --output text`;
          const epId = execSync(epCmd, { encoding: 'utf8' }).trim();
          if (epId && epId !== 'None') {
            execSync(`aws ec2 modify-vpc-endpoint --region ${region} \
              --vpc-endpoint-id ${epId} --remove-route-table-ids ${rtId}`, { encoding: 'utf8', stdio: 'pipe' });
            console.log(`[ComputeSubnetManager] Removed RT ${rtId} from S3 endpoint ${epId}`);
          }
        } catch (error) {
          console.log(`[ComputeSubnetManager] S3 endpoint detach warning: ${error.message}`);
        }

        // 解除 RT 与 subnet 的关联
        if (assocId && assocId !== 'None') {
          try {
            execSync(`aws ec2 disassociate-route-table --region ${region} --association-id ${assocId}`, { encoding: 'utf8', stdio: 'pipe' });
          } catch (error) {
            console.log(`[ComputeSubnetManager] Disassociate RT warning: ${error.message}`);
          }
        }

        // 删除 RT
        try {
          execSync(`aws ec2 delete-route-table --region ${region} --route-table-id ${rtId}`, { encoding: 'utf8', stdio: 'pipe' });
          console.log(`[ComputeSubnetManager] Deleted route table ${rtId}`);
        } catch (error) {
          console.log(`[ComputeSubnetManager] Delete RT warning: ${error.message}`);
        }
      }

      // 删除 subnet
      execSync(`aws ec2 delete-subnet --region ${region} --subnet-id ${subnetId}`, { encoding: 'utf8', stdio: 'pipe' });
      console.log(`[ComputeSubnetManager] Deleted dedicated subnet ${subnetId} (ig=${dedicatedTag})`);
      return { deleted: true };
    } catch (error) {
      console.log(`[ComputeSubnetManager] deleteDedicatedSubnet failed for ${subnetId}: ${error.message}`);
      return { deleted: false, reason: error.message };
    }
  }

  // Helper: IP to integer (unsigned)
  static ipToInt(ip) {
    const parts = ip.split('.').map(Number);
    return ((parts[0] * 16777216) + (parts[1] * 65536) + (parts[2] * 256) + parts[3]) >>> 0;
  }

  // Helper: Integer to IP
  static intToIp(int) {
    return `${(int >>> 24) & 255}.${(int >>> 16) & 255}.${(int >>> 8) & 255}.${int & 255}`;
  }

  // Helper: Check CIDR overlap
  static cidrOverlaps(newCidr, existingCidrs) {
    const [newIp, newPrefix] = newCidr.split('/');
    const newStart = this.ipToInt(newIp);
    const newSize = Math.pow(2, 32 - parseInt(newPrefix));
    const newEnd = newStart + newSize - 1;

    for (const existing of existingCidrs) {
      const [existIp, existPrefix] = existing.split('/');
      const existStart = this.ipToInt(existIp);
      const existSize = Math.pow(2, 32 - parseInt(existPrefix));
      const existEnd = existStart + existSize - 1;

      if (newStart <= existEnd && newEnd >= existStart) {
        return true;
      }
    }
    return false;
  }
}

module.exports = ComputeSubnetManager;
