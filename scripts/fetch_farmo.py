"""
Farmo CSV 自動取得スクリプト（GitHub Actions 用）
Playwright でログインしてCookieを取得し、requests でCSVを取得する
環境変数: FARMO_EMAIL, FARMO_PASSWORD
"""
import os
import sys
import json
import requests
from datetime import datetime, timezone, timedelta, date
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE_URL    = "https://farmo.tech/pc"
API_URL     = f"{BASE_URL}/php/update_summary.php"
DATA_DIR    = Path("data")
FIELDS_FILE = DATA_DIR / "fields.json"
FETCH_DAYS  = 730
CHECK_ITEMS = ["temperature", "underground", "vwc", "illuminance", "ec"]


def get_cookie_via_playwright(email: str, password: str) -> str:
    """Playwrightでログインし、pc_user_device_id クッキー値を返す"""
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36"
        )
        page = context.new_page()

        print("ログインページを開いています...")
        page.goto(f"{BASE_URL}/login.php", timeout=30000)

        page.fill('input[name="login_email"]', email)
        page.fill('input[name="login_pass"]', password)
        page.click('input[type="submit"], button[type="submit"]')

        # ログイン後のリダイレクト完了を待つ
        page.wait_for_load_state("networkidle", timeout=30000)

        # ログイン成功確認
        if "ログアウト" not in page.content() and "login_success" not in page.url:
            # ダッシュボードへ移動してみる
            page.goto(f"{BASE_URL}/", timeout=30000)
            page.wait_for_load_state("networkidle", timeout=15000)
            if "ログアウト" not in page.content():
                raise RuntimeError(f"ログインに失敗しました。URL: {page.url}")

        print("ログイン成功")

        cookies = context.cookies()
        browser.close()

    for c in cookies:
        if c["name"] == "pc_user_device_id":
            print(f"Cookie取得成功: pc_user_device_id={c['value'][:8]}...")
            return c["value"]

    raise RuntimeError(
        "pc_user_device_id が見つかりません。"
        "ログインは成功しましたがCookieが発行されませんでした。"
    )


def build_session(cookie_value: str) -> requests.Session:
    session = requests.Session()
    session.headers.update({
        "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
        "Accept-Language": "ja,en-US;q=0.9",
    })
    session.cookies.set("pc_user_device_id", cookie_value, domain="farmo.tech")

    # セッション確立
    resp = session.get(f"{BASE_URL}/", timeout=30)
    resp.raise_for_status()
    if "ログアウト" not in resp.text:
        raise RuntimeError("セッション確立に失敗しました（Cookie無効）")
    print("セッション確立OK")
    return session


def fetch_chunk(session: requests.Session, sid: str, start_dt: date, end_dt: date) -> bytes:
    referer = f"{BASE_URL}/summary_csv.php?sid={sid}"
    post_data = [
        ("mode",       "download_csv"),
        ("sensor_id",  sid),
        ("start_date", start_dt.strftime("%Y-%m-%d")),
        ("end_date",   end_dt.strftime("%Y-%m-%d")),
    ]
    for item in CHECK_ITEMS:
        post_data.append(("check_item[]", item))

    resp = session.post(
        API_URL,
        data=post_data,
        headers={
            "Referer":          referer,
            "X-Requested-With": "XMLHttpRequest",
            "Accept":           "application/json, text/javascript, */*; q=0.01",
        },
        timeout=60,
    )
    resp.raise_for_status()
    result = resp.json()
    status = result.get("result")
    if status == "csv_data_empty":
        return b""
    if status != "get_success":
        raise ValueError(f"API エラー: {status}")

    dl_link = result["dl_link"]
    if dl_link.startswith("http"):
        csv_url = dl_link
    elif dl_link.startswith("/"):
        csv_url = "https://farmo.tech" + dl_link
    else:
        csv_url = f"{BASE_URL}/{dl_link}"

    csv_resp = session.get(csv_url, headers={"Referer": referer}, timeout=60)
    csv_resp.raise_for_status()

    try:
        session.post(API_URL, data={"mode": "delete_csv_file", "dl_link": dl_link}, timeout=10)
    except Exception:
        pass

    return csv_resp.content


def fetch_csv(session: requests.Session, sid: str) -> bytes:
    today = date.today()
    start = today - timedelta(days=FETCH_DAYS)

    all_lines = []
    header_saved = False
    total_chunks = 0

    chunk_start = start
    while chunk_start <= today:
        year_end  = date(chunk_start.year, 12, 31)
        chunk_end = min(chunk_start + timedelta(days=13), today, year_end)

        content = fetch_chunk(session, sid, chunk_start, chunk_end)
        if content:
            text  = content.decode("cp932", errors="replace")
            lines = text.splitlines()
            if not header_saved and lines:
                all_lines.append(lines[0])
                header_saved = True
            all_lines.extend(lines[1:])
            total_chunks += 1

        chunk_start = chunk_end + timedelta(days=1)

    print(f"    チャンク数: {total_chunks}, 行数: {len(all_lines)}")
    if len(all_lines) <= 1:
        raise ValueError("データが空です")

    return "\n".join(all_lines).encode("utf-8-sig")


def main():
    email    = os.environ.get("FARMO_EMAIL", "")
    password = os.environ.get("FARMO_PASSWORD", "")
    if not email or not password:
        print("エラー: FARMO_EMAIL と FARMO_PASSWORD 環境変数が必要です")
        sys.exit(1)

    DATA_DIR.mkdir(exist_ok=True)

    cookie_value = get_cookie_via_playwright(email, password)
    session      = build_session(cookie_value)

    with open(FIELDS_FILE, encoding="utf-8") as f:
        fields = json.load(f)

    print(f"圃場数: {len(fields)}")

    manifest = {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "fields":  [],
    }

    for field in fields:
        sid, name = field["sid"], field["name"]
        try:
            content  = fetch_csv(session, sid)
            filepath = DATA_DIR / f"{sid}.csv"
            filepath.write_bytes(content)
            manifest["fields"].append({"sid": sid, "name": name, "file": f"{sid}.csv"})
            print(f"  ✓ {name}")
        except Exception as e:
            print(f"  ✗ {name}: {e}")

    with open(DATA_DIR / "manifest.json", "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    print(f"\n完了: {len(manifest['fields'])} 件取得")

    if len(manifest["fields"]) == 0:
        print("警告: 取得できた圃場が0件です")
        sys.exit(1)


if __name__ == "__main__":
    main()
