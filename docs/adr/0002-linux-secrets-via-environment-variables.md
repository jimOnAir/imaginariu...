# Linux secrets via environment variables; the vault stays deferred

The Connections tab stores cloud API keys encrypted with Windows DPAPI, which has no
cross-platform equivalent in reach (libsecret needs a running keyring daemon that headless and
minimal setups lack). On Linux the vault refuses gracefully and keys are read only from
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY` and `TRIPO_API_KEY`; a Linux key store (libsecret vs an
app-local encrypted file) is a deliberate future decision, not an oversight — inventing a
home-grown cipher on the critical path would be the worst first move for a security subsystem.
This is surprising on purpose: the UI shows "set the key through an environment variable" rather
than silently dropping entered keys.
