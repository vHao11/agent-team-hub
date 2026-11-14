import asyncio
import contextlib
import hashlib
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Literal

from fastapi import Depends, FastAPI, Header, Query, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError
from sqlalchemy.exc import IntegrityError, OperationalError
from starlette.exceptions import HTTPException

from . import __version__, db as m, schemas as s
from .bootstrap import DEMO_IDENTITIES, ensure_mode, seed_demo
from .integration_contract import integration_contract
from .service import DomainError, Hub, now, row, uid

logger = logging.getLogger('teamhub')


def payload(value):
    # Omitted fields must not erase existing progress/binding values.
    return value.model_dump(exclude_unset=True)


def create_app(data_dir: str | Path = '.teamhub', demo: bool = False) -> FastAPI:
    database = m.Database(data_dir)
    hub = Hub(database, demo=demo)
    ensure_mode(database, demo)
    if demo:
        seed_demo(hub)

    async def reconcile():
        while True:
            await asyncio.sleep(30)
            try:
                await asyncio.to_thread(hub.mark_stale_runs)
            except Exception:
                logger.exception('Run heartbeat reconciliation failed')

    @asynccontextmanager
    async def lifespan(app):
        monitor = asyncio.create_task(reconcile())
        try:
            yield
        finally:
            monitor.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await monitor
            database.close()

    app = FastAPI(title='Agent Team Hub', version=__version__, lifespan=lifespan,
                  description='跨组协作台账、版本化交付与共享能力库。执行记录与业务验收独立。')
    app.state.hub, app.state.database = hub, database
    app.add_middleware(CORSMiddleware, allow_origins=['http://localhost:5173', 'http://127.0.0.1:5173'],
                       allow_methods=['GET', 'POST', 'PUT'], allow_headers=['Authorization', 'Content-Type'])

    @app.exception_handler(DomainError)
    async def domain_error(_request, error):
        body = {'code': error.code, 'message': error.message}
        if error.details is not None:
            body['details'] = error.details
        return JSONResponse({'error': body}, status_code=error.status)

    @app.exception_handler(RequestValidationError)
    @app.exception_handler(ValidationError)
    async def invalid_request(_request, error):
        details = [{'field': '.'.join(map(str, x['loc'])), 'message': x['msg']} for x in error.errors()]
        return JSONResponse({'error': {'code': 'VALIDATION_ERROR', 'message': '请求内容不完整或格式有误。', 'details': details}}, status_code=422)

    @app.exception_handler(HTTPException)
    async def http_error(_request, error):
        return JSONResponse({'error': {'code': 'NOT_FOUND' if error.status_code == 404 else 'HTTP_ERROR', 'message': str(error.detail)}}, status_code=error.status_code)

    @app.exception_handler(IntegrityError)
    async def conflict(_request, _error):
        return JSONResponse({'error': {'code': 'CONSTRAINT_CONFLICT', 'message': '数据存在关联或唯一性冲突，请刷新后重试。'}}, status_code=409)

    @app.exception_handler(OperationalError)
    async def busy(_request, error):
        logger.error('Database operation failed: %s', type(error).__name__)
        return JSONResponse({'error': {'code': 'STORAGE_UNAVAILABLE', 'message': '数据存储暂时不可用，请用同一操作编号重试。'}}, status_code=503)

    def auth(authorization: Annotated[str | None, Header()] = None):
        prefix, _, token = (authorization or '').partition(' ')
        return hub.actor(token.strip() if prefix.lower() == 'bearer' else '')

    Actor = Annotated[dict, Depends(auth)]
    base = '/api/v1'

    @app.get(base + '/health', tags=['Workspace'])
    def health():
        return {'status': 'ok', 'version': __version__, 'demo_mode': demo}

    @app.get(base + '/demo', tags=['Workspace'])
    def demo_identities():
        if not demo:
            raise DomainError('NOT_FOUND', '当前工作空间未启用演示身份。', 404)
        return {'identities': DEMO_IDENTITIES}

    @app.get(base + '/bootstrap', tags=['Workspace'])
    def bootstrap(actor: Actor):
        return hub.bootstrap(actor)

    @app.get(base + '/integration/contract', tags=['Integration'])
    def get_integration_contract(actor: Actor):
        return integration_contract()

    @app.get(base + '/auth/me', tags=['Workspace'])
    def whoami(actor: Actor):
        return actor

    @app.post(base + '/teams', tags=['Workspace'])
    def create_team(body: s.Team, actor: Actor):
        return hub.create_team(actor, payload(body))

    @app.post(base + '/users', tags=['Workspace'])
    def create_user(body: s.User, actor: Actor):
        return hub.create_user(actor, payload(body))

    @app.get(base + '/workflow-templates', tags=['Workflows'])
    def workflow_templates(actor: Actor):
        return hub.workflows.list_templates()

    @app.post(base + '/workflow-templates', tags=['Workflows'])
    def create_workflow_template(body: s.WorkflowCreate, actor: Actor):
        return hub.workflows.create_template(actor, payload(body))

    @app.get(base + '/workflow-templates/{identifier}', tags=['Workflows'])
    def workflow_template(identifier: str, actor: Actor):
        return hub.workflows.get_template(identifier)

    @app.put(base + '/workflow-templates/{identifier}', tags=['Workflows'])
    def update_workflow_template(identifier: str, body: s.WorkflowUpdate, actor: Actor):
        return hub.workflows.update_template(actor, identifier, payload(body))

    @app.post(base + '/workflow-templates/{identifier}/validate', tags=['Workflows'])
    def validate_workflow_template(identifier: str, actor: Actor):
        return hub.workflows.validate_template(identifier)

    @app.post(base + '/workflow-templates/{identifier}/publish', tags=['Workflows'])
    def publish_workflow_template(identifier: str, body: s.WorkflowPublish, actor: Actor):
        return hub.workflows.publish_template(actor, identifier, payload(body))

    @app.post(base + '/workflow-templates/{identifier}/clone', tags=['Workflows'])
    def clone_workflow_template(identifier: str, body: s.Mutation, actor: Actor):
        return hub.workflows.clone_template(actor, identifier, payload(body))

    @app.get(base + '/pipelines', tags=['Pipelines'])
    def pipelines(actor: Actor):
        return hub.workflows.list_pipelines(actor)

    @app.post(base + '/pipelines', tags=['Pipelines'])
    def create_pipeline(body: s.PipelineCreate, actor: Actor):
        return hub.workflows.create_pipeline(actor, payload(body))

    @app.get(base + '/pipelines/{identifier}', tags=['Pipelines'])
    def pipeline(identifier: str, actor: Actor):
        return hub.workflows.get_pipeline(actor, identifier)

    @app.post(base + '/pipelines/{identifier}/steps/{step_key}/reassign', tags=['Pipelines'])
    def reassign_pipeline_step(identifier: str, step_key: str, body: s.PipelineReassign, actor: Actor):
        return hub.workflows.reassign(actor, identifier, step_key, payload(body))

    @app.post(base + '/pipelines/{identifier}/steps/{step_key}/rollback', tags=['Pipelines'])
    def rollback_pipeline_step(identifier: str, step_key: str, body: s.PipelineRollback, actor: Actor):
        return hub.workflows.rollback(actor, identifier, step_key, payload(body))

    @app.post(base + '/pipelines/{identifier}/{action}', tags=['Pipelines'])
    def pipeline_control(identifier: str, action: Literal['start', 'pause', 'resume', 'cancel'], body: s.Versioned, actor: Actor):
        return hub.workflows.control(actor, identifier, action, payload(body))

    @app.get(base + '/work-items', tags=['Work items'])
    def work_items(actor: Actor, q: str = '', status: str = '', team_id: str = '',
                   view: Literal['all', 'mine', 'requested', 'review', 'inbox'] = 'all',
                   limit: int = Query(50, ge=1, le=500), offset: int = Query(0, ge=0)):
        return hub.list_items(actor, q=q, status=status, team_id=team_id, view=view, limit=limit, offset=offset)

    @app.post(base + '/work-items', tags=['Work items'])
    def create_item(body: s.CreateItem, actor: Actor):
        return hub.create_item(actor, payload(body))

    @app.get(base + '/work-items/{identifier}', tags=['Work items'])
    def detail(identifier: str, actor: Actor):
        return hub.detail(actor, identifier)

    @app.post(base + '/work-items/{identifier}/deliveries', tags=['Deliveries'])
    def submit(identifier: str, body: s.Delivery, actor: Actor):
        return hub.submit(actor, identifier, payload(body))

    @app.post(base + '/deliveries/{identifier}/reviews', tags=['Deliveries'])
    def review(identifier: str, body: s.Review, actor: Actor):
        return hub.review(actor, identifier, payload(body))

    @app.post(base + '/work-items/{identifier}/bindings', tags=['Runs'])
    def bind(identifier: str, body: s.Binding, actor: Actor):
        return hub.bind(actor, identifier, payload(body))

    @app.post(base + '/work-items/{identifier}/runs', tags=['Runs'])
    def create_run(identifier: str, body: s.CreateRun, actor: Actor):
        return hub.create_run(actor, identifier, payload(body))

    @app.post(base + '/work-items/{identifier}/{action}', tags=['Work items'])
    def command(identifier: str, action: str, body: dict, actor: Actor):
        model = s.COMMANDS.get(action)
        if not model:
            raise DomainError('UNKNOWN_ACTION', '不支持的事项操作。', 404)
        return hub.command(actor, identifier, action, payload(model.model_validate(body)))

    @app.get(base + '/runs/{identifier}', tags=['Runs'])
    def get_run(identifier: str, actor: Actor):
        return hub.get_run(identifier)

    @app.post(base + '/runs/{identifier}/events', tags=['Runs'])
    def run_event(identifier: str, body: s.RunEvent, actor: Actor):
        return hub.run_event(actor, identifier, payload(body))

    @app.post(base + '/runs/{identifier}/cancel', tags=['Runs'])
    def cancel_run(identifier: str, body: s.Mutation, actor: Actor):
        return hub.cancel_run(actor, identifier, payload(body))

    @app.get(base + '/events', tags=['Events'])
    def events(actor: Actor, after: int = Query(0, ge=0), limit: int = Query(100, ge=1, le=500)):
        return hub.event_feed(after, limit)

    @app.get(base + '/capabilities', tags=['Capabilities'])
    def capabilities(actor: Actor, q: str = '', kind: str = ''):
        return hub.list_capabilities(q, kind)

    @app.post(base + '/capabilities', tags=['Capabilities'])
    def create_capability(body: s.Capability, actor: Actor):
        return hub.create_capability(actor, payload(body))

    @app.get(base + '/capabilities/{identifier}', tags=['Capabilities'])
    def capability(identifier: str, actor: Actor):
        return hub.capability(identifier)

    @app.post(base + '/capabilities/{identifier}/releases', tags=['Capabilities'])
    def publish_release(identifier: str, body: s.Release, actor: Actor):
        return hub.publish_release(actor, identifier, payload(body))

    @app.get(base + '/capabilities/{identifier}/releases/{version}', tags=['Capabilities'])
    def release(identifier: str, version: str, actor: Actor):
        return hub.release(identifier, version)

    @app.get(base + '/team-toolsets/{team_id}', tags=['Capabilities'])
    def toolset(team_id: str, actor: Actor):
        return hub.toolset(team_id)

    @app.put(base + '/team-toolsets/{team_id}', tags=['Capabilities'])
    def set_toolset(team_id: str, body: s.Toolset, actor: Actor):
        return hub.set_toolset(actor, team_id, payload(body))

    @app.post(base + '/artifacts', tags=['Deliveries'])
    async def upload(file: UploadFile, actor: Actor):
        identifier, size = uid('artifact'), 0
        digest = hashlib.sha256()
        path = database.data_dir / 'artifacts' / identifier
        try:
            with path.open('xb') as stream:
                while chunk := await file.read(1024 * 1024):
                    size += len(chunk)
                    if size > 20 * 1024 * 1024:
                        raise DomainError('ARTIFACT_TOO_LARGE', '首版每个附件最大 20 MiB。', 413)
                    digest.update(chunk)
                    stream.write(chunk)
            label = (file.filename or 'attachment').replace('\\', '/').rsplit('/', 1)[-1][:500] or 'attachment'
            value = {'id': identifier, 'label': label, 'content_type': file.content_type or 'application/octet-stream',
                     'size': size, 'uploaded_by': actor['id'], 'created_at': now(), 'sha256': digest.hexdigest()}
            with database.write() as connection:
                connection.execute(m.artifacts.insert().values(**value))
            return {**{key: value[key] for key in ('id', 'label', 'size', 'content_type', 'sha256')}, 'url': f'artifact://{identifier}'}
        except BaseException:
            path.unlink(missing_ok=True)
            raise
        finally:
            await file.close()

    @app.get(base + '/artifacts/{identifier}', tags=['Deliveries'])
    def artifact(identifier: str, actor: Actor):
        with database.read() as connection:
            value = row(connection, m.artifacts, identifier)
        path = database.data_dir / 'artifacts' / value['id']
        if not path.is_file():
            raise DomainError('ARTIFACT_MISSING', '附件内容不可用，请检查数据目录备份。', 404)
        return FileResponse(path, media_type=value['content_type'], filename=value['label'],
                            headers={'X-Content-Type-Options': 'nosniff'})

    # Source checkout serves web/dist; built Python packages may ship static/.
    package_static = Path(__file__).parent / 'static'
    checkout_static = Path(__file__).resolve().parents[2] / 'web' / 'dist'
    static_dir = package_static if (package_static / 'index.html').is_file() else checkout_static
    if (static_dir / 'assets').is_dir():
        app.mount('/assets', StaticFiles(directory=static_dir / 'assets'), name='assets')

    @app.get('/{path:path}', include_in_schema=False)
    def index(path: str):
        if path.startswith('api/'):
            raise DomainError('NOT_FOUND', '找不到此 API。', 404)
        candidate = (static_dir / path).resolve()
        if candidate.is_relative_to(static_dir.resolve()) and candidate.is_file():
            return FileResponse(candidate)
        if (static_dir / 'index.html').is_file():
            return FileResponse(static_dir / 'index.html', headers={'Cache-Control': 'no-cache'})
        return JSONResponse({'service': 'Agent Team Hub', 'message': '请先在 web 目录运行 npm ci && npm run build，或使用 scripts/start.ps1。', 'api_docs': '/docs'})

    return app
