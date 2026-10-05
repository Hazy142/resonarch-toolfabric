# 04 — Standard user tools

Normal agents only need 20 stable workflow names:
inspect, plan, implement, fix, debug, test, verify, review, refactor, migrate, research, benchmark, audit, release, ship, triage, resume, handoff, document, and delegate.

The YAML files are declarative workflow contracts. The compiler may add repository-specific optional steps in later versions, but it may never silently remove required gates or lower risk.
scripts/generate-workflows.mjs is the reproducible source generator.
