---
name: shieldpress-ai-access
description: Safely inspect or operate ShieldPress Local projects, databases, VPS/SFTP connections, and S3 storage through user-approved scopes. Use whenever an AI is asked to access ShieldPress Local resources.
---

# ShieldPress AI Access

Use ShieldPress Local only through the resources and capabilities enabled in **AI Access**. Saved credentials belong to ShieldPress and must never be requested, displayed, copied, logged, or returned to the user or model.

## Required authorization

Before accessing anything, state the intended resource, scope, operation, and reason, then obtain the user's approval. Approval for one resource or operation does not authorize another.

- Treat source, database, ShieldPress configuration, VPS/SFTP/FTP, and S3 as separate scopes.
- Treat `read`, `create`, `edit`, and `delete` as resource capabilities. `execute` is a separate high-risk VPS capability and must be explicitly enabled.
- Ask again before every create, edit, delete, database write, file transfer, restore, or remote command that changes state.
- When a tool returns `approval_required`, stop and tell the user to open **AI Access → Pending AI requests** and press **Approve** or **Deny**; never fall back to reading credential files or running `sshpass` directly.
- If the user explicitly enables **Approve all for this session**, treat it as a time-limited approval for the current ShieldPress session only. Continue naming the exact target and command, and rely on the Debug Logs audit trail.
- For `execute`, show the exact command and any piped input, identify the VPS and account, and obtain fresh approval. Never hide, transform, or append commands.
- A request to investigate authorizes read-only inspection only after the user selects or confirms the target resource.
- If the AI Access policy denies a capability, stop and ask the user to enable it in ShieldPress Local. Never bypass the policy through a terminal or direct credential use.
- Reqnora API keys are credentials: never request them in chat, print them, or include them in tool output. Use only the encrypted key stored by ShieldPress Local.

## Safe operation

Use the narrowest path, database, bucket prefix, or VPS connection needed. Read only enough data to complete the request. Redact passwords, tokens, cookies, salts, private keys, connection strings, and personal data from output.

For changes, show a concise impact summary and the exact targets before requesting confirmation. Create a backup first when the enabled policy requires it. After execution, report what changed and record the result in the AI Access audit log.

Deletion always requires explicit confirmation naming the exact targets. Never interpret permission to edit or backup as permission to delete. Do not use unrestricted SSH shells, `sudo`, root access, destructive SQL, recursive deletion, or bucket-wide operations unless the user explicitly requests the exact operation and ShieldPress policy permits it.

## Data-specific rules

- **Source:** stay inside the approved project/path. Do not read `.env`, private keys, Vault data, or credential files unless the user explicitly names the file and understands that secrets may be exposed. Prefer patches for edits.
- **Database:** default to metadata plus `SELECT`, `SHOW`, `DESCRIBE`, and `EXPLAIN`. Name the database before querying. Database writes and schema changes need a fresh confirmation and a successful backup when required.
- **Configuration:** name the exact ShieldPress, PHP, MariaDB, Nginx, project, or remote configuration before reading it. Redact secrets. Editing a configuration requires a fresh confirmation, backup, syntax validation, and a clear note about any service restart.
- **VPS/SFTP:** use the saved ShieldPress connection without exposing its password/key. Stay under its configured remote path. Prefer fixed inspection probes over arbitrary shell commands.
- For VPS health checks, use the fixed remote inspection tool for disk, memory, CPU, OS, and network metrics; do not request an arbitrary `df`, `bash`, or SSH shell command.
- **S3:** stay within the approved bucket and prefix. Upload, overwrite, restore, and delete each require confirmation. Never disclose access or secret keys.
- **Safety copy:** ShieldPress may create an automatic safety copy before a change, but backup files are not an AI-granted capability and must not be treated as permission to transfer or restore data.
- **Migration:** identify both source and destination resources, create/verify the backup from the source, preview the files/database to be transferred, then ask for confirmation before the destination create/edit operation. Never copy credentials from source configuration into the destination.

If the requested target or desired operation is ambiguous, ask one concise question and do not access any resource until it is resolved.
