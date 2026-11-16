# Workspace IAM permissions

The EC2 workspace template uses three inline policies for InstantStart deployment and operations instead of attaching the AWS managed `AdministratorAccess` policy. The policy is designed to preserve the platform's existing workflows, including provisioning, importing clusters, configuring dependencies, storage selection, MLflow and node diagnostics.

This is a privileged deployment role with permissions limited to selected services and IAM operations. It is not a strict least-privilege policy or an isolation boundary. In particular, role and policy administration combined with `iam:PassRole` can grant workloads more permissions than the workspace's direct service permissions.

## Permission scope

The source of truth is `Resources.EKSPlusHYPDAdminRole.Properties.Policies` in [eks-hypd-workspace.yaml](eks-hypd-workspace.yaml).

| Policy | Permissions | Purpose |
|---|---|---|
| `InstantStartPlatformOperations` | Service-wide access to CloudFormation, EC2, EKS, SageMaker AI, SageMaker MLflow, S3, FSx, Lambda, ECR, ECR Public, load balancing, scaling, SQS, EventBridge, Amazon Managed Service for Prometheus, CloudWatch and CloudWatch Logs | Provision and operate the platform without requiring an additional policy for each resource or add-on update |
| `InstantStartPlatformOperations` | Resource and quota discovery, CloudTrail event lookup; KMS data encryption/decryption and service grants | Capacity checks, diagnostics and encrypted storage |
| `InstantStartIdentityOperations` | IAM reads and policy validation; create, update and delete roles, customer managed policies, instance profiles, OIDC providers and service-linked roles in the current account | CloudFormation resources, IRSA, Pod Identity, add-on installation and cleanup |
| `InstantStartIdentityOperations` | `iam:PassRole` for current-account roles, limited by `iam:PassedToService` | Give execution roles to EC2, EKS, EKS nodes, EKS Pod Identity, SageMaker, HyperPod, Lambda, CloudFormation and scaling services |
| `InstantStartSessions` | Systems Manager, SSM Messages and EC2 Messages; caller identity; assume trusted roles | Workspace SSM connectivity, node diagnostics and cross-account workflows |

Service permissions intentionally use `Resource: "*"`. There is no default region restriction, project-name requirement, bucket allowlist or mandatory permissions boundary:

- The management host and target cluster can be in different regions.
- Imported clusters and existing execution roles can use customer-selected names.
- S3 storage and MLflow artifact stores can use existing buckets. Cross-account access still requires authorization from the resource owner.
- Cross-account role assumption still requires the destination role's trust policy and applicable account policies.
- Service-linked role creation remains available for first-time provisioning in an account.

IAM write permissions are enumerated rather than granting `iam:*`. Their resource ARNs are limited to the current account's roles, policies, instance profiles, OIDC providers and service-linked roles. IAM user/group creation, access-key management, Organizations administration and KMS key administration are not directly granted by these policies. This does not prevent indirect escalation through the deployment privileges described above.

`kms:CreateGrant` requires `kms:GrantIsForAWSResource=true`, following the AWS pattern for grants made on behalf of AWS resources. The template retains KMS data operations for encrypted storage; it does not grant `kms:PutKeyPolicy`, `kms:ScheduleKeyDeletion` or `kms:CreateKey`.

## Role identity and reuse

The logical ID `EKSPlusHYPDAdminRole`, physical name `${ResourceTag}-admin-role`, instance profile and output names are retained for compatibility. The historical word `admin` in the role name does not mean that `AdministratorAccess` is attached.

The existing trust policy is retained. It trusts EC2, ECR, EKS, Bedrock, CloudFormation, SageMaker and Lambda service principals, plus the current account. The account's `:root` principal delegates trust to that account; other IAM identities need authorization to assume the role.

Two existing workflows also use the workspace role:

- The HyperPod lifecycle-script loader Lambda receives the current runtime role as `LambdaExecutionRoleArn`. It needs Lambda trust, S3 access and logging permissions.
- MLflow Tracking Server creation passes the current runtime role to SageMaker. It needs SageMaker trust, access to the artifact bucket and SageMaker Model Registry permissions.

