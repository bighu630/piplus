# AI Agent Platform Design

## 1. Scope and Product Goal

This document captures the agreed v1 design for a LAN-first, browser-based, role-driven AI agent platform built in a single TypeScript codebase. The product is a web workbench inspired by Codex Desktop interaction patterns, but implemented as a web application rather than a desktop shell.

The primary goal of v1 is to provide a usable project/session workbench with:
- local account login
- project container management
- a tree of PI-backed sessions with parent-child relationships
- a conversation-first chat surface
- a read-only session detail view
- a minimal but durable local control-plane data model
- platform-managed session spawning and explicit parent writeback tools layered on top of PI Agent SDK

This document intentionally fixes architecture, frontend structure, backend module boundaries, runtime behavior, and data model decisions before API design and implementation begin.

## 2. Product Constraints and Core Assumptions

### 2.1 Deployment and usage model
- The product is a LAN-first web application.
- The primary target is desktop browser usage.
- Mobile web support is required, but mobile is a constrained navigation-first adaptation rather than a desktop-style multi-pane UI.
- The system supports local account login and lightweight multi-user usage.
- v1 does not include teams, organizations, collaborators, or advanced RBAC.
- The architecture must support both split deployment and unified deployment.
- In split deployment mode, frontend and backend run as separate apps/services.
- In unified deployment mode, frontend and backend may still be deployed together behind one domain or reverse proxy while remaining logically separate applications.

### 2.2 Relationship with PI Agent SDK
- PI Agent SDK is treated as the single-session execution engine.
- PI Agent SDK is the source of truth for live chat history and live run behavior.
- PI Agent SDK does not provide native child-agent orchestration or the platform role system.
- Child sessions, role templating, prompt composition, writeback semantics, and session tree management are platform-owned capabilities built outside PI.
- The local database stores a durable control-plane model and full message/event replica, but live chat rendering in the UI reads from PI rather than from the local message replica.

### 2.3 Scope discipline for v1
- Projects are containers only and do not have a root chat.
- Each session maps 1:1 to a PI agent session.
- A session has exactly one immutable role template binding.
- Forking is expressed as child session creation, not as thread branching inside one session.
- Session Info is a pure read-only page with no embedded management actions.
- Tool permissions and per-role tool allowlists are out of scope for v1.
- Attachments, file uploads, and file object modeling are out of scope for v1.
- Advanced autonomous orchestration, run/job splitting, and automatic multi-step writeback policies are out of scope for v1.

## 3. Frontend Experience Design

## 3.1 Overall shell model
The frontend is a single workspace shell with two major regions on desktop:
- left: project/session tree
- right: session main panel

The right main panel has two tabs in the upper-right area:
- Chat
- Session Info

These are two views over the currently selected session context, not two unrelated pages.

### 3.1.1 Desktop layout
- The left tree is independently collapsible.
- The left tree remains present across session switching.
- The right side defaults to Chat whenever a session is entered.
- Session Info is shown only when the Session Info tab is selected.
- The right side is conversation-first and should visually prioritize message history and composer over secondary operational chrome.

### 3.1.2 Mobile layout
- Mobile does not use a left-right split layout.
- Project/session tree is presented as a full-screen navigation page.
- Selecting a project or session navigates into a content page.
- Within a session content page, Chat and Session Info are still switched by top tabs.
- Mobile is intentionally a navigation-page to content-page experience, not a compressed desktop clone.

## 3.2 Left tree model
The left tree is a file-tree-like navigation structure with clear expand/collapse behavior.

Tree hierarchy:
- Project
- top-level Sessions under that Project
- child Sessions under their parent Sessions

Important semantics:
- The tree reflects the platform-managed session lineage, not a purely visual grouping.
- Parent-child relationships correspond to session spawning relationships.
- Role information is shown on each session node.
- Runtime state and archive state should be visually visible on nodes.

