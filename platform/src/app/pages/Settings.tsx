import { useState } from 'react';
import type { Me } from '../perm';
import { api, apiBase } from '../api';
import { ErrorLine, Modal, useAsync } from '../ui';
import { confirmDialog, promptDialog } from '../dialogs';

export function Settings({ me }: { me: Me }) {
  const s = useAsync(() => api('GET', '/api/settings'), []);
  const [key, setKey] = useState<any>(null);
  const [err, setErr] = useState<unknown>(null);
  const [demo, setDemo] = useState<any>(null);
  const act = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
      s.reload();
    } catch (e) {
      setErr(e);
    }
  };
  const d = s.data;
  const ro = d?.read_only;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Настройки сервиса</h1>
        <p className="text-sm text-muted-foreground">Доступны суперадминистратору{me.is_demo ? '; в демо-доступе — только просмотр' : ''}.</p>
      </div>
      <ErrorLine e={s.error ?? err} />
      {d && (
        <>
          <section className="card space-y-3 p-5">
            <h2 className="font-semibold">Демо-тенант</h2>
            {!ro && (
              <div className="flex flex-wrap items-center gap-3">
                <button
                  className="btn-ghost border border-border"
                  onClick={() => act(async () => setDemo(await api('POST', '/api/settings/demo-tenant')))}
                  title="FUCHS (демо), 3 дистрибьютора, 4 владельца, 12 машин и учётка каждой роли; удалённое и изменённое в демо возвращается"
                >
                  Создать или восстановить демо-тенант
                </button>
                {demo && (
                  <span className="text-sm text-muted-foreground">
                    готово: {demo.orgs} организаций, {demo.users} учётных записей, {demo.machines} машин
                    {demo.skipped?.length ? ` · пропущено: ${demo.skipped.join('; ')}` : ''}
                  </span>
                )}
              </div>
            )}
          </section>
          <section className="card space-y-3 p-5">
            <h2 className="font-semibold">Ключи шлюзов</h2>
            <p className="text-sm text-muted-foreground">
              Шлюз — программа на сервере с публичным IP: принимает TCP-пакеты трекеров (Galileosky, EGTS, Wialon IPS, Навтелеком FLEX, ретрансляция Wialon)
              и передаёт их сюда по HTTPS на <span className="font-mono">{(apiBase() || location.origin) + '/api/ingest'}</span>. Каждому шлюзу — свой ключ;
              отзыв ключа сразу отключает шлюз. {d.gateway_env_token ? 'Дополнительно действует ключ из переменной GATEWAY_TOKEN.' : ''}
            </p>
            {d.gateway_keys.map((k: any) => (
              <div key={k.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border px-3 py-2 text-sm">
                <div>
                  <b>{k.label}</b> {k.revoked_at && <span className="badge ml-2 bg-muted text-muted-foreground">отозван</span>}
                  <div className="text-xs text-muted-foreground">
                    создан {new Date(k.created_at).toLocaleString('ru-RU')}
                    {k.created_by ? ` · ${k.created_by}` : ''} · {k.last_used_at ? `последнее обращение ${new Date(k.last_used_at).toLocaleString('ru-RU')}` : 'ещё не использовался'}
                  </div>
                </div>
                {!k.revoked_at && !ro && (
                  <button className="btn-ghost h-8 px-2 text-xs text-danger" onClick={async () => (await confirmDialog({ title: 'Отозвать ключ?', body: 'Шлюз с этим ключом перестанет передавать данные.', confirmText: 'Отозвать', danger: true })) && act(() => api('DELETE', `/api/gateway-keys/${k.id}`))}>
                    Отозвать
                  </button>
                )}
              </div>
            ))}
            {!ro && (
              <button
                className="btn-primary"
                onClick={async () => {
                  const label = await promptDialog({ title: 'Новый ключ шлюза', label: 'Название шлюза', placeholder: 'Шлюз Москва, VPS', defaultValue: 'Шлюз', confirmText: 'Создать ключ' });
                  if (label) act(async () => setKey(await api('POST', '/api/gateway-keys', { label })));
                }}
              >
                Создать ключ
              </button>
            )}
          </section>
        </>
      )}
      {key && (
        <Modal title="Ключ шлюза" onClose={() => setKey(null)}>
          <p className="text-sm text-muted-foreground">Скопируйте ключ сейчас — он показывается один раз. На сервере шлюза задайте его в переменной GATEWAY_TOKEN.</p>
          <div className="my-4 break-all rounded-lg bg-muted p-3 font-mono text-sm">{key.key}</div>
          <button className="btn-ghost w-full" onClick={() => navigator.clipboard?.writeText(key.key)}>
            Копировать
          </button>
        </Modal>
      )}
    </div>
  );
}
