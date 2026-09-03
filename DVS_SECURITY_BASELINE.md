# DVS ChatGPT Workflow security baseline

## Fork origin

- Upstream repository: `totec448-spec/chat-on-steroids`
- Audited upstream commit: `4e810ce0b0d416f7c40cf52cc166369592c70c56`
- Fork: `DigitalVisionStudios/dvs-chatgpt-workflow`
- Baseline date: 2026-09-03

## Trust policy

The DVS fork is built from reviewed source. Upstream prebuilt installers are not part of the trusted update path.

### Automatic updates

Automatic update scheduling is disabled in the DVS fork. The updater engine remains available for explicit/manual use and regression tests, but its release API, checksum manifest, installers, and extension recovery URLs all target only `DigitalVisionStudios/dvs-chatgpt-workflow`, never the upstream maintainer repository.

### Fresh-install permissions

Fresh installs start fail-closed:

- enabled: browse, search, read, metadata
- disabled: create, edit, move, deleteFile, command
- disabled: desktop control and clipboard mutation/read permissions
- disabled: multi-agent execution
- disabled: unattributed-call bypasses

Powerful permissions will be enabled later through explicit DVS workflow modes such as Ultra Max.

### External model loop

The upstream Goal/Loop OpenRouter integration already defaults to disabled. Keep it disabled by default. DVS loop/queue work must not silently opt users into sending conversation content to third-party model providers.

### Session history

Upstream session recording is detailed and stored locally without safeStorage encryption. DVS keeps recording enabled during the initial port because continuation and recovery depend on it, but encrypted-at-rest session storage remains a hardening target before treating the fork as suitable for highly sensitive client conversations.

### Command execution

`exec_command` intentionally runs with the privileges of the logged-in OS user and is not confined to approved roots after launch. DVS must only expose it through an explicit high-capability mode.

## Dependency audit

The 2026-09-03 npm advisory check found two vulnerable transitive build-time dependencies under `electron-builder`:

- `fast-uri 3.1.5` via `app-builder-lib -> ajv`: high severity, fixed in 3.1.6
- `@xmldom/xmldom 0.8.14` via `app-builder-lib -> plist`: moderate severity, fixed in 0.8.15

The DVS fork pins fixed compatible versions with npm overrides. The lockfile must be regenerated without running install scripts and `npm audit --package-lock-only` must be clean before the first DVS package is built.

## Remaining pre-run gates

1. Regenerate and audit the lockfile.
2. Review browser bridge pairing/origin enforcement.
3. Review all outbound network destinations.
4. Review command/process spawning and tunnel launch paths.
5. Review extension permissions and content-script data flow.
6. Review session persistence and retention.
7. Run typecheck and the full upstream test suite.
8. Build locally from the DVS fork only.
9. Compare packaged file inventory against source/build configuration.
10. Only then install the DVS build.
