"""
Farmo CSV 自動取得スクリプト
GitHub Actions から実行される
環境変数: FARMO_EMAIL, FARMO_PASSWORD
"""
import os
import re
import json
import requests
from bs4 import BeautifulSoup
from datetime import datetime, timezone

EMAIL    = os.environ["FARMO_EMAIL"]
PASSWORD = os.environ["FARMO_PASSWORD"]
BASE_URL = "https://farmo.tech/pc"
DATA_DIR = "data"

session = requests.Session()
session.headers.update({"User-Agent": "Mozilla/5.0 (compatible; FarmoFetcher/1.0)"})


def login():
    resp = session.post(
        f"{BASE_URL}/login_process.php",
        data={
            "login_pc_user": "",
            "login_email": EMAIL,
            "login_pass": PASSWORD,
        },
        allow_redirects=True,
        timeout=30,
    )
    resp.raise_for_status()
    # ログアウトリンクがあればログイン成功
    if "ログアウト" not in resp.text and "logout" not in resp.text.lower():
        raise RuntimeError("ログインに失敗しました。メールアドレス・パスワードを確認してください。")
    print("ログイン成功")


def get_fields():
    resp = session.get(f"{BASE_URL}/", timeout=30)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")

    fields = {}
    for a in soup.find_all("a", href=True):
        m = re.search(r"sid=([a-zA-Z0-9]+)", a["href"])
        if not m:
            continue
        sid  = m.group(1)
        name = a.get_text(strip=True)
        # 短い名前（ナビゲーションリンク等）は除外
        if name and len(name) >= 2 and sid not in fields:
            fields[sid] = name

    print(f"圃場数: {len(fields)}")
    return fields


def fetch_csv(sid):
    url  = f"{BASE_URL}/summary_csv.php?sid={sid}"
    resp = session.get(url, timeout=30)
    resp.raise_for_status()
    return resp.content  # バイナリで受け取り（文字コード保持）


def main():
    os.makedirs(DATA_DIR, exist_ok=True)

    login()
    fields = get_fields()

    if not fields:
        print("圃場が見つかりませんでした")
        return

    manifest = {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "fields": [],
    }

    for sid, name in fields.items():
        try:
            content = fetch_csv(sid)
            filename = f"{sid}.csv"
            filepath = os.path.join(DATA_DIR, filename)
            with open(filepath, "wb") as f:
                f.write(content)
            manifest["fields"].append({
                "sid":  sid,
                "name": name,
                "file": filename,
            })
            print(f"  ✓ {name} ({sid})")
        except Exception as e:
            print(f"  ✗ {name} ({sid}): {e}")

    with open(os.path.join(DATA_DIR, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    print(f"\n完了: {len(manifest['fields'])} 件取得")


if __name__ == "__main__":
    main()
