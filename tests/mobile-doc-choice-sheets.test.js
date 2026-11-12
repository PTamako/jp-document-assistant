import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
const app=read('web/src/App.vue');
const style=read('web/src/style.css');
const part=(a,b)=>{
 const first=app.indexOf(a),last=app.indexOf(b,first);
 assert.ok(first>=0&&last>first,'required Vue view must exist');
 return app.slice(first,last);
};

test('document filter fits in one short sheet and choices open a second layer',()=>{
 const filter=part("<template v-else-if=\"sheet==='filter'\">","<template v-else-if=\"sheet==='choicePicker'\">");
 for(const field of ['category','visibility','archived','favorite'])
  assert.match(filter,new RegExp("openChoice\\('"+field+"'\\)"));
 assert.doesNotMatch(filter,/<h3>文书类型<\/h3>/);
 assert.doesNotMatch(filter,/<div class="option-list"/);
 assert.doesNotMatch(filter,/<select/);
 assert.match(filter,/创建月份（可留空）/);
 assert.match(filter,/@click="searchDocs"/);
});
test('picker uses search, shows selection, and returns to parent without applying prematurely',()=>{
 const choices=part("<template v-else-if=\"sheet==='choicePicker'\">","<template v-else-if=\"sheet==='field'\">");
 assert.match(choices,/v-if="pickerItems.length>5"/);
 assert.match(choices,/v-model="choiceSearch"/);
 assert.match(choices,/v-for="option in visiblePickerItems"/);
 assert.match(choices,/@click="selectChoice\(option.value\)"/);
 assert.match(choices,/@click="backChoice"/);
 assert.doesNotMatch(choices,/@click="searchDocs"/);
 const back=part('function backChoice(){','function selectChoice(value){');
 assert.match(back,/sheet.value=choiceReturnSheet.value/);
 assert.doesNotMatch(back,/closeSheet\(\)/);
 const select=part('function selectChoice(value){','function closeNestedSheet(){');
 assert.match(select,/backChoice\(\)/);
 assert.doesNotMatch(select,/api\(|loadTab\(|searchDocs\(|closeSheet\(\)/);
});
test('new document import uses one provider menu and single-choice retention/source fields',()=>{
 const imp=part("<template v-if=\"sheet==='import'\">","<template v-else-if=\"sheet==='importSources'\">");
 assert.match(imp,/@click="sheet='importSources'"/);
 assert.match(imp,/openChoice\('textSource'\)/);
 assert.match(imp,/openChoice\('textRetention'\)/);
 assert.match(imp,/openChoice\('fileRetention'\)/);
 assert.match(imp,/@click="importDocument"/);
 assert.match(imp,/v-model="textDraft.text"/);
 assert.doesNotMatch(imp,/<div class="radio-stack"/);
 assert.doesNotMatch(imp,/从 Gmail 选择邮件/);
 const provider=part("<template v-else-if=\"sheet==='importSources'\">","<template v-else-if=\"sheet==='safariGoogleGuide'\">");
 assert.match(provider,/@change="selectFile"/);
 assert.match(provider,/@change="importLocalText"/);
 assert.match(provider,/@click="openGmailSheet"/);
 assert.match(provider,/<label v-if="iosStandalonePwa" class="choice-picker-file">/);
 assert.match(provider,/从 Google Drive 选文件（使用 iPhone「文件」）/);
 assert.match(provider,/<button v-if="drivePickerAvailable&&!iosStandalonePwa"/);
 assert.match(provider,/@click="importFromGoogleDrive"/);
 assert.match(provider,/@click="sheet='import'"/);
 assert.doesNotMatch(provider,/window\.localStorage|setInterval/);
});
test('picker preserves draft values while returning to parent and overlay closes only nested level',()=>{
 assert.match(app,/choiceReturnSheet.value=sheet.value/);
 assert.match(app,/choiceField.value=field/);
 assert.match(app,/sheet.value='choicePicker'/);
 assert.match(app,/sheet==='original'\?\(revokeOriginal\(\),sheet=''\):closeNestedSheet\(\)/);
 assert.match(app,/if\(sheet.value==='choicePicker'\)backChoice\(\)/);
 assert.match(app,/else if\(sheet.value==='importSources'\)sheet.value='import'/);
 assert.match(app,/case 'textRetention':textDraft.retention=value/);
 assert.match(app,/case 'fileRetention':fileRetention.value=value/);
 assert.match(app,/case 'taskVisibility':candidateDraft.visibility=value/);
 assert.match(app,/case 'reviewState':fieldDraft.state=value/);
 assert.match(app,/if\(field==='fileRetention'&&!fileHasTextLayer.value\)/);
 assert.match(style,/\.choice-picker-list\{[^}]*max-height:/);
 assert.match(style,/\.choice-field-control\{[^}]*min-height:48px/);
});
