const { execSync } = require('child_process');
const { promisify } = require('util');
const exec = promisify(require('child_process').exec);

// Import existing subnet managers
const SubnetManager = require('./subnetManager');
const ComputeSubnetManager = require('./computeSubnetManager');
const CidrGenerator = require('./cidrGenerator');

/**
 * Network Manager
 * Unified manager for all network-related operations:
 * - Availability Zones
 * - Subnets (Public, Private, Compute)
 * - CIDR generation and validation
 * - VPC and Network configuration
 */
class NetworkManager {

  // ==================== Availability Zones ====================

  /**
   * Get all availability zones for a region
   * @param {string} region - AWS region
   * @returns {Object} { success, zones?, error? }
   */
  static async getAvailabilityZones(region) {
    if (!region) {
      return { success: false, error: 'Region parameter required' };
    }

    try {
      const command = `aws ec2 describe-availability-zones --region ${region} --query 'AvailabilityZones[*].{ZoneName:ZoneName,ZoneId:ZoneId}' --output json`;
      const result = execSync(command, { encoding: 'utf8' });
      const zones = JSON.parse(result);

      return { success: true, zones };
    } catch (error) {
      console.error('Error getting availability zones:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get AZ ID from AZ name
   * @param {string} availabilityZone - AZ name (e.g., us-west-2a)
   * @param {string} region - AWS region
   * @returns {string|null} AZ ID or null
   */
  static async getAzId(availabilityZone, region) {
    return ComputeSubnetManager.getAzId(availabilityZone, region);
  }

  // ==================== CIDR Operations ====================

  /**
   * Get VPC CIDR by VPC ID
   * @param {string} vpcId - VPC ID
   * @param {string} region - AWS region
   * @returns {Promise<string|null>} VPC CIDR or null
   */
  static async getVpcCidr(vpcId, region) {
    try {
      const command = `aws ec2 describe-vpcs --vpc-ids ${vpcId} --region ${region} --query "Vpcs[0].CidrBlock" --output text`;
      const result = execSync(command, { encoding: 'utf8' }).trim();
      return result && result !== 'None' ? result : null;
    } catch (error) {
      console.error(`Error getting VPC CIDR for ${vpcId}:`, error.message);
      return null;
    }
  }

  /**
   * Generate a unique VPC CIDR that doesn't conflict with existing VPCs
   * @param {string} region - AWS region
   * @param {string} excludeCidr - CIDR to exclude (optional)
   * @returns {Object} { success, cidr?, error? }
   */
  static async generateUniqueCidr(region, excludeCidr = null) {
    if (!region) {
      return { success: false, error: 'AWS region is required' };
    }

    try {
      const cidr = await CidrGenerator.generateUniqueCidr(region, excludeCidr);
      return {
        success: true,
        cidr,
        region,
        generatedAt: new Date().toISOString()
      };
    } catch (error) {
      console.error('Error generating CIDR:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Generate full CIDR configuration for VPC and subnets
   * @param {string} region - AWS region
   * @param {string} customVpcCidr - Custom VPC CIDR (optional)
   * @returns {Object} { success, ...cidrConfig?, error? }
   */
  static async generateCidrConfig(region, customVpcCidr = null) {
    if (!region) {
      return { success: false, error: 'AWS region is required' };
    }

    try {
      const cidrConfig = await CidrGenerator.generateFullCidrConfiguration(region, customVpcCidr);
      return { success: true, ...cidrConfig };
    } catch (error) {
      console.error('Error generating CIDR configuration:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Validate CIDR format and check for conflicts
   * @param {string} cidr - CIDR to validate
   * @param {string} region - AWS region
   * @returns {Object} { success, valid?, conflict?, error? }
   */
  static async validateCidr(cidr, region) {
    if (!cidr || !region) {
      return { success: false, error: 'CIDR and region are required' };
    }

    try {
      // Validate format
      const isValidFormat = CidrGenerator.validateCidrFormat(cidr);
      if (!isValidFormat) {
        return {
          success: false,
          valid: false,
          error: 'Invalid CIDR format'
        };
      }

      // Check conflict
      const hasConflict = await CidrGenerator.checkCidrConflict(cidr, region);

      return {
        success: true,
        valid: !hasConflict,
        conflict: hasConflict,
        message: hasConflict ? 'CIDR conflicts with existing VPC' : 'CIDR is available'
      };
    } catch (error) {
      console.error('Error validating CIDR:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get all existing VPC CIDRs in a region
   * @param {string} region - AWS region
   * @returns {string[]} Array of CIDR strings
   */
  static async getExistingVpcCidrs(region) {
    return CidrGenerator.getExistingVpcCidrs(region);
  }

  // ==================== Subnet Operations ====================

  /**
   * Ensure a public subnet exists in the specified AZ (create if not exists)
   * @param {Object} config - { vpcId, availabilityZone, clusterTag, region }
   * @returns {Object} { subnetId, subnetName, routeTableId, cidrBlock?, created }
   */
  static async ensurePublicSubnet(config) {
    return SubnetManager.ensurePublicSubnet(config);
  }

  /**
   * Ensure a compute subnet exists in the specified AZ (create if not exists)
   * Used for EKS Node Groups and HyperPod Instance Groups
   * @param {string} vpcId - VPC ID
   * @param {string} availabilityZone - AZ name
   * @param {string} region - AWS region
   * @param {string} clusterName - EKS cluster name (for karpenter discovery tag)
   * @param {boolean} newSubnet - if true, always create a fresh independent subnet (hp-compute-{yymmdd}-{az}-{hash})
   * @returns {Object} { subnetId, created }
   */
  static async ensureComputeSubnet(vpcId, availabilityZone, region, clusterName, newSubnet = false) {
    return ComputeSubnetManager.ensureComputeSubnet(vpcId, availabilityZone, region, clusterName, newSubnet);
  }

  /**
   * Find existing shared compute subnet in specified AZ (hp-compute-{az})
   * @param {string} vpcId - VPC ID
   * @param {string} availabilityZone - AZ name
   * @param {string} region - AWS region
   * @returns {Object|null} { subnetId, cidrBlock } or null
   */
  static async findComputeSubnet(vpcId, availabilityZone, region) {
    return ComputeSubnetManager.findComputeSubnet(vpcId, availabilityZone, region);
  }

  /**
   * Check if a public subnet exists in specified AZ
   * @param {string} vpcId - VPC ID
   * @param {string} availabilityZone - AZ name
   * @param {string} region - AWS region
   * @returns {Object} { exists, subnetId?, subnetName?, routeTableId? }
   */
  static async checkPublicSubnetInAZ(vpcId, availabilityZone, region) {
    return SubnetManager.checkPublicSubnetInAZ(vpcId, availabilityZone, region);
  }

  /**
   * Get the public route table (with IGW route) for a VPC
   * @param {string} vpcId - VPC ID
   * @param {string} region - AWS region
   * @returns {string|null} Route Table ID or null
   */
  static async getPublicRouteTable(vpcId, region) {
    return SubnetManager.getPublicRouteTable(vpcId, region);
  }

  /**
   * Get NAT Gateway for a VPC
   * @param {string} vpcId - VPC ID
   * @param {string} region - AWS region
   * @returns {string} NAT Gateway ID
   */
  static async getNatGateway(vpcId, region) {
    return ComputeSubnetManager.getNatGateway(vpcId, region);
  }

  /**
   * Get detailed subnet info for a VPC
   * Includes public and private subnets with metadata
   * @param {string} vpcId - VPC ID
   * @param {string} region - AWS region
   * @returns {Object} { publicSubnets: [], privateSubnets: [] }
   */
  static async getSubnetInfo(vpcId, region) {
    const CloudFormationManager = require('./cloudFormationManager');
    return CloudFormationManager.fetchSubnetInfo(vpcId, region);
  }

  /**
   * Get subnet's availability zone
   * @param {string} subnetId - Subnet ID
   * @returns {string|null} AZ name or null
   */
  static getSubnetAvailabilityZone(subnetId) {
    try {
      const cmd = `aws ec2 describe-subnets --subnet-ids ${subnetId} --query "Subnets[0].AvailabilityZone" --output text`;
      const az = execSync(cmd, { encoding: 'utf8', timeout: 10000 }).trim();
      return az && az !== 'None' ? az : null;
    } catch (error) {
      console.error(`Error getting subnet AZ: ${error.message}`);
      return null;
    }
  }

  // ==================== VPC Operations ====================

  /**
   * Get VPC CIDR blocks
   * @param {string} vpcId - VPC ID
   * @param {string} region - AWS region
   * @returns {string[]} Array of CIDR blocks
   */
  static async getVpcCidrs(vpcId, region) {
    try {
      const cmd = `aws ec2 describe-vpcs --region ${region} --vpc-ids ${vpcId} --query "Vpcs[0].CidrBlockAssociationSet[?CidrBlockState.State=='associated'].CidrBlock" --output json`;
      const result = execSync(cmd, { encoding: 'utf8' });
      return JSON.parse(result);
    } catch (error) {
      console.error('Error getting VPC CIDRs:', error);
      return [];
    }
  }

  /**
   * Get all subnets in a VPC
   * @param {string} vpcId - VPC ID
   * @param {string} region - AWS region
   * @returns {Object[]} Array of subnet info
   */
  static async getAllVpcSubnets(vpcId, region) {
    try {
      const cmd = `aws ec2 describe-subnets --region ${region} --filters "Name=vpc-id,Values=${vpcId}" --query "Subnets[*].{SubnetId:SubnetId,CidrBlock:CidrBlock,AvailabilityZone:AvailabilityZone,MapPublicIpOnLaunch:MapPublicIpOnLaunch}" --output json`;
      const result = execSync(cmd, { encoding: 'utf8' });
      return JSON.parse(result);
    } catch (error) {
      console.error('Error getting VPC subnets:', error);
      return [];
    }
  }

  // ==================== Utility Functions ====================

  /**
   * Check if two CIDRs overlap
   * @param {string} cidr1 - First CIDR
   * @param {string} cidr2 - Second CIDR
   * @returns {boolean} True if overlapping
   */
  static cidrOverlaps(cidr1, cidr2) {
    return ComputeSubnetManager.cidrOverlaps(cidr1, [cidr2]);
  }

  /**
   * Convert IP string to integer
   * @param {string} ip - IP address string
   * @returns {number} Integer representation
   */
  static ipToInt(ip) {
    return ComputeSubnetManager.ipToInt(ip);
  }

  /**
   * Convert integer to IP string
   * @param {number} int - Integer value
   * @returns {string} IP address string
   */
  static intToIp(int) {
    return ComputeSubnetManager.intToIp(int);
  }

  /**
   * Validate CIDR format
   * @param {string} cidr - CIDR string
   * @returns {boolean} True if valid
   */
  static validateCidrFormat(cidr) {
    return CidrGenerator.validateCidrFormat(cidr);
  }

  // ==================== Constants ====================

  /**
   * Get compute subnet naming prefix
   */
  static get COMPUTE_SUBNET_PREFIX() {
    return ComputeSubnetManager.SUBNET_PREFIX;
  }
}

module.exports = NetworkManager;
