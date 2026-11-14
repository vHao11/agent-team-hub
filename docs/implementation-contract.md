# Agent Team Hub implementation contract

Version 0.1.0. Root owns server/ and root package/build files. Frontend agent owns web/. Integration agent owns packages/, server/teamhub/mcp_server.py, examples/. QA agent owns tests/ and docs/ (except this contract). No agent edits another agent's area without agreement.

## Transport and auth

Base /api/v1. Bearer token. Single shared workspace. Bootstrap GET /bootstrap returns {me,teams,users,projects,demo_mode}. Health GET /health. GET /demo returns {identities:[{id,name,team_id,token}]} ONLY if TEAMHUB_DEMO=1; otherwise 404. Defaults are local-only. Demo users: u-lin (林澈, team-trading, admin), u-chen (陈悦, team-clearing, member), u-xu (许安, team-qa, member). Teams name: 交易研发组、清算研发组、质量保障组. Tokens: demo-lin, demo-chen, demo-xu only explicit demo mode. Projects [{id:'proj-interface',name:'交易接口协同'}].

Errors {error:{code,message,details?}} with 400/401/403/404/409/422. Writes JSON always include operation_id (stable for retries); lifecycle writes also expected_version. create exceptions no version. Idempotent receipt keyed actor+operation_id, different body rejected.

## Work items

GET /work-items?status=&q=&team_id=&view=all|mine|requested|review|inbox&limit=50&offset=0 returns {items:WorkItem[],total,limit,offset}. WorkItem fields id:string, number:string (TH-1001), title, description, project_id, requesting_team_id, owner_team_id, pending_target_team_id:string|null, assignee_id:string|null, reviewer_id, status:open|accepted|active|review|done|cancelled, priority:normal|high|urgent, due_at:string|null ISO, acceptance_spec:string[], blocked_reason:string|null, waiting_on:string|null, next_action:string|null, version:number, spec_revision:number, current_delivery_id:string|null, created_at,updated_at.

POST /work-items {operation_id,title,description?,project_id,target_team_id,reviewer_id?,priority?,due_at?,acceptance_spec:string[]} -> WorkItem. Defaults reviewer=current user, initial owner=requesting team.

GET /work-items/{id} -> {item,progress:Progress[],deliveries:Delivery[],reviews:Review[],runs:Run[],bindings:Binding[],events:Event[],dependencies:WorkItem[],allowed_actions:string[]}.

Commands POST /work-items/{id}/{action}, common {operation_id,expected_version}, return WorkItem except noted:
- accept {assignee_id?}; current target team only.
- decline {reason}; target team only, clears pending target, stays open.
- start {}; assigned current owner only, dependencies done.
- cancel {reason}; requester/reviewer or assignee; no implicit confirmed runtime cancellation.
- transfer-requests {target_team_id,reason}; keeps old owner until accepted.
- accept-transfer {assignee_id?}; pending team only.
- progress {summary,blocked_reason?,waiting_on?,next_action?}; owner team/reviewer, returns WorkItem.
- spec {description?,acceptance_spec:string[],reason}; requester/reviewer, bumps spec_revision, invalidates pending review to active.
- dependencies {depends_on_id}; requester/assignee, cycle check; returns WorkItem.

POST /work-items/{id}/deliveries {operation_id,expected_version,spec_revision,summary,artifacts:[{label,url,kind?}],run_ids?:string[]} -> Delivery; sets review. URLs are http(s) or artifact://<id>, no local file paths. Requires active or review status and nonempty artifacts; a newer delivery supersedes the prior current delivery. Delivery {id,work_item_id,sequence,spec_revision,summary,artifacts,run_ids,submitted_by,created_at}.
POST /deliveries/{id}/reviews {operation_id,expected_version,decision:approve|request_changes,reason?} -> WorkItem. Only named reviewer; current delivery+spec revision+review status required.
POST /artifacts multipart file -> {id,label,url:'artifact://id',size,content_type}. GET /artifacts/{id} auth download.

## Runs / bindings / event feed

POST /work-items/{id}/bindings {operation_id,client_instance_id,harness,workspace_ref,local_todo_id?,session_id?} -> Binding. Stable uniqueness item+instance+harness.
POST /work-items/{id}/runs {operation_id,expected_version,client_instance_id,harness,workspace_ref,capabilities?:[{capability_id,version}],external_session_id?} -> Run. Explicit action, must be assignee, dependency guards, accepted->active. Single outstanding active Run per item. Run {id,dispatch_id,work_item_id,client_instance_id,harness,workspace_ref,requested_by,status:queued|starting|running|waiting_input|succeeded|failed|cancel_requested|cancelled|unknown,external_session_id,external_run_id,capability_releases:[],result_summary,created_at,last_seen_at,sequence}.
GET /runs/{id} -> Run. POST /runs/{id}/events {operation_id,client_instance_id,sequence:number,status,summary?,external_session_id?,external_run_id?} -> Run. Monotonic event sequence, only requesting actor; successful run NEVER marks item done. POST /runs/{id}/cancel {operation_id} -> Run.
GET /events?after=0&limit=100 -> {events:[{id:number,type,entity_id,actor_id,payload,created_at}],next_cursor,has_more}. Event playback is not an execution command.

## Capability catalog

GET /capabilities?q=&kind= -> {items:Capability[],total}. Capability {id,slug,name,description,kind:skill|script|mcp|plugin|workflow|app,owner_team_id,tags:string[],latest_version:string|null,releases?:Release[]}.
GET /capabilities/{id} -> Capability with releases.
POST /capabilities {operation_id,slug,name,description,kind,tags?} -> Capability; owner=current team.
POST /capabilities/{id}/releases {operation_id,version,manifest:object,files?:Record<string,string>} -> Release; immutable unique version.
GET /capabilities/{id}/releases/{version} -> Release {id,capability_id,version,manifest,files,created_at}.
GET /team-toolsets/{team_id} -> {team_id,version,items:[{capability_id,version}]}.
PUT /team-toolsets/{team_id} {operation_id,expected_version,items:[{capability_id,version}]} -> toolset; admin or team lead only.

All UI calls live API, no fake local data fallback. Explicit demo mode has seeded realistic tasks/capabilities and persona selector. Frontend Vite build to web/dist, server serves built assets. API proxy in dev to http://127.0.0.1:8765. Root runs backend on 8765.

## DSH integration

No invented Superagent API. Build installable bundle with public HTTP/tools and local adapter contracts. Native ctx.tools.register can be version constrained after source inspection. Actual local board/Superagent bridge must probe availability; absent adapter returns explicit unsupported, never fake success. Provide binding/manual result path and fake adapters only in tests, identified as such. Root will not claim actual Windows DSH verified.

## Quality

Python unittest or pytest with FastAPI TestClient and isolated SQLite. Contract-driven lifecycle, auth, idempotency, stale-review, duplicates and no false done tests. Integration Node tests for client/bridge as practical. FastAPI+SQLAlchemy package install underway. No public publication/deployment or GitHub repo mutation in this task.
