const { execSync } = require('child_process');

/**
 * HyperPod Karpenter 资源管理器
 * 管理 HyperpodNodeClass 和关联的 NodePool
 */
class HyperPodKarpenterManager {
  
  /**
   * 获取所有 HyperPod Karpenter 资源
   */
  static async getHyperPodKarpenterResources() {
    try {
      // 获取所有 HyperpodNodeClass
      const nodeClassesCmd = 'kubectl get hyperpodnodeclass -o json';
      const nodeClassesOutput = execSync(nodeClassesCmd, { encoding: 'utf8' });
      const nodeClassesData = JSON.parse(nodeClassesOutput);

      // 获取所有 NodePool
      const nodePoolsCmd = 'kubectl get nodepool -o json';
      const nodePoolsOutput = execSync(nodePoolsCmd, { encoding: 'utf8' });
      const nodePoolsData = JSON.parse(nodePoolsOutput);

      // 过滤出使用 HyperpodNodeClass 的 NodePool
      const hyperpodNodePools = nodePoolsData.items.filter(np => 
        np.spec?.template?.spec?.nodeClassRef?.kind === 'HyperpodNodeClass'
      );

      // 解析 NodePool 数据
      const nodePools = hyperpodNodePools.map(np => {
        const nodeClassRef = np.spec.template.spec.nodeClassRef?.name;
        
        return {
          name: np.metadata.name,
          nodeClassRef: nodeClassRef,
          weight: np.spec.weight,
          status: np.status?.conditions?.find(c => c.type === 'Ready')?.status === 'True' ? 'Ready' : 'NotReady',
          creationTimestamp: np.metadata.creationTimestamp
        };
      });

      // 解析 HyperpodNodeClass 数据
      const nodeClasses = nodeClassesData.items.map(nc => {
        const instanceGroups = nc.spec?.instanceGroups || [];
        const statusInstanceGroups = nc.status?.instanceGroups || [];
        
        // 获取第一个 instance group 的详细信息
        const firstIG = statusInstanceGroups[0] || {};
        const instanceTypes = firstIG.instanceTypes || [];
        const capacity = firstIG.capacity || {};
        const capacityType = capacity.spot ? 'spot' : 'on-demand';
        const subnets = firstIG.subnets || [];

        return {
          name: nc.metadata.name,
          instanceGroups: instanceGroups,
          instanceTypes: instanceTypes,
          capacityType: capacityType,
          subnets: subnets.map(s => s.id),
          status: nc.status?.conditions?.find(c => c.type === 'Ready')?.status === 'True' ? 'Ready' : 'NotReady'
        };
      });

      // 收集所有被 Karpenter 管理的 Instance Groups
      const managedInstanceGroups = [...new Set(
        nodeClasses.flatMap(nc => nc.instanceGroups)
      )];

      return {
        nodePools: nodePools,
        nodeClasses: nodeClasses,
        managedInstanceGroups: managedInstanceGroups
      };

    } catch (error) {
      // 如果是 CRD 不存在（Karpenter 未安装），静默返回空数据
      if (error.message.includes('the server doesn\'t have a resource type') ||
          error.message.includes('NotFound')) {
        return {
          nodePools: [],
          nodeClasses: [],
          managedInstanceGroups: []
        };
      }

      // 其他错误记录详细信息
      console.error('Failed to get HyperPod Karpenter resources:', error.message);
      return {
        nodePools: [],
        nodeClasses: [],
        managedInstanceGroups: []
      };
    }
  }

  /**
   * 删除 HyperPod Karpenter NodePool
   */
  static async deleteNodePool(nodePoolName) {
    try {
      // 1. 获取 NodePool 信息，找到关联的 HyperpodNodeClass
      const getNodePoolCmd = `kubectl get nodepool ${nodePoolName} -o json`;
      const nodePoolOutput = execSync(getNodePoolCmd, { encoding: 'utf8' });
      const nodePoolData = JSON.parse(nodePoolOutput);
      
      const nodeClassRef = nodePoolData.spec?.template?.spec?.nodeClassRef?.name;
      
      // 2. 删除 NodePool
      const deleteNodePoolCmd = `kubectl delete nodepool ${nodePoolName}`;
      execSync(deleteNodePoolCmd, { encoding: 'utf8' });
      console.log(`NodePool ${nodePoolName} deleted successfully`);
      
      // 3. 如果有关联的 HyperpodNodeClass，也删除它
      if (nodeClassRef) {
        try {
          const deleteNodeClassCmd = `kubectl delete hyperpodnodeclass ${nodeClassRef}`;
          execSync(deleteNodeClassCmd, { encoding: 'utf8' });
          console.log(`Associated HyperpodNodeClass ${nodeClassRef} deleted successfully`);
          return { 
            success: true, 
            message: `NodePool ${nodePoolName} and HyperpodNodeClass ${nodeClassRef} deleted successfully` 
          };
        } catch (ncError) {
          console.warn(`Failed to delete HyperpodNodeClass ${nodeClassRef}:`, ncError.message);
          return { 
            success: true, 
            message: `NodePool ${nodePoolName} deleted, but failed to delete HyperpodNodeClass ${nodeClassRef}` 
          };
        }
      }
      
      return { success: true, message: `NodePool ${nodePoolName} deleted successfully` };
    } catch (error) {
      console.error('Failed to delete NodePool:', error.message);
      throw new Error(`Failed to delete NodePool: ${error.message}`);
    }
  }

