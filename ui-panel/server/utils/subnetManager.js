const { execAsync: exec } = require('./exec');

class SubnetManager {
  
  /**
   * 检查指定 AZ 是否存在 Public Subnet
   * @param {string} vpcId - VPC ID
   * @param {string} availabilityZone - 可用区名称 (如 us-west-2a)
   * @param {string} region - AWS 区域
   * @returns {Promise<Object>} { exists: boolean, subnetId: string|null, routeTableId: string|null }
   */
  static async checkPublicSubnetInAZ(vpcId, availabilityZone, region) {
    try {
      // 查询该 AZ 中的所有子网
      const cmd = `aws ec2 describe-subnets \
        --filters "Name=vpc-id,Values=${vpcId}" "Name=availability-zone,Values=${availabilityZone}" \
        --query "Subnets[*].[SubnetId,MapPublicIpOnLaunch,Tags[?Key=='Name'].Value|[0]]" \
        --region ${region} \
        --output json`;
      
      const result = await exec(cmd);
      const subnets = JSON.parse(result.stdout);
      
      // 查找 Public Subnet (MapPublicIpOnLaunch = true)
      const publicSubnet = subnets.find(s => s[1] === true);
      
      if (publicSubnet) {
        const subnetId = publicSubnet[0];
        
        // 获取关联的路由表
        const rtCmd = `aws ec2 describe-route-tables \
          --filters "Name=association.subnet-id,Values=${subnetId}" \
          --query "RouteTables[0].RouteTableId" \
          --region ${region} \
          --output text`;
        
        const rtResult = await exec(rtCmd);
        const routeTableId = rtResult.stdout.trim();
        
        return {
          exists: true,
          subnetId: subnetId,
          subnetName: publicSubnet[2] || null,
          routeTableId: routeTableId !== 'None' ? routeTableId : null
        };
      }
      
      return { exists: false, subnetId: null, routeTableId: null };
      
    } catch (error) {
      console.error(`Error checking public subnet in AZ ${availabilityZone}:`, error);
      throw error;
    }
  }
  
  /**
   * 获取下一个可用的 Public Subnet 编号
   * 基于项目标准命名模式: {clusterTag}-SMHP-Public{N}
   * 如果没有符合模式的子网，从 1 开始
   * @param {string} vpcId - VPC ID
   * @param {string} clusterTag - 集群标识
   * @param {string} region - AWS 区域
   * @returns {Promise<number>} 下一个可用的编号
   */
  static async getNextPublicSubnetNumber(vpcId, clusterTag, region) {
    try {
      // 查询所有 Public Subnet
      const cmd = `aws ec2 describe-subnets \
        --filters "Name=vpc-id,Values=${vpcId}" "Name=map-public-ip-on-launch,Values=true" \
        --query "Subnets[*].Tags[?Key=='Name'].Value|[0]" \
        --region ${region} \
        --output json`;
      
      const result = await exec(cmd);
      const subnetNames = JSON.parse(result.stdout).flat().filter(Boolean);
      
      // 提取编号: hypd-1031-3706-SMHP-Public1 -> 1
      const pattern = new RegExp(`${clusterTag}-SMHP-Public(\\d+)`);
      const numbers = subnetNames
        .map(name => {
          const match = name.match(pattern);
          return match ? parseInt(match[1]) : 0;
        })
        .filter(n => n > 0);
      
      // 如果找到符合模式的子网，返回最大编号 + 1；否则从 1 开始
      const nextNumber = numbers.length > 0 ? Math.max(...numbers) + 1 : 1;
      console.log(`ℹ️ Next public subnet number: ${nextNumber} (found ${numbers.length} existing subnets)`);
      
      return nextNumber;
      
    } catch (error) {
      console.error('Error getting next public subnet number:', error);
      return 1; // 默认从 1 开始
    }
  }
  
  /**
   * 检测现有 Public Subnet 的网段大小模式
   * @param {string} vpcId - VPC ID
   * @param {string} region - AWS 区域
   * @returns {Promise<number>} 网段大小 (如 24 表示 /24)，默认 24
   */
  static async detectPublicSubnetMask(vpcId, region) {
    try {
      const cmd = `aws ec2 describe-subnets \
        --filters "Name=vpc-id,Values=${vpcId}" "Name=map-public-ip-on-launch,Values=true" \
        --query "Subnets[*].CidrBlock" \
        --region ${region} \
        --output json`;
      
      const result = await exec(cmd);
      const cidrs = JSON.parse(result.stdout);
      
      if (cidrs.length === 0) {
        console.log('ℹ️ No existing public subnets, using default /24 mask');
        return 24;
      }
      
      // 提取第一个子网的掩码
      const [, mask] = cidrs[0].split('/');
      const maskSize = parseInt(mask);
      
      console.log(`ℹ️ Detected public subnet mask: /${maskSize} (from ${cidrs[0]})`);
      return maskSize;
      
    } catch (error) {
      console.error('Error detecting subnet mask:', error);
      return 24; // 默认 /24
    }
  }
  