### 3.2.1 Node interaction
- Clicking a node selects and opens that session in the right panel.
- Clicking the expand arrow only expands/collapses the node.
- Node click should not implicitly expand/collapse children.

### 3.2.2 Tree visibility and archive behavior
- Archived sessions remain in the same tree structure position.
- Archived sessions are hidden by default.
- The tree exposes a toggle button to reveal archived sessions.
- When the toggle is enabled, archived sessions appear in place rather than being moved to a separate archive area.

### 3.2.3 Tree ordering
- Projects are ordered by most recent activity.
- Sessions are ordered by most recent activity.
- Child sessions are also ordered by most recent activity.
- Sibling nodes use descending last_activity_at ordering.

## 3.3 Chat page behavior
Chat is the default primary view for any selected session.

### 3.3.1 Data source
- Chat history is read from PI Agent SDK, not from the local message replica.
- On entry, Chat loads a recent slice of messages first.
- Older history is loaded by upward pagination.
- The local messages table exists as a replica/control-plane layer and is not the main rendering source for the chat page.

### 3.3.2 Message semantics
Visible message roles:
- user: a human user message sent into the current session
- assistant: a normal reply from the current session, including writeback messages received from a child session
- system: reserved for rare platform-visible messages; expected to be uncommon in v1

Writeback display behavior:
- Child-session writeback appears as an assistant message in the parent chat.
- It carries explicit source labeling so the user can tell it came from a child session.
- The distinction is represented in data by message_kind and source_session_id.

### 3.3.3 Sending and stopping rules
- A single session may not run multiple user sends concurrently.
- While a session is running, it must not accept a new send.
- To stop a running session, the user presses Esc twice.
- First Esc enters a stop-armed UI state.
- Second Esc sends a real stop request down to the underlying PI agent execution.
- After stop completes, the session returns to an idle state and can accept a new message.
- It is valid to leave a running session and open another session while the first continues running in the background.

## 3.4 Session Info page behavior
Session Info is a read-only explanatory view for the current session.

### 3.4.1 Data loading
- Session Info data is not loaded by default when Chat is opened.
- It is queried only when the Session Info tab is selected.
- Session Info reads from the local platform database rather than PI live chat APIs.

### 3.4.2 Information density
Session Info is a medium-density information page, not a log terminal and not an operations console.

Recommended sections:
1. Overview
2. Prompts
3. Sync
4. Recent Events

### 3.4.3 Session Info content
Overview should include:
- session title
- role template name/key/version
- project
- parent session and root session context
- created_by and created_at
- pi_session_id
- archive/runtime state

Prompts should include:
- role_base_prompt_snapshot
- user_supplied_prompt
- parent_supplied_prompt
- compiled_prompt

Prompt visibility rule:
- all prompt fragments are visible
- compiled_prompt is visible and may be default-collapsed for readability

Sync should include:
- sync_status
- last_synced_at
- last_pi_message_id
- last_error
- retry_count

Recent Events should include:
- a recent bounded slice of session_events, such as the latest 10-20 records

### 3.4.4 Session Info non-goals
- no create-child action
- no manual writeback action
- no archive action
- no retry-sync action
- no role editing
- no prompt editing

## 4. Frontend Technology Choices

### 4.1 Framework and rendering stack
The agreed frontend stack for v1 is:
- Next.js with App Router
- React
- TypeScript
- Tailwind CSS
- shadcn/ui
- framer-motion

Reasons:
- strong fit for a modern browser-based workbench
- compatible with dense but refined application UI
- a clean fit for a dedicated frontend application in either split-deploy or unified-deploy mode
- enough control to avoid the look and feel of a generic admin panel

### 4.2 Package/runtime choice
The agreed package/runtime direction is Bun-first.

The project will use Bun as:
- package manager
- workspace manager
- task runner
- primary runtime target

