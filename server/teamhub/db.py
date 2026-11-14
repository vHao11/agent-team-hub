from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path

from sqlalchemy import (
    JSON, Boolean, Column, ForeignKey, Index, Integer, MetaData, String,
    Table, Text, UniqueConstraint, create_engine, event, select,
)

metadata = MetaData()

schema_versions = Table("schema_versions", metadata, Column("version", Integer, primary_key=True))
settings = Table("settings", metadata, Column("key", String, primary_key=True), Column("value", JSON, nullable=False))
teams = Table("teams", metadata, Column("id", String, primary_key=True), Column("name", String, nullable=False))
users = Table(
    "users", metadata,
    Column("id", String, primary_key=True), Column("name", String, nullable=False),
    Column("team_id", ForeignKey("teams.id"), nullable=False), Column("role", String, nullable=False),
    Column("token_hash", String, unique=True, nullable=False), Column("active", Boolean, nullable=False, default=True),
)
projects = Table("projects", metadata, Column("id", String, primary_key=True), Column("name", String, nullable=False), Column("description", Text, default=""))
work_items = Table(
    "work_items", metadata,
    Column("id", String, primary_key=True), Column("number", String, unique=True, nullable=False),
    Column("title", String, nullable=False), Column("description", Text, nullable=False),
    Column("project_id", ForeignKey("projects.id"), nullable=False),
    Column("requesting_team_id", ForeignKey("teams.id"), nullable=False),
    Column("requester_id", ForeignKey("users.id"), nullable=False),
    Column("owner_team_id", ForeignKey("teams.id"), nullable=False),
    Column("pending_target_team_id", ForeignKey("teams.id")),
    Column("assignee_id", ForeignKey("users.id")), Column("reviewer_id", ForeignKey("users.id"), nullable=False),
    Column("status", String, nullable=False), Column("priority", String, nullable=False),
    Column("due_at", String), Column("acceptance_spec", JSON, nullable=False),
    Column("blocked_reason", Text), Column("waiting_on", String), Column("next_action", Text),
    Column("version", Integer, nullable=False), Column("spec_revision", Integer, nullable=False),
    Column("current_delivery_id", String), Column("assignment_generation", Integer, nullable=False, default=1),
    Column("created_at", String, nullable=False), Column("updated_at", String, nullable=False),
)
Index("ix_work_items_team_status", work_items.c.owner_team_id, work_items.c.status)
Index("ix_work_items_target", work_items.c.pending_target_team_id)
dependencies = Table(
    "dependencies", metadata,
    Column("work_item_id", ForeignKey("work_items.id"), primary_key=True),
    Column("depends_on_id", ForeignKey("work_items.id"), primary_key=True),
)
progress = Table(
    "progress", metadata, Column("id", String, primary_key=True),
    Column("work_item_id", ForeignKey("work_items.id"), nullable=False),
    Column("summary", Text, nullable=False), Column("blocked_reason", Text), Column("waiting_on", Text),
    Column("next_action", Text), Column("author_id", ForeignKey("users.id"), nullable=False),
    Column("created_at", String, nullable=False),
)
deliveries = Table(
    "deliveries", metadata, Column("id", String, primary_key=True),
    Column("work_item_id", ForeignKey("work_items.id"), nullable=False),
    Column("sequence", Integer, nullable=False), Column("spec_revision", Integer, nullable=False),
    Column("summary", Text, nullable=False), Column("artifacts", JSON, nullable=False),
    Column("run_ids", JSON, nullable=False), Column("submitted_by", ForeignKey("users.id"), nullable=False),
    Column("pipeline_attempt_id", String),
    Column("created_at", String, nullable=False),
    UniqueConstraint("work_item_id", "sequence"),
)
reviews = Table(
    "reviews", metadata, Column("id", String, primary_key=True),
    Column("delivery_id", ForeignKey("deliveries.id"), nullable=False),
    Column("decision", String, nullable=False), Column("reason", Text, nullable=False),
    Column("reviewer_id", ForeignKey("users.id"), nullable=False), Column("created_at", String, nullable=False),
)
capabilities = Table(
    "capabilities", metadata, Column("id", String, primary_key=True), Column("slug", String, unique=True, nullable=False),
    Column("name", String, nullable=False), Column("description", Text, nullable=False), Column("kind", String, nullable=False),
    Column("owner_team_id", ForeignKey("teams.id"), nullable=False), Column("tags", JSON, nullable=False),
    Column("latest_version", String), Column("created_at", String, nullable=False),
)
releases = Table(
    "releases", metadata, Column("id", String, primary_key=True),
    Column("capability_id", ForeignKey("capabilities.id"), nullable=False), Column("version", String, nullable=False),
    Column("manifest", JSON, nullable=False), Column("files", JSON, nullable=False), Column("created_at", String, nullable=False),
    UniqueConstraint("capability_id", "version"),
)
toolsets = Table("toolsets", metadata, Column("team_id", ForeignKey("teams.id"), primary_key=True), Column("version", Integer, nullable=False), Column("items", JSON, nullable=False))
runs = Table(
    "runs", metadata, Column("id", String, primary_key=True), Column("dispatch_id", String, unique=True, nullable=False),
    Column("work_item_id", ForeignKey("work_items.id"), nullable=False), Column("client_instance_id", String, nullable=False),
    Column("harness", String, nullable=False), Column("workspace_ref", String, nullable=False),
    Column("requested_by", ForeignKey("users.id"), nullable=False), Column("status", String, nullable=False),
    Column("external_session_id", String), Column("external_run_id", String),
    Column("capability_releases", JSON, nullable=False), Column("result_summary", Text, nullable=False),
    Column("spec_revision", Integer, nullable=False), Column("assignment_generation", Integer, nullable=False),
    Column("input_snapshot", JSON, nullable=False), Column("sequence", Integer, nullable=False),
    Column("pipeline_attempt_id", String),
    Column("created_at", String, nullable=False), Column("last_seen_at", String, nullable=False),
)
Index("ix_runs_item_status", runs.c.work_item_id, runs.c.status)
bindings = Table(
    "bindings", metadata, Column("id", String, primary_key=True),
    Column("work_item_id", ForeignKey("work_items.id"), nullable=False), Column("user_id", ForeignKey("users.id"), nullable=False),
    Column("client_instance_id", String, nullable=False), Column("harness", String, nullable=False),
    Column("workspace_ref", String, nullable=False), Column("local_todo_id", String), Column("session_id", String),
    Column("created_at", String, nullable=False), Column("updated_at", String, nullable=False),
    UniqueConstraint("work_item_id", "user_id", "client_instance_id", "harness"),
)
events = Table(
    "events", metadata, Column("id", Integer, primary_key=True, autoincrement=True),
    Column("type", String, nullable=False), Column("entity_id", String, nullable=False),
    Column("actor_id", String, nullable=False), Column("payload", JSON, nullable=False), Column("created_at", String, nullable=False),
    sqlite_autoincrement=True,
)
operation_receipts = Table(
    "operation_receipts", metadata, Column("actor_id", String, primary_key=True), Column("operation_id", String, primary_key=True),
    Column("fingerprint", String, nullable=False), Column("response", JSON, nullable=False), Column("created_at", String, nullable=False),
)
artifacts = Table(
    "artifacts", metadata, Column("id", String, primary_key=True), Column("label", String, nullable=False),
    Column("content_type", String, nullable=False), Column("size", Integer, nullable=False),
    Column("uploaded_by", ForeignKey("users.id"), nullable=False), Column("created_at", String, nullable=False),
    Column("sha256", String),
)

