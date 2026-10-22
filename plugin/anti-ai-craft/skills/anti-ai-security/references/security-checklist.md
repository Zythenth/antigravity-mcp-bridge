# Contextual security checklist

## Summary

- [Threat model and surfaces](#threat-model-and-surfaces)
- [Authentication and session](#authentication-and-session)
- [Authorization and isolation](#authorization-and-isolation)
- [Rate limiting and resources](#rate-limiting-and-resources)
- [Input, output, and execution](#input-output-and-execution)
- [Browser and client](#browser-and-client)
- [Uploads, files, and active content](#uploads-files-and-active-content)
- [Secrets, cryptography, and configuration](#secrets-cryptography-and-configuration)
- [Dependencies and supply chain](#dependencies-and-supply-chain)
- [Logging, monitoring, and privacy](#logging-monitoring-and-privacy)
- [Flows and concurrency](#flows-and-concurrency)
- [Systems that use models or agents](#systems-that-use-models-or-agents)
- [External themes or tokens](#external-themes-or-tokens)
- [Minimum tests by risk](#minimum-tests-by-risk)

Use only the applicable categories. Mark `confirmed`, `present`, `not applicable`, `depends on infrastructure`, or `unverified`; never convert an unverified item directly into a vulnerability.

## Threat model and surfaces

- [ ] Assets, sensitive data, actors, roles, and tenants identified.
- [ ] Processes, datastores, flows, external entities, and boundaries diagrammed to a depth proportionate to the risk.
- [ ] Production, CI/build, local, examples, tests, and generated content are separated.
- [ ] Inputs controllable by an attacker, operator, developer, and provider were distinguished.
- [ ] Public, administrative, internal, asynchronous, and third-party inputs inventoried.
- [ ] Trust boundaries and credentials between components recorded.
- [ ] Business abuses and confidentiality, integrity, availability, and cost impacts considered.
- [ ] Existing controls were located before declaring their absence.
- [ ] Realistic attack stories and out-of-scope items are recorded.
- [ ] The threat model was updated after any discovery or change in architecture, flow, asset, actor, boundary, integration, or environment.
- [ ] An information architecture change that created an input, role, action, state, integration, data exposure, or expensive operation triggered revalidation; a solely aesthetic change did not trigger a broad review.
- [ ] Public, internal, beta/staging, and legacy hosts, admin/debug endpoints, and exposed schemas/documentation are inventoried.
- [ ] Version retirement plans and use of real data outside production are verified.
- [ ] Third-party services and the data shared with them are in the inventory.

## Authentication and session

- [ ] Passwords use an appropriate stack primitive, a coherent policy, and secure comparison.
- [ ] Login, MFA, OTP, reset, and recovery resist enumeration, replay, and brute force.
- [ ] Tokens have audience, issuer, expiration, signature, and algorithm validated according to the protocol.
- [ ] Sensitive cookies use appropriate `Secure`, `HttpOnly`, and `SameSite` settings.
- [ ] The session is renewed after authentication/elevation and invalidated on logout, revocation, and critical change.
- [ ] Errors do not reveal whether an account, email, phone number, or tenant exists without need.

## Authorization and isolation

- [ ] The actor × input × action × resource × property × tenant × state matrix was exercised.
- [ ] Every protected action validates authorization on the server.
- [ ] Client-controlled IDs undergo object- and tenant-level authorization.
- [ ] Sensitive read and write fields use an allowlist; no mass assignment.
- [ ] Low-privilege roles cannot access administrative functions through a URL, alternative method, or direct API.
- [ ] Queries, cache keys, queues, storage paths, and events preserve tenant/ownership.
- [ ] RLS, ACL, IAM, or external policy is proven and tested, not merely assumed.
- [ ] Table role and owner do not bypass RLS unexpectedly.
- [ ] Services preserve the original identity and do not become a confused deputy.
- [ ] Revocation, stale cache/token, onboarding, offboarding, export, and deletion preserve isolation.
- [ ] All equivalent versions, jobs, webhooks, queues, search, and internal tools were inventoried.
- [ ] Tests cover user A/B, tenant A/B, roles, and nonexistent objects.

## Rate limiting and resources

- [ ] Layer, routes, methods, versions, aliases, batch/GraphQL, and internal endpoints are covered.
- [ ] The limit key matches the abuse: identity, token, tenant, endpoint, trusted IP, or a combination.
- [ ] Trusted proxies and IP headers are configured without allowing spoofing.
- [ ] Burst and sustained rate are limited with storage consistent across multiple instances.
- [ ] Shared-store operations are atomic and the limiter failure policy is explicit.
- [ ] Login, OTP, reset, invitation, registration, and paid operations have their own limits.
- [ ] Body, string, array, upload, batch, pagination, GraphQL, and export have maximums.
- [ ] Timeout, cancellation, backpressure, concurrency, and retry are finite.
- [ ] Jobs and queues have deduplication/idempotency and a growth limit.
- [ ] Billed integrations have a budget, quota, or cost alert.
- [ ] Noisy neighbor was exercised: one user or tenant does not degrade others' pools, queues, CPU, memory, connections, storage, quotas, or budget.
- [ ] Isolation, fairness, priority, backpressure, and per-tenant/user limits exist where resources are shared.
- [ ] The excess response is consistent (`429` when applicable), observable, and does not create a bypass.
- [ ] Thresholds come from capacity, cost, UX, and threat; arbitrary values are marked as a pending decision.

## Input, output, and execution

- [ ] Input validates type, format, range, size, semantics, and unexpected fields.
- [ ] SQL/ORM uses parameters; shell avoids concatenation; template/HTML applies contextual encoding.
- [ ] Paths are normalized, confined, and do not accept traversal.
- [ ] Outbound URLs restrict scheme, host, redirects, DNS/rebinding, and internal networks as appropriate.
- [ ] Deserializers and parsers are in secure mode and have limits.
- [ ] Content-Type, HTTP method, and size are allowlisted.
- [ ] Outputs do not expose internal fields, secrets, stack traces, or unnecessary PII.

## Browser and client

- [ ] CORS uses deliberate origins, methods, and credentials; it does not blindly reflect the origin.
- [ ] Cookie-session operations have applicable CSRF protection.
- [ ] CSP and other headers are consistent with the application, without copying configuration that breaks the product.
- [ ] Secrets and real authorization do not depend on the bundle, local storage, route guard, or hidden button.
- [ ] Redirects and external links are validated.
- [ ] The UI map and endpoint inventory agree; direct route, old link, refresh, and state restoration revalidate authentication, authorization, and tenant.
- [ ] URL, history, cache, and client storage do not carry unnecessary secrets or sensitive data.

## Uploads, files, and active content

- [ ] Extension, actual type, size, name, and content are verified by allowlist/context.
- [ ] The file is stored outside the webroot or served by an authorized handler.
- [ ] The name/path is generated by the server and does not overwrite an arbitrary file.
- [ ] Processors resist compressed/bomb files and have bounded time/memory.
- [ ] Download revalidates authorization and uses secure headers.

## Secrets, cryptography, and configuration

- [ ] No secret appears in code, client, log, fixture, image, or error.
- [ ] Secrets have least privilege, rotation, revocation, expiration, and environment separation.
- [ ] For a secret already exposed, removal from the code was not treated as resolution; scope, containment, and revocation/rotation were required and their status was confirmed or escalated.
- [ ] TLS is required where data/credentials cross an untrusted network.
- [ ] Cryptography uses a stack-approved library and algorithm; keys are not stored with the ciphertext without a justifiable model.
- [ ] Debug, default password, administrative endpoint, and public storage are disabled/restricted by default.
- [ ] Missing config fails explicitly and securely, without a silent default allow.

## Dependencies and supply chain

- [ ] Suggested packages exist, are necessary, and match the correct name/registry.
- [ ] Manifest and lockfile agree; resolution does not depend on a dangerous floating version.
- [ ] Existing alerts, vulnerable versions, and unmaintained software were considered.
- [ ] Build/CI does not execute untrusted input with a secret or excessive permission.
- [ ] The diff was reviewed for new network or shell execution in build, install, generation, test, CI, and deploy.
- [ ] Every new network/shell execution has its need, origin, version/integrity, arguments, privileges, credentials, and failure behavior verified.
- [ ] Artifacts and images have verifiable provenance, integrity, and updates when the project requires it.
- [ ] A new external font, image, stylesheet, script, or visual library has its need, origin, privacy, CSP, integrity, performance, cache, fallback, and degraded behavior evaluated.

## Logging, monitoring, and privacy

- [ ] Authentication, authorization, validation, and rate-limit failures generate useful events.
- [ ] Logs have correlation, an appropriate actor/tenant, and protection against log injection.
- [ ] Tokens, passwords, keys, sensitive content, and unnecessary PII are not logged.
- [ ] Alerts have a consumer and threshold; logging is not unactionable noise.
- [ ] Data retention, deletion, export, and minimization follow the applicable requirement.

## Flows and concurrency

- [ ] State order is validated on the server.
- [ ] Price, discount, ownership, role, and permission are recalculated on the server.
- [ ] Financial, credit, inventory, invitation, and confirmation operations resist replay and double submission.
- [ ] A dishonest-user pass tried lying about identity, tenant, state, quantity, price, eligibility, sequence, and prior success to obtain a benefit.
- [ ] Skipped, repeated, and out-of-order steps and TOCTOU were exercised.
- [ ] Functions that dispense value have a limit per business flow, not only a generic endpoint limit.
- [ ] An idempotency key is bound to the actor, operation, and payload when used.
- [ ] Transactions, locks, unique constraints, or compare-and-set protect concurrent invariants.
- [ ] Partial failure has observable rollback or compensation.

## Systems that use models or agents

- [ ] External content is treated as data, not as a trusted instruction.
- [ ] Issues, PRs, README, logs, pages, and tool responses cannot silently redefine persistent instructions.
- [ ] Tools, files, network, and secrets follow least privilege.
- [ ] Model output is validated before SQL, shell, HTML, URL, parser, or external action.
- [ ] Human approval exists for destructive or high-impact actions.
- [ ] Costs, tokens, concurrency, and context size have limits.
- [ ] Invented packages/typosquatting and changes to agent configuration, CI, and install/deploy scripts were reviewed.
- [ ] Removed tests, weakened assertions, substitute mocks, and out-of-scope changes were sought.
- [ ] Subagent output was revalidated through independent evidence.
- [ ] Persisted briefs, plans, and checkpoints do not contain secrets, unnecessary PII, client content, or external instructions treated as authority.
- [ ] A sensitive feature includes actors, boundaries, plausible abuse, and negative tests from the planning stage, without turning an ordinary feature into a blind checklist.

## External themes or tokens

Apply only when a theme or token comes from a user, tenant, CMS, remote file, or integration:

- [ ] Names and properties follow an allowlist.
- [ ] Types, units, ranges, and size are validated.
- [ ] URLs and resource references pass through the applicable outbound controls.
- [ ] The value reaches only the intended style sink, without active content or isolation breach.
- [ ] Cache, persistence, and per-tenant scope do not leak configuration between users.

Local build tokens do not produce a security finding without controllable input, a reachable path, a missing control, and impact.

## Minimum tests by risk

- [ ] No credential, invalid credential, and expired session.
- [ ] Lower role, another user's object, and another tenant.
- [ ] Empty input, boundary, above the limit, wrong type, and unexpected field.
- [ ] Burst, sustained rate, batch, large page/upload, and expensive operation.
- [ ] Repetition, replay, concurrency, and invalid step order.
- [ ] Slow, unavailable, or malformed external dependency/service.
- [ ] Noisy user/tenant consuming shared resources while other legitimate use continues operating.
- [ ] Logs and responses reviewed for leakage.
