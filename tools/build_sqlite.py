# -*- coding: utf-8 -*-
"""csv/ 의 CSV 12개로 SQLite 데이터베이스 하나를 만든다 (배포 제외).

    python3 tools/build_sqlite.py                 # csv/ → telco.db
    python3 tools/build_sqlite.py csv out.db      # 폴더와 파일 이름을 바꿀 때

정한 것
  - 테이블은 모두 STRICT. 날짜는 TEXT 'YYYY-MM-DD' + 형식 CHECK, 참·거짓은 INTEGER 0/1.
  - 빈 칸은 모두 NULL 로 넣는다(빈 문자열로 넣지 않는다). NULL 을 허용하는 컬럼은 다섯 개뿐이라
    다른 컬럼에 빈 칸이 오면 NOT NULL 오류로 멈춘다.
  - 기본 키 · NOT NULL · CHECK 는 넣는 동안 검사한다. 외래 키는 다 넣은 뒤 PRAGMA foreign_key_check 로
    테이블마다 어기는 행을 센다 — 첫 행에서 멈추지 않고 몇 행이 어기는지 보여 주기 위해서다.
    한 행이라도 어기면 새 파일로 바꾸지 않는다.
  - 다 만든 뒤 테이블마다 CSV 행 수 · DB 행 수 · 외래 키를 어기는 행 수를 표로 찍는다.
  - visitor_id 는 가리킬 방문자 테이블이 CSV에 없어 외래 키를 걸지 않는다.
  - 분류 값에는 허용 목록 CHECK 를 걸지 않는다 — 다음 달 새 값이 오면 넣기가 실패하므로.
새 파일을 임시 이름으로 만든 뒤 모든 검사가 통과하면 그때 바꿔 넣는다. 실패하면 기존 파일은 그대로다.
"""
import csv
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(HERE, sys.argv[1] if len(sys.argv) > 1 else "csv")
OUT = os.path.join(HERE, sys.argv[2] if len(sys.argv) > 2 else "telco.db")

# 컬럼: (이름, 종류, NULL 허용). 종류 — text · int · real · bool · date · datetime · ym
# 표는 부모 → 자식 순서다(외래 키를 넣는 동안 검사하므로).
TABLES = {
    "campaigns": dict(cols=[("campaign_id", "text", 0), ("campaign_name", "text", 0), ("acquisition_channel", "text", 0),
                            ("objective", "text", 0), ("start_date", "date", 0), ("end_date", "date", 0),
                            ("target_segment", "text", 0), ("total_budget", "int", 0)],
                      pk=["campaign_id"]),
    "agents": dict(cols=[("agent_id", "text", 0), ("team", "text", 0), ("hire_date", "date", 0), ("job_satisfaction", "real", 0),
                         ("burnout_score", "real", 0), ("training_hours", "real", 0), ("is_resigned", "bool", 0)],
                   pk=["agent_id"]),
    "experiments": dict(cols=[("experiment_id", "text", 0), ("experiment_name", "text", 0), ("hypothesis", "text", 0),
                              ("target_funnel_step", "text", 0), ("primary_metric", "text", 0), ("guardrail_metric", "text", 0),
                              ("start_date", "date", 0), ("end_date", "date", 0)],
                        pk=["experiment_id"]),
    "customers": dict(cols=[("customer_id", "text", 0), ("customer_name", "text", 0), ("visitor_id", "text", 1),
                            ("signup_date", "date", 0), ("acquisition_channel", "text", 0), ("campaign_id", "text", 1),
                            ("plan_type", "text", 0), ("monthly_fee", "int", 0), ("age_group", "text", 0), ("region", "text", 0),
                            ("device_os", "text", 0), ("is_churned", "bool", 0), ("churn_date", "date", 1)],
                      pk=["customer_id"], fk=[("campaign_id", "campaigns", "campaign_id")]),
    "ad_spend": dict(cols=[("campaign_id", "text", 0), ("spend_date", "date", 0), ("impressions", "int", 0),
                           ("clicks", "int", 0), ("spend", "int", 0)],
                     pk=["campaign_id", "spend_date"], fk=[("campaign_id", "campaigns", "campaign_id")]),
    "sessions": dict(cols=[("session_id", "text", 0), ("visitor_id", "text", 0), ("session_date", "date", 0),
                           ("acquisition_channel", "text", 0), ("campaign_id", "text", 1), ("device", "text", 0),
                           ("is_first_visit", "bool", 0), ("duration_sec", "int", 0)],
                     pk=["session_id"], fk=[("campaign_id", "campaigns", "campaign_id")]),
    "funnel_events": dict(cols=[("event_id", "text", 0), ("visitor_id", "text", 0), ("session_id", "text", 0),
                                ("event_timestamp", "datetime", 0), ("event_date", "date", 0), ("funnel_step", "text", 0),
                                ("step_order", "int", 0)],
                          pk=["event_id"], fk=[("session_id", "sessions", "session_id")]),
    "experiment_assignments": dict(cols=[("experiment_id", "text", 0), ("visitor_id", "text", 0), ("variant", "text", 0),
                                         ("assigned_at", "date", 0)],
                                   pk=["experiment_id", "visitor_id"], fk=[("experiment_id", "experiments", "experiment_id")]),
    "support_tickets": dict(cols=[("ticket_id", "text", 0), ("customer_id", "text", 0), ("agent_id", "text", 0),
                                  ("created_date", "date", 0), ("contact_channel", "text", 0), ("ticket_category", "text", 0),
                                  ("duration_min", "int", 0), ("resolution_hours", "real", 0), ("status", "text", 0),
                                  ("is_recontact", "bool", 0)],
                            pk=["ticket_id"], fk=[("customer_id", "customers", "customer_id"), ("agent_id", "agents", "agent_id")]),
    "csat_survey": dict(cols=[("survey_id", "text", 0), ("ticket_id", "text", 0), ("customer_id", "text", 0),
                              ("survey_date", "date", 0), ("csat", "int", 0), ("nps", "int", 0), ("comment", "text", 1)],
                        pk=["survey_id"], unique=[["ticket_id"]],
                        fk=[("ticket_id", "support_tickets", "ticket_id"), ("customer_id", "customers", "customer_id")],
                        check=["csat BETWEEN 1 AND 5", "nps BETWEEN 0 AND 10"]),
    "usage_monthly": dict(cols=[("customer_id", "text", 0), ("year_month", "ym", 0), ("data_gb", "real", 0),
                                ("voice_min", "int", 0), ("sms_count", "int", 0), ("billing_amount", "int", 0),
                                ("app_login_count", "int", 0), ("service_count", "int", 0), ("is_active", "bool", 0)],
                          pk=["customer_id", "year_month"], fk=[("customer_id", "customers", "customer_id")]),
    "voc": dict(cols=[("voc_id", "text", 0), ("customer_id", "text", 0), ("received_date", "date", 0),
                      ("contact_channel", "text", 0), ("voc_type", "text", 0), ("voc_category", "text", 0),
                      ("content", "text", 0), ("sentiment", "text", 0)],
                pk=["voc_id"], fk=[("customer_id", "customers", "customer_id")]),
}

