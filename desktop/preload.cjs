'use strict';
const {contextBridge,ipcRenderer}=require('electron');
const commands=new Set(['startup','save','openLocal','saveAs','backups','restore','getSettings','configure','chooseFolder','importSettings','ftpList','ftpOpen','ftpTest','status','activate']);
contextBridge.exposeInMainWorld('skycrmDesktop',{
 call:(command,payload)=>{if(!commands.has(command))throw new Error('지원하지 않는 작업입니다.');return ipcRenderer.invoke('desktop-storage',command,payload);},
 onAction:callback=>ipcRenderer.on('desktop-action',(_event,action)=>callback(action))
});
