## Stale Classification Note

This note explains why the following four Spot requests were classified as `stale` in the original `2026-05-09 14:48:03 +08:00` audit snapshot:

- `sir-dtz7e65n` / `i-037e4bd42f670bfe7`
- `sir-zxazdaxq` / `i-0017c55a644afc02c`
- `sir-c2kzdaxn` / `i-0aed25a96fa09b203`
- `sir-xrx7dwip` / `i-045945979b4462527`

### Point-in-time definition used

For that audit step, `stale` meant:

1. The `SpotInstanceRequest` was still visible as `active` / `fulfilled`.
2. The backing instance was already `terminated` or `shutting-down`, or the corresponding Kubernetes node was already gone / not serving work.
3. The instance was no longer providing useful cluster capacity, but the request still appeared to remain in the quota-relevant request set.

### Why these four matched that definition

At the time of the earlier snapshot:

- two requests pointed to `terminated` `g6.4xlarge` instances with no Kubernetes node and `0` ray pods
- two requests pointed to `shutting-down` `g6.12xlarge` instances with `NotReady` nodes and `0` ray pods

That is why they were treated as the cleanest first targets in the earlier release-priority analysis.

### Recheck result

On recheck performed later the same day, all four requests had already converged to:

- Spot request state: `closed`
- Status code: `instance-terminated-by-user`
- Instance state: `terminated`
- Kubernetes node: none
- Ray pods: `0`

### Important interpretation

So `stale` was a correct description of their earlier intermediate state, not a claim that they were permanently stuck forever. They have now aged out and are no longer in that stale-active bucket.