workflow_templates = Table(
    "workflow_templates", metadata, Column("id", String, primary_key=True),
    Column("name", String, nullable=False), Column("description", Text, nullable=False),
    Column("owner_team_id", ForeignKey("teams.id"), nullable=False),
    Column("created_by", ForeignKey("users.id"), nullable=False),
    Column("draft", JSON), Column("draft_revision", Integer, nullable=False),
    Column("created_at", String, nullable=False), Column("updated_at", String, nullable=False),
)
workflow_versions = Table(
    "workflow_versions", metadata, Column("id", String, primary_key=True),
    Column("template_id", ForeignKey("workflow_templates.id"), nullable=False),
    Column("version", Integer, nullable=False), Column("definition", JSON, nullable=False),
    Column("sha256", String, nullable=False), Column("published_by", ForeignKey("users.id"), nullable=False),
    Column("created_at", String, nullable=False), UniqueConstraint("template_id", "version"),
)
pipelines = Table(
    "pipelines", metadata, Column("id", String, primary_key=True),
    Column("title", String, nullable=False), Column("description", Text, nullable=False),
    Column("project_id", ForeignKey("projects.id"), nullable=False),
    Column("template_version_id", ForeignKey("workflow_versions.id"), nullable=False),
    Column("requesting_team_id", ForeignKey("teams.id"), nullable=False),
    Column("created_by", ForeignKey("users.id"), nullable=False),
    Column("role_bindings", JSON, nullable=False), Column("status", String, nullable=False),
    Column("version", Integer, nullable=False), Column("generation", Integer, nullable=False),
    Column("blocked_reason", Text),
    Column("priority", String, nullable=False), Column("due_at", String),
    Column("created_at", String, nullable=False), Column("updated_at", String, nullable=False),
)
pipeline_steps = Table(
    "pipeline_steps", metadata, Column("id", String, primary_key=True),
    Column("pipeline_id", ForeignKey("pipelines.id"), nullable=False),
    Column("step_key", String, nullable=False), Column("position", Integer, nullable=False),
    Column("definition", JSON, nullable=False),
    Column("target_team_id", ForeignKey("teams.id"), nullable=False),
    Column("reviewer_id", ForeignKey("users.id"), nullable=False),
    Column("requested_assignee_id", ForeignKey("users.id")),
    Column("capability_releases", JSON), Column("current_attempt_id", String),
    UniqueConstraint("pipeline_id", "step_key"), UniqueConstraint("pipeline_id", "position"),
)
pipeline_attempts = Table(
    "pipeline_attempts", metadata, Column("id", String, primary_key=True),
    Column("step_id", ForeignKey("pipeline_steps.id"), nullable=False),
    Column("ordinal", Integer, nullable=False), Column("work_item_id", ForeignKey("work_items.id"), nullable=False),
    Column("input_snapshot", JSON, nullable=False),
    Column("created_at", String, nullable=False), Column("ended_at", String),
    UniqueConstraint("step_id", "ordinal"),
)
Index("ix_pipeline_attempts_item", pipeline_attempts.c.work_item_id)
Index("ix_pipeline_steps_pipeline", pipeline_steps.c.pipeline_id, pipeline_steps.c.position)

