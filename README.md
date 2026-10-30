# PayHub

Wallets, a double-entry ledger and payments — built as four independently
deployable NestJS services with a React dashboard on top.

The point of this repository is not that it moves money. It is that every
decision in it is defensible: why this transport, why this isolation level,
why this lock, why this cache TTL. Where a choice is a trade-off, the code
says so in a comment next to the line that pays for it.

```
┌─────────┐   REST / GraphQL / WS / SSE    ┌──────────────┐
│  web    │ ─────────────────────────────▶ │     api      │  Identity · Merchant · Payment
└─────────┘                                └──────┬───────┘
                                                  │ outbox → Kafka
                        gRPC (balances)           ▼
                  ┌───────────────────────  ┌──────────────┐
                  │                         │    ledger    │  Wallet · Journal (own schema)
                  │                         └──────┬───────┘
                  │                                │ Kafka: transfer_posted / rejected
                  │                                ▼
            ┌─────┴────────┐              ┌────────────────┐
            │    worker    │              │ notifications  │
            └──────────────┘              └────────────────┘
       outbox relay · webhooks (BullMQ)      Nest Kafka transport
       expiry & recovery crons
```

---

## Running it

```bash
cp .env.example .env

# everything, including the dashboard on :5173
docker compose up -d --build

# or: infrastructure in Docker, services from source
docker compose up -d postgres redis kafka
npm install && npm run build
npm run db:migrate
./scripts/run-local.sh ledger &   # :3001 + gRPC :50051
./scripts/run-local.sh api &      # :3000
./scripts/run-local.sh worker &   # :3002
npm run db:seed                   # demo merchant, API key and payments
cd web && npm install && npm run dev
```

| | |
|---|---|
| Dashboard | http://localhost:5173 |
| REST + OpenAPI | http://localhost:3000/api/docs — routes are mounted under `/api/v1`, which is a prefix and not itself a page |
| GraphQL | http://localhost:3000/graphql |
| Queues (Bull Board) | http://localhost:3002/admin/queues |
| Kafka UI | http://localhost:8080 |
| Traces · Metrics · Dashboards | http://localhost:16686 · :9090 · :3100 |

```bash
npm run typecheck && npm run lint
npm test            # 316 unit tests, no containers, ~2 s
npm run test:e2e    # 61 integration tests against real Postgres + Redis
```

---

## Why four services, and why these four

A service boundary is worth its cost only when the two halves differ in
something real: their consistency requirements, their scaling shape, or
their rate of change. Each split here is justified on at least one.

**`ledger`** owns the money. It has its own Postgres schema, its own
database credentials, and no other service may read its tables — the
`search_path` is pinned per connection so even a hand-written query cannot
reach across. It accepts *commands* over Kafka and answers *queries* over
gRPC. Its consistency requirements are stricter than everything else's, and
that is the whole reason it is separate.

**`api`** owns identity, merchants and the payment lifecycle. It is latency
bound and scales on request rate. It never writes to the ledger; it asks.

**`worker`** is the API's background half — same bounded context, same
schema, different workload shape. It is throughput bound and scales on queue
depth, so it gets its own deployment and its own autoscaler. This is the one
place two deployments share a schema, and it is a deliberate exception
rather than an accident (the architecture test encodes it, and would fail on
any other cross-service import).

**`notifications`** owns nothing. Its only state is a dedup key and a rate
limit in Redis, and its guarantees are the loosest in the platform — which
is exactly why it is separate: it can be deployed, broken and restarted
without anybody noticing.

### The payment saga

```
POST /payments ──▶ Payment(pending) ──▶ PSP authorise ──▶ Payment(capturing)
                         │                                       │
                    outbox row                              outbox row
                         ▼                                       ▼
               payment.initiated.v1                 ledger.post_transfer.v1
                                                              │
                                      ┌───────────────────────┴───────────────┐
                                      ▼                                       ▼
                       ledger.transfer_posted.v1              ledger.transfer_rejected.v1
                                      │                                       │
                            Payment(captured)                        Payment(failed)
                                      │
                      payment.captured.v1 ──▶ webhook queue ──▶ merchant
```

It is an **orchestrated** saga, not a choreographed one: `PaymentSaga` holds
the state machine in one file. With choreography, "why is this payment
stuck?" is answered by tracing events across four services; with
orchestration it is answered by reading one class.

The external PSP call sits deliberately **between** two transactions, not
inside one. Holding a database transaction open across an HTTP call to a
provider is the single most damaging thing you can do to a payments service:
a provider that takes ten seconds pins a connection and a row lock for ten
seconds, and the pool is exhausted long before the provider times out. The
cost is a crash window where a provider authorisation was never recorded —
which is precisely what reconciliation and the stuck-payment cron exist to
catch.

---

## Picking the right tool

