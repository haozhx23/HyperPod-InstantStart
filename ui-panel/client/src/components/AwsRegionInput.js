import React from 'react';
import { AutoComplete } from 'antd';

// 与后端 server/utils/validateInput.js 的 isAwsRegion 同一形状：拒绝 AZ 名（us-west-2c）和大写。
export const AWS_REGION_PATTERN = /^[a-z]{2,4}(-[a-z]+)+-\d{1,2}$/;

// 下拉建议 = cli-min 模板（1-eks-full-stack.yaml / 2-hypd-full.yaml）AssetS3Buckets 覆盖的 region。
// 在面板里创建 EKS 或给集群加 HyperPod 只支持这些 region；只导入已有集群时可以手输其他 region。
const SUGGESTED_REGIONS = [
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'ca-central-1', 'sa-east-1',
  'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1', 'eu-north-1',
  'ap-south-1', 'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3',
  'ap-southeast-1', 'ap-southeast-2',
];

export const awsRegionRules = (requiredMessage = 'Please enter AWS region') => [
  { required: true, message: requiredMessage },
  { pattern: AWS_REGION_PATTERN, message: 'Not a valid AWS Region (e.g. us-east-1, not an Availability Zone)' },
];

/**
 * AWS region 输入：带建议列表的 AutoComplete，可以手输列表外的 region。
 * 作为 Form.Item 的直接子元素使用，value / onChange 由 Form.Item 注入。
 */
const AwsRegionInput = (props) => (
  <AutoComplete
    options={SUGGESTED_REGIONS.map(r => ({ value: r }))}
    filterOption={(input, option) => option.value.includes((input || '').trim())}
    placeholder="e.g. us-east-1"
    {...props}
  />
);

export default AwsRegionInput;
