"""Скачивает публичные посты Telegram-канала через t.me/s/<канал> (листая назад) -> data/posts.json"""
import html, json, re, sys, time, urllib.request

CH = sys.argv[1] if len(sys.argv) > 1 else "kultura_analitiki"
LIMIT = int(sys.argv[2]) if len(sys.argv) > 2 else 120
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36"


def get(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=30).read().decode("utf-8", "replace")


def clean(fragment):
    fragment = re.sub(r"<br\s*/?>", "\n", fragment)
    fragment = re.sub(r"<[^>]+>", "", fragment)
    return html.unescape(fragment).strip()


posts, before = {}, None
while len(posts) < LIMIT:
    page = get(f"https://t.me/s/{CH}" + (f"?before={before}" if before else ""))
    blocks = re.findall(r'data-post="[^/]+/(\d+)"(.*?)(?=data-post="|\Z)', page, re.S)
    if not blocks:
        break
    for pid, body in blocks:
        m = re.search(r'<div class="tgme_widget_message_text[^"]*"[^>]*>(.*?)</div>', body, re.S)
        d = re.search(r'<time datetime="([^"]+)"', body)
        v = re.search(r'tgme_widget_message_views">([^<]+)<', body)
        if m:
            posts[int(pid)] = {"id": int(pid), "date": d.group(1) if d else None,
                               "views": v.group(1) if v else None, "text": clean(m.group(1))}
    ids = [int(p) for p, _ in blocks]
    nb = min(ids)
    if before == nb:
        break
    before = nb
    time.sleep(1)

out = sorted(posts.values(), key=lambda x: x["id"], reverse=True)
json.dump(out, open("data/posts.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(len(out), "постов; последний", out[0]["date"] if out else None, "; самый ранний", out[-1]["date"] if out else None)
