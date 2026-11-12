// iOS home-screen standalone apps may not be able to complete Google popup OAuth.
// Use feature detection; never infer this from an unrelated mobile browser.
export function isIosStandalonePwa(browser=typeof window==='undefined'?null:window){
 if(!browser)return false;
 const ios=/iPhone|iPad|iPod/i.test(String(browser.navigator?.userAgent||''));
 const standalone=browser.navigator?.standalone===true||
  browser.matchMedia?.('(display-mode: standalone)')?.matches===true;
 return ios&&standalone;
}
