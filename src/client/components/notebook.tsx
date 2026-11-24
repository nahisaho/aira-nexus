import { useEffect, useRef, useState } from 'react';
import type { NotebookApi } from '../notebook-api';
import type { NotebookCell, NotebookLanguage } from '../../shared/notebook';
import { Button } from './ui/button';

/** @id CODE-NB-008 @implements REQ-NB-002 REQ-NB-003 */
export function Notebook({api,projectId,t}: {api:NotebookApi;projectId:string;t:(text:string)=>string}) {
  const [cells,setCells] = useState<NotebookCell[]>([]);
  const [enabled,setEnabled] = useState(false);
  const [busy,setBusy] = useState(true);
  const [error,setError] = useState('');
  const [lost,setLost] = useState(false);
  const [language,setLanguage] = useState<NotebookLanguage>('python');
  const controller = useRef<AbortController | null>(null);
  useEffect(()=>{
    const operation = new AbortController();
    controller.current = operation;
    void api.capabilities(projectId,operation.signal).then(async capabilities=>{
      if (operation.signal.aborted) return;
      setEnabled(capabilities.enabled);
      if (!capabilities.enabled) return;
      const saved = await api.list(projectId,operation.signal);
      if (!operation.signal.aborted) {setCells(saved.cells);setLost(saved.cells.some(cell=>cell.stateLost));}
    }).catch(()=>{if (!operation.signal.aborted) setError('Notebookを読み込めませんでした。');})
      .finally(()=>{if (!operation.signal.aborted) setBusy(false);});
    return ()=>{operation.abort();controller.current=null;};
  },[api,projectId]);
  function operation(action:(signal:AbortSignal)=>Promise<void>) {
    const signal = controller.current?.signal;
    if (!signal || signal.aborted || busy) return;
    setBusy(true);setError('');
    void action(signal).catch(error=>{
      if (!signal.aborted) setError(error instanceof Error ? error.message : 'Notebookの操作に失敗しました。');
    }).finally(()=>{if (!signal.aborted) setBusy(false);});
  }
  function replace(cell:NotebookCell) {
    setCells(current=>current.map(existing=>existing.id === cell.id ? cell : existing));
    if (cell.stateLost) setLost(true);
  }
  return <section aria-label="Python / R Notebook" className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4">
    <h2 className="font-semibold">Python / R Notebook</h2>
    {!enabled && !busy && <p>{t('Notebookは現在利用できません。')}</p>}
    {error && <p role="alert">{t(error)}</p>}
    {lost && <p role="status">{t('カーネルの変数は失われました。保存済みのコードと出力は残っています。')}</p>}
    {enabled && <>
      <label>{t('言語')}<select value={language} onChange={event=>setLanguage(event.target.value as NotebookLanguage)} disabled={busy}>
        <option value="python">Python</option><option value="r">R</option>
      </select></label>
      <div className="flex gap-2">
        <Button disabled={busy} onClick={()=>operation(async signal=>{
          const created=await api.create(projectId,{language,code:''},signal);
          if (!signal.aborted) setCells(current=>[...current,created]);
        })}>{t('セルを追加')}</Button>
        <Button variant="outline" disabled={busy} onClick={()=>operation(async signal=>{
          await api.restart(projectId,language,signal);
          if (!signal.aborted) setLost(true);
        })}>{t('カーネルを再起動')}</Button>
      </div>
      {cells.map(cell=><article key={cell.id} className="flex flex-col gap-2 rounded border p-3">
        <span>{cell.language === 'python' ? 'Python' : 'R'}</span>
        <textarea aria-label={t('セルのコード')} className="min-h-32 w-full rounded border p-2 font-mono" value={cell.code} disabled={busy}
          onChange={event=>setCells(current=>current.map(item=>item.id === cell.id ? {...item,code:event.target.value} : item))} />
        <Button disabled={busy} onClick={()=>operation(async signal=>{
          const saved=await api.save(projectId,cell.id,{code:cell.code,version:cell.version},signal);
          if (signal.aborted) return;
          replace(saved);
          const output=await api.execute(projectId,cell.id,{version:saved.version},signal);
          if (!signal.aborted) replace(output);
        })}>{t('セルを実行')}</Button>
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words">{cell.output}</pre>
      </article>)}
    </>}
  </section>;
}
