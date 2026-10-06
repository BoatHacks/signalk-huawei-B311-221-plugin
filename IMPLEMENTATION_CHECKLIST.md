# Implementation Checklist - Quick Reference

Work through this in order before and while implementing a feature.

## Phase 1: Explore
- [ ] Read the relevant issue/task fully
- [ ] Read the relevant sections of `SPEC.md`
- [ ] Read the relevant sections of `ARCHITECTURE.md`
- [ ] Look at existing code and fixtures before writing anything
- [ ] If the work touches router behaviour, check `test/fixtures/` for
      recorded responses. Field names without a fixture are unverified
      (SPEC §13.1); say so in the plan instead of guessing

## Phase 2: Plan
- [ ] Think through the approach and alternatives
- [ ] Write a short plan in `docs/plans/` from `docs/plans/plan-template.md`
- [ ] Identify test scenarios up front

## Phase 3: Test
- [ ] Write tests first (`node:test`, files in `test/`)
- [ ] Confirm they fail for the right reason
- [ ] Commit the tests separately from the implementation

## Phase 4: Implement
- [ ] Write code to satisfy the tests and the plan
- [ ] Run tests and Biome lint frequently, not just at the end
- [ ] If a test seems wrong, fix the test deliberately, don't loosen it
      just to get to green

## Phase 5: Verify
- [ ] Check edge cases: router unreachable, session expired mid-poll,
      login rejected, counter reset, empty SMS inbox, missing fields
- [ ] Confirm the change matches `SPEC.md`
- [ ] Confirm the change follows `ARCHITECTURE.md`
- [ ] If the change publishes paths: units and `meta` match SPEC §6.1
      and §6.4
- [ ] If the change touches `public/`: no `http(s)://` references, all
      assets vendored (see ARCHITECTURE §2.8)
- [ ] If the change handles credentials or SMS text: nothing sensitive
      reaches logs, REST responses or committed fixtures

## Phase 6: Document & Commit
- [ ] Update `SPEC.md` / `ARCHITECTURE.md` if the change altered what
      they describe
- [ ] Remove temporal language from comments ("new", "recently added")
- [ ] All tests pass, code is linted and formatted
- [ ] Commit with a message that explains *why*, referencing the issue

---

## Common Mistakes to Avoid

**Don't:**
- Jump straight to coding before reading SPEC/ARCHITECTURE
- Invent router response field names; use fixtures or mark unverified
- Retry a rejected login in a loop (the router locks out, error 108007)
- Loosen a test to make it pass instead of fixing the real issue
- Leave SPEC/ARCHITECTURE stale after a change that contradicts them
- Commit unredacted captures from a real router

**Do:**
- Explore before planning, plan before coding
- Write down the plan somewhere reviewable, even briefly
- Verify against the docs, not just your memory of the task