Important boundary:
- Bun is expected to be sufficiently Node-compatible for this project.
- The codebase should still avoid unnecessary dependence on exotic Bun-only APIs where a standard JS/TS approach is sufficient.
- If a future compatibility issue is discovered specifically in PI Agent SDK integration, that may be handled as a later engineering adjustment, but the current design assumes Bun full-stack usage.

### 4.3 Frontend state strategy
- Server-derived data should use TanStack Query.
- Local UI state should remain in React state/context where possible.
- A heavy client-side global state solution is not required at the start.
- Zustand is intentionally not part of the initial baseline.

### 4.4 Frontend module structure
The frontend should be feature-oriented rather than page-component dumping.

Suggested feature boundaries:
- features/project-tree
- features/chat
- features/session-info
- features/auth
- features/layout-shell

This is intended to keep the product shell stable while individual capabilities evolve.

## 5. Backend Architecture and Module Boundaries

## 5.1 Overall backend shape
The backend should remain in the same repository as the frontend, but not be coupled to the frontend runtime.

Recommended structure:
- apps/web provides the dedicated frontend application.
- apps/api provides the dedicated backend API service.
- Domain logic lives in isolated packages/services rather than directly inside API entry code.
- PI-specific SDK adaptation is isolated behind a dedicated adapter package.

This produces a same-repo dual-app topology that supports both split deployment and unified deployment without collapsing backend logic into the frontend runtime.

## 5.2 Workspace structure
The agreed project structure is a workspace-style monorepo with two apps and several supporting packages.

Recommended layout:
- apps/web
- apps/api
- packages/db
- packages/domain
- packages/pi-client
- packages/ui
- packages/shared

Responsibilities:
- apps/web: Next.js frontend application
- apps/api: Hono + Bun backend API service, auth entry point, streaming/chat proxy entry point
- packages/db: Drizzle schema, migration config, db access
- packages/domain: business/domain services for projects, sessions, roles, sync, audit
- packages/pi-client: PI Agent SDK adapter and integration layer
- packages/ui: shared visual components and design primitives
- packages/shared: shared types, DTOs, constants, enums, schemas

Logical backend layers:
- Web API layer: serves frontend-facing APIs only
- Project management layer: manages project lifecycle and project initialization flow
- Role management layer: system core; owns role/session lifecycle and session-tree control-plane truth
- PI SDK layer: wraps PI SDK capabilities only
- Extension injection layer: injects tools into PI agents and forwards tool calls to role management
- DB: SQLite-backed control-plane persistence
- Log: system and runtime logging for diagnostics and operational traceability

## 5.3 HTTP/API layer responsibilities
The backend HTTP boundary lives in apps/api and is implemented with Hono on Bun.

It should:
- authenticate requests
- validate input
- call domain services
- shape response DTOs
- bridge streaming and request/response semantics

It should not:
- contain core domain rules
- embed direct PI orchestration logic
- directly own database query logic beyond shallow wiring

The frontend application in apps/web must not become a second backend. Core business truth must remain in apps/api regardless of whether deployment is split or unified.

## 5.4 Authentication
The agreed authentication model is:
- local accounts only
- no OAuth
- no email verification
- no password reset flow in v1

Recommended library:
- better-auth

Authentication scope for v1:
- initialize/admin-capable first user flow if needed by product bootstrapping
- login
- logout
- session-based server-side auth

Authorization scope for v1:
- project visibility is limited to the creating user
- no collaborator model
- no team/org model
- no advanced RBAC

## 5.5 Core backend responsibility boundaries
- The Web API layer serves frontend APIs and remains a thin protocol boundary.
- The Project management layer creates and queries projects, but does not directly create sessions.
- The Role management layer is the system core. It owns role lifecycle, session lifecycle, prompt compilation, session-tree maintenance, parent-child relationships, writeback target resolution, and PI-facing execution decisions.
- The PI SDK layer only exposes wrapped PI capabilities and must not contain platform business rules.
- The Extension injection layer is intentionally thin: it registers tools, receives tool invocations from PI, assembles invocation context, and hands execution to the Role management layer. It does not maintain the session tree or perform business orchestration.
- Session-tree truth belongs to the Role management layer rather than to LLM tool parameters or extension-layer state.