SQLTYPE = {"text": "TEXT", "date": "TEXT", "datetime": "TEXT", "ym": "TEXT", "int": "INTEGER", "real": "REAL", "bool": "INTEGER"}


def col_check(name, kind):
    if kind == "date":
        return f"date({name}) = {name}"
    if kind == "datetime":
        return f"datetime({name}) = {name}"
    if kind == "ym":
        return f"length({name}) = 7 AND date({name} || '-01') = {name} || '-01'"
    if kind == "bool":
        return f"{name} IN (0, 1)"
    return None


def ddl(table, t):
    lines = []
    for name, kind, nullable in t["cols"]:
        c = col_check(name, kind)
        lines.append(f"  {name} {SQLTYPE[kind]}{'' if nullable else ' NOT NULL'}{f' CHECK ({c})' if c else ''}")
    lines.append(f"  PRIMARY KEY ({', '.join(t['pk'])})")
    for u in t.get("unique", []):
        lines.append(f"  UNIQUE ({', '.join(u)})")
    for col, ref, refcol in t.get("fk", []):
        lines.append(f"  FOREIGN KEY ({col}) REFERENCES {ref} ({refcol})")
    for c in t.get("check", []):
        lines.append(f"  CHECK ({c})")
    out = [f"CREATE TABLE {table} (\n" + ",\n".join(lines) + "\n) STRICT;"]
    for col, _, _ in t.get("fk", []):  # SQLite 는 외래 키 쪽 인덱스를 저절로 만들지 않는다
        # 기본 키의 첫 컬럼이거나 UNIQUE 로 이미 인덱스가 있으면 따로 만들지 않는다
        if t["pk"][0] != col and [col] not in t.get("unique", []):
            out.append(f"CREATE INDEX idx_{table}_{col} ON {table} ({col});")
    return "\n".join(out)


def convert(v, kind, where):
    if v == "":
        return None  # 빈 칸은 NULL. NOT NULL 컬럼이면 넣을 때 오류가 난다
    if kind in ("int", "real"):
        try:
            return int(v) if kind == "int" else float(v)
        except ValueError:
            raise ValueError(f"{where}: {'정수' if kind == 'int' else '숫자'}가 아닌 값 {v!r}") from None
    if kind == "bool":
        if v not in ("true", "false"):
            raise ValueError(f"{where}: 참·거짓이 아닌 값 {v!r}")
        return 1 if v == "true" else 0
    return v