| Transport | Used for | Why it, and not the others |
|---|---|---|
| **REST** | public merchant API, all payment commands | `Idempotency-Key`, precise status codes, signed bodies, a contract an integrator can call with `curl` |
| **GraphQL** | dashboard read model | one round trip fills a screen that would otherwise be four requests plus an N+1 on merchants. Writes stay on REST |
| **gRPC** | `api` → `ledger` balance reads | deadlines that propagate, a contract that breaks the build when the `.proto` changes, HTTP/2 multiplexing on an internal hop |
| **Kafka** | everything between services | durable log, partitioned by aggregate id so events about one payment are ordered, replayable, with a real DLQ |
| **WebSocket** | live payment and balance push | bidirectional (clients subscribe to merchant rooms), many small messages, rooms do the authorisation |
| **SSE** | assistant token stream | one-directional and long-lived; rides plain HTTP so no proxy needs to understand an Upgrade handshake |
| **BullMQ** | webhook delivery | retry schedule must survive a restart, and operations needs to see what is stuck |

Two of these deserve their inverse stated: GraphQL is **not** used for
writes, because money commands want idempotency keys and strict contracts
more than they want field selection. WebSocket is **not** used for the
assistant, because nothing flows upward during a stream and `EventSource`
reconnects on its own.

---

## Decisions, and what they cost

### Money is never a float

`Money` holds `bigint` minor units and a `Currency` with an explicit
exponent. `0.1 + 0.2 !== 0.3` is a unit test in this repository. Fees are
basis points, not percentages; division takes an explicit rounding mode and
defaults to banker's rounding, so rounding does not systematically favour
the platform over a million transactions. `allocate()` distributes a
remainder one minor unit at a time, so splitting 0.05 three ways loses
nothing.

### A correlation id that did not survive the first hop

The question worth asking of any distributed system: at three in the
morning, given the `x-correlation-id` the client was handed, can you
follow one payment through the platform? Measured, before:

```
api            1 line
ledger         0
worker         0
notifications  0
```

One line. A payment touches four services and the id reached exactly one
of them. Two independent breaks.

#### The relay threw away the id the outbox had saved

```ts
const correlationId = this.cls.isActive() ? this.cls.get('correlationId') : randomUUID();
```

Computed once per batch, from the ambient request context. Both halves
are wrong for the outbox relay, which is the main caller: it is a
background poller, so there is no request context and every message got
a fresh random id — and a batch holds rows written by many different
requests, so a single id could not be right even in principle.

The real id was already there. `OutboxPublisher` stores it on the row at
the moment the business transaction commits, and the relay passes those
headers through. The spread even put the stored value on the Kafka
*header* — so each message carried the correct id one field away from
the envelope that contradicted it, and consumers read the envelope.

It is taken per message from the stored header now, with the context and
then a fresh id as fallbacks, and the header is written last so the two
cannot diverge again.

#### The logger only tagged HTTP

`customProps` is a pino-http feature: it decorates logs belonging to an
HTTP request and nothing else. Every line written while handling a Kafka
message, running a cron or processing a queue job came out untagged —
which is most of what a payment actually does. A `mixin` runs for every
record the instance emits, whatever started it.

The notifications service needed its own fix: it runs on the Nest Kafka
transport rather than the hand-written consumer, so nothing re-entered
the correlation id into CLS for it.

Measured, after — one id, four services, in order:

```
10:44:30.480  api            request completed
10:44:30.661  notifications  handled payment.initiated.v1
10:44:30.691  ledger         Posted deposit transfer 0dfdb676…
10:44:31.179  api            Payment 39059317… captured via transfer 0dfdb676…
10:44:31.683  notifications  push → template=payment_captured
10:44:31.692  worker         Merchant 442d8b6e… has no active endpoint
```

### Brute-force protection that a rollback quietly deleted

Everything was in place: a progressive lockout in the `User` aggregate, a
`MAX_FAILED_ATTEMPTS` threshold, a `UserLocked` domain event, two columns
carrying the state, and a login flow that calls all of it. Six wrong
passwords in a row left the counter at **zero**.

```ts
@Transactional()
async login(command: LoginCommand) {
  …
  if (!matches) {
    user.recordFailedLogin();
    await this.users.save(user);
    throw new InvalidCredentialsError();   // ← rolls the increment back
  }
```

A rejected login throws, the throw rolls back the transaction, and the
increment goes with it. The threshold, the event and both columns were
dead code; an attacker had unlimited guesses per account, bounded only by
the IP throttle, which distributing defeats.

The write that records a failure has to survive the failure of the
transaction that caused it, so it runs on its own now
(`propagation: 'REQUIRES_NEW'`).

#### Why no test caught it

`bindTestTransactions` — the unit-test transaction manager — runs the
callback directly. It does not roll back, so `write; throw` looks
perfectly correct there and is undone in production. Every unit test of
this path passed.

The behaviour under test *is* the transaction boundary, so the regression
test is an integration one against a real Postgres, and the helper now
says plainly what it cannot tell you.

