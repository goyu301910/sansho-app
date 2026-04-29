"""
Farmo CSV ローカル取得スクリプト
PC上で実行し、GitHubに自動プッシュする
実行方法: run_update.bat をダブルクリック
"""
import os
import sys
import json
import subprocess
import requests
from datetime import datetime, timezone, timedelta, date
from pathlib import Path

# Windows日本語環境でUTF-8出力
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# ---- 設定 ------------------------------------------------
BASE_DIR   = Path(__file__).parent.parent
DATA_DIR   = BASE_DIR / "data"
CRED_FILE  = BASE_DIR / ".env"
BASE_URL   = "https://farmo.tech/pc"
API_URL    = f"{BASE_URL}/php/update_summary.php"
FETCH_DAYS = 730  # 約2年分
CHECK_ITEMS = ["temperature", "underground", "vwc", "illuminance", "ec"]

# ---- 認証情報の読み込み ----------------------------------
def load_credentials():
    # GitHub Actions など環境変数が設定されていればそちらを優先
    env_email    = os.environ.get("FARMO_EMAIL", "")
    env_password = os.environ.get("FARMO_PASSWORD", "")
    if env_email and env_password:
        return env_email, env_password

    if not CRED_FILE.exists():
        print("=" * 50)
        print(".env ファイルが見つかりません。初回設定を行います。")
        email = input("Farmo メールアドレス: ").strip()
        password = input("Farmo パスワード: ").strip()
        CRED_FILE.write_text(
            f"FARMO_EMAIL={email}\nFARMO_PASSWORD={password}\n",
            encoding="utf-8"
        )
        print(".env を作成しました。")
        print("=" * 50)
    creds = {}
    for line in CRED_FILE.read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.startswith("#"):
            k, _, v = line.partition("=")
            creds[k.strip()] = v.strip()
    return creds.get("FARMO_EMAIL", ""), creds.get("FARMO_PASSWORD", "")

# ---- ログイン -------------------------------------------
def login(session, email, password):
    session.get(f"{BASE_URL}/login.php", timeout=30)
    resp = session.post(
        f"{BASE_URL}/login_process.php",
        data={
            "mode":        "login_pc_user",
            "login_email": email,
            "login_pass":  password,
        },
        headers={"Referer": f"{BASE_URL}/login.php"},
        allow_redirects=True,
        timeout=30,
    )
    resp.raise_for_status()
    if "login_success" not in resp.text and "ログアウト" not in resp.text:
        raise RuntimeError(f"ログインに失敗しました。レスポンス: {resp.text[:100]}")
    print("ログイン成功")
    session.get(f"{BASE_URL}/", timeout=30)

# ---- 14日チャンクでCSV取得 -------------------------------
def fetch_chunk(session, sid, start_dt, end_dt):
    """1チャンク（最大14日）のCSVをAPI経由で取得"""
    referer = f"{BASE_URL}/summary_csv.php?sid={sid}"

    # check_item を個別フィールドとして送る（multipart形式）
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
            "Referer":           referer,
            "X-Requested-With":  "XMLHttpRequest",
            "Accept":            "application/json, text/javascript, */*; q=0.01",
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
    # dl_link が相対パスの場合は BASE_URL のルートから結合
    if dl_link.startswith("http"):
        csv_url = dl_link
    elif dl_link.startswith("/"):
        csv_url = "https://farmo.tech" + dl_link
    else:
        csv_url = f"{BASE_URL}/{dl_link}"

    csv_resp = session.get(csv_url, headers={"Referer": referer}, timeout=60)
    csv_resp.raise_for_status()

    # サーバー上の一時ファイルを削除
    try:
        session.post(API_URL, data={"mode": "delete_csv_file", "dl_link": dl_link}, timeout=10)
    except Exception:
        pass

    return csv_resp.content

# ---- 全期間CSV取得（14日チャンク分割） --------------------
def fetch_csv(session, sid, days_back=FETCH_DAYS):
    today   = date.today()
    start   = today - timedelta(days=days_back)

    all_lines  = []
    header_saved = False
    total_chunks = 0

    chunk_start = start
    while chunk_start <= today:
        # 年またぎ禁止・最大14日
        year_end   = date(chunk_start.year, 12, 31)
        chunk_end  = min(chunk_start + timedelta(days=13), today, year_end)

        content = fetch_chunk(session, sid, chunk_start, chunk_end)

        if content:
            # Farmo CSVはShift-JIS（cp932）
            text = content.decode("cp932", errors="replace")
            lines = text.splitlines()
            if not header_saved and lines:
                all_lines.append(lines[0])   # ヘッダー行は一度だけ
                header_saved = True
            all_lines.extend(lines[1:])      # データ行
            total_chunks += 1

        chunk_start = chunk_end + timedelta(days=1)

    print(f"    チャンク数: {total_chunks}, 行数: {len(all_lines)}")

    if len(all_lines) <= 1:
        raise ValueError("データが空です")

    return "\n".join(all_lines).encode("utf-8-sig")

# ---- Git プッシュ ----------------------------------------
def git_push():
    os.chdir(BASE_DIR)
    subprocess.run(["git", "add", "data/"], check=True)
    result = subprocess.run(["git", "diff", "--staged", "--quiet"])
    if result.returncode == 0:
        print("データに変更なし。プッシュをスキップします。")
        return
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    subprocess.run(["git", "commit", "-m", f"データ更新: {now}"], check=True)
    subprocess.run(["git", "push"], check=True)
    print("GitHubへのプッシュ完了")

# ---- メイン ---------------------------------------------
def main():
    print(f"\n{'='*50}")
    print(f"山椒圃場モニター データ更新")
    print(f"開始: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"取得期間: 過去 {FETCH_DAYS} 日間")
    print(f"{'='*50}")

    DATA_DIR.mkdir(exist_ok=True)

    email, password = load_credentials()

    session = requests.Session()
    session.headers.update({
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
    })

    login(session, email, password)

    fields_path = DATA_DIR / "fields.json"
    with open(fields_path, encoding="utf-8") as f:
        fields = json.load(f)

    print(f"圃場数: {len(fields)}")

    manifest = {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "fields":  [],
    }

    for field in fields:
        sid, name = field["sid"], field["name"]
        try:
            content = fetch_csv(session, sid)
            filepath = DATA_DIR / f"{sid}.csv"
            filepath.write_bytes(content)
            manifest["fields"].append({"sid": sid, "name": name, "file": f"{sid}.csv"})
            print(f"  ✓ {name}")
        except Exception as e:
            print(f"  ✗ {name}: {e}")

    # デバッグファイルを削除
    for f in DATA_DIR.glob("debug_*.html"):
        f.unlink()

    with open(DATA_DIR / "manifest.json", "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    print(f"\n取得完了: {len(manifest['fields'])} 件")

    # GitHub Actions では git 操作をワークフロー側で行う
    if not os.environ.get("GITHUB_ACTIONS"):
        git_push()

    print(f"\n{'='*50}")
    print("更新完了！アプリに最新データが反映されます。")
    print(f"{'='*50}\n")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"\nエラー: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
    if not os.environ.get("GITHUB_ACTIONS"):
        input("\nEnterキーで閉じる...")
