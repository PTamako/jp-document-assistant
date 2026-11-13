import test from 'node:test';
import assert from 'node:assert/strict';
import {
 readSentencePiece,readMarianVocabulary,
 createMarianTokenizer,encodeMarian,decodeMarian
} from '../web/src/marian-tokenizer.js';

function vi(n){
 const a=[];
 do{let b=n%128;n=Math.floor(n/128);if(n)b|=128;a.push(b);}while(n);
 return a;
}
const ft=(field,wire)=>vi(field*8+wire);
const len=(field,value)=>[...ft(field,2),...vi(value.length),...value];
const str=(field,s)=>len(field,Array.from(new TextEncoder().encode(s)));
function piece(s,score,type=1){
 const buf=new ArrayBuffer(4);new DataView(buf).setFloat32(0,score,true);
 return len(1,[...str(1,s),...ft(2,5),...new Uint8Array(buf),...ft(3,0),...vi(type)]);
}
function sampleSpm(type=1){
 const body=[
  ...piece('<unk>',0,2),
  ...piece('▁',-2),
  ...piece('▁ありがとう',12),
  ...piece('▁ありがと',11),
  ...piece('▁ありが',10),
  ...piece('▁あり',9),
  ...piece('あ',-3),
  ...piece('り',-3),
  ...piece('▁あ',8),
  ...piece('が',-2),
  ...piece('と',-2),
  ...piece('う',-2),
  ...len(2,[...ft(3,0),...vi(type)])
 ];
 return Uint8Array.from(body).buffer;
}
function vocabObj(){
 return {'</s>':0,'<unk>':1,'<pad>':65000,'▁':4,'▁ありがとう':11506,
   'あ':15,'り':16,'▁あ':17,'が':18,'と':19,'う':20,
   '▁あり':25,'▁ありが':26,'▁ありがと':27,
   '多':220,'谢':221,'啦':222,'▁多':223,'▁谢':224};
}
test('parse real SentencePiece protobuf fields while ignoring pinned model TrainerSpec extras',()=>{
 const model=readSentencePiece(sampleSpm(1),{minPieces:3});
 assert.equal(model.pieces.length,12);
 assert.equal(model.modelType,2);
 assert.equal(model.pieces[2].piece,'▁ありがとう');
 assert.equal(model.pieces[2].score,12);
});
test('Marian source token uses vocab.json ID rather than .spm piece index',()=>{
 const spm=readSentencePiece(sampleSpm(2),{minPieces:3});
 const vocab=readMarianVocabulary(JSON.stringify(vocabObj()),{minEntries:4});
 const tokenizer=createMarianTokenizer(spm,vocab);
 assert.deepEqual(encodeMarian('ありがとう',tokenizer),[11506,0]);
 assert.equal(decodeMarian([223,221,222,0],vocab),'多谢啦');
});
test('BPE source merges high-ranked adjacent tokens and keeps Marian IDs',()=>{
 const spm=readSentencePiece(sampleSpm(2),{minPieces:3});
 const vocab=readMarianVocabulary(JSON.stringify(vocabObj()),{minEntries:4});
 const tokenizer=createMarianTokenizer(spm,vocab);
 assert.equal(tokenizer.type,2);
 assert.deepEqual(encodeMarian('あ',tokenizer),[17,0]);
});
test('corrupted/HTML model and invalid vocab are rejected explicitly',()=>{
 const html=new TextEncoder().encode('<html>not an SPM</html>').buffer;
 assert.throws(()=>readSentencePiece(html),/SPM_NOT_BINARY/);
 assert.throws(()=>readSentencePiece(Uint8Array.from([10,128]).buffer),/SPM_TRUNCATED/);
 assert.throws(()=>readMarianVocabulary('{',{minEntries:1}),/VOCAB_INVALID_JSON/);
 assert.throws(()=>readMarianVocabulary('{"</s>":0,"<pad>":65000,"<unk>":1}',{minEntries:4}),/VOCAB_TOO_SMALL/);
});
test('tokenizer fails closed when source SPM pieces are not in vocab',()=>{
 const spm=readSentencePiece(sampleSpm(1),{minPieces:3});
 const vocab=readMarianVocabulary(JSON.stringify({'</s>':0,'<unk>':1,'<pad>':65000,'other':9,'oops':10}),{minEntries:4});
 assert.throws(()=>createMarianTokenizer(spm,vocab),/SPM_VOCAB_MISMATCH/);
});
