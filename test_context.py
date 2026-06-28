#!/usr/bin/env python3
"""
模型上下文窗口大小测试脚本（有效上下文版）
用法: python test_context.py [--debug]

在填充文本末尾放置随机验证码，要求模型回答。
只有模型正确回答验证码才算通过 —— 验证模型真的读到了全部内容，
而不仅仅是"没报错"。
"""
import json, sys, time, re, random, urllib.request, urllib.error

def parse_response(raw):
    """解析 AI 响应，兼容标准 JSON 和 SSE 格式"""
    raw = raw.strip()
    if not raw:
        return ''
    if raw.startswith('data: ') or raw.startswith('data:'):
        combined = ''
        for line in raw.split('\n'):
            line = line.strip()
            if line.startswith('data:') and line.strip() != 'data: [DONE]' and line.strip() != 'data:[DONE]':
                payload = line[5:].strip() if line.startswith('data:') else line[6:]
                try:
                    chunk = json.loads(payload)
                    delta = (chunk.get('choices', [{}])[0].get('delta', {}).get('content', '')
                             or chunk.get('choices', [{}])[0].get('message', {}).get('content', ''))
                    combined += delta
                except json.JSONDecodeError:
                    pass
        return combined.strip()
    try:
        data = json.loads(raw)
        for path in [
            lambda d: d.get('choices', [{}])[0].get('message', {}).get('content', ''),
            lambda d: d.get('choices', [{}])[0].get('delta', {}).get('content', ''),
            lambda d: str(d['response']) if 'response' in d else '',
            lambda d: str(d['result']) if 'result' in d else '',
        ]:
            v = path(data)
            if v:
                return v.strip()
        return ''
    except json.JSONDecodeError:
        return raw if len(raw) > 5 else ''

def ask(prompt, default=''):
    val = input(f'{prompt} [{default}]: ' if default else f'{prompt}: ').strip()
    return val or default

def gen_code():
    """生成 4 位随机验证码"""
    return str(random.randint(1000, 9999))

def gen_padding(size_k, secret_code):
    """生成填充文本，末尾放验证码"""
    lines = []
    target = size_k * 4000
    length = 0
    i = 0
    while length < target:
        line = f'Line {i:05d}: The quick brown fox jumps over the lazy dog and five boxing wizards jump quickly.\n'
        lines.append(line)
        length += len(line)
        i += 1
    lines.append(f'\n===VERIFICATION===\nThe secret code is: {secret_code}\n===END===\n')
    return ''.join(lines)

def try_size(url, model, api_key, headers, size_k, timeout=60, debug=False):
    code = gen_code()
    padding = gen_padding(size_k, code)
    messages = [
        {'role': 'system', 'content': 'You are a helpful assistant. Follow instructions exactly.'},
        {'role': 'user', 'content':
            f'Below is a long text with padding lines. At the very END of the text, '
            f'there is a section marked ===VERIFICATION=== containing a secret code. '
            f'Read the ENTIRE text and find the secret code. '
            f'Reply with ONLY the 4-digit number, nothing else.\n\n{padding}'},
    ]
    body = json.dumps({
        'model': model,
        'messages': messages,
        'temperature': 0,
        'max_tokens': 20,
        'stream': False,
    }).encode('utf-8')

    req_headers = {
        'Content-Type': 'application/json',
        'Authorization': f'Bearer {api_key}',
    }
    req_headers.update(headers)

    req = urllib.request.Request(url, data=body, headers=req_headers, method='POST')
    try:
        t0 = time.time()
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode(errors='replace')
            elapsed = time.time() - t0
            content = parse_response(raw)
            if debug:
                print(f'\n  [DEBUG] status={resp.status} len={len(raw)} code={code} reply="{content}"')
            found = code in content
            return {'ok': found, 'elapsed': elapsed, 'expected': code, 'got': content.strip()}
    except urllib.error.HTTPError as e:
        err_body = e.read().decode(errors='replace')
        if debug:
            print(f'\n  [DEBUG] HTTP {e.code} body={err_body[:300]}')
        return {'ok': False, 'error': f'HTTP {e.code}', 'detail': err_body[:300]}
    except Exception as e:
        return {'ok': False, 'error': str(e)}

