import test from 'node:test';
import assert from 'node:assert/strict';
import {parseOcrSpaceResult} from '../worker/ocr-space.js';
test('OCR.space Engine 3 parses only successful pages',()=>{
 const result=parseOcrSpaceResult({OCRExitCode:2,IsErroredOnProcessing:false,ParsedResults:[
  {FileParseExitCode:1,ParsedText:'区役所からのお知らせ'},
  {FileParseExitCode:-20,ParsedText:'不正确的文本'}
 ]});
 assert.match(result,/区役所/);
 assert.doesNotMatch(result,/不正确/);
});
test('OCR.space errors and blank pages never fabricate text',()=>{
 assert.equal(parseOcrSpaceResult({OCRExitCode:4,IsErroredOnProcessing:true}),null);
 assert.equal(parseOcrSpaceResult({OCRExitCode:1,ParsedResults:[{FileParseExitCode:1,ParsedText:''}]}),null);
});