  /**
   * 生成下一个可用的 Public Subnet CIDR
   * 自动检测现有 Public Subnet 的网段大小（/20 或 /24）
   * @param {string} vpcId - VPC ID
   * @param {string} region - AWS 区域
   * @returns {Promise<string>} 可用的 CIDR 块
   */
  static async generateNextPublicSubnetCIDR(vpcId, region) {
    try {
      // 1. 获取 VPC CIDR
      const vpcCmd = `aws ec2 describe-vpcs \
        --vpc-ids ${vpcId} \
        --query "Vpcs[0].CidrBlock" \
        --region ${region} \
        --output text`;
      
      const vpcCidr = (await exec(vpcCmd)).stdout.trim();
      const [vpcBase] = vpcCidr.split('/');
      const [octet1, octet2] = vpcBase.split('.');
      
      // 2. 检测现有 Public Subnet 的网段大小
      const maskSize = await this.detectPublicSubnetMask(vpcId, region);
      
      // 3. 获取所有已使用的子网 CIDR（转为 Set 便于快速查找）
      const subnetsCmd = `aws ec2 describe-subnets \
        --filters "Name=vpc-id,Values=${vpcId}" \
        --query "Subnets[*].CidrBlock" \
        --region ${region} \
        --output json`;
      
      const usedCidrs = new Set(JSON.parse((await exec(subnetsCmd)).stdout));
      
      // 4. 根据网段大小生成候选 CIDR
      if (maskSize === 24) {
        // /24 网段：递增第三个八位组
        for (let octet3 = 10; octet3 < 256; octet3++) {
          const candidateCidr = `${octet1}.${octet2}.${octet3}.0/24`;
          
          if (!usedCidrs.has(candidateCidr)) {
            console.log(`✅ Generated available CIDR: ${candidateCidr}`);
            return candidateCidr;
          }
        }
      } else if (maskSize === 20) {
        // /20 网段：第三个八位组必须是 16 的倍数 (0, 16, 32, 48, ...)
        for (let octet3 = 0; octet3 < 256; octet3 += 16) {
          const candidateCidr = `${octet1}.${octet2}.${octet3}.0/20`;
          
          if (!usedCidrs.has(candidateCidr)) {
            console.log(`✅ Generated available CIDR: ${candidateCidr}`);
            return candidateCidr;
          }
        }
      } else {
        // 其他网段大小：使用 /24 作为 fallback
        console.warn(`⚠️ Unusual subnet mask /${maskSize}, using /24 as fallback`);
        for (let octet3 = 10; octet3 < 256; octet3++) {
          const candidateCidr = `${octet1}.${octet2}.${octet3}.0/24`;
          
          if (!usedCidrs.has(candidateCidr)) {
            console.log(`✅ Generated available CIDR: ${candidateCidr}`);
            return candidateCidr;
          }
        }
      }
      
      throw new Error('No available CIDR blocks found in VPC range');
      
    } catch (error) {
      console.error('Error generating public subnet CIDR:', error);
      throw error;
    }
  }
  
  /**
   * 获取 VPC 的 Public Route Table (有 IGW 路由的路由表)
   * @param {string} vpcId - VPC ID
   * @param {string} region - AWS 区域
   * @returns {Promise<string|null>} Route Table ID
   */
  static async getPublicRouteTable(vpcId, region) {
    try {
      // 查找有 0.0.0.0/0 -> igw-* 路由的路由表
      // 使用两步查询避免 starts_with() 处理 null 值的问题
      const cmd = `aws ec2 describe-route-tables \
        --filters "Name=vpc-id,Values=${vpcId}" \
        --region ${region} \
        --output json`;
      
      const result = await exec(cmd);
      const routeTables = JSON.parse(result.stdout).RouteTables;
      
      // 在 JS 中过滤，找到有 IGW 路由的路由表
      const publicRouteTable = routeTables.find(rt => {
        return rt.Routes.some(route => 
          route.DestinationCidrBlock === '0.0.0.0/0' && 
          route.GatewayId && 
          route.GatewayId.startsWith('igw-')
        );
      });
      
      if (!publicRouteTable) {
        console.error('❌ No public route table found (no route to Internet Gateway)');
        return null;
      }
      
      const routeTableId = publicRouteTable.RouteTableId;
      console.log(`✅ Found public route table: ${routeTableId}`);
      
      return routeTableId;
      
    } catch (error) {
      console.error('Error getting public route table:', error);
      throw error;
    }
  }
  
