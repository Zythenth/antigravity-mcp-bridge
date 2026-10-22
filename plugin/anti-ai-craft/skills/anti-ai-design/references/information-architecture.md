# Contextual information architecture

## Summary

- [When to use](#when-to-use)
- [Inputs and depth](#inputs-and-depth)
- [Surface map](#surface-map)
- [Navigation and hierarchy](#navigation-and-hierarchy)
- [Flows, URLs, and persistence](#flows-urls-and-persistence)
- [Growth and edge cases](#growth-and-edge-cases)
- [Acceptance criteria](#acceptance-criteria)

## When to use

Execute the complete stage for a product with multiple surfaces, a navigation change, public routes, multiple roles or tenants, growing content, onboarding, deep links, resumption, sharing, SEO, or structural redesign.

Use a mini-contract for one screen that changes priority, an action, a recoverable overlay, a filter/tab in the URL, or a persistent draft:

- entry;
- task;
- path;
- persisted state;
- return, error, and recovery.

Do not create a complete document for a purely visual adjustment that preserves hierarchy, labels, actions, routes, and state.

## Inputs and depth

Read:

- the current brief or requirement;
- routes, layouts, and navigation components;
- content models, APIs, and persistence;
- roles, permissions, and tenants;
- URL, analytics, SEO, and integration conventions;
- actual direct-link, refresh, back/forward, and return behavior.

Do not require a brief at a fixed path or silently choose the most recent one. Respect the project's documentation convention; without writing authorization, deliver the architecture in the response.

## Surface map

Include only reachable or planned surfaces with a verifiable basis:

| Field | Control |
|---|---|
| Identity | Stable name |
| Path | Route and alternative entry points |
| Audience | Role, tenant, and access state |
| Task | Outcome completed on the surface |
| Content | Source and authority of data |
| State | Variations that change structure or action |
| Exit | Destination, return, and recovery |
| Persistence | What survives refresh, return, or session |

Do not blindly mirror the file tree. One route may contain multiple functional surfaces, and multiple routes may share structure.

## Navigation and hierarchy

Distinguish:

- global: recurring destinations;
- local: options within the area;
- contextual: actions tied to the object and state;
- utility: account, help, and administration;
- location and return: breadcrumb, history, and origin;
- adaptive: equivalent access under space, input, and task constraints.

Do not impose an item count, sidebar, top bar, tabs, hamburger menu, or bottom navigation. Choose based on frequency, hierarchy, volume, comparison, and platform.

For each surface, order according to state:

1. context that enables recognition;
2. dominant action or decision;
3. information supporting the decision;
4. secondary actions;
5. progressive detail;
6. help and recovery.

Loading, empty, error, permission-denied, and removed-resource states may replace the entire hierarchy and need their own next step.

Maintain a glossary of concepts and actions. Use the same name in the destination, title, button, confirmation, progress, result, error, documentation, and related event.

## Flows, URLs, and persistence

Each relevant flow records:

1. actor and initial state;
2. entry point;
3. objective;
4. surfaces and actions;
5. decisions and conditions;
6. data read or written;
7. URL and history;
8. failures and recovery;
9. terminal state;
10. return or resumption.

Cover, as applicable:

- primary;
- alternative role or origin;
- error, timeout, offline, and unavailability;
- authentication, expiration, and return to destination;
- authorization without leakage;
- interruption, refresh, back/forward, and multiple tabs;
- lifecycle, administration, and offboarding.

### URL

Decide deliberately:

- static and dynamic segments;
- identifier, slug, and aliases;
- shareable filter, sort, pagination, tab, and search;
- locale, version, workspace, or tenant;
- canonical URL, redirects, and old links;
- removed resources;
- sensitive data that must never enter a URL.

A URL is a contract for location, history, and integration; it does not need to copy the visual hierarchy.

### Persistence

Classify state:

| Type | Examples | Rule |
|---|---|---|
| Authoritative server | resource, permission, progress | Refetch and invalidate coherently |
| URL | search, filter, page, tab | Support direct links and history |
| Navigation session | origin, scroll, step | Preserve when return requires it |
| Device | nonsensitive preference | Do not use as a critical source |
| Ephemeral | menu, hover, animation | Do not persist without need |
| Draft | long form | Define duration, conflict, cleanup, and privacy |

Record key/scope, duration, expiration, version, invalidation, conflict, logout/revocation, sensitivity, and observable fallback.

## Growth and edge cases

Examine:

- zero, one, many, and extreme volume;
- long strings, localization, and special characters;
- pagination after reducing the set;
- item removed between list and detail;
- partial, stale, or duplicated content;
- search with no results or unavailable;
- direct link without history;
- expired session and insufficient role;
- another user's or tenant's resource;
- slow, repeated, or out-of-order request;
- duplicate submission, edit conflict, and rejected optimistic update;
- stale cache, offline, reconnection, quota, and rate limit;
- virtual keyboard, safe area, absence of hover, zoom, and focus return.

## Acceptance criteria

- A critical task has reachable entry and exit.
- Labels and concepts remain consistent.
- Deep links, refresh, and return work when they are part of the contract.
- There is no dead end; error and blocking states offer a safe next step.
- State is deliberately preserved or discarded.
- Public routes, aliases, and integrations preserve compatibility or an approved migration.
- Mobile navigation preserves equivalent discoverability and operation.
- UI and endpoint enforce consistent authorization; hiding navigation is not a control.
- Coverage by surface and flow records `covered`, `partial`, `blocked`, `not exercised`, or `not applicable`.
- No universal number of clicks, items, or depth replaces real scenarios.
