# Security remediation workflow

## 1. Lock evidence and scope

Record:

- asset and boundary;
- actor and precondition;
- controllable path;
- current control and bypass;
- impact;
- safe reproducible evidence;
- authorized files/configurations;
- test that must fail before the fix.

If the protection may be in a gateway, WAF, IAM, RLS, service mesh, or external platform that was not provided, do not assert its absence. Request the configuration or report `depends on infrastructure`.

## 2. Choose the correct boundary

- Authorization: server and resource access, not only route/UI.
- Isolation: query/policy/storage/cache/event, not a subsequent filter.
- Validation: before the sink or change in trust.
- Rate limit: close to the abuse surface, with a key and storage consistent with the deployment.
- Secret: secret manager/secure configuration, not obfuscation.
- State: transaction, constraint, idempotency, or state machine, not a visual flag.

If a secret has already been exposed, removing it from the code prevents new exposures but does not invalidate existing copies. Record scope and window, block new use when authorized, and require confirmed revocation or rotation. Do not perform actual rotation, production changes, or revocation without specific authorization; escalate it as residual risk until confirmation.

## 3. Fix rate limiting and consumption

Before implementing, define:

1. protected action and cost;
2. actor/limit key;
3. burst, window, and sustained rate;
4. behavior across multiple instances;
5. response and retry;
6. observability;
7. impact on NAT, proxies, accessibility, and legitimate users;
8. complementary limits for payload, batch, pagination, timeout, concurrency, queue, and spend.

Prefer the mechanism already adopted in the gateway/framework. A local in-memory counter does not protect a deployment with multiple instances and resets with the process. Do not copy `100 requests/minute` as a universal value. If the product/capacity does not define a threshold, implement a configurable structure only when the need is real and record the value as a pending decision.

Test at least: below the limit, at the limit, above the limit, recovery after the window, distinct keys, concurrency, and bypass through a header/alternative endpoint.

## 4. Preserve function and usability

- Do not remove functional code merely to silence a scanner.
- Do not block every user to prevent abuse by a few.
- Do not turn an authorization failure into a leak through differing messages.
- Do not weaken cryptography, validation, or a test to restore compatibility.
- Do not introduce a dependency without verifying existence, version, maintenance, and local architecture.

## 5. Validate in layers

1. specific negative test;
2. positive test that preserves legitimate use;
3. regression for the area;
4. static analysis/configuration already adopted by the project;
5. manual review of the diff and data path;
6. verification of logs, errors, and telemetry;
7. suite proportionate to the impact.

Update the threat model if the fix changes architecture, flow, asset, actor, boundary, integration, or environment. For shared-consumption controls, also validate noisy neighbor behavior and concurrent legitimate use.

A clean scanner does not conclude the work. A scanner outcome requires manual validation; the absence of an alert does not cover business logic, contextual authorization, tenant, external rate limit, or concurrency.

## 6. Report

For each finding, report:

- cause and risk;
- implemented control;
- file/configuration;
- test before/after;
- commands and outcomes;
- legitimate behavior preserved;
- limitations and external dependencies;
- residual risk and monitoring;
- additional approval required.