## 6. PI Agent Integration and Platform Extensions

## 6.1 PI adapter role
PI Agent SDK is treated as a lower-level execution engine.

A dedicated adapter layer in packages/pi-client should encapsulate:
- session creation in PI
- message history retrieval from PI
- streaming send to PI
- stop request forwarding to PI
- extension/tool registration against PI
- error normalization and translation to platform semantics

PI adapter code must not be spread across pages or ad hoc route files.

## 6.2 Platform-owned orchestration behavior
The platform, not PI, owns:
- role template selection
- prompt composition
- parent-child session lineage
- child session creation semantics
- explicit parent writeback semantics
- local replica and sync state tracking

The session tree is therefore a platform-controlled orchestration tree whose nodes happen to map to individual PI sessions. Its authoritative control-plane truth lives in the Role management layer, not in tool parameters exposed to LLMs. Parent-child relationships, writeback targets, role lifecycle, and prompt compilation are platform-owned decisions.

## 6.3 Extension tools
V1 requires platform-registered extension tools layered on top of PI.

At minimum:
- spawn_session
- writeback_to_parent

### 6.3.1 spawn_session
Purpose:
- create a child session from the current session context
- accept an explicitly decided role together with task intent
- compile prompt from role and prompt inputs
- create the corresponding PI session
- return immediately without blocking for child completion

LLM-facing inputs:
- role
- target
- constraints

Important boundary:
- spawn_session does not expose parent identifiers or session-tree structure to the LLM
- the Role management layer resolves the parent session from the current execution context

Behavior:
- once invoked, the tool executes directly with no additional frontend confirmation
- the human/LLM alignment and confirmation are assumed to have already happened before the tool call
- synchronously validates role, target, and constraints
- synchronously resolves parent context
- synchronously compiles prompt
- synchronously creates the local session record and tree relationship
- synchronously creates the PI session
- synchronously records required events and logs
- immediately returns child_session_id, pi_session_id, and creation status
- the child session's subsequent execution is asynchronous and does not block the tool call

### 6.3.2 writeback_to_parent
Purpose:
- explicitly write a result summary from a child session into its parent session

Important boundary:
- the tool does not require the LLM to specify the parent session id
- the Role management layer resolves the parent target from the current session context

Behavior:
- v1 does not automatically write back in the general case
- most sessions are expected not to auto-writeback
- writeback is an explicit act initiated by a tool call or user/agent intent
- once invoked, the tool executes directly with no extra frontend confirmation
- v1 supports writeback only to the parent session, not arbitrary project sessions
- writeback is executed synchronously by the Role management layer
- writeback must enter the parent PI session and also be written to the local database replica

### 6.3.3 Tool availability policy
- V1 does not include tool allowlists by role or by session.
- Platform tools are loaded broadly by PI Agent integration.
- The platform does not add a separate tool capability permission system at this stage.

## 7. Data Layer Design

## 7.1 Data-layer philosophy
The agreed data-layer approach is a medium-control-plane design.

Meaning:
- PI is the source of truth for live chat and ongoing session execution behavior.
- The local database is a durable control-plane model and replica layer.
- The local database stores enough information to render the tree, interpret sessions, store role bindings and prompt snapshots, keep a full replica of messages/events, and maintain sync/audit state.
- Chat page reads PI directly.
- Session Info reads local data.

This deliberately avoids both extremes:
- too-thin shell that stores almost nothing locally
- too-heavy orchestration engine with run/job modeling that is premature for v1

## 7.2 Database technology
The agreed database stack is:
- SQLite
- Drizzle ORM
- Drizzle Kit