The policies retain the permissions used by those workflows, which continue to share the deployment role. This change does not introduce separate service roles or additional setup steps.

## Deployment and existing workspaces

Use the existing workspace deployment procedure and `CAPABILITY_NAMED_IAM`. No additional template parameters are required.

An existing workspace receives the new permissions only when its CloudFormation stack is updated with this template. Keep its existing parameter values when updating. Editing or pulling repository files does not change a deployed IAM role.

The preserved role and profile names allow the permissions to be updated without intentionally replacing those resources. Any customer-added policies remain outside this template's control and should be considered when checking the deployed role's effective permissions.

## Permission troubleshooting

Check the actual denied action and resource before changing a policy:

- EKS add-ons and access entries have their own resource ARN types. A grant restricted to `cluster/<name>` alone may not cover `eks:DescribeAddon` or access-entry operations. This version retains service-wide EKS permissions.
- HyperPod log inspection uses CloudWatch Logs actions such as `logs:FilterLogEvents`, `logs:GetLogEvents` and `logs:DescribeLogStreams`. Reading cluster metadata does not grant log access.
- SageMaker MLflow Tracking Server APIs and MLflow data APIs are separate permission namespaces. This version includes both `sagemaker:*` and `sagemaker-mlflow:*`, including MLflow App API access.
- ECR Public login uses `ecr-public:GetAuthorizationToken` and `sts:GetServiceBearerToken`. An expired Docker login token can still cause a 403 even when IAM permissions are correct.
- `iam:PassRole` authorization and the target role's trust policy are separate requirements. Changing one does not replace the other.
- Kubernetes access entries and RBAC remain separate from AWS IAM permissions. An IAM permission change does not automatically grant Kubernetes access.
- An SCP, permissions boundary, session policy, resource policy or explicit deny can still affect authorization.

## Validation

Validation of this revision on November 16, 2026:

- 66 policy regression checks passed.
- CloudFormation `ValidateTemplate` passed and reported the existing `CAPABILITY_NAMED_IAM` requirement.
- IAM Access Analyzer `ValidatePolicy` reported no errors. The IAM policy received the general warning `CREATE_SLR_WITH_STAR_IN_RESOURCE`; its wildcard is retained to support first-time provisioning without a service-linked-role allowlist.
- IAM `SimulateCustomPolicy` returned the expected results for 97 permission decisions, including required platform operations, omitted direct account-administration operations, `PassRole` conditions and ECR Public login.

These are template and policy checks, not a complete AWS integration test. No workspace IAM role was changed in AWS, and no new cluster was deployed during this validation. A policy can be syntactically valid while still granting broad deployment privileges. The absence of validation errors is not proof of least privilege or end-to-end runtime behavior.

## AWS sources

This is a project policy assembled from the platform's implementation and AWS permission requirements, not an AWS managed policy or an AWS-certified minimum-permission policy.

- [HyperPod IAM prerequisites and cluster-creation policy](https://docs.aws.amazon.com/sagemaker/latest/dg/sagemaker-hyperpod-prerequisites-iam.html)
- [CloudFormation service roles and delegation](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-iam-servicerole.html)
- [Grant permissions to pass a role to an AWS service](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_use_passrole.html)
- [Create an MLflow Tracking Server using the AWS CLI](https://docs.aws.amazon.com/sagemaker/latest/dg/mlflow-create-tracking-server-cli.html)
- [ECR Public authorization token permissions](https://docs.aws.amazon.com/AmazonECRPublic/latest/APIReference/API_GetAuthorizationToken.html)
- [IAM permissions boundaries and delegation](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_boundaries.html)
- [KMS conditions, including GrantIsForAWSResource](https://docs.aws.amazon.com/kms/latest/developerguide/conditions-kms.html)
- [Validate policies with IAM Access Analyzer](https://docs.aws.amazon.com/IAM/latest/UserGuide/access-analyzer-policy-validation.html)
- [IAM policy simulator](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_testing-policies.html)
