# ToolFabric threat model

ToolFabric assumes models, files, web pages, issues, PR comments, MCP results, and other retrieved content may be hostile.

## Threat classes

1. Prompt or instruction injection.
2. Capability escalation.
3. Path or workspace escape.
4. Credential or sensitive-data exfiltration.
5. Duplicate or ambiguous side effects.
6. TOCTOU and revision drift.
7. Artifact substitution after verification.
8. Provider semantic drift.
9. Compromised workers crossing scope.
10. False reviewer independence.
11. Supply-chain or dependency mutation.
12. Context contamination across tasks or sessions.
13. Network pivot or uncontrolled egress.
14. Claim inflation from narrow technical evidence.

Primary controls are executable: instruction manifests, scoped capabilities, expected-state writes, leases/fencing, intent/completion receipts, uncertain reconciliation, content-addressed artifacts, adapter conformance, independent review packages, output redaction, network authorization, and explicit claim status.
