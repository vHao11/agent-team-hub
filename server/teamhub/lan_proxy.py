"""为已有的本机 Hub 提供单个私网地址上的 TLS 入口（python -m teamhub.lan_proxy）。"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import ipaddress
import ssl


PRIVATE_NETWORKS = tuple(ipaddress.ip_network(value) for value in (
    '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16',
))


def private_ipv4(value: str) -> str:
    try:
        address = ipaddress.IPv4Address(value)
    except ipaddress.AddressValueError:
        raise argparse.ArgumentTypeError('监听地址必须是本机私网 IPv4。') from None
    if not any(address in network for network in PRIVATE_NETWORKS):
        raise argparse.ArgumentTypeError('仅允许监听 RFC 1918 私网 IPv4，不能使用通配地址。')
    return str(address)


def port(value: str) -> int:
    try:
        number = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError('端口必须是 1 到 65535 之间的整数。') from None
    if not 1 <= number <= 65535:
        raise argparse.ArgumentTypeError('端口必须是 1 到 65535 之间的整数。')
    return number


async def copy_stream(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    while chunk := await reader.read(65536):
        writer.write(chunk)
        await writer.drain()


async def forward(client_reader: asyncio.StreamReader, client_writer: asyncio.StreamWriter, backend_port: int) -> None:
    backend_writer = None
    tasks = []
    try:
        backend_reader, backend_writer = await asyncio.wait_for(
            asyncio.open_connection('127.0.0.1', backend_port), timeout=5)
        tasks = [asyncio.create_task(copy_stream(client_reader, backend_writer)),
                 asyncio.create_task(copy_stream(backend_reader, client_writer))]
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    except (OSError, asyncio.TimeoutError):
        pass
    finally:
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        for writer in (backend_writer, client_writer):
            if writer is not None:
                writer.close()
                with contextlib.suppress(OSError, ssl.SSLError, asyncio.CancelledError):
                    await writer.wait_closed()


async def serve(arguments: argparse.Namespace) -> None:
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(arguments.certfile, arguments.keyfile)
    server = await asyncio.start_server(
        lambda reader, writer: forward(reader, writer, arguments.backend_port),
        host=arguments.listen_host, port=arguments.port, ssl=context,
        ssl_handshake_timeout=10, ssl_shutdown_timeout=5)
    print(f'私网 HTTPS 入口已启动：{arguments.listen_host}:{arguments.port}；后端为本机端口 {arguments.backend_port}。', flush=True)
    async with server:
        await server.serve_forever()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--listen-host', required=True, type=private_ipv4, help='当前主机的 RFC 1918 私网 IPv4')
    parser.add_argument('--port', type=port, default=8766, help='私网 HTTPS 端口')
    parser.add_argument('--backend-port', type=port, default=8765, help='本机 127.0.0.1 上现有 Hub 的端口')
    parser.add_argument('--certfile', required=True, help='服务器证书链 PEM 文件')
    parser.add_argument('--keyfile', required=True, help='服务器私钥 PEM 文件')
    arguments = parser.parse_args()
    try:
        asyncio.run(serve(arguments))
    except KeyboardInterrupt:
        print('私网 HTTPS 入口已停止；本机 Hub 未改变。')
    except (OSError, ssl.SSLError) as error:
        parser.exit(1, f'HTTPS 入口启动失败：{error}\n')


if __name__ == '__main__':
    main()