Verified end to end afterwards:

```
попытка 1 → 401, счётчик=1      статус=locked
…                               верный пароль → ACCOUNT_LOCKED
попытка 5 → 401, счётчик=5
```

The two defences are layered on purpose: a per-IP throttle on `/login`
stops the fast attack, and the per-account lockout stops the slow
distributed one that the throttle cannot see.

### `refunding` was a state nothing came back from

Every payment state has something that rescues it when a process dies at
the wrong moment — `pending` and `authorized` expire, `capturing` is
re-issued. Except one. The refund handler's own comment said so: *"a
state no cron sweeps"*. Two independent ways in, and no way out.

#### A refused refund stranded the payment

The ledger can decline to move money back — the house account may not
have it. The saga called `payment.fail()` for every rejection, and
`refunding → failed` is not a legal transition, so it logged *"already
refunding"* and returned. The payment stayed in `refunding` for good:
the customer never got the money, and `beginRefund` refuses to start
from `refunding`, so nobody could retry it either.

A refused refund is not a failed payment. Nothing moved, so the payment
is still captured — which is exactly the compensation the command
handler already applies when the *provider* declines. It calls
`cancelRefund()` now, and the refundable amount is intact for a retry.

#### A crash in the middle left nothing to retry by

`refunding` is entered in one transaction and left by an event from the
ledger. A process that died in between, or a reply that was lost,
stranded the payment the same way — and recovery was impossible rather
than merely absent: the refund's `transferId` was minted inside the
handler, sent to the outbox and forgotten. Re-issuing under a fresh id
is a *second* refund.

So the in-flight refund is persisted now — id **and** amount, in the
same step that sets the status, exactly as `beginCapture` has always
done. Both are needed: the ledger ignores the amount on a duplicate, but
if the transfer never posted the retry has to be for the amount
originally requested, which a partial refund makes different from the
outstanding balance. A sweep then re-issues the same transfer, which is
a no-op if it already posted and the missing movement if it did not.

Rows stranded before this existed cannot be recovered automatically, and
the sweep says so rather than guessing.

#### The update that silently dropped new columns

`save` is an optimistic-locked `UPDATE` that named the columns it wrote.
`refund_transfer_id` was added to the aggregate, the entity and the
mapper; it compiled; it never reached the database. Nothing in the type
system connects "the aggregate has a field" to "this `.set({…})`
mentions it".

The mutable set is derived by *subtracting* the columns fixed at
creation now, so a new field persists by default and a newly immutable
one is a deliberate edit. Found by writing the round-trip test rather
than by reading the code.

### The safety net had holes in it

Reconciliation is what catches everything the other checks miss: a trial
balance that must be zero by construction, and a projection that must
match the journal. Three defects, all of the shape *the check does not
cover what you think, and cannot tell you when it fails*.

#### The trial balance skipped currencies

```sql
SELECT DISTINCT currency FROM ledger.wallets
```

Postings are written to accounts that are not wallets — `house_fees` and
`external` are both in the chart of accounts — so a currency used only
between those, or one whose wallets were all closed, was never checked at
all. The blind spot sat exactly where the check matters: a posting
written outside the aggregate is the thing a trial balance exists to
catch, and it was invisible precisely when it landed somewhere without a
wallet. The postings are the ledger; they are what gets asked now.

#### The alarm crashed instead of firing

```ts
`TRIAL BALANCE BROKEN for ${currency}: ${Money.fromMinor(total, currency)}`
```

`Currency.of` throws on a code it does not know. So the one branch that
runs only when the ledger is already broken threw instead of logging —
and because the reports run in a loop, it took the remaining currencies'
alarms with it. An unregistered currency in the postings is not an exotic
input here: it is one of the ways the trial balance breaks in the first
place.

This one was found by a test written for the bug above: adding a CHF
posting to prove the currency was now discovered made the job crash.

The amount is formatted defensively now, and each currency's report is
isolated from the others.

#### The most important check had no metric

`reconciliation_drift_minor_units` was a gauge. The trial balance — the
cheaper, stricter, more serious check — produced a log line and nothing a
rule could fire on. It is `ledger_trial_balance_minor_units` now, and
healed projections are counted in `reconciliation_healed_total`, because
a sweep that heals the same wallets every cycle is masking a live bug and
that is only visible if the healing itself is counted.

### Two bugs found by refusing to call a flaky test flaky

#### The outbox read one clock and wrote another

An integration test failed about one run in three: two appended rows,
one claimable row. The tempting read is "containers, timing, retry it".

`append` stamped `available_at` with `new Date()` — the **application's**
clock. The relay selects `WHERE available_at <= now()` — the
**database's**. Two clocks, one comparison. A writer running a few
milliseconds ahead publishes events the relay cannot see until real time
catches up, and since every pod has its own offset, the delay differs per
writer. The column already carried `DEFAULT now()`; the application was
overriding the right answer with a worse one.

