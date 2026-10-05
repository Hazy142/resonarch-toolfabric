# 06 — Security, policy, authority, evidence, and receipts

Policy is deny-by-default. Capabilities are scoped grants, not model traits.
Mutating side effects create a durable intent before execution and a completion/failure receipt afterwards.
A crash between effect and durable evidence produces uncertain until reconciled.

Receipt chains detect local tampering relative to their known root. Signing or external anchoring is a separate, stronger provenance claim.
Large outputs belong in content-addressed artifacts; receipts bind their digests rather than duplicating raw content.