  /**
   * 删除 HyperpodNodeClass
   */
  static async deleteNodeClass(nodeClassName) {
    try {
      const deleteCmd = `kubectl delete hyperpodnodeclass ${nodeClassName}`;
      execSync(deleteCmd, { encoding: 'utf8' });
      return { success: true, message: `HyperpodNodeClass ${nodeClassName} deleted successfully` };
    } catch (error) {
      console.error('Failed to delete HyperpodNodeClass:', error.message);
      throw new Error(`Failed to delete HyperpodNodeClass: ${error.message}`);
    }
  }

  /**
   * 创建 HyperPod Karpenter 资源（NodeClass + NodePool）
   */
  static async createHyperPodKarpenterResource(instanceGroups) {
    try {
      // 使用第一个 instance group 作为基础名称
      const baseName = instanceGroups[0];
      const nodeClassName = `${baseName}-nodeclass`;
      const nodePoolName = `${baseName}-nodepool`;

      // 1. 创建 HyperpodNodeClass
      const nodeClassYaml = `
apiVersion: karpenter.sagemaker.amazonaws.com/v1
kind: HyperpodNodeClass
metadata:
  name: ${nodeClassName}
spec:
  instanceGroups:
${instanceGroups.map(ig => `    - ${ig}`).join('\n')}
`;

      const createNodeClassCmd = `kubectl apply -f - <<EOF
${nodeClassYaml}
EOF`;
      
      execSync(createNodeClassCmd, { encoding: 'utf8', shell: '/bin/bash' });
      console.log(`HyperpodNodeClass ${nodeClassName} created`);

      // 2. 等待 NodeClass 就绪
      await new Promise(resolve => setTimeout(resolve, 5000));

      // 3. 创建 NodePool
      const nodePoolYaml = `
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: ${nodePoolName}
spec:
  template:
    spec:
      nodeClassRef:
        group: karpenter.sagemaker.amazonaws.com
        kind: HyperpodNodeClass
        name: ${nodeClassName}
      expireAfter: Never
      requirements:
        - key: node.kubernetes.io/instance-type
          operator: Exists
`;

      const createNodePoolCmd = `kubectl apply -f - <<EOF
${nodePoolYaml}
EOF`;

      execSync(createNodePoolCmd, { encoding: 'utf8', shell: '/bin/bash' });
      console.log(`NodePool ${nodePoolName} created`);

      return {
        success: true,
        message: 'HyperPod Karpenter resource created successfully',
        nodeClassName: nodeClassName,
        nodePoolName: nodePoolName
      };

    } catch (error) {
      console.error('Failed to create HyperPod Karpenter resource:', error.message);
      throw new Error(`Failed to create resource: ${error.message}`);
    }
  }

  /**
   * 获取指定 instance group 的 NodeClaim 列表
   */
  static async getNodeClaimsByInstanceGroup(instanceGroupName) {
    try {
      // 先找到包含该 instance group 的 NodeClass
      const resources = await this.getHyperPodKarpenterResources();
      const nodeClass = resources.nodeClasses.find(nc => nc.instanceGroups.includes(instanceGroupName));
      if (!nodeClass) return [];

      const output = execSync('kubectl get nodeclaim -o json', { encoding: 'utf8' });
      const data = JSON.parse(output);

      return data.items
        .filter(nc => nc.metadata?.labels?.['karpenter.sagemaker.amazonaws.com/hyperpodnodeclass'] === nodeClass.name)
        .map(nc => ({
          name: nc.metadata.name,
          nodeName: nc.status?.nodeName || '-',
          instanceType: nc.metadata?.labels?.['node.kubernetes.io/instance-type'] || '-',
          zone: nc.metadata?.labels?.['topology.kubernetes.io/zone'] || '-',
          ready: nc.status?.conditions?.find(c => c.type === 'Ready')?.status === 'True',
          drifted: nc.status?.conditions?.find(c => c.type === 'Drifted')?.status === 'True',
          age: nc.metadata.creationTimestamp,
          nodePool: nc.metadata?.labels?.['karpenter.sh/nodepool'] || '-'
        }));
    } catch (error) {
      if (error.message.includes("doesn't have a resource type")) return [];
      console.error('Failed to get NodeClaims:', error.message);
      return [];
    }
  }

  /**
   * 删除 NodeClaim（触发 drain + 节点回收）
   */
  static async deleteNodeClaim(nodeClaimName) {
    try {
      execSync(`kubectl delete nodeclaim ${nodeClaimName}`, { encoding: 'utf8' });
      return { success: true, message: `NodeClaim ${nodeClaimName} deleted. Node will be drained and removed.` };
    } catch (error) {
      throw new Error(`Failed to delete NodeClaim: ${error.message}`);
    }
  }
}

module.exports = HyperPodKarpenterManager;
