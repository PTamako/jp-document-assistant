<script setup>
defineProps({name:{type:String,required:true}});
</script>

<template>
  <svg class="nav-icon" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"
       fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
       aria-hidden="true" focusable="false">
    <template v-if="name==='today'">
      <rect x="3" y="5" width="18" height="16" rx="2.5" />
      <path d="M7.5 3.5v3M16.5 3.5v3M3 10h18M8 16l2.5 2.5L16 13" />
    </template>
    <template v-else-if="name==='docs'">
      <path d="M14 2.5H7a2.5 2.5 0 0 0-2.5 2.5v14A2.5 2.5 0 0 0 7 21.5h10a2.5 2.5 0 0 0 2.5-2.5V8Z" />
      <path d="M14 2.5V8h5.5M8 12.5h8M8 16.5h8" />
    </template>
    <template v-else-if="name==='links'">
      <path d="M10.1 13.9a4.5 4.5 0 0 0 6.4 0l2.1-2.1a4.5 4.5 0 1 0-6.4-6.4l-1.2 1.2" />
      <path d="M13.9 10.1a4.5 4.5 0 0 0-6.4 0l-2.1 2.1a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2" />
    </template>
    <template v-else-if="name==='mine'">
      <circle cx="12" cy="8" r="4" />
      <path d="M4.5 21a7.5 7.5 0 0 1 15 0" />
    </template>
  </svg>
</template>
