---
name: create-cluster-pipeline
description: Create a full HyperPod cluster from scratch, including EKS creation, dependency configuration, and HyperPod provisioning. Use when creating a new cluster, setting up HyperPod infrastructure, bootstrapping environment.
---

## Overview

Full pipeline: EKS Cluster → Switch → Install Dependencies → Create HyperPod

Each step is async and requires polling until completion before proceeding. Users can start from any step if prior steps are already done.

## Resume from Previous Session

If user says "continue" or "resume cluster creation", detect current progress before starting:

1. Call `cluster_get_eks_creation_status` — if a cluster is still creating, resume polling from Step 1
2. Call `cluster_list_all` and `cluster_get_status` — check which cluster is active
3. Call `cluster_get_dependency_status` — if not configured, resume from Step 3
4. Call `hyperpod_get_creation_status` — if HyperPod is creating, resume polling from Step 4

Report the detected state to the user and confirm before continuing.

## Step 1: Create EKS Cluster

1. Call `cluster_list_all` to check for existing clusters
2. Only ask user for cluster tag. Do NOT ask about region — omit the region parameter, which creates the cluster in the panel host's region. If the user names a different region, pass it as `region`; the cluster does not have to be in the panel host's region.
3. Check if user provided custom CIDR configuration:
   - **If user provided all 6 CIDRs** (vpcCidr, publicSubnet1Cidr, publicSubnet2Cidr, eksPrivateSubnet1Cidr, eksPrivateSubnet2Cidr, hyperPodPrivateSubnetCidr): call `cluster_create_eks_with_cidr` with all 6 CIDRs plus clusterTag and region
   - **Otherwise**: call `cluster_create_eks` with just the clusterTag (CIDR auto-generated)
   - Do NOT proactively ask user about CIDR. Only use `cluster_create_eks_with_cidr` when user explicitly provides CIDR values.
4. Inform user: estimated wait 8-12 minutes
5. Poll `cluster_get_eks_creation_status` every **120 seconds** until stack status is `CREATE_COMPLETE`. Between each poll, call `wait_seconds(120)` to wait.
6. If status contains `FAILED` or `ROLLBACK`, report error and stop

## Step 2: Switch to New Cluster and Verify

1. Call `cluster_switch` with the new cluster tag
2. Call `cluster_list_all` and confirm `activeCluster` matches the new cluster tag
3. Call `cluster_get_status` to verify node connectivity and Ready state; this endpoint does not return a cluster tag
4. If verification fails, report error and stop

## Step 3: Install Dependencies

1. Call `cluster_configure_dependencies`
2. Inform user: estimated wait 3-5 minutes
3. Poll `cluster_get_dependency_status` every **60 seconds** until `configured: true`. Between each poll, call `wait_seconds(60)` to wait.
4. If status is `failed`, report error and stop

## Step 4: Create HyperPod Cluster

1. Call `cluster_get_availability_zones` and `cluster_get_available_instances` in parallel to get options
2. Ask user to provide the following (show available options from above):
   - **AcceleratedInstanceType**: GPU instance type (e.g. ml.g5.xlarge, ml.p4d.24xlarge)
   - **AcceleratedInstanceCount**: number of instances
   - **availabilityZone**: which AZ to use
   - **Capacity type**: ask whether to use **on-demand** or **Training Plan (reserved capacity)**. If user chooses Training Plan, ask for the **AcceleratedTrainingPlanArn**.
3. Call `hyperpod_create` with user's choices (auto-generate hyperPodTag if user doesn't specify)
4. Inform user: estimated wait 5-15 minutes
5. **MUST poll** `hyperpod_get_creation_status` every **60 seconds** for initial CloudFormation creation. Once `status.cfStatus` is `CREATE_COMPLETE`, or the creation record has been cleared, poll `hyperpod_get_instance_group_status` until `ready: true` or `failed: true`. The first tool reports CloudFormation creation; the second reports actual cluster and instance-group capacity. Stop and report any creation or runtime failure. Between each poll, call `wait_seconds(60)` to wait. Report each poll result to the user. Do NOT skip polling or leave it to the user to check manually.

## Step 5: Configure S3 Storage

1. Call `s3_storage_create` with no parameters (uses all defaults: s3-claim, auto-detected bucket and that bucket's region). The default bucket is the panel host's workspace bucket; if the cluster is in a different region, tell the user that pods will read it across regions.
2. If successful, inform user that S3 storage is mounted
3. If failed, report error but do NOT block — this is non-critical and can be configured later

## Step 6: Verify

1. Call `cluster_get_status` to show final state (nodes, GPUs)
2. Summarize what was created (EKS cluster, dependencies, HyperPod, S3 storage)

## Rules

- Do NOT ask user about region. Omitting it uses the panel host's region; pass `region` only when the user explicitly requests a different one.
- Execute steps strictly in order. Do not proceed until the previous step completes.
- Stop immediately on any failure and report the error clearly.
- Inform user of estimated wait time before each long-running operation.
- Report current status during polling, do not poll silently.
- User can say "start from step N" to skip completed steps.
- Always ask user whether to use on-demand or Training Plan (reserved capacity). Default selection is on-demand, but user must be given the choice.
- After ANY long-running operation starts (EKS creation, dependency install, HyperPod creation), you MUST automatically poll for status. Always call `wait_seconds()` between polls. Never poll without waiting first.
