import {createApp} from 'vue';
import App from './App.vue';
import './style.css';
// No persisted Pinia/localStorage/IndexedDB/Service Worker: keep personal data memory-only.
createApp(App).mount('#app');
