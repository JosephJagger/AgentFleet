import {ChevronRight,Settings2} from 'lucide-react';
import {t} from '../i18n';
import {cursorSettingsSummary} from '../lib/cursor-labels';
import type {CursorSettings,CursorOption,CursorModel} from '../lib/cursor-settings';

export function CursorSettingsShortcut({settings,options,models,ready,error,onOpen}:{settings:CursorSettings;options:CursorOption[];models:CursorModel[];ready:boolean;error:string;onOpen:()=>void}){
  return <div className="runtime-settings-bar"><button type="button" className="runtime-settings-shortcut" aria-label={t('Cursor 会话配置')} aria-haspopup="dialog" onClick={onOpen}><Settings2 size={13}/><span className="runtime-settings-lines"><span className="runtime-settings-line"><small>{t('发送使用')}</small><span>{ready?cursorSettingsSummary(settings,options,models):t(error||'正在读取会话配置…')}</span></span></span><ChevronRight size={13}/></button></div>;
}
