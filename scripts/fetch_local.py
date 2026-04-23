"""
Farmo CSV ローカル取得スクリプト
PC上で実行し、GitHubに自動プッシュする
実行方法: run_update.bat をダブルクリック
"""
import os
import json
import subprocess
import requests
from bs4 import BeautifulSoup
from datetime import datetime, timezone
from pathlib import Path

# ---- 設定 ------------------------------------------------
BASE_DIR = Path(__file__).parent.parent
DATA_DIR  = BASE_DIR / "data"
CRED_FILE = BASE_DIR / ".env"
BASE_URL  = "https://farmo.tech/pc"

# ---- 認証情報の読み込み ----------------------------------
def load_credentials():
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
    if "ログアウト" not in resp.text:
        raise RuntimeError("ログインに失敗しました。メールアドレス・パスワードを確認してください。")
    print("ログイン成功")

# ---- CSV取得 --------------------------------------------
def fetch_csv(session, sid):
    resp = session.get(
        f"{BASE_URL}/summary_csv.php?sid={sid}",
        headers={"Referer": f"{BASE_URL}/"},
        timeout=30,
    )
    resp.raise_for_status()
    if b"<!DOCTYPE" in resp.content[:50] or b"<html" in resp.content[:50]:
        raise ValueError("HTMLが返されました（認証失敗）")
    return resp.content

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

    with open(DATA_DIR / "manifest.json", "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    print(f"\n取得完了: {len(manifest['fields'])} 件")

    git_push()

    print(f"\n{'='*50}")
    print("更新完了！アプリに最新データが反映されます。")
    print(f"{'='*50}\n")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"\nエラー: {e}")
    input("\nEnterキーで閉じる...")
