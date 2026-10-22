# Architecture and maintenance antipatterns

## Summary

- [Preserve before expanding](#preserve-before-expanding)
- [Abstraction without value](#abstraction-without-value)
- [Fragmentation and volume](#fragmentation-and-volume)
- [Verbosity and overengineering](#verbosity-and-overengineering)
- [Speculative compatibility and configuration](#speculative-compatibility-and-configuration)
- [Duplication and inconsistency](#duplication-and-inconsistency)
- [API and contract](#api-and-contract)
- [Performance, cache, and concurrency](#performance-cache-and-concurrency)
- [Logging and observability](#logging-and-observability)
- [Documentation and comments](#documentation-and-comments)
- [False signals](#false-signals)

## Preserve before expanding

Read the existing architecture and distinguish real debt from preference. A localized fix does not authorize a broad redesign.

## Abstraction without value

- one-line helper that merely renames a clear operation;
- wrapper that replicates an interface without adapting, protecting, or observing;
- factory for a single, invariant construction;
- interface/protocol with one implementation and no testing or boundary need;
- strategy/adapter/repository introduced for generic “professionalism”;
- class for state that a simple function/structure can represent;
- genericity for hypothetical cases;
- configuration that replaces clear code with strings;
- base class with hooks that are never used;
- layers that merely forward parameters.

Ask: what variation, invariant, boundary, test seam, or policy does the abstraction concentrate? If there is no concrete answer, simplify.

## Fragmentation and volume

- dozens of small files without ownership or cohesion;
- function split into helpers that require constant navigation;
- “utils/common/helpers” module without a domain;
- one type per simple operation;
- boilerplate larger than the logic;
- duplicated DTOs/mappers without a real boundary;
- huge block with genuinely distinct responsibilities.

The target is cohesion and understanding, not a universal number of lines or files.

## Verbosity and overengineering

- validation repeated across several layers without a change in trust;
- options object for two stable parameters without real evolution;
- enum, DTO, mapper, and service that merely rename the same fields;
- handler pipeline for a short, fixed sequence;
- redundant guard clauses after types or invariants have already been proven;
- comment, docstring, and log repeating the same information;
- two equivalent implementations maintained for imaginary compatibility;
- “enterprise” architecture applied to a simple script, endpoint, or local flow.
- abstraction, tokens, configuration, structure, or documentation task declared complete without a known consumer or verifiable behavior in the same increment or the immediately dependent one.

Apply the removal test: remove the suspect structure and compare the contract, readability, tests, reuse, and architectural boundaries. If nothing material is lost, choose the smaller implementation. Do not use line count as an objective, and do not hide a complex domain in overly compact code.

A horizontal foundation may be legitimate when it has a confirmed consumer, real dependency, and its own evidence, such as a compatible migration, shared contract, or consumed semantic token. Do not reject it because of its format; require observable value.

## Speculative compatibility and configuration

- feature flag without rollout, experiment, or rollback;
- compatibility with an unsupported version/platform;
- branches for nonexistent config;
- fallback for an old API without a test;
- exposed option that is never used;
- partially implemented migration;
- version duplicated across multiple registries;
- silent default that hides missing configuration.

Require a consumer, schedule, test, and removal.

## Duplication and inconsistency

- copying an implementation instead of using the local pattern;
- divergent validation/authorization across paths;
- identical names with different semantics;
- different error model without a boundary;
- duplicated serialization;
- repeated logic that has already diverged.

Do not blindly abstract two coincidences. First confirm the shared rule and direction of change.

## API and contract

- changing a public API without migration/justification;
- accepting ignored parameters;
- undocumented polymorphic return;
- inconsistent use of null/exception/status;
- invented default behavior;
- surprising side effect;
- documented contract without implementation.

Preserve valid compatibility and make the change explicit.

## Performance, cache, and concurrency

- optimization without profiling or a requirement;
- cache without invalidation, ownership, or a limit;
- memoization of mutable/sensitive data;
- parallelism for a small operation;
- batch that changes semantics;
- pooling/retry without backpressure;
- index or denormalization without a measured query;
- logging in a hot loop.

Measure the baseline, define the metric, and validate before/after.

## Logging and observability

- log in every function/branch;
- generic message without actionable context;
- secret/PII in a log;
- same error logged at every layer;
- catch-log-rethrow that duplicates noise;
- incorrect level;
- metric without a consumer;
- tracing added to an out-of-scope path.

Record the boundary, correlation, and action. Logging does not replace error handling.

## Documentation and comments

- comment that narrates the next line;
- docstring that promises “robust,” “scalable,” or “production-ready” behavior;
- example of a nonexistent API;
- README/CI/config created automatically without a request;
- comment made obsolete by a change;
- missing rationale where a non-obvious decision genuinely exists.

Document why, the contract, risk, and decision; let the code express how.

## False signals

Do not infer authorship from:

- many or few comments;
- very descriptive or generic names in isolation;
- consistent style;
- use of a known pattern;
- number of files/classes;
- polished or verbose code;
- presence of a TODO;
- a simple error.

Report only observable impact and evidence.
