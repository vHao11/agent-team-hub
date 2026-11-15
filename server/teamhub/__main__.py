from __future__ import annotations

import argparse
from contextlib import closing
import json
import sqlite3
import ssl
import tempfile
import zipfile
from pathlib import Path

from . import __version__


def backup(data_dir: Path, destination: Path):
    source = data_dir / 'teamhub.db'
    if not source.is_file():
        raise RuntimeError(f'找不到工作空间数据库：{source}')
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        raise RuntimeError('备份目标已存在；请选择新的文件名。')
    with tempfile.TemporaryDirectory(prefix='teamhub-backup-') as temp:
        snapshot_path = Path(temp) / 'teamhub.db'
        with closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)) as original:
            with closing(sqlite3.connect(snapshot_path)) as snapshot:
                original.backup(snapshot)
                identifiers = [value[0] for value in snapshot.execute('SELECT id FROM artifacts')]
        for identifier in identifiers:
            if not (data_dir / 'artifacts' / identifier).is_file():
                raise RuntimeError(f'附件缺失，备份未创建：{identifier}')
        # Immutable artifacts are copied using the reference set from this exact DB snapshot.
        with zipfile.ZipFile(destination, 'x', compression=zipfile.ZIP_DEFLATED) as archive:
            archive.write(snapshot_path, 'teamhub.db')
            for identifier in identifiers:
                archive.write(data_dir / 'artifacts' / identifier, f'artifacts/{identifier}')
    return {'backup': str(destination), 'artifacts': len(identifiers)}


def main():
    parser = argparse.ArgumentParser(prog='teamhub', description='跨组协作台账与共享能力库服务端')
    parser.add_argument('--version', action='version', version=__version__)
    commands = parser.add_subparsers(dest='command', required=True)
    initialize = commands.add_parser('init', help='初始化正式工作空间，输出首个管理员令牌')
    initialize.add_argument('--data-dir', default='.teamhub')
    initialize.add_argument('--name', default='管理员')
    initialize.add_argument('--team-name', default='我的团队')
    serve = commands.add_parser('serve', help='启动单实例 HTTP(S) 服务和 Web 界面')
    serve.add_argument('--data-dir')
    serve.add_argument('--demo', action='store_true', help='显式启用带固定身份的独立演示空间')
    serve.add_argument('--host', default='127.0.0.1')
    serve.add_argument('--port', type=int, default=8765)
    serve.add_argument('--ssl-certfile', help='TLS 服务器证书及中间证书 PEM 文件')
    serve.add_argument('--ssl-keyfile', help='TLS 服务器私钥 PEM 文件')
    save = commands.add_parser('backup', help='创建一致的 SQLite 快照和关联附件备份')
    save.add_argument('--data-dir', default='.teamhub')
    save.add_argument('--output', required=True)
    arguments = parser.parse_args()
    try:
        if arguments.command == 'backup':
            print(json.dumps(backup(Path(arguments.data_dir).expanduser().resolve(), Path(arguments.output).expanduser().resolve()), ensure_ascii=False, indent=2))
            return
        from .db import Database, users
        from .bootstrap import initialize_workspace
        from sqlalchemy import func, select
        if arguments.command == 'init':
            database = Database(arguments.data_dir)
            try:
                result = initialize_workspace(database, name=arguments.name, team_name=arguments.team_name)
                print('工作空间已初始化。请保存此管理员令牌，在连接设置中使用：')
                print(json.dumps(result, ensure_ascii=False, indent=2))
            finally:
                database.close()
        elif arguments.command == 'serve':
            from .app import create_app
            import uvicorn
            if bool(arguments.ssl_certfile) != bool(arguments.ssl_keyfile):
                raise RuntimeError('HTTPS 需要同时指定 --ssl-certfile 和 --ssl-keyfile。')
            tls = {}
            if arguments.ssl_certfile:
                # 提前检查证书与私钥，避免配置错误时触碰现有数据目录。
                context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
                context.load_cert_chain(arguments.ssl_certfile, arguments.ssl_keyfile)
                tls = {'ssl_certfile': arguments.ssl_certfile, 'ssl_keyfile': arguments.ssl_keyfile}
            directory = arguments.data_dir or ('.teamhub-demo' if arguments.demo else '.teamhub')
            app = create_app(directory, demo=arguments.demo)
            with app.state.database.read() as connection:
                if not connection.execute(select(func.count()).select_from(users)).scalar_one():
                    raise RuntimeError(f'工作空间尚未初始化，请先运行 python -m teamhub init --data-dir "{directory}"')
            scheme = 'https' if tls else 'http'
            print(f'Agent Team Hub {__version__}: {scheme}://{arguments.host}:{arguments.port}')
            if arguments.demo:
                print('当前为演示模式。演示身份和数据仅用于体验。')
            uvicorn.run(app, host=arguments.host, port=arguments.port, log_level='info', **tls)
    except (RuntimeError, OSError) as error:
        parser.exit(1, f'错误：{error}\n')


if __name__ == '__main__':
    main()
