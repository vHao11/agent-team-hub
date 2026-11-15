from __future__ import annotations

import argparse
import os
from pathlib import Path
import subprocess
import sys

import pytest
from teamhub import lan_proxy as proxy


ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize('address', ['0.0.0.0', '127.0.0.1', '8.8.8.8', 'example.com', '::1'])
def test_proxy_rejects_non_private_or_wildcard_addresses(address):
    with pytest.raises(argparse.ArgumentTypeError):
        proxy.private_ipv4(address)


def test_proxy_accepts_private_addresses():
    assert proxy.private_ipv4('192.168.12.34') == '192.168.12.34'
    assert proxy.private_ipv4('10.1.2.3') == '10.1.2.3'


def test_tls_cert_and_key_must_be_supplied_together_before_data_creation(tmp_path):
    data = tmp_path / 'untouched'
    result = subprocess.run([sys.executable, '-m', 'teamhub', 'serve', '--data-dir', str(data),
                             '--ssl-certfile', str(tmp_path / 'certificate.pem')],
                            env={**os.environ, 'PYTHONPATH': str(ROOT / 'server'), 'PYTHONUTF8': '1'},
                            capture_output=True, text=True, encoding='utf-8', timeout=15)
    assert result.returncode != 0
    assert '--ssl-keyfile' in result.stderr
    assert not data.exists()
