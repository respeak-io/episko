# Repository instructions

`CLAUDE.md` is the comprehensive project guide despite its historical filename. Read
it before changing this repository, then read the matching deep-dive document it
links for the area being changed.

For any coding-agent, session, inspector, usage, history, approval, launch or resume
change, read `docs/providers.md` first. Its central invariant is mandatory:

> Shared features depend on capabilities; only provider adapters depend on vendors.

Do not add a vendor-specific branch to shared UI or state logic. Define neutral
`Sess` state / `AgentEvent`s, gate genuinely optional behavior with
`hasAgentCapability`, implement every provider that claims the capability, and leave
an intentional terminal-only fallback. Provider-native code belongs under
`src/providers/` or at the backend control-plane boundary in
`src-tauri/src/agent.rs`.

Run the frontend build/tests and the Rust check/tests/Clippy gates listed in
`CLAUDE.md` before handing off a change.
