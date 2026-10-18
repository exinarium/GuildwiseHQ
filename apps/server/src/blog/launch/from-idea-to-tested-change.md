---
title: "From idea to tested change: how work moves through an AI agent team"
slug: from-idea-to-tested-change
summary: "A walkthrough of one change as it moves from idea to requirements, build, review, test and release in an AI agent team, with the pitfalls to watch for at each stage."
tags: [how-to, ai-agents]
cover:
  defaultKey: how-to
  alt: Abstract stepped path rising across a dark blue gradient
seo:
  metaTitle: "From idea to tested change with an AI agent team"
  metaDescription: "Requirements, build, review, test and release: how one change moves through an AI agent team, and the pitfalls."
social:
  facebookText: "New on the blog: follow one change from idea to release through an AI agent team, stage by stage, with the pitfalls to watch for."
  linkedinText: "What actually happens between 'we should add this' and 'it is live' when AI agents do the work? A stage-by-stage walkthrough of requirements, build, review, test and release, and where each stage tends to go wrong."
  xText: "From idea to tested change: how an AI agent team takes a request through build, review and test gates."
  blueskyText: "From idea to tested change: how an AI agent team takes a request through build, review and test gates, step by step."
sources:
  - title: "Claude Code documentation: Best practices"
    url: https://code.claude.com/docs/en/best-practices
  - title: "Anthropic: Building effective agents"
    url: https://www.anthropic.com/engineering/building-effective-agents
  - title: "METR: Measuring the impact of early-2025 AI on experienced open-source developer productivity"
    url: https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/
---

## One change, five stages

An idea is cheap. A change that is specified, built, reviewed, tested and released is not. The value of an AI agent team is in how it carries an idea across those stages without dropping it, and in how it shows you where it got stuck.

This walkthrough follows one realistic change through a typical flow. The example is invented for illustration: a small online shop wants customers to be able to download their invoices as PDF files. The stages are the same for most changes, whether they are a feature, a fix or a small clean-up.

## Stage 1: The idea becomes requirements

It starts with a sentence from you: "Customers should be able to download invoices as PDFs."

That sentence hides questions. Which invoices, all of them or only paid ones? Is the file named in a particular way? What should happen when an invoice does not exist? Does it need your company details in a particular layout?

A business analyst role exists to ask these before any code is written. Anthropic's Claude Code documentation recommends the same order of work for people: explore first, then plan, then code, because jumping straight to coding "can produce code that solves the wrong problem". It also suggests that, for larger features, you let the agent interview you and write a spec, with an end-to-end verification step at the end.

A good specification for this card is short and checkable: the behaviour in plain words, what is out of scope, and the tests that would prove it works.

**Pitfall: a vague card.** If the specification is "make invoices downloadable", every later stage has to guess. The most useful thing you can do as the manager is to answer the analyst's questions properly. Spending ten minutes here saves hours downstream.

## Stage 2: Build

The builder implements the specification in its own copy of the code, so it cannot disturb anything else in progress, and runs the checks that already exist: the build, the tests, the linter.

The same documentation makes a point worth repeating: give the agent a check it can run, because without one "looks done" is the only signal, and you become the verification loop. A builder that can run tests iterates until they pass; a builder without them stops when the code looks plausible.

**Pitfall: grading your own homework.** A builder that writes both the change and the tests can encode the same misunderstanding in both. The remedy is the next two stages, which are done by other roles from the specification, not from the builder's reasoning.

**Pitfall: scope creep.** Agents like to tidy things up. A change that was meant to touch invoices and also rewrites the settings page is harder to review and harder to undo. Say what is out of scope on the card.

## Stage 3: Review

A reviewer reads the change against the specification, in a fresh context, without the builder's chain of reasoning. The Claude Code documentation describes the benefit directly: a fresh context improves review because the reviewer is not biased toward code it just wrote. It suggests the writer and reviewer pattern, where one session implements and a separate one reviews, and the findings go back to the first.

In our example the reviewer notices that the download works for paid invoices but crashes when an invoice has no line items. That is the kind of gap a second pair of eyes finds.

Reviews should scale with risk. A one-line text change does not need the scrutiny of a change to payments. A sensible rule is that larger or riskier changes get more reviewers.

**Pitfall: reviewing for style.** The documentation warns that a reviewer asked to find gaps will usually report some, even when the work is sound, and that chasing every finding leads to over-engineering. Tell the reviewer to flag what affects correctness or the stated requirements and to list the rest as optional.

## Stage 4: Test

A tester works from the specification and exercises the behaviour: downloads an invoice, tries one that does not exist, tries a very long customer name, and checks the file opens. Where possible it uses the running application, not just the code, and it reports evidence such as output or a screenshot rather than the word "passed".

The tester finds a bug the reviewer did not: names with accented characters appear garbled in the PDF. The card goes back to the builder, who fixes it and adds a test. The change returns to review for the new lines, then to test.

**Pitfall: tests that cannot fail.** A test that passes whatever the code does is worse than no test. Ask for at least one test that you have seen fail first.

**Pitfall: stale environments.** Tests run against what was actually built. Make sure the tester is looking at the latest version of the change, not a copy from two rounds ago.

## Stage 5: Release

When the gates have passed, the change reaches your main code. Depending on your preference that is a direct merge after review and testing, or a pull request that you or a colleague approve. Deployment follows your normal process, and for anything that goes out to customers, it is sensible to require your approval.

A release is also the moment to write down what was decided, such as "invoices are only available for paid orders", so that the next change does not reopen the question.

**Pitfall: treating green checks as a guarantee.** Review and testing reduce risk; they do not remove it. For changes that matter, watch the first hours after release and know how to roll back.

## Pitfalls that cut across the stages

- **Blind trust in speed.** METR ran a randomised trial with 16 experienced open-source developers on 246 real issues and found that, with the AI tools of early 2025, they took 19% longer, while believing they had been about 20% faster. The authors are careful to say this is one setting and one moment in time, and that it is not evidence about all developers or all tools. The useful lesson is narrower: do not rely on how fast work feels. Measure how long cards take to get through the board, and how many bounce back.
- **Too much at once.** Anthropic's [guide to building agents](https://www.anthropic.com/engineering/building-effective-agents) recommends adding complexity only when it demonstrably improves outcomes. Start with a few small cards before you run a dozen in parallel.
- **Silent blockers.** A card that waits for an answer from you looks the same as a card that is working, unless the board says why it is stuck. Look for tooling that explains blockers on the card itself.
- **Missing records.** If decisions live only in chat, the next agent, or the next person, will ask again. Record answers once, in a place every agent can read.

## How Guildwise HQ fits

Guildwise HQ puts this flow on a board. Cards move through stages such as spec, build, review, test and done as the agents work; a business analyst agent can turn tickets and ideas into cards with specifications and test plans; large changes need two reviewers; and a change reaches your main code only after review and testing, either directly or as a pull request if your project prefers. Questions that need you arrive at one desk, with context and a recommendation.

## Key takeaways

- Most of the quality of a change is decided in the specification, so invest your time there.
- Give every stage a check that returns a clear pass or fail, and ask for evidence.
- Let review and testing be done by roles that did not write the change.
- Keep changes small and in scope, and scale review to risk.
- Track how long cards take and how often they bounce back; do not rely on how fast things feel.

*This article was written with AI assistance and reviewed and approved by the Guildwise HQ team. The invoice example is invented for illustration.*
