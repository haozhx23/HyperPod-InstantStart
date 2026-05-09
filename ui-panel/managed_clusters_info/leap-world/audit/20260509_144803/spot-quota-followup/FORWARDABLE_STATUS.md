## Forwardable Status

Date: `2026-05-09`
Region: `us-east-2`
Quota: `All G and VT Spot Instance Requests (L-3819A6DF)`

### Current status

- Applied quota is still `2500 vCPU`.
- The original quota increase request is still for `8000 vCPU`.
- AWS Support case `177822574900799` has already been updated with a detailed production use case.
- Support case status is now `customer-action-completed`, which means AWS has received the follow-up and the case is back with them for reassessment.

### What actually blocked the launch

This was not an InstantStart/NAT/EKS configuration problem.

- CloudWatch `AWS/Usage` recorded a same-day peak of `2496 vCPU` against the `2500 vCPU` limit.
- That explains the earlier `MaxSpotInstanceCountExceeded` seen when trying to launch additional `g6e.48xlarge` Spot nodes.

### Current occupancy snapshot

At the time of this audit:

- Running `G/VT Spot` compute still in use: `640 vCPU`
- Stale but still active `G/VT Spot` requests: `128 vCPU`

Current active-request breakdown:

- `running` / `ray-gpu-spot-fallback`: `368 vCPU`
- `running` / `ray-gpu-spot-primary`: `272 vCPU`
- `stale active requests`: `128 vCPU`

### Fastest headroom recovery

If headroom is needed before AWS responds, the cleanest sequence is:

1. Clear the stale active requests first.
2. If more relief is needed, release running `ray-gpu-spot-fallback` nodes before `ray-gpu-spot-primary` nodes, because a `g6.12xlarge` frees `48 vCPU` while a `g6.4xlarge` frees `16 vCPU`.

Stale active requests worth clearing first:

- `sir-dtz7e65n` / `i-037e4bd42f670bfe7` / `g6.4xlarge` / `16 vCPU`
- `sir-zxazdaxq` / `i-0017c55a644afc02c` / `g6.4xlarge` / `16 vCPU`
- `sir-c2kzdaxn` / `i-0aed25a96fa09b203` / `g6.12xlarge` / `48 vCPU`
- `sir-xrx7dwip` / `i-045945979b4462527` / `g6.12xlarge` / `48 vCPU`

Total stale relief available from this bucket: `128 vCPU`

### Important exclusion

`p5.48xlarge` and `p5en.48xlarge` Spot instances do not count toward this specific quota, so releasing them does not help `L-3819A6DF`.
