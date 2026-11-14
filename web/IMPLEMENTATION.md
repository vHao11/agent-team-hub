# Web implementation notes

## Run and build

Requires Node.js 20.19+ or 22+ (implemented and built with Node.js 24).

```sh
npm ci
npm run dev
```

Vite listens on port 5173 and proxies `/api` to `http://127.0.0.1:8765`. Build with `npm run build`; the Python server serves `web/dist` in a source checkout.

## Implemented views

- Cross-team ledger, assigned work, team inbox, requester/reviewer views, keyword/status/team filtering, pagination and refresh.
- Item creation and permission-gated detail drawer: acceptance, start, progress/blocking/next action, transfer request/acceptance, decline, cancellation, dependencies and acceptance-spec revision.
- Delivery links and uploaded artifacts, release-specific acceptance review, change requests, current/historical deliveries.
- Explicit external-run registration, manual status reporting, cancellation requests and local-todo bindings. The page does not launch a DSH/Superagent process.
- Shared capability catalog, capability creation, immutable version publishing, manifest/files inspection and fixed-version team toolsets.
- Bearer-token login, demo persona switching only when `/demo` is enabled, honest host-connection status.
- Administrator team/member creation, role selection, one-time display of the generated member credential and member directory.

## Data and permission behavior

All visible items are read from the service. There is no fake-data fallback. Initial demo login is performed only after the server explicitly exposes demo identities; the sidebar and connection settings retain an explicit demo label.

Credentials are held in sessionStorage for the current browser tab. Writes carry `operation_id`; repeating the same request after a network/server failure reuses its operation ID. Versioned writes also carry `expected_version`, and delivery carries `spec_revision`. A 409 response is shown to the user; item and toolset editors refresh the current server data before a retry. Controls use the server's `allowed_actions`; the backend remains the authority for permission and lifecycle checks.

Uploaded artifact metadata is reduced to the delivery API's allowed `label`, `url`, `kind` fields before submission. Private artifact downloads include the current bearer credential. External links are limited to HTTP/HTTPS and opened without opener access. Artifact uploads have no automatic retries.

The DSH connection is explicitly unconnected until a native host adapter exists. Registering an execution only creates the service record. A successful run does not finish a work item; submission and named-reviewer approval are separate actions.

## Design

The implementation follows the selected full-screen concept: dark graphite left navigation, white work surface, teal actions, flat summary strip, table-first ledger, and subdued status colors. It uses native HTML/CSS/SVG controls, no raster text or screenshot-based interface. The interface includes narrow-screen navigation, locally scrollable wide tables, keyboard focus handling for dialogs, reduced-motion support and loading/empty/error states.

The reference concept remains outside the source tree at `/workspace/scratch/bdc2bc896631/generated_images/exec-a79adf2c-08a3-4dd2-94b9-ec6dda485887.png`. It is a design reference rather than application content.

## Verification and limits

- `npm run build` passed: strict TypeScript compilation and Vite production build.
- Form payloads were reviewed against the actual Pydantic models and service methods, including nullable fields, artifact metadata, administrator bootstrap refresh, transfer ownership and run semantics.
- Browser visual/interaction verification was blocked in this environment: the Browser plugin did not expose an originating context, and cloud-browser localhost access was refused and then blocked by URL policy. No alternative automation surface was used to bypass that restriction. The browser flows and responsive rendering are therefore implemented but not browser-verified here.
- There is no native Windows DSH or Superagent validation in this environment. This frontend does not claim those connections are working.
- The overview counts active/review/blocked states in the latest 200 work items and explicitly notes that scope when the workspace contains more items. The total count comes from the server.

For the first local browser acceptance pass, create an item as one identity, switch to the target team, accept/start/update progress, upload or link delivery evidence, switch back to the named reviewer, approve, then verify that the ledger shows completion. Also exercise a second browser tab updating the same item to confirm the stale-version flow.
