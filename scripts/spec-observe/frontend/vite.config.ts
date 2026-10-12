import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
export default defineConfig({plugins:[solid()],build:{target:'es2022',minify:true,cssMinify:true},server:{proxy:{'/api':'http://127.0.0.1:4319','/package-view':'http://127.0.0.1:4319'}}});
