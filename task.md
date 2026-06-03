Air Automation technical assignment: GitHub Event Filtering
Context
Imagine we're building a service that subscribes to GitHub webhook events and runs downstream actions based on certain user-specified criteria.

GitHub sends an event via webhook for everything that happens in a repository - pull requests, comments, CI runs, issues, releases, and so on (see the GitHub webhook events and payloads spec) - and in practice, only a small subset is interesting. 
The criteria for "what matters" varies across users and change often, and they're rarely simple: they depend on who did what, on which branch, with which labels, and sometimes on what happened in the last few minutes. We want users to describe these criteria themselves, declaratively, in a DSL, and have the service evaluate incoming events against them.

The task
Design and develop a rules engine that filters GitHub webhook events through rules expressed in a DSL of your design. You decide the DSL syntax — YAML, JSON, code-as-config, a custom grammar, whatever you can defend.
A rule should be able to:
Match events by shape — event type, repository, and fields in the payload (PR author, labels, target branch, file paths, commit message, etc.).
Compose conditions — AND / OR / NOT, grouping, negation.
Call out to external APIs that may respond slowly — the DSL should let a rule depend on the result of an external call (think classification service, LLM, or internal lookup).
Aggregate across events — e.g., "fire only if 3 failed CI runs happen on the same PR within 1 hour" or "ignore an issue-closed event if the issue was reopened in the last 5 minutes".
The engine itself should be extensible — adding a new condition type, predicate, or external integration should be a localized change, not a rewrite. We expect the set of conditions to grow over time.
Example rules the DSL to be able to express:
Notify when a PR targeting main is opened by someone outside the core-team and touches files under infra/.
Fire only when the same PR receives 3 failing CI runs within an hour.
React an issue.closed event if the issue was not reopened in the last 5 minutes.
Notify when a PR comment is flagged as hostile by an external classification API.
When a release is published, fan out only if the tag matches v*.*.* and the release notes mention "breaking change".
These are illustrative — the DSL should support this shape of thinking, not these exact rules verbatim.
Deliverables
 A GitHub repository containing a working prototype:
An implementation of your DSL and a rule engine that evaluates GitHub webhook events against rules written in it.
A simple UI is optional but welcome — something that lets you load a DSL file and test rules against sample events would be useful for demonstrating the engine.
A short document (README or similar) describing what you built and how it works: the DSL, the evaluation model, how external API calls and aggregation are handled, and any tradeoffs or shortcuts you made.
Language
TypeScript (Node.js) or Kotlin are preferable, but not required — pick what lets you demonstrate the design best.
Evaluation criteria
Design clarity — how readable and ergonomic the DSL is for the people who'd write rules.
Modeling — how matching, composition, external calls, and aggregation fit together as one coherent engine.
Code quality and correctness — structure, readability, sensible boundaries.
Documentation — whether someone new can read the doc and understand the design choices.
Submission
A link to a GitHub repository with the implementation.