Rationale:
- minimal operational burden
- appropriate for LAN-first v1
- sufficient for the expected product complexity and traffic level
- good fit for typed TypeScript schema and migrations

## 7.3 Core tables
The v1 core tables are:
- users
- projects
- role_templates
- sessions
- messages
- session_events
- session_sync_states
- audit_events

### 7.3.1 users
Fields:
- id
- email
- password_hash
- name
- created_at

Responsibilities:
- represent local account identity
- support authentication and basic ownership/audit linkage

### 7.3.2 projects
Fields:
- id
- name
- created_by
- status
- archived_at
- archived_by
- last_activity_at
- created_at
- updated_at

Rules:
- projects are containers only
- projects have no root chat
- project visibility is limited to the creating user in v1
- projects support active or archived visibility state
- no description field in v1

### 7.3.3 role_templates
Fields:
- id
- key
- version
- name
- description
- base_prompt
- config_json
- created_by (nullable)
- owner_type
- visibility
- is_builtin
- archived_at (nullable)
- created_at
- updated_at

Rules:
- role templates are versioned
- new versions create new records rather than overwriting old ones
- v1 operationally supports built-in templates only
- the data model leaves room for future user-created templates
- minimum built-ins for v1 are planner and blank

RoleTemplate.config_json scope in v1:
- minimal runtime parameters only
- not a full policy/config system
- expected fields may include model, temperature, max_output_tokens, reasoning-level-like values if supported, thin tool-use hints, and metadata

### 7.3.4 sessions
Fields:
- id
- project_id
- parent_session_id (nullable)
- root_session_id
- depth
- role_template_id
- pi_session_id
- requested_by_message_id (nullable)
- title
- title_source
- status
- runtime_status
- last_activity_at
- last_run_at (nullable)
- last_stop_at (nullable)
- last_runtime_error (nullable)
- created_by
- archived_at (nullable)
- archived_by (nullable)
- created_at
- updated_at

Prompt snapshot fields stored directly on Session:
- role_base_prompt_snapshot
- user_supplied_prompt
- parent_supplied_prompt
- compiled_prompt

Rules:
- one session maps to exactly one PI session
- one session binds exactly one immutable role template version
- role binding never changes after creation
- prompt snapshots are written at creation time and then treated as read-only
- title is defaulted initially and may later be generated or manually overridden
- if user manually changes title, later automation must not override it

Tree semantics:
- top-level project sessions have parent_session_id = null
- root_session_id identifies the top-most ancestor session for a lineage
- depth is tracked explicitly
- tree ordering is by last_activity_at among siblings

Session title semantics:
- title_source = default | generated | user
- default title is created at session creation time
- a suggested/generated title may be produced after early conversation
- user title change is authoritative

Session status semantics:
- status = active | archived
- runtime_status = idle | running | stopping | error

These two dimensions must remain separate.

### 7.3.5 messages
Fields:
- id
- session_id
- pi_message_id (nullable)
- message_kind
- source_session_id (nullable)
- role
- content_text
- content_blocks_json (nullable)
- content_version
- created_at

Rules:
- local message records form a replica, not the primary chat rendering source
- role values are user, assistant, system
- message_kind values are normal and writeback
- writeback messages appear as assistant messages in the UI with explicit source labeling
- content_text is the primary readable message body
- content_blocks_json is reserved for structured rich content evolution
- v1 includes no attachment/file model

### 7.3.6 session_events
Fields:
- id
- session_id
- type
- payload
- parent_message_id (nullable)
- sequence
- created_at

Purpose:
- store operational events and execution-related timeline entries
- keep runtime/process detail separate from the main chat message stream

Expected event families include:
- spawn_requested
- child_session_created
- sync_started
- sync_completed
- sync_failed
- writeback_requested
- writeback_written
- writeback_failed
- error

