import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
export default defineConfig({base:'./',plugins:[react(),VitePWA({registerType:'autoUpdate',manifest:{name:'Online app',short_name:'App',start_url:'./',scope:'./',display:'standalone',theme_color:'#0f172a',background_color:'#ffffff',icons:[{src:'./icon.svg',sizes:'any',type:'image/svg+xml',purpose:'any'}]}})]});