In the test environment the host and the Postgres container disagreed by
just enough to make it visible a third of the time. In production it is
the same bug with better-synchronised clocks — a smaller, permanent,
invisible delay in the component whose entire job is that no event is
lost.

`occurred_at` still comes from the application, and should: it records
when the domain event happened, which is a fact about the business rather
than a scheduling decision the database ever evaluates.

The regression test moves the process clock five minutes forward and
asserts the row is still claimable — it fails on the old code, which is
the only thing that makes it a regression test.

#### The recovery sweep could mint a second transfer

```ts
// Re-issue the *same* command with the *same* transferId. The ledger's
// unique key turns a duplicate into a no-op, so this is safe …
transferId: row.transfer_id ?? randomUUID(),
```

The comment is correct and the code contradicts it on the last line. The
ledger deduplicates on `transferId`, so a generated id is not a retry —
it is a second transfer. And this is a cron: it would mint another one
every five minutes, each a fresh id, until somebody noticed the balance.

It was unreachable, because `beginCapture` sets the status and the id in
the same step. That invariant lived only in code. It is a database
constraint now (`ck_payments_capturing_has_transfer`), and the sweep
refuses such a row and increments `recovery_skipped_total` rather than
guessing — because a compensation job that silently skips looks exactly
like one with nothing to do.

### What a deep audit turned up

Four defects, all of the same shape: a control that looks present and is
not actually enforced.

#### SSRF: the guard matched a regular expression, not an address

A merchant chooses the webhook URL and our workers sit inside the
network, so the URL is attacker-controlled input aimed at our perimeter.
The guard matched a dotted quad — which meant **every IPv6 literal walked
past it**: `https://[::1]/` and `https://[fd00::1]/` were both stored as
public endpoints.

It also only ever checked a *string*. `hooks.example.com` resolving to
`10.0.0.1` passed, and a name validated on Monday can point inward on
Tuesday. A stored rule nobody re-enforces is not a control.

Now `isPrivateHost` understands both families — expanding IPv6 into its
eight groups rather than pattern-matching text, so `fd00::1` and
`fd00:0:0:0:0:0:0:1` give the same answer, and unwrapping IPv4-mapped and
NAT64 addresses — and the worker re-checks the *resolved* address
immediately before it connects.

The second half of that fix was wrong on the first attempt, and the test
caught it: treating "DNS did not answer" as "unsafe" meant a thirty-second
resolver blip would bury deliveries as permanently unrecoverable. The
classification is three-valued for that reason — `unresolved` lets the
request proceed and fail through the ordinary retry schedule.

This narrows the window rather than closing it; between the lookup and the
socket the name can answer differently again. Closing it fully means
pinning the resolved address onto the connection.

#### An unhandled rejection handler that prevented the restart it promised

```ts
// … let the orchestrator restart a clean one.
process.on('unhandledRejection', (reason) => { logger.error(reason) })
```

Since Node 15 the default for an unhandled rejection is to crash.
Registering a listener silently *replaces* that default, so a handler that
only logs does the opposite of what it reads like: it keeps a process
whose integrity is unknown in the load balancer, serving payments. It now
logs synchronously and then drains and exits non-zero.

#### The ledger's amounts were immutable; its explanations were not

`postings` had an append-only trigger and the foreign key is `ON DELETE
RESTRICT`, so no entry carrying postings could be deleted. But
`UPDATE ledger.journal_entries SET description = …` succeeded — and the
entry is what records *why* the money moved. Half an audit trail. The
ledger only ever appends, so the trigger now covers both tables.

#### A cache keyed by attacker-chosen data with no eviction

One `CircuitBreaker` per webhook host, each with a 50-slot ring buffer,
inserted and never removed. Bounded now, with idle hosts evicted.

### GraphQL and the query plans underneath it

One `@ResolveField` exists — `Payment.merchant` — and it goes through a
DataLoader created per request. Measured on a 50-payment page: **one
access to the `merchants` table per request** instead of fifty, because
the batch collapses to a single `WHERE id IN (…)` and the per-request
memo folds repeated ids together. Per request and never process-wide: a
shared loader would serve one customer's merchant out of another's cache
and never notice an update.

Everything else is a root query, so there is no deeper N+1 to find. The
interesting problems were a layer down.

#### The `OR` that quietly disabled keyset pagination

A user's listing must include transfers where they are the *destination*,
which read naturally as:

```sql
WHERE user_id = $1 OR counterparty_user_id = $1
ORDER BY created_at DESC, id DESC LIMIT 26
```

A disjunction over two columns cannot be served by either column's index.
Measured over 400 000 payments:

| | plan | buffers | time |
|---|---|---|---|
| by merchant (no `OR`) | Index Scan | 29 | 0.24 ms |
| by user (with `OR`) | **Parallel Seq Scan + top-N sort** | **9 839** | **40 ms** |

