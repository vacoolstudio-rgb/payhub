# Kubernetes manifests

Plain YAML, deliberately: the point is that every decision is visible rather
than buried in a chart's `values.yaml`. Wrap it in Kustomize or Helm when
there is a second environment to parameterise.

```bash
kubectl apply -f base/namespace.yaml
kubectl apply -f base/config.yaml        # replace the Secret with External Secrets
kubectl apply -f base/                   # the rest
```

## What is deliberately *not* here

**Postgres, Redis and Kafka.** Running stateful systems on Kubernetes is a
project of its own, and a payments ledger is the last place to practise.
Use a managed Postgres, a managed Redis and a managed Kafka (MSK, Confluent
Cloud, Aiven); point `payhub-config` and `payhub-secrets` at them. If they
must live in-cluster, use the operators — CloudNativePG, the Redis operator
and Strimzi — not hand-written StatefulSets.

**The secret values.** `config.yaml` contains a placeholder Secret so the
manifests apply cleanly. Replace it with External Secrets Operator, Vault
Agent or the cloud provider's CSI driver before anything real.

## Decisions worth defending in review

| Choice | Why |
|---|---|
| `maxUnavailable: 0` on the API | A deploy must not shed capacity on the request path. |
| Separate liveness and readiness | Liveness is process-local. A liveness probe that checks Redis restarts every pod during a Redis blip — turning a dependency outage into your own. |
| `terminationGracePeriodSeconds` > `SHUTDOWN_GRACE_MS` | The app drains on its own terms; a shorter grace means SIGKILL mid-transaction. |
| `preStop: sleep 5` | Endpoints propagate asynchronously. Without the pause, a terminating pod still receives traffic it has decided to refuse. |
| Memory limits, no CPU limits | CFS throttling on a Node event loop shows up as unexplained p99 latency. Requests reserve capacity; limits only add jitter. |
| Headless Service for the ledger | gRPC keeps one HTTP/2 connection open, so a ClusterIP would pin all traffic to a single pod. Clients need per-RPC balancing. |
| Migrations in a Job | Replicas racing `runMigrations()` deadlock. One Job, before the rollout. |
| KEDA for the worker | It is I/O bound: 5 % CPU with ten thousand queued webhooks. Queue depth is the only honest signal. |
| Notifications replicas ≤ partitions | A Kafka consumer group assigns whole partitions; extra pods hold nothing. |
| Default-deny NetworkPolicy | The bounded-context boundary becomes a network rule instead of a convention. |