  /**
   * 创建 Public Subnet
   * @param {Object} config - 配置对象
   * @param {string} config.vpcId - VPC ID
   * @param {string} config.cidrBlock - CIDR 块 (如 10.90.13.0/24)
   * @param {string} config.availabilityZone - 可用区名称
   * @param {string} config.subnetName - 子网名称
   * @param {string} config.region - AWS 区域
   * @returns {Promise<string>} 创建的 Subnet ID
   */
  static async createPublicSubnet(config) {
    const { vpcId, cidrBlock, availabilityZone, subnetName, region } = config;
    
    try {
      // 创建子网
      const createCmd = `aws ec2 create-subnet \
        --vpc-id ${vpcId} \
        --cidr-block ${cidrBlock} \
        --availability-zone ${availabilityZone} \
        --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=${subnetName}},{Key=kubernetes.io/role/elb,Value=1}]' \
        --region ${region} \
        --output json`;
      
      const createResult = await exec(createCmd);
      const subnet = JSON.parse(createResult.stdout);
      const subnetId = subnet.Subnet.SubnetId;
      
      console.log(`✅ Created public subnet: ${subnetId} (${subnetName}) in ${availabilityZone}`);
      
      // 启用自动分配公网 IP
      const modifyCmd = `aws ec2 modify-subnet-attribute \
        --subnet-id ${subnetId} \
        --map-public-ip-on-launch \
        --region ${region}`;
      
      await exec(modifyCmd);
      console.log(`✅ Enabled auto-assign public IP for subnet: ${subnetId}`);
      
      return subnetId;
      
    } catch (error) {
      console.error('Error creating public subnet:', error);
      throw error;
    }
  }
  
  /**
   * 关联子网到路由表
   * @param {string} subnetId - Subnet ID
   * @param {string} routeTableId - Route Table ID
   * @param {string} region - AWS 区域
   * @returns {Promise<void>}
   */
  static async associateRouteTable(subnetId, routeTableId, region) {
    try {
      const cmd = `aws ec2 associate-route-table \
        --subnet-id ${subnetId} \
        --route-table-id ${routeTableId} \
        --region ${region}`;
      
      await exec(cmd);
      console.log(`✅ Associated subnet ${subnetId} with route table ${routeTableId}`);
      
    } catch (error) {
      console.error('Error associating route table:', error);
      throw error;
    }
  }
  
  /**
   * 确保指定 AZ 有 Public Subnet（如果没有则创建）
   * @param {Object} config - 配置对象
   * @param {string} config.vpcId - VPC ID
   * @param {string} config.availabilityZone - 可用区名称
   * @param {string} config.clusterTag - 集群标识（用于命名）
   * @param {string} config.region - AWS 区域
   * @returns {Promise<Object>} { subnetId: string, created: boolean, subnetName: string, cidrBlock: string, routeTableId: string }
   */
  static async ensurePublicSubnet(config) {
    const { vpcId, availabilityZone, clusterTag, region } = config;
    
    console.log(`\n🔍 Checking public subnet in ${availabilityZone}...`);
    
    // 1. 检查是否已存在
    const checkResult = await this.checkPublicSubnetInAZ(vpcId, availabilityZone, region);
    
    if (checkResult.exists) {
      console.log(`✅ Public subnet already exists in ${availabilityZone}: ${checkResult.subnetId} (${checkResult.subnetName})`);
      return {
        subnetId: checkResult.subnetId,
        subnetName: checkResult.subnetName,
        routeTableId: checkResult.routeTableId,
        created: false
      };
    }
    
    console.log(`⚠️ No public subnet found in ${availabilityZone}, creating one...`);
    
    // 2. 获取 Public Route Table（验证 IGW 存在）
    const routeTableId = await this.getPublicRouteTable(vpcId, region);
    
    if (!routeTableId) {
      throw new Error(`No public route table found in VPC ${vpcId}. Please ensure VPC has an Internet Gateway.`);
    }
    
    // 3. 生成 CIDR 和子网名称
    const cidrBlock = await this.generateNextPublicSubnetCIDR(vpcId, region);
    const subnetNumber = await this.getNextPublicSubnetNumber(vpcId, clusterTag, region);
    const subnetName = `${clusterTag}-SMHP-Public${subnetNumber}`;
    
    console.log(`📋 Creating subnet: ${subnetName} with CIDR: ${cidrBlock}`);
    
    // 4. 创建 Public Subnet
    const subnetId = await this.createPublicSubnet({
      vpcId,
      cidrBlock,
      availabilityZone,
      subnetName,
      region
    });
    
    // 5. 关联到 Public Route Table
    await this.associateRouteTable(subnetId, routeTableId, region);
    
    console.log(`✅ Public subnet setup completed: ${subnetId}\n`);
    
    return {
      subnetId,
      subnetName,
      routeTableId,
      cidrBlock,
      created: true
    };
  }
}

module.exports = SubnetManager;
