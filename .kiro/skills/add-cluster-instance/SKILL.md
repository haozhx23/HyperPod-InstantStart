---
name: add-cluster-instance
description: Add a new instance group to an existing HyperPod cluster. Use when user wants to add GPU nodes, expand cluster capacity, or add a new instance group.
---

## Overview

Add a new HyperPod instance group to the current active cluster. Corresponds to the "Add Instance Group" button on the Cluster Management page.

## Step 1: Collect Parameters

1. Call `cluster_get_availability_zones` and `cluster_get_available_instances` in parallel
2. Ask user for ALL of the following (show available options):
   - **instanceGroupName**: name for the new instance group
   - **instanceType**: GPU instance type (e.g. ml.g5.xlarge, ml.p4d.24xlarge)
   - **instanceCount**: number of instances
   - **availabilityZone**: which AZ (e.g. us-east-1c)
   - **volumeSize**: EBS volume size in GB (default 500)
   - **Capacity type**: ask whether to use **on-demand**, **Spot**, or **Training Plan (reserved capacity)**
     - If Training Plan: ask for the **trainingPlanArn**
     - If Spot: set isSpot=true (no further questions needed)
     - If on-demand: default, no extra params

## Step 2: Validate Parameters

1. If user provides both a **trainingPlanArn** and an **availabilityZone**, extract the AZ from the Training Plan ARN and compare:
   - Training Plan ARNs encode the AZ info. If the user-specified AZ conflicts with the Training Plan's AZ, **use the Training Plan's AZ** and inform the user of the override.
2. Confirm the final parameters with the user before proceeding.

## Step 3: Add Instance Group

1. Call `hyperpod_add_instance_group` with the validated parameters
2. Inform user: estimated wait 5-15 minutes
3. **MUST poll** `hyperpod_get_instance_group_status(name=instanceGroupName)` every **60 seconds** until `ready: true` or `failed: true`. This checks actual cluster state and current/target capacity; `hyperpod_get_creation_status` only checks the initial CloudFormation creation. Between each poll, call `wait_seconds(60)` to wait. Report each poll result to the user. Do NOT skip polling.

## Step 4: Verify

1. Call `cluster_get_status` to show updated cluster state (nodes, GPUs, instance groups)
2. Summarize what was added

## Rules

- Always ask user about capacity type (on-demand / Spot / Training Plan). Default is on-demand.
- If user mentions "spot" anywhere in the conversation, set isSpot=true without further questions about capacity type.
- Training Plan ARN's AZ takes precedence over user-specified AZ. Always inform user if overriding.
- After the add operation starts, you MUST automatically poll for status. Never tell the user to "check later".
- Stop immediately on any failure and report the error clearly.
