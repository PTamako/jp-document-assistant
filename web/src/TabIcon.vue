<script setup>
import UiIcon from './UiIcon.vue';
defineProps({name:{type:String,required:true}});
</script>
<template>
  <UiIcon :name="name" :size="24" class="nav-icon"/>
</template>
