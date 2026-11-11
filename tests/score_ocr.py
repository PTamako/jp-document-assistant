"""Strict offline field scorer for annotated, privacy-cleared OCR JSONL.

Usage: python tests/score_ocr.py gold.jsonl predictions.jsonl
Each file contains objects with `id`, `fields` containing `amount_jpy`,
`due_date`, `payment_state`, `document_type`. Null means unknown, not zero.
No model requests are issued here. Printed numbers do NOT indicate that any
real-world OCR has been evaluated unless real predictions are supplied.
"""
import json, sys
from pathlib import Path
FIELDS = ['amount_jpy','due_date','payment_state','document_type']

def load(path):
    items={}
    for n,line in enumerate(Path(path).read_text(encoding='utf-8').splitlines(),1):
        if not line.strip(): continue
        row=json.loads(line)
        ident=row['id']
        if ident in items: raise ValueError(f'duplicate id {ident} in {path}:{n}')
        if not isinstance(row.get('fields'),dict): raise ValueError(f'missing fields: {ident}')
        items[ident]=row['fields']
    return items

def score(gold,pred):
    result={}
    for f in FIELDS:
        valid=[k for k,fields in gold.items() if fields.get(f) is not None]
        matched=sum(1 for k in valid if k in pred and pred[k].get(f)==gold[k][f])
        missing=sum(1 for k in valid if k not in pred or pred[k].get(f) is None)
        result[f]={'eligible':len(valid),'exact':matched,'missing':missing,'accuracy':round(matched/len(valid),4) if valid else None}
    return {'gold_cases':len(gold),'predicted_cases':len(pred),'missing_cases':len(set(gold)-set(pred)), 'fields':result}

if __name__=='__main__':
    if len(sys.argv)!=3:
        raise SystemExit('Usage: score_ocr.py gold.jsonl predictions.jsonl')
    print(json.dumps(score(load(sys.argv[1]),load(sys.argv[2])),ensure_ascii=False,indent=2))
