# DVS ChatGPT Workflow baseline

## Fork origin

- Upstream repository: `totec448-spec/chat-on-steroids`
- Audited upstream commit: `4e810ce0b0d416f7c40cf52cc166369592c70c56`
- Fork: `DigitalVisionStudios/dvs-chatgpt-workflow`
- Baseline date: 2026-09-03

## What this baseline is for

The security goal is practical: verify the source is clean enough to use as the DVS foundation and avoid an upstream binary/update path we do not control. DVS is not intended to add permission prompts or security friction to normal building and automation.

The source review found no RAT/trojan indicators in the audited upstream baseline.

## Trust and supply chain

### Builds and updates

Build DVS from this reviewed fork rather than installing upstream prebuilt executables.

Automatic update scheduling remains disabled. Release/checksum/extension recovery references point to `DigitalVisionStudios/dvs-chatgpt-workflow`, so a DVS installation does not silently ingest a future upstream maintainer binary.

### Dependencies

The 2026-09-03 lockfile audit found two vulnerable transitive build dependencies under `electron-builder`:

- `fast-uri 3.1.5` via `app-builder-lib -> ajv`
- `@xmldom/xmldom 0.8.14` via `app-builder-lib -> plist`

The DVS fork pins fixed compatible versions and CI audits the lockfile before dependency install scripts run.

## Usability defaults

DVS keeps the upstream power-user behavior for normal building:

- fresh-install capabilities are enabled rather than read-only
- multi-agent execution may start enabled on a fresh install
- unattributed-call fallback may start enabled on a fresh install
- command/file/browser workflows do not require a separate DVS Safe-mode approval step

Existing saved user choices and corruption/fail-closed migration behavior are still respected by the upstream config system.

### Browser pairing

Use the upstream low-friction localhost pairing design. There is no DVS "Approve browser" button or explicit first-pair approval.

The companion bridge remains loopback-only, requires a Chrome-extension origin, and uses a bearer token for protected routes. As upstream documents, another process already running as the same OS user can potentially obtain that browser token; this is accepted for our local development use case because the bridge does not expose filesystem, command, or permission-changing routes.

### Session history

Keep upstream durable session recording behavior. Session history is local plaintext and is **not** being redesigned for encrypted-at-rest storage at this stage. Continuation/recovery reliability is more important for this project, and encryption can be reconsidered later only if the use case requires it.

### Command execution

`exec_command` intentionally runs with the logged-in OS user's privileges and is not confined to approved project roots after launch. This is expected functionality for DVS/Ultra Max rather than something to gate behind an extra approval layer.

### Goal / Loop provider

The upstream OpenRouter Goal/Loop integration remains opt-in because it requires a provider key. Porting DVS queues, loops and Ultra Max should not require OpenRouter unless we deliberately choose to use it.

## Remaining pre-install checks

1. Keep the dependency audit clean.
2. Keep the full upstream verification suite green after DVS changes.
3. Build the first package from the DVS fork only.
4. Compare packaged contents/update endpoints against the reviewed source.
5. Install and live-test the DVS build.
6. Then port/finish DVS Queue, Auto Queue, Loop, Ultra Max and durable rollover behavior.
