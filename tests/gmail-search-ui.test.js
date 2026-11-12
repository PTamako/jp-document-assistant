import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app=readFileSync(new URL('../web/src/App.vue',import.meta.url),'utf8');
const gmail=readFileSync(new URL('../web/src/gmail-import.js',import.meta.url),'utf8');
const worker=readFileSync(new URL('../worker/google-oauth.js',import.meta.url),'utf8');

test('Gmail search box queries the whole mailbox, not only the five displayed rows',()=>{
  assert.match(app, /type="search" maxlength="180"/);
  assert.match(app, /placeholder="发件人、主题或关键词"/);
  assert.match(app, /@submit\.prevent="loadGmailMessages\(false\)"/);
  assert.ok(app.includes("gmailQuery=ref('')"),'search starts without hidden 30-day restriction');
  assert.ok(app.includes("encodeURIComponent(query)"),'search passes query to Gmail API');
  assert.ok(!app.includes('gmailItems.value.filter('),'search never filters the five visible rows');
  assert.ok(worker.includes("const params=new URLSearchParams({maxResults:'5',q})"),'persistent Gmail uses server-side query');
  assert.ok(gmail.includes("const params=new URLSearchParams({maxResults:'5',q})"),'direct Gmail uses server-side query');
});

test('Search result pagination keeps five rows, remembers applied query and resets on new search',()=>{
  assert.ok(app.includes("const query=append?gmailLastQuery.value:gmailQuery.value.trim();"));
  assert.ok(app.includes("if(!append){\n    gmailLastQuery.value=query;"));
  assert.ok(app.includes("gmailItems.value=[];gmailNext.value=null;gmailSearched.value=false;"));
  assert.match(app, /@click="loadGmailMessages\(true\)">加载更多（5 封）/);
  assert.ok(app.includes('gmailQuery.trim()===gmailLastQuery'),'stale search cannot load a page into another query');
  assert.ok(app.includes('gmailNext.value=result.nextPageToken'),'server cursor drives pagination');
});
