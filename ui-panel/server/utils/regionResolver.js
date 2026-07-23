/**
 * regionResolver — 生命周期安全的 region 解析器
 *
 * 背景:本项目 region 有两套权威。
 *   A 轨(主机)  : awsHelpers.getCurrentRegion() —— env → aws configure → EC2 IMDS,返回本机 region。
 *   B 轨(每集群): metadataUtils.getClusterRegion(tag) —— 读 cluster_info.json 里的 region。
 *
 * 运维路径应以"活跃集群的 region"(B 轨)为主,A 轨仅作兜底。
 *
 * getEffectiveRegion(clusterTag):
 *   - 传入 clusterTag  → 该集群的 region
 *   - 未传 clusterTag  → 当前活跃集群的 region
 *   - 上述都拿不到      → getCurrentRegion() 主机兜底
 *
 * 动线约束:创建 EKS 时 cluster_info.json 尚不存在、也可能没有活跃集群,
 * 此时本函数会安全回退到主机 region,绝不抛异常、绝不假设 per-cluster 元数据存在。
 * 因此创建路径可放心不使用本解析器(继续用用户输入的 awsRegion),而运维路径统一走它。
 *
 * 使用惰性 require 以避免与 clusterManager / metadataUtils 之间潜在的循环依赖。
 */

function getEffectiveRegion(clusterTag) {
  try {
    const ClusterManager = require('../clusterManager');
    const MetadataUtils = require('./metadataUtils');
    const tag = clusterTag || new ClusterManager().getActiveCluster();
    if (tag) {
      const region = MetadataUtils.getClusterRegion(tag);
      if (region) return region;
    }
  } catch (e) {
    // per-cluster 解析失败(无活跃集群 / 元数据缺失等)→ 落到主机兜底
    console.warn(`getEffectiveRegion: per-cluster resolution failed, falling back to host region: ${e.message}`);
  }
  return require('./awsHelpers').getCurrentRegion();
}

module.exports = { getEffectiveRegion };
