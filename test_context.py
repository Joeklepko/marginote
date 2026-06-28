#!/usr/bin/env python3
"""
模型上下文窗口大小测试脚本
用法: python test_context.py

会交互式询问 endpoint / model / api_key，
然后用二分查找法检测模型真实上下文窗口大小。
"""
import json, sys, time, re, urllib.request, urllib.error

def parse_response(raw):
    """解析 AI 响应，兼容标准 JSON 和 SSE 格式"""
    raw = raw.strip()
    if not raw:
        return ''
    # SSE 格式：data: {...}\ndata: {...}\n...
    if raw.startswith('data: '):
        combined = ''
        for line in raw.split('\n'):
            line = line.strip()
            if line.startswith('data: ') and line != 'data: [DONE]':
                try:
                    chunk = json.loads(line[6:])
                    delta = (chunk.get('choices', [{}])[0].get('delta', {}).get('content', '')
                             or chunk.get('choices', [{}])[0].get('message', {}).get('content', ''))
                    combined += delta
                except json.JSONDecodeError:
                    pass
        return combined.strip()
    # 标准 JSON
    try:
        data = json.loads(raw)
        content = data.get('choices', [{}])[0].get('message', {}).get('content', '')
        if content:
            return content
        delta = data.get('choices', [{}])[0].get('delta', {}).get('content', '')
        if delta:
            return delta
        if data.get('response'):
            return str(data['response'])
        if data.get('result'):
            return str(data['result'])
        return ''
    except json.JSONDecodeError:
        return raw if len(raw) > 5 else ''

def ask(prompt, default=''):
    val = input(f'{prompt} [{default}]: ' if default else f'{prompt}: ').strip()
    return val or default

def gen_padding(size_k):
    lines = []
    target = size_k * 4000
    length = 0
    i = 0
    while length < target:
        line = f'Line {i:05d}: The quick brown fox jumps over the lazy dog and five boxing wizards jump quickly.\n'
        lines.append(line)
        length += len(line)
        i += 1
    return ''.join(lines)

def try_size(url, model, api_key, headers, size_k, timeout=60):
    padding = gen_padding(size_k)
    messages = [
        {'role': 'system', 'content': 'Reply with exactly one word: OK'},
        {'role': 'user', 'content': 'Ignore all padding text below. Reply ONLY: OK\n\n' + padding},
    ]
    body = json.dumps({
        'model': model,
        'messages': messages,
        'temperature': 0,
        'max_tokens': 5,
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
            if DEBUG:
                print(f'\n  [DEBUG] status={resp.status} len={len(raw)}')
                print(f'  [DEBUG] body={raw[:300]}')
            content = parse_response(raw)
            return {'ok': bool(content), 'elapsed': elapsed}
    except urllib.error.HTTPError as e:
        err_body = e.read().decode(errors='replace')
        if DEBUG:
            print(f'\n  [DEBUG] HTTP {e.code} body={err_body[:300]}')
        # 尝试从错误消息中提取精确上下文限制
        m = re.search(r'maximum[^0-9]*(\d{3,})', err_body, re.I)
        if not m:
            m = re.search(r'max[_ ]?tokens?[^0-9]*(\d{4,})', err_body, re.I)
        if not m:
            m = re.search(r'context[_ ]?length[^0-9]*(\d{4,})', err_body, re.I)
        limit = int(m.group(1)) // 1000 if m else None
        return {'ok': False, 'error': f'HTTP {e.code}', 'detail': err_body[:300], 'limit': limit}
    except Exception as e:
        return {'ok': False, 'error': str(e), 'limit': None}

DEBUG = '--debug' in sys.argv

def main():
    print('=== 模型上下文窗口大小测试 ===\n')

    endpoint = ask('接口地址 (Endpoint)', 'https://api.deepseek.com/v1/chat/completions')
    # 自动补全 /chat/completions
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
    r = try_size(endpoint, model, api_key, extra_headers, 1)
    if not r['ok']:
        print(f'❌ 失败: {r.get("error", "响应为空或无法解析")}')
        if r.get('detail'):
            print(f'  详情: {r["detail"]}')
        print(f'\n  提示: 加 --debug 参数可查看原始响应')
        sys.exit(1)
    print(f'✓ ({r["elapsed"]:.1f}s)')

    # 2. 指数递增
    sizes = [2, 4, 8, 16, 32, 64, 128, 256, 512, 1024]
    last_success = 1

    for size_k in sizes:
        print(f'测试 {size_k}K...', end=' ', flush=True)
        timeout = 30 if size_k <= 32 else (60 if size_k <= 128 else 120)
        r = try_size(endpoint, model, api_key, extra_headers, size_k, timeout=timeout)

        if r['ok']:
            last_success = size_k
            print(f'✓ ({r["elapsed"]:.1f}s)')
        else:
            print(f'✗ {r.get("error", "")}')
            if r.get('detail'):
                print(f'  详情: {r["detail"][:200]}')

            # 优先用 API 报告的精确值
            if r.get('limit'):
                last_success = r['limit']
                print(f'\n  API 报告上下文限制: ~{last_success}K tokens')
                break

            # 二分查找
            lo, hi = last_success, size_k
            print(f'\n  二分查找 {lo}K ~ {size_k}K...')
            while hi - lo > 1:
                mid = (lo + hi) // 2
                print(f'  测试 {mid}K...', end=' ', flush=True)
                rm = try_size(endpoint, model, api_key, extra_headers, mid, timeout=timeout)
                if rm['ok']:
                    lo = mid
                    print(f'✓ ({rm["elapsed"]:.1f}s)')
                else:
                    hi = mid
                    print(f'✗')
                    if rm.get('limit'):
                        lo = rm['limit']
                        print(f'  API 报告: ~{lo}K tokens')
                        break
            last_success = lo
            break
    else:
        # 所有尺寸都通过了
        print(f'\n⚠ 所有测试均通过 (最大测试到 {sizes[-1]}K)')
        print(f'  模型上下文可能超过 {sizes[-1]}K，建议手动设置。')
        last_success = sizes[-1]

    print(f'\n{"="*40}')
    print(f'✅ 检测结果: ~{last_success}K')
    print(f'  在 Marginote AI 设置中填入: {last_success}')
    print(f'{"="*40}')

if __name__ == '__main__':
    main()
