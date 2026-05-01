"""
WAGRI 気象データ取得スクリプト（GitHub Actions 用）
環境変数: WAGRI_CLIENT_ID, WAGRI_CLIENT_SECRET, WAGRI_MESH_USERID, WAGRI_MESH_PASSWORD
"""
import os
import sys
import io
import json
import requests
import numpy as np
import h5py
from datetime import datetime, timedelta, timezone, date
from pathlib import Path

DATA_DIR    = Path("data")
FIELDS_FILE = DATA_DIR / "fields.json"
OUTPUT_FILE = DATA_DIR / "wagri_weather.json"
FETCH_DAYS  = 365  # 直近1年分

DATASETS = {
    "TMP_mea": "平均気温",
    "TMP_max": "最高気温",
    "TMP_min": "最低気温",
    "APCP":    "降水量",
    "SSD":     "日照時間",
    "GSR":     "全天日射量",
}

# nc4 の時間単位: "days since 1900-1-1 00:00:0.0"
NC_EPOCH = datetime(1900, 1, 1)


def get_token() -> str:
    res = requests.post(
        "https://api.wagri2.net/Token",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        data={
            "grant_type":    "client_credentials",
            "client_id":     os.environ["WAGRI_CLIENT_ID"].strip(),
            "client_secret": os.environ["WAGRI_CLIENT_SECRET"].strip(),
        },
        timeout=30,
    )
    res.raise_for_status()
    return res.json()["access_token"]


def get_auth_key(token: str) -> str:
    res = requests.post(
        "https://api.wagri2.net/wagri-mesh/weather/AuthenticationKey",
        headers={"X-Authorization": token, "Content-Type": "application/json"},
        json={
            "userid":   os.environ["WAGRI_MESH_USERID"].strip(),
            "password": os.environ["WAGRI_MESH_PASSWORD"].strip(),
        },
        timeout=30,
    )
    res.raise_for_status()
    return res.text.strip().strip('"')


def parse_time_units(units_str: str) -> datetime:
    """'days since YYYY-M-D ...' から基準日時を返す"""
    try:
        parts = units_str.strip().split()
        return datetime.strptime(parts[2], "%Y-%m-%d")
    except Exception:
        return NC_EPOCH


def fetch_nc4(token: str, auth_key: str, dataset: str,
              lat: float, lon: float, start: str, end: str) -> dict:
    """nc4(HDF5) 形式で取得し、{日付: 値} の辞書を返す"""
    r = requests.get(
        "https://api.wagri2.net/wagri-mesh/weather/AMD",
        headers={"X-Authorization": token},
        params={
            "userid":    os.environ["WAGRI_MESH_USERID"].strip(),
            "authKey":   auth_key,
            "dataset":   dataset,
            "type":      "nc4",
            "startdate": start,
            "enddate":   end,
            "latitude":  str(lat),
            "longitude": str(lon),
        },
        timeout=60,
    )
    r.raise_for_status()

    with h5py.File(io.BytesIO(r.content), "r") as f:
        time_vals  = f["time"][:]
        time_units = f["time"].attrs.get("units", b"days since 1900-1-1")
        if isinstance(time_units, bytes):
            time_units = time_units.decode()

        epoch = parse_time_units(time_units)

        # データ変数を探す
        data_key = None
        for k in f.keys():
            if k.lower() not in ("time", "lat", "lon", "latitude", "longitude"):
                data_key = k
                break
        if data_key is None:
            raise ValueError("データ変数が見つかりません")

        raw = f[data_key][:]

    # (time, lat, lon) → (time,) に圧縮
    if raw.ndim > 1:
        raw = raw.reshape(len(time_vals), -1)[:, 0]

    result = {}
    for days_offset, v in zip(time_vals, raw):
        dt = epoch + timedelta(days=float(days_offset))
        key = dt.strftime("%Y-%m-%d")
        masked = np.ma.is_masked(v) if np.ma.isMaskedArray(raw) else False
        result[key] = round(float(v), 2) if not masked else None

    return result


def main():
    for key in ["WAGRI_CLIENT_ID", "WAGRI_CLIENT_SECRET",
                "WAGRI_MESH_USERID", "WAGRI_MESH_PASSWORD"]:
        if not os.environ.get(key):
            print(f"エラー: 環境変数 {key} が必要です")
            sys.exit(1)

    DATA_DIR.mkdir(exist_ok=True)

    token    = get_token()
    auth_key = get_auth_key(token)
    print("認証成功")

    today     = date.today()
    yesterday = today - timedelta(days=1)
    start_str = (today - timedelta(days=FETCH_DAYS)).strftime("%Y-%m-%d")
    end_str   = yesterday.strftime("%Y-%m-%d")
    print(f"取得期間: {start_str} 〜 {end_str}")

    with open(FIELDS_FILE, encoding="utf-8") as f:
        fields = json.load(f)

    output = {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "period":  {"start": start_str, "end": end_str},
        "fields":  [],
    }

    for field in fields:
        if "lat" not in field or "lon" not in field:
            continue

        name, lat, lon = field["name"], field["lat"], field["lon"]
        print(f"\n{name} ({lat}, {lon})")

        field_entry = {"name": name, "lat": lat, "lon": lon, "data": {}, "errors": {}}

        for ds_key, ds_label in DATASETS.items():
            try:
                daily = fetch_nc4(token, auth_key, ds_key, lat, lon, start_str, end_str)
                field_entry["data"][ds_label] = daily
                print(f"  ✓ {ds_label} ({len(daily)}日)")
            except Exception as e:
                field_entry["errors"][ds_label] = str(e)
                print(f"  ✗ {ds_label}: {e}")

        output["fields"].append(field_entry)

    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"\n完了: {len(output['fields'])}圃場 → {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
