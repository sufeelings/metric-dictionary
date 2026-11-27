# -*- coding: utf-8 -*-
"""metrics/ 폴더의 정의서를 파이썬 DuckDB로 다시 계산한다 (화면과 같은 규칙, 배포 제외).

    python tools/check_metrics.py            # 지표마다 12개월 값과 정의서 점검
    python tools/check_metrics.py --json     # 같은 내용을 JSON으로

화면(app.js)이 돌려준 숫자가 맞는지 다른 길로 확인할 때 쓴다 — 두 길이 같으면 숫자를 믿는다.
"""
import json
import os
import re
import sys

import duckdb

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MONTHS = [f"2025-{m:02d}" for m in range(1, 13)]
ELEMENTS = ["numerator", "denominator", "period", "filter", "exclusion"]


def month_parts(m):
    import calendar
    y, mo = map(int, m.split("-"))
    return f"{m}-01", f"{m}-{calendar.monthrange(y, mo)[1]:02d}"


def fill(sql, m):
    s, e = month_parts(m)
    return sql.replace("{month_start}", s).replace("{month_end}", e).replace("{month}", m)


FORBIDDEN = re.compile(r"\b(insert|update|delete|drop|create|alter|attach|detach|copy|pragma|install|load|export|import|call|set)\b", re.I)


def read_only(sql):
    """읽기만 하는 SQL인가 (app.js · duckdb_mcp.py 와 같은 검사)."""
    s = re.sub(r"--[^\n]*", "", sql or "").strip().rstrip(";").strip()
    if not s or ";" in s or not re.match(r"^(select|with)\b", s, re.I):
        return None
    return None if FORBIDDEN.search(re.sub(r"'[^']*'", "''", s)) else s


def blank(v):
    return v is None or str(v).strip() == ""


def problems(m, by_id):
    e = m.get("elements") or {}
    p = []
    for k in ("name", "purpose"):
        if blank(m.get(k)):
            p.append(f"{k} 없음")
    for k in ELEMENTS:
        if blank(e.get(k)):
            p.append(f"{k} 비어 있음")
    if not e.get("min_sample") or blank(e["min_sample"].get("reason")):
        p.append("min_sample 이유 없음")
    if m.get("kind") == "derived":
        if not m.get("inputs") or blank(m.get("formula")):
            p.append("계산식 없음")
        else:
            p += [f"입력 지표 {i} 없음" for i in m["inputs"].values() if i not in by_id]
    else:
        if blank(m.get("sql")):
            p.append("sql 없음")
        if not m.get("sources"):
            p.append("sources 없음")
    rej = m.get("rejected") or []
    if not rej:
        p.append("버린 정의 없음")
    for r in rej:
        if blank(r.get("reason")):
            p.append(f"버린 정의 {r.get('name')} 이유 없음")
    return p


def value_of(m, num, den):
    scale = m.get("scale", 100 if den is not None else 1)
    if den is not None:
        return None if den == 0 else num / den * scale
    return None if num is None else num * scale


def hidden(m, num, den):
    ms = (m.get("elements") or {}).get("min_sample") or {}
    if ms.get("value") is None:
        return False
    basis = num if ms.get("applies_to") == "numerator" else (den if den is not None else num)
    return basis is not None and basis < ms["value"]


def main():
    con = duckdb.connect()
    for f in sorted(os.listdir(os.path.join(HERE, "data"))):
        if f.endswith(".parquet"):
            p = os.path.join(HERE, "data", f).replace("\\", "/")
            con.execute(f"CREATE VIEW {f[:-8]} AS SELECT * FROM read_parquet('{p}')")
    names = json.load(open(os.path.join(HERE, "metrics", "index.json"), encoding="utf-8"))
    metrics = [json.load(open(os.path.join(HERE, "metrics", n), encoding="utf-8")) for n in names]
    by_id = {m["id"]: m for m in metrics}
    series = {}

    def run(sql, mo):
        safe = read_only(fill(sql, mo))
        if not safe:
            raise ValueError("읽기(SELECT · WITH)만 실행합니다. 한 문장만, 바꾸는 명령 없이.")
        cur = con.execute(safe)
        cols = [d[0].lower() for d in cur.description]
        row = cur.fetchone()
        num = row[cols.index("numerator")]
        den = row[cols.index("denominator")] if "denominator" in cols else None
        return (None if num is None else float(num)), (None if den is None else float(den))

    def get(mid):
        if mid in series:
            return series[mid]
        m = by_id[mid]
        s = {}
        if m.get("kind") == "derived":
            for mo in MONTHS:
                vars_ = {k: get(i)[mo]["value"] for k, i in m["inputs"].items()}
                v = None if any(x is None for x in vars_.values()) else eval(m["formula"], {"__builtins__": {}}, vars_)
                s[mo] = {"value": v}
        else:
            for mo in MONTHS:
                num, den = run(m["sql"], mo)
                s[mo] = {"num": num, "den": den, "hidden": hidden(m, num, den),
                         "value": None if hidden(m, num, den) else value_of(m, num, den),
                         "rejected": {r["name"]: value_of(m, *run(r["sql"], mo)) for r in m.get("rejected", []) if r.get("sql")}}
        series[mid] = s
        return s

    out = {}
    for m in metrics:
        try:
            out[m["id"]] = {"name": m["name"], "problems": problems(m, by_id), "months": get(m["id"])}
        except Exception as e:                       # 한 지표가 실패해도 나머지는 계산한다
            out[m["id"]] = {"name": m["name"], "problems": problems(m, by_id), "months": {}, "error": str(e)}
    if "--json" in sys.argv:
        print(json.dumps(out, ensure_ascii=False))
        return
    for mid, o in out.items():
        print(f"\n{o['name']} ({mid}) — {'정의서 완성' if not o['problems'] else '미완성: ' + ' · '.join(o['problems'])}")
        if o.get("error"):
            print(f"  계산하지 못했습니다: {o['error']}")
            continue
        for mo in MONTHS:
            c = o["months"][mo]
            v = "표시 안 함" if c.get("hidden") else ("—" if c["value"] is None else f"{c['value']:,.2f}")
            extra = f"  버린 정의 {c['rejected']}" if c.get("rejected") else ""
            print(f"  {mo}  {v}{extra}")


if __name__ == "__main__":
    main()
