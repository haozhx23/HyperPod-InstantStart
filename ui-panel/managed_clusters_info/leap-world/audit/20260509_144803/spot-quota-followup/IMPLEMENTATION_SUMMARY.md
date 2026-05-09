## Spot Quota Follow-up

Timestamp: `2026-05-09 14:48:03 +08:00`
Region: `us-east-2`
Quota: `L-3819A6DF` / `All G and VT Spot Instance Requests`

### Scope

This audit follow-up covered two tasks:

1. Track the existing `G/VT Spot` quota increase request and its linked AWS Support case.
2. Identify the current `us-east-2` `G/VT Spot` consumers and produce a release-priority recommendation.

### Commands Used

- `aws service-quotas get-service-quota --service-code ec2 --quota-code L-3819A6DF --region us-east-2`
- `aws service-quotas list-requested-service-quota-change-history-by-quota --service-code ec2 --quota-code L-3819A6DF --region us-east-2`
- `aws support describe-cases --display-id 177822574900799 --include-communications --region us-east-1`
- `aws cloudwatch get-metric-statistics --namespace AWS/Usage --metric-name ResourceCount ... --region us-east-2`
- `aws ec2 describe-spot-instance-requests --region us-east-2`
- `aws ec2 describe-instances --region us-east-2`
- `aws ec2 describe-instance-types --region us-east-2`
- `kubectl get nodes -o json`
- `kubectl get pods -A -o json`

### Findings

#### 1. Quota request / support case status

- The quota request is still the same request created on `2026-05-08 15:35:48 +08:00`.
- Requested value remains `8000 vCPU`.
- Applied quota is still `2500 vCPU`.
- Service Quotas request object still shows `CASE_OPENED`.
- The linked AWS Support case is:
  - Display ID: `177822574900799`
  - Case ID: `case-829115578968-muen-2026-7817b5ed7d6bcee6`
  - Subject: `Quota Increase: EC2 Spot Instances`
  - Current status: `customer-action-completed`

Interpretation:

- `CASE_OPENED` on the Service Quotas object does not mean AWS has not received the follow-up.
- The Support case is the more precise state source here.
- `customer-action-completed` means our additional use-case details were submitted on `2026-05-09T06:42:44.800Z`, and the case is now back with AWS for reassessment.

#### 2. Peak usage vs current snapshot

- Quota description is explicit: `The maximum number of vCPUs for all running or requested G and VT Spot Instances per Region`.
- CloudWatch `AWS/Usage` showed a same-day peak of `2496 vCPU` at `2026-05-09 14:00:00 +08:00`.
- Current snapshot at audit time is materially lower:
  - Running `G/VT Spot` backing useful nodes: `640 vCPU`
  - Stale but still active `G/VT Spot` requests: `128 vCPU`
  - Current observed total in active requests + running/shutting/terminated instances tied to them: `768 vCPU`

Interpretation:

- The earlier `MaxSpotInstanceCountExceeded` is consistent with a real intraday saturation event.
- The current cluster state is not still at `2496 vCPU`; the account had already partially scaled down by the time of this audit.
- Because the quota counts `requested` capacity too, stale active requests still matter even when their instances are already gone.

#### 3. Current consumers

Current active `G/VT Spot` request summary:

- `running` / `ray-gpu-spot-fallback`: `9` requests, `368 vCPU`
- `running` / `ray-gpu-spot-primary`: `17` requests, `272 vCPU`
- `shutting-down` / `ray-gpu-spot-fallback`: `2` requests, `96 vCPU`
- `terminated` / `ray-gpu-spot-primary`: `2` requests, `32 vCPU`

Important exclusion:

- `p5.48xlarge` and `p5en.48xlarge` Spot instances are not part of this quota.
- Releasing those does not help `L-3819A6DF`.

#### 4. Immediate release-priority recommendation

Priority 1: stale active requests with no useful capacity behind them

- These are the highest-value cleanup targets because they appear to consume quota without providing active compute.
- Total potential relief from this bucket: `128 vCPU`

Targets:

- `sir-dtz7e65n` / `i-037e4bd42f670bfe7` / `g6.4xlarge` / `terminated` / `16 vCPU`
- `sir-zxazdaxq` / `i-0017c55a644afc02c` / `g6.4xlarge` / `terminated` / `16 vCPU`
- `sir-c2kzdaxn` / `i-0aed25a96fa09b203` / `g6.12xlarge` / `shutting-down` / `48 vCPU`
- `sir-xrx7dwip` / `i-045945979b4462527` / `g6.12xlarge` / `shutting-down` / `48 vCPU`

Priority 2: running `ray-gpu-spot-fallback` nodes with `1` ray pod each

- These are the most quota-efficient running releases.
- Each `g6.12xlarge` frees `48 vCPU`.
- Each `g6.4xlarge` frees `16 vCPU`.
- Avoid the single fallback node with `2` ray pods until later.

Primary `48 vCPU` candidates:

- `i-0dbb6508e6bc2451c`
- `i-0b5a312a9fbaa9da5`
- `i-055fa8e30b5f27a49`
- `i-0b5e92cd77ed866c7`
- `i-01b230028cc158e15`
- `i-02865b8015a51b71b`

Smaller-granularity `16 vCPU` fallback candidates:

- `i-06fb0882351f9ec05`
- `i-07e16af76703cc1c5`

Fallback node to avoid until later because it has `2` ray pods:

- `i-0d448a850dec64f46`

Priority 3: running `ray-gpu-spot-primary` nodes

- These all currently show `1` ray pod each.
- They free only `16 vCPU` per node, so they are less efficient if the goal is quota headroom.
- They remain valid release candidates if smaller, more granular reduction is preferred.

### Forwardable Conclusion

As of `2026-05-09`, the quota increase request to `8000 vCPU` is still open and the linked Support case has already been updated with a detailed production use case. The Support case status is now `customer-action-completed`, which means AWS has our follow-up and should reassess the request.

The current blocker is no longer “mystery missing capacity.” It is specifically the `G/VT Spot` quota in `us-east-2`. The account hit a real same-day CloudWatch peak of `2496 / 2500 vCPU`, and there are still `128 vCPU` worth of stale active Spot requests that are not providing useful capacity. If immediate headroom is needed before AWS responds, the cleanest first action is to clear those stale requests, then release running `ray-gpu-spot-fallback` nodes before `ray-gpu-spot-primary` nodes.

### Artifacts

- Structured result: `result.json`
- Forwardable note: `FORWARDABLE_STATUS.md`