### 7.3.7 session_sync_states
Fields:
- session_id
- sync_status
- last_synced_at
- last_pi_message_id
- last_pi_event_id (nullable)
- last_error (nullable)
- retry_count
- updated_at

Purpose:
- track control-plane sync position and sync health independently from session identity

Rules:
- sync state is not considered part of the core business identity of a session
- sync state is modeled separately to allow future retries, repair, and diagnostics

### 7.3.8 audit_events
Fields:
- id
- user_id
- action
- target_type
- target_id
- payload
- created_at

Audit scope in v1:
- record login
- record change actions such as project creation, session creation, forking, archive operations, and other platform mutations
- do not record ordinary view/read access

## 7.4 Session creation rules
### 7.4.1 Project initialization
A newly created project automatically receives one top-level Planner session.

Initialization boundary:
- the Project management layer creates the project itself
- the Project management layer does not directly create the default session
- instead, it calls the Role management layer to create the default Planner session

Frontend refresh behavior after project creation:
- the create-project API does not need to return a fully assembled tree or default-session payload
- after project creation succeeds, the frontend simply re-fetches the full project/session tree
- the frontend must not perform complex tree stitching locally

### 7.4.2 Manual session creation
The user may manually create a top-level Blank session under the project.

Creation boundary:
- top-level Blank session creation also goes through the Role management layer
- the frontend refresh strategy is the same as project creation: after success, re-fetch the full project/session tree

Blank role semantics:
- Blank is a real built-in role template, not a null-role session
- Blank is intentionally minimal and not strongly opinionated
- Blank is immutable like any other role binding

### 7.4.3 Child session creation
- child sessions are created via platform tooling/orchestration
- child sessions are independent sessions with their own PI session and immutable role binding
- child sessions are modeled in the same sessions table and tree as all other sessions
- all session creation paths are owned by the Role management layer, including project-default sessions, manually created top-level Blank sessions, and spawned child sessions

## 7.5 Replica and sync behavior
### 7.5.1 Message ownership model
- PI remains the source of truth for chat history.
- The local database stores a full replica for platform use.
- Local replicas may be rebuilt or repaired if drift is detected.
- When there is disagreement, PI truth wins.

### 7.5.2 Sync strategy
The agreed sync style is proactive-plus-repairable:
- while a session is actively running, the backend captures flow and writes local replica data
- when needed, light reconciliation can occur against PI state
- Session Info and platform diagnostics rely on the local sync state model

### 7.5.3 Runtime activity updates
The following should update last_activity_at appropriately:
- new message arrival
- new relevant session event
- child session creation
- writeback into parent
- sync completion that introduces new content

Both projects and sessions carry last_activity_at to support efficient recent-first navigation.

## 8. Runtime and Interaction Rules

## 8.1 Single-session concurrency
- One session cannot process multiple simultaneous sends.
- The frontend must prevent a new send while runtime_status is running or stopping.
- Stopping must propagate to PI, not merely cancel a UI subscription.

## 8.2 Background running and navigation
- A running session may continue while the user navigates elsewhere.
- Tree state and session runtime state must remain independent from the currently open page.
- Returning to a running session should reconnect the user to the ongoing visible output stream.

## 8.3 Archive semantics
- Archive is a visibility/lifecycle operation, not a hard delete.
- Projects and sessions are archived, not deleted.
- Messages and events are not manually deleted in v1.
- Archived sessions remain part of the tree lineage and can be shown in-place.

## 8.4 Writeback semantics
- Automatic writeback is intentionally not a general default in v1.
- Most child sessions are expected not to auto-writeback.
- Explicit writeback is supported by a dedicated tool.
- V1 writeback targets parent session only.
- A writeback produces a normal chat-visible assistant message in the parent session with writeback markers and source_session_id.
- Structured and readable forms are both expected: human-readable summary text plus structured blocks/payload if needed.

## 9. Technology Decisions Summary

