-- Frozen schema generated from Agent Team Hub 0.1.0 version 1.
CREATE TABLE artifacts (
	id VARCHAR NOT NULL,
	label VARCHAR NOT NULL,
	content_type VARCHAR NOT NULL,
	size INTEGER NOT NULL,
	uploaded_by VARCHAR NOT NULL,
	created_at VARCHAR NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(uploaded_by) REFERENCES users (id)
);

CREATE TABLE bindings (
	id VARCHAR NOT NULL,
	work_item_id VARCHAR NOT NULL,
	user_id VARCHAR NOT NULL,
	client_instance_id VARCHAR NOT NULL,
	harness VARCHAR NOT NULL,
	workspace_ref VARCHAR NOT NULL,
	local_todo_id VARCHAR,
	session_id VARCHAR,
	created_at VARCHAR NOT NULL,
	updated_at VARCHAR NOT NULL,
	PRIMARY KEY (id),
	UNIQUE (work_item_id, user_id, client_instance_id, harness),
	FOREIGN KEY(work_item_id) REFERENCES work_items (id),
	FOREIGN KEY(user_id) REFERENCES users (id)
);

CREATE TABLE capabilities (
	id VARCHAR NOT NULL,
	slug VARCHAR NOT NULL,
	name VARCHAR NOT NULL,
	description TEXT NOT NULL,
	kind VARCHAR NOT NULL,
	owner_team_id VARCHAR NOT NULL,
	tags JSON NOT NULL,
	latest_version VARCHAR,
	created_at VARCHAR NOT NULL,
	PRIMARY KEY (id),
	UNIQUE (slug),
	FOREIGN KEY(owner_team_id) REFERENCES teams (id)
);

CREATE TABLE deliveries (
	id VARCHAR NOT NULL,
	work_item_id VARCHAR NOT NULL,
	sequence INTEGER NOT NULL,
	spec_revision INTEGER NOT NULL,
	summary TEXT NOT NULL,
	artifacts JSON NOT NULL,
	run_ids JSON NOT NULL,
	submitted_by VARCHAR NOT NULL,
	created_at VARCHAR NOT NULL,
	PRIMARY KEY (id),
	UNIQUE (work_item_id, sequence),
	FOREIGN KEY(work_item_id) REFERENCES work_items (id),
	FOREIGN KEY(submitted_by) REFERENCES users (id)
);

CREATE TABLE dependencies (
	work_item_id VARCHAR NOT NULL,
	depends_on_id VARCHAR NOT NULL,
	PRIMARY KEY (work_item_id, depends_on_id),
	FOREIGN KEY(work_item_id) REFERENCES work_items (id),
	FOREIGN KEY(depends_on_id) REFERENCES work_items (id)
);

CREATE TABLE events (
	id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
	type VARCHAR NOT NULL,
	entity_id VARCHAR NOT NULL,
	actor_id VARCHAR NOT NULL,
	payload JSON NOT NULL,
	created_at VARCHAR NOT NULL
);

CREATE TABLE operation_receipts (
	actor_id VARCHAR NOT NULL,
	operation_id VARCHAR NOT NULL,
	fingerprint VARCHAR NOT NULL,
	response JSON NOT NULL,
	created_at VARCHAR NOT NULL,
	PRIMARY KEY (actor_id, operation_id)
);

CREATE TABLE progress (
	id VARCHAR NOT NULL,
	work_item_id VARCHAR NOT NULL,
	summary TEXT NOT NULL,
	blocked_reason TEXT,
	waiting_on TEXT,
	next_action TEXT,
	author_id VARCHAR NOT NULL,
	created_at VARCHAR NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(work_item_id) REFERENCES work_items (id),
	FOREIGN KEY(author_id) REFERENCES users (id)
);

CREATE TABLE projects (
	id VARCHAR NOT NULL,
	name VARCHAR NOT NULL,
	description TEXT,
	PRIMARY KEY (id)
);

CREATE TABLE releases (
	id VARCHAR NOT NULL,
	capability_id VARCHAR NOT NULL,
	version VARCHAR NOT NULL,
	manifest JSON NOT NULL,
	files JSON NOT NULL,
	created_at VARCHAR NOT NULL,
	PRIMARY KEY (id),
	UNIQUE (capability_id, version),
	FOREIGN KEY(capability_id) REFERENCES capabilities (id)
);