def main():
    debug = '--debug' in sys.argv
    print('=== 模型有效上下文窗口测试 ===')
    print('验证方式: 在文本末尾放随机验证码，模型答对才算通过\n')

    endpoint = ask('接口地址 (Endpoint)', 'https://api.deepseek.com/v1/chat/completions')
    if re.search(r'/v\d+/?$', endpoint):
        endpoint = re.sub(r'/?$', '/chat/completions', endpoint)
        print(f'  → 自动补全: {endpoint}')

    model = ask('模型 ID', 'deepseek-chat')
    api_key = ask('API Key')

    extra_headers = {}
    h = ask('额外请求头 (JSON格式, 留空跳过)', '')
    if h:
        try:
            extra_headers = json.loads(h)
        except:
            print('  ⚠ JSON 格式错误，已跳过')

    print(f'\n目标: {endpoint}')
    print(f'模型: {model}\n')

    # 1. 验证连接
    print('验证连接 (1K)...', end=' ', flush=True)
    r = try_size(endpoint, model, api_key, extra_headers, 1, debug=debug)
    if not r['ok']:
        if r.get('error'):
            print(f'❌ 连接失败: {r["error"]}')
            if r.get('detail'):
                print(f'  详情: {r["detail"]}')
        else:
            print(f'❌ 验证码不匹配 (期望={r.get("expected")}, 回复="{r.get("got", "")}")')
        print(f'\n  提示: 加 --debug 参数可查看原始响应')
        sys.exit(1)
    print(f'✓ 验证码正确 ({r["elapsed"]:.1f}s)')

    # 2. 指数递增
    sizes = [2, 4, 8, 16, 32, 64, 128, 256, 512, 1024]
    last_success = 1

    for size_k in sizes:
        print(f'测试 {size_k}K...', end=' ', flush=True)
        timeout = 30 if size_k <= 16 else (60 if size_k <= 64 else (120 if size_k <= 256 else 180))
        r = try_size(endpoint, model, api_key, extra_headers, size_k, timeout=timeout, debug=debug)

        if r['ok']:
            last_success = size_k
            print(f'✓ 验证码正确 ({r["elapsed"]:.1f}s)')
        else:
            if r.get('error'):
                print(f'✗ {r["error"]}')
                if r.get('detail'):
                    print(f'  详情: {r["detail"][:200]}')
            else:
                print(f'✗ 验证码错误 (期望={r.get("expected")}, 回复="{r.get("got", "")}")')

            # 二分查找
            lo, hi = last_success, size_k
            print(f'\n  二分查找 {lo}K ~ {size_k}K...')
            while hi - lo > 1:
                mid = (lo + hi) // 2
                print(f'  测试 {mid}K...', end=' ', flush=True)
                rm = try_size(endpoint, model, api_key, extra_headers, mid, timeout=timeout, debug=debug)
                if rm['ok']:
                    lo = mid
                    print(f'✓ ({rm["elapsed"]:.1f}s)')
                else:
                    hi = mid
                    if rm.get('error'):
                        print(f'✗ {rm["error"]}')
                    else:
                        print(f'✗ (回复="{rm.get("got", "")}")')
            last_success = lo
            break
    else:
        print(f'\n⚠ 所有测试均通过 (最大测试到 {sizes[-1]}K)')
        last_success = sizes[-1]

    print(f'\n{"="*50}')
    print(f'✅ 有效上下文窗口: ~{last_success}K')
    print(f'  （模型能完整读取并正确回答末尾验证码的最大输入）')
    print(f'  在 Marginote AI 设置中填入: {last_success}')
    print(f'{"="*50}')

if __name__ == '__main__':
    main()
