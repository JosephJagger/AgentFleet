# Contributing

Use Node.js 24. Install dependencies in each application and run the check, test, and build commands in the [README](README.md). Open an issue to describe a bug or discuss a substantial change, then submit a focused pull request explaining the behavior and validation.

Never include `.env`, credentials, enrollment tickets, real conversation histories, private hostnames, deployment addresses, or unredacted screenshots and logs. Use synthetic fixtures and your own isolated test directories. Tests must not send real host commands or modify a user's Codex history.

For changes involving native sessions, test writer exclusion, interruption, restarts, idempotency, and unknown outcomes. Image cleanup must preserve text and session identity and reject unsupported history. Agent binaries are immutable per version: bump the Agent version when changing shipped Agent code and use the packaging checks.

Contributions are provided under the project's MIT license. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

Panel publication must use `packaging/deploy-control-plane.py` after preparing and verifying a separately tagged image. Do not use direct `docker compose up`, `restart`, or forced browser reloads to publish over active voice calls. Both global and session voice calls must drain naturally; a timeout defers publication. See `docs/voice-safe-deployment.md`, including first-rollout fencing and crash recovery.