Same query shape, 340× the work — and growing with the table rather than
with the page, which is the one thing keyset pagination exists to
prevent. `ix_payments_user_created` was sitting there unused.

Splitting the disjunction into two branches lets each walk its own
`(owner, created_at DESC, id DESC)` index in order, limited to one page
each, and the merge then sorts at most `2 × limit` rows however big the
table gets. Total after the change: **31 buffers**. The second branch
needed `ix_payments_counterparty_created`, which replaces the plain
single-column index it supersedes.

The risk moves with the fix — a merge that disagrees with the branch
ordering drops or repeats rows across a page boundary — so
`payments-pagination.e2e-spec` pages through interleaved data at five
different page sizes and asserts the result equals what one sorted query
would return, including when timestamps collide.

#### What the audit cleared

- The expiry cron's own SQL (`status IN ('pending','authorized')`) does
  imply the partial index predicate and uses it: **3 buffers, 0.06 ms**.
- `PaymentRepository.findExpired` was a second, unused implementation of
  that sweep whose `status NOT IN (…)` would *not* match the index, and
  which also selected `refunding` payments that the aggregate's state
  machine can never expire. Dead code that is also wrong is a trap for
  whoever calls it next; deleted.
- The ledger's statement query projects explicit columns over one join and
  orders along `(owner_id, currency, posted_at DESC, id DESC)` — already
  index-aligned.
- `ix_wallets_user` was a strict prefix of `uq_wallets_user_currency`, so
  it was maintained on every write and never chosen. Dropped.
- `payment stats` runs a single pass with `count(*) FILTER (…)` rather
  than four round trips, and is cached for a minute; 13 ms over a 30 000
  row window is not where the next hour belongs.

### Typing and validation: the boundary is the only place to check

Every input crossing into the process is validated where it arrives, and
after that the types are true — so nothing downstream re-checks and
nothing downstream has to wonder.

| Boundary | Validated by | Failure |
|---|---|---|
| REST body and query | class-validator DTOs, global `ValidationPipe` | 400 + per-field Problem Details |
| GraphQL arguments | `@ArgsType` classes + schema enums | `BAD_USER_INPUT` with the field messages |
| Kafka message | the contract's Zod schema, at the consumer | straight to the DLQ, never retried |
| WebSocket frame | Zod, in the handler | `WsException` |
| Environment | Zod, once, at boot | the process refuses to start |

The pipe runs with `whitelist`, `forbidNonWhitelisted` and
`transform`, and with `enableImplicitConversion` **off** — implicit
coercion turns `?limit=abc` into `NaN` somewhere deep in a handler
instead of into a 400 at the edge, so every numeric query parameter asks
for conversion explicitly.

The catch that caught us: `ValidationPipe` only inspects a parameter that
has a DTO *class*. Four endpoints took bare `@Query('limit') limit?:
string` and were therefore not validated at all — `?limit=abc` reached
SQL as `NaN`, `?limit=-5` as a negative `LIMIT`, `?limit=999999` let one
request decide how much memory the process used, and `?from=garbage`
became an `Invalid Date` that surfaced as a **500**: a client mistake
reported as a server fault, which lies to the caller and spends the error
budget. They all have DTOs now, and the page-size ceiling is defined
once in `@payhub/shared` rather than three times with three values.

GraphQL had the mirror of the same problem: bounds applied by hand in the
resolver with `Math.min(limit, 100)`, which bounds from above only, and a
`status as PaymentStatus` assertion the compiler accepted and nothing
checked. The arguments are declared types now, so the schema rejects a
bad enum before the resolver runs and the cast is gone.

#### Strictness

`strict`, plus `noUncheckedIndexedAccess`, `noImplicitOverride`,
`noImplicitReturns`, `noFallthroughCasesInSwitch`, `noUnusedLocals`,
`noUnusedParameters`, `noPropertyAccessFromIndexSignature` and
`exactOptionalPropertyTypes`.

The last one earns its place: without it `{ merchantId: undefined }`
satisfies `{ merchantId?: string }`, which is how an accidental
`undefined` reaches a partial update and erases a column. Turning it on
found nine places passing an explicit `undefined` where the target meant
"absent" — including a `sasl` object cast with `as` that was hiding a
union it did not actually satisfy.

There is no `any` in the production code, and one non-null assertion.

### Caching: three layers, three different reasons

| Layer | What it holds | Invalidated by | Why this strategy |
|---|---|---|---|
| **HTTP validator** (`@HttpCache`) | nothing — an `ETag` | a version bump | the client already has the body; the cheapest response is the one with no body |
| **Value cache** (`CacheService`) | rendered read models | TTL + explicit bust | the work is expensive and shared across callers |
| **Credential cache** (`ApiKeyAuthenticator`) | the facts about one API key | 30s TTL + bust on revoke | on every single request, and security-sensitive |

#### Conditional GET that actually skips the work

