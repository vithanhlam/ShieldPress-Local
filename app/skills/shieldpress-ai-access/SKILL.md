---
name: shieldpress-ai-access
description: Operate authorized ShieldPress Local resources using full access with confirmation for dangerous operations.
---

# ShieldPress AI Access

Use resources selected in AI Access. Selecting and saving a resource grants full access within its scope, including reads, writes, uploads, downloads and VPS commands. Existing granular policies remain effective until the user saves full access.

Ordinary authorized operations need no repeated confirmation. Use `shieldpress.file_operation` for concrete writes, deletes, uploads and downloads. Transfers identify both the remote resource and the authorized local source or destination. Use `shieldpress.run_remote_command` for VPS commands; each command runs independently; specify `workingDirectory` when needed. MCP opens its own saved SSH connection and does not require an open terminal. VPS database commands run through SSH; `query_database` targets the local database. The credential vault must be unlocked and the saved connection must be reachable.

Full-access resources execute without an additional approval in ShieldPress or Reqnora. Ask the user directly in chat when a destructive or ambiguous operation needs confirmation. Existing authorization in the conversation remains effective; do not ask again for the same authorized action. Granular legacy policies may still return `approval_required`; use the exact request ID and `shieldpress.get_request` to check the result instead of submitting the operation repeatedly. Approval alone is not proof of successful execution. Never bypass a denied operation using credentials or another transport.

Credentials stay in ShieldPress. Never read or disclose credential vaults, passwords, private keys or API keys. Redact secrets in output. Create recoverable backups when required by policy. Report actual execution results; approval alone is not proof that a change was applied.

If the target or operation is ambiguous, ask one concise question. Full access does not grant access to unselected resources or paths outside their configured scope.
