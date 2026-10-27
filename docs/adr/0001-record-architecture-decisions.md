# 0001. Record architecture decisions

Status: accepted · 2026-10-27

## Context

Much of Ember will be written by AI agents working across many sessions. Decisions that live only in a conversation are lost, and later agents re-open them or contradict them. The brief asks for decisions to be written down.

## Options considered

1. **ADRs in the repository.** Short Markdown files next to the code, reviewed like code.
2. **A wiki or external doc.** Easier to edit, but out of reach of agents working in the repository and not versioned with the code.

## Decision

Record each significant decision as a numbered ADR in `docs/adr/`, using `0000-template.md`. ADRs are not edited after acceptance except to mark them superseded; a changed decision gets a new ADR.

## Consequences

Agents and humans can find the reasoning behind any choice with a file search. Writing an ADR adds a small cost to every significant decision, which is intended.

## Dependencies introduced

None.
