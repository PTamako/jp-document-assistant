<script setup>
import { ref } from 'vue';

const props=defineProps({
  id:{type:String,required:true},
  revealed:{type:Boolean,default:false},
  disabled:{type:Boolean,default:false}
});
const emit=defineEmits(['reveal','hide','delete']);
const RAIL=88;
const dragging=ref(false),drag=ref(0);
let start=null,axis=null,lastSwipeAt=0;

function onTouchStart(event){
  if(props.disabled||event.touches.length!==1)return;
  start={x:event.touches[0].clientX,y:event.touches[0].clientY};
  axis=null;dragging.value=false;drag.value=0;
}
function onTouchMove(event){
  if(!start||event.touches.length!==1)return;
  const dx=event.touches[0].clientX-start.x;
  const dy=event.touches[0].clientY-start.y;
  if(!axis && Math.max(Math.abs(dx),Math.abs(dy))>8)
    axis=Math.abs(dx)>Math.abs(dy)*1.3?'horizontal':'vertical';
  if(axis!=='horizontal')return;
  dragging.value=true;
  const original=props.revealed?-RAIL:0;
  drag.value=Math.max(-RAIL,Math.min(0,original+dx))-original;
}
function onTouchEnd(event){
  if(!start)return;
  const dx=(event.changedTouches[0]?.clientX??start.x)-start.x;
  const dy=(event.changedTouches[0]?.clientY??start.y)-start.y;
  if(axis==='horizontal'&&Math.abs(dx)>35&&Math.abs(dx)>Math.abs(dy)*1.3){
    if(dx<0)emit('reveal',props.id);
    else emit('hide');
    lastSwipeAt=Date.now();
  }
  resetDrag();
}
function resetDrag(){
  start=null;axis=null;dragging.value=false;drag.value=0;
}
function onContentClick(event){
  // A touch-generated click after a swipe must not open a document.
  if(Date.now()-lastSwipeAt<500 || props.revealed){
    event.preventDefault();event.stopPropagation();
    if(props.revealed)emit('hide');
  }
}
function toggle(){
  if(props.disabled)return;
  if(props.revealed)emit('hide');
  else emit('reveal',props.id);
}
</script>
<template>
  <div class="document-swipe-row" :class="{'is-dragging':dragging,'is-revealed':revealed}"
       :aria-label="'文书操作：向左滑动或点击右侧按钮可删除'"
       @touchstart.passive="onTouchStart" @touchmove.passive="onTouchMove"
       @touchend="onTouchEnd" @touchcancel="resetDrag">
    <button type="button" class="document-swipe-delete" :disabled="disabled"
            :tabindex="revealed?0:-1" aria-label="删除文书，移入回收站"
            @click.stop="emit('delete',id)">删除</button>
    <div class="document-swipe-content"
         :style="{transform:'translateX('+((revealed?-RAIL:0)+drag)+'px)'}"
         @click.capture="onContentClick">
      <slot />
      <button type="button" class="document-swipe-trigger" :disabled="disabled"
              :aria-expanded="revealed" :aria-label="revealed?'收起文书操作':'展开删除文书操作'"
              @click.stop="toggle">
        <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M6 12h.01M12 12h.01M18 12h.01" stroke-width="3" />
        </svg>
      </button>
    </div>
  </div>
</template>
<style scoped>
.document-swipe-row{position:relative;overflow:hidden;isolation:isolate;min-width:0;
  margin:0 0 9px;border-radius:var(--radius);border:1px solid var(--line);
  background:#cf4056;touch-action:pan-y}
.document-swipe-content{position:relative;z-index:1;min-width:0;background:var(--panel);
  transition:transform .19s ease-out;will-change:transform}
.is-dragging .document-swipe-content{transition:none}
.document-swipe-delete{position:absolute;right:0;inset-block:0;display:grid;place-items:center;
  width:88px;padding:0;color:#fff;background:#cf4056;font-weight:750;font-size:14px}
.document-swipe-delete:disabled{opacity:.5}
.document-swipe-content :deep(.item-card){margin:0;border:0;border-radius:0;
  min-height:78px;padding-right:53px}
.document-swipe-trigger{position:absolute;right:4px;top:50%;transform:translateY(-50%);
  display:grid;place-items:center;width:44px;height:44px;border-radius:12px;
  color:var(--secondary);touch-action:manipulation}
.document-swipe-trigger:active{background:var(--soft)}
.document-swipe-row :is(button):focus-visible{outline:2px solid var(--blue);outline-offset:-3px}
@media(prefers-reduced-motion:reduce){.document-swipe-content{transition:none}}
</style>