Express emits a weak `ETag` and answers `If-None-Match` with a 304 out of
the box — after the handler has run, queried Postgres and serialised a
body it then throws away. That saves bandwidth and nothing else.

`@HttpCache` declares which *resource scopes* a response is derived from.
The validator is built from version markers held in Redis, so a
revalidation costs one `MGET` and returns before the handler is ever
invoked. Measured on `GET /payments`, 40 conditional requests:

```
40x plain        → 40x 200, 39 scans of the payments table
40x If-None-Match→ 40x 304,  0 scans
```

Writers bump the scopes they affect, through the same in-process event
that already drives the WebSocket push — so there is one place that knows
"a payment moved", and no write path has to remember to invalidate
anything.

Two headers matter more than the saved query. `Cache-Control:
private, no-cache` states what is actually true of a balance — store it,
never reuse it without asking — where the framework default states
nothing and lets intermediaries guess. And `Vary: Authorization`, because
the URL is not the cache key when the bearer token decides the body;
omitting it is how one customer's statement reaches another. The `ETag`
folds in the principal as well, so even a cache that ignored `Vary` could
not produce a cross-user hit.

Version markers are random tokens, not counters. Nothing needs ordering —
an `ETag` is only ever compared for equality — and a counter that expired
and restarted at 1 would make a client's old validator match again and
serve a stale balance. A random token cannot collide, so the worst an
expiry can do is cost one extra 200.

#### Invalidating after the commit, not during it

`TransactionManager.afterCommit()` defers a side effect until the
transaction is durable. Busting a cache key *inside* the transaction
opens a window where a concurrent reader misses, reads the pre-commit row
and repopulates the cache with the old value: the write lands and the
cache is stale with no further event coming to fix it. The same reasoning
covers anything the outside world can observe — a push for a payment that
then rolls back is worse than one that arrives a millisecond later.

#### What is deliberately *not* cached

Creating a payment loads the merchant to resolve its fee policy. That
looks like an obvious caching target and is not one: it is a primary-key
index scan costing **0.053 ms and two buffer hits**, against a ~51 ms
request — roughly a tenth of a percent. Caching it would buy nothing
measurable and would put a merchant's *suspended* status behind a TTL,
trading a compliance control for a rounding error.

The `api_keys` lookup is the opposite case and is cached: same shape of
query, but on **every** request from every integration rather than once
per payment, and the negative entries matter on their own — without them
an unauthenticated flood of invented keys becomes one Postgres query per
attempt, a load amplifier that needs no credentials.

### Kafka topology: retries live in topics, not in memory

Each consumer group gets its own ladder next to the topic it consumes:

```
payhub.ledger.commands.v1                          ← the real topic
payhub.ledger.commands.v1.payhub-ledger.retry.1    ← 1s
payhub.ledger.commands.v1.payhub-ledger.retry.2    ← 5s
payhub.ledger.commands.v1.payhub-ledger.retry.3    ← 30s
payhub.ledger.commands.v1.payhub-ledger.retry.4    ← 2m
payhub.ledger.commands.v1.payhub-ledger.retry.5    ← 10m
payhub.ledger.commands.v1.payhub-ledger.dlq        ← terminal, 30d retention
```

Retrying in-process would hold the partition for ten minutes and starve
every other message behind it, so a failure is re-published one level down
with an incremented `x-attempt` header. The delay is enforced by pausing
the partition and seeking back to the offset — never by sleeping, which
would miss heartbeats and trigger a rebalance. The ladder is per consumer
group, so one slow consumer cannot delay another's traffic on the same
topic.

What does **not** go on the ladder: a schema violation, an unparseable
envelope, and any deterministic domain rejection. Those go straight to the
DLQ, because replaying them five times produces the same error five times.
Only `DependencyFailureError` and the `unavailable` / `conflict` domain
kinds are treated as retryable.

Every one of these topics — the DLQ included — is created at startup, by
the consumer, before it subscribes. Leaving the DLQ to broker
auto-creation works in development and fails in production, where
auto-creation is off: the dead-letter publish throws *inside the error
path*, and the poison message is redelivered forever. A missing topic
therefore aborts the boot instead.

Dead letters are not subscribed to. The message is stored verbatim with
`x-original-topic` pointing at the **base** topic, so replay tooling
re-enters the ladder at the beginning rather than halfway down it with a
stale attempt count.

### Double-entry, enforced three times

1. The `JournalEntry` aggregate refuses to exist unless debits equal credits
   per currency.
2. The database carries `CHECK` constraints (`amount_minor > 0`, no
   overdraft) and an `AFTER UPDATE OR DELETE` trigger that makes `postings`
   genuinely append-only — application code is not the last line of defence
   for an audit trail.
3. Reconciliation asserts that the signed sum of every posting is exactly
   zero, and that the wallet projection matches the journal. When they
   disagree, the journal wins and the projection is rewritten.

