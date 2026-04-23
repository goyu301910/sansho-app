"""
Farmo CSV 自動取得スクリプト
GitHub Actions から実行される
環境変数: FARMO_COOKIE (pc_user_device_id=... の形式)
"""
import os
import re
import json
import requests
from bs4 import BeautifulSoup
from datetime import datetime, timezone

COOKIE   = os.environ["FARMO_COOKIE"]
BASE_URL = "https://farmo.tech/pc"
DATA_DIR = "data"

session = requests.Session()
session.headers.update({
    "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ja,en-US;q=0.9",
})

# Cookie をセッションに設定
for item in COOKIE.split(";"):
    item = item.strip()
    if "=" in item:
        name, _, value = item.partition("=")
        session.cookies.set(name.strip(), value.strip(), domain="farmo.tech")


def check_login():
    resp = session.get(f"{BASE_URL}/", timeout=30)
    resp.raise_for_status()
    if "ログアウト" not in resp.text and "logout" not in resp.text.lower():
        raise RuntimeError(
            "Cookieが無効または期限切れです。"
            "ブラウザから最新の pc_user_device_id を取得して GitHub Secrets を更新してください。"
        )
    print("認証確認OK")
    return resp


def get_fields(resp):
    # update_index.php を試す
    r = session.get(f"{BASE_URL}/update_index.php", timeout=30)
    print(f"[DEBUG] update_index.php status: {r.status_code}")
    print(f"[DEBUG] update_index.php content:\n{r.text[:1000]}")

    # HTML全体からsid=を探す
    all_sids = re.findall(r"sid=([a-zA-Z0-9]+)", resp.text + r.text)
    print(f"[DEBUG] 発見したSID一覧: {list(set(all_sids))}")

    fields = {}
    soup = BeautifulSoup(resp.text, "html.parser")
    for a in soup.find_all("a", href=True):
        m = re.search(r"sid=([a-zA-Z0-9]+)", a["href"])
        if not m:
            continue
        sid  = m.group(1)
        name = a.get_text(strip=True)
        if name and len(name) >= 2 and sid not in fields:
            fields[sid] = name
    print(f"圃場数: {len(fields)}")
    return fields


def fetch_csv(sid):
    url  = f"{BASE_URL}/summary_csv.php?sid={sid}"
    resp = session.get(url, timeout=30)
    resp.raise_for_status()
    return resp.content


def main():
    os.makedirs(DATA_DIR, exist_ok=True)

    resp   = check_login()
    fields = get_fields(resp)

    if not fields:
        print("圃場が見つかりませんでした")
        return

    manifest = {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "fields":  [],
    }

    for sid, name in fields.items():
        try:
            content  = fetch_csv(sid)
            filename = f"{sid}.csv"
            with open(os.path.join(DATA_DIR, filename), "wb") as f:
                f.write(content)
            manifest["fields"].append({"sid": sid, "name": name, "file": filename})
            print(f"  ✓ {name} ({sid})")
        except Exception as e:
            print(f"  ✗ {name} ({sid}): {e}")

    with open(os.path.join(DATA_DIR, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    print(f"\n完了: {len(manifest['fields'])} 件取得")


if __name__ == "__main__":
    main()
