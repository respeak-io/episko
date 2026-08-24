# Coding-agent provider contract

Episko has one cockpit and several ways to feed it. Shared features depend on
capabilities; only provider adapters depend on vendor protocols.

```text
Claude hooks/statusLine ─┐
                        ├─ provider-neutral state/events ─ Sess ─ shared UI
Codex App Server ───────┘
```

An agent with no structured integration still gets the PTY, worktree, project,
terminal and git features. It advertises no session capabilities and is shown honestly
as terminal-only. Never infer trusted state by scraping a TUI's text.

## The boundaries

- `src/providers/manifest.json` is the single capability matrix consumed by the
  frontend and Rust's `list_agents`. A capability is a user-visible promise, not a
  transport detail.
- `src/providers/index.ts` is the frontend registry for normalized event and history
  adapters. Shared modules call the registry rather than importing `codex.ts` or a
  future vendor module.
- `src/providers/<provider>.ts` translates native payloads into `AgentEvent` and maps
  public history data into `HistEntry` / transcript messages.
- `src/providers/control.ts` owns provider-specific approval routing.
- `src/agents.ts` owns the normalized event vocabulary and the only shared reducer
  into `Sess`.
- `src-tauri/src/agent.rs` is the backend control-plane registry. It starts provider
  sidecars, supplies provider launch arguments, resolves their requests and reads
  public history APIs.
- `src-tauri/src/pty.rs` owns the generic catalogue and PTY. It must not learn a
  provider's command shape.

Raw provider checks are allowed only at a real integration boundary: launching a
vendor protocol, adapting native events, handling Claude's external-session registry,
or keeping account-specific usage semantics separate. Shared render, inspector,
grouping and action code asks for a capability or calls the provider registry.
`test/provider-contract.test.ts` enforces that rule for frontend source.

## Adding an agent-aware feature

Start by classifying it:

1. A universal Episko feature, such as worktrees or terminal resize, needs no provider
   change.
2. A structured session feature, such as context, approvals or quota, belongs in the
   neutral model and may need a capability.
3. A vendor-only command stays inside that provider adapter unless it can be expressed
   as a useful neutral capability.

For a structured feature:

1. Describe the state without vendor names. Add a neutral `Sess` field and, for
   control-plane providers, an `AgentEvent` in `src/agents.ts`.
2. Add a capability only if providers can genuinely lack the complete feature. Do not
   add a capability for every field or native event.
3. Gate shared UI with `hasAgentCapability(session, "feature")`, never
   `session.provider === "codex"`.
4. Teach every provider that claims the capability to populate the same state. Claude
   usually does so in `phase.ts`; control-plane providers do so in their adapter.
5. Give unsupported providers an intentional fallback: hide the meter, disable resume,
   explain the missing integration, or leave the interaction in the terminal.
6. Test the neutral reducer once, every claiming adapter with native fixtures, and the
   unsupported fallback.

Example: a remaining-quota card should consume normalized rate-limit windows. Claude
may fill them from statusLine and Codex from App Server, but the card should know
neither fact.

## Adding an integrated provider

Terminal-only support begins with one `AgentSpec` row in `pty.rs`. First-class support
also requires all of the following:

1. Confirm the vendor exposes a structured, public interface. Do not parse screen
   output or private databases.
2. Add the provider and only its proven capabilities to `manifest.json`.
3. Add a native frontend adapter and register it in `PROVIDER_ADAPTERS`.
4. Add the backend sidecar/control-plane branch in `agent.rs`; keep `pty.rs` generic.
5. Route history through a public provider API and implement list, read and restore
   reconciliation if `history` / `resume` are advertised.
6. Verify permission decisions return through `providers/control.ts` if `permissions`
   is advertised.
7. Add native-payload fixtures for events, history and failures. Test launch/resume
   argument construction in Rust and verify both macOS and Windows CI.
8. Run the manual session checklist in `RELEASE.md`: start, prompt, tool activity,
   approval, failure, context/usage/cost, close, history and resume.

The manifest and registry must have exactly the same integrated provider ids. CI also
rejects unknown capability names and an integrated provider without `session-state`.
That means adding a manifest entry without its frontend adapter, or inventing a feature
flag in Rust that TypeScript cannot understand, fails before merge.

## Pull-request definition of done

For any change that touches agent sessions:

- Shared behavior is provider-neutral and has no new vendor branch.
- Capability claims match what every adapter can actually supply.
- Claude and Codex still pass their relevant fixtures.
- Terminal-only agents degrade intentionally.
- History and resume retain the original provider identity.
- Cumulative values such as cost do not double-count after resume.
- Frontend tests, TypeScript, Cargo tests, Cargo check and Clippy pass.

If a provider cannot support the feature because its public interface lacks the data,
leave the capability off and document the limitation. Honest partial support is a
first-class outcome; fabricated state is not.