def main():
    tmp = OUT + ".building"
    for p in (tmp, tmp + "-journal"):
        if os.path.exists(p):
            os.remove(p)
    con = sqlite3.connect(tmp, isolation_level=None)  # 트랜잭션은 아래 BEGIN · COMMIT 으로 직접 연다
    con.execute("PRAGMA foreign_keys = OFF")  # 넣는 동안은 끄고, 다 넣은 뒤 foreign_key_check 로 센다
    keep = os.path.basename(OUT)

    def fail(msg):  # 임시 파일을 지우고 멈춘다. 기존 DB 는 건드리지 않는다
        con.close()
        for p in (tmp, tmp + "-journal"):
            if os.path.exists(p):
                os.remove(p)
        raise SystemExit(f"실패: {msg}\n{keep} 은 바뀌지 않았습니다.")

    counts = {}
    for table, t in TABLES.items():
        con.executescript(ddl(table, t))
    con.execute("BEGIN")
    for table, t in TABLES.items():
        names = [c[0] for c in t["cols"]]
        ins = f"INSERT INTO {table} VALUES ({', '.join('?' * len(names))})"
        path = os.path.join(SRC, f"{table}.csv")
        n = 0
        try:
            with open(path, newline="", encoding="utf-8-sig") as fh:
                r = csv.reader(fh)
                head = next(r, None)
                if head != names:
                    fail(f"{table}.csv 머리줄이 설계와 다릅니다.\n  설계: {names}\n  파일: {head}")
                for i, row in enumerate(r, start=2):
                    if len(row) != len(names):
                        fail(f"{table}.csv {i}행: 칸 수 {len(row)} (설계 {len(names)})")
                    try:
                        con.execute(ins, [convert(v, k, f"{table}.csv {i}행 {c}") for v, (c, k, _) in zip(row, t["cols"])])
                    except ValueError as e:  # e 에 «파일 행 컬럼: 이유»가 들어 있다
                        fail(str(e))
                    except sqlite3.Error as e:
                        fail(f"{table}.csv {i}행: {e}")
                    n += 1
        except FileNotFoundError:
            fail(f"{table}.csv 가 {SRC} 에 없습니다.")
        except UnicodeDecodeError as e:
            fail(f"{table}.csv 가 UTF-8 이 아닙니다 ({e.reason}, {e.start}바이트째). UTF-8 로 저장해 다시 넣어 주세요.")
        counts[table] = n
    con.execute("COMMIT")
    # 외래 키를 어기는 행: foreign_key_check 는 (테이블, rowid, 부모, fk 번호)를 어긴 외래 키마다 한 줄씩 준다.
    # 한 행이 외래 키 두 개를 어기면 두 줄이 나오므로 rowid 로 묶어 «행» 수로 센다. 예시 값도 몇 개 모은다.
    fkcol = {t: {r[0]: r[3] for r in con.execute(f"PRAGMA foreign_key_list({t})")} for t in TABLES}
    bad_rows = {t: set() for t in TABLES}
    examples = {t: [] for t in TABLES}
    for table, rowid, parent, fkid in con.execute("PRAGMA foreign_key_check").fetchall():
        bad_rows[table].add(rowid)
        if len(examples[table]) < 3:
            col = fkcol[table][fkid]
            v = con.execute(f"SELECT {col} FROM {table} WHERE rowid = ?", (rowid,)).fetchone()[0]
            examples[table].append(f"{col}={v!r} (→ {parent} 에 없음)")
    bad = {t: len(v) for t, v in bad_rows.items()}
    integrity = con.execute("PRAGMA integrity_check").fetchone()[0]
    in_db = {t: con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in TABLES}
    con.execute("ANALYZE")
    con.close()
    ok = not any(bad.values()) and integrity == "ok" and in_db == counts
    print("| 테이블 | CSV 행 수 | DB 행 수 | 외래 키를 어기는 행 |")
    print("|---|---:|---:|---:|")
    for t in TABLES:
        fk = "—" if not TABLES[t].get("fk") else f"{bad[t]:,}"
        print(f"| {t} | {counts[t]:,} | {in_db[t]:,} | {fk} |")
    print(f"| **합계** | **{sum(counts.values()):,}** | **{sum(in_db.values()):,}** | **{sum(bad.values()):,}** |")
    print(f"\nintegrity_check: {integrity}")
    for t in TABLES:
        if examples[t]:
            print(f"  {t} 위반 예: " + " · ".join(examples[t]))
    if not ok:
        os.remove(tmp)
        raise SystemExit(f"실패: 검사를 통과하지 못했습니다.\n{keep} 은 바뀌지 않았습니다.")
    os.replace(tmp, OUT)
    print(f"만들었습니다: {OUT} ({os.path.getsize(OUT) / 1024 / 1024:.1f} MB)")


if __name__ == "__main__":
    main()
