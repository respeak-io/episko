# Vendored agent extensions

The files here are copies, not sources. Each one is the extension an agent-protocol provider
loads (`docs/agent-protocol.md`), and `protocol.rs` compiles them into the binary so a launch
can write one into its own folder. `SOURCE` names the episko-integrations commit they came from.

Change them in episko-integrations, where CI runs each inside its real agent, then refresh:

```sh
node scripts/vendor-integrations.mjs ../episko-integrations
```

Editing a copy here would ship code that no agent-level test has seen.
