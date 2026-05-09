# InstantStart NAT + EFA Spot Validation

Date: `2026-05-09`
Region: `us-east-2`
Cluster: `leap-world`

## Goal

Switch the existing `leap-world` EKS cluster from the earlier public-subnet EFA workaround path to the cleaner InstantStart deployment-manual path:

- add NAT-backed private compute subnets
- keep using InstantStart to create the Spot EFA nodegroup
- run `leap_world` EFA/NCCL validation from the dedicated ops worktree

## What Was Changed

### 1. Added NAT-backed private networking

Created:

- NAT EIP: `eipalloc-0939826309d72135b`
- NAT Gateway: `nat-096ebcbc3a2f9fb69` in public subnet `subnet-088ba5d2aed6aebbe` (`us-east-2b`)
- private compute subnet `subnet-0bcfc20f6b0e5f29c` (`hp-compute-us-east-2b`, CIDR `172.31.64.0/20`)
- private compute subnet `subnet-0245e620ed4f40137` (`hp-compute-us-east-2c`, CIDR `172.31.80.0/20`)
- route tables:
  - `rtb-046ec86b04ab60732` for `2b`
  - `rtb-0d5e49b78c72c4d9a` for `2c`
- S3 gateway endpoint: `vpce-016007d2eecb88881`

Each private route table now has:

- `0.0.0.0/0 -> nat-096ebcbc3a2f9fb69`
- `S3 prefix list -> vpce-016007d2eecb88881`

### 2. Updated the EKS cluster subnet set

Successful `VpcConfigUpdate`:

- update id: `849ee616-c94f-3924-be66-71e00a668a64`

`leap-world` now includes:

- public: `subnet-0e620ab50b1526027`, `subnet-088ba5d2aed6aebbe`, `subnet-0bcab1ccb5526245b`
- private: `subnet-0bcfc20f6b0e5f29c`, `subnet-0245e620ed4f40137`

### 3. Kept the InstantStart path

Launched via InstantStart remote CLI:

```bash
bash /Users/chenshengdong/workspace/leap_world-ops-efa/scripts/aws/instantstart/instantstart_remote.sh \
  --env /Users/chenshengdong/workspace/leap_world-ops-efa/scripts/aws/instantstart/env/leap-world-efa-g6e-2b-nat.env \
  create-spot-nodegroup
```

Result:

- nodegroup: `efa-spot-g6e-2b-nat`
- CloudFormation stack: `eksctl-leap-world-nodegroup-efa-spot-g6e-2b-nat`
- target subnet: `subnet-0bcfc20f6b0e5f29c`
- capacity type: `SPOT`
- instance type: `g6e.48xlarge`
- cleanup action: nodegroup deletion requested after quota failure to avoid endless retries

### 4. Updated repo logic for future private subnets

Patched:

- [computeSubnetManager.js](/Users/chenshengdong/workspace/HyperPod-InstantStart/ui-panel/server/utils/computeSubnetManager.js)

Change:

- newly created compute subnets now automatically get:
  - `kubernetes.io/role/internal-elb=1`
  - `kubernetes.io/cluster/<cluster>=shared`

### 5. Updated EFA benchmark scripts in the `leap_world` ops worktree

Patched:

- [02_nccl_allreduce.sh](/Users/chenshengdong/workspace/leap_world-ops-efa/scripts/aws/cluster_validation/02_nccl_allreduce.sh)
- [03_nccl_alltoall.sh](/Users/chenshengdong/workspace/leap_world-ops-efa/scripts/aws/cluster_validation/03_nccl_alltoall.sh)

Change:

- switched to explicit `hostfile`
- switched to `/opt/amazon/openmpi/bin/mpirun`
- added AWS-recommended Open MPI flags:
  - `--mca pml ^cm`
  - `--mca btl tcp,self`
  - `--bind-to none`
- accepted newer success signature:
  - `NET/OFI Selected Provider is efa`

## Current Result

The network/configuration problem is resolved.

Evidence:

- the new InstantStart nodegroup is using private subnet `subnet-0bcfc20f6b0e5f29c`
- no public-IP workaround was required
- NAT and S3 endpoint are in place

The remaining blocker is now account-level Spot quota / usage, not cluster networking.

Auto Scaling activity for `eks-efa-spot-g6e-2b-nat-eecf05a9-9920-acdc-0e04-d0187d3c70b6`:

- `Could not launch Spot Instances. MaxSpotInstanceCountExceeded`

At the time of validation, the account already had a large number of unrelated running GPU Spot instances in `us-east-2`, including many untagged `g6.4xlarge`, `g6.12xlarge`, and at least one `p5en.48xlarge`. Because of that, the new `g6e.48xlarge x2` nodegroup could not allocate any instances, so the EFA/NCCL benchmarks could not start.

## Operational Conclusion

Status:

- `NAT/private-subnet + InstantStart` path: `READY`
- `Spot g6e.48xlarge x2` allocation: `BLOCKED BY ACCOUNT SPOT LIMIT / CURRENT USAGE`
- `EFA allreduce/alltoall throughput numbers`: `NOT PRODUCED YET`
- temporary validation nodegroup `efa-spot-g6e-2b-nat`: `DELETING`

## Next Step To Unblock

One of the following must happen before rerunning the benchmark:

1. free enough existing GPU Spot usage in this AWS account/region
2. raise the relevant EC2 Spot quota for this account/region
3. choose a different account/region with enough GPU Spot headroom

After that, rerun:

```bash
bash /Users/chenshengdong/workspace/leap_world-ops-efa/scripts/aws/instantstart/instantstart_remote.sh \
  --env /Users/chenshengdong/workspace/leap_world-ops-efa/scripts/aws/instantstart/env/leap-world-efa-g6e-2b-nat.env \
  create-spot-nodegroup

bash /Users/chenshengdong/workspace/leap_world-ops-efa/scripts/aws/instantstart/run_nodegroup_efa_bench.sh efa-spot-g6e-2b-nat
```
