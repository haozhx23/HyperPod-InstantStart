## Objective

Validate the mainline `InstantStart -> EKS managed nodegroup -> Spot GPU -> EFA -> NCCL` path on the existing `leap-world` EKS cluster in `us-east-2`, using nodes launched through InstantStart instead of ad hoc EC2.

Date: `2026-05-09`

## What ran

- Cluster: `leap-world`
- Region: `us-east-2`
- Nodegroup: `efa-spot-g6e12-2b-nat`
- Capacity type: `SPOT`
- Instance type: `g6e.12xlarge`
- Node count: `2`
- Subnet: `subnet-0bcfc20f6b0e5f29c`
- Instances:
  - `i-061a87876a5c83dae` / `172.31.66.12`
  - `i-0b9de18fe6504b9a8` / `172.31.78.183`
- Run id: `efa-spot-g6e12-2b-nat-20260509_161826`
- Remote benchmark SSM command: `34626afd-8c1d-43d2-956d-523d9d48b95d`
- S3 results prefix:
  `s3://leap-world-us-east-2/ops/efa-validation/efa-spot-g6e12-2b-nat-20260509_161826/results/`

## Result

The remote benchmark completed successfully end-to-end on the nodes. EFA was active and NCCL used `Libfabric` with provider `efa` for the inter-node path.

Measured results:

- Intra-node `allreduce` average bus bandwidth: `3.00928 GB/s`
- Inter-node `allreduce` average bus bandwidth: `2.94021 GB/s`
- Inter-node `allreduce` large-message bus bandwidth:
  - `32 MiB`: `6.32 GB/s`
  - `4 GiB`: `6.16 GB/s`
  - `8 GiB`: `6.10 GB/s`
- Intra-node `alltoall` average bus bandwidth: `1.79954 GB/s`
- Inter-node `alltoall` average bus bandwidth: `1.63728 GB/s`
- Inter-node `alltoall` large-message bus bandwidth:
  - `256 MiB`: `3.47 GB/s`
  - `1 GiB`: `3.47 GB/s`
  - `2 GiB`: `3.41 GB/s`

## Key findings

- The InstantStart path is valid. The EFA Spot nodegroup was created through InstantStart and reached `ACTIVE`.
- The EFA data path is real, not TCP fallback. The logs contain:
  - `NET/OFI Selected provider is efa`
  - `Using network Libfabric`
- The current `g6e.12xlarge` stack is not giving strong cross-node throughput for the intended 2-node training target.
- The logs also show why the bandwidth is limited on this stack:
  - `disabling GDR`
  - `Need to force simple protocol`
  - `Adding NCCL_PROTO=simple`

## Local tooling fix

The benchmark runner itself failed only after the remote work had already completed, during local JSON result assembly. Root cause:

- file: `scripts/aws/instantstart/run_nodegroup_efa_bench.sh`
- issue: invalid `jq` string concatenation in the final `FINAL_JSON` object
- impact: node-side benchmark succeeded and logs were uploaded to S3, but the local runner exited before writing its summary JSON
- fix applied: switched those fields to valid jq string interpolation

## Conclusion

This closes the mainline validation for:

- `InstantStart -> Spot nodegroup creation`
- private subnet + NAT bootstrap
- EFA device readiness
- NCCL inter-node transport over `efa` / `Libfabric`

But it does **not** yet establish this `g6e.12xlarge x2` configuration as the final production baseline for `wan22 ti2v` two-node training. The EFA path works, but the observed cross-node throughput is low and the stack is running with `GDR` disabled and `NCCL_PROTO=simple`.
