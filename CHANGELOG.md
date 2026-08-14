# Changelog

Notable changes to specd. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project is
pre-1.0 and does not yet cut versioned releases, so everything lands under
Unreleased until the first tag.

Entries describe what changed for someone using specd. The reasoning behind a
change lives in its ADR under `knowledge/decisions/`, and the record of what
was built lives in `knowledge/specs/` — this file is the index, not the
argument.

## [Unreleased]

### Added
- Grounding runs are queued rows claimed by a worker, and an abandoned run is
  failed rather than replayed (#98, `knowledge/decisions/0016-onboarding-runs-are-queued.md`).
- Onboarding reads the repository before it drafts: commands, CI pipelines,
  services, configuration, entities and test layout come out of the repo rather
  than out of a model (#92, `knowledge/decisions/0015-onboarding-reads-the-repo-before-it-drafts.md`).
- The board answers the questions people ask standing in front of it —
  assignee, age, stuck state, unverified-claim flags, and lane ranking that
  survives a filter (#90).

### Changed
- The README's test count is a floor rather than an exact number: exact counts
  rot within days (#91).

<!--
  Adding an entry: put it under Unreleased in the PR that makes the change,
  the same way knowledge/ rides the change. Keep it one line, written for
  somebody deciding whether it affects them, and link the PR and the ADR if
  there is one.
-->
