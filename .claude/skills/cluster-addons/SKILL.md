---
name: cluster-addons
description: Install and manage cluster add-ons (Karpenter, etc.). Use when user wants to install Karpenter, configure cluster add-ons, or enable additional cluster features.
---

## HyperPod Karpenter Installation

### When to use
User wants to install HyperPod Karpenter or enable auto-scaling for the cluster.

### Steps

1. Call `hyperpod_karpenter_get_status` to check if already installed
2. If already installed, inform user and show current status
3. If not installed, call `hyperpod_karpenter_install` (uses the active cluster's metadata; no parameters are needed)
4. The tool waits for IAM setup and submits the HyperPod configuration update
5. Poll `hyperpod_karpenter_get_status` every **60 seconds** (call `wait_seconds(60)` between polls) until `installed: true`
6. Show final status to user

### Rules
- No user input needed for installation
- Always check status first before installing
- Must poll until installation completes

