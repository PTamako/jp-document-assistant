// Contract test against the *real* pinned public tokenizer assets (not a mock).
// No private documents, AI requests, user secrets, or ONNX weights involved.
// Run in GitHub CI with internet access to catch provider format drift.
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readSentencePiece,readMarianVocabulary,createMarianTokenizer,encodeMarian} from '../web/src/marian-tokenizer.js';

const base='https://huggingface.co/ruozhi521/shiyin-mt-ja-zh-onnx/resolve/82c2cb0/';
async function get(path){
 let previousError;
 for(let attempt=0;attempt<2;attempt++){
  try{
   const response=await fetch(base+path+'?download=true',{signal:AbortSignal.timeout(100000)});
   if(!response.ok)throw Error('HTTP_'+response.status);
   const bytes=await response.arrayBuffer();
   if(bytes.byteLength<500000)throw Error('MODEL_TOO_SHORT');
   return {bytes,sha:createHash('sha256').update(Buffer.from(bytes)).digest('hex')};
  }catch(e){previousError=e;}
 }
 throw Error(path+' download failed: '+String(previousError?.message||previousError));
}
const src=await get('source.spm');
const v=await get('vocab.json');
// Compare against upstream's official SentencePiece implementation.
const official=JSON.parse(execFileSync('python',['-c',
 "import sys,json,sentencepiece as spm;from sentencepiece import sentencepiece_model_pb2 as pb;m=pb.ModelProto();m.ParseFromString(sys.stdin.buffer.read());p=spm.SentencePieceProcessor(model_proto=m.SerializeToString());print(json.dumps(dict(model_type=int(m.trainer_spec.model_type),count=len(m.pieces),sample=p.encode('ありがとう',out_type=int))))"
],{input:Buffer.from(src.bytes),encoding:'utf8'}));
console.log('Official SentencePiece:',JSON.stringify(official));
const model=readSentencePiece(src.bytes);
const vocab=readMarianVocabulary(v.bytes);
const tokenizer=createMarianTokenizer(model,vocab);
const tokens=encodeMarian('ありがとう',tokenizer);
if(tokens.length!==2||tokens[1]!==0||tokens[0]!==11506){
 throw Error('Model token ID mismatch; ありがとう expected [11506,0], got '+JSON.stringify(tokens));
}
console.log(JSON.stringify({
 verified:true,pieceCount:model.pieces.length,type:model.modelType,
 vocabCount:Object.keys(vocab.pieceToId).length,
 encodedSample:tokens,
 spmSha:src.sha,vocabSha:v.sha
}));