SCHEMA_VERSION = 2
V2_TABLES = (workflow_templates, workflow_versions, pipelines, pipeline_steps, pipeline_attempts)


def migrate_1_to_2(connection):
    for table in V2_TABLES:
        table.create(connection, checkfirst=True)
    connection.exec_driver_sql("ALTER TABLE deliveries ADD COLUMN pipeline_attempt_id VARCHAR")
    connection.exec_driver_sql("ALTER TABLE runs ADD COLUMN pipeline_attempt_id VARCHAR")
    connection.exec_driver_sql("ALTER TABLE artifacts ADD COLUMN sha256 VARCHAR")


MIGRATIONS = {1: migrate_1_to_2}


def initialize_schema(connection):
    """Check the installed version before creating or migrating anything."""
    names = set(connection.exec_driver_sql(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    ).scalars())
    if not names:
        metadata.create_all(connection)
        connection.execute(schema_versions.insert().values(version=SCHEMA_VERSION))
        return
    if "schema_versions" not in names:
        raise RuntimeError("Unsupported database: missing schema version; restore a compatible release.")
    versions = list(connection.execute(select(schema_versions.c.version)).scalars())
    if len(versions) != 1 or versions[0] < 1 or versions[0] > SCHEMA_VERSION:
        raise RuntimeError(f"Unsupported database schema: {versions}; restore a compatible release.")
    version = versions[0]
    while version < SCHEMA_VERSION:
        migration = MIGRATIONS.get(version)
        if migration is None:
            raise RuntimeError(f"No migration available from database schema {version}.")
        migration(connection)
        connection.execute(schema_versions.update().where(schema_versions.c.version == version).values(version=version + 1))
        version += 1


class Database:
    def __init__(self, data_dir: str | Path):
        self.data_dir = Path(data_dir).expanduser().resolve()
        self.data_dir.mkdir(parents=True, exist_ok=True)
        (self.data_dir / "artifacts").mkdir(exist_ok=True)
        self.engine = create_engine(f"sqlite:///{self.data_dir / 'teamhub.db'}", connect_args={"check_same_thread": False, "timeout": 15})

        @event.listens_for(self.engine, "connect")
        def sqlite_config(connection, _):
            connection.execute("PRAGMA foreign_keys=ON")
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("PRAGMA busy_timeout=15000")

        with self.write() as connection:
            initialize_schema(connection)

    @contextmanager
    def read(self):
        with self.engine.connect() as connection:
            yield connection

    @contextmanager
    def write(self):
        # A short SQLite writer transaction serializes checks + changes across processes.
        # External programs and network requests must never run inside this block.
        with self.engine.connect() as connection:
            connection.exec_driver_sql("BEGIN IMMEDIATE")
            try:
                yield connection
                connection.commit()
            except BaseException:
                connection.rollback()
                raise

    def close(self):
        self.engine.dispose()