Corrections are reversals, never updates. The original entry stays visible,
which is what auditors and support agents both need.

### Double-spend: two independent defences

`SELECT … FOR UPDATE` on the wallet row inside the posting transaction, plus
an optimistic `version` column that catches a lost update if a future code
path forgets the lock. Wallets are always locked in ascending id order, so
two transfers crossing in opposite directions cannot deadlock.

There is an integration test for exactly this: ten concurrent withdrawals of
20.00 against a balance of 100.00 settle **five** and reject five. Without
the row lock all ten read "100.00 available", all ten pass, and the wallet
goes negative.

### Money is allocated by largest remainder

Splitting 0.05 by weights `[5, 1]` has to give somebody the odd cent.
Handing leftovers to the first shares in array order sums correctly but is
*biased*: it would pay `[0.05, 0.00]`, giving the cent to the share with a
1/6 claim instead of the one with 5/6. `Money.allocate` ranks the exact
integer remainders (`amount × weight mod total`) and pays the largest
first, ties broken by position — Hamilton's method, with no floats
anywhere.

### Transactional outbox

Every integration event is written to an outbox table **in the same
transaction** as the state change it describes. A relay drains it into Kafka
afterwards. We trade "exactly once" — impossible across two systems without
2PC — for "at least once plus idempotent consumers", which is what actually
ships. The consumer side inserts into an inbox table inside its own
transaction, so a redelivery hits a primary key and is skipped.

The relay claims rows with `FOR UPDATE SKIP LOCKED` **and a lease**: a naive
relay that flips rows to `publishing` and relies on itself to flip them back
strands every event it was holding when it crashed, silently, because the
next poll only looks at `pending`.

Two places where "idempotent" has to be *observable*, not just safe:

- The inbox claim reads its answer from `RETURNING`, never from TypeORM's
  `result.identifiers` — that array is filled from the values the query was
  *given*, so an `ON CONFLICT DO NOTHING` that inserted nothing still reports
  success and deduplication silently does nothing at all.
- `Payment.completeCapture` returns `'captured'` or `'already-captured'`.
  A redelivery that merely "succeeds quietly" would have the saga publish
  `payment.captured` a second time — and the merchant receives a second
  webhook for one payment.

### Circuit breakers measure a rate, not a streak

Counting *consecutive* failures never opens the breaker for the failure mode
that matters most: a dependency answering half its calls with a 503. Every
failure is followed by a success, the counter resets, and traffic keeps
burning. `CircuitBreaker` keeps a count-based sliding window (a ring buffer
of the last N outcomes) and trips on the failure *rate*, with a minimum
sample count so one early failure cannot trip a cold pod. Half-open admits
exactly one probe at a time — letting a burst through on the transition is
how a recovering dependency gets knocked straight back over.

### Locks: the right one for the job

Two implementations, used where each is actually correct.

*Redis* (`DistributedLockService`) for **efficiency** locks — do not run the
same cron on three pods. A double run there is wasteful, not wrong.
Deliberately not the five-node Redlock algorithm: Kleppmann's objection
stands, since Redlock's safety argument depends on bounded clock drift and
bounded GC pauses, neither of which hold on real hardware. It hands out a
**fencing token** for resources that can check one.

*Postgres advisory locks* for **correctness** locks. The lock and the data
live in the same system, so `pg_advisory_xact_lock` is released by the same
commit that makes the work visible — there is no window where the lease
expired while the transaction is still in flight.

### Two cache tiers, and why the first one is tiny

`CacheService` is Redis plus an in-process LRU with a ~1 s TTL. The local
tier is not a cache in the usual sense: nothing can invalidate it from
another replica, so when a payment settles, *this* pod evicts the key and
the other three keep their copies until they expire. Keeping it to about a
second makes it a **coalescing window** — it collapses the repeated reads of
one dashboard render and takes the hot key off Redis — while bounding
staleness below what anyone can perceive. The LRU itself rides on `Map`
insertion order (delete-and-reinsert on read), so get, set and evict are all
O(1) with no linked-list nodes to allocate.

### Caching, with the three failure modes named

`CacheService` handles stampede (in-process single-flight plus a short Redis
lock electing one recomputing node), penetration (a negative marker with a
short TTL, so lookups for keys that do not exist cannot be aimed at the
database) and avalanche (jittered TTLs). Pattern invalidation uses `SCAN`,
never `KEYS` — `KEYS *` blocks the single-threaded server for its whole
scan.

### Idempotency, the Stripe contract

Same key and same body replays the original response with
`idempotent-replay: true`. Same key and a *different* body is a client bug
and gets `409 IDEMPOTENCY_KEY_REUSED`. A retry while the original is still
running gets `409 IDEMPOTENCY_KEY_IN_PROGRESS`, because a half-finished
state is worse than asking the client to come back. Failures are never
memoised — a transient 500 must not be replayed for 24 hours.