The agreed technical baseline is:
- Bun workspaces
- Next.js App Router
- React + TypeScript
- Tailwind CSS
- shadcn/ui
- framer-motion
- TanStack Query
- Hono + Bun for the backend API service
- better-auth
- SQLite
- Drizzle ORM / Drizzle Kit
- PI Agent SDK adapter isolated in packages/pi-client
- apps/api as the backend HTTP boundary
- domain services isolated in packages/domain
- deployment support for both split web/api deployment and unified same-host deployment

## 10. Deliberately Deferred Items

The following are intentionally not part of v1 baseline design:
- advanced RBAC
- teams/organizations/collaborators
- project descriptions and rich project metadata
- role-template management UI
- user-created role templates as a product feature
- attachment/file model
- full operations console behavior
- tool allowlists or per-role tool access policy
- SessionRun / Job modeling
- automatic multi-policy writeback orchestration
- message-thread branching inside a single session
- desktop shell packaging
- all-site WebSocket infrastructure for non-chat realtime features

## 11. API Design Baseline

This section records the agreed public API shape and realtime protocol baseline.

### 11.1 Separation of public APIs and internal platform actions
Public frontend-facing APIs are distinct from internal platform actions.

Frontend-facing APIs include:
- auth APIs
- tree/project/session query APIs
- chat history and send/stop APIs
- session archive API

Internal platform actions include:
- spawn_session
- writeback_to_parent

spawn_session and writeback_to_parent are not considered primary frontend APIs. They are internal orchestration capabilities invoked through the extension/tool path and executed by the Role management layer.

### 11.2 HTTP API baseline
- Base path: /api/v1
- apps/api is the only backend HTTP boundary
- apps/web consumes apps/api rather than implementing a parallel backend surface
- Queries and mutations are exposed as ordinary HTTP endpoints
- Chat send is an HTTP mutation
- Chat output is received through WebSocket streaming frames

### 11.3 Error response format
Public HTTP APIs should use a unified error format:

```json
{
  "error": {
    "code": "SESSION_BUSY",
    "message": "Session is currently running and cannot accept a new message.",
    "details": {}
  }
}
```

Rules:
- do not wrap success responses in a mandatory success: true envelope
- expose error.code, error.message, and optional error.details

### 11.4 HTTP query APIs
#### 11.4.1 GET /api/v1/tree
Purpose:
- return the entire project + session tree visible to the current user

Rules:
- backend assembles the full nested tree
- backend handles ordering, node shaping, and hierarchy construction
- response includes archived sessions as part of the full tree
- frontend performs only visibility filtering for archived-session display toggle
- frontend does not rebuild tree structure locally

#### 11.4.2 GET /api/v1/sessions/:sessionId/info
Purpose:
- return the fully aggregated Session Info payload for the selected session

Rules:
- this is a single aggregate endpoint
- frontend does not stitch multiple info endpoints together
- called only when Session Info tab is entered

Expected payload includes:
- session overview
- role template summary
- prompt snapshots
- sync state
- recent events

#### 11.4.3 GET /api/v1/sessions/:sessionId/chat/messages
Purpose:
- return chat history for the selected session

Rules:
- chat history is sourced from PI
- frontend uses a cursor-style pagination model
- if PI supports native pagination, backend adapts that directly
- if PI does not support pagination, backend may fetch available full history, cache it for a short TTL window, and locally slice it into cursor pages
- if PI does not provide stable message ids, backend may generate temporary cursors

### 11.5 HTTP mutation APIs
#### 11.5.1 POST /api/v1/projects
Purpose:
- create a project

Rules:
- project creation always auto-creates a default top-level Planner session
- frontend does not control this behavior with a request flag
- response does not need to include a fully assembled tree or default-session summary
- after success, frontend re-fetches the full tree

#### 11.5.2 POST /api/v1/projects/:projectId/sessions
Purpose:
- create a top-level Blank session under the project

Rules:
- creation is handled through the Role management layer
- after success, frontend re-fetches the full tree

