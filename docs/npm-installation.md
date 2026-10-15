# npm host installation

The public `agentfleets` package is a small installation entry point. It does not
run the Agent from node_modules or npx's cache. The existing platform installer
downloads the panel's verified release and installs its independent runtime and
background service. Updates remain managed by the panel.

## Connect a new host

Use the same OS account that owns the projects and native Codex/Claude sessions.
Install Node.js 22 or newer, then select **Add host → npm installation** in the
panel and copy its two commands:

```sh
npm install -g agentfleets
agentfleets connect --url https://fleet.example.com --ticket '<one-time-ticket>'
```

Alternatively, copy the optional `npx agentfleets@latest connect ...` command.
Without a ticket, `agentfleets connect --url https://fleet.example.com` uses the
existing browser confirmation flow. The panel's actual host-online receipt is
the connection result; installing an npm package alone does not connect a host.
Do not post tickets in issues or logs.

Supported release platforms are Linux x64, macOS x64/arm64 and Windows x64.
The Unix installer still requires its normal shell/curl/tar utilities. Windows
uses Windows PowerShell and tar. The installed Agent supplies its own runtime;
changing global Node, clearing npx's cache, or uninstalling this npm package does
not remove the background Agent.

`agentfleets status` reports installation and local service status, not an
authenticated assertion that the panel currently sees the host online. The npm
entry version and the Agent version are separate. `npm update -g agentfleets`
only updates the entry tool. Use the panel for Agent updates, repairs, and complete
service uninstallation. Uninstalling the npm package requires no service restart.

## Existing or interrupted installations

The entry checks stable launchers and state markers before doing any installation.
If a managed installation already exists it preserves it, does not consume a new
ticket, and does not restart or re-pair the host. A native installer repeats this
check under its existing installation lock, preventing a race with another installer.

Cache directories alone do not block retry. An incomplete installation with an
existing launcher, state, or conflicting path is preserved and requires the panel's
native pairing/repair instructions. The first version deliberately does not infer
that an absent service means it is safe to overwrite an installation. It never
reads identity keys or the state database to make this decision.

## Build, test and release

```sh
npm --prefix packages/agentfleets-cli run build
npm --prefix packages/agentfleets-cli test
npm --prefix packages/agentfleets-cli run pack
python3 packaging/test-npm-fresh-install.py
```

On Windows also run `packaging/test-windows-onboarding.ps1`. CI tests Node 22 and
24 on Linux, Apple Silicon, Intel macOS and Windows. Package tests use isolated
prefixes/caches and synthetic fixtures; they do not enroll production hosts.

The explicit build copies the common platform scripts into the package, and
`pack` creates `packages/agentfleets-cli/dist/agentfleets-<version>.tgz`. There are
no install/postinstall hooks. Always publish the tested tarball, not an unbuilt
checkout, and never overwrite an existing npm version.

The first package publication requires the npm owner to authenticate and complete
npm's required account verification. Configure the package's trusted publisher for
repository `JosephJagger/AgentFleet`, workflow `npm-release.yml`, and environment
`npm-release` for later releases. The dispatch workflow defaults to verification
only; publishing is permitted only from main and defaults to the `next` tag.
See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

Before promoting a candidate to `latest`, verify the published tarball with
`node packaging/verify-npm-release.mjs <tested-tarball>`, then install that exact
registry version in disposable environments with scripts disabled and verify
help/version/argument handling. Real host pairing and service persistence need
separate platform acceptance; fixture tests are not evidence of that acceptance.

Only after the npm package is public and verified, build the panel with
`--build-arg VITE_NPM_INSTALL_AVAILABLE=true`. All panel Dockerfiles support this
flag, defaulting to false so an unpublished package is not advertised. Direct
installation remains the default in every theme. Follow the existing
[voice-safe publication procedure](voice-safe-deployment.md); never force an
active call or host service to restart for this feature.
