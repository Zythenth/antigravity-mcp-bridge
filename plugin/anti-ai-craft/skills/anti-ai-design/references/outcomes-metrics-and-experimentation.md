# Metrics, research, and experimentation

## Summary

- [ADO-087 — Connect the metric to a user outcome](#ado-087--connect-the-metric-to-a-user-outcome)
- [ADO-088 — Record a baseline before claiming improvement](#ado-088--record-a-baseline-before-claiming-improvement)
- [ADO-089 — Separate an initial signal from a lasting outcome](#ado-089--separate-an-initial-signal-from-a-lasting-outcome)
- [ADO-090 — Define guardrail metrics](#ado-090--define-guardrail-metrics)
- [ADO-091 — Instrument events with semantics and minimization](#ado-091--instrument-events-with-semantics-and-minimization)
- [ADO-092 — Plan the experiment before observing the outcome](#ado-092--plan-the-experiment-before-observing-the-outcome)
- [ADO-093 — Use qualitative research when volume cannot prove causality](#ado-093--use-qualitative-research-when-volume-cannot-prove-causality)
- [ADO-094 — Compare compatible segments and cohorts](#ado-094--compare-compatible-segments-and-cohorts)

## ADO-087 — Connect the metric to a user outcome

**Strength.** required

**Apply when.** A design decision is justified by sign-ups, clicks, time, visits, revenue, or another aggregate metric.

**Decision.** Explain which task or human value the indicator represents, over which window, and for which population. If the relationship is indirect, label the metric as a proxy and seek complementary evidence.

**Evidence.** The contract connects event, behavior, perceived outcome, and business consequence without confusing correlation with cause.

**Avoid.** Optimizing empty volume, screen time without utility, accidental clicks, revenue without quality, or a metric selected merely because it already exists in the dashboard.

## ADO-088 — Record a baseline before claiming improvement

**Strength.** required

**Apply when.** A screen, flow, or message will be compared before and after.

**Decision.** Capture the initial state, period, segment, event definition, data quality, and relevant external factors before the change. Preserve an equivalent comparison.

**Evidence.** Baseline and outcome use the same definition, population, window, and instrumentation, or the difference is stated as a limitation.

**Avoid.** Comparing seasonal weeks, different audiences, redefined events, screenshots with different data, or absence of measurement as though it were zero.

## ADO-089 — Separate an initial signal from a lasting outcome

**Strength.** default

**Apply when.** A change increases attention, sign-ups, flow starts, initial use, or purchases, but its later effect remains unknown.

**Decision.** Track the entry indicator alongside activation, useful completion, return, support load, refunds, cancellation, or another applicable later outcome.

**Evidence.** The plan distinguishes leading and lagging metrics and defines how long observation must continue.

**Avoid.** Calling curiosity adoption, sign-up retention, purchase satisfaction, or a momentary increase in clicks sustainable success.

## ADO-090 — Define guardrail metrics

**Strength.** required

**Apply when.** A hypothesis seeks to increase conversion, use, speed, revenue, adoption, or retention.

**Decision.** Define signals that must not deteriorate: errors, unintended abandonment, accessibility, support load, privacy, complaints, refunds, cancellation, task time, or satisfaction, according to the risk.

**Evidence.** Approval and reversal criteria include the primary indicator and guardrail limits, with an owner and observation window.

**Avoid.** Declaring victory from an isolated metric while costs, harm, exclusion, or exit difficulty increase.

## ADO-091 — Instrument events with semantics and minimization

**Strength.** required

**Apply when.** Validation depends on analytics, interaction logs, replay, an experiment, or segmentation.

**Decision.** Name events according to domain behavior, document triggers and properties, collect only what is necessary, and respect consent, retention, redaction, and access. Test duplication, loss, and version changes.

**Evidence.** There is an event dictionary, verifiable example, data policy, and test connecting emission to the interface's actual state.

**Avoid.** Indiscriminate capture, unnecessary PII, an event that measures rendering as completion, ambiguous properties, or fabricated telemetry to fill a report.

## ADO-092 — Plan the experiment before observing the outcome

**Strength.** required

**Apply when.** The team intends to use a controlled test to choose among alternatives.

**Decision.** Before starting, define the hypothesis, unit of analysis, population, metric, minimum relevant effect, adequate size or duration, stopping rule, and treatment of multiple readings.

**Evidence.** The plan can be reviewed without knowing the winner and records deviations, exposure failures, and sample quality.

**Avoid.** Stopping at the first favorable number, testing many changes without diagnosis, ignoring statistical power, or presenting association as causality.

## ADO-093 — Use qualitative research when volume cannot prove causality

**Strength.** default

**Apply when.** Traffic, frequency, or user count cannot support a reliable quantitative experiment.

**Decision.** Use task observation, interviews, comprehension tests, support analysis, authorized session review, or a comparative prototype to discover mechanisms and failures. Record reach and do not generalize beyond the sample.

**Evidence.** There is a protocol, compatible participants, notes tied to behavior, and hypotheses that can later be confirmed or rejected.

**Avoid.** Calling five opinions a universal rate, leading answers, using an internal colleague as the only user, or inventing statistical precision.

## ADO-094 — Compare compatible segments and cohorts

**Strength.** default

**Apply when.** The outcome varies by origin, experience, plan, device, role, market, period, or version.

**Decision.** Separate populations with materially different contexts and compare equivalent cohorts. Investigate whether an aggregate average hides benefit for one group and harm for another.

**Evidence.** Segmentation has a rationale established before reading the result, sufficient size or a stated limitation, and does not use a sensitive characteristic without a legitimate basis.

**Avoid.** Mixing known traffic with a new audience, comparing mature customers with newcomers, choosing a segment after the outcome, or turning an external benchmark into a universal target.