The record is written *before* the response is emitted. With a
fire-and-forget write, a client that retries immediately races the write and
gets a spurious 409.

### Auth

Short-lived JWT access tokens (self-contained, so authorisation needs no
database round trip) plus **opaque** refresh tokens stored hashed. The
asymmetry is deliberate: a long-lived JWT cannot be revoked, while an opaque
token is revoked by deleting a row. Refresh tokens rotate on every use, and
presenting a used one revokes the whole family — the standard reuse-detection
mitigation from RFC 9700. Access tokens are checked against a short Redis
denylist so "log out everywhere" works without a per-request database hit.

Passwords use argon2id at the OWASP parameters, with transparent re-hashing
when the policy tightens. API keys do **not**: a 256-bit random secret has
no guessable structure, so an HMAC with a server-side pepper is sufficient
and fast enough to run on every request. The login endpoint burns the same
time whether or not the account exists.

### Error handling

Domain failures are `Result` values, not exceptions — the type system forces
the caller to handle them. Exceptions stay for genuinely exceptional
conditions. At the HTTP edge everything becomes RFC 9457 problem details
with a stable machine-readable `code` and a correlation id, including
translated Postgres SQLSTATEs: a unique violation is a 409, a serialization
failure is a 409 that says "retry", a statement timeout is a 504. A blanket
500 tells a client nothing.

---

## Layout

```
libs/
  kernel/         Result, Money, Entity/AggregateRoot, DomainEvent — zero framework imports
  contracts/      versioned integration events + Zod schemas, shared by producer and consumer
  config/         one Zod schema for every env var; invalid config fails the process at boot
  persistence/    DataSource, unit of work, @Transactional, outbox + inbox, advisory locks
  redis/          cache, locks, idempotency, token bucket, throttler storage (all Lua-atomic)
  messaging/      Kafka producer/consumer, retry topics, DLQ, outbox relay
  queue/          BullMQ wiring
  observability/  pino + CLS, Prometheus, Terminus probes, OpenTelemetry, graceful shutdown
apps/
  api/ ledger/ worker/ notifications/
web/              React dashboard: REST + GraphQL + WebSocket + SSE
k8s/              manifests, with the reasoning in k8s/README.md
```

Inside each context: `domain/` (aggregates, value objects, ports),
`application/` (use cases), `infrastructure/` (adapters),
`presentation/` (controllers, resolvers, consumers). Dependencies point
inwards only, and `test/architecture.spec.ts` **fails the build** if they
stop doing so — a layering rule that lives only in a README decays within a
quarter.

---

## Testing

| Layer | How | What it proves |
|---|---|---|
| Domain | plain `new`, no framework | invariants: unbalanced entries impossible, no overdraft, legal transitions only, fair allocation |
| Application | `Test.createTestingModule` with ports stubbed | orchestration, compensation and saga replay, without a database |
| Integration | Testcontainers: real Postgres **and** real Redis | row locks, deadlock ordering, triggers, `CHECK` constraints, `SKIP LOCKED`, lease expiry, and every Lua script |
| Architecture | import graph assertions | the dependency rule and the context boundaries |

Coverage is uneven on purpose. The domain and the kernel — where the money
logic lives — sit at 70–88 % from unit tests alone (contracts at 100 %);
adapters and infrastructure are covered by the integration suites instead,
because asserting on a mocked `QueryBuilder` proves nothing a real `FOR
UPDATE` does not prove better.

Three bugs in this repository were found by writing those tests, not by
reading the code: deduplication that always returned "fresh", a saga that
booked a 40.00 partial refund as the full 100.00, and a redelivery that
published a second `payment.captured`. All three are quiet in production
and invisible to a type checker.

Vitest needs `unplugin-swc`: it transforms with esbuild, which cannot emit
`design:paramtypes`, so without SWC every type-injected provider resolves to
`undefined` — in the tests only, which makes it a deeply confusing
afternoon.

---

## Things that are deliberately not here

- **A PSP integration.** `CardPaymentProvider` is a fake with real
  resilience around it (retry ladder, circuit breaker, scenario hooks).
  Swapping in Stripe is a new class behind `PaymentProvider` and a registry
  entry — no `switch` in the domain.
- **Stateful infrastructure in Kubernetes.** See `k8s/README.md`.
- **Pruning of financial records.** The retention job touches the outbox,
  the inbox and expired sessions. Payments, journal entries and postings are
  never deleted; archiving them is a different conversation.

## Known rough edges

- Kafka consumers start at the latest offset (`fromBeginning: false`), so an
  event published while a consumer is down is skipped. That is the right
  default for a first deploy, and the stuck-payment cron re-issues the
  command — idempotently — as the backstop. A production platform would
  reset the offset deliberately after an incident instead.
- The assistant is read-only and grounded in a compact snapshot of the
  user's own data. It is `LLM_ENABLED=false` by default; it needs an
  `ANTHROPIC_API_KEY` to do anything.
