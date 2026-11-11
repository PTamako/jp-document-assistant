# OCR 真值标注格式（模板；本交付没有真实准确率数据）

`gold.jsonl` 每行 `{ "id": "private-anonymous-id", "fields": { "amount_jpy": 1234, "due_date": "YYYY-MM-DD", "payment_state": "paid|unpaid|unknown", "document_type": "receipt|salary|utility|card|manual|policy|campaign" } }`。若字段原件未包含、被隐私遮盖或无法人工确认，使用 `null`；绝不能填 0。预测文件 `predictions.jsonl` 结构相同。用 `python tests/score_ocr.py gold.jsonl predictions.jsonl` 产生严格相等指标。

该脚本不调用 AI，不上传图像、没有云费用。**不得使用模板数据生成对外宣称的准确率**。对 IngCrowd 数据集的标注先做字段映射、保留照片引用、遵守 CC BY-NC 许可，并明确仅选定区域有真值而非完整正文。对工资/账单/法规的关键条款需要独立、经授权的真实脱敏样本与人工真值。
