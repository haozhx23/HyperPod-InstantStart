# Spot Quota Request Status

Date: `2026-05-09`
Region: `us-east-2`
Account: `829115578968`

## Target Quota

- Quota name: `All G and VT Spot Instance Requests`
- Quota code: `L-3819A6DF`
- Current applied value: `2500`
- Quota unit: `vCPU`

This is the EC2 Spot quota that governs the `g6/g6e/g5/vt` family pool in the region and is the quota relevant to the failed `g6e.48xlarge x2` InstantStart EFA test.

## Requested Action

Requested goal from the operator: raise the Spot quota to `2x` the current value.

Computed target:

- current value `2500`
- desired `2x` value `5000`

## Result

A new request was **not** created, because AWS already has an open request for the same quota and only allows one open increase request per quota.

Existing open request:

- request id: `a563318b44bb471998180bed2500a0f7bXlZR5VI`
- case id: `177822574900799`
- quota code: `L-3819A6DF`
- desired value: `8000`
- status: `CASE_OPENED`
- created: `2026-05-08 15:35:48 +08:00`
- requester: `arn:aws:iam::829115578968:user/seedleap-server`

Attempted duplicate request:

```text
aws service-quotas request-service-quota-increase --service-code ec2 --quota-code L-3819A6DF --desired-value 5000 --region us-east-2
```

AWS response:

`ResourceAlreadyExistsException: Only one open service quota increase request is allowed per quota.`

## Operational Interpretation

The existing open request to `8000` already exceeds the requested `2x` target of `5000`, so no additional request is needed.

## Usage Evidence

CloudWatch usage metric for this quota:

- namespace: `AWS/Usage`
- metric: `ResourceCount`
- dimensions:
  - `Class=G/Spot`
  - `Resource=vCPU`
  - `Service=EC2`
  - `Type=Resource`

Observed maximum today:

- `2496 vCPU`

That explains the `MaxSpotInstanceCountExceeded` failure observed during the InstantStart EFA Spot nodegroup launch.

## Current Recommendation

No further quota submission is required right now.

The actionable next step is to track or escalate the existing open request:

- case id: `177822574900799`
- requested quota value: `8000`
