# Open Design patches

Small fixes Chief of Staff (Jarvis) carries on top of the bundled Open Design
submodule (`third_party/open-design`). The submodule tracks upstream
`nexu-io/open-design` by commit, so these changes can't be committed as normal
files in this repo — instead they live here as `*.patch` files and are applied
automatically by [`scripts/setup-open-design.sh`](../scripts/setup-open-design.sh)
**before** the submodule is built (so they compile into `dist/`).

The apply step is idempotent: a patch that is already applied is detected and
skipped.

## Patches

- **`open-design-acp-permission.patch`** — `apps/daemon/src/agent-protocol/acp/rpc.ts`.
  Lets Open Design approve tool-permission prompts from agents (like the Kiro
  CLI) whose approve options use non-canonical `optionId`/`kind` labels.
  Without it, a design run started by the "UX Designer" stalls at
  `awaiting_input` ("tool is blocked in the session") instead of proceeding.

## Regenerating a patch

If you change a file inside the submodule and want it to travel with the repo:

```bash
git -C third_party/open-design diff <path/to/file> > patches/<name>.patch
```

Then commit the patch file here. Cloners get it applied on their next
`./scripts/setup-open-design.sh` run.
