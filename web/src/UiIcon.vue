<script setup>
defineProps({
  name:{type:String,required:true},
  size:{type:[Number,String],default:20}
});
</script>
<template>
  <svg class="ui-icon" :width="size" :height="size" viewBox="0 0 24 24"
       fill="none" stroke="currentColor" stroke-width="1.8"
       stroke-linecap="round" stroke-linejoin="round"
       aria-hidden="true" focusable="false">
    <template v-if="name==='today'||name==='calendar'">
      <rect x="3" y="5" width="18" height="16" rx="2.5"/>
      <path d="M7.5 3.5v3M16.5 3.5v3M3 10h18"/>
      <path v-if="name==='today'" d="m8 16 2.5 2.5L16 13"/>
    </template>
    <template v-else-if="name==='docs'||name==='file'||name==='file-text'">
      <path d="M14 2.5H7a2.5 2.5 0 0 0-2.5 2.5v14A2.5 2.5 0 0 0 7 21.5h10a2.5 2.5 0 0 0 2.5-2.5V8Z"/>
      <path d="M14 2.5V8h5.5M8 12.5h8M8 16.5h8"/>
    </template>
    <template v-else-if="name==='links'||name==='link'">
      <path d="M10.1 13.9a4.5 4.5 0 0 0 6.4 0l2.1-2.1a4.5 4.5 0 1 0-6.4-6.4l-1.2 1.2"/>
      <path d="M13.9 10.1a4.5 4.5 0 0 0-6.4 0l-2.1 2.1a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2"/>
    </template>
    <template v-else-if="name==='unlink'">
      <path d="M10 14a4.5 4.5 0 0 0 6.4 0l2-2a4.5 4.5 0 0 0-6.4-6.4l-1.1 1.1"/>
      <path d="M14 10a4.5 4.5 0 0 0-6.4 0l-2 2a4.5 4.5 0 1 0 6.4 6.4l1.1-1.1"/>
      <path d="M3 3l18 18"/>
    </template>
    <template v-else-if="name==='mine'||name==='users'">
      <circle cx="12" cy="8" r="4"/><path d="M4.5 21a7.5 7.5 0 0 1 15 0"/>
    </template>
    <template v-else-if="name==='plus'"><path d="M12 5v14M5 12h14"/></template>
    <template v-else-if="name==='search'">
      <circle cx="10.8" cy="10.8" r="6.7"/><path d="m16 16 5 5"/>
    </template>
    <template v-else-if="name==='filter'"><path d="M4 7h16M7 12h10M10 17h4"/></template>
    <template v-else-if="name==='wallet'">
      <rect x="3" y="6" width="18" height="15" rx="2.5"/><path d="M3 9V6a2 2 0 0 1 2-2h13M15 13h6v4h-6a2 2 0 0 1 0-4Z"/>
    </template>
    <template v-else-if="name==='tag'"><path d="M12 3H4a1 1 0 0 0-1 1v8l9 9 9-9-9-9Z"/><circle cx="7.5" cy="7.5" r="1.4"/></template>
    <template v-else-if="name==='cloud'"><path d="M7 18H6a4.5 4.5 0 0 1-.3-9 6.7 6.7 0 0 1 13-.3A4.6 4.6 0 0 1 18 18H7Z"/></template>
    <template v-else-if="name==='upload'">
      <path d="M12 16V4m-4 4 4-4 4 4"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>
    </template>
    <template v-else-if="name==='download'">
      <path d="M12 3v12m-4-4 4 4 4-4"/><path d="M4 17v3h16v-3"/>
    </template>
    <template v-else-if="name==='mail'">
      <rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="m3.5 7 8.5 7 8.5-7"/>
    </template>
    <template v-else-if="name==='languages'">
      <path d="M2 5h12M8 3v3M5 8c.7 3.6 3.2 6.8 7 9M12 8c-.6 3.3-3.2 6.8-7 9"/>
      <path d="M13 21l4-10 4 10M14.5 17h5"/>
    </template>
    <template v-else-if="name==='book'">
      <path d="M12 6C9 3.6 6 4 3 4v16c3-.5 6-.6 9 2 3-2.6 6-2.5 9-2V4c-3 0-6-.4-9 2Zm0 0v16"/>
    </template>
    <template v-else-if="name==='eye'">
      <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>
    </template>
    <template v-else-if="name==='eye-off'"><path d="M3 3 21 21M9.9 5.2A10.5 10.5 0 0 1 12 5c6 0 10 7 10 7a15.5 15.5 0 0 1-3 3.5M6.6 6.6A15 15 0 0 0 2 12s4 7 10 7c1.1 0 2.2-.2 3.2-.7"/></template>
    <template v-else-if="name==='chevron-right'"><path d="m9 5 7 7-7 7"/></template>
    <template v-else-if="name==='arrow-left'"><path d="m12 5-7 7 7 7M5 12h15"/></template>
    <template v-else-if="name==='arrow-up'"><path d="m5 12 7-7 7 7M12 5v14"/></template>
    <template v-else-if="name==='arrow-down'"><path d="m5 12 7 7 7-7M12 19V5"/></template>
    <template v-else-if="name==='ellipsis'">
      <circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/>
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/>
      <circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none"/>
    </template>
    <template v-else-if="name==='x'"><path d="M5 5 19 19M19 5 5 19"/></template>
    <template v-else-if="name==='check-circle'"><circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.7 2.7 5.6-6"/></template>
    <template v-else-if="name==='refresh-cw'">
      <path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.5 9a7 7 0 0 1 12.1-2L20 12M4 12l2.4 5A7 7 0 0 0 19 15"/>
    </template>
    <template v-else-if="name==='archive'"><rect x="3" y="3.5" width="18" height="5" rx="1.2"/><path d="M5 8.5V20h14V8.5M10 13h4"/></template>
    <template v-else-if="name==='trash'"><path d="M4.5 7h15M9 7V4h6v3M7 7l1 13h8l1-13M10 11v6M14 11v6"/></template>
    <template v-else-if="name==='star'"><path d="m12 2 3.1 6.5 7 1-5 5 .9 7-6-3.4L6 21.5l1-7-5-5 7-1L12 2Z"/></template>
    <template v-else-if="name==='sparkles'">
      <path d="m11 3 1.7 5.3L18 10l-5.3 1.7L11 17l-1.7-5.3L4 10l5.3-1.7L11 3Z"/>
      <path d="m19 15 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z"/>
      <path d="m4 2 .45 1.55L6 4l-1.55.45L4 6l-.45-1.55L2 4l1.55-.45L4 2Z"/>
    </template>
    <template v-else-if="name==='shield'"><path d="M12 2 20 6v6c0 5-3.5 8.3-8 10-4.5-1.7-8-5-8-10V6l8-4Z"/><path d="m9 12 2 2 4-4"/></template>
    <template v-else-if="name==='lock'"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 1 1 8 0v3M12 14v3"/></template>
    <template v-else-if="name==='logout'"><path d="M9 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M15 8l5 4-5 4M20 12H9"/></template>
    <template v-else-if="name==='edit'"><path d="m4 20 4.8-1 11-11a2.5 2.5 0 0 0-3.5-3.5l-11 11L4 20ZM14 6l4 4"/></template>
    <template v-else-if="name==='scan'"><path d="M9 3H5a2 2 0 0 0-2 2v4M15 3h4a2 2 0 0 1 2 2v4M3 15v4a2 2 0 0 0 2 2h4M21 15v4a2 2 0 0 1-2 2h-4M7 12h10"/></template>
    <template v-else-if="name==='image'"><rect x="3" y="3" width="18" height="18" rx="2.5"/><circle cx="9" cy="9" r="2"/><path d="m4 18 6-6 3 3 3-3 5 6"/></template>
    <template v-else-if="name==='copy'"><rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></template>
    <template v-else-if="name==='settings'"><circle cx="12" cy="12" r="3"/><path d="m19 4 2 2-1.5 2.5.7 2.1L23 12l-2.8 1.4-.7 2.1L21 18l-2 2-2.5-1.5-2.1.7L12 22l-2.4-2.8-2.1-.7L5 20l-2-2 1.5-2.5-.7-2.1L1 12l2.8-1.4.7-2.1L3 6l2-2 2.5 1.5 2.1-.7L12 2l2.4 2.8 2.1.7L19 4Z"/></template>
    <template v-else-if="name==='info'"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/></template>
    <template v-else><circle cx="12" cy="12" r="9"/><path d="M12 7v5m0 4h.01"/></template>
  </svg>
</template>
