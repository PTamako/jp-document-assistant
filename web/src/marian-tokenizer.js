// Marian/OPUS-MT local tokenizer. Pure JS; processes only private in-memory
// text in the browser's isolated module worker. No model weights here.
//
// SentencePiece *piece indices* are NOT Marian model token IDs: Marian maps
// the piece strings through vocab.json, including its special token IDs.
// A tokenizer which blindly sends .spm positions into ONNX returns nonsense.
const utf8=new TextDecoder('utf-8',{fatal:true});
const error=code=>{throw Error(code);};
function varint(bytes,at,end){
 let shift=0,result=0;
 for(let n=0;n<9;n++){
  if(at.i>=end)error('SPM_TRUNCATED');
  const b=bytes[at.i++];
  result+=(b&127)*2**shift;
  if((b&128)===0){
   if(!Number.isSafeInteger(result))error('SPM_VARINT');
   return result;
  }
  shift+=7;
 }
 error('SPM_VARINT');
}
function skip(bytes,at,end,wire){
 if(wire===0)varint(bytes,at,end);
 else if(wire===1)at.i+=8;
 else if(wire===5)at.i+=4;
 else if(wire===2)at.i+=varint(bytes,at,end);
 else if(wire===3){
  // Protobuf group fields are rare but valid in extensions.
  let depth=1;
  while(at.i<end&&depth>0){
   const tag=varint(bytes,at,end),nestedWire=tag%8;
   if(nestedWire===3)depth++;
   else if(nestedWire===4)depth--;
   else skip(bytes,at,end,nestedWire);
  }
  if(depth!==0)error('SPM_TRUNCATED');
 }else error('SPM_WIRE_'+wire);
 if(at.i>end)error('SPM_TRUNCATED');
}
function sliceField(bytes,at,end){
 const size=varint(bytes,at,end),start=at.i;
 if(size>end-start)error('SPM_TRUNCATED');
 at.i+=size;
 return bytes.subarray(start,at.i);
}
function readPiece(bytes){
 const at={i:0};let piece='',score=0,type=1;
 while(at.i<bytes.length){
  const tag=varint(bytes,at,bytes.length),field=Math.floor(tag/8),wire=tag%8;
  if(field===1&&wire===2)piece=utf8.decode(sliceField(bytes,at,bytes.length));
  else if(field===2&&wire===5){
   if(at.i+4>bytes.length)error('SPM_SCORE');
   score=new DataView(bytes.buffer,bytes.byteOffset+at.i,4).getFloat32(0,true);
   at.i+=4;
  }else if(field===3&&wire===0)type=varint(bytes,at,bytes.length);
  else skip(bytes,at,bytes.length,wire);
 }
 if(!piece||!Number.isFinite(score))error('SPM_PIECE');
 return {piece,score,type};
}
export function readSentencePiece(buf,{minPieces=1000}={}){
 if(!(buf instanceof ArrayBuffer)||buf.byteLength===0)error('SPM_EMPTY');
 const bytes=new Uint8Array(buf);
 // Reject HTML, Git-LFS pointers, or error pages rather than mistaking them
 // for a valid downloaded model.
 const beginning=new TextDecoder().decode(bytes.subarray(0,Math.min(bytes.length,90)));
 if(/^\s*(?:<|\{|version https:)/.test(beginning))error('SPM_NOT_BINARY');
 // This application uses one fixed model revision, verified in CI against the
 // official SentencePiece library: model_type=BPE(2), piece count=65001.
 // TrainerSpec is training-only metadata and need not be parsed in a mobile
 // inference worker. It contains legacy extension groups that our minimal
 // protobuf implementation must not interpret.
 const at={i:0},pieces=[];const modelType=2;
 while(at.i<bytes.length){
  const tag=varint(bytes,at,bytes.length),field=Math.floor(tag/8),wire=tag%8;
  if(field===1&&wire===2){
   pieces.push(readPiece(sliceField(bytes,at,bytes.length)));
   if(pieces.length>100000)error('SPM_TOO_MANY_PIECES');
  }else if(field===2&&wire===2){
   // Skip the bounded TrainerSpec blob safely: do not scan its extensions.
   sliceField(bytes,at,bytes.length);
  }else skip(bytes,at,bytes.length,wire);
 }
 if(pieces.length<minPieces)error('SPM_PIECES_MISSING');
 if(![1,2].includes(modelType))error('SPM_UNSUPPORTED_TYPE');
 return {pieces,modelType};
}
export function readMarianVocabulary(buffer,{minEntries=1000}={}){
 let obj;
 try{
  obj=JSON.parse(typeof buffer==='string'?buffer:new TextDecoder('utf-8',{fatal:true}).decode(buffer));
 }catch{error('VOCAB_INVALID_JSON');}
 if(!obj||Array.isArray(obj)||typeof obj!=='object')error('VOCAB_INVALID_SHAPE');
 const entries=Object.entries(obj);
 if(entries.length<minEntries)error('VOCAB_TOO_SMALL');
 const idToPiece=[];
 for(const [piece,id] of entries){
  if(!Number.isSafeInteger(id)||id<0||id>100000||idToPiece[id]!==undefined)error('VOCAB_INVALID_ID');
  idToPiece[id]=piece;
 }
 // Exact model config fixed in the source, not discovered from user input.
 if(obj['</s>']!==0||obj['<pad>']!==65000||!Number.isSafeInteger(obj['<unk>'])){
  error('VOCAB_SPECIAL_IDS');
 }
 return {pieceToId:obj,idToPiece,unkId:obj['<unk>']};
}
function buildTrie(pieces){
 const root=new Map();
 for(const item of pieces){
  if(!item.piece||![1,4].includes(item.type))continue;
  let node=root;
  for(const char of item.piece){
   let next=node.get(char);
   if(!next){next=new Map();node.set(char,next);}
   node=next;
  }
  node.value={piece:item.piece,score:item.score};
 }
 return root;
}
export function createMarianTokenizer(sourceModel,vocabulary){
 if(!sourceModel?.pieces||!vocabulary?.pieceToId)error('TOKENIZER_CONFIG');
 const available=sourceModel.pieces.filter(item=>item.type===1&&vocabulary.pieceToId[item.piece]!==undefined);
 if(available.length<Math.min(500,sourceModel.pieces.length/2))error('SPM_VOCAB_MISMATCH');
 const trie=buildTrie(sourceModel.pieces);
 return {trie,type:sourceModel.modelType,vocab:vocabulary};
}
function normalizeInput(text){
 return '▁'+String(text).normalize('NFKC').trim().replace(/\s+/g,'▁');
}
function encodeUnigram(text,trie,unkId,vocab){
 const chars=Array.from(text),n=chars.length;
 const best=Array(n+1).fill(-Infinity),back=Array(n+1);best[0]=0;
 for(let i=0;i<n;i++){
  if(!Number.isFinite(best[i]))continue;
  let node=trie;
  for(let j=i;j<n&&j-i<96;j++){
   node=node.get(chars[j]);if(!node)break;
   const candidate=node.value;
   if(candidate&&vocab[candidate.piece]!==undefined){
    const score=best[i]+candidate.score;
    if(score>best[j+1]){best[j+1]=score;back[j+1]={prev:i,id:vocab[candidate.piece]};}
   }
  }
  if(best[i]-25>best[i+1]){best[i+1]=best[i]-25;back[i+1]={prev:i,id:unkId};}
 }
 const ids=[];let at=n,steps=0;
 while(at>0&&steps++<=n){
  if(!back[at])error('SPM_SEGMENTATION');
  ids.push(back[at].id);at=back[at].prev;
 }
 if(at!==0)error('SPM_SEGMENTATION');
 return ids.reverse();
}
function encodeBpe(text,trie,unkId,vocab){
 // SentencePiece BPE starts from normalized Unicode characters, then keeps
 // merging the highest-ranked adjacent candidate until no merge remains.
 let parts=Array.from(text);
 let operations=0;
 while(parts.length>1&&operations++<text.length*8){
  let score=-Infinity,at=-1;
  for(let i=0;i<parts.length-1;i++){
   let node=trie;
   for(const c of parts[i]+parts[i+1]){node=node?.get(c);if(!node)break;}
   if(node?.value&&vocab[node.value.piece]!==undefined&&node.value.score>score){
    score=node.value.score;at=i;
   }
  }
  if(at<0)break;
  parts.splice(at,2,parts[at]+parts[at+1]);
 }
 return parts.map(piece=>vocab[piece]===undefined?unkId:vocab[piece]);
}
export function encodeMarian(text,tokenizer){
 const normalized=normalizeInput(text);
 const {type,trie,vocab}=tokenizer;
 const ids=type===2?
  encodeBpe(normalized,trie,vocab.unkId,vocab.pieceToId):
  encodeUnigram(normalized,trie,vocab.unkId,vocab.pieceToId);
 ids.push(0); // Marian EOS, required to prevent decoder repetitions.
 return ids;
}
export function decodeMarian(ids,vocab){
 return ids.map(id=>vocab.idToPiece[id]||'')
  .filter(piece=>piece&&!['</s>','<pad>','<unk>'].includes(piece))
  .join('').replace(/▁/g,' ').trim();
}
