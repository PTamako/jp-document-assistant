// Shared, deterministic classification for document-assistant -> Kakebo.
// Only a brokerage investment is an asset transfer. Never infer from "SBI" alone.
const normalized = value => String(value||'').normalize('NFKC').toLowerCase()
  .replace(/[\s　()（）・:_-]/g,'');
export function inferSbiInvestmentKind(value){
  const label=normalized(value);
  if(!label||/(?:払戻|返金|キャンセル|取消|配当|手数料)/.test(label))return '';
  if(/(?:ポイント獲得|积分获得|付与|ポイント還元)/.test(label))return '';
  const broker=/(?:sbi証券|sbi证券|sbi)/.test(label);
  const points=/(?:ポイント|积分|vpoint)/.test(label);
  const investment=/(?:投信|投資信託|投资信托|投資|投资|買付|购买|購買)/.test(label);
  // Point investment is an additional purchase, never recurring savings.
  if(broker&&points&&investment)return 'purchase';
  const distinctive=/(?:証券投信|投信積立サービス)/.test(label);
  if(!((broker&&/(?:投信|投資信託|投资信托)/.test(label))||distinctive))return '';
  return /(?:積立|つみたて|积立)/.test(label)?'monthly':'purchase';
}