CREATE TABLE reviews (
	id VARCHAR NOT NULL,
	delivery_id VARCHAR NOT NULL,
	decision VARCHAR NOT NULL,
	reason TEXT NOT NULL,
	reviewer_id VARCHAR NOT NULL,
	created_at VARCHAR NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(delivery_id) REFERENCES deliveries (id),
	FOREIGN KEY(reviewer_id) REFERENCES users (id)
);

CREATE TABLE runs (
	id VARCHAR NOT NULL,
	dispatch_id VARCHAR NOT NULL,
	work_item_id VARCHAR NOT NULL,
	client_instance_id VARCHAR NOT NULL,
	harness VARCHAR NOT NULL,
	workspace_ref VARCHAR NOT NULL,
	requested_by VARCHAR NOT NULL,
	status VARCHAR NOT NULL,
	external_session_id VARCHAR,
	external_run_id VARCHAR,
	capability_releases JSON NOT NULL,
	result_summary TEXT NOT NULL,
	spec_revision INTEGER NOT NULL,
	assignment_generation INTEGER NOT NULL,
	input_snapshot JSON NOT NULL,
	sequence INTEGER NOT NULL,
	created_at VARCHAR NOT NULL,
	last_seen_at VARCHAR NOT NULL,
	PRIMARY KEY (id),
	UNIQUE (dispatch_id),
	FOREIGN KEY(work_item_id) REFERENCES work_items (id),
	FOREIGN KEY(requested_by) REFERENCES users (id)
);

CREATE TABLE schema_versions (
	version INTEGER NOT NULL,
	PRIMARY KEY (version)
);

CREATE TABLE settings (
	"key" VARCHAR NOT NULL,
	value JSON NOT NULL,
	PRIMARY KEY ("key")
);

CREATE TABLE teams (
	id VARCHAR NOT NULL,
	name VARCHAR NOT NULL,
	PRIMARY KEY (id)
);

CREATE TABLE toolsets (
	team_id VARCHAR NOT NULL,
	version INTEGER NOT NULL,
	items JSON NOT NULL,
	PRIMARY KEY (team_id),
	FOREIGN KEY(team_id) REFERENCES teams (id)
);

CREATE TABLE users (
	id VARCHAR NOT NULL,
	name VARCHAR NOT NULL,
	team_id VARCHAR NOT NULL,
	role VARCHAR NOT NULL,
	token_hash VARCHAR NOT NULL,
	active BOOLEAN NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(team_id) REFERENCES teams (id),
	UNIQUE (token_hash)
);

CREATE TABLE work_items (
	id VARCHAR NOT NULL,
	number VARCHAR NOT NULL,
	title VARCHAR NOT NULL,
	description TEXT NOT NULL,
	project_id VARCHAR NOT NULL,
	requesting_team_id VARCHAR NOT NULL,
	requester_id VARCHAR NOT NULL,
	owner_team_id VARCHAR NOT NULL,
	pending_target_team_id VARCHAR,
	assignee_id VARCHAR,
	reviewer_id VARCHAR NOT NULL,
	status VARCHAR NOT NULL,
	priority VARCHAR NOT NULL,
	due_at VARCHAR,
	acceptance_spec JSON NOT NULL,
	blocked_reason TEXT,
	waiting_on VARCHAR,
	next_action TEXT,
	version INTEGER NOT NULL,
	spec_revision INTEGER NOT NULL,
	current_delivery_id VARCHAR,
	assignment_generation INTEGER NOT NULL,
	created_at VARCHAR NOT NULL,
	updated_at VARCHAR NOT NULL,
	PRIMARY KEY (id),
	UNIQUE (number),
	FOREIGN KEY(project_id) REFERENCES projects (id),
	FOREIGN KEY(requesting_team_id) REFERENCES teams (id),
	FOREIGN KEY(requester_id) REFERENCES users (id),
	FOREIGN KEY(owner_team_id) REFERENCES teams (id),
	FOREIGN KEY(pending_target_team_id) REFERENCES teams (id),
	FOREIGN KEY(assignee_id) REFERENCES users (id),
	FOREIGN KEY(reviewer_id) REFERENCES users (id)
);

CREATE INDEX ix_runs_item_status ON runs (work_item_id, status);

CREATE INDEX ix_work_items_target ON work_items (pending_target_team_id);

CREATE INDEX ix_work_items_team_status ON work_items (owner_team_id, status);
