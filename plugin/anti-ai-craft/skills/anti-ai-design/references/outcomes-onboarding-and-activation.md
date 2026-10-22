# Onboarding, activation, and first value

## Summary

- [ADO-033 — Define the activation event](#ado-033--define-the-activation-event)
- [ADO-034 — Deliver value before over-instructing](#ado-034--deliver-value-before-over-instructing)
- [ADO-035 — Do not deliver a directionless home screen](#ado-035--do-not-deliver-a-directionless-home-screen)
- [ADO-036 — Use evidence from the real journey](#ado-036--use-evidence-from-the-real-journey)
- [ADO-037 — Separate useful friction from bureaucracy](#ado-037--separate-useful-friction-from-bureaucracy)
- [ADO-038 — Make the first task feel achievable](#ado-038--make-the-first-task-feel-achievable)
- [ADO-039 — Make guidance an action, not a passive tour](#ado-039--make-guidance-an-action-not-a-passive-tour)
- [ADO-040 — Reveal value progressively](#ado-040--reveal-value-progressively)
- [ADO-041 — Personalize with a stated purpose](#ado-041--personalize-with-a-stated-purpose)
- [ADO-042 — Use clearly identified examples](#ado-042--use-clearly-identified-examples)
- [ADO-043 — Make progress and recovery truthful](#ado-043--make-progress-and-recovery-truthful)
- [ADO-044 — Celebrate achievement without simulating success](#ado-044--celebrate-achievement-without-simulating-success)
- [ADO-045 — Choose an onboarding pattern according to context](#ado-045--choose-an-onboarding-pattern-according-to-context)

## ADO-033 — Define the activation event

**Strength.** required

**Apply when.** The product has sign-up, a trial, first use, or a flow preceding retention and payment.

**Decision.** Identify the observable action or outcome that distinguishes people who obtain value from those who abandon the product. Design the initial path toward that action and measure time to it, relevant repetition, and subsequent return.

**Evidence.** Relate the event to telemetry, research, interviews, support, or cohort analysis; document the definition and its limitations instead of using sign-up as a substitute.

**Avoid.** Calling account creation, tutorial viewing, or a button click activation without demonstrating that they predict real value.

## ADO-034 — Deliver value before over-instructing

**Strength.** required

**Apply when.** The initial flow requests configuration, data, integrations, invitations, or learning before any perceptible outcome.

**Decision.** Reorder the flow to reach a first useful consequence as early as possible. Teach only what is necessary for the next action and reveal additional details when they become necessary.

**Evidence.** Measure the real sequence, time to the first comprehensible outcome, and abandonment points; confirm that the displayed value is produced or clearly labeled as an example.

**Avoid.** A long tour, required manual, requesting all configuration up front, a promised outcome that appears only after disproportionate work, or removing necessary security controls.

## ADO-035 — Do not deliver a directionless home screen

**Strength.** required

**Apply when.** A person arrives at a dashboard, list, workspace, or newly created area without their own data.

**Decision.** Explain the state, point to a concrete next action, communicate the benefit of taking it, and, when useful, provide an explicitly identified example or template. Prioritize one initial path instead of many equivalent options.

**Evidence.** Test whether someone without prior knowledge can identify what to do, why to do it, and how to recover after an error or interruption.

**Avoid.** Treating an empty panel as neutral, unlabeled fictional metrics, a bureaucratic checklist, multiple competing CTAs, or guidance dependent on an invisible tooltip.

## ADO-036 — Use evidence from the real journey

**Strength.** required

**Apply when.** There is a hypothesis that onboarding, the trial, or the first session is failing.

**Decision.** Compare the designed flow with actual behavior in sessions, interviews, tickets, and funnel data. Turn divergences into prioritized hypotheses without attributing intent to the user.

**Evidence.** Record the origin of observations, segment, point in the journey, contrary evidence, and impact severity before changing the interface.

**Avoid.** Redesigning from the internal map, using one isolated session as a rule, collecting personal content beyond what is necessary, or confusing an incomplete recording with proof of comprehension.

## ADO-037 — Separate useful friction from bureaucracy

**Strength.** default

**Apply when.** There is debate about removing fields, creating qualification, requesting configuration, or requiring an initial stage.

**Decision.** Retain effort only when it protects the person, fulfills a legitimate requirement, enables value personalization, or produces conscious commitment. Remove, defer, or automate administrative collection that does not change the immediate experience.

**Evidence.** For each step, describe the value to the person, system need, risk of removal, and least intrusive alternative.

**Avoid.** Using difficulty to trap the person, requesting sensitive data without a purpose, treating opt-in as mandatory, or removing consent, security, and compliance in the name of conversion.

## ADO-038 — Make the first task feel achievable

**Strength.** heuristic

**Apply when.** The first action requires an import, creation, invitation, publication, integration, or another task perceived as large.

**Decision.** Divide entry into an honest, small unit, show what is already complete, and make the next step clear. Prioritize the smallest action that produces a useful consequence, not the smallest possible action without value.

**Evidence.** Verify perceived effort in a usability test, start rate, completion, abandonment, and time to value; confirm that any displayed progress corresponds to real work.

**Avoid.** Fabricated percentages, artificially low goals that lead nowhere, an endless checklist, or hiding relevant future effort.

## ADO-039 — Make guidance an action, not a passive tour

**Strength.** default

**Apply when.** The proposal is to use tooltips, a walkthrough, video, documentation, or a guided sequence on first access.

**Decision.** Convert guidance into contextual steps that let people perform a real action and observe its effect. Supporting content must be dismissible, recoverable, and compatible with keyboard, screen reader, and reduced motion.

**Evidence.** Verify that each step enables a task, can be skipped and resumed without losing state, and does not block people who already know how to operate the product.

**Avoid.** A sequence requiring reading without action, an impossible-to-close modal, lost focus, video with exclusive information and no text alternative, or a tour that reappears after rejection.

## ADO-040 — Reveal value progressively

**Strength.** default

**Apply when.** The product has an extensive surface, advanced capabilities, a high cost of error, or many possibilities at the outset.

**Decision.** First show the capability necessary for the current task and present additional capabilities when there is a context of need. Preserve discovery, search, and help paths for those who need to go further.

**Evidence.** Map which capability is necessary at each stage, verify later discoverability, and monitor whether hiding it reduced errors without creating support dependency.

**Avoid.** Hiding critical controls, making paid or security capabilities invisible, using progression as an excuse to limit autonomy, or assuming everyone follows the same sequence.

## ADO-041 — Personalize with a stated purpose

**Strength.** default

**Apply when.** The product serves profiles with different objectives, maturity, roles, or initial flows.

**Decision.** Ask for a short, explained statement of intent only when it perceptibly changes a recommendation, content, order, or route. Allow the choice to be corrected later.

**Evidence.** Demonstrate how each answer changes the experience, record the data's purpose and retention, and validate whether personalization reduces effort or improves the first outcome.

**Avoid.** A long questionnaire, opaque segmentation, unnecessary sensitive data, personalization that limits options without warning, or a choice that cannot be changed.

## ADO-042 — Use clearly identified examples

**Strength.** default

**Apply when.** An empty space must demonstrate a possible outcome before the person enters their own data.

**Decision.** Provide examples, templates, or demonstration data that resemble the domain, are visibly labeled, and can be replaced, hidden, or removed. Distinguish examples from observed data.

**Evidence.** Confirm that no chart, activity, indicator, or record demonstrates a nonexistent fact; test whether the person understands the content's origin and can begin with their own data.

**Avoid.** Numbers that look real, examples mixed with production, personal data, a screenshot as a substitute for interaction, or an empty state without a clear exit.

## ADO-043 — Make progress and recovery truthful

**Strength.** required

**Apply when.** The journey includes stages, processing, import, approval, failure, pause, or a later return.

**Decision.** Present progress only when the system knows the corresponding stage or consequence; explain what occurred, what remains, what stays saved, and how to resume or undo. Preserve state securely.

**Evidence.** Test interruption, reload, error, insufficient permission, unstable connection, and return to the flow; review messages with assistive technologies.

**Avoid.** A simulated bar, success before confirmation, silent data loss, a generic error, an unnecessary forced restart, or recovery that depends on support for common cases.

## ADO-044 — Celebrate achievement without simulating success

**Strength.** heuristic

**Apply when.** A person completes an action requiring meaningful effort or reaches a first useful outcome.

**Decision.** Provide feedback that recognizes the achievement, explains its effect, and presents an optional next action. Calibrate motion, color, and intensity to the context while respecting reduced-motion preferences.

**Evidence.** Verify that the achievement exists, the feedback does not interrupt a critical task, and the person understands the state without depending on animation, color, or sound.

**Avoid.** Automatic confetti, exaggerated language, treating incomplete configuration as a win, rewards that pressure continuation, or animation that blocks the next action.

## ADO-045 — Choose an onboarding pattern according to context

**Strength.** required

**Apply when.** A welcome modal, checklist, tour, tooltip, template, example, goal-setting step, or demonstration is selected.

**Decision.** Select the pattern according to the person's familiarity, complexity, risk of error, value of the first task, variety of routes, and accessibility needs. Combine patterns only when each has a distinct role and recoverable path.

**Evidence.** Document the problem each pattern solves, its states, exit criteria, accessible alternative, and expected outcome; validate with novice and experienced users when both exist.

**Avoid.** Adopting a component because it is fashionable, a checklist for tasks without a real sequence, a tooltip as the only instruction, a nested modal, onboarding that blocks normal use, or one journey imposed on everyone.