#### 11.5.3 POST /api/v1/sessions/:sessionId/chat/messages
Purpose:
- send one new user message into the session

Rules:
- this is a command-style mutation
- success means the request has been accepted for processing
- actual assistant output returns through WebSocket chat_stream frames
- if the session is already running or stopping, the endpoint returns an error instead of queueing a second send

#### 11.5.4 POST /api/v1/sessions/:sessionId/stop
Purpose:
- stop the currently running session

Rules:
- must propagate to PI rather than only canceling frontend display
- used by the two-Esc stop interaction path in the UI

#### 11.5.5 POST /api/v1/sessions/:sessionId/archive
Purpose:
- archive a session

Rules:
- v1 exposes session archive but not project archive in the frontend API surface
- after success, frontend re-fetches the full tree

### 11.6 WebSocket baseline
A single user-scoped WebSocket connection is used for realtime delivery.

Rules:
- the connection is established after login
- a global user-level stream is always active
- the frontend explicitly sends current context updates so the backend can apply enhanced subscription rules
- frontend does not connect directly to PI

### 11.7 WebSocket outbound message kinds
Realtime messages are split into two families.

#### 11.7.1 Control-plane events
Control-plane events use this envelope shape:

```json
{
  "kind": "event",
  "type": "session.created",
  "timestamp": "2026-06-02T12:34:56.000Z",
  "scope": {
    "project_id": "p_123",
    "session_id": "s_456"
  },
  "payload": {}
}
```

Event examples:
- project.created
- project.updated
- session.created
- session.updated
- session.archived
- tree.changed
- session.runtime_status_changed
- session.writeback.received
- session.sync_status_changed

#### 11.7.2 Chat stream frames
Chat output is not modeled as ordinary control-plane events.
It is modeled as a dedicated chat_stream message family.

Envelope shape:

```json
{
  "kind": "chat_stream",
  "phase": "delta",
  "timestamp": "2026-06-02T12:34:56.100Z",
  "scope": {
    "session_id": "s_456"
  },
  "payload": {
    "stream_id": "st_001",
    "message_id": "m_001",
    "delta": "hello",
    "blocks": null
  }
}
```

Rules:
- phase values are start, delta, complete, error
- delta is primarily text
- blocks is optional and reserved for structured extension

### 11.8 WebSocket inbound client messages
Frontend-to-backend WebSocket messages should at minimum support:
- hello
- set_context
- ping

Context update shape:

```json
{
  "kind": "client",
  "type": "set_context",
  "payload": {
    "project_id": "p_123",
    "session_id": "s_456",
    "current_tab": "chat"
  }
}
```

Rules:
- current context is explicitly pushed by the frontend
- project_id, session_id, and current_tab are all included for future extensibility

### 11.9 Realtime delivery rules
- global user-scoped connection receives global control-plane events
- current-context enhancement applies after set_context
- when current_tab is chat, the backend may push fine-grained chat_stream delta frames for the active session
- when current_tab is session_info, the backend should not push fine-grained chat delta frames; only summary-level state changes should be pushed
- for background sessions not currently opened, frontend should receive summary-level status changes rather than full token streams

### 11.10 Chat load and stream model
The agreed chat flow is:
1. frontend enters Chat tab
2. frontend loads recent history via HTTP
3. frontend sends a new message via HTTP
4. backend emits chat_stream:start over WebSocket
5. backend emits chat_stream:delta frames over WebSocket
6. backend emits chat_stream:complete or chat_stream:error

This keeps history loading and live streaming clearly separated.

## 12. Recommended Next Step

The next design phase after this document is implementation planning, based on the now-fixed:
- frontend shell and interaction model
- backend module boundaries
- data model
- public HTTP API baseline
- WebSocket protocol baseline
- internal spawn/writeback orchestration boundaries

This document is intended to be the authoritative baseline for those implementation decisions.
