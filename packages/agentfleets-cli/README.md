# AgentFleets npm installer

Install the independently running AgentFleets background Agent and connect your computer to your own control panel. The npm package is an installation entry point, not the Agent runtime.

Requires **Node.js 22+**, and Linux x64, macOS Intel/Apple Silicon, or Windows x64. Unix installations also require the native installer's existing dependencies such as `sh`, `curl`, and `tar`. The native Agent bundles its own runtime.

## Connect a new host

In the panel choose **Add Host → npm** and copy the generated commands:

```sh
npm install -g agentfleets
agentfleets connect --url https://your-panel.example --ticket YOUR_ONE_TIME_TICKET
```

Or run once without a global installation:

```sh
npx agentfleets@latest connect --url https://your-panel.example --ticket YOUR_ONE_TIME_TICKET
```

Keep Add Host open until the panel confirms the host is online. Without `--ticket`, the native installer uses its browser confirmation flow. Optional `--name`, `--project`, and `--alias` retain native onboarding behavior. Use the operating-system account that should own the background service. On Windows, the project defaults to the current directory and the name defaults to your computer's hostname; these defaults are validated and passed explicitly. Project/name values, the current directory, the npm package path and `LOCALAPPDATA` must not contain cmd.exe special characters (`% ! & | < > ^ " ( )`); spaces, apostrophes and Chinese characters work.

`npm install` itself does not start services or pair machines. Installation occurs only when you explicitly run `connect`; npm lifecycle scripts are not required.

## Existing installations and status

```sh
agentfleets status
agentfleets --help
agentfleets --version
```

`status` reads the managed launcher and runs only the native version/service-status queries. It does not initialize a state database or read pairing credentials. A running service does not prove connectivity; check the host in your panel.

If a managed Agent is already installed, `connect` shows its status and leaves it unchanged. It does **not** consume a new ticket, re-pair, restart or update the service. If installation failed before a launcher or configuration was created, it can be retried. A partial installation with a launcher, saved state or runtime profile needs the panel's native pairing/repair instructions; this npm entry point deliberately does not overwrite it or delete data.

An existing custom launcher or unsafe path is reported as a conflict. Custom `AGENTFLEET_HOME` installations must use native instructions. A download-cache directory alone is not considered an installed Agent.

## Updates and removal

The panel manages Agent upgrades. `npm update -g agentfleets` updates only this installer tool, and `--version` reports that tool's version. `status` separately reports the installed Agent version. Removing the npm package, clearing npx caches, changing Node installations, or closing the terminal does not remove the Agent service. For complete removal use the panel's native uninstall instructions.

The bundled installers obtain artifacts from the specified panel's release manifest and retain the native size/SHA-256 checks, install locks and service health checks. Only HTTPS panel addresses are accepted, except localhost/127.0.0.1 for local development. Keep enrollment tickets private; commands containing tickets may be saved by your terminal history.

## Building from the repository

```sh
npm --prefix packages/agentfleets-cli run build
npm --prefix packages/agentfleets-cli test
npm --prefix packages/agentfleets-cli run pack
```

Build copies the repository's canonical `packaging/install.sh`, `install-macos.sh`, and `install.ps1` into the package; there is no separate installer implementation or install-time build. Publish only a built, tested tarball. The package files allowlist excludes source tests, private data and repository configurations.

MIT licensed; see `dist/LICENSE` in the published package.
