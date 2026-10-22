# Code and correctness antipatterns

## Summary

- [Taxonomy](#taxonomy)
- [Invented contracts](#invented-contracts)
- [Fabricated certainty](#fabricated-certainty)
- [Hidden errors and false success](#hidden-errors-and-false-success)
- [State, persistence, and transactions](#state-persistence-and-transactions)
- [Concurrency and async](#concurrency-and-async)
- [Validation, authorization, and security](#validation-authorization-and-security)
- [Local quality](#local-quality)
- [Intersection between code and UI](#intersection-between-code-and-ui)

## Taxonomy

1. **Confirmed functional defect:** reproduction, contract, or test demonstrates incorrect behavior.
2. **Vulnerability:** the impact path and missing control are demonstrable.
3. **Traditional smell:** increases cost/risk but does not prove a bug.
4. **Contextual generic pattern:** observable combination without justification in the task, domain, or architecture.
5. **Community heuristic:** hypothesis to investigate.
6. **Stylistic preference:** do not report as a defect.
7. **Insufficient evidence or false positive:** reject.

## Invented contracts

- Nonexistent API, method, parameter, event, or endpoint.
- Nonexistent, outdated, incompatible dependency/package, or one absent from the lockfile.
- Broken import, undefined name, or feature unavailable in the installed version.
- Fictitious configuration, environment variable, flag, or file.
- Version, command, citation, statistic, or library behavior asserted without verification.
- README/docstring that promises an unimplemented feature.
- Stub, placeholder, or mock left in a production path.
- Embedded absolute path, host, or secret.

Verify existence, version, signature, license/local policy, and actual use. Do not install a package merely because its name seems plausible.

## Fabricated certainty

- presenting an inference as an observed fact;
- filling in a missing requirement with plausible behavior;
- citing documentation that exists but does not support the claim;
- inventing a source, author, number, version, or benchmark outcome;
- defending an earlier claim instead of revalidating it;
- saying that a command, test, build, or review passed without execution and output.

Label fact, inference, and unknown. Verify volatile or precise details in the primary source. When there is insufficient evidence, ask for context or state the limitation.

## Hidden errors and false success

- broad catch that ignores a relevant exception;
- empty/default return after a failure without distinguishing the legitimate error condition;
- log and continuation when the operation should fail;
- generic message that loses the cause and next action;
- success status before side effects are complete;
- infinite retry or retry without idempotency;
- fallback that silently changes semantics;
- test bypassed by an environment-only branch;
- error replaced with a fictitious placeholder.

Require an explicit contract: propagate, translate while preserving the cause, recover with observable state, or compensate. Preserve stack/cause when the language permits.

Do not prohibit `??`, `||`, default values, or `try/catch` based on syntax. Report only when the fallback masks a contract violation or the catch erases a failure that should remain observable.

## State, persistence, and transactions

- partial mutation before validation;
- related writes outside a transaction;
- rollback that covers only some side effects;
- cache updated before the source of truth;
- event emitted without a commit or duplicated on retry;
- impossible state representable without validation;
- sentinel values/magic strings that mix states;
- read-modify-write without concurrency control;
- non-idempotent operation repeated after a timeout.

Trace the initial, intermediate, terminal, and failure states. Confirm atomicity, compensation, and invariants.

## Concurrency and async

- promise/coroutine created without await, join, or owner;
- callback executed after an object/scope becomes invalid;
- listener/timer registered more than once;
- task without cancellation, timeout, or failure handling;
- lock missing, overly broad, or acquired in an inconsistent order;
- shared variable without synchronization;
- response sent before persistence/processing;
- blocking call in an async path;
- race between validation and use;
- concurrency added without measurement or requirement.

Reproduce with relevant interleavings, not merely a superficial reading.

## Validation, authorization, and security

- validating format without validating semantics/range;
- trusting client data, a header, or the UI;
- authenticating without authorizing the resource/action;
- authorization only in the frontend;
- object accessed by ID without verifying ownership/tenant;
- input concatenated into SQL, shell, HTML, URL, path, or template;
- secret, token, key, or PII in code/log;
- excessive permissions and default allow;
- homegrown cryptography or unsafe use of a primitive;
- unaudited dependency;
- message that exposes sensitive detail.

Clearly separate validation, authentication, and authorization. Use the stack's official patterns; do not improvise security.

## Local quality

- magic number/string without explicit domain meaning;
- generic names such as data, item, handler, or manager when they obscure purpose;
- comment that repeats syntax;
- promotional docstring that claims robustness, production readiness, or performance without evidence;
- dead code, impossible branch, or speculative compatibility;
- duplication that has already diverged;
- large function/block with concretely distinct responsibilities;
- fragmentation into trivial helpers that forces jumps without reducing complexity.
- wrapper, facade, or service that only forwards arguments;
- intermediate type immediately converted into another identical type;
- public options, callbacks, or hooks without a consumer;
- duplicated “defensive” handling after a boundary has already validated the data;
- header comment for every obvious function;
- compatibility branch without a supported version, test, or removal deadline.
- table of returns or special cases fitted only to known examples/tests, without a domain rule that generalizes.

Do not turn a naming/size preference into a finding without verifiable impact. Prefer removing volume without a function, while preserving abstractions that concentrate policy, invariants, boundaries, real reuse, or test seams.

## Intersection between code and UI

- kebab menu repeated in every row/card without an action model;
- icon without a label or accessible name;
- hidden primary action;
- cards produced by map without hierarchy or semantics;
- generic component applied to incompatible data;
- fictitious state embedded in HTML;
- theatrical loading, artificial delay, or invented progress;
- motion without a function or reduced motion;
- inline style used to bypass the architecture without justification;
- responsiveness solved only by stacking;
- duplicated listener, fragile ID, or unsynchronized DOM state;
- missing focus and keyboard support;
- visual modal without modal behavior;
- visual tabs without semantics;
- real error replaced by a placeholder.
- missing/circular token alias, or incompatible type or unit;
- token output edited manually instead of the source;
- hardcoding that bypasses the existing semantic layer;
- duplicated theme branch, token without a consumer, or textual replacement without confirming function;
- route that loses filter, page, return destination, or authorization on a direct link/refresh;

Analyze as an implementation decision and behavior, never as proof of authorship.
