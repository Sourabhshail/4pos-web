#!/usr/bin/env python3
"""Static file server with Razorpay order + verify API for local development."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import ssl
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ENV_FILE = ROOT / 'razorpay.env'
PORT = int(os.environ.get('PORT', '8080'))


def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        os.environ.setdefault(key.strip(), value.strip())


load_env_file(ENV_FILE)

KEY_ID = os.environ.get('RAZORPAY_KEY_ID', '')
KEY_SECRET = os.environ.get('RAZORPAY_KEY_SECRET', '')
RAZORPAY_API = 'https://api.razorpay.com/v1'
PLACEHOLDER_VALUES = {
    '',
    'your_key_secret',
    'your_secret_here',
    'PASTE_YOUR_KEY_SECRET_HERE',
}


def keys_configured() -> bool:
    if not KEY_ID or not KEY_SECRET:
        return False
    if KEY_ID in PLACEHOLDER_VALUES or KEY_SECRET in PLACEHOLDER_VALUES:
        return False
    if 'REPLACE' in KEY_ID or 'PASTE_' in KEY_SECRET:
        return False
    return True


def missing_keys_message() -> str:
    return (
        'Razorpay Key Secret is missing. Open razorpay.env in the project folder '
        'and paste your Key Secret from https://dashboard.razorpay.com/app/keys '
        '(same page as your Key ID), then restart the server.'
    )


def build_ssl_context() -> ssl.SSLContext:
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


SSL_CONTEXT = build_ssl_context()


def razorpay_request(method: str, endpoint: str, payload: dict | None = None) -> dict:
    if not keys_configured():
        raise RuntimeError(missing_keys_message())

    data = None
    headers = {
        'Authorization': 'Basic ' + base64.b64encode(f'{KEY_ID}:{KEY_SECRET}'.encode()).decode(),
        'Content-Type': 'application/json',
        'Accept': 'application/json',
    }
    if payload is not None:
        data = json.dumps(payload).encode('utf-8')

    request = urllib.request.Request(
        f'{RAZORPAY_API}{endpoint}',
        data=data,
        headers=headers,
        method=method,
    )

    try:
        with urllib.request.urlopen(request, context=SSL_CONTEXT, timeout=30) as response:
            return json.loads(response.read().decode('utf-8'))
    except urllib.error.URLError as exc:
        reason = getattr(exc, 'reason', exc)
        if 'CERTIFICATE_VERIFY_FAILED' in str(reason):
            raise RuntimeError(
                'SSL certificate verification failed when contacting Razorpay. '
                'Run: python3 -m pip install certifi — then restart the server.'
            ) from exc
        raise RuntimeError(f'Network error contacting Razorpay: {reason}') from exc
    except urllib.error.HTTPError as exc:
        body = exc.read().decode('utf-8', errors='replace')
        try:
            detail = json.loads(body)
        except json.JSONDecodeError:
            detail = {'error': body or exc.reason}
        message = detail.get('error', {})
        if isinstance(message, dict):
            message = message.get('description') or message.get('reason') or str(message)
        raise RuntimeError(message or 'Razorpay API request failed') from exc


class RazorpayHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, format: str, *args) -> None:
        print(f'[{self.log_date_time_string()}] {format % args}')

    def end_headers(self) -> None:
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Accept')
        super().end_headers()

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.end_headers()

    def _read_json(self) -> dict:
        length = int(self.headers.get('Content-Length', 0))
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw.decode('utf-8'))

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        if self.path == '/api/razorpay/create-order':
            self.handle_create_order()
            return
        if self.path == '/api/razorpay/verify-payment':
            self.handle_verify_payment()
            return
        self.send_error(404, 'Not Found')

    def handle_create_order(self) -> None:
        try:
            body = self._read_json()
            amount = int(body.get('amount', 0))
            currency = str(body.get('currency', 'USD')).upper()
            receipt = str(body.get('receipt') or f'rcpt_{secrets.token_hex(6)}')[:40]
            plan_id = str(body.get('planId', 'plan'))

            if amount < 100:
                raise ValueError('Amount must be at least 100 in the smallest currency unit.')

            order = razorpay_request('POST', '/orders', {
                'amount': amount,
                'currency': currency,
                'receipt': receipt,
                'notes': {
                    'plan_id': plan_id,
                    'source': '4pos-website-pricing',
                    'reference': str(body.get('reference', ''))[:120],
                },
            })
            self._send_json(200, {
                'id': order['id'],
                'amount': order['amount'],
                'currency': order['currency'],
            })
        except (ValueError, json.JSONDecodeError) as exc:
            self._send_json(400, {'error': str(exc)})
        except RuntimeError as exc:
            self._send_json(500, {'error': str(exc)})

    def handle_verify_payment(self) -> None:
        try:
            body = self._read_json()
            order_id = body.get('razorpay_order_id', '')
            payment_id = body.get('razorpay_payment_id', '')
            signature = body.get('razorpay_signature', '')

            if not order_id or not payment_id or not signature:
                raise ValueError('Missing payment verification fields.')

            if not keys_configured():
                raise RuntimeError(missing_keys_message())

            expected = hmac.new(
                KEY_SECRET.encode('utf-8'),
                f'{order_id}|{payment_id}'.encode('utf-8'),
                hashlib.sha256,
            ).hexdigest()

            if not hmac.compare_digest(expected, signature):
                raise ValueError('Invalid payment signature.')

            self._send_json(200, {'success': True, 'payment_id': payment_id})
        except (ValueError, json.JSONDecodeError) as exc:
            self._send_json(400, {'error': str(exc), 'success': False})
        except RuntimeError as exc:
            self._send_json(500, {'error': str(exc), 'success': False})


def main() -> None:
    os.chdir(ROOT)
    server = ThreadingHTTPServer(('0.0.0.0', PORT), RazorpayHandler)
    print(f'Serving {ROOT} on http://localhost:{PORT}')
    print('Pricing page: http://localhost:{0}/#pricing'.format(PORT))
    if not keys_configured():
        print('Warning: add your Razorpay Key Secret to razorpay.env, then restart.')
    else:
        print('Razorpay keys loaded.')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nStopped.')


if __name__ == '__main__':
    main()
