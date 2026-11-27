# 지표 사전 — 5주차 목업

지표마다 **정의서 한 장**이 있고, 카드는 정의서대로만 값을 계산합니다.
정의서(`metrics/` 폴더의 JSON)를 고치거나 새로 넣으면 코드를 고치지 않아도 카드가 바뀝니다.

## 돌려보기 · 올리기

```
python -m http.server 8000
```

처음 열 때 데이터 엔진(DuckDB-WASM)을 jsdelivr 에서 받습니다. 테이블은 SQL에 나올 때 그 테이블만 받습니다.
올릴 때는 이 폴더를 GitHub 저장소로 만들고 Vercel → Import → Application Preset: Other → Deploy. 서버 함수도 API 키도 없습니다.

## 파일

| 파일 | 하는 일 |
|---|---|
| `metrics/*.json` | ★ **정의서** — 여섯 요소(분자 · 분모 · 기간 · 거르기 · 제외 · 최소 표본), 계산 SQL, 출처(계보), 버린 정의와 이유. **사람이 정한다** |
| `metrics/index.json` | 카드로 보여 줄 정의서 파일 이름 목록. 정의서를 새로 만들면 여기에도 한 줄 더한다 |
| `dashboard.json` | «대시보드» 탭 구성. `top`(위에 크게) · `trend`(월별 추이)에 **정의서 id만** 적는다. 숫자는 카드와 같은 계산을 그대로 쓴다 |
| `app.js` · `index.html` · `style.css` | 화면. 지표 이름도 «무엇을 셀지»도 들어 있지 않다 |
| `data/*.parquet` · `schema.json` | 통신사 가상 데이터 12개 테이블(4주차와 같은 데이터)과 테이블 설명 |
| `tools/duckdb_mcp.py` · `.mcp.json` | Claude Code가 이 폴더의 데이터에 직접 SQL을 돌리는 연결 (읽기 전용) |
| `tools/check_metrics.py` | 정의서를 파이썬으로 다시 계산해 화면의 숫자와 맞춰 본다 (배포 제외) |

## 정의서 한 장의 모양

```json
{
  "id": "new_customers",
  "name": "신규 가입 고객 수",
  "purpose": "무엇을 재려는지 한 문장",
  "kind": "base",
  "unit": "명",
  "elements": {
    "numerator": "…", "denominator": "…", "period": "…", "filter": "…", "exclusion": "…",
    "min_sample": { "value": null, "reason": "…" }
  },
  "sql": "SELECT COUNT(*) AS numerator FROM … WHERE … BETWEEN DATE '{month_start}' AND DATE '{month_end}'",
  "sources": ["customers.signup_date"],
  "rejected": [ { "name": "버린 정의", "sql": "…", "reason": "버린 이유" } ],
  "unanswerable": "이 지표로 답할 수 없는 것"
}
```

- SQL은 `numerator` 열(비율이면 `denominator` 열도)을 돌려줍니다. `{month}` · `{month_start}` · `{month_end}`는 화면의 기준월로 바뀝니다.
- 비율 지표는 `numerator ÷ denominator × 100`으로 계산하고, 분모가 `min_sample` 미만이면 값을 표시하지 않습니다.
- `"kind": "derived"`는 다른 지표를 가져다 씁니다: `"inputs": {"a": "monthly_revenue", "b": "retained_customers"}`, `"formula": "a / b"`.
- 요소가 비어 있으면 카드에 **정의 미완성**이 뜨고, 어느 요소가 비었는지 알려 줍니다.

## 지키는 것

- **읽기만 합니다.** SELECT · WITH로 시작하는 한 문장만 실행합니다. 정의서에 바꾸는 명령이 들어 있으면 그 카드만 «계산 오류»가 됩니다.
- 모든 숫자 옆에 SQL이 있습니다(카드의 «SQL 보기»).
- 계산은 브라우저 안에서만 합니다. 데이터는 밖으로 나가지 않습니다.

## 확인한 것

- 파이썬 DuckDB(`tools/check_metrics.py`)와 브라우저 화면이 같은 숫자를 냅니다.
- 미완성 정의서 · SQL 오류 정의서 · 파생 지표 · 최소 표본 감춤 · 계보 화면이 모두 열립니다.

시작할 때 들어 있는 카드는 «신규 가입 고객 수» 하나입니다. 1월에 «버린 정의»가 43,845로 크게 튀는 것은 usage_monthly가 2025-01부터 시작해서 기존 고객 전원이 첫 사용으로 잡히기 때문입니다.
